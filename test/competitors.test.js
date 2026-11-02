// Победители прошлых госконтрактов — конкуренты, а не поставщики: пометка «кто это», отдельный список,
// их цена не становится закупочной, а служит ориентиром для своей цены.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { sellerKind, competitorsOf, competitorPrice } = require('../server/offers/seller-kind');

test('кто это: производитель, профильная торговля, торговая компания, посредник — по ОКВЭД и коду товара', () => {
  const kind = (okved, item, extra = {}) => sellerKind({ okved, inn: '7707083893', ...extra }, item);
  // производитель именно такого товара — и по профилю, и по совпадению класса
  assert.deepEqual([kind('26.20', '26.20.15.000').kind, kind('26.20', '26.20.15.000').can_ask], ['maker', true]);
  assert.equal(kind('31.01', '31.01.12.110').kind, 'maker');
  assert.equal(kind('10.51.1', '10.51.40.110').kind, 'maker');
  // производство другой продукции — здесь он посредник
  const other = kind('31.01', '26.20.40.120');
  assert.deepEqual([other.kind, other.can_ask, /производство другой продукции/.test(other.note)], ['reseller', false, true]);
  // торгует именно такими товарами
  const profile = kind('46.51', '26.20.40.120-00000001');
  assert.deepEqual([profile.kind, profile.title, profile.can_ask], ['profile', 'профильная торговля', true]);
  assert.match(profile.note, /ОКВЭД 46\.51 — оптовая торговля компьютерами и периферией/);
  assert.equal(kind('47.41', '26.20.18.000').kind, 'profile');
  assert.equal(kind('46.65', '31.01.11.150').kind, 'profile', 'оптовая торговля офисной мебелью — профиль для мебели');
  // типичные посредники
  assert.equal(kind('46.90', '26.20.15.000').kind, 'reseller');
  assert.match(kind('46.90', '26.20.15.000').note, /неспециализированная оптовая торговля/);
  assert.equal(kind('46.14', '26.20.15.000').kind, 'reseller', 'торговые агенты');
  assert.equal(kind('46.46', '26.20.15.000').kind, 'reseller', 'торгует медициной, а продал компьютер');
  assert.equal(kind('62.01', '26.20.40.120').kind, 'reseller');
  assert.equal(kind('43.21', '27.40.25.123').kind, 'reseller');
  assert.equal(kind('33.12', '28.25.12.130').kind, 'reseller', 'ремонт оборудования — не производство');
  // товар вне известных профилей: торговля есть, но чем — по коду не понять
  assert.equal(kind('46.49', '22.29.25.000').kind, 'trade');
  // нет данных реестра
  const unknown = sellerKind({ okved: null, inn: '500100732259' }, '26.20.15.000');
  assert.deepEqual([unknown.kind, unknown.can_ask], ['unknown', false]);
  assert.match(unknown.note, /индивидуальный предприниматель/);
  assert.match(kind('46.51', '26.20.15.000', { govContracts: 14 }).note, /Выиграл госконтрактов \(по данным сервиса\): 14/);
  assert.doesNotMatch(kind('46.51', '26.20.15.000', { govContracts: 1 }).note, /Выиграл/);
});

test('список конкурентов: тот же товар сверху, производители и профильные — раньше посредников; сводка цен', () => {
  const item = { okpd2_code: '26.20.40.120', ktru_code: null };
  const o = (id, okved, price, match = 'соответствует', extra = {}) => ({ id, source: 'contracts', seller_inn: '7707083893', seller_okved: okved, unit_price: price, match, ...extra });
  const list = competitorsOf([
    o(1, '46.90', 900), o(2, '46.51', 1200), o(3, '26.20', 1500), o(4, '46.51', 1000),
    o(5, '46.51', 300, 'не соответствует'), o(6, '26.20', 700, 'не хватает данных'),
    o(7, '46.51', 100, 'соответствует', { seller_decision: 'blocked' }),
    { id: 8, source: 'yandex', unit_price: 50, match: 'соответствует' },
  ], item);
  assert.deepEqual(list.map((x) => x.id), [3, 4, 2, 1, 6, 5], 'магазин и заблокированный продавец в конкуренты не попадают');
  assert.deepEqual(list.map((x) => x.seller_kind.kind), ['maker', 'profile', 'profile', 'reseller', 'maker', 'profile']);
  assert.deepEqual(competitorPrice(list), { count: 4, min: 900, median: 1100, max: 1500 }, 'в сводке — только тот же товар');
  assert.deepEqual(competitorPrice(list.slice(0, 3)), { count: 3, min: 1000, median: 1200, max: 1500 });
  assert.equal(competitorPrice(list.filter((x) => x.match !== 'соответствует')), null);
});

function start() {
  const config = { ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-comp-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '', ECONOMICS_MAX_PER_SYNC: 0 };
  const s = startServer(config, {
    scheduler: false, log: { log() {}, warn() {}, error() {} },
    clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: path.join(__dirname, '..', 'samples', 'tenders') }),
  });
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, {
      ...opts, headers: opts.json ? { 'Content-Type': 'application/json' } : undefined, body: opts.json ? JSON.stringify(opts.json) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { s, api };
}

test('конкуренты в карточке: отдельный список с пометками; их цена не закупочная — ни сама, ни по кнопке, ни из старых данных', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    await api(`/api/tenders/${id}`);
    await s.details.idle();
    const item = s.repo.getItems(id)[0];
    const add = (source, o) => s.repo.insertOffer({ tender_id: id, item_id: item.id, source, title: 'Моноблок 23.8"', price: 60000, unit_price: 60000, pack_qty: 1, total_cost: 720000, match: 'соответствует', match_notes: [], delivery_cost: 0, ...o });
    s.repo.saveSellerEgrul('7707083893', 'ООО «Компьютерный мир»', { found: true, inn: '7707083893', status: 'ACTIVE', okved: '46.51' });
    s.repo.saveSellerEgrul('5249185655', 'ООО «Всё подряд»', { found: true, inn: '5249185655', status: 'ACTIVE', okved: '46.90' });
    s.repo.noteSellerContract('5249185655', 'ООО «Всё подряд»');
    s.repo.noteSellerContract('5249185655', 'ООО «Всё подряд»');
    const rivalCheap = add('contracts', { unit_price: 48000, price: 48000, seller_name: 'ООО «Всё подряд»', seller_inn: '5249185655' });
    const rivalProfile = add('contracts', { unit_price: 55000, price: 55000, seller_name: 'ООО «Компьютерный мир»', seller_inn: '7707083893' });
    const rivalOther = add('contracts', { unit_price: 9000, price: 9000, seller_name: 'ИП без данных', seller_inn: '500100732259', match: 'не соответствует' });

    // цена конкурента раньше могла быть выбрана — и автоматически, и вручную
    s.repo.setItemOffer(item.id, s.repo.getOffer(rivalCheap), 'user');
    assert.deepEqual(await s.offers.dropCompetitorSelections(), { items: 1, tenders: 1 });
    assert.equal(s.repo.getItems(id)[0].purchase_offer_id, null, 'выбор цены конкурента снят');
    assert.deepEqual(await s.offers.dropCompetitorSelections(), { items: 0, tenders: 0 });

    let g = (await api(`/api/tenders/${id}/offers`)).body.groups[0];
    assert.deepEqual(g.ranked, [], 'в списке «где купить» конкурентов нет');
    assert.equal(g.best, null);
    assert.deepEqual(g.competitors.map((o) => [o.id, o.seller_kind.kind]), [[rivalProfile, 'profile'], [rivalCheap, 'reseller'], [rivalOther, 'unknown']]);
    assert.match(g.competitors[1].seller_kind.note, /Выиграл госконтрактов \(по данным сервиса\): 2/);
    assert.deepEqual(g.competitor_price, { count: 2, min: 48000, median: 51500, max: 55000 });

    // «Выбрать» у конкурента не работает; автоподбор его тоже не берёт
    const refused = await api(`/api/offers/${rivalCheap}/select`, { method: 'POST', json: {} });
    assert.deepEqual([refused.status, /конкурент/.test(refused.body.error)], [400, true]);
    assert.equal((await s.offers.reselect(id)).picked, 0);
    let e = (await api(`/api/tenders/${id}/economics`, { method: 'POST', json: {} })).body.economics;
    assert.equal(e.confirmed, false);
    assert.notEqual(e.result.inputs.items[0].purchase_source, 'поиск поставщиков');

    // появился магазин — он и становится закупочной ценой, хотя конкурент продавал дешевле
    const shop = add('yandex', { unit_price: 52000, price: 52000, total_cost: 624000, seller_name: 'Магазин', url: 'https://shop.ru/p/1', domain: 'shop.ru' });
    assert.equal((await s.offers.reselect(id)).picked, 1);
    g = (await api(`/api/tenders/${id}/offers`)).body.groups[0];
    assert.deepEqual([g.selected_offer_id, g.best.id, g.ranked.map((o) => o.id)], [shop, shop, [shop]]);
    e = (await api(`/api/tenders/${id}/economics`, { method: 'POST', json: {} })).body.economics;
    assert.deepEqual([e.confirmed, e.result.inputs.items[0].purchase_price, e.result.inputs.items[0].purchase_source], [true, 52000, 'поиск поставщиков']);

    // ориентир в карточке: за сколько закупку целиком продавали конкуренты (по прошлым контрактам с тем же товаром)
    const card = (await api(`/api/tenders/${id}`)).body;
    const cp = card.competitor_price;
    if (cp) {
      assert.ok(cp.covered >= 1 && cp.of === card.items.length && cp.low > 0 && cp.mid >= cp.low && typeof cp.complete === 'boolean', JSON.stringify(cp));
      const u = card.item_benchmarks[card.items[0].id].unit_price;
      assert.equal(cp.low, Math.round(u.p25 * card.items[0].quantity * 100) / 100);
    } else {
      assert.equal(Object.values(card.item_benchmarks).filter((b) => b.unit_price).length, 0, 'нет контрактов с тем же товаром — нет и ориентира');
    }
  } finally {
    s.server.close();
  }
});
