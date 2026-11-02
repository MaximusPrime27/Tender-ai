// Отбор ленты по марже (настройка профиля) и отметка продавца по реестру недобросовестных поставщиков (РНП).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { isEligible } = require('../server/offers/rank');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const NOW = '2026-09-17T09:00:00Z';

function start() {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-margin-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, SUPPLIER_INDEX: false, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
    OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '',
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date(NOW), sourceOverride: createFixtureSource({ dir: FIX }) });
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, {
      method: opts.method, headers: opts.json ? { 'Content-Type': 'application/json' } : undefined, body: opts.json ? JSON.stringify(opts.json) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { s, api };
}

const econ = (margin) => ({ verdict: margin >= 10 ? 'выгодно' : 'на грани', result: { profit: margin * 1000, margin_pct: margin } });

test('лента по марже: закупки с маржой ниже порога скрыты, без расчёта — видны, 0 — отбор выключен', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    await s.funnel.idle();
    const all = (await api('/api/tenders?limit=100')).body;
    assert.ok(all.total >= 4, 'в примерах достаточно закупок');
    assert.equal(all.hidden_by_margin, 0, 'порог не передан — ничего не скрыто');
    const [low, edge, high] = all.items.slice(0, 3).map((t) => t.id);
    s.repo.saveEconomics(low, { result: econ(8) });
    s.repo.saveEconomics(edge, { result: econ(20) });
    s.repo.saveEconomics(high, { result: econ(35) });

    const at20 = (await api('/api/tenders?limit=100&min_margin=20')).body;
    const ids = at20.items.map((t) => t.id);
    assert.ok(!ids.includes(low), 'маржа 8% ниже порога 20% — скрыта');
    assert.ok(ids.includes(edge), 'маржа ровно 20% — видна');
    assert.ok(ids.includes(high));
    assert.equal(at20.hidden_by_margin, 1);
    assert.equal(at20.total, all.total - 1, 'закупки без расчёта остались в ленте');
    assert.ok(at20.items.some((t) => t.econ_margin == null), 'в ленте есть закупки без расчёта');

    const at30 = (await api('/api/tenders?limit=100&min_margin=30')).body;
    assert.deepEqual([at30.hidden_by_margin, at30.total], [2, all.total - 2]);
    const off = (await api('/api/tenders?limit=100&min_margin=0')).body;
    assert.deepEqual([off.hidden_by_margin, off.total], [0, all.total]);
    // то же на уровне базы: счётчик скрытых учитывает остальные фильтры
    const none = s.repo.listTenders({ limit: 100, minMargin: 20, q: 'такой закупки точно нет', nowIso: NOW });
    assert.deepEqual([none.total, none.hidden_by_margin], [0, 0]);
  } finally {
    await s.close();
  }
});

test('лента по марже: порог хранится отдельно от профиля — по умолчанию 20%, смена не меняет версию профиля', async () => {
  const { s, api } = start();
  try {
    const before = (await api('/api/profile')).body;
    assert.equal(before.feed_min_margin_pct, 20);
    assert.equal((await api('/api/health')).body.feedMinMarginPct, 20);

    const saved = await api('/api/profile/feed', { method: 'PUT', json: { min_margin_pct: 35 } });
    assert.deepEqual([saved.status, saved.body.feed_min_margin_pct], [200, 35]);
    const after = (await api('/api/profile')).body;
    assert.equal(after.feed_min_margin_pct, 35);
    assert.equal(after.version, before.version, 'версия профиля прежняя — переоценка закупок не запускается');
    assert.equal(after.economics.min_margin_pct, before.economics.min_margin_pct, 'порог вердикта «выгодно» — другой параметр, он не тронут');

    assert.equal((await api('/api/profile/feed', { method: 'PUT', json: { min_margin_pct: 0 } })).body.feed_min_margin_pct, 0);
    assert.equal((await api('/api/health')).body.feedMinMarginPct, 0, '0 — отбор выключен, а не «значение по умолчанию»');
    for (const bad of [-1, 101, 'много', null]) {
      assert.equal((await api('/api/profile/feed', { method: 'PUT', json: { min_margin_pct: bad } })).status, 400, `значение ${bad}`);
    }
  } finally {
    await s.close();
  }
});

test('РНП: продавец с отметкой «в реестре» сам в расчёт не идёт', () => {
  const ok = { source: 'yandex', unit_price: 100, match: 'соответствует' };
  assert.equal(isEligible(ok), true);
  assert.equal(isEligible({ ...ok, seller_rnp: 'clean' }), true);
  assert.equal(isEligible({ ...ok, seller_rnp: null }), true, '«не проверено» ни на что не влияет');
  assert.equal(isEligible({ ...ok, seller_rnp: 'listed' }), false);
});

test('РНП: отметка относится к продавцу, снимает его автоматический выбор и не трогает ручной', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    await s.funnel.idle();
    const [a, b] = (await api('/api/tenders?limit=2')).body.items.map((t) => t.id);
    const INN = '7707083893';
    const offer = (tenderId, itemId, price, inn) => s.repo.insertOffer({ tender_id: tenderId, item_id: itemId, source: 'yandex', title: 'Товар', domain: 'shop.ru', url: `https://shop.ru/${tenderId}-${price}`,
      price, unit_price: price, pack_qty: 1, seller_name: inn === INN ? 'ООО Продавец' : 'ООО Другой', seller_inn: inn, match: 'соответствует', match_notes: [], delivery_cost: 0 });
    const item = (id) => { s.repo.saveItems(id, [{ name: 'Картридж HP CF259X', characteristics: [], quantity: 2, unit: 'шт', unit_price: 9000, source: 'notification' }], { source: 'notification' }); return s.repo.getItems(id)[0]; };

    // закупка A: дешёвое предложение продавца выбрано автоматически, есть запасное подороже от другого продавца
    const ia = item(a);
    const cheap = offer(a, ia.id, 4000, INN);
    const spare = offer(a, ia.id, 5000, '5249185655');
    s.repo.setItemOffer(ia.id, s.repo.getOffer(cheap), 'auto');
    // закупка B: предложение того же продавца выбрано пользователем вручную
    const ib = item(b);
    const manual = offer(b, ib.id, 4100, INN);
    s.repo.setItemOffer(ib.id, s.repo.getOffer(manual), 'user');

    assert.equal((await api(`/api/sellers/${INN}/rnp`, { method: 'POST', json: { status: 'что-то' } })).status, 400);
    assert.equal((await api('/api/sellers/123/rnp', { method: 'POST', json: { status: 'listed' } })).status, 400);
    const r = await api(`/api/sellers/${INN}/rnp`, { method: 'POST', json: { status: 'listed' } });
    assert.deepEqual([r.status, r.body.rnp, r.body.affected_tenders], [200, 'listed', 2]);

    const ga = (await api(`/api/tenders/${a}/offers`)).body.groups[0];
    assert.equal(ga.ranked.find((o) => o.id === cheap).seller_rnp, 'listed', 'отметка видна в таблице предложений');
    assert.ok(ga.ranked.find((o) => o.id === cheap).seller_rnp_at);
    assert.equal(ga.selected_offer_id, spare, 'автоматический выбор перешёл к продавцу, которого в реестре нет');
    const gb = (await api(`/api/tenders/${b}/offers`)).body.groups[0];
    assert.equal(gb.selected_offer_id, manual, 'выбор пользователя не отменён');
    assert.equal(gb.selected_by, 'user');
    assert.equal(gb.ranked.find((o) => o.id === manual).seller_rnp, 'listed', 'но отметка видна — интерфейс предупредит');

    // «в реестре нет» и снятие отметки
    await api(`/api/sellers/${INN}/rnp`, { method: 'POST', json: { status: 'clean' } });
    assert.equal((await api(`/api/tenders/${a}/offers`)).body.groups[0].selected_offer_id, cheap, 'продавец чист — лучшее по цене снова выбрано');
    await api(`/api/sellers/${INN}/rnp`, { method: 'POST', json: { status: 'none' } });
    const cleared = (await api(`/api/tenders/${a}/offers`)).body.groups[0].ranked.find((o) => o.id === cheap);
    assert.deepEqual([cleared.seller_rnp, cleared.seller_rnp_at], [null, null]);
  } finally {
    await s.close();
  }
});
