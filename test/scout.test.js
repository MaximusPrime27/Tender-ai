// Агент поиска поставщиков: попытки с разными формулировками, «нашёл» → агент заявок, «нужен запрос цены» после
// трёх попыток, свой суточный лимит, своя база — до платного поиска.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createScout } = require('../server/offers/scout');

function setup(t, { found = () => false, base = () => false, daily = 60 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let clock = new Date('2026-10-25T09:00:00Z');
  const tender = (number, price = 60000) => {
    const { id } = repo.upsertTender({ law: '44', number, title: 'Поставка мебели медицинской', price, currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: '2026-10-24T08:00:00Z', deadline_at: '2026-11-03T06:00:00Z', stage: 1, eis_url: null });
    repo.db.prepare("UPDATE tenders SET status = 'scored', direction = 'g-furniture' WHERE id = ?").run(id);
    repo.saveItems(id, [{ name: 'Тумба медицинская', quantity: 2, unit: 'шт', unit_price: 25000, source: 'notification', characteristics: [] }]);
    return id;
  };
  const variants = [];
  const addOffer = (tid, title) => { const it = repo.getItems(tid)[0]; repo.insertOffer({ tender_id: tid, item_id: it.id, source: 'wholesale', domain: 'mebel.ru', title, url: `https://mebel.ru/${encodeURIComponent(title)}`, price: 15000, match: 'соответствует', match_checks: { rows: [] } }); };
  const offers = {
    start(tid, opts) {
      variants.push(opts.variant);
      const sid = repo.createOfferSearch(tid);
      if (found(tid, opts.variant)) addOffer(tid, `Тумба медицинская вариант ${opts.variant}`);
      repo.updateOfferSearch(sid, { status: 'done', finished: true, apiRequests: 8 });
      return sid;
    },
    async baseCheck(tid) { if (base(tid)) addOffer(tid, 'Тумба из своей базы'); },
    supplierCatalog: () => [{ name: 'МД Мебель', site: 'md-mebel.ru' }, { name: 'МСК', site: 'msk-med.ru' }],
  };
  const runs = [];
  const bidAgent = { settings: () => ({ price_max: 150000 }), run: async (opts) => { runs.push(opts.tenderIds[0]); return {}; } };
  const scout = createScout({ repo, offers, bidAgent, config: { SCOUT_DAILY_REQUESTS: daily }, clock: () => clock, log: { log() {}, warn() {} }, sleep: async () => {}, pollMs: 0 });
  return { repo, scout, tender, variants, runs, setClock: (d) => { clock = d; } };
}

test('поиск поставщиков: три попытки с разными формулировками, потом — «нужен запрос цены» и кому написать', async (t) => {
  const { scout, tender, variants, setClock, repo } = setup(t);
  const id = tender('s-1');
  for (let i = 0; i < 3; i++) {
    setClock(new Date(Date.parse('2026-10-25T09:00:00Z') + i * 13 * 3600000));
    const r = await scout.tick();
    assert.equal(r.tender_id, id);
  }
  assert.deepEqual(variants, [0, 1, 2], 'каждая попытка — со своими формулировками');
  const v = scout.view();
  assert.equal(v.tasks[0].status, 'quote');
  assert.deepEqual(v.tasks[0].companies.map((c) => c.site), ['md-mebel.ru', 'msk-med.ru']);
  assert.equal(await scout.tick(), null, 'больше не пробует');
  assert.equal(repo.db.prepare('SELECT requests FROM scout_tasks WHERE tender_id = ?').get(id).requests, 24);
});

test('поиск поставщиков: нашёл со второй попытки — агент заявок считает прибыль; своя база — без платного поиска', async (t) => {
  const { scout, tender, variants, runs, setClock } = setup(t, { found: (tid, v) => v === 1, base: (tid) => tid === 2 });
  const a = tender('s-2');
  const b = tender('s-3');
  await scout.tick();
  assert.deepEqual(variants, [0]);
  // вторая закупка: своя база дала товар — платного поиска нет
  const r2 = await scout.tick();
  assert.equal(r2.tender_id, b);
  assert.equal(r2.spent, 0);
  assert.deepEqual(runs, [b]);
  setClock(new Date('2026-10-25T22:00:00Z'));
  const r3 = await scout.tick();
  assert.equal(r3.tender_id, a);
  assert.equal(r3.status, 'found');
  assert.deepEqual(variants, [0, 1]);
  assert.deepEqual(runs, [b, a]);
});

test('поиск поставщиков: свой суточный лимит запросов; дороже порога агента заявок — не берёт', async (t) => {
  const { scout, tender } = setup(t, { daily: 8 });
  tender('s-4', 400000);
  assert.equal(await scout.tick(), null, 'дороже 150 тыс. — не его закупка');
  tender('s-5');
  await scout.tick();
  assert.deepEqual(await scout.tick(), { skipped: 'лимит' });
});

test('поиск поставщиков: товар уже найден раньше — только отметка, без поиска и без агента заявок', async (t) => {
  const { scout, tender, variants, runs, repo } = setup(t);
  const id = tender('s-6');
  const it = repo.getItems(id)[0];
  repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'm.ru', title: 'Тумба', url: 'https://m.ru/1', price: 9000, match: 'соответствует', match_checks: { rows: [] } });
  const r = await scout.tick();
  assert.deepEqual([r.status, r.earlier, r.spent], ['found', true, 0]);
  assert.deepEqual(variants, []);
  assert.deepEqual(runs, []);
});
