// Та же модель на маркетплейсах: ищутся только модели, сверенные с ТЗ; из выдачи — только карточки этой модели;
// маркетплейсы сервис не открывает; каждый запрос к поиску — в суточный лимит; повтор в течение 3 дней бесплатен.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { createLlm } = require('../server/llm');
const { confirmedModels, cardsFrom, brandBefore } = require('../server/offers/marketplaces');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const NOW = new Date('2026-10-17T09:00:00Z');
const res = (body, type = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'content-type': type } });
const XML = (docs) => `<?xml version="1.0"?><yandexsearch><response><results><grouping>${docs.map(([u, t]) => `<group><doc><url>${u}</url><domain>${new URL(u).hostname}</domain><title>${t}</title></doc></group>`).join('')}</grouping></results></response></yandexsearch>`;

test('модели для маркетплейсов: из ТЗ и из товаров «соответствует»; частично подошедшие и госконтракты — нет', () => {
  const item = { name: 'Картридж лазерный', spec: { identity: { model: 'CF259A', brand: 'HP' } } };
  const offers = [
    { match: 'соответствует', source: 'yandex', title: 'Тонер-картридж Cactus CS-CF259A для HP LaserJet M404', domain: 'opt-a.ru' },
    { match: 'частично', source: 'yandex', title: 'Картридж Sakura SA-CF259X', domain: 'opt-b.ru' },
    { match: 'соответствует', source: 'contracts', title: 'Картридж Easyprint LH-CF259A', domain: '' },
  ];
  const m = confirmedModels(item, offers);
  assert.deepEqual(m.map((x) => [x.model, x.query]), [['CF259A', 'Картридж HP CF259A'], ['CS-CF259A', 'Картридж Cactus CS-CF259A']]);
  assert.match(m[1].basis, /opt-a\.ru/);
  assert.equal(brandBefore('МФУ лазерное Pantum M6700DW, принтер', 'M6700DW'), 'Pantum');
  assert.deepEqual(confirmedModels({ name: 'МФУ' }, [{ match: 'частично', title: 'МФУ Pantum M6700DW' }]), [], 'нет сверенной модели — искать нечего');
});

test('карточки из выдачи: только страницы товара той же модели; категории, поиск и чужие модели отброшены; аналог помечен', () => {
  const cards = cardsFrom([
    { url: 'https://www.ozon.ru/category/kartridzh-hp-cf259a/', title: 'Картридж HP CF259A купить на OZON' },
    { url: 'https://www.ozon.ru/product/hp-toner-kartridzh-cf259a-original-1662069/', title: 'HP Тонер-картридж HP-59A (CF259A), оригинал' },
    { url: 'https://www.ozon.ru/product/hp-toner-kartridzh-cf259a-original-1662069/reviews/', title: 'HP Тонер-картридж HP-59A (CF259A), оригинал' },
    { url: 'https://www.ozon.ru/product/kartridzh-hp-cf259x-59x-2215072042/', title: 'Картридж HP CF259X № 59X черный' },
    { url: 'https://www.wildberries.ru/catalog/164379765/detail.aspx', title: 'Картридж совместимый CF259A для HP' },
    { url: 'https://market.yandex.ru/search?text=cf259a', title: 'Картридж HP CF259A — купить на Яндекс Маркете' },
  ], 'CF259A');
  assert.deepEqual(cards.map((c) => [c.market, c.analog]), [['ozon', false], ['wb', true]], 'категория, отзывы-дубль, CF259X и поиск Маркета — не карточки этой модели');
});

function start({ yandex = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-mp-'));
  const opened = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.startsWith('https://searchapi.api.cloud.yandex.net')) { opened.push('yandex'); return res(JSON.stringify({ rawData: Buffer.from(XML(yandex)).toString('base64') }), 'application/json'); }
    if (/ozon|wildberries|market\.yandex|megamarket/.test(u)) opened.push(u);
    return res('<html><body>нет</body></html>');
  };
  const config = {
    ...baseConfig, DATA_DIR: dir, PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '', ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0,
    REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0, PLATFORM_FETCH_PER_SYNC: 0, SUPPLIER_INDEX: false, FETCH_MIN_INTERVAL_MS: 0,
    YANDEX_SEARCH_API_KEY: 'k', YANDEX_FOLDER_ID: 'f', DADATA_API_KEY: '', OFFER_SOURCES: 'yandex', SEARCH_DAILY_MAX_API_REQUESTS: 50,
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, fetchImpl, llmFactory: () => createLlm('mock'), clock: () => NOW, sourceOverride: createFixtureSource({ dir: FIX }) });
  const api = async (p, json) => {
    const r = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, { method: json ? 'POST' : 'GET', headers: json ? { 'Content-Type': 'application/json' } : undefined, body: json ? JSON.stringify(json) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { s, api, opened };
}

test('поиск на маркетплейсах: один запрос на модель, маркетплейсы не открываются, повтор бесплатен; цену человек вписывает сам', async () => {
  const { s, api, opened } = start({ yandex: [
    ['https://www.ozon.ru/product/mfu-lazernoe-pantum-m6700dw-953976972/', 'МФУ лазерное Pantum M6700DW, принтер, сканер'],
    ['https://www.wildberries.ru/catalog/240150231/detail.aspx', 'МФУ лазерный M6700DW, Wi-Fi, дуплекс'],
    ['https://www.ozon.ru/category/pantum-m6700/', 'PANTUM M6700 купить на OZON'],
  ] });
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    const [item] = await s.details.ensureItems(s.repo.getTender(id));
    const url = `/api/tenders/${id}/items/${item.id}/marketplaces`;
    // пока нет сверенной модели — искать нечего, и платный запрос не делается
    const none = (await api(url, {})).body;
    assert.deepEqual([none.models.length, none.spent, opened.length], [0, 0, 0]);
    assert.match(none.error, /сверенной с ТЗ/);

    s.repo.insertOffer({ tender_id: id, item_id: item.id, source: 'yandex', title: 'МФУ лазерное Pantum M6700DW', url: 'https://opt-a.ru/item/1', domain: 'opt-a.ru', price: 21000, unit_price: 21000, pack_qty: 1, match: 'соответствует', match_notes: [], trust: 60, trust_reasons: [] });
    const before = (await api(url)).body;
    assert.deepEqual([before.models[0].model, before.models[0].cards, before.spent], ['M6700DW', null, 0], 'посмотреть — бесплатно, без поиска');
    assert.ok(before.models[0].links.some((l) => l.url.startsWith('https://www.ozon.ru/search/?text=') && l.url.endsWith('Pantum%20M6700DW')));

    const r = (await api(url, {})).body;
    assert.equal(r.spent, 1);
    assert.deepEqual(r.models[0].cards.map((c) => c.market), ['ozon', 'wb']);
    assert.deepEqual(opened, ['yandex'], 'сами маркетплейсы сервис не открывал');
    assert.equal(s.repo.apiUsage('yandex', '2026-10-17'), 1, 'запрос учтён в суточном лимите');
    assert.equal((await api(url, {})).body.spent, 0, 'в течение 3 дней — из сохранённого');

    // цену человек посмотрел по ссылке и вписал: предложение маркетплейса, страница не открывается
    const add = await api(`/api/tenders/${id}/offers`, { item_id: item.id, url: r.models[0].cards[0].url, price: 18490, title: r.models[0].cards[0].title, seller_name: 'Ozon (маркетплейс)', same_model: 'M6700DW' });
    assert.equal(add.status, 201);
    assert.deepEqual(opened, ['yandex'], 'ни страницы товара, ни главной Ozon сервис не открывал');
    const o = s.repo.getOffers(id).find((x) => x.domain === 'ozon.ru');
    assert.deepEqual([o.unit_price, o.seller_name, o.match], [18490, 'Ozon (маркетплейс)', 'соответствует'], 'та же модель, что сверена с ТЗ');
    assert.match(o.match_notes[0], /та же модель M6700DW.*opt-a\.ru/);
    // чужая модель с тем же «same_model» не становится подходящей
    await api(`/api/tenders/${id}/offers`, { item_id: item.id, url: 'https://www.ozon.ru/product/pantum-m6700dw-plus-1/', price: 15000, title: 'МФУ Pantum M6700DW Plus', seller_name: 'Ozon (маркетплейс)', same_model: 'M7100DW' });
    assert.notEqual(s.repo.getOffers(id).find((x) => x.unit_price === 15000).match, 'соответствует', 'модель M7100DW не сверялась — вывода нет');
  } finally { s.server.close(); }
});

test('полный разбор знает свою закупку — чтобы из разбора вернуться к ней; разбор без закупки — без ссылки', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    s.repo.createAnalysis({ id: 'an-with-tender', title: 'Документация' });
    s.repo.createAnalysis({ id: 'an-alone', title: 'Загружено вручную' });
    s.repo.db.prepare('UPDATE tenders SET analysis_id = ? WHERE id = ?').run('an-with-tender', id);
    const a = (await api('/api/analyses/an-with-tender')).body;
    assert.equal(a.tender.id, id);
    assert.equal(a.tender.number, '0332200035226000280');
    assert.equal((await api('/api/analyses/an-alone')).body.tender, null);
    assert.equal((await api('/api/analyses/нет-такого')).status, 404);
  } finally { s.server.close(); }
});
