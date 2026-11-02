const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizePurchase, attachmentsFrom44Notification, attachmentsFrom223Purchase } = require('../server/sources/normalize');
const { createGosplanSource } = require('../server/sources/gosplan');
const { createFixtureSource } = require('../server/sources/fixture');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const readFix = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const firstFile = (re) => fs.readdirSync(FIX).find((f) => re.test(f));

test('44-ФЗ: реальный ответ ГосПлан нормализуется', () => {
  const raw = readFix('fz44-purchases.json')[0];
  const t = normalizePurchase('44', raw);
  assert.equal(t.law, '44');
  assert.equal(t.number, raw.purchase_number);
  assert.equal(t.title, raw.object_info.replace(/\s+/g, ' ').trim());
  assert.equal(t.price, raw.max_price);
  assert.equal(t.region, raw.region);
  assert.deepEqual(t.okpd2, raw.okpd2);
  assert.equal(t.customer_inn, raw.customers[0]);
  // время 44-ФЗ без зоны трактуется как UTC
  assert.equal(t.deadline_at, new Date(`${raw.collecting_finished_at}Z`).toISOString());
  assert.match(t.eis_url, new RegExp(`regNumber=${raw.purchase_number}$`));
});

test('223-ФЗ: другие имена полей сводятся к той же модели', () => {
  const raw = readFix('fz223-purchases.json').find((x) => x.submission_close_at) || readFix('fz223-purchases.json')[0];
  const t = normalizePurchase('223', raw);
  assert.equal(t.law, '223');
  assert.equal(t.customer_inn, raw.customer);
  assert.deepEqual(t.ktru, []);
  if (raw.submission_close_at) {
    assert.equal(t.deadline_at, new Date(`${raw.submission_close_at}+03:00`).toISOString());
  }
  assert.match(t.eis_url, /notice223/);
});

test('вложения 44-ФЗ берутся из извещения, 223-ФЗ — из docs[].source.attachments', () => {
  const a44 = attachmentsFrom44Notification(readFix(firstFile(/^fz44-notification-/)));
  assert.ok(a44.length > 0);
  assert.ok(a44.every((a) => a.fileName && /^https:\/\/zakupki\.gov\.ru\//.test(a.url)));

  const a223 = attachmentsFrom223Purchase(readFix(firstFile(/^fz223-purchase-/)));
  assert.ok(a223.length > 0);
  assert.ok(a223.every((a) => a.fileName && a.url.includes('zakupki.gov.ru')));

  // одиночный документ объектом, а не массивом
  const single = attachmentsFrom223Purchase({ docs: [{ source: { attachments: { document: { fileName: 'a.pdf', url: 'https://x/1' } } } }] });
  assert.deepEqual(single.map((a) => a.fileName), ['a.pdf']);
  assert.deepEqual(attachmentsFrom44Notification(null), []);
});

/** Поддельный fetch: отвечает по функции и запоминает запросы. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ url: u, headers: opts.headers || {} });
    const { status = 200, body, headers } = await handler(u, calls.length);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  fn.calls = calls;
  return fn;
}

const item = (n, extra = {}) => ({ purchase_number: String(n), object_info: `Закупка ${n}`, max_price: 100, region: 77, okpd2: [], ...extra });

test('ГосПлан: параметры профиля передаются в запрос, ключ — в заголовке', async () => {
  const fetchImpl = fakeFetch(() => ({ body: [item(1)] }));
  const src = createGosplanSource({ baseUrl: 'https://api.test', apiKey: 'secret', laws: ['44'], delayMs: 0, fetchImpl });
  const { tenders } = await src.fetchNew({
    profile: { regions: [77, 50], codes: ['26.60'], price_min: 1000, price_max: null, keywords: [] },
    since: new Date('2026-09-10T00:00:00Z'),
  });
  assert.equal(tenders.length, 1);
  const { url, headers } = fetchImpl.calls[0];
  assert.equal(url.pathname, '/fz44/purchases');
  assert.deepEqual(url.searchParams.getAll('region'), ['77', '50']);
  assert.deepEqual(url.searchParams.getAll('classifier'), ['26.60']);
  assert.equal(url.searchParams.get('max_price_ge'), '1000');
  assert.equal(url.searchParams.get('max_price_le'), null);
  assert.equal(url.searchParams.get('published_after'), '2026-09-10T00:00:00Z');
  assert.equal(url.searchParams.get('stage'), '1');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(headers.apikey, 'secret');
});

test('ГосПлан: дата раньше 2024-01-01 не отправляется (сервер отвечает 422)', async () => {
  const fetchImpl = fakeFetch(() => ({ body: [] }));
  const src = createGosplanSource({ baseUrl: 'https://api.test', laws: ['223'], delayMs: 0, fetchImpl });
  await src.fetchNew({ profile: {}, since: new Date('2020-01-01T00:00:00Z') });
  assert.equal(fetchImpl.calls[0].url.searchParams.get('published_after'), '2024-01-01T00:00:00Z');
  assert.equal(fetchImpl.calls[0].headers.apikey, undefined);
});

test('ГосПлан: пагинация до неполной страницы, лимит страниц, дедупликация по ключевым словам', async () => {
  const page = (skip) => Array.from({ length: skip < 200 ? 100 : 30 }, (_, i) => item(skip + i));
  const fetchImpl = fakeFetch((u) => ({ body: page(Number(u.searchParams.get('skip'))) }));
  const src = createGosplanSource({ baseUrl: 'https://api.test', laws: ['44'], delayMs: 0, maxPages: 10, fetchImpl });
  const r = await src.fetchNew({ profile: { keywords: ['мебель', 'стулья'] }, since: new Date() });
  assert.equal(fetchImpl.calls.length, 6); // 3 страницы × 2 ключевых слова
  assert.deepEqual(fetchImpl.calls.map((c) => c.url.searchParams.get('object_info')).slice(0, 4), ['мебель', 'мебель', 'мебель', 'стулья']);
  assert.equal(r.tenders.length, 230); // одинаковые номера из двух запросов не дублируются
  assert.equal(r.truncated, false);

  const limited = createGosplanSource({ baseUrl: 'https://api.test', laws: ['44'], delayMs: 0, maxPages: 2, fetchImpl: fakeFetch(() => ({ body: page(0) })) });
  assert.equal((await limited.fetchNew({ profile: {}, since: new Date() })).truncated, true);
});

test('ГосПлан: повтор при 429, понятная ошибка при 401 без утечки ключа', async () => {
  const flaky = fakeFetch((u, n) => (n === 1 ? { status: 429, body: 'slow down' } : { body: [item(1)] }));
  const src = createGosplanSource({ baseUrl: 'https://api.test', laws: ['44'], delayMs: 0, fetchImpl: flaky });
  const orig = global.setTimeout;
  global.setTimeout = (fn) => orig(fn, 0); // не ждать backoff в тесте
  try {
    assert.equal((await src.fetchNew({ profile: {}, since: new Date() })).tenders.length, 1);
  } finally {
    global.setTimeout = orig;
  }
  assert.equal(flaky.calls.length, 2);

  const denied = createGosplanSource({
    baseUrl: 'https://api.test', apiKey: 'top-secret-key', laws: ['44'], delayMs: 0, log: {},
    fetchImpl: fakeFetch(() => ({ status: 401, body: { message: 'Invalid authentication credentials' } })),
  });
  await assert.rejects(denied.fetchNew({ profile: {}, since: new Date() }), (err) => {
    assert.match(err.message, /401/);
    assert.match(err.message, /GOSPLAN_API_KEY/);
    assert.doesNotMatch(err.message, /top-secret-key/);
    return true;
  });
});

test('ГосПлан: сбой одного закона не теряет другой, страницы отдаются в onPage', async () => {
  const fetchImpl = fakeFetch((u) => (u.pathname.startsWith('/fz223') ? { status: 422, body: 'bad' } : { body: [item(1), item(2)] }));
  const src = createGosplanSource({ baseUrl: 'https://api.test', laws: ['44', '223'], delayMs: 0, fetchImpl, log: {} });
  const pages = [];
  const r = await src.fetchNew({ profile: {}, since: new Date(), onPage: (p) => pages.push(p.length) });
  assert.deepEqual(pages, [2]);
  assert.equal(r.tenders.length, 2);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^223-ФЗ: ГосПлан ответил 422/);

  const allBad = createGosplanSource({ baseUrl: 'https://api.test', laws: ['223'], delayMs: 0, log: {}, fetchImpl: fakeFetch(() => ({ status: 422, body: 'bad' })) });
  await assert.rejects(allBad.fetchNew({ profile: {}, since: new Date() }), /422/);
});

test('fixture-источник фильтрует как API и отдаёт вложения из сохранённых файлов', async () => {
  const src = createFixtureSource({ dir: FIX });
  const all = await src.fetchNew({ profile: {} });
  assert.ok(all.tenders.length >= 60);
  const moscow = await src.fetchNew({ profile: { regions: [77], keywords: ['медицинского оборудования'] } });
  assert.ok(moscow.tenders.length >= 2);
  assert.ok(moscow.tenders.every((t) => t.region === 77));

  const withDocs = all.tenders.find((t) => t.law === '44' && fs.existsSync(path.join(FIX, `fz44-notification-${t.number}.json`)));
  assert.ok((await src.getAttachments(withDocs)).length > 0);
});

test('ГосПлан: больше 5 кодов — несколько запросов по 5 (иначе 422), результаты без дублей', async () => {
  const fetchImpl = fakeFetch((u) => ({ body: u.searchParams.getAll('classifier').includes('28.23') ? [item(2), item(1)] : [item(1)] }));
  const src = createGosplanSource({ baseUrl: 'https://api.test', laws: ['44'], delayMs: 0, fetchImpl });
  const codes = ['26.20', '20.59.12', '26.30', '26.40.3', '26.70.13', '28.23', '27.32.13', '27.33.13', '26.70.16'];
  const { tenders, errors } = await src.fetchNew({ profile: { codes, keywords: [] }, since: new Date('2026-09-10T00:00:00Z') });
  assert.deepEqual(fetchImpl.calls.map((c) => c.url.searchParams.getAll('classifier')), [codes.slice(0, 5), codes.slice(5)]);
  assert.equal(tenders.length, 2);
  assert.deepEqual(errors, []);
});
