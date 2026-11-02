// Этап 6a: несколько источников закупок сразу — лента ЕИС (RSS), ГосПлан и склейка одной закупки из разных источников.
// Сеть подменена: RSS — сохранённая страница настоящей ленты ЕИС.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseRss, createEisRssSource } = require('../server/sources/eis-rss');
const { createMultiSource, merge } = require('../server/sources/multi');

const RSS = fs.readFileSync(path.join(__dirname, '..', 'samples', 'tenders', 'eis-rss-page.xml'), 'utf8');

test('лента ЕИС: закон, номер, наименование, заказчик, цена и дата', () => {
  const items = parseRss(RSS);
  assert.equal(items.length, 4);
  const p223 = items.find((t) => t.law === '223');
  assert.equal(p223.number, '32616402782');
  assert.equal(p223.price, 14850);
  assert.equal(p223.currency, 'RUB');
  assert.equal(p223.title, 'Поставка бумаги для офисной техники', 'подсветка найденного слова не разрывает слово');
  assert.match(p223.customer_name, /МНОГОФУНКЦИОНАЛЬНЫЙ ЦЕНТР/);
  assert.equal(p223.published_at.slice(0, 10), '2026-09-23');
  assert.match(p223.eis_url, /^https:\/\/zakupki\.gov\.ru\//);
  const p44 = items.find((t) => t.law === '44');
  assert.match(p44.number, /^\d{19}$/);
  assert.equal(p44.region, null, 'региона и срока подачи в ленте нет — их добирает ГосПлан');
  assert.equal(parseRss('<rss></rss>').length, 0);
});

test('лента ЕИС: пауза между запросами и ключевые слова профиля', async () => {
  const calls = [];
  let now = 0;
  const fetchImpl = async (url) => {
    calls.push({ url: String(url), at: now });
    return new Response(calls.length === 1 ? RSS : '<rss><channel></channel></rss>', { status: 200 });
  };
  const warned = [];
  // 16.10.2026 22:30 по Москве (19:30 UTC): «через 2 дня» — это 18.10 по московским суткам
  const src = createEisRssSource({ fetchImpl, delayMs: 0, maxPages: 2, clock: () => new Date('2026-10-16T19:30:00Z'), log: { warn: (m) => warned.push(m) } });
  const closed = [];
  const r = await src.fetchNew({ profile: { keywords: ['бумага', 'картридж'], price_min: 30000, min_days_to_deadline: 2 }, laws: ['44'], onClosed: (list) => closed.push(...list) });
  // в сохранённой странице одна закупка уже на этапе «Работа комиссии» — подать заявку на неё нельзя:
  // в ленту она не идёт, но о ней сообщается — чтобы убрать её, если она у нас уже есть
  assert.deepEqual(r.items.map((t) => t.number).sort(), ['0372100005226000200', '0373200586426000107', '32616401512']);
  assert.ok(r.items.every((t) => t.deadline_from === '2026-10-17T21:00:00.000Z' && t.open_confirmed), 'окончание подачи не раньше начала 18.10 по Москве');
  assert.deepEqual(closed, [{ law: '223', number: '32616402782', stage_text: 'Работа комиссии' }]);
  assert.equal(calls.length, 2, 'неполная страница — следующую не запрашиваем');
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get('searchString'), 'бумага');
  assert.equal(u.searchParams.get('fz44'), 'on');
  assert.equal(u.searchParams.get('fz223'), null);
  assert.equal(u.searchParams.get('priceFromGeneral'), '30000');
  // окончание подачи не раньше чем через «дней до подачи» из профиля; отбора по этапу нет — отменённые
  // закупки со сроком в будущем нужны, чтобы убрать их из ленты
  assert.equal(u.searchParams.get('af'), null);
  assert.equal(u.searchParams.get('applSubmissionCloseDateFrom'), '18.10.2026');
  assert.equal(warned.length, 0);
  assert.equal(new URL(calls[1].url).searchParams.get('searchString'), 'картридж');
  const bad = createEisRssSource({ fetchImpl: async () => new Response('нет', { status: 503 }), delayMs: 0 });
  const r2 = await bad.fetchNew({});
  assert.equal(r2.items.length, 0);
  assert.match(r2.errors[0], /ЕИС \(RSS\): ЕИС ответил 503/);
});

test('несколько источников: склейка по номеру, пустые поля дополняются, документы — у первого, кто умеет', async () => {
  const a = {
    name: 'a',
    async fetchNew({ onPage }) {
      const items = [{ law: '44', number: '1', title: 'Бумага', price: 100, region: null, deadline_at: null }];
      onPage?.(items);
      return { items, errors: [] };
    },
  };
  const b = {
    name: 'b',
    async fetchNew() {
      return { items: [{ law: '44', number: '1', title: 'Бумага (полное)', price: 100, region: 36, deadline_at: '2026-10-01T00:00:00Z' },
        { law: '223', number: '2', title: 'Картриджи' }], errors: ['b: страница 2 не отдалась'], truncated: true };
    },
    async getDetailsDoc() { return { doc: 'из b' }; },
    async listContracts() { return [{ reg_num: 'c1' }]; },
  };
  const pages = [];
  const multi = createMultiSource([a, b], { log: { warn() {} } });
  assert.equal(multi.name, 'a+b');
  const r = await multi.fetchNew({ onPage: (p) => pages.push(...p) });
  assert.equal(r.items.length, 2, 'одна и та же закупка из двух источников — одна запись');
  const one = r.items.find((t) => t.number === '1');
  assert.equal(one.title, 'Бумага', 'главный источник — первый в списке');
  assert.equal(one.region, 36, 'пустое поле дополнено вторым источником');
  assert.equal(one.deadline_at, '2026-10-01T00:00:00Z');
  assert.equal(one.source_name, 'a+b');
  assert.deepEqual(r.errors, ['b: страница 2 не отдалась']);
  assert.equal(r.truncated, true);
  assert.equal(pages.length, 1, 'onPage получает страницы всех источников');
  assert.deepEqual(await multi.getDetailsDoc({}), { doc: 'из b' }, 'первый источник не умеет — берём у второго');
  assert.deepEqual(await multi.listContracts('17.12'), [{ reg_num: 'c1' }]);
  assert.deepEqual(await multi.getAttachments({}), [], 'никто не умеет — пустой список, а не ошибка');
  assert.equal(merge({ a: 1, b: null }, { b: 2, c: 3 }).b, 2);
  const single = createMultiSource([a]);
  assert.equal(single, a, 'один источник — без обёртки');
});

test('источник закупки сохраняется и виден в ленте', async () => {
  const os = require('node:os');
  const baseConfig = require('../server/config');
  const { startServer } = require('../server/server');
  const { createFixtureSource } = require('../server/sources/fixture');
  const fixture = createFixtureSource({ dir: path.join(__dirname, '..', 'samples', 'tenders') });
  const rss = createEisRssSource({ fetchImpl: async () => new Response(RSS, { status: 200 }), delayMs: 0, maxPages: 1 });
  const s = startServer({
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-6a-')), PORT: 0, TELEGRAM_BOT_TOKEN: '',
    RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, ECONOMICS_MAX_PER_SYNC: 0,
  }, {
    scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-23T12:00:00Z'),
    sourceOverride: createMultiSource([fixture, rss], { log: { warn() {} } }),
  });
  try {
    await s.sync.run();
    const rows = s.repo.db.prepare('SELECT source, COUNT(*) n FROM tenders GROUP BY source').all();
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r.n]));
    assert.ok(bySource['eis-rss'] >= 3, `закупки из ленты ЕИС сохранены: ${JSON.stringify(bySource)}`);
    assert.ok(bySource.fixture >= 1);
    const feed = s.repo.listTenders({ showHidden: true, limit: 100 }).items;
    assert.ok(feed.some((t) => t.source === 'eis-rss'));
  } finally {
    s.server.close();
  }
});
