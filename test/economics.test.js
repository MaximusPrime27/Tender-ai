const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { itemsFrom44Notification, itemsFrom223Purchase, formatCharValue } = require('../server/tenders/items');
const { parseContract, computeBenchmark, fetchBenchmark, percentile } = require('../server/tenders/benchmark');
const { calculate, breakdown, ECONOMICS_DEFAULTS } = require('../server/tenders/economics');
const { daysFrom, pctFrom, conditionsFrom44 } = require('../server/tenders/details');
const { createFixtureSource } = require('../server/sources/fixture');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const readFix = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

// ---------- позиции ----------
test('позиции 44-ФЗ: товар с характеристиками КТРУ', () => {
  const [item, ...rest] = itemsFrom44Notification(readFix('fz44-notification-0332200035226000280.json'));
  assert.equal(rest.length, 0);
  assert.equal(item.name, 'Системный блок');
  assert.equal(item.ktru_code, '26.20.15.000-00000026');
  assert.equal(item.quantity, 12);
  assert.equal(item.unit, 'шт');
  assert.equal(item.unit_price, 94775);
  assert.equal(item.sum, 1137300);
  assert.ok(item.characteristics.some((c) => c.name === 'Частота процессора базовая' && c.value === 'не менее 3.6 ГГц'));
  assert.ok(item.characteristics.some((c) => c.value === 'Да'));
});

test('позиции 44-ФЗ: лекарство (drugPurchaseObjectsInfo)', () => {
  const [item] = itemsFrom44Notification(readFix('fz44-notification-0333200014626000140.json'));
  assert.equal(item.name, 'КИСЛОРОД');
  assert.equal(item.ktru_code, '21.20.23.190-00006');
  assert.equal(item.quantity, 3120);
  assert.equal(item.unit_price, 105.05);
  assert.equal(item.sum, 327756);
  assert.ok(item.characteristics.some((c) => c.name === 'Лекарственная форма'));
});

test('позиции 44-ФЗ: несколько объектов массивом и одиночный объект', () => {
  const many = itemsFrom44Notification(readFix('fz44-notification-0132600015226000103.json'));
  assert.ok(many.length >= 2);
  const single = itemsFrom44Notification({ source: { notificationInfo: { purchaseObjectsInfo: { notDrugPurchaseObjectsInfo: {
    purchaseObject: { name: 'Картридж', OKEI: { nationalCode: 'шт' }, price: '1500.50', quantity: { value: '10' }, sum: '15005' },
  } } } } });
  assert.deepEqual(single.map((i) => [i.name, i.quantity, i.unit_price]), [['Картридж', 10, 1500.5]]);
  assert.deepEqual(itemsFrom44Notification(null), []);
});

test('позиции 223-ФЗ: из лотов, цена за единицу только при одной позиции', () => {
  const [pens] = itemsFrom223Purchase(readFix('fz223-purchase-32616386849.json'));
  assert.equal(pens.okpd2_code, '32.99.12.110');
  assert.equal(pens.quantity, 10);
  assert.equal(pens.unit_price, 15);
});

test('характеристики: диапазоны и значения читаемо', () => {
  assert.equal(formatCharValue({ rangeSet: { valueRange: { minMathNotation: 'greaterOrEqual', min: '8', maxMathNotation: 'lessOrEqual', max: '16' } }, OKEI: { nationalCode: 'Гбайт' } }), 'не менее 8 и не более 16 Гбайт');
  assert.equal(formatCharValue({ qualityDescription: 'А4' }), 'А4');
});

// ---------- рыночный ориентир ----------
test('ориентир: медиана, 25-й перцентиль, минимум и поставщики по фикстурам контрактов', async () => {
  const b = await fetchBenchmark(createFixtureSource({ dir: FIX }), '26.20.15.000-00000026');
  assert.equal(b.contracts, 5);
  assert.deepEqual(b.unit_price, { min: 43823.57, p25: 47999, median: 55861, max: 64850 });
  assert.equal(b.suppliers[0].inn, '5249185655');
  assert.ok(b.suppliers.every((s, i, a) => i === 0 || a[i - 1].unit_price <= s.unit_price));
});

test('ориентир: закупки у единственного поставщика не участвуют в оценке снижения', () => {
  const c = parseContract(readFix('fz44-contract-2110148701526000173.json'), '26.20.15.000-00000026');
  assert.equal(c.single_supplier, true);
  assert.equal(c.lines[0].unit_price, 47999);
  assert.equal(c.supplier.inn, '1121009000');
  assert.equal(computeBenchmark([c], [0.1, 0.2, 0.95]).decline.samples, 2, 'снижение ≥ 90% отбрасывается как ошибка данных');
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
});

// ---------- калькулятор ----------
const simple = (tax_mode) => calculate({
  nmck: 100000,
  items: [{ quantity: 1, unit_price: 100000, purchase_price: 50000 }],
  decline_pct: 0, logistics: 0, delivery_days: 0, payment_days: 0,
  settings: { tax_mode, min_profit: 0, min_margin_pct: 0 },
});

test('калькулятор: УСН «доходы» 6% — пример с известным ответом', () => {
  const r = simple('usn6').result;
  assert.equal(r.etp_fee, 1000);
  assert.equal(r.tax, 6000);
  assert.equal(r.profit, 43000);
  assert.equal(r.margin_pct, 43);
});

test('калькулятор: УСН 15% и минимальный налог 1%', () => {
  const r = simple('usn15').result;
  assert.equal(r.tax, 7350); // 15% × (100 000 − 50 000 − 1 000)
  assert.equal(r.profit, 41650);
  const loss = calculate({ nmck: 100000, items: [{ quantity: 1, purchase_price: 99500 }], decline_pct: 0, logistics: 0, delivery_days: 0, payment_days: 0, settings: { tax_mode: 'usn15' } }).result;
  assert.equal(loss.tax, 1000, 'при убытке — минимальный налог 1% выручки');
});

test('калькулятор: ОСН с НДС 22% и налогом на прибыль 25%', () => {
  const r = simple('osn').result;
  assert.equal(r.vat, 9016.39);
  assert.equal(r.tax, 9995.9);
  assert.equal(r.profit, 29987.71);
});

test('калькулятор: максимальная закупочная цена действительно даёт минимальную прибыль и маржу', () => {
  const input = {
    nmck: 1137300, items: [{ quantity: 12, unit_price: 94775, purchase_price: 60000 }],
    decline_pct: 10, bid_security_pct: 1, contract_security_pct: 5, delivery_days: 20, payment_days: 10,
    settings: { tax_mode: 'usn6', min_margin_pct: 12, min_profit: 50000 },
  };
  const r = calculate(input);
  const need = Math.max(50000, r.result.revenue * 0.12);
  const settings = { ...ECONOMICS_DEFAULTS, ...input.settings };
  const ctx = { settings, nmck: input.nmck, advance_pct: 0, bid_security_pct: 1, contract_security_pct: 5, warranty_security_pct: 0, delivery_days: 20, payment_days: 10 };
  const at = (p) => breakdown({ revenue: r.result.revenue, purchase: p, logistics: p * 0.05, ctx }).profit;
  assert.ok(Math.abs(at(r.max_purchase.total) - need) < 1, 'на максимальной цене прибыль ровно пороговая');
  assert.ok(at(r.max_purchase.total + 100) < need, 'дороже — ниже порога');
  assert.equal(r.max_purchase.unit, Math.round((r.max_purchase.total / 12) * 100) / 100);
  // Минимальная цена на торгах: прибыль при ней не ниже порога
  assert.ok(r.min_bid.price < input.nmck && r.min_bid.max_decline_pct > 0);
});

test('калькулятор: нет закупочной цены → «нет данных», прибыль не считается', () => {
  const r = calculate({ nmck: 500000, items: [{ quantity: 5, unit_price: 100000, purchase_price: null }] });
  assert.equal(r.verdict, 'нет данных');
  assert.equal(r.result, null);
  assert.match(r.reasons[0], /нет закупочной цены для 1 из 1/);
  assert.ok(r.max_purchase.total > 0, 'а максимальную цену закупки посчитать можно');
});

test('калькулятор: вердикты и предупреждение о сроке', () => {
  const base = { nmck: 100000, items: [{ quantity: 1, purchase_price: 50000 }], decline_pct: 0, delivery_days: 2, payment_days: 10 };
  assert.equal(calculate({ ...base, settings: { min_profit: 10000 } }).verdict, 'выгодно');
  assert.equal(calculate({ ...base, settings: { min_profit: 60000 } }).verdict, 'на грани');
  assert.equal(calculate({ ...base, items: [{ quantity: 1, purchase_price: 99000 }] }).verdict, 'невыгодно');
  assert.ok(calculate(base).reasons.some((x) => /мало времени/.test(x)));
});

// ---------- разбор чисел из документации ----------
test('сроки и проценты из текста карточки', () => {
  assert.equal(daysFrom('Срок поставки товара: в течение 10 календарных дней с даты заключения контракта.'), 10);
  assert.equal(daysFrom('Оплата производится в течение 30 (тридцати) рабочих дней'), 42);
  assert.equal(daysFrom('по заявке заказчика'), null);
  assert.equal(pctFrom('Размер обеспечения заявки: 1 % от НМЦК'), 1);
  assert.equal(pctFrom('0,5% от цены'), 0.5);
  assert.deepEqual(conditionsFrom44(readFix('fz44-notification-0132600015226000103.json')),
    { bid_security_pct: 1, contract_security_pct: 10, customer_inn: '5250077573', deadline_at: '2026-09-25T05:00:00.000Z', notice_version: 1, notice_published_at: '2026-09-17T13:59:44.432+03:00' },
    'из извещения берём и срок подачи с заказчиком — источник (лента ЕИС) их не даёт');
});

test('ориентир не подставляется, если несопоставим с позицией (группа ОКПД2, условные единицы)', () => {
  const { benchmarkComparable } = require('../server/tenders/details');
  const bench = { unit_price: { p25: 37.95 } };
  assert.equal(benchmarkComparable({ unit: 'Условная единица', unit_price: 240021.98 }, bench), false);
  assert.equal(benchmarkComparable({ unit: 'шт', unit_price: 240021.98 }, bench), false, 'цена в тысячи раз ниже — другой товар');
  assert.equal(benchmarkComparable({ unit: 'шт', unit_price: 94775, ktru_code: 'x' }, { unit_price: { p25: 47999 } }), true);
  assert.equal(benchmarkComparable({ unit: 'шт', unit_price: null, ktru_code: 'x' }, { unit_price: { p25: 100 } }), true);
  assert.equal(benchmarkComparable({ unit: 'шт', unit_price: null, ktru_code: null }, { unit_price: { p25: 100 } }), false);
});

test('223-ФЗ: юридическая оговорка в «дополнительных сведениях» — не наименование товара', () => {
  const lot = (info) => ({ docs: [{ source: { lots: { lot: [{ lotData: { initialSum: 900, lotItems: { lotItem: [{ qty: 9, additionalInfo: info, okpd2: { code: '26.30.11.110', name: 'Коммутаторы' }, okei: { name: 'Штука' } }] } } }] } } }] });
  assert.equal(itemsFrom223Purchase(lot('Ограничение закупок товаров , происходящих из иностранных государств, работ, услуг, по перечню согласно приложению N 2.'))[0].name, 'Коммутаторы');
  assert.equal(itemsFrom223Purchase(lot('Коммутатор управляемый 24 порта'))[0].name, 'Коммутатор управляемый 24 порта');
  assert.equal(itemsFrom223Purchase(lot('-'))[0].name, 'Коммутаторы');
});
