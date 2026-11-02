// Адресный поиск недостающих характеристик по модели: модель из названия, запросы, страницы той же модели,
// свой суточный лимит и запоминание найденного по модели (повторно не платим).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { modelOf, queriesFor, missingRows, sameModelPage, mergeMakerChecks } = require('../server/offers/maker-search');
const { openDb } = require('../server/db');
const { createOfferService } = require('../server/offers');
const baseConfig = require('../server/config');

test('модель из названия: латиница, кириллица, бренд с цифрой и интерфейсы моделью не считаются', () => {
  assert.equal(modelOf('Клавиатура Defender GK-196L проводная USB'), 'GK-196L');
  assert.equal(modelOf('Мышь A4Tech S310N беспроводная'), 'S310N');
  assert.equal(modelOf('Клавиатура КЛ104РУ черная'), 'КЛ104РУ');
  assert.equal(modelOf('Кабель HDMI 2м'), null);
  // совместимый картридж: номер оригинала после «для» — чужой товар
  assert.equal(modelOf('Тонер-картридж EasyPrint LX-B230 для Xerox B225, B230, B235 (6000 стр.) черный, с чипом 006R04404'), 'LX-B230');
  assert.equal(modelOf('Картридж для HP LaserJet CF259X'), null);
  assert.equal(modelOf('Совместимый тонер картридж CACTUS для HP (CS-CF226X-MPS)'), 'CS-CF226X-MPS');
  assert.equal(modelOf('Бумага офисная А4 500 листов'), null);
});

test('запросы: бренд, модель и до двух недостающих свойств; условия поставки не ищутся', () => {
  const checks = { rows: [
    { name: 'Способ нанесения русификации клавиатуры', need: 'лазерная гравировка', verdict: 'unknown' },
    { name: 'Тип', need: 'Полноразмерная', verdict: 'unknown' },
    { name: 'Гарантийный срок', need: 'не менее 12 мес', verdict: 'unknown' },
    { name: 'Интерфейс', need: 'USB', verdict: 'yes' },
  ] };
  const rows = missingRows(checks);
  assert.deepEqual(rows.map((r) => r.name), ['Способ нанесения русификации клавиатуры', 'Тип']);
  const qs = queriesFor('Клавиатура Defender GK-196L', rows);
  assert.equal(qs.length, 1);
  assert.match(qs[0], /^Defender GK-196L Способ нанесения русификации клавиатуры Тип Полноразмерная характеристики$/);
  assert.deepEqual(queriesFor('Кабель HDMI 2м', rows), []);
});

test('страница той же модели: без разделителей и регистра; другая модель — нет', () => {
  assert.ok(sameModelPage('Клавиатура Defender gk 196l, черная', 'GK-196L'));
  assert.ok(!sameModelPage('Клавиатура Defender GK-195L', 'GK-196L'));
  // совместимый картридж назван номером оригинала: страница оригинала HP без бренда NV Print — не та
  assert.ok(!sameModelPage('Картридж HP CF226X оригинальный', 'CF226X', 'NV Print'));
  assert.ok(sameModelPage('Картридж NV-Print CF226X', 'CF226X', 'NV Print'));
});

test('слияние: меняются только неподтверждённые строки, у них источник и способ; «нет» отклоняет товар', () => {
  const checks = { total: 3, of: 3, confirmed: 1, failed: 0, unknown: 2, rows: [
    { name: 'Интерфейс', need: 'USB', verdict: 'yes', found: 'USB' },
    { name: 'Тип', need: 'Полноразмерная', verdict: 'unknown' },
    { name: 'Подсветка', need: 'нет', verdict: 'unknown' },
  ] };
  const pages = [{ url: 'https://defender.ru/gk-196l', domain: 'defender.ru', text: 'Тип: полноразмерная' }];
  const sub = { checks: { rows: [
    { name: 'Тип', need: 'Полноразмерная', verdict: 'yes', found: 'полноразмерная', quote: 'Тип: полноразмерная' },
    { name: 'Подсветка', need: 'нет', verdict: 'unknown' },
    { name: 'Интерфейс', need: 'USB', verdict: 'no', found: 'PS/2' }, // уже подтверждённое не трогаем
  ] } };
  const m = mergeMakerChecks(checks, sub, pages);
  assert.equal(m.changed, 1);
  assert.equal(m.checks.confirmed, 2);
  assert.equal(m.checks.unknown, 1);
  const row = m.checks.rows.find((r) => r.name === 'Тип');
  assert.equal(row.source, 'https://defender.ru/gk-196l');
  assert.match(row.method, /по модели — в интернете: defender\.ru/);
  assert.equal(m.checks.rows[0].verdict, 'yes');
  assert.equal(m.match, 'частично');
  const bad = mergeMakerChecks(checks, { checks: { rows: [{ name: 'Подсветка', need: 'нет', verdict: 'no', found: 'RGB-подсветка' }] } }, pages);
  assert.equal(bad.match, 'не соответствует');
  const full = mergeMakerChecks(checks, { checks: { rows: [{ name: 'Тип', verdict: 'yes', found: 'да' }, { name: 'Подсветка', verdict: 'yes', found: 'нет' }] } }, pages);
  assert.equal(full.match, 'соответствует');
  assert.equal(mergeMakerChecks(checks, { checks: { rows: [{ name: 'Тип', verdict: 'yes' }, { name: 'Подсветка', verdict: 'yes' }] } }, pages, { specComplete: false }).match, 'частично');
});

// Подставной Яндекс и сайты: считаем запросы к поиску и открытия страниц.
function world(extra = {}) {
  const calls = { search: 0, pages: [] };
  const xml = (urls) => Buffer.from(`<yandexsearch>${urls.map((u) => `<doc><url>${u}</url><domain>${new URL(u).hostname}</domain><title>t</title></doc>`).join('')}</yandexsearch>`).toString('base64');
  const html = {
    'https://defender.ru/catalog/gk-196l': '<html><body><h1>Клавиатура Defender GK-196L</h1><table><tr><td>Тип</td><td>полноразмерная</td></tr><tr><td>Подсветка</td><td>нет</td></tr></table></body></html>',
    'https://other.ru/gk-195l': '<html><body><h1>Клавиатура Defender GK-195L</h1><p>Тип: компактная</p></body></html>',
    ...extra,
  };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('searchapi') || u.includes('search-api') || (opts.method === 'POST' && /yandex|cloud/.test(u))) {
      calls.search++;
      return new Response(JSON.stringify({ rawData: xml(Object.keys(html)) }), { status: 200 });
    }
    if (u.endsWith('/robots.txt')) return new Response('', { status: 404 });
    calls.pages.push(u);
    if (html[u]) return new Response(html[u], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('нет', { status: 404 });
  };
  return { calls, fetchImpl };
}

function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maker-search-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { ...baseConfig, DATA_DIR: dir, OFFER_SOURCES: 'yandex,manual', YANDEX_SEARCH_API_KEY: 'test-key', YANDEX_FOLDER_ID: 'test-folder', DADATA_API_KEY: '', TELEGRAM_BOT_TOKEN: '', FETCH_MIN_INTERVAL_MS: 0, ...extra };
  const { id } = repo.upsertTender({ law: '44', number: 'maker-1', title: 'Клавиатуры', price: 10000, currency: 'RUB', region: 27, okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: 1, eis_url: null });
  repo.saveItems(id, [{ name: 'Клавиатура', quantity: 2, unit: 'шт', source: 'notification', characteristics: [{ name: 'Интерфейс', value: 'USB' }, { name: 'Тип', value: 'Полноразмерная' }, { name: 'Подсветка', value: 'нет' }] }]);
  const item = repo.getItems(id)[0];
  const offer = (title, url, price) => repo.insertOffer({ tender_id: id, item_id: item.id, source: 'yandex', title, url, domain: new URL(url).hostname, price, unit_price: price, match: 'частично',
    match_checks: { total: 3, of: 3, confirmed: 1, failed: 0, unknown: 2, rows: [
      { name: 'Интерфейс', need: 'USB', verdict: 'yes', found: 'USB' },
      { name: 'Тип', need: 'Полноразмерная', verdict: 'unknown' },
      { name: 'Подсветка', need: 'нет', verdict: 'unknown' },
    ] } });
  // нейросеть сверки: «Тип» и «Подсветка» подтверждены по тексту найденной страницы
  const llm = { complete: async ({ messages }) => {
    const ask = JSON.parse(messages[messages.length - 1].content);
    const names = (ask.required?.characteristics || []).map((c) => c.name);
    return { text: JSON.stringify({ kind: true, checks: Object.fromEntries(names.map((n, i) => [i + 1, n === 'Тип' ? 'да: полноразмерная' : n === 'Подсветка' ? 'да: нет' : '?'])) }) };
  } };
  return { repo, config, id, item, offer, llm };
}

test('«Найти по модели»: страница той же модели подтверждает недостающее, расход по своему счётчику, повтор — из памяти', async (t) => {
  const { repo, config, offer, llm } = setup(t);
  const { calls, fetchImpl } = world();
  const offers = createOfferService({ config, repo, details: {}, llmFactory: () => llm, fetchImpl });
  const a = offer('Клавиатура Defender GK-196L', 'https://shop.ru/a', 500);
  const r = await offers.findByModel(a);
  assert.equal(r.changed, 2, JSON.stringify(r));
  assert.equal(r.after, 'соответствует');
  assert.deepEqual(r.pages.map((p) => p.domain), ['defender.ru']); // страница другой модели (GK-195L) отброшена
  assert.ok(r.queries >= 1 && r.queries <= 2);
  const day = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  assert.equal(repo.apiUsage('yandex', day), 0, 'лимит поиска поставщиков не тронут');
  assert.ok(repo.apiUsage('yandex_maker', day) >= 1);
  const saved = repo.getOffer(a);
  assert.equal(saved.match, 'соответствует');
  assert.match(saved.match_checks.rows.find((x) => x.name === 'Тип').method, /defender\.ru/);

  // та же модель у другого продавца — без новых запросов к Яндексу
  const before = calls.search;
  const b = offer('Клавиатура проводная Defender GK-196L черная', 'https://shop2.ru/b', 520);
  const r2 = await offers.findByModel(b);
  assert.equal(calls.search, before);
  assert.equal(r2.queries, 0);
  assert.equal(r2.changed, 2);
});

test('суточный лимит поиска по модели исчерпан — запросов нет, понятная причина', async (t) => {
  const { repo, config, offer, llm } = setup(t, { MAKER_SEARCH_DAILY: 1 });
  const { calls, fetchImpl } = world();
  const offers = createOfferService({ config, repo, details: {}, llmFactory: () => llm, fetchImpl });
  const day = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  repo.addApiUsage('yandex_maker', day);
  const r = await offers.findByModel(offer('Клавиатура Defender GK-196L', 'https://shop.ru/a', 500));
  assert.equal(calls.search, 0);
  assert.equal(r.changed, 0);
  assert.match(r.reason, /лимит/);
  assert.equal(r.daily_left, 0);
});

test('без модели в названии — не ищем и не платим', async (t) => {
  const { repo, config, offer, llm } = setup(t);
  const { calls, fetchImpl } = world();
  const offers = createOfferService({ config, repo, details: {}, llmFactory: () => llm, fetchImpl });
  const r = await offers.findByModel(offer('Клавиатура проводная черная', 'https://shop.ru/c', 400));
  assert.equal(calls.search, 0);
  assert.match(r.reason, /нет модели/);
});

test('розничная сеть: в закупочную цену не идёт, но характеристики модели с её страницы берутся', async (t) => {
  const { repo, config, offer, llm } = setup(t);
  const { fetchImpl } = world({ 'https://www.citilink.ru/product/gk-196l': '<html><body><h1>Клавиатура Defender GK-196L</h1><p>Тип: полноразмерная. Подсветка: нет</p></body></html>' });
  const offers = createOfferService({ config, repo, details: {}, llmFactory: () => llm, fetchImpl });
  const r = await offers.findByModel(offer('Клавиатура Defender GK-196L', 'https://shop.ru/a', 500));
  assert.ok(r.pages.some((p) => p.domain === 'citilink.ru'), JSON.stringify(r.pages));
});

test('бесплатно: недостающее нашлось на странице другого продавца этой модели — без запросов к Яндексу', async (t) => {
  const { repo, config, id, item, offer, llm } = setup(t, { YANDEX_SEARCH_API_KEY: '' });
  const { calls, fetchImpl } = world({ 'https://peer.ru/defender-gk-196l': '<html><body><h1>Клавиатура Defender GK-196L</h1><p>Тип: полноразмерная. Подсветка: нет</p></body></html>' });
  // другой продавец этой модели уже встречался сервису (в любой закупке)
  repo.insertOffer({ tender_id: id, item_id: item.id, source: 'yandex', title: 'Defender GK-196L клавиатура USB', url: 'https://peer.ru/defender-gk-196l', domain: 'peer.ru', price: 600, unit_price: 600, match: 'частично' });
  const offers = createOfferService({ config, repo, details: {}, llmFactory: () => llm, fetchImpl });
  const a = offer('Клавиатура Defender GK-196L', 'https://shop.ru/a', 500);
  const r = await offers.findByModel(a);
  assert.equal(calls.search, 0, 'платный поиск не нужен');
  assert.equal(r.changed, 2, JSON.stringify(r));
  assert.equal(r.after, 'соответствует');
  assert.equal(r.trace[0].route, 'peers');
  const saved = repo.getOffer(a).match_checks;
  assert.match(saved.rows.find((x) => x.name === 'Тип').method, /у другого продавца: peer\.ru/);
  assert.equal(saved.maker.trace[0].closed, 2);
  // досье модели сохранено: следующий продавец этой модели закрывается из памяти, страницы не открываются заново
  const opened = calls.pages.length;
  const r2 = await offers.findByModel(offer('Клавиатура проводная Defender GK-196L черная', 'https://shop2.ru/b', 510));
  assert.equal(r2.trace[0].route, 'memory');
  assert.equal(r2.changed, 2);
  assert.equal(calls.pages.length, opened);
});

test('ничего не нашлось — у требования видно, где искали; платный поиск выключен, а не «товара нет»', async (t) => {
  const { repo, config, offer, llm } = setup(t, { YANDEX_SEARCH_API_KEY: '' });
  const { fetchImpl } = world();
  const offers = createOfferService({ config, repo, details: {}, llmFactory: () => llm, fetchImpl });
  const a = offer('Клавиатура Defender GK-196L', 'https://shop.ru/a', 500);
  const r = await offers.findByModel(a);
  assert.equal(r.changed, 0);
  const row = repo.getOffer(a).match_checks.rows.find((x) => x.name === 'Тип');
  assert.equal(row.verdict, 'unknown');
  assert.match(row.tried, /других продавцов этой модели в базе нет/);
  assert.match(row.tried, /нет ключа Яндекса/);
});

test('модель: числительные, размеры и процессор — не модель; точка внутри обозначения сохраняется', () => {
  assert.equal(modelOf('Бахилы Особо Прочные синие (с 2-ой резинкой) в евроблоках'), null);
  assert.equal(modelOf('Стол ученический 2-местный с закруг. углами'), null);
  assert.equal(modelOf('Ноутбук Lenovo IdeaPad 3 15.6 i5-1235U 8GB'), null);
  assert.equal(modelOf('Э-32.2 Стол компьютерный (1000х700х750 мм)'), 'Э-32.2');
});

test('совместимый без своего бренда и универсальный артикул — характеристики чужого товара не переносятся', () => {
  const { noNameCompatible, otherVariant, brandOf } = require('../server/offers/maker-search');
  assert.ok(noNameCompatible('Тонер-картридж TK-5290K совместимый для Kyocera Ecosys P7240cdn'));
  assert.equal(brandOf('Тонер-картридж TK-5290K совместимый для Kyocera'), null);
  assert.ok(!noNameCompatible('Совместимый тонер картридж CACTUS для HP (CS-CF226X)'));
  assert.ok(otherVariant('<h1>Картридж Hi-Black (HB-CE505X/CF280X/CRG-719) для HP</h1>', 'HB-CE505X', 'Картридж Hi-Black HB-CE505X, черный'));
  assert.ok(!otherVariant('<h1>Картридж Hi-Black HB-CE505X для HP LJ P2055/P2050</h1>', 'HB-CE505X', 'Картридж Hi-Black HB-CE505X'));
});

test('чужой сайт: «нет» по числу или есть/нет — отказ; словесная категория — противоречие для проверки', () => {
  const checks = { total: 3, of: 3, confirmed: 0, failed: 0, unknown: 3, rows: [
    { name: 'Емкость', need: 'Повышенная', verdict: 'unknown' },
    { name: 'Длина', need: 'не менее 400 мм', verdict: 'unknown' },
    { name: 'Интерфейс', need: 'HDMI / USB Type-C', verdict: 'unknown' },
  ] };
  const pages = [{ url: 'https://x.ru/a', domain: 'x.ru', text: '' }];
  const m = mergeMakerChecks(checks, { checks: { rows: [
    { name: 'Емкость', verdict: 'no', found: 'Обычная' },
    { name: 'Длина', verdict: 'no', found: '390 мм' },
    { name: 'Интерфейс', verdict: 'no', found: 'HDMI / VGA' },
  ] } }, pages);
  const by = Object.fromEntries(m.checks.rows.map((r) => [r.name, r.verdict]));
  assert.deepEqual(by, { 'Емкость': 'conflict', 'Длина': 'no', 'Интерфейс': 'no' });
});

test('страница принадлежности («… для TASKalfa 3554ci») — не страница самой модели', () => {
  const { accessoryPage } = require('../server/offers/maker-search');
  assert.ok(accessoryPage('<h1>Опция расширения UG-36 для TASKalfa 3554ci</h1>', '3554ci'));
  assert.ok(!accessoryPage('<h1>МФУ Kyocera TASKalfa 3554ci цветное</h1>', '3554ci'));
  assert.ok(!accessoryPage('<p>без заголовка 3554ci</p>', '3554ci'));
});

test('страница, где модель лишь упомянута (заголовок про принтер), — не страница этой модели', () => {
  const { accessoryPage } = require('../server/offers/maker-search');
  assert.ok(accessoryPage('<h1>Принтер HP LaserJet Pro M402dn</h1><p>картридж CS-CF226X</p>', 'CS-CF226X'));
});

test('ручное подтверждение: с основанием и датой, сверка пересчитывается, «отменить» возвращает как было', async (t) => {
  const { repo, config, offer, llm } = setup(t, { YANDEX_SEARCH_API_KEY: '' });
  const offers = createOfferService({ config, repo, details: {}, llmFactory: () => llm, fetchImpl: world().fetchImpl });
  const a = offer('Клавиатура Defender GK-196L', 'https://shop.ru/a', 500);
  assert.throws(() => offers.confirmRow(a, { name: 'Тип', verdict: 'yes' }), /где нашли/);
  offers.confirmRow(a, { name: 'Тип', verdict: 'yes', source: 'https://defender.ru/gk-196l' });
  const r = offers.confirmRow(a, { name: 'Подсветка', verdict: 'yes', note: 'ответ поставщика 23.10' });
  assert.equal(r.after, 'соответствует');
  const row = repo.getOffer(a).match_checks.rows.find((x) => x.name === 'Тип');
  assert.equal(row.method, 'подтверждено вручную');
  assert.equal(row.source, 'https://defender.ru/gk-196l');
  assert.ok(row.manual.at && row.manual.before.verdict === 'unknown');
  const back = offers.confirmRow(a, { name: 'Подсветка', verdict: 'reset' });
  assert.equal(back.after, 'частично');
  assert.equal(repo.getOffer(a).match_checks.rows.find((x) => x.name === 'Подсветка').verdict, 'unknown');
  // «не подходит» вручную — товар отклонён
  assert.equal(offers.confirmRow(a, { name: 'Подсветка', verdict: 'no', note: 'на фото подсветка RGB' }).after, 'не соответствует');
});
