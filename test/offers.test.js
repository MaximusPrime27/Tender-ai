// Этап 4: поиск поставщиков. Сеть подменена: поисковый API, страницы магазинов, robots.txt и DaData — фикстуры.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { parseRobots, isAllowed, extractStructured, decode, createPageFetcher, FetchSkipped, htmlToText } = require('../server/offers/fetch-page');
const { extractOffer } = require('../server/offers/extract');
const { checkNumbers, matchOffer, parseRequirement } = require('../server/offers/match');
const { estimateDelivery, distanceKm, regionFromText, regionFromInn } = require('../server/offers/logistics');
const { validInn, innFromText, assessTrust, lookupEgrul } = require('../server/offers/seller-check');
const { rankOffers, isEligible } = require('../server/offers/rank');
const { parseResultsXml, queriesFor } = require('../server/offers/sources/yandex-search');
const { createLlm } = require('../server/llm');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');

// ---------- фикстуры страниц ----------
const PAGE_JSONLD = `<html><head><title>Системный блок</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Системный блок Офис Pro i5 (6 ядер, 12 потоков, 3.9 ГГц)",
"offers":{"@type":"Offer","price":"52 400","priceCurrency":"RUB","availability":"https://schema.org/InStock"}}</script></head>
<body><h1>Системный блок Офис Pro i5</h1><p>Процессор: 6 ядер, 12 потоков, частота 3.9 ГГц, в турбо-режиме до 4.6 ГГц</p><p>Оперативная память: 16 ГБ DDR4 3200 МГц, накопитель 512 ГБ SSD M.2 (PCIe)</p>
<footer>ООО «Компьютерный мир», ИНН 7707083893, г. Москва, ул. Тверская, 1</footer></body></html>`;

const PAGE_TEXT = `<html><body><h1>Системный блок Эконом i3 (4 ядра)</h1>
<p>Цена: 31 990 ₽ за шт. В наличии.</p><p>Процессор 4 ядер, 8 потоков, 3.6 ГГц</p>
<p>Доставка по России от 5 до 7 дней.</p><p>Реквизиты: ИП Иванов, ИНН 500100732259, г. Самара</p></body></html>`;

const PAGE_CAPTCHA = '<html><body>Подтвердите, что вы не робот. captcha</body></html>';

const YANDEX_XML = `<?xml version="1.0"?><yandexsearch><response><results><grouping>
<group><doc><url>https://shop-one.ru/p/office-pro</url><domain>shop-one.ru</domain><title>Системный блок <hlword>Офис</hlword> Pro</title><passages><passage>Купить системный блок</passage></passages></doc></group>
<group><doc><url>https://shop-two.ru/econom</url><domain>shop-two.ru</domain><title>Системный блок Эконом</title></doc></group>
<group><doc><url>https://blocked-shop.ru/item</url><domain>blocked-shop.ru</domain><title>Системный блок</title></doc></group>
<group><doc><url>https://otzovik.com/review</url><domain>otzovik.com</domain><title>Отзывы</title></doc></group>
</grouping></results></response></yandexsearch>`;

const DADATA = {
  7707083893: { suggestions: [{ data: { inn: '7707083893', name: { short_with_opf: 'ООО «Компьютерный мир»' }, state: { status: 'ACTIVE', registration_date: Date.parse('2010-05-01') }, okved: '47.41', address: { value: 'г Москва', data: { city: 'Москва' } } } }] },
  500100732259: { suggestions: [{ data: { inn: '500100732259', name: { short_with_opf: 'ИП Иванов' }, state: { status: 'ACTIVE', registration_date: Date.parse('2026-06-01') }, address: { value: 'г Самара', data: { city: 'Самара' } } } }] },
};

/** Поддельная сеть: поисковый API, robots.txt, страницы, DaData. */
function fakeNet({ yandexCalls = { n: 0 } } = {}) {
  return async (url, opts = {}) => {
    const u = String(url);
    const html = (body, status = 200, type = 'text/html; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type } });
    if (u.startsWith('https://searchapi.api.cloud.yandex.net')) {
      yandexCalls.n++;
      assert.match(opts.headers.Authorization, /^Api-Key /);
      return html(JSON.stringify({ rawData: Buffer.from(YANDEX_XML).toString('base64') }), 200, 'application/json');
    }
    if (u.startsWith('https://suggestions.dadata.ru')) {
      const inn = JSON.parse(opts.body).query;
      return html(JSON.stringify(DADATA[inn] || { suggestions: [] }), 200, 'application/json');
    }
    if (u.endsWith('/robots.txt')) return u.includes('shop-two') ? html('User-agent: *\nDisallow: /admin', 200, 'text/plain') : html('', 404);
    if (u.startsWith('https://shop-one.ru/')) return html(PAGE_JSONLD);
    if (u.startsWith('https://shop-two.ru/')) return html(PAGE_TEXT);
    if (u.startsWith('https://blocked-shop.ru/')) return html(PAGE_CAPTCHA);
    return html('not found', 404);
  };
}

// ---------- модули ----------
test('robots.txt: самое длинное правило, звёздочки, группа для всех роботов', () => {
  const rules = parseRobots('User-agent: Yandex\nDisallow: /\n\nUser-agent: *\nAllow: /*?page=\nDisallow: *?*\nDisallow: /search');
  assert.equal(isAllowed(rules, '/product/1'), true);
  assert.equal(isAllowed(rules, '/catalog?search=x'), false);
  assert.equal(isAllowed(rules, '/catalog?page=2'), true);
  assert.equal(isAllowed(rules, '/search/abc'), false);
});

test('загрузка: windows-1251, разметка schema.org, текст без скриптов', () => {
  const buf = Buffer.from(new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])); // «Привет» в windows-1251
  assert.equal(decode(buf, 'text/html; charset=windows-1251'), 'Привет');
  const s = extractStructured(PAGE_JSONLD, 'https://x/');
  assert.equal(s[0].price, 52400);
  assert.equal(s[0].availability, 'InStock');
  assert.doesNotMatch(htmlToText('<p>a</p><script>var x=1</script><p>b&nbsp;&laquo;c&raquo;</p>'), /var x/);
});

test('загрузка: запрет robots.txt и капча → страница пропускается с причиной', async () => {
  const f = createPageFetcher({ minIntervalMs: 0, fetchImpl: async (u) => (String(u).endsWith('/robots.txt')
    ? new Response('User-agent: *\nDisallow: /search', { status: 200 })
    : new Response(PAGE_CAPTCHA, { status: 200, headers: { 'content-type': 'text/html' } })) });
  await assert.rejects(f.fetchPage('https://s.ru/search?q=1'), (e) => e instanceof FetchSkipped && /robots/.test(e.message) && !e.closed, 'robots.txt — про страницу, не про весь сайт');
  await assert.rejects(f.fetchPage('https://s.ru/product/1'), (e) => e instanceof FetchSkipped && /не робот/.test(e.message) && e.closed);
});

test('загрузка: 401/403/498 — сайт закрыт целиком (запоминаем), 429 и 503 — временно', async () => {
  for (const [status, closed] of [[401, true], [403, true], [498, true], [429, false], [503, false]]) {
    const f = createPageFetcher({ minIntervalMs: 0, fetchImpl: async (u) => (String(u).endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response('x', { status })) });
    await assert.rejects(f.fetchPage('https://s.ru/p/1'), (e) => e instanceof FetchSkipped && e.closed === closed, `HTTP ${status}`);
  }
});

test('извлечение: цена из разметки, ИНН со страницы; без разметки — правилами (заголовок и цена рядом)', async () => {
  const item = { name: 'Системный блок', characteristics: [] };
  const a = await extractOffer({ url: 'https://a', html: PAGE_JSONLD, text: htmlToText(PAGE_JSONLD), structured: extractStructured(PAGE_JSONLD, 'https://a') }, item);
  assert.equal(a.price, 52400);
  assert.equal(a.extracted_by, 'разметка страницы');
  assert.equal(a.seller_inn, '7707083893');
  assert.equal(a.seller_inn_on_site, true);
  const b = await extractOffer({ url: 'https://b', html: PAGE_TEXT, text: htmlToText(PAGE_TEXT), structured: [] }, item, { llm: createLlm('mock'), system: 'offer' });
  assert.equal(b.price, 31990);
  assert.equal(b.extracted_by, 'правила');
  assert.equal(b.seller_inn, '500100732259');
  assert.equal(b.delivery_days, 7);
});

test('фасовка: цена за упаковку пересчитывается в цену за единицу заказчика', async () => {
  const page = { url: 'https://c', text: 'Ручка шариковая, упаковка 10 шт — 150 ₽', structured: [{ title: 'Ручка шариковая синяя (10 шт в упаковке)', price: 150 }] };
  const o = await extractOffer(page, { name: 'Ручка шариковая' });
  assert.equal(o.pack_qty, 10);
});

test('сверка с ТЗ: числа проверяются строго', async () => {
  assert.deepEqual(parseRequirement('не менее 6 шт'), { min: 6, minStrict: false });
  const chars = [{ name: 'Количество ядер процессора', value: 'не менее 6 шт' }, { name: 'Частота процессора базовая', value: 'не менее 3.6 ГГц' }];
  assert.equal(checkNumbers(chars, 'Процессор: 6 ядер, 3.9 ГГц').fail.length, 0);
  const freq = [{ name: 'Частота процессора максимальная', value: 'не менее 4.2 ГГц' }];
  assert.deepEqual(checkNumbers(freq, 'базовая 3.9 ГГц, турбо до 4.6 ГГц').fail, [], 'для «максимальной» берётся наибольшая частота');
  assert.deepEqual(checkNumbers(freq, 'частота 3.9 ГГц').unknown, ['Частота процессора максимальная'], 'одно число при уточнении — неоднозначно');
  const bad = await matchOffer({ name: 'Системный блок', characteristics: chars }, { title: 'Системный блок Эконом', text: 'Процессор 4 ядер, 3.6 ГГц' });
  assert.equal(bad.match, 'не соответствует');
  assert.match(bad.notes[0], /нужно не менее 6 шт, у товара 4/);
});

test('логистика: расстояние, срок, «не успеваем», регион по адресу и ИНН', () => {
  assert.ok(Math.abs(distanceKm(77, 54) - 2811) < 30);
  assert.equal(regionFromText('443091, САМАРСКАЯ ОБЛАСТЬ, Г САМАРА'), 63);
  assert.equal(regionFromInn('5249185655'), 52);
  const far = estimateDelivery({ sellerRegion: 77, customerRegion: 54, goodsCost: 500000, deliveryTermDays: 10, logisticsPct: 5 });
  assert.equal(far.in_time, false);
  const near = estimateDelivery({ sellerRegion: 77, customerRegion: 50, goodsCost: 100000, deliveryTermDays: 10, logisticsPct: 5 });
  assert.equal(near.in_time, true);
  assert.equal(near.delivery_cost, 2500);
  const own = estimateDelivery({ sellerRegion: 77, customerRegion: 54, goodsCost: 1, sellerDeliveryDays: 3, sellerDeliveryCost: 900, deliveryTermDays: 10 });
  assert.deepEqual([own.delivery_days, own.delivery_cost, own.in_time, own.estimated], [3, 900, true, false]);
});

test('продавец: ИНН, ЕГРЮЛ через DaData, доверие с причинами', async () => {
  assert.equal(validInn('7707083893'), true);
  assert.equal(validInn('7707083894'), false);
  assert.equal(innFromText('Реквизиты: ИНН 7707083894, ИНН: 7707083893'), '7707083893');
  const egrul = await lookupEgrul('7707083893', { apiKey: 'k', fetchImpl: fakeNet() });
  assert.equal(egrul.status, 'ACTIVE');
  assert.ok(assessTrust({ inn: '7707083893', egrul, hasInnOnSite: true }).trust >= 80);
  const young = assessTrust({ inn: '1', egrul: { found: true, status: 'ACTIVE', registration_date: '2026-06-01' }, hasInnOnSite: true, now: new Date('2026-09-19') });
  assert.ok(young.reasons.some((r) => /меньше года/.test(r)));
  const cheap = assessTrust({ inn: null, price: 10, medianPrice: 100 });
  assert.ok(cheap.trust < 30 && cheap.reasons.some((r) => /подозрительно дёшево/.test(r)));
  assert.equal(assessTrust({ inn: 'x', decision: 'blocked' }).trust, 0);
});

test('ранжирование: соответствует > успевает > магазин раньше госконтракта > цена; лучшее — самое дешёвое подходящее', () => {
  const offers = [
    { id: 1, unit_price: 100, total_cost: 1000, in_time: false, match: 'соответствует', trust: 90 },
    { id: 2, unit_price: 120, total_cost: 1200, in_time: true, match: 'частично', trust: 90 },
    { id: 3, unit_price: 110, total_cost: 1100, in_time: true, match: 'соответствует', trust: 90 },
    { id: 4, unit_price: 90, total_cost: 900, in_time: true, match: 'соответствует', trust: 20 },
    { id: 5, unit_price: null, match: 'соответствует' },
    { id: 6, unit_price: 50, total_cost: 500, in_time: true, match: 'не соответствует', trust: 90 },
    { id: 7, unit_price: 40, total_cost: 400, in_time: true, match: 'соответствует', trust: 90, seller_decision: 'blocked' },
  ];
  const r = rankOffers(offers);
  assert.deepEqual(r.ranked.map((o) => o.id), [4, 3, 1, 2], 'подходящие по ТЗ — по цене; не успевающий — после успевающих; «частично» — в конце');
  assert.equal(r.best.id, 4, 'самое дешёвое подходящее — даже если доверие к продавцу низкое');
  // настоящее предложение магазина раньше более дешёвой цены прошлого госконтракта
  const mix = rankOffers([
    { id: 10, source: 'contracts', unit_price: 50, total_cost: 500, in_time: true, match: 'соответствует', trust: 90 },
    { id: 11, source: 'yandex', unit_price: 80, total_cost: 800, in_time: true, match: 'соответствует', trust: 40 },
    { id: 12, source: 'yandex', unit_price: 70, total_cost: 700, in_time: true, match: 'соответствует', trust: 30 },
  ]);
  assert.deepEqual(mix.ranked.map((o) => o.id), [12, 11, 10]);
  assert.equal(mix.best.id, 12);
  assert.equal(rankOffers([{ id: 13, source: 'contracts', unit_price: 50, total_cost: 500, match: 'соответствует' }]).best, null, 'магазинов нет — цена конкурента из госконтракта закупочной не становится');
  assert.equal(isEligible({ source: 'contracts', unit_price: 50, match: 'соответствует', in_time: true }), false);
  // срок доставки неизвестен — дешёвое предложение всё равно первое; точно не успевающее — не выбирается
  const time = rankOffers([
    { id: 20, source: 'yandex', unit_price: 1250, total_cost: 16500, in_time: true, match: 'соответствует' },
    { id: 21, source: 'yandex', unit_price: 329, total_cost: 5448, in_time: null, match: 'соответствует' },
    { id: 22, source: 'yandex', unit_price: 100, total_cost: 1200, in_time: false, match: 'соответствует' },
  ]);
  assert.deepEqual(time.ranked.map((o) => o.id), [21, 20, 22]);
  assert.equal(time.best.id, 21);
  assert.deepEqual(r.rejected.map((x) => x.offer.id), [5, 6]);
  assert.equal(r.hidden, 1);
});

test('поисковый API: разбор XML-выдачи и запросы по позиции', () => {
  const docs = parseResultsXml(YANDEX_XML);
  assert.equal(docs.length, 4);
  assert.equal(docs[0].title, 'Системный блок Офис Pro');
  const qs = queriesFor({ name: 'Системный блок', characteristics: [{ name: 'Ядра', value: 'не менее 6 шт' }] });
  assert.equal(qs.length, 3);
  assert.match(qs[0], /Системный блок 6 ядер купить цена/, '«6 шт» без названия характеристики поисковику ничего не говорит — «6 ядер»');
});

// ---------- поиск целиком ----------
function start(overrides = {}) {
  const yandexCalls = { n: 0 };
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-e4-')), PORT: 0, TENDER_SOURCE: 'fixture',
    TELEGRAM_BOT_TOKEN: '', ECONOMICS_MAX_PER_SYNC: 0, FETCH_MIN_INTERVAL_MS: 0,
    YANDEX_SEARCH_API_KEY: 'test-key', YANDEX_FOLDER_ID: 'folder', DADATA_API_KEY: 'dadata-key',
    OFFER_SOURCES: 'contracts,yandex,manual', OFFER_DOMAIN_BLOCKLIST: 'otzovik.com', SEARCH_MAX_QUERIES_PER_ITEM: 3, ...overrides,
  };
  const s = startServer(config, {
    scheduler: false, log: { log() {}, warn() {}, error() {} }, fetchImpl: fakeNet({ yandexCalls }),
    clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: FIX }),
  });
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, {
      method: opts.method, headers: opts.json ? { 'Content-Type': 'application/json' } : undefined, body: opts.json ? JSON.stringify(opts.json) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { s, api, yandexCalls };
}

async function tenderWithBenchmark(s, api) {
  await s.sync.run();
  const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
  await api(`/api/tenders/${id}`);
  await s.details.idle();
  // срок поставки по контракту — 30 дней (как если бы пользователь уточнил его в калькуляторе)
  await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { delivery_days: 30 } });
  return id;
}

test('поиск поставщиков: источники, сверка, доставка, ЕГРЮЛ, лучшее предложение в калькуляторе', async () => {
  const { s, api, yandexCalls } = start();
  try {
    const id = await tenderWithBenchmark(s, api);
    const r = await api(`/api/tenders/${id}/offers/search`, { method: 'POST' });
    assert.equal(r.status, 202);
    await s.offers.idle();

    const search = (await api(`/api/offer-searches/${r.body.searchId}`)).body;
    assert.equal(search.status, 'done', search.error);
    // Три запроса по ТЗ и до двух — по товарам, которые уже поставляли по госконтрактам (с производителем).
    const queries = search.log.filter((l) => l.text.startsWith('Поиск «')).map((l) => l.text);
    // плюс один — маркетплейсы для позиции, где подходящего товара с ценой не нашлось
    assert.ok(yandexCalls.n >= 3 && yandexCalls.n <= 6, `запросов к поисковому API: ${yandexCalls.n}`);
    assert.ok(queries.some((q) => q.includes('Системный блок БЕШТАУ купить')), queries.join(' // '));
    assert.ok(search.log.some((l) => l.level === 'skip' && /blocked-shop\.ru: .*не робот/.test(l.text)));
    assert.ok(!search.log.some((l) => /otzovik/.test(l.text)), 'домен из стоп-списка не открывается');

    const { groups } = (await api(`/api/tenders/${id}/offers`)).body;
    const g = groups[0];
    const byDomain = Object.fromEntries(g.ranked.concat(g.rejected.map((x) => x.offer)).map((o) => [o.domain || o.source, o]));
    const one = byDomain['shop-one.ru'];
    assert.equal(one.unit_price, 52400);
    assert.equal(one.seller_inn, '7707083893');
    assert.ok(one.trust >= 80);
    assert.equal(one.total_cost, 52400 * 12 + one.delivery_cost);
    const two = g.rejected.find((x) => x.offer.domain === 'shop-two.ru');
    assert.ok(two, 'товар с 4 ядрами вместо 6 — в отложенных');
    assert.match(two.reason, /не соответствует ТЗ/);
    // победители прошлых госконтрактов — отдельным списком «конкуренты»: с пометкой, кто это, и не среди «где купить»
    assert.ok(g.ranked.every((o) => o.source !== 'contracts'));
    const rival = g.competitors.find((o) => o.seller_inn === '5249185655');
    assert.ok(rival, 'конкуренты из госконтрактов — в своём списке');
    assert.ok(['maker', 'profile', 'trade', 'reseller', 'unknown'].includes(rival.seller_kind.kind) && rival.seller_kind.title && rival.seller_kind.note);
    assert.notEqual(g.selected_offer_id, rival.id, 'цена конкурента в расчёт как закупочная не идёт');

    // В ТЗ системного блока 45 требований; страница магазина подтверждает 9 и ни одному не противоречит —
    // это «частично»: сервис показывает, что именно подтверждено, но сам такое предложение в расчёт не берёт.
    assert.equal(one.match, 'частично');
    assert.deepEqual([one.match_checks.confirmed, one.match_checks.failed, one.match_checks.total], [9, 0, 45]);
    // «Ширина корпуса: менее 200 мм» не подтверждена: про корпус на странице ничего нет, а «200» внутри «3200 МГц» — не оно.
    assert.equal(one.match_checks.rows.find((r) => r.name === 'Ширина корпуса').verdict, 'unknown');
    assert.ok(one.match_checks.rows.some((r) => r.name === 'Количество ядер процессора' && r.verdict === 'yes' && r.found === '6'));
    assert.match(one.match_notes[0], /подтверждено 9 из 45 требований, противоречий нет/);
    assert.equal(g.selected_offer_id, null, 'неполностью подтверждённый товар сам в расчёт не идёт');
    let card = (await api(`/api/tenders/${id}`)).body;
    assert.equal(card.items[0].purchase_selected_by, null);

    // Пользователь уточнил остальное у поставщика и выбрал предложение сам — оно идёт в расчёт.
    assert.equal((await api(`/api/offers/${one.id}/select`, { method: 'POST', json: {} })).status, 200);
    card = (await api(`/api/tenders/${id}`)).body;
    assert.equal(card.items[0].purchase_selected_by, 'user');
    assert.equal(card.economics.result.inputs.items[0].purchase_source, 'поиск поставщиков');
    assert.match(card.economics.result.inputs.sources.logistics, /доставка выбранных предложений/);

    // Простое ТЗ (три требования, все подтверждаются страницей) — «соответствует» и выбирается автоматически.
    s.repo.db.prepare('UPDATE tender_items SET characteristics_json = ?, spec_json = NULL, purchase_offer_id = NULL, purchase_selected_by = NULL WHERE id = ?')
      .run(JSON.stringify([{ name: 'Количество ядер процессора', value: 'не менее 6 шт' }, { name: 'Объем установленной оперативной памяти', value: 'не менее 8 Гбайт' }, { name: 'Тип оперативной памяти', value: 'DDR4' }]), card.items[0].id);
    s.offers.start(id, { auto: true });
    await s.offers.idle();
    const again = (await api(`/api/tenders/${id}/offers`)).body.groups[0];
    const best = again.ranked.find((o) => o.domain === 'shop-one.ru');
    assert.equal(best.match, 'соответствует');
    assert.equal(again.selected_offer_id, best.id);
    assert.equal((await api(`/api/tenders/${id}`)).body.items[0].purchase_selected_by, 'auto');
  } finally {
    await s.close();
  }
});

test('выбор вручную, блокировка продавца и ручное предложение', async () => {
  const { s, api } = start();
  try {
    const id = await tenderWithBenchmark(s, api);
    await api(`/api/tenders/${id}/offers/search`, { method: 'POST' });
    await s.offers.idle();
    let groups = (await api(`/api/tenders/${id}/offers`)).body.groups;
    // конкурента выбрать нельзя: его цена — цена продажи заказчику, а не закупочная
    const rival = groups[0].competitors[0];
    const refused = await api(`/api/offers/${rival.id}/select`, { method: 'POST', json: {} });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /конкурент/);
    assert.notEqual((await api(`/api/tenders/${id}/offers`)).body.groups[0].selected_offer_id, rival.id);
    // второй настоящий вариант — своё предложение от другого продавца
    const itemId0 = (await api(`/api/tenders/${id}`)).body.items[0].id;
    await api(`/api/tenders/${id}/offers`, { method: 'POST', json: { item_id: itemId0, price: 51000, seller_name: 'ИП Иванов', seller_inn: '500100732259', seller_city: 'Самара' } });
    groups = (await api(`/api/tenders/${id}/offers`)).body.groups;
    const other = groups[0].ranked.find((o) => o.id !== groups[0].selected_offer_id);
    assert.ok(other, 'есть второе предложение, у которого можно купить');
    groups = (await api(`/api/offers/${other.id}/select`, { method: 'POST', json: {} })).body.groups;
    assert.equal(groups[0].selected_offer_id, other.id);
    assert.equal(groups[0].selected_by, 'user');

    // «Не работаем» — продавец скрыт, выбор переходит на следующее предложение
    const d = await api(`/api/sellers/${other.seller_inn}/decision`, { method: 'POST', json: { decision: 'blocked' } });
    assert.equal(d.status, 200);
    groups = (await api(`/api/tenders/${id}/offers`)).body.groups;
    assert.ok(!groups[0].ranked.some((o) => o.seller_inn === other.seller_inn));
    assert.ok(groups[0].hidden >= 1);
    assert.notEqual(groups[0].selected_offer_id, other.id);

    // ручное предложение без ссылки
    const itemId = (await api(`/api/tenders/${id}`)).body.items[0].id;
    const m = await api(`/api/tenders/${id}/offers`, { method: 'POST', json: { item_id: itemId, price: 45000, seller_name: 'Мой поставщик', seller_inn: '7707083893', seller_city: 'Москва', delivery_days: 3, delivery_cost: 5000 } });
    assert.equal(m.status, 201);
    assert.equal(m.body.offer.source, 'manual');
    assert.equal(m.body.offer.delivery_cost, 5000);
    assert.equal((await api(`/api/tenders/${id}/offers`, { method: 'POST', json: { item_id: itemId } })).status, 400);
    assert.equal((await api('/api/sellers/123/decision', { method: 'POST', json: { decision: 'blocked' } })).status, 400);
  } finally {
    await s.close();
  }
});

test('лимит запросов к поисковому API останавливает поиск с понятным сообщением; без ключей — подсказка', async () => {
  const { s, api, yandexCalls } = start({ SEARCH_MAX_API_REQUESTS: 1, SEARCH_API_PER_ITEM: 0 });
  try {
    const id = await tenderWithBenchmark(s, api);
    const { searchId } = (await api(`/api/tenders/${id}/offers/search`, { method: 'POST' })).body;
    await s.offers.idle();
    const search = (await api(`/api/offer-searches/${searchId}`)).body;
    assert.equal(yandexCalls.n, 1);
    assert.match(search.error, /лимит запросов к поисковому API/);
  } finally {
    await s.close();
  }
  const noKeys = start({ YANDEX_SEARCH_API_KEY: '', DADATA_API_KEY: '' });
  try {
    const id = await tenderWithBenchmark(noKeys.s, noKeys.api);
    const { searchId } = (await noKeys.api(`/api/tenders/${id}/offers/search`, { method: 'POST' })).body;
    await noKeys.s.offers.idle();
    const search = (await noKeys.api(`/api/offer-searches/${searchId}`)).body;
    assert.equal(search.status, 'done');
    assert.ok(search.log.some((l) => /YANDEX_SEARCH_API_KEY/.test(l.text)));
    const payload = (await noKeys.api(`/api/tenders/${id}/offers`)).body;
    assert.equal(payload.sources.yandex, 'no_key');
    assert.equal(payload.groups[0].ranked.length, 0, 'без ключа поиска магазинов нет');
    assert.ok(payload.groups[0].competitors.length > 0 && payload.groups[0].competitors.every((o) => o.source === 'contracts'), 'без ключей видны конкуренты из прошлых госконтрактов');
    assert.equal(payload.groups[0].competitors[0].seller_kind.kind, 'unknown', 'без проверки по ЕГРЮЛ — кто это, неизвестно');
  } finally {
    await noKeys.s.close();
  }
});

test('сверка: в ТЗ только наименование «Моноблоки» — любой моноблок не «соответствует»; с моделью — соответствует', async () => {
  const { matchOffer } = require('../server/offers/match');
  const bare = await matchOffer({ name: 'Моноблоки', characteristics: [] }, { title: 'Моноблок Digma Action 24 (DM23N9-8CXW01)', text: 'Моноблок 23.8"' });
  assert.equal(bare.match, 'не хватает данных');
  assert.match(bare.notes.join(' '), /только наименование/);
  const model = await matchOffer({ name: 'Картридж HP CF259X', characteristics: [] }, { title: 'Картридж HP CF259X чёрный', text: 'оригинал' });
  assert.equal(model.match, 'соответствует');
});

test('извлечение: страница каталога и цена не в рублях — не предложение; товар с нужной моделью в каталоге — берём', async () => {
  const prod = (title, price, currency = 'RUB') => ({ title, price, currency, url: 'https://s/p' });
  const listing = { url: 'https://s/catalog/monobloki/', text: '', structured: [prod('Моноблок A', 88704), prod('Моноблок B', 90000), prod('Моноблок C', 95000), prod('Моноблок D', 99000)] };
  await assert.rejects(extractOffer(listing, { name: 'Моноблоки', characteristics: [] }), (e) => e instanceof FetchSkipped && /каталога/.test(e.message));
  const withModel = { ...listing, structured: [...listing.structured, prod('Моноблок Dell OptiPlex 7410 Plus', 125690)] };
  const o = await extractOffer(withModel, { name: 'Моноблок', characteristics: [{ name: 'Модель', value: 'OptiPlex 7410' }] });
  assert.equal(o.price, 125690);
  assert.equal(o.url, 'https://s/p', 'товар нашёлся на странице каталога — ссылка на сам товар, а не на каталог');
  const uz = { url: 'https://texnostar.uz/p/1', text: '', structured: [prod('Моноблок Dell OptiPlex 5490', 8200000, 'UZS')] };
  await assert.rejects(extractOffer(uz, { name: 'Моноблоки', characteristics: [] }), (e) => e instanceof FetchSkipped && /не в рублях/.test(e.message));
  const { foreignDomain } = require('../server/offers/fetch-page');
  assert.ok(foreignDomain('texnostar.uz') && foreignDomain('shop.kz') && !foreignDomain('kns.ru') && !foreignDomain('chipcart.shop'));
});

test('разметка «цена от … до …» по разделу каталога — не цена товара', async () => {
  const html = '<script type="application/ld+json">{"@type":"Product","name":"Моноблоки","offers":{"@type":"AggregateOffer","lowPrice":"88704","highPrice":"912000","priceCurrency":"RUB","offerCount":"312"}}</script>';
  const structured = extractStructured(html, 'https://s/catalog/monobloki/');
  assert.equal(structured[0].range, true);
  await assert.rejects(extractOffer({ url: 'https://s/catalog/monobloki/', text: '', structured }, { name: 'Моноблоки', characteristics: [] }), (e) => e instanceof FetchSkipped && /каталога/.test(e.message));
  const one = extractStructured('<script type="application/ld+json">{"@type":"Product","name":"Моноблок X","offers":{"@type":"Offer","price":"52400","priceCurrency":"RUB"}}</script>', 'https://s/p');
  assert.equal(one[0].range, false);
});

test('товар поставщика по госконтракту — на его сайте: прямая ссылка и цена; без своего сайта не ищем', async () => {
  const { s, api, yandexCalls } = start();
  try {
    const id = await tenderWithBenchmark(s, api);
    const item = s.repo.getItems(id)[0];
    const mk = (contacts, title = 'Системный блок. Товарный знак: Офис Pro') => s.repo.insertOffer({ tender_id: id, item_id: item.id, source: 'contracts', title, price: 50000, unit_price: 50000, pack_qty: 1,
      seller_name: 'ООО «Компьютерный мир»', seller_inn: '7707083893', match: 'соответствует', match_notes: [], contacts });
    // сайт известен по почте на собственном домене
    const withSite = mk({ phones: [], emails: ['sale@shop-one.ru'], site: null });
    const before = yandexCalls.n;
    const r = await api(`/api/offers/${withSite}/product`, { method: 'POST' });
    assert.equal(r.body.found, true, r.body.reason);
    assert.equal(r.body.url, 'https://shop-one.ru/p/office-pro');
    assert.equal(r.body.price, 52400);
    assert.equal(yandexCalls.n - before, 1, 'один запрос «site:домен товар»');
    const saved = s.repo.getOffer(withSite);
    assert.equal(saved.product_url, 'https://shop-one.ru/p/office-pro');
    assert.ok(saved.product_checked_at);

    // почта на Яндексе — сайта нет, платный запрос не тратим
    const noSite = mk({ phones: ['+7 (812) 123-45-67'], emails: ['zakaz@yandex.ru'], site: null });
    const n2 = yandexCalls.n;
    const r2 = await api(`/api/offers/${noSite}/product`, { method: 'POST' });
    assert.equal(r2.body.found, false);
    assert.match(r2.body.reason, /нет своего сайта/);
    assert.equal(yandexCalls.n, n2);

    // по закупке целиком: только ещё не проверенные, у кого есть сайт
    mk({ phones: [], emails: [], site: 'https://shop-one.ru' });
    const all = await api(`/api/tenders/${id}/products`, { method: 'POST' });
    assert.equal(all.body.checked, 1);
    assert.equal(all.body.found, 1);
    assert.equal((await api(`/api/tenders/${id}/products`, { method: 'POST' })).body.checked, 0, 'повторно не ищем');
  } finally {
    s.server.close();
  }
});

test('товар на сайте поставщика — бесплатно по карте сайта: страница с моделью в адресе, без запроса к поисковику', async () => {
  const { findInSitemap } = require('../server/offers/sitemap');
  const pages = {
    'https://shop.ru/robots.txt': 'User-agent: *\nSitemap: https://shop.ru/sitemap.xml',
    'https://shop.ru/sitemap.xml': '<sitemapindex><sitemap><loc>https://shop.ru/sitemap-news.xml</loc></sitemap><sitemap><loc>https://shop.ru/sitemap-products.xml</loc></sitemap><sitemap><loc>https://shop.ru/big.xml.gz</loc></sitemap></sitemapindex>',
    'https://shop.ru/sitemap-news.xml': '<urlset><url><loc>https://shop.ru/news/1</loc></url></urlset>',
    'https://shop.ru/sitemap-products.xml': '<urlset><url><loc>https://shop.ru/catalog/kartridzhi/kartridzh-hp-cf259x-chernyj/</loc></url><url><loc>https://shop.ru/catalog/kartridzhi/kartridzh-hp-cf259x-chernyj/reviews/</loc></url><url><loc>https://shop.ru/catalog/kartridzh-hp-ce285a/</loc></url></urlset>',
  };
  const asked = [];
  const fetchImpl = async (u) => { asked.push(String(u)); const b = pages[String(u)]; return b ? new Response(b) : new Response('', { status: 404 }); };
  const urls = await findInSitemap('shop.ru', 'CF259X', { fetchImpl, log: {} });
  assert.deepEqual(urls, ['https://shop.ru/catalog/kartridzhi/kartridzh-hp-cf259x-chernyj/', 'https://shop.ru/catalog/kartridzhi/kartridzh-hp-cf259x-chernyj/reviews/']);
  assert.equal(asked.indexOf('https://shop.ru/sitemap-products.xml') < asked.indexOf('https://shop.ru/sitemap-news.xml'), true, 'карта каталога — первой');
  assert.ok(!asked.includes('https://shop.ru/big.xml.gz'), 'сжатые карты не качаем');
  assert.deepEqual(await findInSitemap('shop.ru', 'TK-5240K', { fetchImpl, log: {} }), [], 'модели на сайте нет');
  assert.deepEqual(await findInSitemap('shop.ru', 'A4', { fetchImpl, log: {} }), [], 'слишком короткая «модель» — не ищем');
  assert.deepEqual(await findInSitemap('nosite.ru', 'CF259X', { fetchImpl, log: {} }), [], 'карты сайта нет');
});
