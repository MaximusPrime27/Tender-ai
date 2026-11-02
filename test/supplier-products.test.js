// Блок «Профильные компании»: у компаний с открытыми ценами сервис сам показывает товар, цену и наличие — искать модель
// на сайте компании вручную не нужно. Сеть и нейросеть подменены.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { createLlm } = require('../server/llm');
const { attachProducts, onSite } = require('../server/offers/supplier-catalog');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const NOW = new Date('2026-09-17T09:00:00Z');
const res = (body, type = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'content-type': type } });
const urlset = (urls) => `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const XML = (docs) => `<?xml version="1.0"?><yandexsearch><response><results><grouping>${docs.map((u) => `<group><doc><url>${u}</url><domain>${new URL(u).hostname}</domain><title>t</title></doc></group>`).join('')}</grouping></results></response></yandexsearch>`;
const product = (title, price, stock = '') => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: title, offers: { price: String(price), priceCurrency: 'RUB', availability: 'https://schema.org/InStock' } })}</script></head><body><h1>${title}</h1><p>${stock} Процессор: 6 ядер, 12 потоков, 3.9 ГГц. Оперативная память: 16 ГБ DDR4</p></body></html>`;

test('товар у компании: предложения с её сайта, сначала подходящие и дешёвые; городское зеркало — тот же магазин', () => {
  assert.ok(onSite('kazan.xcom-shop.ru', 'xcom-shop.ru') && onSite('www.kns.ru', 'kns.ru') && !onSite('notkns.ru', 'kns.ru'));
  const offers = [
    { id: 1, source: 'wholesale', domain: 'kns.ru', url: 'https://kns.ru/a', title: 'Диск A', unit_price: 9000, match: 'не соответствует' },
    { id: 2, source: 'wholesale', domain: 'www.kns.ru', url: 'https://www.kns.ru/b', title: 'Диск B', unit_price: 12000, match: 'соответствует', stock_qty: 5, match_checks: { confirmed: 7, total: 7 } },
    { id: 3, source: 'yandex', domain: 'kns.ru', url: 'https://kns.ru/c', title: 'Диск C', unit_price: 11000, match: 'частично', match_checks: { confirmed: 5, total: 7, of: 7 } },
    { id: 4, source: 'contracts', domain: 'kns.ru', url: 'https://zakupki.gov.ru/x', title: 'по госконтракту', unit_price: 1, match: 'соответствует' },
    { id: 5, source: 'yandex', domain: 'other.ru', url: 'https://other.ru/d', title: 'Диск D', unit_price: 1000, match: 'соответствует' },
  ];
  const [shop, opt, empty] = attachProducts([
    { site: 'kns.ru', access_mode: 'public_site' }, { site: 'merlion.com', access_mode: 'api_partner' }, { site: 'regard.ru', access_mode: 'public_site' },
  ], offers, (site) => (site === 'regard.ru' ? { status: 'none', models: ['ST8000'] } : null));
  assert.deepEqual(shop.products.map((p) => [p.id, p.unit_price, p.match]), [[2, 12000, 'соответствует'], [3, 11000, 'частично']], 'неподходящий товар в блок не идёт');
  assert.equal(shop.unfit, null);
  // на сайте нашёлся только неподходящий товар — он показан отдельной строкой с причиной, а поиск подходящего продолжается
  const [onlyBad] = attachProducts([{ site: 'kns.ru', access_mode: 'public_site' }], [{ ...offers[0], match_notes: ['Объем накопителя: нужно ≥ 8000, у товара 500'] }]);
  assert.deepEqual([onlyBad.products.length, onlyBad.unfit.id, onlyBad.unfit.why, onlyBad.lookup.status], [0, 1, 'Объем накопителя: нужно ≥ 8000, у товара 500', 'pending']);
  assert.deepEqual([shop.products[0].stock_qty, shop.products[0].confirmed, shop.products[0].of], [5, 7, 7]);
  assert.deepEqual([shop.open_prices, shop.lookup.status], [true, 'found']);
  assert.deepEqual([opt.open_prices, opt.products.length, opt.lookup], [false, 0, null], 'у дистрибьютора цены на сайте нет — искать нечего');
  assert.deepEqual([empty.lookup.status, empty.lookup.models], ['none', ['ST8000']]);
  assert.equal(attachProducts([{ site: 'regard.ru', access_mode: 'public_site' }], [])[0].lookup.status, 'pending', 'ещё не искали');
});

function start(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-cand-'));
  const stores = path.join(dir, 'stores.json');
  const shop = (name, site) => ({ name, site, enabled: true, dir: 'computers' });
  fs.writeFileSync(stores, JSON.stringify({ stores: [], b2b: [], retail: [], distributors: [{ name: 'Дистрибьютор', site: 'distr.ru', dir: 'computers', access_mode: 'api_partner' }],
    suppliers: [shop('Опт один', 'opt-one.ru'), shop('Опт два', 'opt-two.ru'), shop('Опт три', 'opt-three.ru'), shop('Опт четыре', 'opt-four.ru')] }));
  const pages = {
    'https://opt-one.ru/catalog/sistemnyy-blok-acme-ao-5000x-1/': product('Системный блок Acme AO-5000X', 47000),
    'https://opt-two.ru/p/sistemnyy-blok-acme-ao-5000x.html': product('Системный блок Acme AO-5000X', 43000, 'В наличии: 14 шт.'),
    'https://web-shop.ru/acme-ao-5000x': product('Системный блок Acme AO-5000X', 49000),
  };
  const calls = { pages: [], yandex: 0 };
  const sitemaps = {
    'opt-one.ru': ['https://opt-one.ru/catalog/sistemnyy-blok-acme-ao-5000x-1/'],
    'opt-two.ru': ['https://opt-two.ru/p/sistemnyy-blok-acme-ao-5000x.html'],
    'opt-three.ru': ['https://opt-three.ru/p/sistemnyy-blok-drugoy-zz-900.html'],
    'opt-four.ru': ['https://opt-four.ru/p/sistemnyy-blok-acme-ao-5000x.html'],
  };
  const fetchImpl = async (url) => {
    const u = String(url);
    const host = new URL(u).hostname;
    if (u.startsWith('https://searchapi.api.cloud.yandex.net')) { calls.yandex++; return res(JSON.stringify({ rawData: Buffer.from(XML(['https://web-shop.ru/acme-ao-5000x'])).toString('base64') }), 'application/json'); }
    if (u.startsWith('https://suggestions.dadata.ru')) return res('{"suggestions":[]}', 'application/json');
    if (u.endsWith('/robots.txt')) return sitemaps[host] ? res('User-agent: *\nAllow: /', 'text/plain') : res('', 'text/plain', 404);
    if (u.endsWith('/sitemap.xml') && sitemaps[host]) return res(urlset(sitemaps[host]), 'application/xml');
    calls.pages.push(u);
    if (host === 'opt-four.ru') return res('Forbidden', 'text/html', 403);
    return pages[u] ? res(pages[u]) : res('<html><body>Контакты</body></html>');
  };
  const mock = createLlm('mock');
  const llm = { provider: 'fake', model: 'fake', async complete(req) {
    if (req.task !== 'models') return mock.complete(req);
    return { text: JSON.stringify({ products: [{ name: 'Системный блок Acme AO-5000X', brand: 'Acme', model: 'AO-5000X' }] }), usage: { in: 0, out: 0 } };
  } };
  const config = {
    ...baseConfig, SEARCH_FREE_BY_WORDS: false, DATA_DIR: dir, STORES_CONFIG: stores, SUPPLIER_CANDIDATES_CONFIG: path.join(dir, 'нет-такого.json'), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, FETCH_MIN_INTERVAL_MS: 0,
    YANDEX_SEARCH_API_KEY: 'k', YANDEX_FOLDER_ID: 'f', DADATA_API_KEY: '', OFFER_SOURCES: 'yandex', SEARCH_MAX_PAGES: 100,
    // поиск сам берёт из каталога поставщиков только одну страницу и «не дожимает» — остальное должен найти блок компаний
    SEARCH_WHOLESALE_PAGES: 1, SEARCH_SWEEP_PAGES: 0, SEARCH_REFINE_PAGES: 0, SEARCH_PLAIN_QUERY: false, ...overrides,
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, fetchImpl, llmFactory: () => llm, clock: () => NOW, sourceOverride: createFixtureSource({ dir: FIX }) });
  const api = async (p, post) => {
    const r = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, { method: post ? 'POST' : 'GET' });
    return { status: r.status, body: await r.json() };
  };
  return { s, api, calls };
}

async function tender(s) {
  await s.sync.run();
  const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
  const [item] = await s.details.ensureItems(s.repo.getTender(id));
  s.repo.db.prepare('UPDATE tender_items SET characteristics_json = ?, spec_json = NULL WHERE id = ?')
    .run(JSON.stringify([{ name: 'Количество ядер процессора', value: 'не менее 6 шт' }, { name: 'Объем установленной оперативной памяти', value: 'не менее 8 Гбайт' }, { name: 'Тип оперативной памяти', value: 'DDR4' }]), item.id);
  await s.siteIndex.refreshAll(s.offers.supplierDomains());
  return { id, itemId: item.id };
}
const bySite = (body) => Object.fromEntries(body.groups[0].candidates.map((c) => [c.site, c]));

test('блок компаний: товар, цена и наличие показаны у компании; где поиск не дошёл — сервис находит товар сам, бесплатно', async () => {
  const { s, api, calls } = start({ SEARCH_CANDIDATE_LOOKUPS: 0 });
  try {
    const { id } = await tender(s);
    s.offers.start(id, { auto: true });
    await s.offers.idle();
    let c = bySite((await api(`/api/tenders/${id}/offers`)).body);
    // сразу после поиска: у одной компании товар уже найден — он и показан, с ценой и наличием; остальных поиск не открывал
    const two = c['opt-two.ru'].products[0];
    assert.deepEqual([two.title, two.unit_price, two.stock_qty, two.match, two.confirmed, two.of], ['Системный блок Acme AO-5000X', 43000, 14, 'соответствует', 3, 3]);
    assert.equal(two.url, 'https://opt-two.ru/p/sistemnyy-blok-acme-ao-5000x.html');
    assert.equal(c['opt-two.ru'].lookup.status, 'found');
    assert.deepEqual(['opt-one.ru', 'opt-three.ru', 'opt-four.ru'].map((x) => [c[x].open_prices, c[x].products.length, c[x].lookup.status]), [[true, 0, 'pending'], [true, 0, 'pending'], [true, 0, 'pending']]);
    assert.deepEqual([c['distr.ru'].open_prices, c['distr.ru'].lookup], [false, null], 'дистрибьютор: цену нужно запрашивать');

    const paid = calls.yandex;
    const r = (await api(`/api/tenders/${id}/supplier-candidates/lookup`, true)).body;
    assert.deepEqual([r.checked, r.found, r.left], [2, 1, 0], 'открыты страницы двух компаний, где модель есть в каталоге страниц');
    assert.equal(calls.yandex, paid, 'платных запросов нет');
    c = bySite(r);
    const one = c['opt-one.ru'].products[0];
    assert.deepEqual([one.unit_price, one.match, one.stock_qty, c['opt-one.ru'].lookup.status], [47000, 'соответствует', null, 'found']);
    assert.deepEqual([c['opt-three.ru'].lookup.status, c['opt-three.ru'].lookup.models], ['none', ['AO-5000X']], 'модели на сайте нет — сказано, какую искали');
    assert.equal(c['opt-four.ru'].lookup.status, 'no_price');
    assert.match(c['opt-four.ru'].lookup.reason, /не пускает программы/);
    // найденное — обычное предложение: стоит в общей таблице «Где купить»; в расчёте остаётся самое дешёвое подходящее
    const g = r.groups[0];
    assert.ok(g.ranked.some((o) => o.domain === 'opt-one.ru' && o.source === 'wholesale'));
    assert.equal(g.ranked.find((o) => o.id === g.selected_offer_id).unit_price, 43000);

    const again = (await api(`/api/tenders/${id}/supplier-candidates/lookup`, true)).body;
    assert.deepEqual([again.checked, again.found, again.left], [0, 0, 0], 'второй раз те же сайты не открываются');
    assert.equal(calls.pages.filter((u) => u.includes('opt-four.ru')).length, 1);
  } finally {
    await s.close();
  }
});

test('поиск поставщиков сам проверяет компании с открытыми ценами; новый поиск начинает проверку заново', async () => {
  const { s, api } = start();
  try {
    const { id } = await tender(s);
    const first = s.offers.start(id, { auto: true });
    await s.offers.idle();
    const log = s.repo.getOfferSearch(first).log.map((l) => l.text).join('\n');
    assert.match(log, /У компаний с открытыми ценами дополнительно открыто страниц товара: 2, с ценой: 1/);
    let c = bySite((await api(`/api/tenders/${id}/offers`)).body);
    assert.deepEqual(['opt-one.ru', 'opt-two.ru', 'opt-three.ru', 'opt-four.ru'].map((x) => c[x].lookup.status), ['found', 'found', 'none', 'no_price']);
    const g = (await api(`/api/tenders/${id}/offers`)).body.groups[0];
    assert.equal(g.ranked.find((o) => o.id === g.selected_offer_id).unit_price, 43000, 'в расчёте — самое дешёвое подходящее');

    // после нового поиска прежние «не найдено» не действуют: предложения пересобраны, проверка идёт заново
    s.offers.start(id, { auto: true });
    await s.offers.idle();
    c = bySite((await api(`/api/tenders/${id}/offers`)).body);
    assert.equal(c['opt-two.ru'].products.length, 1, 'выбранное предложение пережило новый поиск и найдено снова — в блоке одна строка');
    assert.equal(c['opt-one.ru'].products.length, 1);
    assert.equal(c['opt-three.ru'].lookup.status, 'none');
  } finally {
    await s.close();
  }
});
