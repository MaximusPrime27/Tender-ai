// База знаний из пакета (config/knowledge): характеристики по-русски с оговорками, вид товара, серия и модели,
// совместимость картриджей; загрузка в свою базу товаров — паспорт производителя важнее страницы продавца.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedCards, formatFact, kbKind } = require('../server/offers/knowledge-seed');
const { createProductBase, KIND } = require('../server/offers/product-base');
const { openDb } = require('../server/db');

const dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'kb-fields.json'), 'utf8'));

test('значение по-русски: «до», «около», да/нет, разрешение, опция и условие', () => {
  assert.equal(formatFact({ value: 40, unit: 'ppm', qualifier: 'upper_bound', scope: 'model_invariant' }, dict), 'до 40 стр/мин');
  assert.equal(formatFact({ value: 10000, unit: 'pages', qualifier: 'approximate' }, dict), 'около 10000 стр.');
  assert.equal(formatFact({ value: true, qualifier: 'exact' }, dict), 'да');
  assert.equal(formatFact({ value: [1920, 1200], unit: 'pixels', qualifier: 'exact' }, dict), '1920×1200');
  assert.equal(formatFact({ value: 14, unit: 'inch', qualifier: 'exact' }, dict), '14"');
  assert.equal(formatFact({ value: 2.2, unit: 'mm', qualifier: 'exact' }, dict), '2,2 мм');
  assert.equal(formatFact({ value: ['print', 'copy', 'scan'], qualifier: 'exact' }, dict), 'печать, копирование, сканирование');
  assert.equal(formatFact({ value: 'black', qualifier: 'exact' }, dict), 'черный');
  assert.equal(formatFact({ value: true, qualifier: 'exact', scope: 'conditional', condition: 'Только WWAN-комплектации' }, dict), 'да (Только WWAN-комплектации)');
  assert.equal(formatFact({ value: 1, unit: 'count', qualifier: 'exact', scope: 'optional' }, dict), '1 шт (опционально)');
});

test('вид товара: процессор, плата (у неё тоже «сокет»), накопитель, МФУ по функциям, мебель — по виду или полям', () => {
  assert.equal(kbKind({ category_id: 'comp-parts', brand: 'AMD', name: 'Ryzen 5 5600' }, [{ field: 'cpu.cores' }]), 'cpu');
  assert.equal(kbKind({ category_id: 'comp-parts', brand: 'ASUS', name: 'PRIME H610M-K D4' }, [{ field: 'cpu.socket' }, { field: 'ram.slots' }]), 'motherboard');
  assert.equal(kbKind({ category_id: 'comp-parts', brand: 'Kingston', name: 'NV2 1000GB' }, [{ field: 'storage.capacity_gb' }]), 'storage');
  assert.equal(kbKind({ category_id: 'printers', brand: 'Kyocera', name: 'ECOSYS M2040dn' }, [{ field: 'functions', value: ['print', 'copy', 'scan'] }]), 'mfp');
  assert.equal(kbKind({ category_id: 'furniture', brand: 'CHAIRMAN', name: '523' }, []), null, 'ни вида, ни полей — не знаем, что это');
  assert.equal(kbKind({ category_id: 'furniture', brand: 'X', name: '1', kind: 'cabinet' }, []), 'cabinet');
  assert.equal(kbKind({ category_id: 'furniture', brand: 'X', name: '1' }, [{ field: 'gaslift.class' }]), 'office_chair');
  assert.equal(kbKind({ category_id: 'furniture', brand: 'X', name: '1' }, [{ field: 'tabletop.width_mm' }]), 'desk');
});

test('карточки пакета: модели серии получают общие свойства, у серии с моделями своей карточки нет; совместимость картриджа', () => {
  const cards = seedCards();
  assert.ok(cards.length >= 25);
  assert.ok(!cards.some((c) => c.kb_id === 'kingston_nv2'), 'серия Kingston NV2 — только в моделях');
  const nv2 = cards.find((c) => c.model === 'SNV2S/1000G');
  assert.equal(nv2.kindId, 'storage');
  assert.equal(nv2.specs.find((s) => s.name === 'Максимальная скорость записи').value, 'до 2100 МБ/с');
  assert.ok(nv2.specs.some((s) => s.name === 'Форм-фактор накопителя'), 'свойство серии');
  assert.ok(nv2.specs.every((s) => s.src && /^https?:/.test(s.src)), 'у каждого значения — документ производителя');
  const cf = cards.find((c) => c.model === 'CF259X');
  assert.match(cf.specs.find((s) => s.name === 'Совместимые устройства').value, /HP LaserJet Pro M404/);
  const family = cards.find((c) => c.kb_id === 'lenovo_t14_g5_intel');
  assert.match(family.title, /серия, исполнение уточнить/);
  // мебель: вид товара в названии, модель — как её выделит страница магазина («111РВ», а не «Росметалл 111РВ»)
  const chair = cards.find((c) => c.kb_id === 'chairman523');
  assert.equal(chair.kindId, 'office_chair');
  assert.equal(chair.title, 'Кресло руководителя CHAIRMAN 523');
  assert.equal(chair.model, 'CHAIRMAN 523');
  assert.equal(chair.specs.find((s) => s.name === 'Обивка спинки сзади').value, 'экокожа');
  assert.equal(cards.find((c) => c.kb_id === 'rosmet111rv').model, '111РВ');
  assert.equal(cards.find((c) => c.kb_id === 'ferroplast_smm08').model, 'СММП-08-Я-ФП-03-08');
  assert.equal(cards.find((c) => c.kb_id === 'ferroplast_smm08').specs.find((s) => s.name === 'Срок службы, лет').value, 'не менее 5');
});

test('совместимость по списку устройств: все устройства из ТЗ названы — подтверждено, часть — нет', () => {
  const { applyCompat } = require('../server/offers/match');
  const rows = [
    { name: 'Применимость', need: 'Pantum M6500W', verdict: 'unknown', found: '' },
    { name: 'Наименование печатающего устройства, в котором применяется картридж', need: 'Pantum M6500W; Canon MF3010', verdict: 'unknown', found: '' },
    { name: 'Совместимость с ОС', need: 'Windows 10', verdict: 'unknown', found: '' },
  ];
  applyCompat(rows, [{ name: 'Совместимые устройства', value: 'Pantum M6500W, Pantum M6550W' }], 'Pantum PC-211P', '');
  assert.equal(rows[0].verdict, 'yes');
  assert.equal(rows[1].verdict, 'unknown');
  assert.match(rows[1].found, /не подтверждено: MF3010/);
  assert.equal(rows[2].verdict, 'unknown', 'не устройство — правило не применяется');
  // устройство в названии требования, значение «Да»; «MF 3010» с пробелом — одна модель
  const named = [{ name: 'Совместим с лазерным МФУ Canon i-sensys MF 3010', need: 'Да', verdict: 'unknown', found: '' }];
  applyCompat(named, [{ name: 'Совместимые устройства', value: 'Canon i-SENSYS MF3010' }], 'Canon Cartridge 725', '');
  assert.equal(named[0].verdict, 'yes');
  // серия на странице («LJ M428») покрывает исполнения из ТЗ; «нет» нейросети при полном списке — «да»
  const series = [{ name: 'совместимость', need: 'HP LaserJet M428dw M428/M428fdn/M428fdw', verdict: 'no', found: 'HP LJ Pro M304, M404' }];
  applyCompat(series, [], 'Тонер-картридж 7Q CF259X, 057H для HP LJ M404, LJ M428, Canon LBP223', '');
  assert.equal(series[0].verdict, 'yes');
  assert.match(series[0].found, /по серии/);
  // M4280 — другой аппарат, серия M428 его не покрывает; неполный список при «нет» остаётся «нет»
  const other = [{ name: 'совместимость', need: 'HP LaserJet M428dw', verdict: 'no', found: '' }];
  applyCompat(other, [], 'Картридж для HP M4280', '');
  assert.equal(other[0].verdict, 'no');
});

test('числа с пробелом между тысячами: «≥9 000 и ≤10 000» — от 9000 до 10000, а не от 9 до 10', () => {
  const { fitsNumeric } = require('../server/offers/match');
  assert.equal(fitsNumeric('≥9 000 и ≤10 000', '9700 стр.'), true);
  assert.equal(fitsNumeric('не менее 9000 и не более 10000', '10 500'), false);
  assert.equal(fitsNumeric('не менее 1 600 страниц', '2000'), true);
  assert.equal(fitsNumeric('не менее 2, не более 4', '3'), true, 'запятая с пробелом — не разделитель тысяч');
});

test('загрузка в свою базу: паспорт заменяет значение продавца, повторно не грузится, новая версия — грузится', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // копия пакета: её потом меняем
  const kbDir = path.join(dir, 'knowledge');
  fs.cpSync(path.join(__dirname, '..', 'config', 'knowledge'), kbDir, { recursive: true });
  const base = createProductBase({ db: repo.db, knowledgeDir: kbDir, log: { log() {}, warn() {} } });
  // продавец написал другую скорость записи
  base.upsert({ kind: KIND.storage, brand: 'Kingston', model: 'SNV2S/1000G', title: 'SSD Kingston NV2 1TB SNV2S/1000G', specs: [{ name: 'Максимальная скорость записи', value: '3000 МБ/с', src: 'https://shop.ru/1' }, { name: 'Гарантия', value: '3 года' }], sources: [{ url: 'https://shop.ru/1', type: 'supplier', name: 'shop.ru', price: 5200, price_at: '2026-10-20' }] });
  const r = await base.refresh();
  assert.ok(r.knowledge.new >= 25, JSON.stringify(r.knowledge));
  assert.equal(r.knowledge.updated, 1);
  const p = base.list('storage').find((x) => x.model === 'SNV2S/1000G');
  assert.equal(p.specs.find((s) => s.name === 'Максимальная скорость записи').value, 'до 2100 МБ/с');
  assert.ok(p.specs.some((s) => s.name === 'Гарантия'), 'то, чего в паспорте нет, остаётся');
  assert.equal(p.from_kb, true);
  assert.equal(p.price.value, 5200, 'цена продавца сохранилась');
  const again = await base.refresh();
  assert.equal(again.knowledge.new + again.knowledge.updated + again.knowledge.same, 0, 'та же версия — не грузится');
  const models = JSON.parse(fs.readFileSync(path.join(kbDir, 'models.json'), 'utf8'));
  models[0].notes = `${models[0].notes} (изменено)`;
  fs.writeFileSync(path.join(kbDir, 'models.json'), JSON.stringify(models));
  const third = await base.refresh();
  assert.ok(third.knowledge.same + third.knowledge.updated > 0, 'новая версия пакета — загружается');
});
