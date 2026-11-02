// Количество в наличии, набор партии у нескольких продавцов и выбор логистики (продавец → перевозчик → оценка).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { allocate } = require('../server/offers/allocate');
const { stockFromText, stockFromStructured } = require('../server/offers/stock');
const { cargoOf, cargoFromSpecs, loadLogistics, weightKg, volumeM3 } = require('../server/offers/cargo');
const { estimateDelivery, quoteCarriers } = require('../server/offers/logistics');
const { extractOffer } = require('../server/offers/extract');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const LOGISTICS = loadLogistics(path.join(__dirname, '..', 'config', 'logistics.json'));

test('количество в наличии: число берётся со страницы только когда оно прямо названо', () => {
  assert.deepEqual(stockFromText('В наличии: 12 шт.'), { qty: 12, at_least: false, note: null });
  assert.deepEqual(stockFromText('Осталось 3 шт'), { qty: 3, at_least: false, note: null });
  assert.deepEqual(stockFromText('На складе более 10 шт'), { qty: 10, at_least: true, note: 'более 10' });
  assert.deepEqual(stockFromText('Наличие: 10+'), { qty: 10, at_least: true, note: 'более 10' });
  assert.equal(stockFromText('Под заказ, 14 дней').note, 'под заказ');
  // число после «в наличии» без единицы — это цена или число магазинов, а не количество
  assert.equal(stockFromText('В наличии 57 000 ₽').qty, null);
  assert.equal(stockFromText('В наличии в 12 магазинах').qty, null);
  assert.deepEqual(stockFromText('В наличии'), { qty: null, at_least: false, note: null });
  // разметка страницы (schema.org inventoryLevel)
  assert.equal(stockFromStructured({ '@type': 'QuantitativeValue', value: 25 }).qty, 25);
  assert.equal(stockFromStructured(7).qty, 7);
  assert.equal(stockFromStructured(null), null);
});

test('количество в наличии: попадает в предложение со страницы товара', async () => {
  const html = '<html><body><h1>Картридж HP CF259X</h1><p>В наличии: 6 шт.</p><p>Ресурс 10000 страниц</p></body></html>';
  const page = { url: 'https://shop.ru/cf259x', html, text: 'Картридж HP CF259X\nВ наличии: 6 шт.\nРесурс 10000 страниц', structured: [{ title: 'Картридж HP CF259X', price: 100, currency: 'RUB', availability: 'InStock', props: [] }] };
  const offer = await extractOffer(page, { name: 'Картридж HP CF259X', characteristics: [] });
  assert.deepEqual([offer.stock_qty, offer.stock_note, offer.availability], [6, null, 'в наличии']);
  // количество из разметки важнее текста
  const marked = await extractOffer({ ...page, structured: [{ ...page.structured[0], stock: { value: 40 } }] }, { name: 'Картридж HP CF259X', characteristics: [] });
  assert.equal(marked.stock_qty, 40);
  // на странице только «в наличии» — количество неизвестно
  const unknown = await extractOffer({ ...page, html: html.replace(': 6 шт.', ''), text: page.text.replace(': 6 шт.', '') }, { name: 'Картридж HP CF259X', characteristics: [] });
  assert.deepEqual([unknown.stock_qty, unknown.stock_note], [null, null]);
});

test('набор партии: лучшее берём на сколько есть, остаток — у следующих', () => {
  const o = (id, stock_qty, stock_note = null) => ({ id, stock_qty, stock_note });
  // нужно 10: у первого 6, у второго хватает
  assert.deepEqual(allocate([o(1, 6), o(2, 10), o(3, null)], 10), { allocations: [{ offer_id: 1, qty: 6, check: null }, { offer_id: 2, qty: 4, check: null }], covered: 10, missing: 0 });
  // количество неизвестно — берём всё у первого и просим уточнить (как было раньше, когда выбирался один продавец)
  const unknown = allocate([o(1, null), o(2, 100)], 10);
  assert.deepEqual(unknown.allocations.map((a) => [a.offer_id, a.qty]), [[1, 10]]);
  assert.match(unknown.allocations[0].check, /уточните наличие/);
  // «более 10»: нужно 8 — точно хватит; нужно 30 — берём, но просим уточнить
  assert.deepEqual(allocate([o(1, 10, 'более 10')], 8).allocations, [{ offer_id: 1, qty: 8, check: null }]);
  assert.match(allocate([o(1, 10, 'более 10')], 30).allocations[0].check, /уточните, есть ли всё количество/);
  // у продавца ноль — пропускаем; всего не хватает — видно, сколько не добрали
  assert.deepEqual(allocate([o(1, 0), o(2, 3), o(3, 4)], 10), { allocations: [{ offer_id: 2, qty: 3, check: null }, { offer_id: 3, qty: 4, check: null }], covered: 7, missing: 3 });
  assert.deepEqual(allocate([], 5), { allocations: [], covered: 0, missing: 5 });
});

function start() {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-alloc-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, SUPPLIER_INDEX: false, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
    OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '',
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: FIX }) });
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, {
      method: opts.method, headers: opts.json ? { 'Content-Type': 'application/json' } : undefined, body: opts.json ? JSON.stringify(opts.json) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { s, api };
}

test('набор партии: нужно 10 — 6 шт по 100 ₽ и 4 шт по 120 ₽ дают 1080 ₽; набор правится вручную', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    await s.funnel.idle();
    const id = (await api('/api/tenders?limit=1')).body.items[0].id;
    s.repo.saveItems(id, [{ name: 'Картридж HP CF259X', characteristics: [], quantity: 10, unit: 'шт', unit_price: 200, source: 'notification' }], { source: 'notification' });
    const item = s.repo.getItems(id)[0];
    const offer = (price, stock, extra = {}) => s.repo.insertOffer({ tender_id: id, item_id: item.id, source: 'yandex', title: 'HP CF259X', domain: `shop${price}.ru`, url: `https://shop${price}.ru/x`,
      price, unit_price: price, pack_qty: 1, seller_name: `Магазин ${price}`, match: 'соответствует', match_notes: [], availability: 'в наличии', stock_qty: stock, delivery_cost: 500, ...extra });
    const a = offer(100, 6);
    const b = offer(120, 10, { delivery_cost: 1000, delivery_carrier: 'продавец' });
    const c = offer(150, null);
    const put = (list) => api(`/api/tenders/${id}/items/${item.id}/allocations`, { method: 'PUT', json: { allocations: list } });

    // автоматически: самый дешёвый на 6 шт, остаток 4 шт — у следующего
    let r = await put([]);
    assert.equal(r.status, 200);
    let g = r.body.groups[0];
    assert.deepEqual(g.allocations.map((x) => [x.offer_id, x.qty, x.goods_cost]), [[a, 6, 600], [b, 4, 480]]);
    assert.deepEqual([g.needed, g.covered, g.missing, g.selected_by], [10, 10, 0, 'auto']);
    // доставка части партии: у перевозчика — пропорционально доле, цена доставки продавца от доли не зависит
    assert.deepEqual(g.allocations.map((x) => x.delivery_cost), [300, 1000]);
    let it = s.repo.getItems(id)[0];
    assert.equal(it.purchase_price_offer, 108, 'средняя цена за единицу: 1080 ₽ за 10 шт');
    assert.equal(it.purchase_offer_delivery, 1300);
    assert.match(it.purchase_offer_label, /набор у 2 продавцов/);
    let card = (await api(`/api/tenders/${id}`)).body;
    assert.equal(card.economics.result.inputs.items[0].purchase_price, 108);
    assert.equal(card.economics.result.result.purchase, 1080, 'в расчёт идёт вся сумма набора: 6×100 + 4×120');
    assert.equal(card.economics.result.result.logistics, 1300, 'доставка — от каждого продавца набора');
    assert.equal(card.economics.confirmed, true);

    // вручную: остаток добираем у третьего продавца
    r = await put([{ offer_id: a, qty: 6 }, { offer_id: c, qty: 4 }]);
    g = r.body.groups[0];
    assert.deepEqual([g.selected_by, g.covered, g.missing], ['user', 10, 0]);
    assert.equal(s.repo.getItems(id)[0].purchase_price_offer, 120, '(6×100 + 4×150) / 10');
    // взяли у продавца больше, чем у него на странице, — набор принят, но с пометкой
    r = await put([{ offer_id: a, qty: 8 }, { offer_id: b, qty: 2 }]);
    assert.match(r.body.groups[0].allocations[0].note, /в наличии 6 шт — уточните остальное/);

    // партия набрана не полностью — цена позиции в расчёт не идёт, набор виден
    r = await put([{ offer_id: a, qty: 6 }]);
    g = r.body.groups[0];
    assert.deepEqual([g.covered, g.missing, g.allocations.length], [6, 4, 1]);
    it = s.repo.getItems(id)[0];
    assert.equal(it.purchase_price_offer, null);
    card = (await api(`/api/tenders/${id}`)).body;
    assert.notEqual(card.economics.confirmed, true, 'остаток не закрыт — это не расчёт по найденным ценам');

    // ошибки ввода
    assert.equal((await put([{ offer_id: a, qty: 6 }, { offer_id: b, qty: 6 }])).status, 400, 'набрано больше, чем нужно');
    assert.equal((await put([{ offer_id: 999999, qty: 1 }])).status, 400, 'чужое предложение');
    assert.equal((await put([{ offer_id: a, qty: 0 }])).status, 400);
    assert.equal((await put([{ offer_id: a, qty: 3 }, { offer_id: a, qty: 3 }])).status, 400, 'одно предложение дважды');
    assert.equal((await api(`/api/tenders/${id}/items/999999/allocations`, { method: 'PUT', json: { allocations: [] } })).status, 404);

    // «Выбрать» — всё количество у одного продавца, как раньше
    assert.equal((await api(`/api/offers/${b}/select`, { method: 'POST', json: {} })).status, 200);
    g = (await api(`/api/tenders/${id}/offers`)).body.groups[0];
    assert.deepEqual(g.allocations.map((x) => [x.offer_id, x.qty]), [[b, 10]]);
    assert.deepEqual([g.selected_offer_id, g.selected_by], [b, 'user']);
    assert.equal(s.repo.getItems(id)[0].purchase_price_offer, 120);

    // повторный поиск не удаляет предложения из набора
    await put([{ offer_id: a, qty: 6 }, { offer_id: c, qty: 4 }]);
    s.repo.clearSearchOffers(id);
    assert.deepEqual(s.repo.getOffers(id).map((o) => o.id).sort(), [a, c].sort(), 'остались только предложения набора');
  } finally {
    await s.close();
  }
});

test('набор партии: выбор, сделанный до обновления, при открытии базы получает строку набора', () => {
  const { openDb } = require('../server/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-alloc-old-'));
  let repo = openDb(dir);
  const { id } = repo.upsertTender({ law: '44', number: 'old-choice', title: 'Картриджи', price: 100000, currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: 1, eis_url: null });
  repo.saveItems(id, [{ name: 'Картридж', quantity: 12, unit: 'шт', source: 'notification' }, { name: 'Тонер', quantity: null, unit: 'шт', source: 'notification' }, { name: 'Бумага', quantity: 5, unit: 'пач', source: 'notification' }]);
  const [a, b, c] = repo.getItems(id);
  const o1 = repo.insertOffer({ tender_id: id, item_id: a.id, source: 'yandex', unit_price: 4000, seller_name: 'Магазин', delivery_cost: 900 });
  const o2 = repo.insertOffer({ tender_id: id, item_id: b.id, source: 'yandex', unit_price: 700, seller_name: 'Магазин' });
  // как хранилось раньше: выбранное предложение записано только в самой позиции
  const old = repo.db.prepare('UPDATE tender_items SET purchase_offer_id = ?, purchase_price_offer = ?, purchase_offer_delivery = ?, purchase_selected_by = ? WHERE id = ?');
  old.run(o1, 4000, 900, 'user', a.id);
  old.run(o2, 700, null, 'auto', b.id);
  old.run(999999, 50, null, 'auto', c.id); // предложения уже нет — переносить нечего
  repo.db.prepare('DELETE FROM item_allocations').run();
  repo.db.close();

  repo = openDb(dir);
  try {
    const rows = repo.getAllocations(id);
    assert.deepEqual(rows.map((r) => [r.item_id, r.offer_id, r.qty, r.delivery_cost]), [[a.id, o1, 12, 900], [b.id, o2, 1, null]], 'одна строка на всё количество; количество не указано — 1');
    assert.equal(repo.getItems(id)[0].purchase_selected_by, 'user', 'сам выбор не тронут');
    repo.db.close();
    repo = openDb(dir);
    assert.equal(repo.getAllocations(id).length, 2, 'повторное открытие ничего не дублирует');
  } finally {
    repo.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('логистика: вес и объём — со страницы товара, иначе оценка по виду товара', () => {
  assert.deepEqual([weightKg('2,5 кг'), weightKg('850 г'), weightKg('1.2 kg'), weightKg('нет данных')], [2.5, 0.85, 1.2, null]);
  assert.equal(volumeM3('30х20х10 см'), 0.006);
  assert.equal(volumeM3('430 x 250 x 44 мм'), 0.00473);
  assert.deepEqual(cargoFromSpecs([{ name: 'Диагональ экрана', value: '24 дюйма' }, { name: 'Вес брутто', value: '6,2 кг' }, { name: 'Вес', value: '5 кг' }, { name: 'Габариты упаковки', value: '60x40x15 см' }]), { weight_kg: 6.2, volume_m3: 0.036 });
  const own = cargoOf({ specs: [{ name: 'Вес', value: '4.5 кг' }, { name: 'Габариты (ШхВхГ)', value: '440x44x250 мм' }], itemName: 'Коммутатор', settings: LOGISTICS });
  assert.deepEqual([own.weight_kg, own.estimated], [4.5, false]);
  const guess = cargoOf({ specs: [], itemName: 'Картридж HP CF259X', settings: LOGISTICS });
  assert.deepEqual([guess.weight_kg, guess.volume_m3, guess.estimated], [1, 0.005, true]);
  assert.match(guess.basis, /оценка/);
  assert.equal(cargoOf({ specs: [], itemName: 'Неведомая вещь', settings: LOGISTICS }).estimated, true, 'вид товара не распознан — общее значение по умолчанию, тоже оценка');
  assert.equal(cargoOf({ specs: [], itemName: 'Картридж', settings: { carriers: [], cargo_defaults: [], cargo_fallback: null } }).weight_kg, null, 'настроек нет — вес не известен');
});

test('логистика: сетка СДЭК совпадает с расчётами на сайте перевозчика; неподтверждённые перевозчики выключены', () => {
  assert.deepEqual(LOGISTICS.carriers.map((c) => c.name), ['СДЭК'], 'ПЭК и «Деловые линии» не участвуют, пока их тарифы не подтверждены');
  // расчёты владельца на сайте СДЭК 09.10.2026: сборный груз, склад → дверь, 1 м³ (расчётный вес 200 кг)
  const cargo = { weight_kg: 50, volume_m3: 1, estimated: false };
  const quote = (from, to) => { const d = estimateDelivery({ sellerRegion: from, customerRegion: to, goodsCost: 100000, cargo, quantity: 1, logistics: LOGISTICS, deliveryTermDays: 60 }); return [d.carrier, d.delivery_cost, d.delivery_days]; };
  assert.deepEqual(quote(77, 27), ['СДЭК', 23750, 11], 'Москва → Хабаровск: 23 750 ₽, 10–11 дней');
  assert.deepEqual(quote(77, 16), ['СДЭК', 8950, 4], 'Москва → Казань: 8 950 ₽, 3–4 дня');
  assert.deepEqual(quote(27, 27), ['СДЭК', 2900, 3], 'внутри Хабаровска: 2 900 ₽, 3–4 дня');
  // посылка: 10 кг, 0,05 м³ (расчётный вес 10 кг) — те же маршруты, свои сроки
  const parcel = { weight_kg: 10, volume_m3: 0.05, estimated: false };
  const small = (from, to) => { const d = estimateDelivery({ sellerRegion: from, customerRegion: to, goodsCost: 100000, cargo: parcel, quantity: 1, logistics: LOGISTICS, deliveryTermDays: 60 }); return [d.delivery_cost, d.delivery_days]; };
  assert.deepEqual(small(77, 27), [2960, 10], 'Москва → Хабаровск: 2 960 ₽, 9–10 дней');
  assert.deepEqual(small(77, 16), [1110, 3], 'Москва → Казань: 1 110 ₽, 2–3 дня');
  assert.deepEqual(small(27, 27), [615, 2], 'внутри Хабаровска: 615 ₽, 1–2 дня');
  // вес 10 или 50 кг при объёме 1 м³ цену не меняет — считается объёмный вес
  assert.equal(estimateDelivery({ sellerRegion: 77, customerRegion: 16, cargo: { weight_kg: 10, volume_m3: 1, estimated: false }, quantity: 1, logistics: LOGISTICS }).delivery_cost, 8950);
});

test('логистика: сначала доставка продавца, потом перевозчик по тарифной сетке, потом оценка по расстоянию', () => {
  const base = { sellerRegion: 77, customerRegion: 27, goodsCost: 100000, deliveryTermDays: 30, logisticsPct: 5 };
  const cargo = { weight_kg: 4.5, volume_m3: 0.005, estimated: false };

  // продавец назвал цену доставки — берём её, даже если перевозчик по сетке вышел бы дешевле или дороже
  const seller = estimateDelivery({ ...base, sellerDeliveryCost: 9000, cargo, quantity: 8, logistics: LOGISTICS });
  assert.deepEqual([seller.carrier, seller.delivery_cost, seller.basis, seller.estimated], ['продавец', 9000, 'страница продавца', false]);
  assert.equal(estimateDelivery({ ...base, sellerDeliveryCost: 0, cargo, quantity: 8, logistics: LOGISTICS }).delivery_cost, 0, 'бесплатная доставка продавца — тоже его доставка');

  // продавец доставку не назвал — перевозчик: самый дешёвый по весу всей партии
  const tk = estimateDelivery({ ...base, cargo, quantity: 8, logistics: LOGISTICS });
  const quotes = quoteCarriers({ roadKm: tk.distance_km, weightKg: 36, volumeM3: 0.04, settings: LOGISTICS });
  assert.deepEqual([tk.carrier, tk.delivery_cost], [quotes[0].name, quotes[0].cost]);
  assert.equal(tk.basis, 'оценка по тарифной сетке');
  assert.equal(tk.estimated, true);
  const several = quoteCarriers({ roadKm: 500, weightKg: 36, volumeM3: 0.04, settings: { carriers: [
    { id: 'a', name: 'Дорогой', min: 0, handling_days: 1, km_per_day: 500, zones: [{ to_km: null, base: 900, per_kg: 10 }] },
    { id: 'b', name: 'Дешёвый', min: 0, handling_days: 1, km_per_day: 500, zones: [{ to_km: null, base: 500, per_kg: 10 }] }] } });
  assert.deepEqual(several.map((q) => q.name), ['Дешёвый', 'Дорогой'], 'варианты перевозчиков — от дешёвого к дорогому');
  assert.ok(estimateDelivery({ ...base, cargo, quantity: 80, logistics: LOGISTICS }).delivery_cost > tk.delivery_cost, 'больше партия — дороже доставка');

  // веса на странице нет — расчёт по оценке веса, и это видно
  const guessed = estimateDelivery({ ...base, cargo: { weight_kg: 1, volume_m3: 0.005, estimated: true }, quantity: 20, logistics: LOGISTICS });
  assert.ok(guessed.carrier);
  assert.match(guessed.basis, /вес и объём — оценка/);

  // объёмный груз считается по объёмному весу: 1 м³ = 200 кг
  const bulky = quoteCarriers({ roadKm: 500, weightKg: 10, volumeM3: 1, settings: LOGISTICS });
  assert.ok(bulky.every((q) => q.chargeable_kg === 200));

  // к сроку успевает не самый дешёвый перевозчик — берём того, кто успевает
  const grid = { volumetric_kg_per_m3: 200, carriers: [
    { id: 'slow', name: 'Медленный', min: 100, handling_days: 10, km_per_day: 100, zones: [{ to_km: null, base: 100, per_kg: 1 }] },
    { id: 'fast', name: 'Быстрый', min: 100, handling_days: 1, km_per_day: 1000, zones: [{ to_km: null, base: 5000, per_kg: 1 }] },
  ] };
  assert.equal(estimateDelivery({ ...base, deliveryTermDays: 12, cargo, quantity: 1, logistics: grid }).carrier, 'Быстрый');
  assert.equal(estimateDelivery({ ...base, deliveryTermDays: 200, cargo, quantity: 1, logistics: grid }).carrier, 'Медленный');

  // регион продавца не известен или нет веса — перевозчика нет, оценка долей от стоимости товара (как раньше)
  const blind = estimateDelivery({ ...base, sellerRegion: null, cargo, quantity: 8, logistics: LOGISTICS });
  assert.deepEqual([blind.carrier, blind.delivery_days], [null, null]);
  assert.match(blind.basis, /регион продавца не известен/);
  const old = estimateDelivery(base);
  assert.equal(old.carrier, null);
  assert.match(old.note, /оценка по расстоянию/);
});

test('вес по виду товара: мелкие медицинские расходники — граммы, а не запасные 3 кг (канюли на 558 шт — не 2 тонны)', () => {
  const { cargoOf, loadLogistics } = require('../server/offers/cargo');
  const s = loadLogistics(require('node:path').join(__dirname, '..', 'config', 'logistics.json'));
  for (const name of ['Канюля/игла для приготовления лекарственных средств, стерильная', 'Бахилы водонепроницаемые', 'Шприц 5 мл', 'Перчатки смотровые нитриловые']) {
    const c = cargoOf({ specs: null, itemName: name, settings: s });
    assert.ok(c.weight_kg <= 0.05, `${name}: ${c.weight_kg} кг`);
  }
  assert.equal(cargoOf({ specs: null, itemName: 'Кабель сетевой', settings: s }).weight_kg, 10, 'другие правила не задеты');
});
