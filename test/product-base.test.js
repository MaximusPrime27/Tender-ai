// Своя база товаров: вид товара по наименованию, пополнение из найденных предложений (характеристики, значения
// со сверки, цена) без повторов, подбор по ТЗ из базы в карточке позиции.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProductBase, kindOf } = require('../server/offers/product-base');
const { openDb } = require('../server/db');
const { createOfferService } = require('../server/offers');
const baseConfig = require('../server/config');

test('вид товара: пять ниш (с мебелью), принадлежности — не из базы', () => {
  const k = (name, code) => kindOf(name, { code })?.id ?? null;
  assert.equal(k('Картридж для электрографических печатающих устройств'), 'cartridge');
  assert.equal(k('Тонер-картридж Kyocera TK-1170'), 'cartridge');
  assert.equal(k('Тонер для заправки HP 1 кг'), 'toner');
  assert.equal(k('Тонер — картридж CF226Х'), 'cartridge');
  assert.equal(k('Тонер - картридж с тонером увеличенной емкости 106R03583'), 'cartridge');
  assert.equal(k('Блок фотобарабана Brother DR-2335'), 'drum');
  assert.equal(k('Поставка МФУ'), 'mfp');
  assert.equal(k('Многофункциональное устройство лазерное'), 'mfp');
  assert.equal(k('Принтер лазерный'), 'printer');
  assert.equal(k('Накопитель SSD 512 ГБ'), 'storage');
  assert.equal(k('Модуль оперативной памяти DDR4'), 'ram');
  assert.equal(k('Мышь компьютерная'), 'mouse');
  assert.equal(k('Источник бесперебойного питания'), 'ups');
  assert.equal(k('Компьютер персональный настольный (моноблок)'), 'aio');
  assert.equal(k('Поставка персональных компьютеров в сборе.'), 'pc');
  assert.equal(k('Монитор, подключаемый к компьютеру'), 'monitor');
  assert.equal(k('Вычислительная машина', '26.20.11.110-00000165'), 'laptop');
  assert.equal(k('Коврик для мыши'), null);
  assert.equal(k('Стол компьютерный'), 'desk', 'стол — мебель, а не компьютер');
  assert.equal(k('Кресло руководителя CHAIRMAN 523'), 'office_chair');
  assert.equal(k('Парта школьная 2-местная'), 'desk');
  assert.equal(k('Шкаф для одежды ШР-22'), 'cabinet');
  assert.equal(k('Стеллаж металлический'), 'shelving');
  assert.equal(k('Кровать двухъярусная'), 'bed');
  assert.equal(k('Кресло-коляска инвалидное'), null);
  assert.equal(k('Шкаф телекоммуникационный 19"'), null);
  assert.equal(k('Столовые приборы'), null);
  assert.equal(kindOf('Тумба мобильная').niche, 'furniture');
  assert.equal(k('Подставка под системный блок'), null);
  assert.equal(k('Блок питания 600 Вт'), 'psu');
  assert.equal(k('Монитор пациента прикроватный'), null);
  assert.equal(kindOf('Картридж').niche, 'cartridges');
  assert.equal(kindOf('Сканер').niche, 'office');
});

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbase-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { id } = repo.upsertTender({ law: '44', number: 'pb-1', title: 'Картриджи', price: 100000, currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: 1, eis_url: null });
  repo.saveItems(id, [
    { name: 'Картридж', quantity: 4, unit: 'шт', source: 'notification', characteristics: [{ name: 'Цвет', value: 'черный' }, { name: 'Ресурс', value: 'не менее 1600 страниц' }] },
    { name: 'Стол письменный', quantity: 1, unit: 'шт', source: 'notification', characteristics: [{ name: 'Ширина', value: '1200 мм' }] },
  ]);
  const [cart, desk] = repo.getItems(id);
  const add = (o) => repo.insertOffer({ tender_id: id, item_id: cart.id, source: 'yandex', domain: new URL(o.url).hostname, ...o });
  return { repo, id, cart, desk, add };
}

test('пополнение из найденных предложений: карточка по модели, характеристики и значения со сверки, цена, без повторов', async (t) => {
  const { repo, add, desk, id } = setup(t);
  add({ title: 'Картридж Cactus CS-CE285A черный', url: 'https://opt1.ru/p/cs-ce285a', price: 590, price_date: '2026-10-01T10:00:00Z', match: 'соответствует',
    specs: [{ name: 'Цвет', value: 'черный' }, { name: 'Ресурс', value: '1600 стр.' }, { name: 'Бренд', value: 'Cactus' }],
    match_checks: { rows: [{ name: 'Совместимость', need: 'HP LaserJet P1102', verdict: 'yes', found: 'HP LaserJet P1102, M1132' }, { name: 'Гарантия', need: '12 мес', verdict: 'unknown', found: 'на странице нет' }] } });
  // тот же товар у другого поставщика — дополняет карточку (новая характеристика, вторая цена)
  add({ title: 'Картридж лазерный Cactus CS-CE285A', url: 'https://opt2.ru/item/777', price: 560, price_date: '2026-10-05T10:00:00Z', match: 'частично',
    specs: [{ name: 'Цвет', value: 'черный' }, { name: 'Технология печати', value: 'лазерная' }, { name: 'Вес', value: '0.6 кг' }] });
  // без модели и мало характеристик — не берём; стол с моделью — карточка мебели
  add({ title: 'Картридж черный', url: 'https://opt3.ru/x', price: 300, specs: [{ name: 'Цвет', value: 'черный' }, { name: 'Тип', value: 'лазерный' }, { name: 'Ресурс', value: '1500' }] });
  repo.insertOffer({ tender_id: id, item_id: desk.id, source: 'yandex', domain: 'mebel.ru', title: 'Стол письменный СП-120', url: 'https://mebel.ru/sp-120', price: 5000, specs: [{ name: 'Ширина', value: '1200' }, { name: 'Глубина', value: '600' }, { name: 'Цвет', value: 'бук' }] });
  // прошлые госконтракты — не страницы товаров
  add({ source: 'contracts', title: 'Картридж HP CE285A', url: 'https://zakupki.gov.ru/c/1', specs: [{ name: 'Цвет', value: 'черный' }, { name: 'a', value: '1' }, { name: 'b', value: '2' }] });

  const base = createProductBase({ db: repo.db, log: { log() {}, warn() {} } });
  const r = await base.refresh();
  assert.equal(r.offers.new, 2, JSON.stringify(r));
  assert.equal(r.offers.updated, 1);
  const [p] = base.list('cartridge');
  assert.equal(p.model, 'CS-CE285A');
  assert.equal(p.brand, 'Cactus');
  assert.deepEqual(p.specs.map((s) => s.name), ['Цвет', 'Ресурс', 'Бренд', 'Совместимость', 'Технология печати', 'Вес']);
  assert.equal(p.specs.find((s) => s.name === 'Совместимость').from, 'сверка с ТЗ');
  assert.ok(!p.specs.some((s) => s.name === 'Гарантия'), '«на странице нет» — не значение');
  assert.equal(p.sources, 2);
  assert.deepEqual(p.price, { value: 560, at: '2026-10-05T10:00:00Z', url: 'https://opt2.ru/item/777', site: 'opt2.ru' }, 'свежая цена');
  assert.equal(base.status().total, 2);
  assert.deepEqual(base.status().niches.sort((a, b) => a.id.localeCompare(b.id)), [{ id: 'cartridges', label: 'картриджи и расходные материалы', n: 1 }, { id: 'furniture', label: 'мебель', n: 1 }]);
  assert.equal(base.list('desk')[0].model, 'СП-120');
  // повторное пополнение берёт только новые предложения
  const again = await base.refresh();
  assert.equal(again.offers.new + again.offers.updated + again.offers.same + again.offers.skipped, 0);
});

test('подбор по ТЗ из базы: подходящий картридж — с ценой из базы, чужой цвет — отсеян без нейросети', async (t) => {
  const { repo, id, cart, add } = setup(t);
  add({ title: 'Картридж Cactus CS-CE285A черный', url: 'https://opt1.ru/p/cs-ce285a', price: 590, price_date: '2026-10-01T10:00:00Z', match: 'соответствует',
    specs: [{ name: 'Цвет', value: 'черный' }, { name: 'Ресурс', value: '1600 стр.' }, { name: 'Бренд', value: 'Cactus' }] });
  add({ title: 'Картридж NV Print NV-CF543A пурпурный', url: 'https://opt1.ru/p/nv-cf543a', price: 900, match: 'не соответствует',
    specs: [{ name: 'Цвет', value: 'пурпурный' }, { name: 'Ресурс', value: '1300 стр.' }, { name: 'Бренд', value: 'NV Print' }] });
  const base = createProductBase({ db: repo.db, log: { log() {}, warn() {} } });
  await base.refresh();
  assert.equal(base.list('cartridge').length, 2);
  let asked = 0;
  const llm = { complete: async ({ messages }) => {
    asked++;
    const ask = JSON.parse(messages[messages.length - 1].content);
    const checks = Object.fromEntries(ask.required.characteristics.map((c) => [c.n, /цвет/i.test(c.name) ? 'да: черный' : 'да: 1600 стр.']));
    return { text: JSON.stringify({ kind: true, checks }) };
  } };
  const config = { ...baseConfig, DATA_DIR: os.tmpdir(), OFFER_SOURCES: 'manual', YANDEX_SEARCH_API_KEY: '', DADATA_API_KEY: '', TELEGRAM_BOT_TOKEN: '', FETCH_MIN_INTERVAL_MS: 0, SUPPLIER_INDEX: false, RNP_AUTO: false };
  const offers = createOfferService({ config, repo, productBase: base, details: { computeEconomics: async () => ({}) }, llmFactory: () => llm });
  const before = offers.listForTender(id).find((g) => g.item_id === cart.id).base;
  assert.equal(before.kind, 'cartridge');
  assert.equal(before.catalog, 2);
  const r = await offers.baseCheck(id, cart.id);
  assert.equal(r.base.considered, 2);
  assert.equal(r.base.rejected, 1, 'пурпурный отсеян по таблице');
  assert.equal(asked, 1);
  const m = r.base.models[0];
  assert.equal(m.model, 'CS-CE285A');
  assert.equal(m.match, 'соответствует');
  assert.equal(m.from_registry, false);
  assert.equal(m.price.value, 590);
  assert.ok(offers.sourcesStatus().products === 2);
});
