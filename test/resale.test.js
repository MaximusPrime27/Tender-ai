// Этап 5: режим «Перепродажа» — фильтры товаров, оценка потенциала, ранг возможности, воронка,
// широкий поиск поставщиков. Сеть подменена фикстурами, .env не читается.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { filterReason, resaleReason, loadExclusions } = require('../server/tenders/filters');
const { scoreTenders } = require('../server/tenders/scoring');
const { opportunityRank, confidenceOf, nearestHub, hubDelivery, CONFIRMED_BONUS } = require('../server/tenders/opportunity');
const { queriesFor, siteQuery, modelOf } = require('../server/offers/sources/yandex-search');
const { assessTrust } = require('../server/offers/seller-check');
const { rankOffers } = require('../server/offers/rank');
const { createLlm } = require('../server/llm');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const EX = loadExclusions(baseConfig.RESALE_EXCLUSIONS);
const NOW = new Date('2026-09-17T09:00:00Z');

// ---------- фильтры ----------
test('перепродажа: только поставка товаров, без лицензируемых', () => {
  const r = (t) => resaleReason({ okpd2: [], ktru: [], ...t }, EX);
  assert.equal(r({ title: 'Поставка картриджей', okpd2: ['20.59.12.120'] }), null);
  assert.equal(r({ title: 'Поставка бумаги для офисной техники' }), null, 'без кодов и без признаков услуг — товар');
  assert.equal(r({ title: 'Поставка учебников', okpd2: ['58.11.1'] }), null, 'печатные книги — товар, хотя раздел 58');
  assert.match(r({ title: 'Выполнение работ по ремонту кровли', okpd2: ['43.91.19'] }), /работы или услуги.*43\.91/);
  assert.match(r({ title: 'Оказание услуг по уборке помещений' }), /работы или услуги.*оказание услуг/);
  assert.match(r({ title: 'Поставка лекарственных препаратов', okpd2: ['21.20.10.110'] }), /лекарства.*21\.20/);
  assert.match(r({ title: 'Спирт этиловый 95%', okpd2: ['20.14.75'] }), /алкоголь/);
  assert.match(r({ title: 'Патроны для служебного оружия', okpd2: ['25.40.13'] }), /оружие/);
  assert.equal(r({ title: 'Поставка и монтаж окон', okpd2: ['22.23.14', '43.32.10'] }), null, 'товар с монтажом — решает оценка, а не фильтр');
});

test('перепродажа: без направления — любой товар; с направлением — только его коды и слова', () => {
  const profile = { mode: 'resale', laws: ['44'], regions: [], codes: [], keywords: [], stop_words: [], min_days_to_deadline: 2 };
  const t = { law: '44', title: 'Поставка бумаги', okpd2: ['17.12.14'], ktru: [], price: 100000, deadline_at: '2026-09-25T09:00:00Z' };
  assert.equal(filterReason(t, profile, NOW, { exclusions: EX }), null, 'направление не задано — берём любой товар');
  const it = { ...profile, codes: ['26.20', '26.30'], keywords: ['видеонаблюден', 'коммутатор'] };
  assert.match(filterReason(t, it, NOW, { exclusions: EX }), /не из выбранного направления \(код 17\.12\.14\)/);
  assert.equal(filterReason({ ...t, title: 'Поставка МФУ', okpd2: ['26.20.18.000'] }, it, NOW, { exclusions: EX }), null, 'код из направления');
  assert.equal(filterReason({ ...t, title: 'Поставка камер видеонаблюдения', okpd2: [] }, it, NOW, { exclusions: EX }), null, 'без кода — по слову направления');
  assert.equal(filterReason({ ...t, title: 'Коммутатор управляемый 24 порта', okpd2: ['26.70.13'] }, it, NOW, { exclusions: EX }), null, 'слово направления спасает, даже если код чужой');
  assert.match(filterReason({ ...t, title: 'Поставка молока', okpd2: [] }, it, NOW, { exclusions: EX }), /нет слов направления/);
  assert.match(filterReason({ ...t, law: '223' }, profile, NOW, { exclusions: EX }), /223-ФЗ/);
  assert.match(filterReason({ ...t, okpd2: ['86.10'] }, profile, NOW, { exclusions: EX }), /работы или услуги/);
  assert.match(filterReason(t, { ...profile, codes: ['26.20'], mode: 'profile' }, NOW), /коды 17\.12\.14 не входят/, 'режим по профилю — как раньше');
});

// ---------- оценка потенциала ----------
test('оценка потенциала: промпт перепродажи и mock-ответ resale_score', async () => {
  const seen = [];
  const llm = createLlm('mock');
  const spy = { complete: (req) => { seen.push(req); return llm.complete(req); } };
  const tenders = [
    { number: '1', law: '44', title: 'Поставка бумаги офисной А4', price: 300000, region: 36, okpd2: [], ktru: [] },
    { number: '2', law: '44', title: 'Поставка и монтаж системы видеонаблюдения', price: 900000, region: 36, okpd2: [], ktru: [] },
  ];
  const results = {};
  const r = await scoreTenders({ tenders, profile: { mode: 'resale', regions: [] }, llm: spy, now: NOW, onResult: (t, res) => { results[t.number] = res; } });
  assert.equal(r.scored, 2);
  assert.equal(seen[0].task, 'resale_score');
  assert.match(seen[0].system, /перепродаж/);
  assert.ok(results['1'].score > results['2'].score, 'массовый товар выше, чем поставка с монтажом');
  assert.equal(results['1'].verdict, 'подходит');
});

// ---------- ранг возможности ----------
test('ранг возможности: подтверждённая прибыль → ожидаемая маржа × уверенность → без маржи', () => {
  const confirmed = opportunityRank({ marginPct: 12, confidence: 1, score: 60, confirmed: true });
  const strong = opportunityRank({ marginPct: 30, confidence: 1, score: 60 });
  const weak = opportunityRank({ marginPct: 30, confidence: 0.2, score: 60 });
  const loss = opportunityRank({ marginPct: -5, confidence: 1, score: 90 });
  const unknown = opportunityRank({ marginPct: null, score: 100 });
  const confirmedLoss = opportunityRank({ marginPct: -10, confidence: 1, score: 60, confirmed: true });
  assert.ok(confirmed > CONFIRMED_BONUS && confirmed > strong);
  assert.ok(strong > weak, 'та же маржа, но оценка по 1 контракту — ниже');
  assert.ok(weak > loss && loss > unknown);
  assert.ok(confirmedLoss < loss, 'подтверждённый убыток — вниз');
  assert.equal(confidenceOf([{ weight: 100, contracts: 10 }, { weight: 100, contracts: 0 }]), 0.5);
  assert.equal(confidenceOf([{ weight: 1, contracts: 1 }]), 0.2);
  assert.equal(confidenceOf([]), 0);
});

test('логистика до поиска: ближайший узел поставок', () => {
  const hubs = baseConfig.RESALE_HUBS;
  assert.equal(nearestHub(36, hubs).hub.name, 'Москва', 'Воронеж ближе всего к Москве');
  assert.equal(nearestHub(25, hubs).hub.name, 'Новосибирск', 'Приморье — к Новосибирску');
  assert.equal(nearestHub(77, hubs).km, 0);
  const far = hubDelivery({ region: 25, goodsCost: 100000, hubs, settings: { logistics_pct: 5 } });
  const near = hubDelivery({ region: 50, goodsCost: 100000, hubs, settings: { logistics_pct: 5 } });
  assert.ok(far.cost > near.cost && far.days > near.days);
  assert.equal(nearestHub(null, hubs), null);
});

// ---------- поисковые запросы ----------
test('запросы по ТЗ: модель, характеристики, город заказчика, лимит, без дублей', () => {
  assert.equal(modelOf({ name: 'Картридж Kyocera TK-5240K' }), 'TK-5240K');
  assert.equal(modelOf({ name: 'Бумага А4', characteristics: [{ name: 'Модель', value: 'SvetoCopy' }] }), 'SvetoCopy');
  assert.equal(modelOf({ name: 'Бумага офисная' }), null);
  const item = { name: 'Картридж для принтера', characteristics: [{ name: 'Модель', value: 'TK-5240K' }, { name: 'Цвет', value: 'чёрный' }] };
  const qs = queriesFor(item, 5, { city: 'Воронеж' });
  assert.equal(qs.length, 5);
  assert.equal(new Set(qs).size, 5);
  assert.match(qs[0], /TK-5240K купить$/);
  assert.match(qs[4], /купить Воронеж$/, 'город заказчика попадает в лимит');
  assert.ok(qs.some((q) => /оптом/.test(q)));
  assert.equal(queriesFor(item, 2).length, 2);
  assert.equal(siteQuery(item, 'pulscen.ru'), 'site:pulscen.ru Картридж для принтера TK-5240K');
});

// ---------- проверенные продавцы ----------
test('проверенный продавец: все признаки сразу; в списке — сначала дешевле, при равной цене — надёжнее и ближе', () => {
  const egrul = { found: true, status: 'ACTIVE', registration_date: '2015-01-01' };
  const now = new Date('2026-09-17');
  assert.equal(assessTrust({ inn: '7707083893', egrul, hasInnOnSite: true, govContracts: 2, now }).verified, true);
  assert.equal(assessTrust({ inn: '7707083893', egrul, hasInnOnSite: true, govContracts: 0, now }).verified, false, 'без госконтрактов');
  assert.equal(assessTrust({ inn: '7707083893', egrul: { ...egrul, registration_date: '2025-01-01' }, hasInnOnSite: true, govContracts: 3, now }).verified, false, 'меньше 3 лет');
  assert.equal(assessTrust({ inn: '7707083893', egrul: null, hasInnOnSite: true, govContracts: 3, now }).verified, false, 'нет проверки ЕГРЮЛ');
  assert.equal(assessTrust({ inn: '7707083893', egrul, innFromRegistry: true, govContracts: 1, now }).verified, true, 'ИНН из реестра контрактов');

  const base = { unit_price: 100, total_cost: 1000, match: 'соответствует', trust: 80, in_time: true };
  const { ranked } = rankOffers([
    { ...base, id: 1, total_cost: 900 },
    { ...base, id: 2, verified: true },
    { ...base, id: 3, total_cost: 900, delivery_days: 2 },
    { ...base, id: 4, total_cost: 900, delivery_days: 7 },
  ]);
  assert.deepEqual(ranked.map((o) => o.id), [3, 4, 1, 2], 'дешёвые первыми; среди равных по цене — кто быстрее привезёт; «проверенный», но дороже — после');
});

// ---------- поиск целиком: лимит на домен, B2B, суточный лимит ----------
const XML = (docs) => `<?xml version="1.0"?><yandexsearch><response><results><grouping>${docs.map((u) => `<group><doc><url>${u}</url><domain>${new URL(u).hostname}</domain><title>t</title></doc></group>`).join('')}</grouping></results></response></yandexsearch>`;
const PAGE = '<html><head><script type="application/ld+json">{"@type":"Product","name":"Системный блок Офис Pro (6 ядер)","offers":{"price":"50000"}}</script></head><body>ИНН 7707083893</body></html>';

function start(overrides = {}) {
  const calls = { yandex: [], pages: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const res = (body, type = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'content-type': type } });
    if (u.startsWith('https://searchapi.api.cloud.yandex.net')) {
      const q = JSON.parse(opts.body).query.queryText;
      calls.yandex.push(q);
      const docs = q.startsWith('site:') ? ['https://pulscen.ru/firm/1/item'] : ['https://big-shop.ru/1', 'https://big-shop.ru/2', 'https://big-shop.ru/3', 'https://small.ru/a', 'https://ozon.ru/x', 'https://www.citilink.ru/product/sistemnyy-blok-1'];
      return res(JSON.stringify({ rawData: Buffer.from(XML(docs)).toString('base64') }), 'application/json');
    }
    if (u.startsWith('https://suggestions.dadata.ru')) return res('{"suggestions":[]}', 'application/json');
    if (u.endsWith('/robots.txt')) return res('', 'text/plain', 404);
    calls.pages.push(u);
    return res(PAGE);
  };
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-e5-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, FETCH_MIN_INTERVAL_MS: 0,
    YANDEX_SEARCH_API_KEY: 'k', YANDEX_FOLDER_ID: 'f', DADATA_API_KEY: '', OFFER_SOURCES: 'yandex,b2b',
    SEARCH_MAX_QUERIES_PER_ITEM: 2, SEARCH_MAX_PAGES_PER_ITEM: 20, SEARCH_MAX_PAGES: 100, SEARCH_MAX_PAGES_PER_DOMAIN: 2, ...overrides,
  };
  const s = startServer(config, {
    scheduler: false, log: { log() {}, warn() {}, error() {} }, fetchImpl,
    clock: () => NOW, sourceOverride: createFixtureSource({ dir: FIX }),
  });
  return { s, calls };
}

async function firstGoodsTender(s) {
  await s.sync.run();
  return s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
}

test('поиск: не больше 2 страниц с сайта, маркетплейсы не открываются, B2B через site:', async () => {
  const { s, calls } = start();
  try {
    const id = await firstGoodsTender(s);
    const searchId = s.offers.start(id);
    await s.offers.idle();
    const search = s.repo.getOfferSearch(searchId);
    assert.equal(search.status, 'done', search.error);
    const items = s.repo.getItems(id).length;
    // Заход на главную страницу магазина за контактами — один на сайт (дальше кеш), в счёт страниц товаров не идёт.
    const isHome = (u) => /^https?:\/\/[^/]+\/?$/.test(u);
    // Поиск по кнопке сначала читает ТЗ: файлы документации закупки скачиваются с площадки — это не страницы магазинов.
    const isDocs = (u) => u.includes('zakupki.gov.ru');
    assert.ok(calls.pages.some(isDocs), 'перед поиском прочитана документация закупки');
    assert.ok(search.log.some((l) => /сначала читаю ТЗ/.test(l.text)));
    const productPages = calls.pages.filter((u) => !isHome(u) && !isDocs(u));
    const perItem = productPages.length / items;
    assert.equal(productPages.filter((u) => u.includes('big-shop.ru')).length, 2 * items, 'с big-shop.ru — по 2 страницы на позицию');
    assert.ok(calls.pages.filter((u) => isHome(u) && u.includes('big-shop.ru')).length <= 1, 'за контактами на сайт — не больше одного раза');
    assert.ok(!calls.pages.some((u) => u.includes('ozon.ru')), 'маркетплейс из стоп-списка не открывается');
    assert.ok(calls.pages.some((u) => u.includes('pulscen.ru')), 'страница из B2B-каталога открыта');
    assert.ok(calls.yandex.some((q) => q.startsWith('site:kns.ru ')), `запросы: ${calls.yandex.join(' | ')}`);
    assert.ok(!calls.yandex.some((q) => /site:citilink/.test(q)), 'по розничной сети запросы не тратим');
    assert.ok(!calls.pages.some((u) => u.includes('citilink.ru')), 'страницы крупной розничной сети не открываются');
    assert.ok(search.log.some((l) => /крупные розничные сети не открываю.*citilink\.ru/.test(l.text)));
    assert.ok(!calls.yandex.some((q) => /site:(pulscen|flagma|supl)/.test(q)), 'общие каталоги выключены: платные запросы к ним ничего не давали');
    assert.ok(perItem <= 4, `страниц на позицию: ${perItem}: ${productPages.join(' ')}`);
    assert.ok(search.log.some((l) => /лишних ссылок с уже взятых сайтов/.test(l.text)));
    const status = s.offers.sourcesStatus();
    assert.equal(status.b2b[0], 'КНС', 'первым — поставщик, работающий с организациями');
    assert.ok(!status.b2b.includes('Ситилинк') && status.retail.includes('Ситилинк'), 'розничная сеть — в списке «не открываем», а не среди поставщиков');
    assert.ok(!status.b2b.some((n) => /Пульс цен|Supl\.biz|Flagma/.test(n)), 'сайты, которые не открываются роботу или отдают мусор, выключены');
    assert.ok(status.b2b.includes('ТИНКО'), 'профильные сайты направления тоже в списке');
  } finally {
    s.server.close();
  }
});

test('суточный лимит платных запросов: общий на сервис, потом — только бесплатные источники', async () => {
  const { s, calls } = start({ SEARCH_DAILY_MAX_API_REQUESTS: 2, SEARCH_MAX_QUERIES_PER_ITEM: 5, OFFER_SOURCES: 'contracts,yandex' });
  try {
    const id = await firstGoodsTender(s);
    s.offers.start(id);
    await s.offers.idle();
    assert.equal(calls.yandex.length, 2);
    const second = s.offers.start(id);
    await s.offers.idle();
    assert.equal(calls.yandex.length, 2, 'второй поиск за день уже не тратит запросы');
    const log = s.repo.getOfferSearch(second).log;
    assert.ok(log.some((l) => /суточный лимит/.test(l.text)));
    assert.equal(s.offers.sourcesStatus().yandex_daily_left, 0);
    assert.equal(s.repo.getOfferSearch(second).status, 'done');
  } finally {
    s.server.close();
  }
});

// ---------- воронка ----------
test('воронка: лента по рангу возможности, автопоиск для лучших по марже', async () => {
  const { s } = start({ RESALE_AUTO_SEARCH_PER_SYNC: 2, RESALE_MIN_MARGIN_PCT: 15, OFFER_SOURCES: 'contracts', RESALE_DOCS_PER_SYNC: 0 });
  try {
    await s.sync.run();
    await s.funnel.idle(); // воронка после синхронизации должна закончиться до проверок
    assert.equal(s.repo.getProfile().mode, 'resale', 'режим по умолчанию — перепродажа');
    const ids = s.repo.db.prepare("SELECT id FROM tenders WHERE status = 'scored' ORDER BY id LIMIT 4").all().map((r) => r.id);
    assert.ok(ids.length >= 4, 'в фикстурах достаточно оценённых закупок');
    const fake = (margin) => ({ verdict: margin > 10 ? 'выгодно' : 'на грани', result: { profit: margin * 1000, margin_pct: margin } });
    // Автопоиск платный — только там, где известно, что искать: у позиции есть модель или характеристики.
    // Позиции сохраняем до расчёта: сохранение позиций сбрасывает расчёт, посчитанный по прежним.
    for (const id of [ids[0], ids[1]]) {
      s.repo.saveItems(id, [{ name: 'Картридж HP CF259X', characteristics: [], quantity: 1, unit: 'шт', source: 'notification' }], { source: 'notification' });
    }
    s.repo.saveEconomics(ids[0], { result: fake(40), opportunity: 20, confirmed: false });
    s.repo.saveEconomics(ids[1], { result: fake(25), opportunity: 25, confirmed: false });
    s.repo.saveEconomics(ids[2], { result: fake(12), opportunity: 1012, confirmed: true });
    s.repo.saveEconomics(ids[3], { result: fake(10), opportunity: 10, confirmed: false });

    const feed = s.repo.listTenders({ sort: 'opportunity', limit: 4, nowIso: '2026-01-01T00:00:00.000Z' }).items.map((t) => t.id);
    assert.deepEqual(feed, [ids[2], ids[1], ids[0], ids[3]], 'подтверждённая прибыль первой, дальше по рангу');

    const r = await s.funnel.run();
    assert.deepEqual(r.started.map((x) => x.tenderId), [ids[1], ids[0]], 'автопоиск: маржа ≥ 15%, не подтверждено, по рангу');
    await s.offers.idle?.();
    s.repo.saveItems(ids[3], [{ name: 'Моноблоки', characteristics: [], quantity: 5, unit: 'шт', source: 'notification' }], { source: 'notification' });
    s.repo.saveEconomics(ids[3], { result: fake(30), opportunity: 30, confirmed: false });
    const r2 = await s.funnel.run();
    assert.deepEqual(r2.started, [], 'одно наименование без модели и характеристик — платный поиск не запускаем');

    // доля автопоиска в суточном лимите израсходована — новых платных поисков нет, остаток — на ручные кнопки
    s.repo.saveItems(ids[3], [{ name: 'Картридж HP CE285A', characteristics: [], quantity: 5, unit: 'шт', source: 'notification' }], { source: 'notification' });
    s.repo.saveEconomics(ids[3], { result: fake(30), opportunity: 30, confirmed: false });
    const day = new Date(NOW.getTime() + 3 * 3600000).toISOString().slice(0, 10); // сутки — по часам сервиса (Москва)
    s.repo.setSetting(`usage:yandex:${day}`, 100);
    assert.deepEqual((await s.funnel.run()).started, [], 'потрачено 100 запросов за сутки — автопоиск ждёт следующего дня');
    s.repo.setSetting(`usage:yandex:${day}`, 0);
    assert.deepEqual((await s.funnel.run()).started.map((x) => x.tenderId), [ids[3]], 'маржа 30% ≥ 25% — ищем');
    await s.offers.idle();
    const again = await s.funnel.run();
    assert.equal(again.started.length, 0, 'повторно по тем же закупкам не ищет');
  } finally {
    s.server.close();
  }
});

test('профиль: режим сохраняется и переключает фильтры', async () => {
  const { s } = start();
  try {
    const port = s.server.address().port;
    const put = (body) => fetch(`http://127.0.0.1:${port}/api/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    assert.equal((await put({ mode: 'profile', laws: ['44'] })).mode, 'profile');
    assert.equal((await put({ laws: ['44'] })).mode, 'profile', 'без поля mode режим не сбрасывается');
    assert.equal((await put({ mode: 'resale', laws: ['44'] })).mode, 'resale');
    await s.sync.idle?.();
  } finally {
    s.server.close();
  }
});

test('оценка: битый JSON на большой пачке — пачка делится пополам, остальные закупки не теряются', async () => {
  const mock = createLlm('mock');
  const bad = '99';
  const llm = {
    async complete(req) {
      // Модель «ломается» на любой пачке, где есть закупка bad.
      if (JSON.parse(req.messages[0].content).tenders.some((t) => t.number === bad)) return { text: '{"results": [ битый', usage: {} };
      return mock.complete(req);
    },
  };
  const tenders = Array.from({ length: 8 }, (_, i) => ({ number: i === 5 ? bad : String(i + 1), law: '44', title: 'Поставка бумаги', price: 100000, okpd2: [], ktru: [] }));
  const results = new Map();
  const r = await scoreTenders({ tenders, profile: { mode: 'resale' }, llm, batchSize: 8, now: NOW, onResult: (t, res) => results.set(t.number, res) });
  assert.equal(r.failed, 1, 'потеряна только сбойная закупка');
  assert.equal(r.scored, 7);
  assert.equal(results.get(bad).ok, false);
});

const stdProfile = (enabledIds = null) => {
  const std = require('../server/tenders/directions').loadStandard();
  return { mode: 'resale', directions: std.map((d) => ({ ...d, enabled: !enabledIds || enabledIds.includes(d.id) })) };
};

test('направления: четыре стандартных, отбор по основам слов и кодам, у каждого свои закупки', async () => {
  const { focusReason } = require('../server/tenders/filters');
  const D = require('../server/tenders/directions');
  const std = D.loadStandard();
  assert.deepEqual(std.map((d) => d.id), ['computers', 'network', 'cctv', 'office']);
  for (const d of std) assert.ok(d.codes.length <= 30 && d.keywords.length <= 60 && d.title && d.short, d.id);
  const p = stdProfile();
  const dir = (title, okpd2 = []) => D.tenderDirection({ title, okpd2, ktru: [] }, p);
  const ok = (title, okpd2 = []) => focusReason({ title, okpd2, ktru: [] }, p);
  assert.equal(ok('Поставка системы видеонаблюдения для школы'), null, '«видеонаблюдение» находит «видеонаблюдения»');
  assert.equal(dir('Поставка системы видеонаблюдения для школы'), 'cctv');
  assert.equal(dir('Поставка коммутаторов управляемых'), 'network');
  assert.equal(dir('Поставка оргтехники'), 'office');
  assert.equal(dir('Картриджи для принтеров'), 'office');
  assert.equal(dir('Поставка ноутбуков'), 'computers');
  assert.equal(dir('Поставка проекторов'), 'computers');
  assert.equal(dir('Разработка проекта планировки территории'), null, '«проектор» не превращается в «проект»');
  // точность совпадения: длинный код > слово > общий код класса
  assert.equal(dir('Поставка товара', ['26.20.18.000']), 'office', 'МФУ по коду — оргтехника, хотя класс 26.20 — компьютеры');
  assert.equal(dir('Поставка товара', ['26.20.40.120']), 'office', 'картриджи по коду');
  assert.equal(dir('Поставка товара', ['26.20.15.000']), 'computers');
  assert.equal(dir('Поставка товара', ['26.30.11.110']), 'network', 'коммутационное оборудование по коду');
  assert.equal(dir('Поставка товара', ['26.30.50.110']), 'cctv', 'охранная сигнализация и СКУД — код длиннее общего 26.30');
  assert.equal(dir('Поставка видеорегистратора', ['26.20.21.120']), 'cctv', 'слово точнее общего кода класса');
  assert.equal(dir('Поставка средств СКУД'), 'cctv');
  assert.equal(dir('Преодоление оскудения почв'), null, 'короткое слово ищется целиком');
  assert.match(ok('Поставка продуктов питания', ['10.51.11']), /не из выбранного направления/);
  assert.match(ok('Поставка мебели'), /не из выбранного направления/);
  // выключенное направление закупки не пропускает; включённые — по-прежнему
  const noOffice = stdProfile(['computers', 'network', 'cctv']);
  assert.match(focusReason({ title: 'Картриджи для принтеров', okpd2: [], ktru: [] }, noOffice), /не из выбранного направления/);
  assert.equal(focusReason({ title: 'Поставка коммутаторов', okpd2: [], ktru: [] }, noOffice), null);
  assert.equal(D.tenderDirection({ title: 'Поставка товара', okpd2: ['26.20.18.000'], ktru: [] }, noOffice), 'computers', 'оргтехника выключена — МФУ остаётся в классе 26.20');
  // ни одного включённого — «любой товар»: всё проходит, метка ставится по всем направлениям
  const any = stdProfile([]);
  assert.equal(focusReason({ title: 'Поставка мебели', okpd2: [], ktru: [] }, any), null);
  assert.equal(D.tenderDirection({ title: 'Картриджи', okpd2: [], ktru: [] }, any), 'office');
});

test('направления: метка по составу, слова для лент, коды для загрузки, перенос старого профиля', () => {
  const D = require('../server/tenders/directions');
  const p = stdProfile();
  const mixed = [
    { name: 'Коммутатор управляемый 24 порта', okpd2_code: '26.30.11.110', sum: 300000 },
    { name: 'Картридж HP 305', okpd2_code: '26.20.40.120', sum: 20000 },
    { name: 'Бумага А4', okpd2_code: '17.12.14.110', sum: 80000 },
  ];
  assert.deepEqual(D.itemsShare(mixed, D.enabledOf(p)), { total: 0.8, best: 'network', byDir: { network: 0.75, office: 0.05 } });
  assert.equal(D.tenderDirection({ title: 'Поставка товаров', okpd2: [], ktru: [] }, p, mixed), 'network', 'общее наименование — по деньгам в составе');
  assert.equal(D.tenderDirection({ title: 'Поставка оборудования для системы видеонаблюдения', okpd2: [], ktru: [] }, p, mixed), 'cctv', 'наименование однозначно — верим ему');
  assert.equal(D.tenderDirection({ title: 'Поставка компьютеров и картриджей', okpd2: [], ktru: [] }, p, mixed), 'network', 'в наименовании два направления — решает состав');
  // в ленты площадок — первые слова каждого направления по очереди
  assert.equal(D.searchWordsPerDirection(p), 3);
  assert.deepEqual(D.searchWords(p).slice(0, 5), ['компьютер', 'коммутатор', 'видеонаблюдение', 'картридж', 'ноутбук']);
  assert.equal(D.searchWords(p).length, 12);
  assert.equal(D.searchWords(stdProfile(['cctv'])).length, 5, 'одно направление — пять слов, как раньше');
  assert.ok(D.searchWords(p).every((w) => !w.startsWith('-')));
  // коды для ГосПлана: без кодов, покрытых более коротким
  assert.deepEqual(D.unionCodes(D.enabledOf(p)), ['26.20', '26.30', '26.40.33', '26.70.13', '28.23.2', '20.59.12']);
  // нейросеть видит только своё направление
  assert.deepEqual(D.profileForDirection(p, 'cctv').codes, ['26.40.33', '26.70.13', '26.30.13', '26.30.5', '26.30.6']);
  // старый профиль: прежнее общее направление → включены все четыре; пусто → всё выключено; чужой набор → своё направление
  const old = { codes: ['26.20', '20.59.12', '26.30', '26.40.3', '26.70.13', '28.23', '26.70.16'], keywords: ['видеонаблюдение', 'коммутатор', 'оргтехника', 'МФУ', 'картридж', '-мониторинг'] };
  assert.deepEqual(D.seedDirections(old).map((d) => [d.id, d.enabled]), [['computers', true], ['network', true], ['cctv', true], ['office', true]]);
  assert.ok(D.seedDirections({}).every((d) => !d.enabled));
  const own = D.seedDirections({ codes: ['10.51'], keywords: ['молоко', 'сыр'] });
  assert.deepEqual(own.map((d) => [d.id, d.enabled]), [['custom-legacy', true], ['computers', false], ['network', false], ['cctv', false], ['office', false]]);
  assert.deepEqual(own[0].codes, ['10.51']);
});

test('направление по составу: «канцтовары» с парой картриджей — не наши, закупка оргтехники — наша', () => {
  const { focusShare } = require('../server/tenders/filters');
  const p = stdProfile();
  const stationery = [
    { name: 'Ручки шариковые', okpd2_code: '32.99.12.110', sum: 40000 },
    { name: 'Бумага А4', okpd2_code: '17.12.14.110', sum: 90000 },
    { name: 'Картридж HP 305', okpd2_code: '26.20.40.120', sum: 12000 },
  ];
  assert.equal(focusShare(stationery, p), 0.08);
  const it = [{ name: 'МФУ Pantum M6500', okpd2_code: '26.20.18.000', sum: 120000 }, { name: 'Бумага А4', okpd2_code: '17.12.14.110', sum: 10000 }];
  assert.equal(focusShare(it, p), 0.92);
  assert.equal(focusShare([{ name: 'Коммутатор управляемый', okpd2_code: null, sum: null, unit_price: 50000, quantity: 2 }], p), 1, 'без кода — по наименованию');
  assert.equal(focusShare(it, stdProfile(['cctv'])), 0, 'включено только видеонаблюдение — оргтехника не наша');
  assert.equal(focusShare(stationery, { codes: [], keywords: [] }), null, 'направление не задано');
  // прежний способ — свои коды и слова в полях профиля — работает, когда направления не включены
  assert.equal(focusShare(stationery, { ...stdProfile([]), codes: ['26.20'], keywords: [] }), 0.08);
});

test('B2B-сайты по позиции: профильные по коду/слову, одно место общему каталогу, лимит запросов', () => {
  const { b2bSitesFor } = require('../server/offers/sources/yandex-search');
  const sites = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'stores.json'), 'utf8')).b2b.filter((s) => s.enabled);
  const names = (item, n) => b2bSitesFor(item, sites, n).map((s) => s.site);
  assert.deepEqual(names({ name: 'МФУ Pantum M6500', okpd2_code: '26.20.18.000' }, 3), ['kns.ru', 'xcom-shop.ru', 'regard.ru']);
  assert.deepEqual(names({ name: 'IP-камера видеонаблюдения 4 Мп', okpd2_code: null }, 3), ['tinko.ru', 'luis.ru']);
  assert.deepEqual(names({ name: 'Бумага офисная А4', okpd2_code: '17.12.14.110' }, 3), [], 'не из направления — профильных магазинов нет, платный запрос не тратим');
  // Общий каталог (без кодов и слов), если он есть в списке, получает одно место после профильных.
  const withGeneral = [{ site: 'opt.example' }, ...sites];
  assert.deepEqual(b2bSitesFor({ name: 'МФУ Pantum M6500', okpd2_code: '26.20.18.000' }, withGeneral, 3).map((s) => s.site), ['kns.ru', 'xcom-shop.ru', 'opt.example']);
  assert.deepEqual(b2bSitesFor({ name: 'Бумага офисная А4', okpd2_code: '17.12.14.110' }, withGeneral, 3).map((s) => s.site), ['opt.example']);
  assert.equal(names({ name: 'Коммутатор', okpd2_code: '26.30.11.110' }, 1).length, 1);
  assert.deepEqual(names({ name: 'Коммутатор', okpd2_code: '26.30.11.110' }, 0), []);
});

test('направление: слова-исключения с минусом убирают «мониторинг» и медизделия, в ленты площадок не уходят', () => {
  const { focusReason, focusShare, positiveKeywords } = require('../server/tenders/filters');
  const p = stdProfile();
  assert.match(focusReason({ title: 'Поставка медицинских изделий: Комплект изделий чрескожного мониторинга', okpd2: [], ktru: [] }, p), /исключение/);
  assert.equal(focusReason({ title: 'Поставка мониторов', okpd2: [], ktru: [] }, p), null);
  assert.equal(focusReason({ title: 'Поставка МФУ для медицинского центра', okpd2: [], ktru: [] }, p), null, 'заказчик-медучреждение — не повод отсеять');
  assert.equal(focusShare([{ name: 'Монитор пациента медицинских изделий', okpd2_code: '26.60.12', sum: 100 }, { name: 'Монитор 24"', okpd2_code: '26.20.17.110', sum: 100 }], p), 0.5);
  // исключение действует только в своём направлении: «фильтр» мешает оргтехнике (картридж фильтра), но не компьютерам
  assert.match(focusReason({ title: 'Картридж для фильтра воды', okpd2: [], ktru: [] }, p), /исключение/);
  assert.equal(focusReason({ title: 'Сетевой фильтр для компьютера', okpd2: [], ktru: [] }, p), null);
  // прежний способ со словами профиля
  const legacy = { codes: [], keywords: ['монитор', 'картридж', '-мониторинг'] };
  assert.match(focusReason({ title: 'Услуги мониторинга', okpd2: [], ktru: [] }, legacy), /исключение/);
  assert.ok(positiveKeywords(legacy.keywords).every((w) => !w.startsWith('-')));
});

