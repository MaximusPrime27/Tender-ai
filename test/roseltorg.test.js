// Источник «Росэлторг, коммерческие закупки»: разбор настоящих страниц площадки (сохранены в test/fixtures).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRoseltorgSource, parseSearch, parseProcedure, parseUnitsChunk, moscowDate } = require('../server/sources/roseltorg');
const { createMultiSource } = require('../server/sources/multi');
const { filterReason } = require('../server/tenders/filters');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('Росэлторг: страница поиска → коммерческие закупки с ценой, регионом, заказчиком и сроком', () => {
  const list = parseSearch(fixture('roseltorg-search.html'));
  assert.equal(list.length, 10);
  const t = list[0];
  assert.equal(t.law, 'com');
  assert.equal(t.number, 'B0210261252594/1');
  assert.equal(t.title, 'Закупка картриджей, тонер -картриджей');
  assert.equal(t.price, 85970);
  assert.equal(t.region, 30);
  assert.equal(t.customer_inn, '3023004670');
  assert.match(t.customer_name, /ЮЖНЫЙ ЦЕНТР СУДОСТРОЕНИЯ/);
  assert.equal(t.deadline_at, '2026-10-08T04:59:00.000Z', '08.10.2026 07:59 по Москве');
  assert.equal(t.eis_url, 'https://www.roseltorg.ru/procedure/B0210261252594/1');
  assert.equal(t.section, 'Росэлторг.Бизнес');
  assert.equal(new Set(t.tags).size, t.tags.length, 'метки без повторов');
  assert.ok(list.every((x) => x.law === 'com' && /^B\d+\/\d+$/.test(x.number)));
  assert.equal(moscowDate('09.10.2026 в 18:00'), '2026-10-09T15:00:00.000Z');
});

test('Росэлторг: страница процедуры → позиции с ОКПД2 и количеством; «Показать ещё» — остальные позиции', () => {
  const p = parseProcedure(fixture('roseltorg-procedure.html'));
  assert.equal(p.items.length, 5);
  assert.deepEqual(p.items[0], { name: 'Тонер-картридж CF83A', ktru_code: null, okpd2_code: '26.20.40', characteristics: [], quantity: 8, unit: 'Штука', unit_price: null, sum: null, source: 'notification' });
  assert.deepEqual(p.showMore, { procedure: 'B0210261252594', lot: '1', nextPage: 2, total: 15, perPage: 5 });
  const chunk = JSON.stringify({ html: '<div class="lot-units__item"><div class="lot-unit__col lot-unit__col--1"><div class="lot-unit__name">Драм-картридж DR-2275</div><div class="lot-unit__okpd-name">26.20.40 Блоки</div></div><div class="lot-unit__col lot-unit__col--2"><div class="lot-unit__quantity">3</div><div class="lot-unit__okei">Штука</div></div><div class="lot-unit__col lot-unit__col--3"><div class="lot-unit__no-price">НМЦ не указано</div></div></div>' });
  assert.deepEqual(parseUnitsChunk(chunk).map((i) => [i.name, i.quantity]), [['Драм-картридж DR-2275', 3]]);
});

test('Росэлторг: запросы — коммерческий раздел (первым) и приём заявок; позиции догружаются; пауза между запросами', async () => {
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(String(u));
    const s = String(u);
    if (s.includes('/procedures/search')) return new Response(fixture('roseltorg-search.html'));
    if (s.includes('/ajax/lot-units/')) return new Response(JSON.stringify({ html: '<div class="lot-units__item"><div class="lot-unit__name">Позиция</div><div class="lot-unit__quantity">1</div></div>' }));
    return new Response(fixture('roseltorg-procedure.html'));
  };
  const src = createRoseltorgSource({ fetchImpl, delayMs: 0, maxPages: 1, log: {} });
  const pages = [];
  const r = await src.fetchNew({ profile: { focus_keywords: ['картридж'], price_min: 50000 }, onPage: (p) => pages.push(p.length) });
  const q = new URL(urls[0]);
  assert.equal(q.searchParams.get('query_field'), 'картридж');
  assert.equal(q.searchParams.get('place'), 'com');
  assert.deepEqual(q.searchParams.getAll('source[]'), ['24', '20']);
  assert.deepEqual(q.searchParams.getAll('status[]'), ['0']);
  assert.ok(r.items.every((t) => t.price == null || t.price >= 50000), 'нижняя граница цены из профиля');
  const doc = await src.getDetailsDoc({ law: 'com', number: 'B0210261252594/1' });
  assert.equal(doc.items.length, 5 + 2, 'страница + две догрузки «Показать ещё» (15 позиций по 5)');
  assert.ok(urls.some((u) => u.endsWith('/ajax/lot-units/B0210261252594/1/3')));
  assert.equal(await src.getDetailsDoc({ law: '44', number: '0372200220826000013' }), null, 'закупки ЕИС — не к Росэлторгу');
});

test('несколько источников: закупку отдают источнику её вида; коммерческая не отсеивается, если включена в профиле', async () => {
  const calls = [];
  const gos = { name: 'gosplan', laws: ['44', '223'], getDetailsDoc: async (t) => { calls.push(`gos:${t.number}`); return { gos: true }; } };
  const rt = { name: 'roseltorg', laws: ['com'], getDetailsDoc: async (t) => { calls.push(`rt:${t.number}`); return { items: [] }; } };
  const multi = createMultiSource([gos, rt], { log: {} });
  await multi.getDetailsDoc({ law: 'com', number: 'B1/1' });
  await multi.getDetailsDoc({ law: '44', number: '0123' });
  assert.deepEqual(calls, ['rt:B1/1', 'gos:0123']);

  const t = { law: 'com', title: 'Закупка картриджей', price: 85970, okpd2: [], ktru: [], deadline_at: '2026-12-01T00:00:00Z' };
  const now = new Date('2026-10-02T00:00:00Z');
  assert.equal(filterReason(t, { laws: ['44', '223'] }, now), 'коммерческие закупки исключены в профиле');
  assert.equal(filterReason(t, { laws: ['44', '223', 'com'] }, now), null);
});

test('Росэлторг: разделы 44-ФЗ и 223-ФЗ — номер ЕИС вместо номера процедуры, лоты одной закупки — одна закупка', async () => {
  // та же страница поиска, но номера процедур — как у госзакупок: 19 цифр (44-ФЗ) и 11 цифр (223-ФЗ)
  let n = 0;
  const html44 = fixture('roseltorg-search.html').replace(/procedure-number="B\d+"/g, () => `procedure-number="03583000450260000${String(10 + (n++ % 3))}"`);
  const list = parseSearch(html44, '44');
  assert.ok(list.length >= 1 && list.length <= 3, 'повторы одного номера (лоты) склеены');
  assert.ok(list.every((t) => t.law === '44' && /^\d{19}$/.test(t.number)));
  assert.equal(parseSearch(fixture('roseltorg-search.html'), '44').length, 0, 'номер не ЕИС — в разделе 44-ФЗ не берём');
  const html223 = fixture('roseltorg-search.html').replace(/procedure-number="B\d+"/g, 'procedure-number="32616495569"');
  assert.deepEqual(parseSearch(html223, '223').map((t) => `${t.law} ${t.number}`), ['223 32616495569']);

  // поиск: коммерческий раздел и разделы госзакупок, профиль без 223-ФЗ — его не спрашиваем
  const asked = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    asked.push(u.searchParams.get('place'));
    return new Response(u.searchParams.get('place') === '44fz' ? html44 : fixture('roseltorg-search.html'), { status: 200 });
  };
  const src = createRoseltorgSource({ fetchImpl, delayMs: 0, maxPages: 1, log: { warn() {} } });
  const r = await src.fetchNew({ profile: { focus_keywords: ['картридж'], laws: ['com', '44'] } });
  assert.deepEqual(asked, ['com', '44fz']);
  assert.ok(r.items.some((t) => t.law === '44') && r.items.some((t) => t.law === 'com'));
  // позиции закупки ЕИС площадка не отдаёт — их берёт ГосПлан или ЕИС
  assert.equal(await src.getDetailsDoc(r.items.find((t) => t.law === '44')), null);
});
