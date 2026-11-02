// Мерлион: разбор карты сайта, списка товаров и карточки; ночной агент пополняет базу характеристиками —
// сначала модели из ТЗ, потом карточки нужных видов; повторно карточку не читает раньше чем через 30 дней.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createProductBase } = require('../server/offers/product-base');
const { createProductAgent } = require('../server/offers/product-agent');
const { parseSitemap, parseList, parseCard, createMerlion } = require('../server/offers/merlion');

const item = (id, first, second) => `<a
          class="plate item col-xs-12 col-sm-6 col-md-4"
          href="/catalog/product/${id}/">
          <div class="col-xs-12"><span class="merlion_id">id ${id}</span>
              <span class="firstname">${first}</span>
              <span class="secondname">${second}</span></div></a>`;
const card = (title, second, rows) => `<h1 class="h2 ">${title}</h1>
  <p class="h3 light">${second}</p>
  <div class="property-wrapper"><div class="property">EAN код</div><div class="value">
        4549292248760      </div></div>
  ${rows.map(([n, v], i) => `<div class="property-wrapper"><div
            class="property${i % 2 ? ' odd' : ' '}">${n}</div>
          <div class="value ">
            ${v}          </div></div>`).join('\n')}`;

test('Мерлион: разделы из карты сайта, товары из списка, характеристики из карточки (и строки «odd»)', () => {
  const xml = '<urlset><url><loc>https://merlion.com/catalog/</loc></url><url><loc>https://merlion.com/catalog/periferiya-i-aksessuary/</loc></url>'
    + '<url><loc>https://merlion.com/catalog/periferiya-i-aksessuary/mfu-lazernye</loc></url><url><loc>https://merlion.com/about/</loc></url></urlset>';
  assert.deepEqual(parseSitemap(xml), ['https://merlion.com/catalog/periferiya-i-aksessuary/mfu-lazernye/']);
  const list = parseList(`${item(356463, 'МФУ лазерный Brother DCP-1602R', '(DCP1602R1) A4 черный')}${item(2194961, 'МФУ лазерный Canon i-Sensys MF465DW II', '(7188C007) A4 Duplex')}<a data-page="2">2</a><a data-page="8">8</a>`);
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items[1], { id: 2194961, title: 'МФУ лазерный Canon i-Sensys MF465DW II', second: '(7188C007) A4 Duplex' });
  assert.equal(list.pages, 8);
  const c = parseCard(card('МФУ лазерный Canon i-Sensys MF465DW II', '(7188C007) A4 Duplex Net WiFi белый', [['Разрешение печати (ч / б)', '1200x1200dpi'], ['Ресурс ч / б картриджа', '3000 стр'], ['Скорость печати ЧБ А4 (до)', '40 стр/мин']]));
  assert.equal(c.article, '7188C007');
  assert.equal(c.ean, '4549292248760');
  assert.deepEqual(c.specs.map((s) => s.name), ['Разрешение печати (ч / б)', 'Ресурс ч / б картриджа', 'Скорость печати ЧБ А4 (до)']);
});

test('Мерлион: список раздела — сессия со страницы раздела и POST по страницам с паузой', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', cookie: opts.headers?.Cookie, body: opts.body ? Object.fromEntries(opts.body) : null });
    const headers = { getSetCookie: () => ['PHPSESSID=abc; path=/'] };
    if (url.endsWith('/getproductlist')) {
      const page = Number(opts.body.get('page'));
      return { ok: true, headers, text: async () => (page <= 2 ? `${item(page * 10, `МФУ ${page}`, '(X1) A4')}<a data-page="2">2</a>` : '<p>ничего не найдено</p>') };
    }
    return { ok: true, headers, text: async () => '<div id="productsList" data-active-tg="971"></div>' };
  };
  const waits = [];
  const m = createMerlion({ fetchImpl, delayMs: 10, sleep: async (ms) => { waits.push(ms); } });
  const res = await m.listCategory('https://merlion.com/catalog/periferiya-i-aksessuary/mfu-lazernye/');
  assert.deepEqual(res.items.map((x) => x.id), [10, 20]);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts[0].body, { filter: '()', id: '971', view: 'plate', brand: '[]', page: '1' });
  assert.equal(posts[0].cookie, 'PHPSESSID=abc');
});

test('ночной агент: Мерлион — сначала модель из ТЗ, потом карточки нужного вида; в базе характеристики, EAN и артикул', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merlion-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const clock = () => new Date('2026-10-24T00:30:00Z');
  const base = createProductBase({ db: repo.db, clock, log: { log() {}, warn() {} } });
  const { id } = repo.upsertTender({ law: '44', number: 'm-1', title: 'МФУ', price: 100000, currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: '2026-10-23T08:00:00Z', deadline_at: '2026-11-01T10:00:00Z', stage: 1, eis_url: null });
  repo.saveItems(id, [{ name: 'МФУ Canon MF465DW II', quantity: 1, unit: 'шт', source: 'notification', characteristics: [{ name: 'Разрешение печати', value: 'не менее 1200 dpi' }] }]);
  const read = [];
  const merlion = {
    categories: async () => ['https://merlion.com/catalog/periferiya-i-aksessuary/mfu-lazernye/', 'https://merlion.com/catalog/bytovaya-tehnika/kastryuli/'],
    listCategory: async () => ({ items: [
      { id: 1, title: 'МФУ лазерный Brother DCP-1602R', second: '(DCP1602R1) A4' },
      { id: 2, title: 'МФУ лазерный Canon i-Sensys MF465DW II', second: '(7188C007) A4' },
    ], pages: 1 }),
    card: async (cid) => {
      read.push(cid);
      return cid === 2
        ? { url: 'https://merlion.com/catalog/product/2/', title: 'МФУ лазерный Canon i-Sensys MF465DW II', second: '(7188C007) A4', article: '7188C007', ean: '4549292248760', specs: [{ name: 'Разрешение печати (ч / б)', value: '1200x1200dpi' }, { name: 'Ресурс ч / б картриджа', value: '3000 стр' }, { name: 'Формат печати', value: 'A4' }] }
        : { url: 'https://merlion.com/catalog/product/1/', title: 'МФУ лазерный Brother DCP-1602R', second: '(DCP1602R1) A4', article: 'DCP1602R1', ean: null, specs: [{ name: 'Формат печати', value: 'A4' }, { name: 'Скорость печати', value: '20 стр/мин' }, { name: 'Разрешение печати', value: '2400x600dpi' }] };
    },
  };
  const agent = createProductAgent({ db: repo.db, productBase: base, siteIndex: null, merlion, clock, log: { log() {}, warn() {} }, config: { AGENT_HOUR: 3, DIGEST_TZ: 'Europe/Moscow', MERLION_CARDS_PER_NIGHT: 5 }, fetcher: { fetchPage: async () => { throw new Error('404'); } } });
  const rep = await agent.run({ reason: 'manual' });
  assert.deepEqual(read, [2, 1], 'модель из ТЗ — первой');
  assert.equal(rep.stats.merlion.by_model, 1);
  const p = base.findModel('MF465DW II', 'office') || base.findModel('MF465DWII', 'office');
  assert.ok(p, 'карточка MF465DW II в базе');
  const full = base.get(p.id);
  assert.ok(full.specs.some((s) => s.name === 'EAN' && s.value === '4549292248760'));
  assert.ok(full.sources.some((s) => s.name === 'merlion.com'));
  assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM merlion_categories').get().n, 1, 'кастрюли — не наш раздел');
  // повторная ночь: прочитанные карточки не читаются снова
  read.length = 0;
  await agent.run({ reason: 'manual' });
  assert.deepEqual(read, []);
});

test('две карточки Мерлиона одной модели (размер, цвет) — не расхождение на решение человека', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merlion2-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const clock = () => new Date('2026-10-24T00:30:00Z');
  const base = createProductBase({ db: repo.db, clock, log: { log() {}, warn() {} } });
  const { id } = repo.upsertTender({ law: '44', number: 'm-2', title: 'Мыши', price: 10000, currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: '2026-10-23T08:00:00Z', deadline_at: '2026-11-01T10:00:00Z', stage: 1, eis_url: null });
  repo.saveItems(id, [{ name: 'Мышь беспроводная', quantity: 5, unit: 'шт', source: 'notification', characteristics: [] }]);
  const merlion = {
    categories: async () => ['https://merlion.com/catalog/periferiya-i-aksessuary/besprovodnye-myshi/'],
    listCategory: async () => ({ items: [{ id: 11, title: 'Мышь Logitech M650 белый', second: '(910-006255)' }, { id: 12, title: 'Мышь Logitech M650 L белый', second: '(910-006240)' }], pages: 1 }),
    card: async (cid) => ({ url: `https://merlion.com/catalog/product/${cid}/`, title: 'Мышь Logitech M650 белый', second: '', article: `A${cid}`, ean: null,
      specs: [{ name: 'Количество кнопок', value: cid === 11 ? '4' : '5' }, { name: 'Вес', value: cid === 11 ? '101 г' : '115 г' }, { name: 'Интерфейс', value: 'USB' }] }),
  };
  const agent = createProductAgent({ db: repo.db, productBase: base, siteIndex: null, merlion, clock, log: { log() {}, warn() {} }, config: { AGENT_HOUR: 3, DIGEST_TZ: 'Europe/Moscow' }, fetcher: { fetchPage: async () => { throw new Error('404'); } } });
  const rep = await agent.run({ reason: 'manual' });
  assert.equal(rep.stats.merlion.cards, 2);
  assert.equal(repo.db.prepare("SELECT COUNT(*) n FROM product_conflicts WHERE status = 'open'").get().n, 0);
});
