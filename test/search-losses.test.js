// Поиск поставщиков: где теряются результаты (воронка), проверка ссылки, найденной вручную, и жёсткие признаки
// вида товара — чёрно-белая или цветная печать. Сеть и нейросеть подменены.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { createLlm } = require('../server/llm');
const { matchOffer } = require('../server/offers/match');
const { pickFromListing } = require('../server/offers/candidates');
const { requiredTraits, checkTraits, titleFits, loadTraits } = require('../server/offers/traits');
const { describeFunnel, pageReason, DROP_REASONS, PAGE_REASONS } = require('../server/offers/funnel');
const { FetchSkipped } = require('../server/offers/fetch-page');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const NOW = new Date('2026-09-17T09:00:00Z');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `tender-ai-${name}-`));
const res = (body, type = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'content-type': type } });

// ---------- цветность печати ----------
const MONO = [{ name: 'Цветность печати', value: 'Черно-Белая' }, { name: 'Формат печати', value: 'А4' }, { name: 'Скорость черно-белой печати в формате А4, стр/мин', value: 'не менее 30' }];
const COLOR = [{ name: 'Цветность печати', value: 'Цветная' }, { name: 'Скорость черно-белой печати в формате А4, стр/мин', value: 'не менее 30' }];

test('цветность: что требует ТЗ — по требованию о цветности, а не по словам «черно-белая печать» в других требованиях', () => {
  assert.deepEqual(requiredTraits('Принтер лазерный', MONO).map((t) => [t.trait.id, t.value]), [['print_color', 'mono']]);
  assert.deepEqual(requiredTraits('МФУ', COLOR).map((t) => t.value), ['color'], '«Скорость черно-белой печати» у цветного устройства признаком не считается');
  assert.deepEqual(requiredTraits('Принтер', [{ name: 'Скорость черно-белой печати', value: 'не менее 30' }]), [], 'цветность в ТЗ не указана');
  assert.deepEqual(requiredTraits('Принтер', [{ name: 'Цветность', value: 'монохромная' }]).map((t) => t.value), ['mono']);
  assert.deepEqual(requiredTraits('Принтер', [{ name: 'Цветная печать', value: 'Нет' }]).map((t) => t.value), ['mono']);
  assert.deepEqual(requiredTraits('Принтер', [{ name: 'Цвет', value: 'Черный' }]), [], 'цвет корпуса — не цветность печати');
  assert.deepEqual(requiredTraits('Картридж', MONO), [], 'признак относится только к печатающим устройствам');
  assert.ok(loadTraits().length >= 1, 'признаки читаются из config/exclusive-traits.json');
});

test('цветность: товар определяется по характеристикам страницы и названию, с синонимами', () => {
  const t = (req, title, text) => checkTraits('Принтер', req, { title, text });
  assert.equal(t(MONO, 'Принтер лазерный HP Color LaserJet Pro 4203dn', 'Характеристики: Цветность печати: цветная; Скорость ч/б печати: 33 стр/мин').conflicts.length, 1);
  assert.equal(t(MONO, 'Цветной лазерный принтер Pantum CP1100', 'Формат А4').conflicts.length, 1, 'по названию');
  assert.deepEqual(t(MONO, 'Принтер лазерный Pantum P3010D', 'Тип печати: монохромная').agreed.map((a) => a.name), ['Цветность печати']);
  assert.deepEqual(t(MONO, 'МФУ лазерное Pantum M6500W', 'Количество цветов: 1. Цветное сканирование: да').agreed.length, 1, '«цветное сканирование» чёрно-белому МФУ не мешает');
  assert.deepEqual(t(MONO, 'МФУ лазерное Pantum M6500W ч/б', 'Формат А4').agreed.length, 1);
  assert.deepEqual(t(MONO, 'МФУ лазерное Pantum M6500W', 'Формат А4'), { conflicts: [], agreed: [] }, 'на странице ничего не сказано — ни да, ни нет');
  // ловушка: цветное устройство печатает и чёрно-белым — это не противоречие
  assert.deepEqual(t(COLOR, 'МФУ Kyocera ECOSYS M5526cdn', 'Цветность печати — цветная. Скорость черно-белой печати 26 стр/мин'), { conflicts: [], agreed: [{ name: 'Цветность печати', found: 'Цветность печати — цветная' }] });
  assert.equal(t(COLOR, 'Принтер Pantum P3010D', 'Цветность печати: черно-белая').conflicts.length, 1, 'и наоборот: в ТЗ цветной, товар чёрно-белый');
  assert.equal(titleFits('Принтер', MONO, 'HP Color LaserJet Pro M454dn'), false);
  assert.equal(titleFits('Принтер', MONO, 'Pantum P3010DW'), true, 'по названию не понять — не отбрасываем');
});

test('технология печати: «электрографическая» в ТЗ — это лазерная и светодиодная у магазинов, струйная — другой вид', async () => {
  const TECH = [{ name: 'Технология печати', value: 'Электрографическая' }, { name: 'Цветность печати', value: 'Черно-Белая' }];
  const t = (title, text, req = TECH) => { const r = checkTraits('МФУ', req, { title, text }); return [r.conflicts.map((c) => c.name), r.agreed.map((a) => a.name)]; };
  assert.deepEqual(t('МФУ HP LaserJet Pro M428fdw MFP', 'Тип печати: черно-белая лазерная; Формат А4'), [[], ['Цветность печати', 'Технология печати']]);
  assert.deepEqual(t('BROTHER', 'Технология печати: струйная; Цветность печати: цветная'), [['Цветность печати', 'Технология печати'], []]);
  assert.deepEqual(t('МФУ Xerox WorkCentre 6505N', 'Технология печати: лазерная; Цветность печати: цветная'), [['Цветность печати'], ['Технология печати']]);
  assert.deepEqual(t('МФУ Pantum M6700D', 'Формат А4'), [[], []], 'ничего не сказано — ни да, ни нет');
  // текст страницы без знаков препинания: «Цветная печать нет» — отдельное требование, а не продолжение «Тип печати лазерная»
  assert.deepEqual(t('МФУ Kyocera', 'Тип печати лазерная Цветная печать нет', [{ name: 'Цветность печати', value: 'Цветная' }]), [['Цветность печати'], []]);
  assert.deepEqual(t('МФУ Катюша M130', 'Тип печати: монохромная. Технология печати лазерная Цветная печать нет'), [[], ['Цветность печати', 'Технология печати']]);
  // настоящая страница (ink-market.ru, HP M428fdw): слово «Цветность» начинается на «цветн», а в рекламном описании
  // магазин сам ошибся («Печать - лазерная цветная») — признак берётся из характеристик, устройство чёрно-белое
  assert.deepEqual(t('МФУ HP LaserJet Pro M428fdw MFP', 'Печать - лазерная цветная. А выход первого отпечатка займет не более 6,8 секунд. Тип устройства МФУ Тип печати лазерный Цветность печати черно-белая Максимальный формат A4 Дисплей цветной ЖК-дисплей'),
    [[], ['Цветность печати', 'Технология печати']]);
  assert.deepEqual(t('МФУ HP LaserJet Pro M428fdw MFP', 'Технология печати Лазерная / Светодиодная Монохромная / цветная печать Монохромная Интерфейс Ethernet'), [[], ['Цветность печати', 'Технология печати']]);
  // раньше такой товар отклонялся: нейросеть отвечала «нет: лазерная», и это слово действительно есть на странице
  const llm = { provider: 'fake', model: 'fake', async complete() { return { text: JSON.stringify({ kind: true, checks: { 1: 'нет: лазерная', 2: 'да: черно-белая' } }), usage: { in: 0, out: 0 } }; } };
  const r = await matchOffer({ name: 'МФУ', characteristics: TECH }, { title: 'МФУ HP LaserJet Pro M428fdw', text: 'Характеристики: Технология печати: лазерная; Цветность печати: черно-белая' }, { llm, system: 's' });
  assert.equal(r.match, 'соответствует', r.notes.join(' | '));
});

test('сверка: гарантия на странице магазина и «лишнее» в перечне товар не отклоняют — но и подтверждением не становятся', async () => {
  const say = (checks) => ({ provider: 'fake', model: 'fake', async complete() { return { text: JSON.stringify({ kind: true, checks }), usage: { in: 0, out: 0 } }; } });
  // «10 месяцев» на странице — рассрочка, а не гарантия: раньше товар отклонялся ещё до нейросети
  const warranty = await matchOffer({ name: 'МФУ', characteristics: [{ name: 'Гарантийный срок', value: 'не менее 12 месяцев' }, { name: 'Формат печати', value: 'А4' }] },
    { title: 'МФУ Acme M100', text: 'Характеристики: Формат печати: А4. Рассрочка на 10 месяцев. Гарантия 3 мес' }, { llm: say({ 1: 'нет: 3 мес', 2: 'да: А4' }), system: 's' });
  assert.equal(warranty.match, 'частично', warranty.notes.join(' | '));
  assert.equal(warranty.checks.rows[0].verdict, 'unknown');
  assert.match(warranty.checks.rows[0].found, /уточните у поставщика/);
  // в ТЗ «Ethernet (RJ-45), USB», на странице есть и то и другое, а нейросеть ответила «нет: Wi-Fi»
  const ports = await matchOffer({ name: 'МФУ', characteristics: [{ name: 'Способ подключения', value: 'Ethernet (RJ-45), USB' }, { name: 'Формат печати', value: 'А4' }] },
    { title: 'МФУ Acme M100', text: 'Характеристики: Интерфейсы: Wi-Fi, Ethernet, USB 2.0; Формат печати: А4' }, { llm: say({ 1: 'нет: Wi-Fi', 2: 'да: А4' }), system: 's' });
  assert.equal(ports.match, 'частично', ports.notes.join(' | '));
  // а если чего-то из перечня на странице нет — отказ остаётся
  const noUsb = await matchOffer({ name: 'МФУ', characteristics: [{ name: 'Способ подключения', value: 'Ethernet (RJ-45), USB' }, { name: 'Формат печати', value: 'А4' }] },
    { title: 'МФУ Acme M100', text: 'Характеристики: Интерфейсы: Wi-Fi, Ethernet; Формат печати: А4' }, { llm: say({ 1: 'нет: Wi-Fi', 2: 'да: А4' }), system: 's' });
  assert.equal(noUsb.match, 'не соответствует');
});

test('«не более N» — верхняя граница: товар легче, тоньше или дешевле требуемого подходит', async () => {
  const { parseRequirement, fitsNumeric } = require('../server/offers/match');
  assert.deepEqual(parseRequirement('не более 3 кг'), { max: 3, maxStrict: false }, 'раньше сюда попадало ещё и «больше 3»');
  assert.deepEqual(parseRequirement('более 3 кг'), { min: 3, minStrict: true });
  assert.deepEqual(parseRequirement('не менее 8 и не более 16'), { min: 8, minStrict: false, max: 16, maxStrict: false });
  assert.deepEqual(parseRequirement('от 5 до 10'), { min: 5, minStrict: false, max: 10, maxStrict: false });
  assert.equal(parseRequirement('Диапазон частот 50'), null, '«частот 50» — не «от 50»');
  assert.equal(fitsNumeric('не более 3 кг', '2430 г'), true);
  assert.equal(fitsNumeric('не более 3 кг', '3.4 кг'), false);
  const item = { name: 'Ноутбук', characteristics: [{ name: 'Вес', value: 'не более 3 кг' }, { name: 'Диагональ экрана', value: 'не менее 15.6 дюйм' }] };
  const ok = await matchOffer(item, { title: 'Ноутбук Acme Book 16', text: 'Характеристики: Вес: 2.42 кг; Диагональ экрана: 16 дюймов' }, { llm: createLlm('mock'), system: 's' });
  assert.notEqual(ok.match, 'не соответствует', ok.notes.join(' | '));
  const heavy = await matchOffer(item, { title: 'Ноутбук Acme Tank 17', text: 'Характеристики: Вес: 3.8 кг; Диагональ экрана: 17.3 дюймов' }, { llm: createLlm('mock'), system: 's' });
  assert.equal(heavy.match, 'не соответствует');
  assert.match(heavy.notes[0], /Вес: нужно не более 3 кг, у товара 3\.8/);
});

test('блок фотобарабана с моделью из ТЗ — сам товар, а не деталь к нему', () => {
  const { otherKind } = require('../server/offers/match');
  const need = 'Картридж для электрографических печатающих устройств';
  assert.equal(otherKind(need, 'Фотобарабан Kyocera DK-170', 'DK-170'), null, 'DK-170 и есть блок фотобарабана');
  assert.equal(otherKind(need, 'Фотобарабан (Drum-Unit) Cactus CS-DK170 черный для Kyocera', 'DK-170'), null, 'совместимый аналог — дальше решает сверка');
  assert.match(otherKind(need, 'Фотобарабан для Kyocera DK-170/150, FS-1016', 'DK-170'), /фотобарабан к нему/, 'деталь к блоку');
  assert.match(otherKind(need, 'Фотобарабан XEROX (013R00662) WorkCentre 7830', 'DK-170'), /фотобарабан к нему/, 'другая модель');
  assert.match(otherKind(need, 'Чип DK-170 Kyocera', 'DK-170'), /чип к нему/, 'чип остаётся деталью, даже с моделью в названии');
  assert.match(otherKind(need, 'Фотобарабан Kyocera DK-170'), /фотобарабан к нему/, 'модели в ТЗ нет — правило прежнее');
});

test('сверка: ТЗ чёрно-белое, страница «цветной лазерный принтер» — не соответствует, с причиной', async () => {
  const item = { name: 'Принтер лазерный', characteristics: MONO };
  const r = await matchOffer(item, { title: 'Цветной лазерный принтер Acme C300', text: 'Характеристики: Цветность печати: цветная; Формат: А4; Скорость печати: 33 стр/мин' }, { llm: createLlm('mock'), system: 's' });
  assert.equal(r.match, 'не соответствует');
  assert.match(r.notes[0], /в ТЗ чёрно-белый .*а товар цветной/);
});

test('сверка: «монохромный» на странице подтверждает требование «Черно-Белая»; цветное ТЗ с «Скорость черно-белой печати» цветной товар не отклоняет', async () => {
  const llm = createLlm('mock');
  const mono = await matchOffer({ name: 'Принтер лазерный', characteristics: MONO },
    { title: 'Принтер лазерный Acme M300', text: 'Характеристики: Тип печати: монохромная; Формат: А4; Скорость печати: 33 стр/мин' }, { llm, system: 's' });
  const row = mono.checks.rows.find((x) => x.name === 'Цветность печати');
  assert.deepEqual([row.verdict, row.found], ['yes', 'Тип печати: монохромная']);
  assert.equal(mono.checks.confirmed, mono.checks.rows.filter((x) => x.verdict === 'yes').length, 'счётчики пересчитаны');
  assert.notEqual(mono.match, 'не соответствует');

  const color = await matchOffer({ name: 'МФУ', characteristics: COLOR },
    { title: 'МФУ цветное Acme C500', text: 'Характеристики: Цветность печати: цветная; Скорость черно-белой печати: 33 стр/мин' }, { llm, system: 's' });
  assert.notEqual(color.match, 'не соответствует', 'цветной товар под цветное ТЗ не отклоняется из-за слов «черно-белая печать»');
  assert.equal(color.checks.rows.find((x) => x.name === 'Цветность печати').verdict, 'yes');
});

test('отбор со страницы каталога: под чёрно-белое ТЗ цветные модели не берутся', () => {
  const list = [
    { title: 'Принтер лазерный HP Color LaserJet Pro 4203dn', price: 30000, url: 'https://s.ru/1' },
    { title: 'Принтер лазерный Pantum P3010D', price: 12000, url: 'https://s.ru/2' },
    { title: 'Принтер цветной струйный Epson L1210', price: 15000, url: 'https://s.ru/3' },
  ];
  const picked = pickFromListing(list, { item: { name: 'Принтер лазерный' }, spec: { required: MONO }, max: 3 });
  assert.deepEqual(picked.map((p) => p.url), ['https://s.ru/2']);
});

test('цена «по запросу»: цена сопутствующего товара ниже по странице — не цена самого товара', () => {
  const { extractStructured } = require('../server/offers/fetch-page');
  // так устроена страница printer-plotter.ru: у МФУ «Запросить цену», а первая цена в разметке — у бумаги
  const page = (own) => `<html><body><h1>МФУ Kyocera ECOSYS M2040dn</h1><div>Технология печати лазерная</div>${own}
    <div class="related"><span>Бумага Canon Black Label Extra, А4</span><span>640 ₽</span><meta itemprop="price" content="640"><meta itemprop="priceCurrency" content="RUB"></div></body></html>`;
  assert.deepEqual(extractStructured(page('<a>Запросить цену</a><span>Под заказ</span>'), 'https://s.ru/p'), []);
  assert.equal(extractStructured('<html><body><h1>МФУ Acme M100</h1><span>45 000 ₽</span><meta itemprop="price" content="45000"></body></html>', 'https://s.ru/p')[0].price, 45000, 'обычная страница читается как прежде');
});

test('подозрительно низкая цена ловится и тогда, когда полностью подтверждённых предложений мало', () => {
  const { rankOffers } = require('../server/offers/rank');
  const base = { source: 'yandex', in_time: true, match_checks: { confirmed: 9, total: 9, failed: 0, unknown: 0 } };
  const r = rankOffers([
    { ...base, id: 1, match: 'соответствует', unit_price: 640, total_cost: 640 },       // цена бумаги вместо цены МФУ
    { ...base, id: 2, match: 'соответствует', unit_price: 68820, total_cost: 68820 },
    { ...base, id: 3, match: 'частично', unit_price: 58400, total_cost: 58400 },
    { ...base, id: 4, match: 'частично', unit_price: 61000, total_cost: 61000 },
    { ...base, id: 5, match: 'частично', unit_price: 84500, total_cost: 84500 },
  ]);
  assert.ok(r.ranked.find((o) => o.id === 1).too_cheap > 50, 'обычная цена посчитана и по «частично»');
  assert.equal(r.best.id, 2, 'в расчёт идёт настоящее предложение, а не «640 ₽»');
});

// ---------- воронка ----------
test('воронка: причина пропуска страницы и подписи', () => {
  assert.equal(pageReason(new FetchSkipped('x', { kind: 'captcha' })), 'captcha');
  assert.equal(pageReason(new FetchSkipped('сайт закрыт от автоматического доступа (HTTP 403)')), 'denied');
  assert.equal(pageReason(new Error('что-то ещё')), 'error');
  const view = describeFunnel({ item_id: 1, name: 'Принтер', queries: [{ text: 'q', source: 'yandex', results: 10, taken: 4 }], dropped: { retail: { n: 3, domains: ['a.ru'] }, blocklist: { n: 5, domains: ['ozon.ru'] } }, taken: 4, opened: 4, pages: { no_price: { n: 1, domains: ['b.ru'] } }, with_price: 3, offers: { 'не соответствует': 1, 'соответствует': 2 } });
  assert.deepEqual(view.dropped.map((r) => [r.key, r.n]), [['blocklist', 5], ['retail', 3]], 'по убыванию потерь');
  assert.equal(view.dropped[1].label, DROP_REASONS.retail);
  assert.equal(view.pages[0].label, PAGE_REASONS.no_price);
  assert.deepEqual(view.offers, [{ match: 'соответствует', n: 2 }, { match: 'не соответствует', n: 1 }]);
  assert.equal(view.found, 10);
});

const XML = (docs) => `<?xml version="1.0"?><yandexsearch><response><results><grouping>${docs.map((u) => `<group><doc><url>${u}</url><domain>${new URL(u).hostname}</domain><title>t</title></doc></group>`).join('')}</grouping></results></response></yandexsearch>`;
const product = (title, price, body = 'Процессор: 6 ядер, 12 потоков, 3.9 ГГц. Оперативная память: 16 ГБ DDR4') => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: title, offers: { price: String(price), priceCurrency: 'RUB', availability: 'https://schema.org/InStock' } })}</script></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

function start({ yandex = [], pages = {}, denied = [], overrides = {} } = {}) {
  const dir = tmp('loss');
  const stores = path.join(dir, 'stores.json');
  fs.writeFileSync(stores, JSON.stringify({ stores: [], b2b: [], suppliers: [], retail: [{ name: 'Большая сеть', site: 'big-retail.ru' }] }));
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://searchapi.api.cloud.yandex.net')) return res(JSON.stringify({ rawData: Buffer.from(XML(yandex)).toString('base64') }), 'application/json');
    if (u.startsWith('https://suggestions.dadata.ru')) return res('{"suggestions":[]}', 'application/json');
    if (u.endsWith('/robots.txt')) return res('', 'text/plain', 404);
    if (denied.some((d) => u.includes(d))) return res('Forbidden', 'text/html', 403);
    void opts;
    return pages[u] ? res(pages[u]) : res('<html><body><h1>О компании</h1><p>Контакты и реквизиты</p></body></html>');
  };
  const config = {
    ...baseConfig, DATA_DIR: dir, STORES_CONFIG: stores, PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, FETCH_MIN_INTERVAL_MS: 0, SUPPLIER_INDEX: false,
    YANDEX_SEARCH_API_KEY: 'k', YANDEX_FOLDER_ID: 'f', DADATA_API_KEY: '', OFFER_SOURCES: 'yandex', SEARCH_MAX_PAGES: 100, SEARCH_MODEL_CANDIDATES: 0, ...overrides,
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, fetchImpl, llmFactory: () => createLlm('mock'), clock: () => NOW, sourceOverride: createFixtureSource({ dir: FIX }) });
  const api = async (p, json) => {
    const r = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, { method: json ? 'POST' : 'GET', headers: json ? { 'Content-Type': 'application/json' } : undefined, body: json ? JSON.stringify(json) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { s, api };
}

/** Закупка с простым ТЗ: три требования, все подтверждаются страницей товара из product(). */
async function simpleTender(s) {
  await s.sync.run();
  const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
  const [item] = await s.details.ensureItems(s.repo.getTender(id));
  s.repo.db.prepare('UPDATE tender_items SET characteristics_json = ?, spec_json = NULL WHERE id = ?')
    .run(JSON.stringify([{ name: 'Количество ядер процессора', value: 'не менее 6 шт' }, { name: 'Объем установленной оперативной памяти', value: 'не менее 8 Гбайт' }, { name: 'Тип оперативной памяти', value: 'DDR4' }]), item.id);
  return { id, itemId: item.id };
}

test('воронка поиска: каждая причина, по которой адрес из выдачи не стал предложением, попадает в счётчик', async () => {
  const { s, api } = start({
    yandex: [
      'https://big-retail.ru/product/1',          // розничная сеть
      'https://www.ozon.ru/product/2',            // маркетплейс
      'https://shop.kz/item/3',                   // зарубежный сайт
      'https://was-closed.ru/item/4',             // закрыт для программ, запомнен раньше
      'https://good.ru/item/a', 'https://good.ru/item/b', 'https://good.ru/item/c', // третья ссылка с сайта — лишняя
      'https://forbidden.ru/item/5',              // не пускает программы
      'https://noprice.ru/item/6',                // страница без цены
      'https://weak.ru/item/7',                   // товар не подходит под ТЗ
      'https://late.ru/item/8',                   // не поместилась в лимит страниц
    ],
    pages: {
      'https://good.ru/item/a': product('Системный блок Acme AO-5000X', 47000),
      'https://good.ru/item/b': product('Системный блок Acme AO-5100X', 49000),
      'https://weak.ru/item/7': product('Системный блок Acme AO-100', 20000, 'Процессор: 2 ядра. Оперативная память: 4 ГБ DDR3'),
      'https://late.ru/item/8': product('Системный блок Acme AO-9000', 51000),
    },
    denied: ['forbidden.ru'],
    overrides: { SEARCH_MAX_PAGES_PER_ITEM: 5, SEARCH_MAX_QUERIES_PER_ITEM: 1, SEARCH_MAX_API_REQUESTS: 1, SEARCH_API_PER_ITEM: 0, SEARCH_MAX_PAGES_PER_DOMAIN: 2 },
  });
  try {
    const { id, itemId } = await simpleTender(s);
    s.repo.setSetting('closed_domain:was-closed.ru', NOW.toISOString());
    const searchId = s.offers.start(id, { auto: true });
    await s.offers.idle();
    const search = s.repo.getOfferSearch(searchId);
    assert.equal(search.status, 'done', search.error);
    const f = search.funnel.find((x) => x.item_id === itemId);
    assert.equal(f.queries.length, 1);
    assert.deepEqual([f.queries[0].results, f.queries[0].taken], [11, 6]);
    assert.deepEqual(Object.fromEntries(Object.entries(f.dropped).map(([k, v]) => [k, v.n])), { retail: 1, blocklist: 1, foreign: 1, closed: 1, domain_cap: 1, page_limit: 1 });
    assert.deepEqual(f.dropped.retail.domains, ['big-retail.ru']);
    assert.deepEqual(f.dropped.page_limit.domains, ['late.ru']);
    assert.equal(f.opened, 5);
    assert.deepEqual(Object.fromEntries(Object.entries(f.pages).map(([k, v]) => [k, v.n])), { denied: 1, no_price: 1 });
    assert.equal(f.with_price, 3);
    assert.deepEqual(f.offers, { 'соответствует': 2, 'не соответствует': 1 });

    // В ответе API — с подписями для интерфейса.
    const { body } = await api(`/api/tenders/${id}/offers`);
    const view = body.search.funnel[0];
    assert.equal(view.dropped.find((r) => r.key === 'retail').label, DROP_REASONS.retail);
    assert.equal(view.pages.find((r) => r.key === 'denied').label, PAGE_REASONS.denied);
    assert.equal(view.found, 11);
  } finally {
    await s.close();
  }
});

test('«простой» запрос — как ищет человек: наименование и модель или главные характеристики, без добавок', () => {
  const { plainQuery } = require('../server/offers/sources/yandex-search');
  const { specOf } = require('../server/offers/spec');
  const cartridge = { name: 'Картридж Cactus CS-CE285A для принтеров HP LaserJet P1102', characteristics: [] };
  assert.equal(plainQuery(cartridge, specOf(cartridge)), 'Картридж Cactus CS-CE285A для принтеров HP LaserJet P1102', 'модель уже в названии — буквы не теряются');
  const drum = { name: 'Картридж для электрографических печатающих устройств', characteristics: [{ name: 'Модель', value: 'DK-170' }] };
  assert.equal(plainQuery(drum, specOf(drum)), 'Картридж для электрографических печатающих устройств DK-170');
  const disk = { name: 'Накопитель данных внутренний', characteristics: [{ name: 'Объем накопителя', value: 'не менее 8 Тбайт' }, { name: 'Форм-фактор', value: '3,5 дюйм' }] };
  const q = plainQuery(disk, specOf(disk));
  assert.ok(q.startsWith('Накопитель данных внутренний ') && !/купить|оптом|цена/.test(q), q);
});

test('поиск: «простой» запрос отправляется последним и только если остался лимит; с одного сайта — до трёх страниц', async () => {
  const urls = ['https://good.ru/item/a', 'https://good.ru/item/b', 'https://good.ru/item/c', 'https://good.ru/item/d'];
  const asked = [];
  const run = async (overrides) => {
    const { s } = start({ yandex: urls, pages: Object.fromEntries(urls.map((u, i) => [u, product(`Системный блок Acme AO-5${i}00X`, 47000 + i)])), overrides });
    try {
      const { id, itemId } = await simpleTender(s);
      const searchId = s.offers.start(id, { auto: true });
      await s.offers.idle();
      return s.repo.getOfferSearch(searchId).funnel.find((x) => x.item_id === itemId);
    } finally { await s.close(); }
  };
  void asked;
  const f = await run({});
  const last = f.queries[f.queries.length - 1].text;
  assert.ok(!/купить|цена|оптом/.test(last) && /^Системный блок/.test(last), `последний запрос — простой: «${last}»`);
  assert.equal(new Set(f.queries.map((q) => q.text.toLowerCase())).size, f.queries.length, 'одинаковый запрос дважды не отправляется');
  assert.deepEqual([f.dropped.domain_cap.n, f.opened], [1, 3], 'из четырёх ссылок одного сайта открыты три');
  const off = await run({ SEARCH_PLAIN_QUERY: false });
  assert.equal(off.queries.length, f.queries.length - 1, 'SEARCH_PLAIN_QUERY=0 убирает ровно один запрос');
  const tight = await run({ SEARCH_MAX_API_REQUESTS: 1, SEARCH_API_PER_ITEM: 0 });
  assert.equal(tight.queries.length, 1, 'лимит израсходован точным запросом — простой не отправляется');
  assert.match(tight.queries[0].text, /купить/);
});

test('проверить ссылку: розничный сайт, закрытый сайт, страница без цены, страница с ценой — и добавление в предложения', async () => {
  const { s, api } = start({
    pages: {
      'https://big-retail.ru/product/acme': product('Системный блок Acme AO-5000X', 58000),
      'https://good.ru/item/a': product('Системный блок Acme AO-5000X', 47000),
    },
    denied: ['forbidden.ru'],
  });
  try {
    const { id, itemId } = await simpleTender(s);
    const check = async (url) => (await api(`/api/tenders/${id}/offers/check-url`, { item_id: itemId, url })).body;
    const keys = (r) => r.steps.map((x) => `${x.key}:${x.ok ? 'да' : 'нет'}`);

    const retail = await check('https://big-retail.ru/product/acme');
    assert.deepEqual(keys(retail), ['site:нет', 'page:да', 'price:да', 'match:да'], 'сайт исключён, но страницу проверяем: человек назвал её сам');
    assert.match(retail.steps[0].text, /розничные сети/);
    assert.deepEqual([retail.in_search, retail.can_add], [false, true]);

    const closed = await check('https://forbidden.ru/item/5');
    assert.deepEqual(keys(closed), ['site:да', 'page:нет']);
    assert.match(closed.steps[1].text, /не пускает программы/);
    assert.equal(closed.can_add, false);

    const noPrice = await check('https://noprice.ru/item/6');
    assert.deepEqual(keys(noPrice), ['site:да', 'page:да', 'price:нет']);

    const good = await check('https://good.ru/item/a');
    assert.deepEqual(keys(good), ['site:да', 'page:да', 'price:да', 'match:да']);
    assert.deepEqual([good.in_search, good.can_add, good.known, good.offer.match], [true, true, false, 'соответствует']);
    assert.equal(s.repo.getOffers(id).length, 0, 'проверка ничего не сохраняет');

    const bad = await api(`/api/tenders/${id}/offers/check-url`, { item_id: itemId, url: 'не ссылка' });
    assert.equal(bad.status, 400);

    // Добавление — прежним маршрутом ручного предложения; после него та же ссылка «уже есть в списке».
    const added = await api(`/api/tenders/${id}/offers`, { item_id: itemId, url: 'https://good.ru/item/a' });
    assert.equal(added.status, 201);
    assert.equal((await check('https://good.ru/item/a')).known, true);
  } finally {
    await s.close();
  }
});

// ---------- остатки ----------
const { readStock, scanStock, normalizeAvailability } = require('../server/offers/stock');
const STOCK_PAGES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stock', 'pages.json'), 'utf8'));

test('остаток: настоящие страницы поставщиков — на каждый способ, которым магазины показывают наличие', () => {
  const read = (key) => { const p = STOCK_PAGES[key]; const r = readStock({ text: p.text, html: p.html || '', availability: p.availability, attr: p.attr || null }); return [r.qty, r.note, r.availability]; };
  // число в тексте страницы
  assert.deepEqual(read('ink-market.ru-1'), [11, null, 'в наличии'], '«В наличии · 11 шт», а не «100+ шт» у соседнего товара ниже');
  assert.deepEqual(read('shop.nag.ru-2'), [1000, 'более 1000', 'в наличии'], '«1 000+ шт» — с пробелом в тысячах');
  assert.deepEqual(read('xcom-shop.ru-1'), [1, 'от 1 до 3', 'в наличии'], '«Количество товара на складах: 1 – 3»');
  assert.deepEqual(read('xcom-shop.ru-3'), [100, 'более 100', 'в наличии']);
  assert.deepEqual(read('ssd.ru-2'), [0, null, 'нет в наличии'], '«В наличии 0 шт» по всем складам — товара нет, что бы ни говорила разметка');
  // число в проверенном атрибуте сайта
  assert.deepEqual(read('sec-group.ru-2'), [48, null, 'в наличии']);
  // только слова
  assert.deepEqual(read('regard.ru-2'), [null, null, 'в наличии']);
  assert.deepEqual(read('shop.nag.ru-1'), [null, 'под заказ', 'под заказ'], 'сам товар под заказ; «В наличии : 3 шт» ниже — у другого товара');
  assert.deepEqual(read('kns.ru-2'), [null, null, 'нет в наличии'], '«Нет в наличии более 6 месяцев» — это срок, а не шесть штук');
  assert.deepEqual(read('serverflow.ru-2'), [null, null, 'нет в наличии']);
  assert.deepEqual(read('skomplekt.com-3'), [null, null, 'нет в наличии'], '«Товар не поставляется»; остатки похожих товаров ниже не берём');
  // наличие не показано
  assert.deepEqual(read('servermall.ru-1'), [null, null, null], '«Доступность уточняйте» — сведений на странице нет');
  assert.deepEqual(read('zscom.ru-1'), [null, null, null], '«отгрузка при наличии на складе» — оговорка, а не наличие');
  assert.deepEqual(read('compday.ru-1'), [null, null, null]);
});

test('остаток: первый признак после названия товара; деньги, сроки и магазины — не количество', () => {
  const s = (t) => { const r = scanStock(t); return [r.qty, r.note, r.availability]; };
  assert.deepEqual(s('Под заказ. Похожие товары: Картридж X — В наличии: 68 шт'), [null, 'под заказ', 'под заказ']);
  assert.deepEqual(s('В наличии от 504 632 ₽ с НДС'), [null, null, 'в наличии']);
  assert.deepEqual(s('В наличии в 12 магазинах'), [null, null, 'в наличии']);
  assert.deepEqual(s('На складе 1 год гарантии'), [null, null, 'в наличии']);
  assert.deepEqual(s('В наличии: много'), [null, 'много', 'в наличии']);
  // кабель продают метрами, крепёж — упаковками
  assert.deepEqual(s('Кратно 13 м В наличии 0 м Основной склад (Домодедово) 0 м'), [0, null, 'нет в наличии']);
  assert.deepEqual(s('В наличии : 1 000+ м'), [1000, 'более 1000', 'в наличии']);
  assert.deepEqual(s('В наличии : 100+ уп'), [100, 'более 100', 'в наличии']);
  // число без единицы — только когда за ним начинается другая надпись
  assert.deepEqual(s('4 200 руб. В наличии 7 Получить спец. цену'), [7, null, 'в наличии']);
  assert.deepEqual(s('В наличии 3 цвета корпуса'), [null, null, 'в наличии']);
  assert.deepEqual(s('Информация о наличии на складе носит справочный характер'), [null, null, null]);
  assert.deepEqual(s('Наличие и срок поставки уточняйте у менеджеров. В корзину. Под заказ'), [null, 'под заказ', 'под заказ']);
  assert.equal(readStock({ text: 'В наличии', level: { '@type': 'QuantitativeValue', value: 25 } }).qty, 25, 'разметка страницы важнее текста');
  assert.equal(readStock({ html: '<input name="q" data-max-quantity="48">', availability: 'PreOrder', attr: 'data-max-quantity' }).qty, null, 'под заказ — атрибут показывает, сколько можно заказать, а не остаток');
});

test('наличие: что бы ни написал магазин — в интерфейсе три слова, служебные значения не показываются', () => {
  assert.equal(normalizeAvailability('https://schema.org/InStock'), 'в наличии');
  assert.equal(normalizeAvailability('PreOrder'), 'под заказ');
  assert.equal(normalizeAvailability('BackOrder'), 'под заказ');
  assert.equal(normalizeAvailability('OutOfStock'), 'нет в наличии');
  assert.equal(normalizeAvailability('Нет в наличии'), 'нет в наличии');
  assert.equal(normalizeAvailability('Есть на складе'), 'в наличии');
  assert.equal(normalizeAvailability('В корзину'), null, 'надпись на кнопке — не сведения о наличии');
  assert.equal(normalizeAvailability(null), null);
});

test('прежние находки: остаток дочитывается повторным открытием страницы, без поисковика; «PreOrder» в ответе — «под заказ»', async () => {
  const { s, api } = start({
    pages: {
      'https://opt-a.ru/item/1': product('Системный блок Acme AO-5000X', 47000, 'В наличии: 14 шт. Процессор: 6 ядер. Оперативная память: 16 ГБ DDR4'),
      'https://opt-b.ru/item/2': product('Системный блок Acme AO-5100X', 49000),
    },
    denied: ['opt-c.ru'],
  });
  try {
    const { id, itemId } = await simpleTender(s);
    const base = { tender_id: id, item_id: itemId, source: 'yandex', price: 47000, unit_price: 47000, pack_qty: 1, match: 'соответствует', match_notes: [], trust: 60, trust_reasons: [] };
    // так выглядят предложения, найденные до появления чтения остатков: количества нет, наличие — как в разметке
    const a = s.repo.insertOffer({ ...base, title: 'Системный блок Acme AO-5000X', url: 'https://opt-a.ru/item/1', domain: 'opt-a.ru', availability: 'InStock' });
    const b = s.repo.insertOffer({ ...base, title: 'Системный блок Acme AO-5100X', url: 'https://opt-b.ru/item/2', domain: 'opt-b.ru', availability: 'PreOrder', unit_price: 49000 });
    const c = s.repo.insertOffer({ ...base, title: 'Системный блок Acme AO-5200X', url: 'https://opt-c.ru/item/3', domain: 'opt-c.ru', availability: null, unit_price: 51000 });
    const before = (await api(`/api/tenders/${id}/offers`)).body.groups[0];
    assert.equal([...before.ranked, ...before.rejected.map((x) => x.offer)].find((o) => o.id === b).availability, 'под заказ', 'служебное «PreOrder» наружу не выходит');

    const r = (await api(`/api/tenders/${id}/offers/stock`, {})).body;
    assert.deepEqual([r.checked, r.left], [3, 0]);
    const got = Object.fromEntries(s.repo.getOffers(id).map((o) => [o.id, [o.stock_qty, o.availability, Boolean(o.stock_checked_at)]]));
    assert.deepEqual(got[a], [14, 'в наличии', true]);
    assert.deepEqual(got[b], [null, 'в наличии', true], 'наличие обновлено по странице: теперь InStock');
    assert.deepEqual(got[c], [null, null, true], 'страница не открылась — помечено проверенным, повторно не ходим');
    assert.equal((await api(`/api/tenders/${id}/offers/stock`, {})).body.checked, 0, 'второй раз проверять нечего');
  } finally {
    await s.close();
  }
});

test('«Подтвердить наличие»: заново открывается только выбранный товар и не чаще раза в 30 минут; итог — сколько в наличии', async () => {
  const { s, api } = start({ pages: { 'https://opt-a.ru/item/1': product('Системный блок Acme AO-5000X', 47000, 'В наличии: 14 шт.'), 'https://opt-b.ru/item/2': product('Системный блок Acme AO-5100X', 49000) } });
  try {
    const { id, itemId } = await simpleTender(s);
    const base = { tender_id: id, item_id: itemId, source: 'yandex', price: 47000, unit_price: 47000, pack_qty: 1, match: 'соответствует', match_notes: [], trust: 60, trust_reasons: [] };
    const a = s.repo.insertOffer({ ...base, title: 'Системный блок Acme AO-5000X', url: 'https://opt-a.ru/item/1', domain: 'opt-a.ru', availability: null });
    const b = s.repo.insertOffer({ ...base, title: 'Системный блок Acme AO-5100X', url: 'https://opt-b.ru/item/2', domain: 'opt-b.ru', availability: null, unit_price: 49000 });
    s.repo.db.prepare('UPDATE tender_items SET purchase_offer_id = ? WHERE id = ?').run(a, itemId);
    // обе страницы уже проверялись час назад — обычная проверка их не трогает
    s.repo.db.prepare("UPDATE offers SET stock_checked_at = '2026-09-17T08:00:00.000Z' WHERE id IN (?, ?)").run(a, b);
    assert.equal((await api(`/api/tenders/${id}/offers/stock`, {})).body.checked, 0);
    const r = (await api(`/api/tenders/${id}/offers/stock`, { selected: true })).body;
    assert.equal(r.checked, 1, 'открыт только выбранный товар');
    assert.deepEqual(r.selected, { total: 1, in_stock: 1, out_of_stock: 0, unknown: 0 });
    const got = Object.fromEntries(s.repo.getOffers(id).map((o) => [o.id, o.stock_qty]));
    assert.deepEqual([got[a], got[b]], [14, null], 'невыбранный не перепроверялся');
    s.repo.db.prepare("UPDATE offers SET stock_checked_at = '2026-09-17T08:50:00.000Z' WHERE id = ?").run(a);
    assert.equal((await api(`/api/tenders/${id}/offers/stock`, { selected: true })).body.checked, 0, '10 минут назад — повторно не открываем');
  } finally {
    await s.close();
  }
});
