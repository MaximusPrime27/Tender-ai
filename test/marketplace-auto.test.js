// Маркетплейсы для позиции без подходящего товара: поиск по описанию из ТЗ (модели в ТЗ нет), сверка карточек с ТЗ,
// «В расчёт» с ценой переносит сверку карточки в предложение.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createOfferService } = require('../server/offers');
const baseConfig = require('../server/config');
const { createProductBase } = require('../server/offers/product-base');

const CARDS = [
  { url: 'https://www.ozon.ru/product/kartridzh-tk-5290m-purpurnyy-123/', title: 'Картридж TK-5290M пурпурный для Kyocera ECOSYS P7240cdn, 13000 страниц — купить на OZON', passage: 'Совместимый тонер-картридж TK-5290M, цвет пурпурный, ресурс 13000 страниц' },
  { url: 'https://www.ozon.ru/product/kartridzh-tk-5290k-chernyy-456/', title: 'Картридж TK-5290K черный для Kyocera ECOSYS P7240cdn — купить на OZON', passage: 'Совместимый тонер-картридж TK-5290K, цвет черный, ресурс 17000 страниц' },
  { url: 'https://www.wildberries.ru/catalog/789/detail.aspx', title: 'Принтер Kyocera ECOSYS P7240cdn', passage: 'цветной лазерный принтер' },
  { url: 'https://example.ru/blog/kak-vybrat', title: 'Как выбрать картридж', passage: 'статья' },
];

function setup(t, { withBase = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-auto-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { ...baseConfig, DATA_DIR: dir, OFFER_SOURCES: 'yandex,manual', YANDEX_SEARCH_API_KEY: 'k', YANDEX_FOLDER_ID: 'f', DADATA_API_KEY: '', TELEGRAM_BOT_TOKEN: '', FETCH_MIN_INTERVAL_MS: 0, SUPPLIER_INDEX: false };
  const { id } = repo.upsertTender({ law: '44', number: 'mp-1', title: 'Картриджи', price: 10000, currency: 'RUB', region: 27, okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: 1, eis_url: null });
  repo.saveItems(id, [{ name: 'Картридж для электрографических печатающих устройств', quantity: 2, unit: 'шт', source: 'notification',
    characteristics: [{ name: 'Цвет печати', value: 'пурпурный' }, { name: 'Количество отпечатков', value: 'не менее 13000 шт' }, { name: 'Совместимость с устройствами', value: 'Kyocera ECOSYS P7240cdn' }] }]);
  const item = repo.getItems(id)[0];
  const calls = { search: 0, queries: [] };
  const xml = Buffer.from(`<yandexsearch>${CARDS.map((c) => `<doc><url>${c.url}</url><domain>${new URL(c.url).hostname}</domain><title>${c.title}</title><passages><passage>${c.passage}</passage></passages></doc>`).join('')}</yandexsearch>`).toString('base64');
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('searchapi')) { calls.search++; calls.queries.push(JSON.parse(opts.body).query.queryText); return new Response(JSON.stringify({ rawData: xml }), { status: 200 }); }
    return new Response('нет', { status: 404 });
  };
  // нейросеть сверки: по тексту карточки — цвет, ресурс, совместимость
  const llm = { complete: async ({ messages }) => {
    const ask = JSON.parse(messages[messages.length - 1].content);
    const text = `${ask.offer.title} ${ask.offer.text}`.toLowerCase();
    const a = {};
    for (const c of ask.required.characteristics) {
      if (/цвет/i.test(c.name)) a[c.n] = text.includes('пурпур') ? 'да: пурпурный' : text.includes('черн') ? 'нет: черный' : '?';
      else if (/отпечат/i.test(c.name)) a[c.n] = text.includes('13000') ? 'да: 13000' : text.includes('17000') ? 'да: 17000' : '?';
      else if (/совмест/i.test(c.name)) a[c.n] = text.includes('p7240cdn') ? 'да: Kyocera ECOSYS P7240cdn' : '?';
    }
    return { text: JSON.stringify({ kind: !/принтер kyocera/i.test(ask.offer.title), checks: a }) };
  } };
  const productBase = withBase ? createProductBase({ db: repo.db, log: { log() {}, warn() {} } }) : null;
  const offers = createOfferService({ config, repo, productBase, details: { computeEconomics: async () => ({}) }, llmFactory: () => llm, fetchImpl });
  return { repo, id, item, offers, calls, productBase };
}

test('позиция без модели в ТЗ: запрос по описанию (вид + устройство + цвет), подходящая карточка сверху, чужой цвет и принтер — не подходят', async (t) => {
  const { repo, id, item, offers, calls } = setup(t);
  const r = await offers.marketplaceCheck(id, item.id);
  assert.equal(calls.search, 1);
  assert.match(calls.queries[0], /Картридж Kyocera ECOSYS P7240cdn пурпурный \(site:ozon\.ru/);
  const mp = r.marketplace;
  assert.equal(mp.cards.length, 1, JSON.stringify(mp.cards.map((c) => [c.title, c.match])));
  assert.match(mp.cards[0].title, /TK-5290M пурпурный/);
  assert.equal(mp.cards[0].match, 'соответствует');
  assert.equal(mp.rejected, 2, 'чёрный картридж и принтер не подходят; статья — не карточка товара');
  // показывается в списке поставщиков позиции
  assert.equal(offers.listForTender(id)[0].marketplace.cards.length, 1);
  // повторно в течение 3 дней не ищем (не платим), если не попросили заново
  repo.setSetting('noop', '1');
});

test('«В расчёт» с ценой: предложение маркетплейса получает сверку карточки, а не «не хватает данных»', async (t) => {
  const { repo, id, item, offers } = setup(t);
  await offers.marketplaceCheck(id, item.id);
  const card = offers.listForTender(id)[0].marketplace.cards[0];
  const o = await offers.addManual(id, { item_id: item.id, url: card.url, price: 2490, title: card.title, seller_name: 'Ozon (маркетплейс)', mp_card: true });
  assert.equal(o.match, 'соответствует');
  assert.equal(o.unit_price, 2490);
  assert.match(o.match_notes[0], /Ozon: сверено с ТЗ по названию и описанию карточки/);
  assert.equal(repo.getOffers(id).length, 1);
});

test('позиция уже закрыта подходящим товаром с ценой — после поиска маркетплейсы сами не ищутся', async (t) => {
  const { repo, id, item, offers, calls } = setup(t);
  repo.insertOffer({ tender_id: id, item_id: item.id, source: 'yandex', title: 'Картридж Kyocera TK-5290M', url: 'https://shop.ru/x', domain: 'shop.ru', price: 3000, unit_price: 3000, match: 'соответствует' });
  // автоматический проход (как после поиска поставщиков)
  assert.equal(offers.listForTender(id)[0].marketplace, null);
  await offers.marketplaceCheck(id, item.id); // по кнопке — ищет
  assert.equal(calls.search, 1);
});

test('в ТЗ список устройств — в запрос к маркетплейсам идёт первое: по всему списку карточки не находятся', async (t) => {
  const { repo, id, item, offers, calls } = setup(t);
  repo.db.prepare('UPDATE tender_items SET characteristics_json = ? WHERE id = ?').run(JSON.stringify([
    { name: 'Цвет печати', value: 'черный' },
    { name: 'Наименование печатающего устройства, в котором применяется картридж', value: 'Xerox B225; Xerox B230; Xerox B235' },
  ]), item.id);
  await offers.marketplaceCheck(id, item.id);
  assert.equal(calls.search, 1);
  assert.match(calls.queries[0], /^Картридж Xerox B225 черный \(site:ozon\.ru/);
});

test('найденная карточка Озона запоминается в своей базе: в другой закупке на ту же модель — без запроса к поиску; ссылки на поиск — бесплатно', async (t) => {
  const { repo, id, item, offers, calls, productBase } = setup(t, { withBase: true });
  await offers.marketplaceCheck(id, item.id);
  assert.equal(calls.search, 1);
  const [p] = productBase.list('cartridge');
  assert.equal(p.model, 'TK-5290M');
  assert.ok(productBase.get(p.id).sources.some((s) => s.type === 'marketplace' && /ozon/.test(s.url)));
  // другая закупка, в ТЗ — та же модель
  const { id: id2 } = repo.upsertTender({ law: '44', number: 'mp-2', title: 'Картриджи 2', price: 9000, currency: 'RUB', region: 27, okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: 1, eis_url: null });
  repo.saveItems(id2, [{ name: 'Картридж TK-5290M', quantity: 1, unit: 'шт', source: 'notification', characteristics: [{ name: 'Цвет печати', value: 'пурпурный' }] }]);
  const r = await offers.marketplaceFill(id2, { auto: true });
  assert.equal(calls.search, 1, 'нового платного запроса нет');
  assert.equal(r.reused, 1);
  const g = offers.listForTender(id2)[0];
  assert.equal(g.marketplace.reused, true);
  assert.match(g.marketplace.cards[0].url, /ozon\.ru\/product\/kartridzh-tk-5290m/);
  assert.match(g.marketplace.cards[0].notes.at(-1), /в другой закупке — без нового запроса/);
  // бесплатные ссылки на поиск самих маркетплейсов по запросу из ТЗ
  assert.ok(g.market_links.links.some((l) => l.market_name === 'Ozon' && /ozon\.ru\/search\/\?text=/.test(l.url)));
});
