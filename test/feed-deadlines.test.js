// Лента — только закупки, на которые ещё можно успеть подать заявку: идёт приём заявок и до окончания подачи
// не меньше «дней до подачи» из профиля. Раньше закупки из ленты ЕИС (срока подачи в ней нет) считались
// действующими всегда — и в ленту попадали давно завершённые.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { moscowDayFrom } = require('../server/sources/eis-rss');

// 16.10.2026, 11:00 по Москве
const NOW = '2026-10-16T08:00:00.000Z';
const day = (d, hhmm = '12:00') => new Date(`${d}T${hhmm}:00+03:00`).toISOString();

function repoWith(minDays = 2) {
  const repo = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-deadlines-')));
  repo.db.prepare('UPDATE profile SET min_days_to_deadline = ? WHERE id = 1').run(minDays);
  let n = 0;
  const add = (o) => {
    const { id } = repo.upsertTender({ law: '44', number: `00000000000000000${String(++n).padStart(2, '0')}`, title: o.title, price: 100000, currency: 'RUB', region: null, okpd2: [], ktru: [],
      customer_inn: null, published_at: day('2026-10-10'), deadline_at: o.deadline_at ?? null, deadline_from: o.deadline_from ?? null, stage: null, eis_url: null, source_name: o.source || 'eis-rss' });
    repo.db.prepare("UPDATE tenders SET status = 'scored', score = 80 WHERE id = ?").run(id);
    return id;
  };
  const shown = () => repo.listTenders({ limit: 100, nowIso: NOW }).items.map((t) => t.title).sort();
  return { repo, add, shown };
}

test('московские сутки: «через N дней» для запроса ЕИС и нижней границы срока', () => {
  assert.deepEqual(moscowDayFrom(new Date(NOW), 2), { iso: '2026-10-17T21:00:00.000Z', ru: '18.10.2026' });
  // поздний вечер по Москве — это уже следующие сутки по UTC+3
  assert.deepEqual(moscowDayFrom(new Date('2026-10-16T21:30:00Z'), 0), { iso: '2026-10-16T21:00:00.000Z', ru: '17.10.2026' });
  assert.equal(moscowDayFrom(new Date('2026-12-31T10:00:00Z'), 2).ru, '02.01.2027');
});

test('в ленте — только закупки с запасом дней до окончания подачи', () => {
  const { add, shown, repo } = repoWith(2);
  add({ title: 'ЕИС: срок неизвестен' });
  add({ title: 'ЕИС: окончание не раньше 18.10', deadline_from: moscowDayFrom(new Date(NOW), 2).iso });
  add({ title: 'ЕИС: граница устарела (вчерашняя выборка)', deadline_from: moscowDayFrom(new Date(NOW), 1).iso });
  add({ title: 'точный срок: завтра', deadline_at: day('2026-10-17'), source: 'gosplan' });
  add({ title: 'точный срок: послезавтра утром', deadline_at: day('2026-10-18', '09:00'), source: 'gosplan' });
  add({ title: 'точный срок: через неделю', deadline_at: day('2026-10-23'), source: 'roseltorg' });
  add({ title: 'точный срок: прошёл', deadline_at: day('2026-10-15'), source: 'roseltorg' });
  add({ title: 'точный срок известен из извещения — граница ленты не важна', deadline_at: day('2026-10-17'), deadline_from: moscowDayFrom(new Date(NOW), 2).iso });
  add({ title: 'ГосПлан: срок не указан', source: 'gosplan' });
  const own = repo.createManualTender({ number: 'EAT-1', title: 'своя закупка без срока' });
  const ownSoon = repo.createManualTender({ number: 'EAT-2', title: 'своя закупка: срок сегодня вечером', deadline_at: day('2026-10-16', '18:00') });
  repo.db.prepare("UPDATE tenders SET status = 'scored' WHERE id IN (?, ?)").run(own, ownSoon);
  assert.deepEqual(shown(), [
    'ЕИС: окончание не раньше 18.10',
    'ГосПлан: срок не указан',
    'своя закупка без срока',
    'своя закупка: срок сегодня вечером',
    'точный срок: послезавтра утром',
    'точный срок: через неделю',
  ].sort());
  // «0 дней» в профиле — видно всё, что ещё не закончилось
  repo.db.prepare('UPDATE profile SET min_days_to_deadline = 0 WHERE id = 1').run();
  assert.ok(shown().includes('точный срок: завтра'));
  assert.ok(!shown().includes('точный срок: прошёл') && !shown().includes('ЕИС: срок неизвестен'));
  // счётчики по направлениям считают так же
  repo.db.prepare('UPDATE profile SET min_days_to_deadline = 2 WHERE id = 1').run();
  assert.equal(Object.values(repo.directionCounts(NOW)).reduce((a, b) => a + b, 0), 6);
});

test('повторно найденная закупка: пустое поле ленты не затирает срок из извещения; нижняя граница только растёт', () => {
  const { repo } = repoWith(2);
  const base = { law: '44', number: '0000000000000000099', title: 'Поставка', price: 1, currency: 'RUB', region: null, okpd2: [], ktru: [], customer_inn: null, published_at: null, stage: null, eis_url: null, source_name: 'eis-rss' };
  const { id } = repo.upsertTender({ ...base, deadline_at: null, deadline_from: '2026-10-17T21:00:00.000Z' });
  // срок и регион узнали из извещения
  repo.updateTenderBasics(id, { deadline_at: '2026-10-24T06:00:00.000Z', region: 77, okpd2: ['26.20.18'] });
  // следующее обновление ленты: в ней срока, региона и кодов нет
  repo.upsertTender({ ...base, deadline_at: null, deadline_from: '2026-10-18T21:00:00.000Z' });
  let t = repo.getTender(id);
  assert.deepEqual([t.deadline_at, t.region, t.okpd2, t.deadline_from], ['2026-10-24T06:00:00.000Z', 77, ['26.20.18'], '2026-10-18T21:00:00.000Z']);
  // старая выборка не уменьшает границу
  repo.upsertTender({ ...base, deadline_at: null, deadline_from: '2026-10-17T21:00:00.000Z' });
  assert.equal(repo.getTender(id).deadline_from, '2026-10-18T21:00:00.000Z');
  // источник назвал новый срок (продлили) — он заменяет прежний
  repo.upsertTender({ ...base, deadline_at: '2026-10-28T06:00:00.000Z', source_name: 'gosplan' });
  t = repo.getTender(id);
  assert.equal(t.deadline_at, '2026-10-28T06:00:00.000Z');
});

test('срок, затёртый раньше пустым полем ленты, возвращается из сохранённого извещения при запуске', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-deadlines-'));
  let repo = openDb(dir);
  const { id } = repo.upsertTender({ law: '44', number: '0000000000000000077', title: 'Поставка', price: 1, currency: 'RUB', region: null, okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: null, eis_url: null, source_name: 'eis-rss' });
  repo.saveItems(id, [], { conditions: { deadline_at: '2026-10-24T06:00:00.000Z' }, source: 'notification' });
  repo.db.prepare('UPDATE tenders SET deadline_at = NULL WHERE id = ?').run(id);
  repo.db.close();
  repo = openDb(dir);
  assert.equal(repo.getTender(id).deadline_at, '2026-10-24T06:00:00.000Z');
});

test('закупку отменили в ЕИС после того, как она попала в ленту, — она уходит из ленты и не возвращается при пересчёте', () => {
  const { repo, add, shown } = repoWith(2);
  const id = add({ title: 'отменена заказчиком', deadline_at: day('2026-10-20') });
  add({ title: 'идёт приём заявок', deadline_at: day('2026-10-21') });
  const { filterReason, closedReason } = require('../server/tenders/filters');
  const t = repo.getTender(id);
  // обновление ленты: ЕИС сообщил этап «Определение поставщика отменено»
  assert.equal(repo.markClosed('44', t.number, 'Определение поставщика отменено'), id);
  repo.setFiltered(id, closedReason('Определение поставщика отменено'), repo.getProfile().version);
  assert.deepEqual(shown(), ['идёт приём заявок']);
  // пересчёт после смены профиля: фильтр помнит этап — закупка не возвращается в ленту
  assert.match(filterReason(repo.getTender(id), repo.getProfile(), new Date(NOW)), /«Определение поставщика отменено» — подать заявку уже нельзя/);
  // своих закупок это не касается; неизвестной закупки — тоже
  const own = repo.createManualTender({ number: 'EAT-9', title: 'своя' });
  assert.equal(repo.markClosed('com', 'EAT-9', 'отменено'), null);
  assert.equal(repo.getTender(own).closed_stage, null);
  assert.equal(repo.markClosed('44', '99999999999999999999', 'отменено'), null);
  // снова найдена на этапе «Подача заявок» (такое бывает после исправлений в извещении) — пометка снимается
  repo.upsertTender({ law: '44', number: t.number, title: t.title, price: 1, currency: 'RUB', region: null, okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: null, eis_url: null, source_name: 'eis-rss', deadline_from: day('2026-10-18', '00:00'), open_confirmed: true });
  assert.equal(repo.getTender(id).closed_stage, null);
});

test('этап закупки сверяется с ЕИС по номеру: отменённая уходит из ленты, остальные помечаются сверенными', async () => {
  const { createEisRssSource } = require('../server/sources/eis-rss');
  const { createFunnel } = require('../server/tenders/funnel');
  // этап по номеру — из той же ленты поиска ЕИС
  const RSS = fs.readFileSync(path.join(__dirname, '..', 'samples', 'tenders', 'eis-rss-page.xml'), 'utf8');
  const asked = [];
  const eis = createEisRssSource({ delayMs: 0, fetchImpl: async (url) => { asked.push(new URL(String(url)).searchParams); return new Response(RSS, { status: 200 }); } });
  assert.equal(await eis.getStage({ law: '223', number: '32616402782' }), 'Работа комиссии');
  assert.deepEqual([asked[0].get('searchString'), asked[0].get('fz223')], ['32616402782', 'on']);
  assert.equal(await eis.getStage({ law: '44', number: '0373200586426000107' }), 'Подача заявок');
  assert.equal(await eis.getStage({ law: '44', number: '0000000000000000000' }), null, 'не найдена — не значит отменена');
  assert.equal(await eis.getStage({ law: 'com', number: 'EAT-1' }), null);

  const { repo, add, shown } = repoWith(2);
  const cancelled = add({ title: 'отменена', deadline_at: day('2026-10-20'), source: 'gosplan' });
  const open = add({ title: 'идёт приём', deadline_at: day('2026-10-21') });
  const missing = add({ title: 'в ЕИС не найдена', deadline_at: day('2026-10-22') });
  const stages = new Map([[repo.getTender(cancelled).number, 'Определение поставщика отменено'], [repo.getTender(open).number, 'Подача заявок']]);
  const calls = [];
  const source = { getStage: async (t) => { calls.push(t.number); return stages.get(t.number) || null; } };
  const funnel = createFunnel({ repo, details: {}, offers: {}, analyses: null, source, config: { STAGE_CHECK_PER_SYNC: 10, STAGE_CHECK_HOURS: 24 }, log: { log() {}, warn() {} }, clock: () => new Date(NOW) });
  assert.deepEqual(await funnel.checkStages(), { checked: 3, closed: 1 });
  assert.deepEqual(shown(), ['в ЕИС не найдена', 'идёт приём']);
  assert.match(repo.getTender(cancelled).filter_reason, /«Определение поставщика отменено»/);
  // сверенные раньше суток назад повторно не спрашиваются
  assert.deepEqual(await funnel.checkStages(), { checked: 0, closed: 0 });
  assert.equal(calls.length, 3);
  // ЕИС не ответил — проход прекращается, закупка остаётся в очереди
  repo.db.prepare('UPDATE tenders SET stage_checked_at = NULL WHERE id = ?').run(missing);
  const down = createFunnel({ repo, details: {}, offers: {}, analyses: null, source: { getStage: async () => { throw new Error('ЕИС ответил 503'); } }, config: { STAGE_CHECK_PER_SYNC: 10 }, log: { log() {}, warn() {} }, clock: () => new Date(NOW) });
  assert.deepEqual(await down.checkStages(), { checked: 0, closed: 0 });
  assert.equal(repo.db.prepare('SELECT stage_checked_at AS v FROM tenders WHERE id = ?').get(missing).v, null);
});
