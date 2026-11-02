// Поиск товара, который в ТЗ описан характеристиками, без модели: подбор конкретных товаров под требования,
// запросы с отличительными признаками, товары со страницы каталога. Сеть и нейросеть подменены.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { createLlm } = require('../server/llm');
const { extractStructured, htmlToText, FetchSkipped } = require('../server/offers/fetch-page');
const { extractOffer } = require('../server/offers/extract');
const { suggestProducts, normalizeCandidates, requirementsFor, pickFromListing, deliveredBrands } = require('../server/offers/candidates');
const { specQueries, siteQuery } = require('../server/offers/sources/yandex-search');
const { listingOf, productLinks } = require('../server/offers/listing');
const { productText } = require('../server/offers/product');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const NOW = new Date('2026-09-17T09:00:00Z');

const NOTEBOOK = { name: 'Ноутбук', quantity: 5, unit: 'шт' };
const NOTEBOOK_SPEC = {
  name: 'Ноутбук', identity: {},
  required: [
    { name: 'Диагональ экрана', value: 'не менее 16 дюйм' },
    { name: 'Объём оперативной памяти', value: 'не менее 16 ГБ' },
    { name: 'Объём накопителя SSD', value: 'не менее 512 ГБ' },
    { name: 'Наличие веб-камеры', value: 'Да' },
    { name: 'Гарантия', value: 'не менее 12 мес' },
  ],
};

/** Подставная нейросеть: на задачу «models» отвечает заданным списком, остальное — как правила. */
function fakeLlm(products, calls = { models: 0 }) {
  const mock = createLlm('mock');
  return {
    provider: 'fake', model: 'fake',
    async complete(req) {
      if (req.task !== 'models') return mock.complete(req);
      calls.models++;
      calls.last = JSON.parse(req.messages[0].content);
      return { text: JSON.stringify({ products }), usage: { in: 0, out: 0 } };
    },
  };
}

function memoryRepo() {
  const store = new Map();
  return { getSetting: (k) => store.get(k) ?? null, setSetting: (k, v) => store.set(k, v), store };
}

test('кандидаты: конкретные товары остаются, общие названия и повторы отбрасываются', () => {
  const out = normalizeCandidates([
    { name: 'Ноутбук Lenovo IdeaPad Slim 5 16IRL8 16" 16 ГБ 512 ГБ', brand: 'Lenovo', model: 'IdeaPad Slim 5 16IRL8' },
    { name: 'Ноутбук', brand: '', model: '' },
    { name: 'Ноутбук офисный недорогой', brand: '', model: '' },
    { name: 'Ноутбук «Lenovo» IdeaPad Slim 5 (16IRL8)', brand: 'Lenovo', model: 'IdeaPad-Slim-5 16IRL8' },
    { name: '', brand: 'ASUS', model: 'Vivobook 16 X1605' },
    { name: 'x', brand: '', model: '' },
  ], 'Ноутбук');
  assert.deepEqual(out.map((c) => c.name), ['Ноутбук Lenovo IdeaPad Slim 5 16IRL8 16 16 ГБ 512 ГБ', 'ASUS Vivobook 16 X1605']);
  assert.equal(out[0].query, 'Ноутбук Lenovo IdeaPad Slim 5 16IRL8 купить', 'в запросе — тип, производитель и модель, без параметров');
  assert.equal(out[1].query, 'ASUS Vivobook 16 X1605 купить');
  const hdd = normalizeCandidates([
    { name: 'Жесткий диск Seagate IronWolf Pro ST8000NE0001 8TB SATA III CMR 3,5 7200rpm 256MB', brand: 'Seagate', model: 'Seagate IronWolf Pro ST8000NE0001' },
    { name: 'Бумага SvetoCopy Classic A4 80 г/м2 500 листов белизна 146 CIE класс C', brand: 'SvetoCopy', model: '' },
  ], 'Накопитель данных внутренний');
  assert.equal(hdd[0].query, 'Жесткий диск Seagate IronWolf Pro ST8000NE0001 купить', 'производитель не повторяется');
  assert.equal(hdd[1].query, 'Бумага SvetoCopy Classic A4 80 г/м2 500 листов купить', 'модели нет — начало названия');
  assert.equal(normalizeCandidates([{ name: 'МФУ Pantum M6700DW', brand: 'Pantum', model: 'M6700DW' }, { name: 'МФУ HP 135w', brand: 'HP', model: '135w' }], 'МФУ', 1).length, 1, 'не больше заданного числа');
});

test('кандидаты: в нейросеть уходят требования без гарантии и упаковки; ответ помнится месяц', async () => {
  assert.deepEqual(requirementsFor(NOTEBOOK_SPEC).map((r) => r.name), ['Диагональ экрана', 'Объём оперативной памяти', 'Объём накопителя SSD', 'Наличие веб-камеры']);
  const calls = { models: 0 };
  const llm = fakeLlm([{ name: 'Ноутбук ASUS Vivobook 16 X1605VA', brand: 'ASUS', model: 'X1605VA' }, { name: 'Ноутбук Lenovo V16 G4', brand: 'Lenovo', model: 'V16 G4' }], calls);
  const repo = memoryRepo();
  let now = NOW;
  const ask = (max = 5) => suggestProducts({ item: NOTEBOOK, spec: NOTEBOOK_SPEC, delivered: ['Ноутбук ASUS', 'Ноутбук ASUS'], llm, system: 'models', repo, clock: () => now, max });

  const first = await ask();
  assert.deepEqual(first.map((c) => c.model), ['X1605VA', 'V16 G4']);
  assert.equal(calls.last.item.name, 'Ноутбук');
  assert.deepEqual(calls.last.delivered_before, ['Ноутбук ASUS'], 'что поставляли раньше — без повторов');
  assert.equal((await ask(1)).length, 1);
  assert.equal(calls.models, 1, 'второй раз нейросеть не спрашиваем — ответ в кеше');
  now = new Date(NOW.getTime() + 31 * 86400000);
  await ask();
  assert.equal(calls.models, 2, 'через месяц спрашиваем заново: модели снимают с продажи');

  assert.deepEqual(await suggestProducts({ item: NOTEBOOK, spec: { required: [] }, llm, system: 'models', repo }), [], 'без требований подбирать не из чего');
  assert.equal(calls.models, 2);
});

test('кандидаты: подсказка из контрактов сбила нейросеть — спрашиваем ещё раз без неё; пустой ответ помним сутки', async () => {
  assert.deepEqual(deliveredBrands(['Ноутбук. Товарный знак: TECNO', 'Ноутбук. Товарный знак: TECNO', 'Ноутбук. Товарный знак: отсутствует', 'Ноутбук. Товарный знак: 1023675', 'Ноутбук ASUS X515']),
    ['Ноутбук. Товарный знак: TECNO', 'Ноутбук ASUS X515']);
  const seen = [];
  const llm = {
    async complete(req) {
      const input = JSON.parse(req.messages[0].content);
      seen.push(input.delivered_before.length);
      const products = input.delivered_before.length ? [] : [{ name: 'Ноутбук MSI Creator Z16', brand: 'MSI', model: 'Creator Z16' }];
      return { text: JSON.stringify({ products }), usage: { in: 0, out: 0 } };
    },
  };
  const out = await suggestProducts({ item: NOTEBOOK, spec: NOTEBOOK_SPEC, delivered: ['Ноутбук. Товарный знак: TECNO'], llm, system: 'models', repo: memoryRepo() });
  assert.deepEqual(seen, [1, 0]);
  assert.equal(out[0].query, 'Ноутбук MSI Creator Z16 купить');

  let asked = 0;
  const silent = { async complete() { asked++; return { text: '{"products":[]}', usage: { in: 0, out: 0 } }; } };
  const repo = memoryRepo();
  let now = NOW;
  const ask = () => suggestProducts({ item: NOTEBOOK, spec: NOTEBOOK_SPEC, llm: silent, system: 'models', repo, clock: () => now });
  assert.deepEqual(await ask(), []);
  await ask();
  assert.equal(asked, 1, 'в тот же день повторно не спрашиваем');
  now = new Date(NOW.getTime() + 2 * 86400000);
  await ask();
  assert.equal(asked, 2, 'через день — спрашиваем снова');
});

test('запросы без модели: название с отличительными признаками, без «Да» и гарантий', () => {
  const qs = specQueries(NOTEBOOK, NOTEBOOK_SPEC, 2);
  assert.equal(qs.length, 2);
  assert.match(qs[0], /^Ноутбук .*купить$/);
  assert.match(qs[0], /16/);
  assert.doesNotMatch(qs.join(' '), /\bДа\b|мес/);
  assert.notEqual(qs[0], qs[1]);
  assert.equal(specQueries(NOTEBOOK, NOTEBOOK_SPEC, 1).length, 1);
  const forPrinter = specQueries({ name: 'Картридж' }, { name: 'Картридж', identity: { compatible_with: 'Kyocera ECOSYS M2040dn' }, required: [{ name: 'Ресурс', value: 'не менее 7200 стр' }] }, 2);
  assert.ok(forPrinter.some((q) => /для Kyocera ECOSYS M2040dn купить/.test(q)), 'расходник ищем по устройству, для которого он нужен');
  // Запрос по сайту: без признаков поисковик отдаёт раздел каталога, а не товар.
  assert.equal(siteQuery(NOTEBOOK, 'pulscen.ru'), 'site:pulscen.ru Ноутбук');
  assert.equal(siteQuery(NOTEBOOK, 'pulscen.ru', ['16 дюйм', '512 ГБ', '16 ГБ']), 'site:pulscen.ru Ноутбук 16 дюйм 512 ГБ');
  assert.equal(siteQuery({ name: 'Картридж Kyocera TK-5240K' }, 'pulscen.ru', ['7200 стр']), 'site:pulscen.ru Картридж Kyocera TK-5240K', 'модель уже в названии — признаки не нужны');
});

const LISTING = [
  { title: 'Ноутбук ASUS Vivobook 16 X1605VA 16" 16 ГБ SSD 512 ГБ', price: 58990, url: 'https://shop.ru/p/1' },
  { title: 'Ноутбук Lenovo V15 G4 15.6" 8 ГБ SSD 256 ГБ', price: 39990, url: 'https://shop.ru/p/2' },
  { title: 'Сумка для ноутбука 16"', price: 1990, url: 'https://shop.ru/p/3' },
  { title: 'Ноутбук Honor MagicBook X16 16" 16 ГБ SSD 512 ГБ', price: 54990, url: 'https://shop.ru/p/4' },
  { title: 'Ноутбук Acer Extensa 16 EX216 16" 16 ГБ SSD 512 ГБ', price: 49990, url: 'https://shop.ru/p/5' },
  { title: 'Ноутбук без цены', price: null, url: 'https://shop.ru/p/6' },
  { title: 'Мышь беспроводная', price: 590, url: 'https://shop.ru/p/7' },
];

test('каталог: берём товары того же типа, ближе к ТЗ и дешевле; модель-кандидат — первой', () => {
  const picks = pickFromListing(LISTING, { item: NOTEBOOK, spec: NOTEBOOK_SPEC, max: 3 });
  assert.deepEqual(picks.map((p) => p.url), ['https://shop.ru/p/5', 'https://shop.ru/p/4', 'https://shop.ru/p/1'], 'подходят по трём признакам — от дешёвого к дорогому');
  assert.ok(!picks.some((p) => /Мышь|без цены/.test(p.title)));
  const all = pickFromListing(LISTING, { item: NOTEBOOK, spec: NOTEBOOK_SPEC, max: 10 }).map((p) => p.url);
  assert.ok(!all.includes('https://shop.ru/p/7') && !all.includes('https://shop.ru/p/6'), 'чужой товар и товар без цены не берём');
  assert.ok(!all.includes('https://shop.ru/p/2'), 'ноутбук 15.6" с 8 ГБ при требовании «не менее 16» — в названии уже видно, что не подходит: не открываем');
  const withModel = pickFromListing(LISTING, { item: NOTEBOOK, spec: NOTEBOOK_SPEC, candidates: [{ model: 'X1605VA', brand: 'ASUS' }], max: 2 });
  assert.equal(withModel[0].url, 'https://shop.ru/p/1', 'товар, который подобран под ТЗ, открываем первым');
  assert.deepEqual(pickFromListing([], { item: NOTEBOOK, spec: NOTEBOOK_SPEC }), []);
});

const ld = (products) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList',
  itemListElement: products.map((p, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@type': 'Product', name: p.title, url: p.url, offers: { '@type': 'Offer', price: p.price, priceCurrency: 'RUB' } } })) })}</script>`;

test('страница каталога: предложением не считается, но список товаров с неё отдаётся поиску', async () => {
  const html = `<html><head>${ld([...LISTING.filter((p) => p.price), { title: 'Ноутбук с чужого сайта', price: 100, url: 'https://other.ru/p/9' }])}</head><body>Каталог ноутбуков</body></html>`;
  const page = { url: 'https://shop.ru/catalog/notebooks', html, text: htmlToText(html), structured: extractStructured(html, 'https://shop.ru/catalog/notebooks') };
  await assert.rejects(extractOffer(page, { ...NOTEBOOK, spec: NOTEBOOK_SPEC }, {}), (err) => {
    assert.ok(err instanceof FetchSkipped);
    assert.match(err.message, /страница каталога/);
    assert.equal(err.listing.length, 6);
    assert.ok(!err.listing.some((p) => p.url.includes('other.ru')), 'ссылки на другой сайт не берём');
    assert.deepEqual(Object.keys(err.listing[0]), ['title', 'price', 'url']);
    return true;
  });
});

// ---------- поиск целиком ----------
const XML = (docs) => `<?xml version="1.0"?><yandexsearch><response><results><grouping>${docs.map((u) => `<group><doc><url>${u}</url><domain>${new URL(u).hostname}</domain><title>t</title></doc></group>`).join('')}</grouping></results></response></yandexsearch>`;
const product = (title, price) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: title, offers: { price: String(price), priceCurrency: 'RUB' } })}</script></head><body><h1>${title}</h1><p>Процессор: 6 ядер, 12 потоков, 3.9 ГГц</p></body></html>`;
const CATALOG = [
  { title: 'Системный блок Acme Office 500 (6 ядер)', price: 48000, url: 'https://catalog-shop.ru/p/1' },
  { title: 'Системный блок Бюджет (6 ядер)', price: 41000, url: 'https://catalog-shop.ru/p/2' },
  { title: 'Коврик для мыши', price: 300, url: 'https://catalog-shop.ru/p/3' },
  { title: 'Системный блок Игровой (8 ядер)', price: 99000, url: 'https://catalog-shop.ru/p/4' },
  { title: 'Клавиатура проводная', price: 900, url: 'https://catalog-shop.ru/p/5' },
];

// Каталог без разметки schema.org: только заголовок и ссылки на товары.
const PLAIN_CATALOG = `<html><head><title>Системные блоки — купить в интернет-магазине</title></head><body><h1>Системные блоки</h1>
<a href="/cart">Корзина</a><a href="/catalog/acme">Системные блоки Acme 500</a>
<a href="/item/of-500"><span>42 000 ₽</span> Системный блок Office OF-500 (6 ядер)</a>
<a href="/item/bz-200">Системный блок Бизнес BZ-200 (6 ядер)</a>
<a href="/item/gm-900">Системный блок Игровой GM-900 (8 ядер)</a>
<a href="/item/st-100">Системный блок Старт ST-100 (4 ядра)</a>
<a href="/item/kb-1">Клавиатура проводная KB-1</a></body></html>`;

function start(overrides = {}, products = [{ name: 'Системный блок Acme Office 500', brand: 'Acme', model: 'Office 500' }]) {
  const calls = { yandex: [], pages: [], models: 0 };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const res = (body, type = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'content-type': type } });
    if (u.startsWith('https://searchapi.api.cloud.yandex.net')) {
      const q = JSON.parse(opts.body).query.queryText;
      calls.yandex.push(q);
      // По названию модели поисковик отдаёт страницу товара, по общему названию — раздел каталога.
      const docs = /Acme/.test(q) ? ['https://model-shop.ru/acme-office-500'] : ['https://catalog-shop.ru/catalog/pc', 'https://plain-shop.ru/catalog/pc'];
      return res(JSON.stringify({ rawData: Buffer.from(XML(docs)).toString('base64') }), 'application/json');
    }
    if (u.startsWith('https://suggestions.dadata.ru')) return res('{"suggestions":[]}', 'application/json');
    if (u.endsWith('/robots.txt')) return res('', 'text/plain', 404);
    calls.pages.push(u);
    if (u === 'https://plain-shop.ru/catalog/pc') return res(PLAIN_CATALOG);
    if (u.startsWith('https://plain-shop.ru/item/')) return res(product(`Системный блок ${u.split('/').pop().toUpperCase()} (6 ядер)`, 43000));
    if (u === 'https://catalog-shop.ru/catalog/pc') return res(`<html><head>${ld(CATALOG)}</head><body>Системные блоки</body></html>`);
    const fromCatalog = CATALOG.find((p) => p.url === u);
    if (fromCatalog) return res(product(fromCatalog.title, fromCatalog.price));
    if (u.startsWith('https://model-shop.ru/acme')) return res(product('Системный блок Acme Office 500 (6 ядер)', 46500));
    return res('<html><body>Контакты</body></html>');
  };
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-cand-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, FETCH_MIN_INTERVAL_MS: 0,
    YANDEX_SEARCH_API_KEY: 'k', YANDEX_FOLDER_ID: 'f', DADATA_API_KEY: '', OFFER_SOURCES: 'yandex',
    SEARCH_MAX_PAGES_PER_ITEM: 12, SEARCH_MAX_PAGES: 100, ...overrides,
  };
  const s = startServer(config, {
    scheduler: false, log: { log() {}, warn() {}, error() {} }, fetchImpl, llmFactory: () => fakeLlm(products, calls),
    clock: () => NOW, sourceOverride: createFixtureSource({ dir: FIX }),
  });
  return { s, calls };
}

async function goodsTender(s) {
  await s.sync.run();
  return s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
}

test('поиск без модели: товары подбираются под ТЗ и ищутся по названию; с каталога открываются похожие товары', async () => {
  const { s, calls } = start();
  try {
    const id = await goodsTender(s);
    const searchId = s.offers.start(id);
    await s.offers.idle();
    const search = s.repo.getOfferSearch(searchId);
    assert.equal(search.status, 'done', search.error);
    const log = search.log.map((l) => l.text).join('\n');

    assert.ok(calls.models >= 1, 'нейросеть спросили, какие товары подходят под требования');
    assert.match(log, /под требования ТЗ подобраны товары для поиска: Системный блок Acme Office 500/);
    assert.ok(calls.yandex.includes('Системный блок Acme Office 500 купить'), `запросы: ${calls.yandex.join(' | ')}`);
    assert.ok(!calls.yandex.some((q) => /оптом|дистрибьютор|с доставкой по России/.test(q)), 'общих запросов «оптом», «дистрибьютор» больше нет');

    assert.match(log, /catalog-shop\.ru: это страница каталога — открываю с неё похожие товары/);
    assert.ok(calls.pages.includes('https://catalog-shop.ru/p/1') && calls.pages.includes('https://catalog-shop.ru/p/2'), 'страницы товаров из каталога открыты');
    assert.ok(!calls.pages.includes('https://catalog-shop.ru/p/3') && !calls.pages.includes('https://catalog-shop.ru/p/5'), 'коврик и клавиатура — не тот товар');

    const offers = s.repo.getOffers(id);
    const fromListing = offers.filter((o) => o.source === 'listing');
    assert.ok(fromListing.length >= 2, 'предложения с каталога сохранены');
    assert.ok(fromListing.every((o) => /^https:\/\/(catalog-shop\.ru\/p\/\d|plain-shop\.ru\/item\/[a-z0-9-]+)$/.test(o.url)), 'ссылка — на страницу товара, а не каталога');
    // Каталог без разметки: раньше нейросеть брала с него первый попавшийся товар, теперь открываются страницы товаров.
    assert.match(log, /plain-shop\.ru: это страница каталога — открываю с неё похожие товары/);
    assert.ok(calls.pages.some((u) => u.startsWith('https://plain-shop.ru/item/')), 'страницы товаров из каталога без разметки открыты');
    assert.ok(!calls.pages.includes('https://plain-shop.ru/item/kb-1') && !calls.pages.includes('https://plain-shop.ru/catalog/acme'), 'клавиатура и раздел каталога — не товары');
    assert.ok(!offers.some((o) => o.url === 'https://plain-shop.ru/catalog/pc'), 'сам каталог предложением не стал');
    assert.ok(offers.some((o) => o.domain === 'model-shop.ru' && o.unit_price === 46500), 'товар, найденный по названию модели');

    // Тот же товар с теми же требованиями — нейросеть второй раз не спрашиваем.
    const asked = calls.models;
    s.offers.start(id);
    await s.offers.idle();
    assert.equal(calls.models, asked);
  } finally {
    s.server.close();
  }
});

test('поиск без модели: нейросеть ничего не назвала или подбор выключен — ищем по признакам и каталогам', async () => {
  const empty = start({}, []);
  try {
    const id = await goodsTender(empty.s);
    const searchId = empty.s.offers.start(id);
    await empty.s.offers.idle();
    const search = empty.s.repo.getOfferSearch(searchId);
    assert.equal(search.status, 'done', search.error);
    assert.ok(!search.log.some((l) => /подобраны товары/.test(l.text)));
    assert.ok(empty.s.repo.getOffers(id).some((o) => o.source === 'listing'), 'товары с каталога всё равно находятся');
  } finally {
    empty.s.server.close();
  }
  const off = start({ SEARCH_MODEL_CANDIDATES: 0, SEARCH_LISTING_MAX: 1 });
  try {
    const id = await goodsTender(off.s);
    off.s.offers.start(id);
    await off.s.offers.idle();
    assert.equal(off.calls.models, 0, 'SEARCH_MODEL_CANDIDATES=0 выключает подбор');
    const perItem = off.s.repo.getOffers(id).filter((o) => o.source === 'listing').length / off.s.repo.getItems(id).length;
    assert.ok(perItem <= 1, 'с каталогов — не больше SEARCH_LISTING_MAX товаров на позицию');
  } finally {
    off.s.server.close();
  }
});

test('слова запроса — как пишут магазины: «8 ТБ», «256 МБ», без повторов «A4/А4»', () => {
  const { distinctiveTerms, searchValue, itemSearchName } = require('../server/offers/spec');
  assert.equal(searchValue({ name: 'Объем накопителя', value: '≥ 8000 Гбайт' }), '8 ТБ');
  assert.equal(searchValue({ name: 'Объем буфера', value: 'не менее 256 Мбайт' }), '256 МБ');
  assert.equal(searchValue({ name: 'Объем оперативной памяти', value: '≥ 1024 Мб' }), '1 ГБ');
  assert.equal(searchValue({ name: 'Объем накопителя SSD', value: 'не менее 480 Гбайт' }), '480 ГБ');
  const terms = distinctiveTerms({ required: [{ name: 'Формат печати', value: 'A4' }, { name: 'Формат сканирования', value: 'А4' }, { name: 'Объем памяти', value: '≥ 256 Мбайт' }] }, 5);
  assert.equal(terms.filter((t) => /^[AА]4$/i.test(t)).length, 1, 'латинская и русская «А4» — одно значение');
  assert.equal(itemSearchName('Многофункциональное устройство (МФУ)'), 'МФУ');
  assert.equal(itemSearchName('Источник бесперебойного питания (ИБП)'), 'ИБП');
  assert.equal(itemSearchName('Бумага офисная (белая)'), 'Бумага офисная (белая)', 'обычное пояснение в скобках — не сокращение');
});

test('каталог без разметки: распознаётся по заголовку и ссылкам; страница товара каталогом не считается', () => {
  const item = { name: 'Ноутбук' };
  const catalog = `<html><head><title>Ноутбуки 16 дюймов купить</title></head><body><h1>Ноутбуки 16 дюймов</h1>
    <a href="/catalog/asus-17">Ноутбуки Asus 17"</a><a href="/compare/1">Ноутбук Acme Book 16 AB16-01 сравнить</a>
    <a href="/p/ab16-01"><b>74 999 ₽</b> Ноутбук Acme Book 16 AB16-01, 16&quot;, 16ГБ, SSD 512ГБ</a>
    <a href="/p/zb-1605">Ноутбук Zeta ZB-1605 16", 32ГБ</a><a href="/p/kx-16">Ноутбук Kappa KX-16 Pro</a>
    <a href="/p/lm-15"><img alt="Ноутбук Lambda LM-15 15.6"></a><a href="/p/bag">Сумка для ноутбука 16"</a>
    <a href="https://other.ru/p/1">Ноутбук Other OT-16</a></body></html>`;
  const links = listingOf({ html: catalog, url: 'https://shop.ru/catalog/notebooks-16' }, item);
  assert.deepEqual(links.map((l) => l.url), ['https://shop.ru/p/ab16-01', 'https://shop.ru/p/zb-1605', 'https://shop.ru/p/kx-16', 'https://shop.ru/p/lm-15'],
    'раздел «Ноутбуки Asus», сравнение, сумка без обозначения модели и чужой сайт — не товары');
  assert.equal(links[0].price, 74999, 'цена из текста ссылки');
  assert.equal(links[0].title, 'Ноутбук Acme Book 16 AB16-01, 16", 16ГБ, SSD 512ГБ');
  assert.equal(links[3].title, 'Ноутбук Lambda LM-15 15.6', 'название — из подписи к картинке');
  const picks = pickFromListing(links.map((l) => ({ ...l, trusted: true })), { item, spec: NOTEBOOK_SPEC, max: 2 });
  assert.equal(picks[0].url, 'https://shop.ru/p/ab16-01');

  const productPage = `<html><body><h1>Ноутбук Acme Book 16 AB16-01</h1><p>74 999 ₽</p><h2>Похожие товары</h2>
    <a href="/p/1">Ноутбук Zeta ZB-1605</a><a href="/p/2">Ноутбук Kappa KX-16</a><a href="/p/3">Ноутбук Lambda LM-15</a><a href="/p/4">Ноутбук Mu MU-14</a></body></html>`;
  assert.equal(listingOf({ html: productPage, url: 'https://shop.ru/p/ab16-01' }, item), null, 'в заголовке конкретная модель — это товар');

  // Раздел бренда: в ссылках только обозначения, слова «ноутбук» нет.
  const brand = `<html><body><h1>Ноутбуки Tecno</h1>${['T15DA', 'T16RA', 'K15SDA', 'K16SAA'].map((m) => `<a href="/description/23/tecno_megabook_${m.toLowerCase()}">TECNO MegaBook ${m} (AMD Ryzen 5 7430U, 15.6", 8Gb, SSD 512Gb)</a>`).join('')}
    <a href="/support/bench/compare.html?id=1">Valorant 1920x1080; Ultra Quality</a></body></html>`;
  const fromBrand = listingOf({ html: brand, url: 'https://shop.ru/catalog/tecno' }, item);
  assert.equal(fromBrand.length, 4);
  const exact = productLinks(brand, 'https://shop.ru/catalog/tecno', item, { models: ['T16RA'] }).filter((l) => l.exact);
  assert.deepEqual(exact.map((l) => l.url), ['https://shop.ru/description/23/tecno_megabook_t16ra'], 'модель из ТЗ — точная ссылка');
  // «Жёсткие диски»: в ТЗ «накопитель данных», тип товара подсказывают подобранные товары.
  const hdd = `<html><body><h1>Жёсткие диски</h1>${[1, 2, 3, 4].map((n) => `<a href="/hdd/st${n}000">Жёсткий диск Seagate Exos ST${n}000NM 8TB</a>`).join('')}<a href="/hdd">Жёсткие диски Seagate 8TB</a></body></html>`;
  assert.equal(listingOf({ html: hdd, url: 'https://shop.ru/hdd/all' }, { name: 'Накопитель данных внутренний' }), null);
  assert.equal(listingOf({ html: hdd, url: 'https://shop.ru/hdd/all' }, { name: 'Накопитель данных внутренний' }, { candidates: [{ name: 'Жёсткий диск WD Red Plus', brand: 'WD', model: 'Red Plus' }] }).length, 4);
});

test('текст для сверки с ТЗ: от названия товара и раздел характеристик, а не меню сайта', () => {
  const menu = Array.from({ length: 300 }, (_, i) => `<li><a href="/c/${i}">МЕНЮ Оперативная память Диски Экраны ${i}</a></li>`).join('');
  const filler = Array.from({ length: 200 }, (_, i) => `<p>Доставка в город номер ${i} послезавтра</p>`).join('');
  const html = `<html><head><title>Ноутбук Acme Book 16 AB16-01 — купить, цена и характеристики</title></head><body><ul>${menu}</ul>
    <h1>Ноутбук Acme Book 16 AB16-01</h1><p>Цена 74 999 ₽</p><a href="#specs">Характеристики</a>${filler}
    <h2>Характеристики</h2><table><tr><td>Диагональ экрана</td><td>16"</td></tr><tr><td>Объём оперативной памяти</td><td>16 ГБ</td></tr>
    <tr><td>Объём накопителя SSD</td><td>512 ГБ</td></tr><tr><td>Частота обновления экрана</td><td>165 Гц</td></tr></table><footer>ООО Магазин</footer></body></html>`;
  const page = { html, text: htmlToText(html) };
  assert.ok(page.text.length > 12000 && !page.text.slice(0, 4000).includes('512 ГБ'), 'в первых 4000 знаках — только меню');
  const out = productText(page, { title: 'Ноутбук Acme Book 16 AB16-01', requirements: NOTEBOOK_SPEC.required });
  assert.ok(out.length <= 7100);
  assert.match(out, /^Ноутбук Acme Book 16 AB16-01\s+Цена 74 999/);
  assert.match(out, /Объём оперативной памяти\s+16 ГБ[\s\S]*Объём накопителя SSD\s+512 ГБ/);
  assert.doesNotMatch(out, /МЕНЮ/);
  assert.equal(productText({ html: '<h1>Товар</h1>', text: 'Товар короткий' }, {}), 'Товар короткий', 'короткая страница — целиком');
});

test('сверка чисел: на странице число повторяется по-разному — «не подходит», только если не подходит ни одно', () => {
  const { checkNumbers } = require('../server/offers/match');
  const chars = [{ name: 'Количество ядер процессора', value: '≥ 12 шт.' }, { name: 'Общий объем накопителей SSD', value: 'не менее 500 Гбайт' }];
  const page = 'Ноутбук Acme ✔Core Ultra 7 255H (2.5/4.4/5.1 ГГц, 2/8/6 ядер) Максимальный объем памяти 8 Гб Накопители: 1 ТБ SSD. Количество ядер 16 ядер: 6 производительных, 8 энергоэффективных';
  const good = checkNumbers(chars, page);
  assert.deepEqual(good.fail, [], '«2/8/6 ядер» — это разбивка по видам ядер, ниже написано «ядер 16»');
  assert.equal(good.ok.length, 2);
  assert.match(good.ok[1], /у товара 1000 — подходит/, '«1 ТБ SSD» — это 1000 ГБ; «8 Гб Накопители» — не объём накопителя');
  const bad = checkNumbers(chars, 'Ноутбук Beta, 10-ядерный процессор, SSD 256ГБ');
  assert.equal(bad.fail.length, 2);
  assert.match(bad.fail[0], /нужно ≥ 12 шт\., у товара 10$/);
  assert.match(bad.fail[1], /у товара 256$/);
  assert.match(checkNumbers(chars, 'Объём накопителя ноутбука 500 Гб HDD').ok[0], /у товара 500/);
});

test('сверка чисел: единицы объёма приводятся, штуки со страницы с требованием не сравниваются', () => {
  const { checkNumbers } = require('../server/offers/match');
  const { checkUnits } = require('../server/offers/spec');
  const ram = [{ name: 'Объем установленной оперативной памяти', value: 'не менее 256 Мбайт' }];
  assert.match(checkNumbers(ram, 'МФУ Катюша M133pm, оперативная память: 1 ГБ').ok[0], /у товара 1024 — подходит/);
  assert.equal(checkNumbers(ram, 'МФУ Старый, оперативная память: 128 МБ').fail.length, 1);
  assert.equal(checkNumbers([{ name: 'Объем накопителя', value: 'не менее 1 Тбайт' }], 'Ноутбук, SSD 512 ГБ').fail.length, 1);
  const pages = [{ name: 'Количество печати страниц в месяц', value: 'не менее 20000 шт' }];
  assert.deepEqual(checkUnits(pages, 'МФУ HP M430f. В корзине 1 шт. Нагрузка до 80000 страниц в месяц'), { ok: [], fail: [] }, '«1 шт» в корзине — не ресурс печати');
  assert.equal(checkUnits([{ name: 'Плотность', value: 'не менее 80 г/м2' }], 'Бумага 70 г/м2').fail.length, 1, 'обычные единицы сравниваются как раньше');
});

test('сверка чисел: объём накопителя из названия товара важнее чужих объёмов на странице', () => {
  const { checkNumbers } = require('../server/offers/match');
  const need = [{ name: 'Объем накопителя', value: 'не менее 8000 Гбайт' }];
  assert.match(checkNumbers(need, '8ТБ Жесткий диск Seagate Ironwolf Pro ST8000NT001\nДругие объёмы серии: 4 ТБ HDD, 2 ТБ HDD').ok[0], /у товара 8000 — подходит/);
  assert.equal(checkNumbers(need, 'Жесткий диск Toshiba P300 6 Тб\nОбъём накопителя 6 ТБ').fail.length, 1);
});

test('товара нет в наличии — в расчёт прибыли автоматически не берётся и стоит ниже тех, что есть', () => {
  const { rankOffers, isEligible } = require('../server/offers/rank');
  const base = { source: 'yandex', match: 'соответствует', in_time: true };
  const r = rankOffers([
    { ...base, id: 1, unit_price: 23000, total_cost: 92000, availability: 'нет в наличии' },
    { ...base, id: 2, unit_price: 35000, total_cost: 140000, availability: 'в наличии' },
    { ...base, id: 3, unit_price: 42000, total_cost: 168000, availability: null },
  ]);
  assert.deepEqual(r.ranked.map((o) => o.id), [2, 3, 1]);
  assert.equal(r.best.id, 2);
  assert.equal(isEligible({ ...base, unit_price: 1, availability: 'Снят с продажи' }), false);
  assert.equal(isEligible({ ...base, unit_price: 1, availability: 'под заказ' }), true, 'под заказ — купить можно');
});

test('характеристики со страницы: таблица условий кредита — не про товар', () => {
  const { specsFromPage } = require('../server/offers/product');
  const credit = '<table><tr><td>Оформление кредита</td><td>за 3 минуты</td></tr><tr><td>Ежемесячный платеж</td><td>1 263 руб/мес</td></tr><tr><td>Первый взнос</td><td>нет</td></tr><tr><td>Срок</td><td>36 месяцев</td></tr></table>';
  assert.deepEqual(specsFromPage(`<html><body>${credit}</body></html>`), []);
  const specs = '<table><tr><td>Объём</td><td>8 ТБ</td></tr><tr><td>Интерфейс</td><td>SATA III</td></tr><tr><td>Скорость вращения</td><td>7200 об/мин</td></tr></table>';
  assert.deepEqual(specsFromPage(`<html><body>${credit}${specs}</body></html>`).map((s) => s.name), ['Объём', 'Интерфейс', 'Скорость вращения']);
});
