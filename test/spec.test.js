// Этап 6b: подбор товара строго по ТЗ — единицы, «тот же товар», ориентир по контрактам, строгая сверка,
// запросы по спецификации, чтение ТЗ из разбора и в воронке. Сеть подменена, .env не читается.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { normUnit, unitFactor, convertPrice, packFromText } = require('../server/offers/units');
const { specOf, sameProductDet, distinctiveTerms } = require('../server/offers/spec');
const { itemBenchmark, unresolvedLines } = require('../server/tenders/item-benchmark');
const { isEligible } = require('../server/offers/rank');
const { matchOffer } = require('../server/offers/match');
const { queriesFor } = require('../server/offers/sources/yandex-search');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const NOW = new Date('2026-09-17T09:00:00Z');

const PAPER = {
  id: 1, name: 'Бумага для офисной техники белая', unit: 'пачка', unit_price: 420, quantity: 100,
  characteristics: [{ name: 'Формат', value: 'А4' }, { name: 'Плотность', value: 'не менее 80 г/м2' }, { name: 'Количество листов в пачке', value: 'не менее 500 шт' }],
};

// ---------- единицы ----------
test('единицы: шт/упак по фасовке, л/т по плотности, кг/т, ОКЕИ и названия', () => {
  assert.equal(normUnit('Тонна; метрическая тонна (1000 кг)'), 'т');
  assert.equal(normUnit({ code: '796' }), 'шт');
  assert.equal(normUnit('Литр; кубический дециметр'), 'л');
  assert.equal(convertPrice(150, 'упак', 'шт', { packQty: 10 }), 15);
  assert.equal(convertPrice(15, 'шт', 'упак', { packQty: 10 }), 150);
  assert.equal(convertPrice(50, 'кг', 'т'), 50000);
  assert.equal(convertPrice(88.34, 'л', 'т', { name: 'Топливо дизельное' }), 105166.67, 'дизель: 0,84 кг/л');
  assert.equal(convertPrice(100, 'л', 'т'), null, 'плотность неизвестна — несопоставимо');
  assert.equal(unitFactor('м', 'упак'), null);
  assert.equal(unitFactor('Штука', 'шт'), 1);
  assert.equal(packFromText('Ручка шариковая (10 шт в упаковке)'), 10);
  assert.equal(packFromText('Бумага А4, 500 листов'), 500);
});

// ---------- тот же товар ----------
test('тот же товар: модель, формат, числа с единицами; общее наименование — «не ясно»', () => {
  const paper = specOf(PAPER);
  assert.equal(paper.required.find((r) => r.name === 'Плотность').comparator, '>=');
  assert.equal(sameProductDet(paper, 'Бумага офисная SvetoCopy A4, 80 г/м2, 500 листов').verdict, 'same', 'латинская A4 = кириллическая А4');
  assert.equal(sameProductDet(paper, 'Бумага для офисной техники А3').verdict, 'different');
  assert.match(sameProductDet(paper, 'Бумага А4 65 г/м2').reason, /нужно не менее 80 г\/м2, у товара 65/);
  assert.equal(sameProductDet(paper, 'Бумага для офисной техники').verdict, 'unknown');

  const cart = specOf({ name: 'Картридж Kyocera TK-5240K', characteristics: [] });
  assert.equal(sameProductDet(cart, 'Картридж лазерный Kyocera TK-5240K черный').verdict, 'same');
  assert.equal(sameProductDet(cart, 'Тонер-картридж TK5240K').verdict, 'same', 'модель без дефиса');
  assert.equal(sameProductDet(cart, 'Картридж Kyocera TK-5230K').verdict, 'different');
  assert.equal(sameProductDet({ ...cart, equivalent_allowed: true }, 'Картридж совместимый NV-TK5230K').verdict, 'unknown', 'эквивалент разрешён — решает нейросеть');
  assert.deepEqual(distinctiveTerms(paper), ['80 г/м2', '500 листов', 'А4'], 'числа с единицей — самые отличительные; штуки названы тем, чего они штуки');
  // мусор в поисковые слова не попадает: «Да», «1 шт», подробности устройства; обозначения латиницей — попадают
  const junk = { required: [{ name: 'Наличие сканера', value: 'Да' }, { name: 'Количество лотков', value: '1 шт' }, { name: 'Блок питания', value: 'Встроенный' },
    { name: 'Формат печати', value: 'А4 (210х297 мм)' }, { name: 'Интерфейс', value: 'SATA III' }, { name: 'Количество портов Ethernet', value: 'не менее 24 шт' },
    { name: 'Технология печати', value: 'лазерная' }, { name: 'Время выхода первого отпечатка', value: 'не более 8 сек' }] };
  assert.deepEqual(distinctiveTerms(junk, 8).sort(), ['24 портов', 'SATA III', 'А4', 'лазерная'].sort());
});

// ---------- ориентир по контрактам ----------
test('ориентир позиции: только тот же товар, в единице заказчика; вердикты нейросети учитываются', () => {
  const bench = {
    code: '17.12.14.110', contracts: 4,
    lines: [
      { name: 'Бумага А4 80 г/м2 500 л.', unit_price: 380, unit: 'пачка', reg_num: '1', supplier_inn: '7707083893' },
      { name: 'Бумага А4 80 г/м2', unit_price: 1900, unit: 'коробка', reg_num: '2' },
      { name: 'Бумага А3 80 г/м2', unit_price: 800, unit: 'пачка', reg_num: '3' },
      { name: 'Бумага для офисной техники', unit_price: 90, unit: 'пачка', reg_num: '4' },
    ],
  };
  const ib = itemBenchmark(PAPER, bench);
  assert.equal(ib.same, 2);
  assert.equal(ib.different, 1);
  assert.equal(ib.unknown, 1);
  assert.equal(ib.unconverted, 1, 'коробка без фасовки не пересчитывается в пачки');
  assert.equal(ib.unit_price.p25, 380);
  assert.equal(ib.contracts, 1);
  assert.deepEqual(unresolvedLines(PAPER, bench), ['Бумага для офисной техники']);
  const withLlm = itemBenchmark({ ...PAPER, contract_match: { 'Бумага для офисной техники': { verdict: 'different', reason: 'llm' } } }, bench);
  assert.equal(withLlm.unknown, 0);
  assert.equal(itemBenchmark(PAPER, { unit_price: { p25: 1 } }), null, 'старый кеш без строк — прежняя логика');

  const diesel = { id: 2, name: 'Топливо дизельное', unit: 'Тонна; метрическая тонна (1000 кг)', unit_price: 120000, characteristics: [] };
  const d = itemBenchmark(diesel, { lines: [{ name: 'Топливо дизельное ДТ-Л-К5', unit_price: 88.34, unit: 'л', reg_num: '9' }] });
  assert.equal(d.unit_price.p25, 105166.67, 'литры пересчитаны в тонны');
});

// ---------- строгая сверка ----------
test('строгая сверка: в расчёт — только «соответствует»; другая модель — «не соответствует»', async () => {
  const base = { unit_price: 100, trust: 80, in_time: true };
  assert.equal(isEligible({ ...base, match: 'соответствует' }, 60), true);
  assert.equal(isEligible({ ...base, match: 'частично' }, 60), false);
  assert.equal(isEligible({ ...base, match: 'не хватает данных' }, 60), false);
  const cart = { name: 'Картридж Kyocera TK-5240K', characteristics: [{ name: 'Цвет', value: 'черный' }] };
  const bad = await matchOffer(cart, { title: 'Картридж Kyocera TK-5230K', text: 'черный' });
  assert.equal(bad.match, 'не соответствует');
  const ok = await matchOffer(PAPER, { title: 'Бумага SvetoCopy A4', text: 'плотность 80 г/м2, 500 листов, белая' });
  // без нейросети каждую характеристику сверяют правила (offers/rule-check.js): формат, плотность и листы есть на странице
  assert.equal(ok.match, 'соответствует');
  assert.equal((await matchOffer(PAPER, { title: 'Бумага SvetoCopy A3', text: 'плотность 80 г/м2, 250 листов' })).match, 'не соответствует');
});

// ---------- запросы ----------
test('запросы по спецификации: модель с производителем первой, дальше отличительные числа', () => {
  const spec = {
    name: 'Картридж', required: [{ name: 'Ресурс', value: 'не менее 3000 стр', unit: 'стр' }, { name: 'Цвет', value: 'черный' }],
    identity: { model: 'TK-5240K', brand: 'Kyocera', compatible_with: 'Kyocera ECOSYS M5526cdn' },
  };
  const qs = queriesFor({ name: 'Картридж для лазерного принтера' }, 5, { spec, city: 'Воронеж' });
  assert.equal(qs[0], 'Kyocera TK-5240K купить');
  assert.match(qs[1], /3000 стр/);
  assert.ok(qs.some((q) => /для Kyocera ECOSYS M5526cdn/.test(q)));
  assert.match(qs[4], /Воронеж$/);
  assert.equal(new Set(qs).size, qs.length);
  const paperQs = queriesFor(PAPER, 3, { spec: { ...specOf(PAPER), identity: {} } });
  assert.match(paperQs[0], /80 г\/м2 500 листов А4 купить$/);
});

// ---------- чтение ТЗ и воронка ----------
const TZ_TEXT = `Техническое задание
Наименование товара: Системный блок
Количество: 12 шт
Модель: Офис Pro i5
Количество ядер процессора: не менее 6
Объем установленной оперативной памяти: не менее 16 Гбайт
Поставка товара или эквивалент.`;

function start(overrides = {}) {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-e6-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, FETCH_MIN_INTERVAL_MS: 0,
    YANDEX_SEARCH_API_KEY: '', DADATA_API_KEY: '', OFFER_SOURCES: 'contracts', ...overrides,
  };
  const s = startServer(config, {
    scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => NOW, sourceOverride: createFixtureSource({ dir: FIX }),
    fetchImpl: async () => new Response('not found', { status: 404 }),
  });
  s.config = config;
  return s;
}

test('чтение ТЗ: спецификация из разбора с цитатами дополняет позиции извещения', async () => {
  const s = start();
  try {
    await s.sync.run();
    const t = s.repo.getTender(s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id);
    await s.details.ensureItems(t);
    const aId = 'a-spec-1';
    s.repo.createAnalysis({ id: aId, title: 'ТЗ' });
    s.repo.addFile(aId, { name: 'ТЗ.docx', status: 'ok', pages: [{ page: 1, text: TZ_TEXT }] });
    s.repo.finishAnalysis(aId, { card: { groups: [] }, provider: 'mock', model: 'm', durationMs: 0 });
    s.repo.setTenderAnalysis(t.id, aId);
    const r = await s.details.ensureSpec(s.repo.getTender(t.id));
    assert.equal(r.status, 'done');
    assert.equal(r.matched, 1);
    const item = s.repo.getItems(t.id)[0];
    assert.equal(item.spec.identity.model, 'Офис Pro i5');
    assert.equal(item.spec.equivalent_allowed, true);
    const ram = item.spec.required.find((x) => /оперативной памяти/.test(x.name));
    assert.equal(ram.value, 'не менее 16 Гбайт');
    assert.deepEqual([ram.source.file, ram.source.page, ram.source.verified], ['ТЗ.docx', 1, true]);
    assert.ok(item.characteristics.length > 5, 'непустые характеристики извещения не затёрты');
    assert.equal(s.repo.getDetails(t.id).spec_status, 'done');
    assert.equal(s.repo.getTender(t.id).spec_status, 'done', 'метка для ленты');
    assert.equal((await s.details.ensureSpec(s.repo.getTender(t.id))).cached, true, 'повторно не читаем');
  } finally {
    s.server.close();
  }
});

test('воронка: сама читает ТЗ у перспективных закупок, с лимитом за раз и за сутки', async () => {
  const s = start({ RESALE_DOCS_PER_SYNC: 0, RESALE_DOCS_PER_DAY: 3, RESALE_MIN_MARGIN_PCT: 15 });
  try {
    await s.sync.run();
    await s.funnel.idle();
    s.config.RESALE_DOCS_PER_SYNC = 2; // до этого воронка после синхронизации документы не читала
    const ids = s.repo.db.prepare("SELECT id FROM tenders WHERE status = 'scored' ORDER BY id LIMIT 4").all().map((r) => r.id);
    const fake = (m) => ({ verdict: 'выгодно', result: { profit: m * 1000, margin_pct: m } });
    ids.forEach((id, n) => s.repo.saveEconomics(id, { result: fake(40 - n * 5), opportunity: 40 - n * 5, confirmed: false }));
    const r1 = await s.funnel.run();
    assert.equal(r1.docs.started, 2, 'не больше RESALE_DOCS_PER_SYNC за раз');
    const r2 = await s.funnel.run();
    assert.equal(r2.docs.started, 1, 'суточный лимит: 3 − 2');
    const r3 = await s.funnel.run();
    assert.equal(r3.docs.started, 0);
    assert.ok(ids.slice(0, 3).every((id) => s.repo.getTender(id).analysis_id), 'самые выгодные — первыми');
  } finally {
    s.server.close();
  }
});

// ---------- качество на реальном наборе ----------
test('набор оценки: другой товар среди выбранных ≤ 10%, найдено того же товара ≥ 70%', () => {
  const { lineVerdict } = require('../server/tenders/item-benchmark');
  const set = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'match-eval.json'), 'utf8'));
  assert.ok(set.pairs.length >= 20);
  let tp = 0; let fp = 0; let fn = 0;
  for (const p of set.pairs) {
    const same = lineVerdict(p.item, specOf(p.item), { name: p.candidate, chars: p.candidate_chars || '' }, p.code).verdict === 'same';
    if (same && p.label === 'same') tp++; else if (same) fp++; else if (p.label === 'same') fn++;
  }
  assert.ok(fp / (tp + fp) <= 0.1, `другой товар среди выбранных: ${fp} из ${tp + fp}`);
  assert.ok(tp / (tp + fn) >= 0.7, `найдено того же товара: ${tp} из ${tp + fn}`);
});

test('нейросеть «тот же» без единого подтверждённого требования — «не ясно»; производитель из «Товарный знак»', () => {
  const { acceptLlmVerdict } = require('../server/tenders/item-benchmark');
  const paper = specOf(PAPER);
  assert.equal(acceptLlmVerdict(PAPER, paper, 'Бумага для офисной техники. Товарный знак: Canon', true).verdict, 'unknown');
  assert.equal(acceptLlmVerdict(PAPER, paper, 'Бумага А4 80 г/м2. Товарный знак: Canon', true).verdict, 'same');
  assert.equal(acceptLlmVerdict(PAPER, paper, 'что угодно', false).verdict, 'different');
  const kyo = { ...specOf({ name: 'Картридж', characteristics: [] }), identity: { model: null, brand: 'Kyocera' }, equivalent_allowed: false };
  assert.equal(sameProductDet(kyo, 'Картридж для электрографических печатающих устройств. Товарный знак: Pantum').verdict, 'different');
  assert.notEqual(sameProductDet(kyo, 'Картридж для электрографических печатающих устройств. Товарный знак: Kyocera').verdict, 'different');
});

test('чтение ТЗ: позиции сопоставляются по модели, даже если в ТЗ другой порядок и кириллица в извещении', async () => {
  const s = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    s.repo.saveItems(id, [
      { name: 'Картридж', characteristics: [{ name: 'Модель', value: 'СЕ743А' }], quantity: 2, unit: 'шт', source: 'notification' },
      { name: 'Картридж', characteristics: [{ name: 'Модель', value: 'P2V67A' }], quantity: 5, unit: 'шт', source: 'notification' },
    ], { source: 'notification' });
    const aId = 'a-spec-2';
    s.repo.createAnalysis({ id: aId, title: 'ТЗ' });
    s.repo.addFile(aId, { name: 'Описание ОЗ.docx', status: 'ok', pages: [{ page: 1, text: 'Наименование товара: Картридж\nМодель: P2V67A\nЦвет: голубой\n\nНаименование товара: Картридж\nМодель: CE743A\nЦвет: пурпурный' }] });
    s.repo.addFile(aId, { name: 'Обоснование НМЦК.docx', status: 'ok', pages: [{ page: 1, text: 'Коммерческие предложения поставщиков' }] });
    s.repo.finishAnalysis(aId, { card: { groups: [] }, provider: 'mock', model: 'm', durationMs: 0 });
    s.repo.setTenderAnalysis(id, aId);
    const r = await s.details.ensureSpec(s.repo.getTender(id), { force: true });
    assert.equal(r.matched, 2);
    const items = s.repo.getItems(id);
    assert.equal(items[0].spec.identity.model, 'CE743A', 'кириллическое «СЕ743А» в извещении = латинское CE743A в ТЗ');
    assert.equal(items[1].spec.identity.model, 'P2V67A');
    assert.equal(items[1].spec.required.find((x) => x.name === 'Цвет').value, 'голубой');
    assert.ok(specOf(items[0]).required.some((x) => x.name === 'Цвет'), 'спецификация объединяет ТЗ и извещение');
  } finally {
    s.server.close();
  }
});

test('в ТЗ есть модель, а в наименовании товара её нет — «не ясно», а не «тот же»', () => {
  const cart = specOf({ name: 'Картридж для струйных печатающих устройств', characteristics: [{ name: 'Модель', value: 'P2V67A' }] });
  const r = sameProductDet(cart, 'Картридж для струйных печатающих устройств. Товарный знак: отсутствует');
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /модель не указана/);
  assert.equal(sameProductDet(cart, 'Картридж струйный HP P2V67A голубой').verdict, 'same');
});

test('обновление данных: источник не ответил — позиции из извещения не затираются', async () => {
  const s = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    const before = await s.details.ensureItems(s.repo.getTender(id));
    assert.ok(before[0].ktru_code, 'позиции из извещения — с кодом КТРУ');
    s.source.getDetailsDoc = async () => { throw new Error('ГосПлан недоступен'); };
    const after = await s.details.ensureItems(s.repo.getTender(id), { force: true });
    assert.deepEqual(after.map((i) => i.ktru_code), before.map((i) => i.ktru_code));
    assert.equal(s.repo.getDetails(id).items_source, 'notification');
  } finally {
    s.server.close();
  }
});

test('цена из контракта «за копейки» или в разы дороже — не берётся ни в ориентир, ни в расчёт', async () => {
  const { priceLooksSane } = require('../server/tenders/item-benchmark');
  const item = { id: 9, name: 'Перемешиватель растворов', unit: 'шт', unit_price: 97989.33, quantity: 1, characteristics: [] };
  assert.equal(priceLooksSane(item, 10.9), false);
  assert.equal(priceLooksSane(item, 2218500), false);
  assert.equal(priceLooksSane(item, 60000), true);
  assert.equal(priceLooksSane({ ...item, unit_price: null }, 10.9), true, 'цена заказчика не известна — сравнивать не с чем');
  const ib = itemBenchmark(item, {
    lines: [
      { name: 'Перемешиватель растворов', unit_price: 10.9, unit: 'шт', reg_num: '1' },
      { name: 'Перемешиватель растворов', unit_price: 74205, unit: 'шт', reg_num: '2' },
      { name: 'Перемешиватель растворов', unit_price: 2218500, unit: 'шт', reg_num: '3' },
    ],
  });
  assert.equal(ib.suspicious, 2);
  assert.equal(ib.unit_price.min, 74205, 'в ориентире осталась только правдоподобная цена');
});

test('расчёт: цена предложения, не похожая на правду, в прибыль не попадает', async () => {
  const s = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    const items = await s.details.ensureItems(s.repo.getTender(id));
    s.repo.setItemOffer(items[0].id, { id: 1, unit_price: 10.9, seller_name: 'ООО Ошибка', delivery_cost: 0 }, 'auto');
    const { economics } = await s.details.computeEconomics(id, { fetch: false });
    const input = economics.result.inputs.items.find((x) => x.id === items[0].id);
    assert.equal(input.purchase_price, null);
    assert.match(input.purchase_source, /слишком отличается от цены заказчика/);
  } finally {
    s.server.close();
  }
});

test('расчёт: такое же дешёвое предложение, выбранное вами, идёт в расчёт — с пометкой «проверьте»', async () => {
  const s = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    const items = await s.details.ensureItems(s.repo.getTender(id));
    s.repo.setItemOffer(items[0].id, { id: 1, unit_price: 10.9, seller_name: 'ООО Дёшево', delivery_cost: 0 }, 'user');
    const { economics } = await s.details.computeEconomics(id, { fetch: false });
    const input = economics.result.inputs.items.find((x) => x.id === items[0].id);
    assert.equal(input.purchase_price, 10.9);
    assert.equal(input.purchase_source, 'поиск поставщиков');
    assert.match(input.purchase_warning, /гораздо ниже рыночной/);
  } finally {
    s.server.close();
  }
});

test('запросы по ТЗ: модель в наименовании без identity.model — ищем «тип + производитель + модель», без диагонали и дублей', () => {
  const { queriesFor } = require('../server/offers/sources/yandex-search');
  const spec = { name: '18" Ноутбук ASUS ROG Strix G815JPR-S9037 или эквивалент', identity: {}, required: [] };
  const qs = queriesFor({ name: 'Ноутбук' }, 3, { spec });
  assert.equal(qs[0], 'Ноутбук ASUS ROG Strix G815JPR-S9037 купить');
  assert.ok(qs.every((q) => (q.match(/G815JPR-S9037/g) || []).length <= 1), qs.join(' | '));
});

test('безликая позиция «Позиция номер 1» — запрос строится из предмета закупки', () => {
  const { queriesFor } = require('../server/offers/sources/yandex-search');
  const { itemSearchName } = require('../server/offers/spec');
  assert.equal(itemSearchName('Позиция номер 1', 'Поставка накопителей SSD для модернизации рабочих мест'), 'накопителей SSD');
  assert.equal(itemSearchName('Позиция номер 1', '26Т0420060.0015. Приобретение (поставка) серверов АСУ ТП для нужд филиала'), 'серверов АСУ ТП');
  assert.equal(itemSearchName('Картридж HP 305', 'Поставка картриджей'), 'Картридж HP 305', 'обычное наименование не трогаем');
  const spec = { name: 'Позиция номер 1', identity: {}, required: [{ name: 'Объём', value: '1 ТБ', unit: 'ТБ', comparator: '=' }] };
  const q = queriesFor({ name: 'Позиция номер 1' }, 1, { spec, title: 'Поставка накопителей SSD для модернизации рабочих мест' })[0];
  assert.match(q, /^накопителей SSD/);
});

test('223-ФЗ: одна позиция «1 условная единица» на всю закупку — позиции берутся из ТЗ', async () => {
  const s = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    s.repo.saveItems(id, [{ name: 'Оборудование офисное и его части', characteristics: [], quantity: 1, unit: 'Условная единица', source: 'notification' }], { source: 'notification' });
    const aId = 'a-spec-agg';
    s.repo.createAnalysis({ id: aId, title: 'ТЗ' });
    s.repo.addFile(aId, { name: 'Техническое задание.docx', status: 'ok', pages: [{ page: 1, text: 'Наименование товара: Картридж\nМодель: P2V67A\nЦвет: голубой\n\nНаименование товара: Картридж\nМодель: CE743A\nЦвет: пурпурный' }] });
    s.repo.finishAnalysis(aId, { card: { groups: [] }, provider: 'mock', model: 'm', durationMs: 0 });
    s.repo.setTenderAnalysis(id, aId);
    await s.details.ensureSpec(s.repo.getTender(id), { force: true });
    const items = s.repo.getItems(id);
    assert.equal(items.length, 2, 'вместо одной «условной единицы» — товары из ТЗ');
    assert.deepEqual(items.map((i) => i.spec?.identity?.model).sort(), ['CE743A', 'P2V67A']);
  } finally {
    s.server.close();
  }
});

test('название раздела ОКПД2 вместо товара — запрос из предмета закупки', () => {
  const { itemSearchName } = require('../server/offers/spec');
  assert.equal(itemSearchName('Аппаратура коммуникационная, аппаратура радио- или телевизионная передающая; телевизионные камеры', 'Поставка коммутаторов в количестве 9 штук(261796)'), 'коммутаторов');
  assert.equal(itemSearchName('Оборудование офисное и его части', 'Поставка расходных материалов для оргтехники для нужд ПАО'), 'расходных материалов для оргтехники');
  assert.equal(itemSearchName('Компьютер персональный настольный (моноблок)', 'Поставка моноблоков'), 'Компьютер персональный настольный (моноблок)');
});

test('техника без характеристик: совпало только наименование — «не ясно»; простой товар — «тот же»', () => {
  const server = specOf({ name: 'Поставка сервера', okpd2_code: '26.20.14.000', characteristics: [] });
  assert.equal(sameProductDet(server, 'Сервер Supermicro AS-4125GS-TNRT, 4U GPU Server').verdict, 'unknown');
  const mono = specOf({ name: 'Моноблоки', ktru_code: '26.20.15.000-00000026', characteristics: [] });
  assert.equal(sameProductDet(mono, 'Моноблоки. Товарный знак: отсутствует').verdict, 'unknown');
  const pens = specOf({ name: 'Ручки шариковые', okpd2_code: '32.99.12.110', characteristics: [] });
  assert.equal(sameProductDet(pens, 'Ручка шариковая Erich Krause R-301 синяя').verdict, 'same');
  const withModel = specOf({ name: 'Сервер Supermicro AS-4125GS-TNRT', okpd2_code: '26.20.14.000', characteristics: [] });
  assert.equal(sameProductDet(withModel, 'Сервер Supermicro AS-4125GS-TNRT, 4U').verdict, 'same');
});

test('главный признак в запросе: диагональ из диапазона → ходовой размер; дюймы на странице пишут по-разному', () => {
  const { queriesFor } = require('../server/offers/sources/yandex-search');
  const { checkUnits, distinctiveTerms } = require('../server/offers/spec');
  const spec = { name: 'Интерактивная панель', identity: {}, required: [
    { name: 'Разрешение по горизонтали', value: 'не менее 2100 пиксель', unit: 'пиксель' },
    { name: 'Яркость', value: '≥ 500 кд/м2', unit: 'кд/м2' },
    { name: 'Время отклика', value: 'не более 8 мс', unit: 'мс' },
    { name: 'Диагональ матрицы дисплея', value: 'не менее 85 и менее 90 дюйм', unit: 'дюйм' },
  ] };
  assert.deepEqual(distinctiveTerms(spec, 3), ['86 дюймов'], 'диагональ — главный признак; пиксели, яркость и время отклика в запрос не идут');
  assert.equal(queriesFor({ name: 'Интерактивная панель' }, 1, { spec })[0], 'Интерактивная панель 86 дюймов купить');
  assert.deepEqual(checkUnits([spec.required[3]], 'Lumien LMP8604HL 86" 4K, USB 3.0').ok.length, 1, '86" — это 86 дюймов');
  assert.equal(checkUnits([spec.required[3]], 'Панель 75 дюймов, 3 порта USB').fail.length, 1);
  assert.equal(checkUnits([spec.required[3]], 'Panel 86 inch').ok.length, 1);
});

test('сокращённые коды картриджей HP: «CF83A» в ТЗ = «CF283A» в магазине, а соседняя модель — другой товар', () => {
  const { modelAliases } = require('../server/offers/spec');
  assert.deepEqual(modelAliases('CF83A'), ['cf83a', 'cf283a']);
  assert.deepEqual(modelAliases('CE285A'), ['ce285a', 'ce85a']);
  assert.deepEqual(modelAliases('TN-2375'), ['tn2375']);
  const short = specOf({ name: 'Тонер-картридж CF83A', okpd2_code: '26.20.40', characteristics: [] });
  assert.equal(sameProductDet(short, 'Картридж HP CF283A (№83A) Black').verdict, 'same');
  assert.equal(sameProductDet(short, 'Картридж EasyPrint (CF283A/83A) для HP LaserJet').verdict, 'same');
  assert.equal(sameProductDet(short, 'Картридж HP CE285A (№85A) Black').verdict, 'different');
  const full = specOf({ name: 'Картридж HP CE285A', okpd2_code: '26.20.40', characteristics: [] });
  assert.equal(sameProductDet(full, 'Картридж CE85A совместимый').verdict, 'same');
});

test('модель русскими буквами-двойниками распознаётся: «Катюша М348», «СЕ743А»; обычные слова не трогаем', () => {
  const { latinizeModels, modelTokens, isSearchable } = require('../server/offers/spec');
  assert.equal(latinizeModels('Блок термозакрепления для МФУ Катюша М348'), 'Блок термозакрепления для МФУ Катюша M348');
  assert.equal(latinizeModels('Картридж СЕ743А'), 'Картридж CE743A');
  assert.equal(latinizeModels('Бумага А4 500 листов, МФУ, 2026 год'), 'Бумага А4 500 листов, МФУ, 2026 год', 'А4, МФУ и числа — не модели');
  assert.deepEqual(modelTokens('Блок фотобарабана PCM348 для МФУ Катюша М348'), ['PCM348', 'M348']);
  const item = { name: 'Блок термозакрепления для МФУ Катюша М348', okpd2_code: '26.20.40', characteristics: [] };
  assert.equal(isSearchable(item), true, 'есть модель — есть что искать');
  assert.equal(sameProductDet(specOf(item), 'Блок термозакрепления Катюша M348 (печка) оригинал').verdict, 'same');
  assert.equal(sameProductDet(specOf(item), 'Блок термозакрепления Катюша М348').verdict, 'same', 'на странице модель тоже может быть русскими буквами');
});

test('«оригинал» в закупке: совместимый картридж — другой товар; «не оригинал» — подходит и тот, и другой', () => {
  const orig = specOf({ name: 'Картридж Xerox 106R02609 оригинал', okpd2_code: '26.20.40', characteristics: [] });
  assert.equal(sameProductDet(orig, 'Тонер-картридж БУЛАТ s-Line 106R02606, 106R02609 для Xerox Phaser 7100').verdict, 'different');
  assert.match(sameProductDet(orig, 'Картридж SAKURA 106R02609 для Xerox Phaser 7100').reason, /нужен оригинал/);
  assert.equal(sameProductDet(orig, 'Совместимый картридж 106R02609 голубой').verdict, 'different');
  assert.equal(sameProductDet(orig, 'Оригинальный лазерный картридж Xerox 106R02609 для Xerox Phaser 7100').verdict, 'same');
  assert.equal(sameProductDet(orig, 'Тонер-картридж голубой для Xerox Phaser 7100. Ресурс 9К (106R02609)').verdict, 'same');
  const compat = specOf({ name: 'Картридж Hewlett Packard CE285A не оригинал', okpd2_code: '26.20.40', characteristics: [] });
  assert.equal(sameProductDet(compat, 'Картридж CE285A 85A GalaPrint для HP').verdict, 'same');
  assert.equal(sameProductDet(compat, 'Картридж HP CE285A (№85A) Black оригинал').verdict, 'same');
  const plain = specOf({ name: 'Тонер-картридж TN-2375', okpd2_code: '26.20.40', characteristics: [] });
  assert.equal(sameProductDet(plain, 'Картридж Cactus CS-TN2375, TN-2375, черный').verdict, 'same', 'про оригинал не сказано — подходит любой');
});

test('вид из характеристик вместо общего наименования: «Рыба трескообразная» + «Вид рыбы: Минтай» → запросы про минтай', () => {
  const { withSpecies } = require('../server/offers/spec');
  const y = require('../server/offers/sources/yandex-search');
  assert.equal(withSpecies('Рыба трескообразная мороженая', [{ name: 'Вид рыбы', value: 'Минтай' }]), 'минтай мороженая');
  assert.equal(withSpecies('Рыба мороженая', [{ name: 'Вид рыбы', value: 'Не ниже первого' }]), 'Рыба мороженая', '«не ниже…» — не вид');
  assert.equal(withSpecies('Минтай мороженый', [{ name: 'Вид рыбы', value: 'Минтай' }]), 'Минтай мороженый', 'вид уже в названии');
  assert.equal(withSpecies('Картридж', [{ name: 'Вид печати', value: 'Лазерная' }]), 'Картридж', 'не продукты — не трогаем');
  const item = { name: 'Рыба трескообразная мороженая', characteristics: [{ name: 'Вид разделки', value: 'Потрошеная обезглавленная' }, { name: 'Вид рыбы', value: 'Минтай' }] };
  const spec = { name: item.name, required: item.characteristics };
  for (const q of [...y.queriesFor(item, 3, {}), ...y.queriesFromSpec(item, spec, 3, {}), ...y.specQueries(item, spec, 2, {}), y.plainQuery(item, spec, {})]) {
    assert.match(q, /минтай/);
    assert.doesNotMatch(q, /трескообразн/);
  }
});
