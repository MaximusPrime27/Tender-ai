// Сколько заявок подано: число из реестра Сбербанк-АСТ хранится по закупке, переспрашивается раз в BID_COUNT_STALE_MIN;
// рабочий процесс держит свежими закупки корзины заявок и отчёта агента заявок.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createBidCounts } = require('../server/tenders/bid-counts');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidcounts-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let now = new Date('2026-10-25T10:00:00Z');
  const answers = {};
  const asked = [];
  const lookup = async (n) => { asked.push(n); if (answers[n] instanceof Error) throw answers[n]; return answers[n] ?? null; };
  const bc = createBidCounts({ repo, lookup, staleMin: 180, clock: () => now, log: { log() {}, warn() {} } });
  const tender = (law, number, deadline = '2026-10-30T09:00:00Z') => repo.upsertTender({ law, number, title: 'Поставка', price: 1000, currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: '2026-10-24T00:00:00Z', deadline_at: deadline, stage: 1, eis_url: null }).id;
  return { repo, bc, tender, answers, asked, setNow: (d) => { now = new Date(d); } };
}

test('число заявок: сохраняется с временем и историей; переспрашиваем не чаще раза в 3 часа; 223-ФЗ не спрашиваем', async (t) => {
  const { repo, bc, tender, answers, asked, setNow } = setup(t);
  const a = tender('44', '0358300045026000023');
  const c = tender('223', '32616520011');
  answers['0358300045026000023'] = { count: 1, stage: 'Подача заявок' };
  let r = await bc.refresh(repo.getTender(a));
  assert.deepEqual([r.found, r.count, r.platform, r.checked_at], [true, 1, 'Сбербанк-АСТ', '2026-10-25T10:00:00.000Z']);
  answers['0358300045026000023'] = { count: 3, stage: 'Подача заявок' };
  r = await bc.refresh(repo.getTender(a));
  assert.equal(r.count, 1, 'три часа не прошло — площадку не спрашивали');
  setNow('2026-10-25T13:30:00Z');
  r = await bc.refresh(repo.getTender(a));
  assert.equal(r.count, 3);
  assert.deepEqual(r.history.map((h) => h.count), [1, 3]);
  assert.equal(await bc.refresh(repo.getTender(c)), null);
  assert.deepEqual(asked, ['0358300045026000023', '0358300045026000023']);
});

test('закупки нет на площадке — переспрашиваем через сутки; после срока подачи и в работе комиссии — не спрашиваем', async (t) => {
  const { repo, bc, tender, answers, asked, setNow } = setup(t);
  const x = tender('44', '0373200000126099999');
  const r = await bc.refresh(repo.getTender(x));
  assert.deepEqual([r.found, r.count], [false, null]);
  setNow('2026-10-25T20:00:00Z');
  assert.equal(bc.due(repo.getTender(x)), false);
  setNow('2026-10-26T11:00:00Z');
  assert.equal(bc.due(repo.getTender(x)), true);
  const y = tender('44', '0744200000226008607', '2026-10-26T09:00:00Z');
  answers['0744200000226008607'] = { count: 4, stage: 'Работа комиссии' };
  await bc.refresh(repo.getTender(y), { force: true });
  setNow('2026-10-27T11:00:00Z');
  assert.equal(bc.due(repo.getTender(y)), false, 'срок прошёл, комиссия работает — число окончательное');
  assert.equal(asked.length, 2);
});

test('рабочий процесс: обновляет корзину заявок и отчёт агента, раз в 15 минут; ошибка площадки — прекращаем до следующего раза', async (t) => {
  const { repo, bc, tender, answers, asked, setNow } = setup(t);
  repo.db.exec('CREATE TABLE IF NOT EXISTS bid_cart (tender_id INTEGER PRIMARY KEY, added_at TEXT NOT NULL)');
  repo.db.exec('CREATE TABLE IF NOT EXISTS bid_agent_items (id INTEGER PRIMARY KEY AUTOINCREMENT, tender_id INTEGER, status TEXT, created_at TEXT, updated_at TEXT)');
  const a = tender('44', '0000000000000000001');
  const b = tender('44', '0000000000000000002');
  const old = tender('44', '0000000000000000003');
  tender('44', '0000000000000000004'); // нигде не отмечена
  repo.db.prepare('INSERT INTO bid_cart VALUES (?, ?)').run(a, '2026-10-25T09:00:00Z');
  repo.db.prepare("INSERT INTO bid_agent_items (tender_id, status, created_at, updated_at) VALUES (?, 'ready', '2026-10-24T02:00:00Z', '2026-10-24T02:00:00Z')").run(b);
  repo.db.prepare("INSERT INTO bid_agent_items (tender_id, status, created_at, updated_at) VALUES (?, 'ready', '2026-10-10T02:00:00Z', '2026-10-10T02:00:00Z')").run(old);
  answers['0000000000000000001'] = { count: 2, stage: 'Подача заявок' };
  answers['0000000000000000002'] = { count: 0, stage: 'Подача заявок' };
  assert.deepEqual(await bc.tick(), { checked: 2 });
  assert.deepEqual(asked.sort(), ['0000000000000000001', '0000000000000000002'], 'старая запись агента и неотмеченная — не спрашиваем');
  assert.deepEqual(await bc.tick(), { checked: 0 }, '15 минут не прошло');
  setNow('2026-10-25T14:00:00Z');
  answers['0000000000000000001'] = new Error('Сбербанк-АСТ ответил 503');
  assert.deepEqual(await bc.tick(), { checked: 0 });
  assert.equal(bc.get(a).count, 2, 'старое число осталось');
});
