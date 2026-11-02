// Этап 2: источники по группам товаров — связь групп с сайтами, уровни проверки, покрытие.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGroupSources } = require('../server/offers/group-sources');
const productGroups = require('../server/tenders/product-groups');

// Позиции закупок: картриджи (коды 20.59.12), канцтовары (32.99.1), мясо (10.1); цены сайтов по картриджам.
function fakeRepo() {
  const items = [
    { id: 1, name: 'Картридж лазерный CF226X', okpd2_code: '20.59.12.120', ktru_code: null },
    { id: 2, name: 'Картридж тонер TK-1170', okpd2_code: '20.59.12.120', ktru_code: null },
    { id: 3, name: 'Ручка шариковая синяя', okpd2_code: '32.99.12.110', ktru_code: null },
    { id: 4, name: 'Говядина замороженная', okpd2_code: '10.11.31.110', ktru_code: null },
  ];
  const offers = [
    { item_id: 1, tender_id: 10, domain: 'www.ink-market.ru', match: 'частично', seller_region: 77 },
    { item_id: 2, tender_id: 11, domain: 'ink-market.ru', match: 'соответствует', seller_region: 77 },
    { item_id: 1, tender_id: 10, domain: 'apteka.ru', match: 'частично', seller_region: 50 }, // одна случайная — не в счёт
    { item_id: 1, tender_id: 10, domain: 'citilink.ru', match: 'соответствует', seller_region: 77 }, // розница
    { item_id: 2, tender_id: 11, domain: 'bad.ru', match: 'не соответствует', seller_region: 77 },
  ];
  return { groupSourceRows: () => ({ items, offers }) };
}

const catalog = () => [
  { site: 'cartridge.ru', name: 'Картридж.ру', access_mode: 'public_site', directions: ['g-cartridges'] },
  { site: 'kns.ru', name: 'КНС', access_mode: 'public_site', directions: ['office'] }, // направление основной ниши
  { site: 'merlion.com', name: 'Merlion', access_mode: 'api_partner', directions: ['computers'] },
  { site: 'bestkanc.ru', name: 'Бесткан', access_mode: 'public_site', directions: ['g-stationery'] },
  { site: 'kanc-mir.ru', name: 'Канц-мир', access_mode: 'public_site', directions: ['g-stationery'] },
  { site: 'office-planet.ru', name: 'Офис-Планета', access_mode: 'public_site', directions: ['g-stationery'] },
];
const stores = () => ({ retail: [{ site: 'citilink.ru' }], b2b: [] });
const siteStatus = () => ({ sites: [{ domain: 'bestkanc.ru', pages: 87006, status: 'ok' }, { domain: 'kanc-mir.ru', pages: 97455, status: 'ok' }] });

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-sources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gs.json');
  fs.writeFileSync(file, JSON.stringify({ checked_at: '2026-10-22', groups: {
    cartridges: { channel: 'open_wholesale', delivery: 'national', auto: 'yes', docs: 'чип' },
    'food-meat': { channel: 'local_quote', delivery: 'local', auto: 'no' },
  } }));
  return createGroupSources({ repo: fakeRepo(), catalog, stores, siteStatus, profileFile: file });
}

test('у каждой группы каталога есть строка; спрос считается по позициям закупок', (t) => {
  const r = setup(t).get();
  assert.equal(r.groups.length, productGroups.loadGroups().length);
  const g = (id) => r.groups.find((x) => x.id === id);
  assert.equal(g('cartridges').demand, 2);
  assert.equal(g('stationery').demand, 1);
  assert.equal(g('food-meat').demand, 1);
});

test('картриджи: сайт с ценами из поиска — «проверено делом», случайная одна цена и розница в закупочную цену не идут', (t) => {
  const g = setup(t).get().groups.find((x) => x.id === 'cartridges');
  const by = Object.fromEntries(g.sources.map((s) => [s.site, s]));
  assert.equal(by['ink-market.ru'].level, 'used');
  assert.equal(by['ink-market.ru'].used_offers, 2);
  assert.equal(by['ink-market.ru'].region, 77);
  assert.ok(by['ink-market.ru'].roles.offers);
  assert.ok(!by['apteka.ru'], 'одна «частичная» цена — случайность');
  assert.ok(!by['bad.ru'], '«не соответствует» не делает сайт источником');
  assert.equal(by['citilink.ru'].price, 'retail');
  assert.ok(!by['citilink.ru'].roles.offers && by['citilink.ru'].roles.specs && by['citilink.ru'].roles.reference_price);
  // компания основной ниши (направление office) привязана к картриджам по кодам
  assert.ok(by['kns.ru'], 'КНС из направления «оргтехника»');
  assert.equal(by['cartridge.ru'].level, 'checked');
  assert.equal(g.coverage, 'good');
  assert.equal(g.sources[0].site, 'ink-market.ru', 'проверенное делом — первым');
  assert.equal(g.docs, 'чип');
});

test('канцтовары: три сайта с ценами и собранные каталоги — «хорошо», но ещё без цен из поиска', (t) => {
  const g = setup(t).get().groups.find((x) => x.id === 'stationery');
  assert.equal(g.counts.open, 3);
  assert.equal(g.counts.indexed, 2);
  assert.equal(g.coverage, 'good');
  assert.match(g.advice, /ещё не получали/);
  assert.match(g.sources.find((s) => s.site === 'bestkanc.ru').verified, /каталог страниц собран/);
});

test('компьютеры: только API партнёра — «мало», нужна регистрация; мясо — «нет источников», совет про КП', (t) => {
  const r = setup(t).get();
  const pc = r.groups.find((x) => x.id === 'computers');
  const m = pc.sources.find((s) => s.site === 'merlion.com');
  assert.equal(m.price, 'api');
  assert.equal(m.registration, true);
  assert.ok(!m.roles.offers);
  assert.equal(pc.coverage, 'weak');
  const meat = r.groups.find((x) => x.id === 'food-meat');
  assert.equal(meat.coverage, 'none');
  assert.match(meat.advice, /КП/);
  assert.ok(!r.summary.gaps.some((x) => x.id === 'food-meat'), 'где цен не публикуют — не в списке «с чего начать»');
});
