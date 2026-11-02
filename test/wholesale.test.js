// Оптовые поставщики вместо розницы: собственный каталог страниц поставщиков (по картам сайтов), пропуск крупных
// розничных сетей, «дожим» цены на подошедший товар, сверка с ТЗ по каждому требованию. Сеть и нейросеть подменены.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { createLlm } = require('../server/llm');
const { createSiteIndex, keyOf, looksLikeProduct, needlesOf } = require('../server/offers/site-index');
const { matchOffer, judge, fitsNumeric } = require('../server/offers/match');
const { rankOffers, isEligible } = require('../server/offers/rank');
const { searchName } = require('../server/offers/spec');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const NOW = new Date('2026-09-17T09:00:00Z');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `tender-ai-${name}-`));
const res = (body, type = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'content-type': type } });
const urlset = (urls) => `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u.replace(/&/g, '&amp;')}</loc></url>`).join('')}</urlset>`;

// ---------- каталог страниц поставщиков ----------
test('каталог поставщиков: что считается страницей товара и что ищем в адресах', () => {
  assert.equal(keyOf('https://www.kns.ru/product/zhestkii-disk-seagate-st8000ne0001/'), 'productzhestkiidiskseagatest8000ne0001');
  assert.equal(looksLikeProduct('https://shop.ru/product/mfu-pantum-m6607nw'), true);
  assert.equal(looksLikeProduct('https://shop.ru/catalog/noutbuki/'), false, 'раздел без номера и модели');
  assert.equal(looksLikeProduct('https://shop.ru/news/novinka-2026/'), false);
  assert.equal(looksLikeProduct('https://shop.ru/product/326831/disk-st8000vn004/description'), false, 'вкладка «описание» той же карточки');
  assert.equal(looksLikeProduct('https://shop.ru/upload/photo-12345.jpg'), false);
  assert.deepEqual(needlesOf(['IronWolf Pro ST8000NE0001', 'WD80EFZX']), ['st8000ne0001', 'wd80efzx']);
  assert.deepEqual(needlesOf(['LaserJet Pro MFP M430fdw']), ['m430fdw']);
  assert.deepEqual(needlesOf(['MagicBook X16']), ['magicbookx16'], 'обозначение короткое — ищем модель целиком');
  assert.deepEqual(needlesOf(['A4', 'Ноутбук', '', null]), [], 'слишком коротко или без модели — не ищем: совпадения были бы случайными');
});

function supplierNet(sites) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    const { hostname, pathname } = new URL(u);
    const site = sites[hostname];
    if (!site) return res('', 'text/plain', 404);
    const body = site[pathname];
    if (body == null) return res('', 'text/plain', 404);
    return Buffer.isBuffer(body) ? new Response(body, { status: 200, headers: { 'content-type': 'application/x-gzip' } }) : res(body, pathname.endsWith('.txt') ? 'text/plain' : 'application/xml');
  };
  return { fetchImpl, calls };
}

test('каталог поставщиков: читает карты сайта (в том числе сжатые), находит модель у всех, сам товар — раньше принадлежностей', async () => {
  const sites = {
    'opt-one.ru': {
      '/robots.txt': 'User-agent: *\nDisallow: /cart\nSitemap: https://opt-one.ru/sitemap.xml',
      '/sitemap.xml': `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://opt-one.ru/sitemap-iblock-3.xml</loc></sitemap><sitemap><loc>https://opt-one.ru/sitemap-products-2.xml.gz</loc></sitemap><sitemap><loc>https://opt-one.ru/sitemap-images.xml</loc></sitemap></sitemapindex>`,
      '/sitemap-iblock-3.xml': urlset(['https://opt-one.ru/catalog/kabel-dlya-mfu-pantum-m6607nw-777/', 'https://opt-one.ru/catalog/mfu-pantum-m6607nw-12345/', 'https://opt-one.ru/catalog/mfu/', 'https://opt-one.ru/news/skidki-2026/']),
      '/sitemap-products-2.xml.gz': zlib.gzipSync(urlset(['https://opt-one.ru/catalog/zhestkiy-disk-seagate-st8000ne0001-555/', 'https://other.ru/catalog/chuzhoy-sayt-st8000ne0001/'])),
      '/sitemap-images.xml': urlset(['https://opt-one.ru/catalog/foto-m6607nw-1/']),
    },
    'www.opt-two.ru': {
      '/robots.txt': 'User-agent: *\nAllow: /',
      '/sitemap.xml': urlset(['https://www.opt-two.ru/p/pantum-m6607nw.html', 'https://www.opt-two.ru/p/pantum-m6607nw/reviews', 'https://www.opt-two.ru/p/disk-st8000ne0001.html?page=2']),
    },
  };
  const { fetchImpl, calls } = supplierNet(sites);
  let now = NOW;
  const index = createSiteIndex({ dataDir: tmp('idx'), fetchImpl, minIntervalMs: 0, log: { log() {}, warn() {} }, clock: () => now });
  try {
    const one = await index.refresh('opt-one.ru');
    assert.deepEqual([one.status, one.pages], ['ok', 3], 'три страницы товаров: раздел, новость и чужой сайт не в счёт');
    assert.ok(!calls.some((u) => u.includes('sitemap-images')), 'карту картинок не читаем');
    const two = await index.refresh('opt-two.ru');
    assert.deepEqual([two.status, two.pages], ['ok', 1], 'сайт на «www.»; вкладка отзывов и страница с ?page= — не товары');

    const found = index.find(['Pantum M6607NW']);
    assert.deepEqual(found.map((f) => f.url), ['https://www.opt-two.ru/p/pantum-m6607nw.html', 'https://opt-one.ru/catalog/mfu-pantum-m6607nw-12345/'], 'у каждого поставщика — сам товар, а не кабель «для» него');
    assert.equal(index.find(['Pantum M6607NW'], { perDomain: 2 }).length, 3, 'по две страницы с сайта — тогда и принадлежность');
    assert.deepEqual(index.find(['ST8000NE0001']).map((f) => f.domain), ['opt-one.ru']);
    assert.deepEqual(index.find(['M6607NW'], { skip: (url, d, needle) => d === 'opt-one.ru' && needle === 'm6607nw' }).map((f) => f.domain), ['opt-two.ru']);
    assert.deepEqual(index.find(['Ноутбук']), []);
    assert.deepEqual([index.status().ready, index.status().pages], [2, 4]);

    // Обновление: товар сняли с сайта — из каталога он уходит; свежие сайты не перечитываются; лишние убираются.
    sites['opt-one.ru']['/sitemap-iblock-3.xml'] = urlset(['https://opt-one.ru/catalog/mfu-pantum-m6800fdw-999/']);
    assert.deepEqual(await index.refreshAll(['opt-one.ru', 'opt-two.ru']), [], 'неделя не прошла — карты не читаем');
    now = new Date(NOW.getTime() + 8 * 86400000);
    const again = await index.refreshAll(['opt-one.ru']);
    assert.deepEqual(again.map((r) => [r.domain, r.pages]), [['opt-one.ru', 2]]);
    assert.deepEqual(index.find(['M6607NW']), [], 'opt-one.ru товар убрал, opt-two.ru больше не в списке поставщиков');
    assert.equal(index.find(['M6800FDW']).length, 1);
    assert.deepEqual(index.status().sites.map((x) => x.domain), ['opt-one.ru']);

    // Сайт не ответил — прежний каталог остаётся.
    delete sites['opt-one.ru'];
    now = new Date(now.getTime() + 8 * 86400000);
    const failed = await index.refresh('opt-one.ru');
    assert.equal(failed.status, 'empty');
    assert.equal(index.find(['M6800FDW']).length, 1);
  } finally {
    index.close();
  }
});

// ---------- сверка с ТЗ по каждому требованию ----------
test('сверка чисел с переводом единиц: «8 Тб» против «не менее 8000 Гбайт» подходит', () => {
  assert.equal(fitsNumeric('не менее 8000 Гбайт', '8 Тб'), true);
  assert.equal(fitsNumeric('не менее 1024 Мбайт', '1 ГБ'), true);
  assert.equal(fitsNumeric('3,5 дюйм', '3.5"'), true);
  assert.equal(fitsNumeric('не менее 16 ГБ', '8 ГБ'), false);
  assert.equal(fitsNumeric('не более 1.4 кг', '2,35 кг'), false);
  assert.equal(fitsNumeric('не менее 20000', '5 000 страниц в месяц'), false);
  assert.equal(fitsNumeric('не менее 165 Гц', '120 Гц'), false);
  assert.equal(fitsNumeric('HDD', 'HDD'), null, 'не число — судить не берёмся');
  assert.equal(fitsNumeric('не менее 5 кг', '500 Вт'), null, 'единицы разного рода');
});

const TZ = [
  { name: 'Тип устройства', value: 'HDD' },
  { name: 'Объем накопителя', value: 'не менее 8000 Гбайт' },
  { name: 'Форм фактор', value: '3,5 дюйм' },
  { name: 'Скорость вращения', value: 'не менее 5000 об/мин' },
  { name: 'Метод записи', value: 'CMR' },
];
const PAGE_TEXT = 'Жесткий диск HGST 0F23668. Тип HDD, ёмкость 8 Тб, форм-фактор 3.5", скорость 7200 rpm, интерфейс SATA 3';
const NO_NUMS = { ok: [], fail: [], unknown: [] };

test('итог сверки: ответам нейросети не верим на слово', () => {
  const j = judge(TZ, { 1: 'да: HDD', 2: 'нет: 8 Тб', 3: 'да: 3.5"', 4: 'Да — 7200 rpm', 5: 'нет: не указано' }, NO_NUMS, PAGE_TEXT);
  assert.deepEqual(j.rows.map((r) => r.verdict), ['yes', 'yes', 'yes', 'yes', 'unknown']);
  assert.equal(j.rows[1].found, '8 Тб', '«нет: 8 Тб» при требовании «не менее 8000 Гбайт» — нейросеть ошиблась в единицах, это подходит');
  assert.deepEqual([j.confirmed, j.failed, j.unknown, j.total], [4, 0, 1, 5]);
  // числа, которых на странице нет, — выдумка: ни «да», ни «нет» не засчитываем
  const invented = judge(TZ, { 2: 'нет: 4 Тб', 4: 'да: 5400 rpm' }, NO_NUMS, PAGE_TEXT);
  assert.deepEqual(invented.rows.map((r) => r.verdict), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  // настоящее противоречие
  const bad = judge(TZ, { 1: 'нет: SSD', 2: 'да: 8 Тб' }, NO_NUMS, 'Накопитель SSD 8 Тб');
  assert.deepEqual(bad.rows.slice(0, 2).map((r) => [r.verdict, r.found]), [['no', 'SSD'], ['yes', '8 Тб']]);
  // «да», а число не подходит — это «нет»
  assert.equal(judge([{ name: 'Объем памяти', value: 'не менее 16 ГБ' }], { 1: 'да: 8 ГБ' }, NO_NUMS, 'память 8 ГБ').rows[0].verdict, 'no');
});

const llmAnswering = (answer) => ({ async complete() { return { text: JSON.stringify(answer), usage: { in: 0, out: 0 } }; } });

test('сверка с ТЗ: неизвестное обязательное требование исключает полное соответствие; иначе видно, чего не хватает', async () => {
  const item = { name: 'Накопитель данных внутренний', characteristics: TZ };
  const offer = { title: 'Жесткий диск HGST 0F23668', text: PAGE_TEXT };
  const full = await matchOffer(item, offer, { llm: llmAnswering({ kind: true, checks: { 1: 'да: HDD', 2: 'да: 8 Тб', 3: 'да: 3.5"', 4: 'да: 7200 rpm', 5: '?' } }), system: 'match' });
  assert.equal(full.match, 'частично');
  assert.deepEqual([full.checks.confirmed, full.checks.total], [4, 5]);
  assert.match(full.notes[0], /подтверждено 4 из 5 требований, противоречий нет/);
  assert.match(full.notes[1], /На странице не указано: Метод записи — уточните у поставщика/);

  const part = await matchOffer(item, offer, { llm: llmAnswering({ kind: true, checks: { 1: 'да: HDD', 2: 'да: 8 Тб' } }), system: 'match' });
  assert.equal(part.match, 'частично', '2 из 5 — мало, чтобы считать товар подходящим');
  const none = await matchOffer(item, { title: 'Диск', text: 'Диск' }, { llm: llmAnswering({ kind: true, checks: {} }), system: 'match' });
  assert.equal(none.match, 'не хватает данных');

  const bad = await matchOffer(item, { title: 'Накопитель SSD 8 Тб', text: 'Тип SSD, ёмкость 8 Тб, 3.5"' }, { llm: llmAnswering({ kind: true, checks: { 1: 'нет: SSD', 2: 'да: 8 Тб', 3: 'да: 3.5"' } }), system: 'match' });
  assert.equal(bad.match, 'не соответствует');
  assert.match(bad.notes[0], /Не подходит: Тип устройства — нужно «HDD», у товара «SSD»/);
  const other = await matchOffer(item, offer, { llm: llmAnswering({ kind: false, checks: {} }), system: 'match' });
  assert.deepEqual([other.match, other.notes[0]], ['не соответствует', 'на странице другой вид товара, не тот, что в ТЗ']);
});

test('название позиции для поиска — без кодов КТРУ и ОКПД2', () => {
  assert.equal(searchName('Накопитель данных внутренний КТРУ 26.20.21.110-00000003 код ОКПД2 26.20.21.110'), 'Накопитель данных внутренний');
  assert.equal(searchName('Ноутбук (код КТРУ: 26.20.11.110-00000165)'), 'Ноутбук');
  assert.equal(searchName('Бумага офисная А4 80 г/м2'), 'Бумага офисная А4 80 г/м2', 'обычные числа не трогаем');
});

test('розничная сеть — не поставщик: в расчёт сама не идёт и стоит после поставщиков', () => {
  const base = { source: 'yandex', match: 'соответствует', in_time: true };
  const r = rankOffers([
    { ...base, id: 1, unit_price: 40000, total_cost: 160000, retail: true },
    { ...base, id: 2, unit_price: 45000, total_cost: 180000 },
    { ...base, id: 3, match: 'частично', unit_price: 30000, total_cost: 120000, match_checks: { confirmed: 2, total: 10 } },
    { ...base, id: 4, match: 'частично', unit_price: 35000, total_cost: 140000, match_checks: { confirmed: 6, total: 10 } },
  ]);
  assert.deepEqual(r.ranked.map((o) => o.id), [2, 1, 4, 3], 'поставщик раньше розничной сети; «частично» с большей долей подтверждённого — выше');
  assert.equal(r.best.id, 2);
  assert.equal(isEligible({ ...base, unit_price: 1, retail: true }), false);
});

// ---------- поиск целиком ----------
const XML = (docs) => `<?xml version="1.0"?><yandexsearch><response><results><grouping>${docs.map((u) => `<group><doc><url>${u}</url><domain>${new URL(u).hostname}</domain><title>t</title></doc></group>`).join('')}</grouping></results></response></yandexsearch>`;
const product = (title, price) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: title, offers: { price: String(price), priceCurrency: 'RUB', availability: 'https://schema.org/InStock' } })}</script></head><body><h1>${title}</h1><p>Процессор: 6 ядер, 12 потоков, 3.9 ГГц. Оперативная память: 16 ГБ DDR4</p></body></html>`;

function start(overrides = {}, extra = {}) {
  const dir = tmp('opt');
  const stores = path.join(dir, 'stores.json');
  fs.writeFileSync(stores, JSON.stringify({
    stores: [], b2b: [],
    suppliers: [{ name: 'Опт один', site: 'opt-one.ru', enabled: true }, { name: 'Опт два', site: 'opt-two.ru', enabled: true }, { name: 'Выключен', site: 'off.ru', enabled: false }],
    retail: [{ name: 'Большая сеть', site: 'big-retail.ru' }],
  }));
  const calls = { yandex: [], pages: [], models: 0 };
  const pages = {
    'https://opt-one.ru/catalog/sistemnyy-blok-acme-ao-5000x-12345/': product('Системный блок Acme AO-5000X', 47000),
    'https://opt-two.ru/p/zx-77881.html': product('Системный блок Acme AO-5000X (артикул ZX-77881)', 43000),
    'https://web-shop.ru/acme-ao-5000x': product('Системный блок Acme AO-5000X, артикул ZX-77881', 49000),
    'https://big-retail.ru/product/acme-ao-5000x': product('Системный блок Acme AO-5000X', 58000),
    ...(extra.pages || {}),
  };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://searchapi.api.cloud.yandex.net')) {
      calls.yandex.push(JSON.parse(opts.body).query.queryText);
      return res(JSON.stringify({ rawData: Buffer.from(XML(extra.yandex || ['https://big-retail.ru/product/acme-ao-5000x', 'https://web-shop.ru/acme-ao-5000x'])).toString('base64') }), 'application/json');
    }
    if (u.startsWith('https://suggestions.dadata.ru')) return res('{"suggestions":[]}', 'application/json');
    if (u === 'https://opt-one.ru/robots.txt' || u === 'https://opt-two.ru/robots.txt') return res('User-agent: *\nAllow: /', 'text/plain');
    if (u === 'https://opt-one.ru/sitemap.xml') return res(urlset(['https://opt-one.ru/catalog/sistemnyy-blok-acme-ao-5000x-12345/', 'https://opt-one.ru/catalog/sistemnye-bloki/', ...(extra.sitemapOne || [])]), 'application/xml');
    if (u === 'https://opt-two.ru/sitemap.xml') return res(urlset(['https://opt-two.ru/p/zx-77881.html']), 'application/xml');
    if (u.endsWith('/robots.txt')) return res('', 'text/plain', 404);
    calls.pages.push(u);
    return pages[u] ? res(pages[u]) : res('<html><body>Контакты</body></html>');
  };
  const mock = createLlm('mock');
  const llm = {
    provider: 'fake', model: 'fake',
    async complete(req) {
      if (req.task !== 'models') return mock.complete(req);
      calls.models++;
      const input = JSON.parse(req.messages[0].content);
      (calls.modelInputs ||= []).push(input);
      const products = extra.modelsFn ? extra.modelsFn(input) : [{ name: 'Системный блок Acme AO-5000X', brand: 'Acme', model: 'AO-5000X' }];
      return { text: JSON.stringify({ products }), usage: { in: 0, out: 0 } };
    },
  };
  const config = {
    ...baseConfig, SEARCH_FREE_BY_WORDS: false, DATA_DIR: dir, STORES_CONFIG: stores, PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, FETCH_MIN_INTERVAL_MS: 0,
    YANDEX_SEARCH_API_KEY: 'k', YANDEX_FOLDER_ID: 'f', DADATA_API_KEY: '', OFFER_SOURCES: 'yandex', SEARCH_MAX_PAGES: 100, ...overrides,
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, fetchImpl, llmFactory: () => llm, clock: () => NOW, sourceOverride: createFixtureSource({ dir: FIX }) });
  return { s, calls };
}

/** Закупка с простым ТЗ (три требования, все подтверждаются страницей товара). */
async function simpleTender(s) {
  await s.sync.run();
  const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
  const [item] = await s.details.ensureItems(s.repo.getTender(id));
  s.repo.db.prepare('UPDATE tender_items SET characteristics_json = ?, spec_json = NULL WHERE id = ?')
    .run(JSON.stringify([{ name: 'Количество ядер процессора', value: 'не менее 6 шт' }, { name: 'Объем установленной оперативной памяти', value: 'не менее 8 Гбайт' }, { name: 'Тип оперативной памяти', value: 'DDR4' }]), item.id);
  return id;
}

test('поиск: модель ищется у оптовых поставщиков из своего каталога, розничная сеть не открывается, цена «дожимается»', async () => {
  const { s, calls } = start();
  try {
    const id = await simpleTender(s);
    await s.siteIndex.refreshAll(s.offers.supplierDomains());
    assert.deepEqual(s.offers.supplierDomains(), ['opt-one.ru', 'opt-two.ru'], 'выключенный поставщик в каталог не идёт');
    const status = s.offers.sourcesStatus();
    assert.deepEqual([status.suppliers.sites, status.suppliers.pages, status.suppliers.of], [2, 2, 2]);
    assert.deepEqual(status.retail, ['Большая сеть']);

    const searchId = s.offers.start(id, { auto: true });
    await s.offers.idle();
    const search = s.repo.getOfferSearch(searchId);
    assert.equal(search.status, 'done', search.error);
    const log = search.log.map((l) => l.text).join('\n');

    // 1. Подобранная под ТЗ модель найдена в каталоге у первого поставщика — без поисковика.
    assert.match(log, /в каталоге оптовых поставщиков найдено страниц: 1 \(opt-one\.ru\)/);
    // 2. Розничная сеть из выдачи Яндекса не открывается.
    assert.match(log, /крупные розничные сети не открываю \(нужны поставщики, а не розница\): big-retail\.ru/);
    assert.ok(!calls.pages.some((u) => u.includes('big-retail.ru')));
    // 3. Товар подошёл — его артикул со страницы магазина найден у второго поставщика, где модель в адресе не указана.
    assert.match(log, /подошедшие модели \(.*ZX-77881.*\) проверены ещё у 1 оптовых поставщиков — цен добавлено: 1/);
    assert.ok(calls.pages.includes('https://opt-two.ru/p/zx-77881.html'));

    const g = s.offers.listForTender(id)[0];
    const byDomain = Object.fromEntries(g.ranked.map((o) => [o.domain, o]));
    assert.deepEqual(Object.keys(byDomain).sort(), ['opt-one.ru', 'opt-two.ru', 'web-shop.ru']);
    assert.deepEqual([byDomain['opt-one.ru'].source, byDomain['opt-one.ru'].seller_type], ['wholesale', 'wholesale']);
    assert.equal(byDomain['web-shop.ru'].seller_type, null, 'про магазин из выдачи ничего не известно — без пометки');
    assert.ok(g.ranked.every((o) => o.match === 'соответствует' && o.match_checks.confirmed === 3));
    assert.equal(g.selected_offer_id, byDomain['opt-two.ru'].id, 'в расчёт взят самый дешёвый из подходящих — 43 000 ₽ у второго поставщика');
  } finally {
    await s.close();
  }
});

test('старые находки из розничной сети помечаются и снимаются с автоматического выбора', async () => {
  const { s } = start({ SUPPLIER_INDEX: false });
  try {
    assert.equal(s.siteIndex, null, 'SUPPLIER_INDEX=0 — каталог поставщиков выключен');
    assert.equal(s.offers.sourcesStatus().suppliers, null);
    const id = await simpleTender(s);
    const item = s.repo.getItems(id)[0];
    const offer = (domain, price) => s.repo.insertOffer({
      tender_id: id, item_id: item.id, source: 'yandex', title: 'Системный блок Acme AO-5000X', url: `https://${domain}/p/1`, domain,
      price, pack_qty: 1, unit_price: price, total_cost: price * 12, in_time: true, match: 'соответствует', match_notes: [], trust: 50, trust_reasons: [],
    });
    const retail = offer('www.big-retail.ru', 40000);
    const shop = offer('web-shop.ru', 45000);
    s.repo.setItemOffer(item.id, s.repo.getOffer(retail), 'auto'); // так было до обновления: самый дешёвый — из розничной сети
    const r = await s.offers.dropRetailSelections();
    assert.deepEqual(r, { items: 1, tenders: 1 });
    const g = s.offers.listForTender(id)[0];
    assert.equal(g.selected_offer_id, shop, 'выбран поставщик, а не розничная сеть, хотя у сети дешевле');
    assert.deepEqual(g.ranked.map((o) => [o.domain, o.seller_type, o.retail]), [['web-shop.ru', null, false], ['www.big-retail.ru', 'retail', true]]);
  } finally {
    await s.close();
  }
});

test('минимальная цена должна быть настоящей: уценка, «последняя цена» и цена вдвое ниже обычной сами в расчёт не идут', async () => {
  const { extractOffer } = require('../server/offers/extract');
  const { htmlToText, extractStructured } = require('../server/offers/fetch-page');
  const page = (url, title, body) => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: title, offers: { price: '5344', priceCurrency: 'RUB' } })}</script></head><body><h1>${title}</h1>${body}</body></html>`;
    return { url, html, text: htmlToText(html), structured: extractStructured(html, url) };
  };
  const item = { name: 'Накопитель данных внутренний', characteristics: [] };
  const sale = await extractOffer(page('https://shop.ru/product/disk-hus728t8tale6l4-ucenka/', 'Жесткий диск WD Ultrastar 8Tb HUS728T8TALE6L4 уценка', '<p>Код товара: 679162 Последняя цена: 5 344 руб.</p>'), item, {});
  assert.deepEqual([sale.condition, sale.availability], ['уценка', 'нет в наличии']);
  const used = await extractOffer(page('https://shop.ru/p/1', 'Жесткий диск Seagate 8TB б/у', '<p>Цена 5 344 руб.</p>'), item, {});
  assert.equal(used.condition, 'б/у');
  const fresh = await extractOffer(page('https://shop.ru/p/2', 'Жесткий диск Seagate 8TB ST8000VN004', '<p>В наличии. Цена 5 344 руб.</p>'), item, {});
  // наличие теперь читается и из текста страницы («В наличии.»), а не только из разметки
  assert.deepEqual([fresh.condition, fresh.availability], [null, 'в наличии']);

  const base = { source: 'yandex', match: 'соответствует', in_time: true };
  const r = rankOffers([
    { ...base, id: 1, unit_price: 5344, total_cost: 21376, condition: 'уценка' },
    { ...base, id: 2, unit_price: 10732, total_cost: 42928 },
    { ...base, id: 3, unit_price: 29088, total_cost: 116352 },
    { ...base, id: 4, unit_price: 40000, total_cost: 160000 },
    { ...base, id: 5, unit_price: 41000, total_cost: 164000 },
    { ...base, id: 6, unit_price: 43000, total_cost: 172000 },
    { ...base, id: 7, unit_price: 45000, total_cost: 180000 },
  ]);
  assert.equal(r.best.id, 3, 'в расчёт — самое дешёвое из обычных: 29 088 ₽');
  assert.deepEqual(r.ranked.map((o) => o.id), [3, 4, 5, 6, 7, 1, 2], 'уценка и подозрительно дешёвое — в конце «подходящих», с пометкой');
  const cheap = r.ranked.find((o) => o.id === 2);
  assert.equal(cheap.too_cheap, 3.8, 'в 3,8 раза ниже обычной цены (40 500 ₽)');
  assert.equal(r.ranked.find((o) => o.id === 3).too_cheap, null);
  // предложений мало — «обычной» цены ещё нет, ничего не помечаем
  const few = rankOffers([{ ...base, id: 1, unit_price: 100, total_cost: 100 }, { ...base, id: 2, unit_price: 900, total_cost: 900 }]);
  assert.deepEqual([few.best.id, few.ranked[0].too_cheap], [1, null]);
});

test('каталог поставщиков: из нескольких страниц с одной моделью первой берётся сам товар из ТЗ', async () => {
  const { urlHints } = require('../server/offers/site-index');
  assert.deepEqual(urlHints(['Тонер', 'картридж', 'МФУ', 'жёсткий']), ['toner', 'kartr', 'mfu', 'zhest']);
  const sites = { 'opt.ru': {
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/sitemap.xml': urlset([
      'https://opt.ru/c/zapravka-toner-kartridzha-kyocera-tk-5230k/', 'https://opt.ru/c/tk-5230k-chip/', 'https://opt.ru/c/tuba-kyocera-tk-5230k/',
      'https://opt.ru/c/kartridzh-lazernyy-kyocera-tk-5230k-1t02r90nl0/', 'https://opt.ru/c/vyklyuchatel-fp502-1kl/', 'https://opt.ru/c/rakel-cactus-kyo-p5021/',
    ]),
  } };
  const index = createSiteIndex({ dataDir: tmp('idx2'), fetchImpl: supplierNet(sites).fetchImpl, minIntervalMs: 0, log: { log() {}, warn() {} } });
  try {
    await index.refresh('opt.ru');
    assert.equal(index.find(['TK-5230K'], { hints: urlHints(['Тонер', 'картридж']) })[0].url, 'https://opt.ru/c/kartridzh-lazernyy-kyocera-tk-5230k-1t02r90nl0/', 'картридж, а не заправка, чип или туба');
    assert.equal(index.find(['TK-5230K'])[0].url, 'https://opt.ru/c/tuba-kyocera-tk-5230k/', 'без подсказки — самый короткий адрес, но не услуга и не чип');
    assert.deepEqual(index.find(['P5021']).map((f) => f.url), ['https://opt.ru/c/rakel-cactus-kyo-p5021/'], 'модель — целым словом: «fp502-1kl» — это не «P5021»');
  } finally {
    index.close();
  }
});

test('модель из ТЗ в названии — ещё не тот товар: чип и заправка к картриджу не подходят', async () => {
  const item = { name: 'Тонер-картридж TK-5230K Black', characteristics: [] };
  const llm = createLlm('mock');
  const same = await matchOffer(item, { title: 'Картридж Kyocera TK-5230K 1T02R90NL0', text: 'Картридж лазерный' }, { llm, system: 'match' });
  assert.equal(same.match, 'соответствует');
  for (const title of ['Чип TK-5230K для Kyocera ECOSYS P5021', 'Заправка тонер-картриджа KYOCERA TK-5230K (Black)']) {
    const other = await matchOffer(item, { title, text: title }, { llm, system: 'match' });
    assert.equal(other.match, 'не соответствует', title);
    assert.match(other.notes[0], /другой товар/);
  }
});

test('второй заход: первые подобранные модели не подошли — нейросети сообщают причину, она называет другие', async () => {
  const weak = '<html><head><script type="application/ld+json">' + JSON.stringify({ '@type': 'Product', name: 'Системный блок Acme BAD-1000X', offers: { price: '30000', priceCurrency: 'RUB' } })
    + '</script></head><body><h1>Системный блок Acme BAD-1000X</h1><p>Процессор: 4 ядра, 8 потоков. Оперативная память: 16 ГБ DDR4</p></body></html>';
  const { s, calls } = start({}, {
    // сначала нейросеть называет слабую модель; узнав, что она отклонена, — подходящую
    modelsFn: (input) => (input.rejected ? [{ name: 'Системный блок Acme BAD-1000X', brand: 'Acme', model: 'BAD-1000X' }, { name: 'Системный блок Acme AO-5000X', brand: 'Acme', model: 'AO-5000X' }]
      : [{ name: 'Системный блок Acme BAD-1000X', brand: 'Acme', model: 'BAD-1000X' }]),
    sitemapOne: ['https://opt-one.ru/catalog/sistemnyy-blok-acme-bad-1000x-777/'],
    pages: { 'https://opt-one.ru/catalog/sistemnyy-blok-acme-bad-1000x-777/': weak },
    yandex: ['https://big-retail.ru/product/acme-ao-5000x'],
  });
  try {
    const id = await simpleTender(s);
    await s.siteIndex.refreshAll(s.offers.supplierDomains());
    const searchId = s.offers.start(id, { auto: true });
    await s.offers.idle();
    const search = s.repo.getOfferSearch(searchId);
    assert.equal(search.status, 'done', search.error);
    const log = search.log.map((l) => l.text).join('\n');
    assert.match(log, /первые подобранные товары не подошли.*Подобраны другие: Системный блок Acme AO-5000X/);
    assert.match(log, /по новым моделям открыто страниц: 1, с ценой: 1, подошло: 1/);
    const second = calls.modelInputs.find((i) => i.rejected);
    assert.equal(second.rejected[0].name, 'Системный блок Acme BAD-1000X');
    assert.match(second.rejected[0].why, /не соответствует: Количество ядер процессора: нужно не менее 6 шт, у товара 4/);
    const g = s.offers.listForTender(id)[0];
    assert.deepEqual(g.ranked.map((o) => [o.title, o.match]), [['Системный блок Acme AO-5000X', 'соответствует']], 'отклонённая модель второй раз не ищется, найдена подходящая');
    assert.equal(g.rejected[0].offer.title, 'Системный блок Acme BAD-1000X');
    assert.equal(g.selected_offer_id, g.ranked[0].id);
  } finally {
    await s.close();
  }
});

test('после обновления автоматический выбор пересматривается: вместо подозрительно дешёвого — обычное предложение', async () => {
  const { s } = start({ SUPPLIER_INDEX: false });
  try {
    const id = await simpleTender(s);
    const item = s.repo.getItems(id)[0];
    const offer = (domain, price, extra = {}) => s.repo.insertOffer({
      tender_id: id, item_id: item.id, source: 'yandex', title: 'Системный блок Acme AO-5000X', url: `https://${domain}/p/1`, domain,
      price, pack_qty: 1, unit_price: price, total_cost: price * 12, in_time: true, match: 'соответствует', match_notes: [], trust: 50, trust_reasons: [], ...extra,
    });
    const cheap = offer('strange.ru', 9000);
    const sale = offer('sale.ru', 20000, { condition: 'уценка' });
    const normal = offer('a.ru', 41000);
    for (const [d, p] of [['b.ru', 43000], ['c.ru', 44000], ['d.ru', 45000], ['big-retail.ru', 39000]]) offer(d, p);
    s.repo.setItemOffer(item.id, s.repo.getOffer(cheap), 'auto'); // так выбиралось раньше: просто самое дешёвое
    const r = await s.offers.reselectAuto();
    assert.deepEqual(r, { tenders: 1, changed: 1 });
    const g = s.offers.listForTender(id)[0];
    assert.equal(g.selected_offer_id, normal, 'не 9 000 ₽ (в 4,8 раза ниже обычной цены), не уценка и не розничная сеть — а 41 000 ₽ у поставщика');
    assert.deepEqual(g.ranked.map((o) => o.domain), ['a.ru', 'b.ru', 'c.ru', 'd.ru', 'big-retail.ru', 'strange.ru', 'sale.ru']);
    assert.equal(g.ranked.find((o) => o.id === cheap).too_cheap, 4.8);
    assert.equal(g.ranked.find((o) => o.id === sale).condition, 'уценка');
    // выбор, сделанный вручную, остаётся
    s.repo.setItemOffer(item.id, s.repo.getOffer(cheap), 'user');
    assert.deepEqual(await s.offers.reselectAuto(), { tenders: 1, changed: 0 });
    assert.equal(s.offers.listForTender(id)[0].selected_offer_id, cheap);
  } finally {
    await s.close();
  }
});

test('требование-перечень подтверждается, только если на странице есть всё перечисленное', () => {
  const { missingFromList } = require('../server/offers/match');
  const page = 'поддержка аудио кодеков G.711, G.722, G.729; протоколы RTP, SIP, SIP over UDP/TCP/TLS; 802.1x, DHCP, QoS';
  assert.deepEqual(missingFromList('G.729 / OPUS / G.711A / G.722', page), ['OPUS']);
  assert.deepEqual(missingFromList('Поддержка TLS / Поддержка SIP / Поддержка NAT / Поддержка IPv6', page), ['NAT', 'IPv6']);
  assert.deepEqual(missingFromList('Поддержка стандарта IEEE 802.1X / Поддержка DHCP', page), []);
  assert.deepEqual(missingFromList('Черный список / Отключение микрофона', page), [], 'русские формулировки так не проверяем');
  assert.deepEqual(missingFromList('SATA III', page), [], 'одно значение — не перечень');

  const chars = [{ name: 'Поддержка аудиокодеков', value: 'G.729 / OPUS / G.711A / G.722' }, { name: 'Сетевые функции', value: 'Поддержка стандарта IEEE 802.1X / Поддержка DHCP' }];
  const j = judge(chars, { 1: 'да: G.711, G.722, G.729', 2: 'да: 802.1x, DHCP' }, { ok: [], fail: [], unknown: [] }, page);
  assert.deepEqual(j.rows.map((r) => [r.verdict, r.found]), [['unknown', 'на странице нет: OPUS'], ['yes', '802.1x, DHCP']]);
});

test('расходники: чип, заправка и тонер в банке — не картридж, даже с той же моделью (без нейросети)', async () => {
  const { otherKind } = require('../server/offers/match');
  const item = 'Тонер-картридж TK-5230K 2 600 стр. Black для P5021cdn/cdw';
  assert.match(otherKind(item, 'Чип TK-5230K для Kyocera ECOSYS P5021/M5521, черный'), /а это чип к нему/);
  assert.match(otherKind(item, 'Заправка тонер-картриджа KYOCERA TK-5230K (Black)'), /заправка/);
  assert.match(otherKind(item, 'Тонер Hi-Black для Kyocera Color TK-5230K, Black, 60 г, банка'), /тонер для заправки/);
  assert.match(otherKind(item, 'Тонер Hi-Black TK-5230K, бутыль 60 г, черный'), /тонер для заправки/);
  assert.equal(otherKind(item, 'Картридж Kyocera TK-5230K 1T02R90NL0'), null);
  assert.equal(otherKind(item, 'Тонер-картридж БУЛАТ s-Line TK-5230K для Kyocera ECOSYS P5021cdn'), null, 'совместимый картридж — тот же вид товара');
  assert.equal(otherKind(item, 'Туба с тонером Kyocera TK-5230K (1T02R90NL0) Black'), null, 'так оригинальный картридж называют некоторые магазины');
  assert.equal(otherKind('Чип для картриджа TK-5230K', 'Чип TK-5230K для Kyocera'), null, 'в ТЗ сам чип — тогда это он');
  assert.equal(otherKind('Ноутбук', 'Ноутбук ASUS Vivobook 16'), null);
  const m = await matchOffer({ name: item, characteristics: [] }, { title: 'Тонер Hi-Black для Kyocera Color TK-5230K, Black, 60 г, банка', text: '' }, {});
  assert.deepEqual([m.match, m.notes[0]], ['не соответствует', 'другой товар: в ТЗ картридж, а это тонер для заправки (в банке или бутыли)']);
});

test('нормальная цена не считается подозрительной из-за более дорогих товаров «с запасом»', () => {
  // Под «не менее 8 ТБ» подошли и диски на 14–16 ТБ: они втрое дороже, но самый дешёвый подходящий — обычная цена.
  const base = { source: 'yandex', match: 'соответствует', in_time: true };
  const r = rankOffers([28351, 38972, 47090, 86243, 101834, 145483].map((p, i) => ({ ...base, id: i + 1, unit_price: p, total_cost: p * 4 })));
  assert.equal(r.best.id, 1, 'в расчёт — 28 351 ₽, самое дешёвое подходящее');
  assert.ok(r.ranked.every((o) => o.too_cheap == null));
  // а настоящий выброс по-прежнему виден
  const odd = rankOffers([5344, 28351, 38972, 47090, 86243].map((p, i) => ({ ...base, id: i + 1, unit_price: p, total_cost: p * 4 })));
  assert.equal(odd.best.id, 2);
  assert.equal(odd.ranked.find((o) => o.id === 1).too_cheap, 7.3);
});
