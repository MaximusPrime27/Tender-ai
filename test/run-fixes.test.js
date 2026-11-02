// Исправления по пробным прогонам заявок (24.10.2026): условие из извещения у голого числа ТЗ, чужое значение в заявке,
// таблица заявки из требований ТЗ, закупка по цене единицы, картриджи к аппарату из своей базы, разметка в характеристиках.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createProductBase, KIND } = require('../server/offers/product-base');
const { specOf } = require('../server/offers/spec');
const C = require('../server/bids/characteristics');
const { cartridgesForDevice, devicesOf } = require('../server/offers/device-cartridges');
const { specsFromPage } = require('../server/offers/product');

test('голое число из таблицы ТЗ берёт условие извещения («400» → «не менее 400»), копия из извещения не дублируется', () => {
  const item = {
    name: 'Накопитель данных внутренний',
    characteristics: [{ name: 'Скорость записи', value: 'не менее 400 Мбайт/с' }, { name: 'Ресурс на запись дисков SSD (DWPD)', value: 'не менее 0.3' }],
    spec: { required: [{ name: 'Скорость записи', value: '400' }, { name: 'Ресурс на запись DWPD', value: '0.3' }, { name: 'Цвет', value: 'черный', comparator: '=' }], identity: {} },
  };
  const req = specOf(item).required;
  assert.deepEqual(req.map((r) => [r.name, r.value]), [['Скорость записи', 'не менее 400 Мбайт/с'], ['Ресурс на запись DWPD', 'не менее 0.3'], ['Цвет', 'черный']]);
  // условие прочитано, но лежит отдельно от числа («500», «>=») и в извещении такого нет — дописывается словами
  const alone = specOf({ name: 'SSD', characteristics: [], spec: { required: [{ name: 'Скорость чтения', value: '500', comparator: '>=' }], identity: {} } }).required;
  assert.equal(alone[0].value, 'не менее 500');
});

test('в заявку не попадает значение чужой характеристики: «Объём накопителя» не подменяет ресурс записи (DWPD)', () => {
  assert.ok(C.nameScore('Ресурс на запись дисков SSD - количество перезаписей всего объема накопителя в день (DWPD)', 'Объем накопителя') < 0.75);
  assert.ok(C.nameScore('Размер диагонали', 'Диагональ') >= 0.75, 'короткое название внутри короткого — то же свойство');
  assert.ok(C.nameScore('Скорость черно-белой печати в формате А4, стр/мин', 'Скорость печати') >= 0.75);
});

test('таблица заявки у позиции без характеристик КТРУ — из требований ТЗ: число с условием — значение товара, текст — как в ТЗ', () => {
  const item = { id: 1, idx: 0, name: 'Тонер-картридж для МФУ Pantum M6800FDW', quantity: 20, unit: 'шт', eis_chars: [],
    spec: { required: [{ name: 'Цвет', value: 'черный' }, { name: 'Ресурс (при 5% заполнении) стр.', value: '≥ 6000 шт.' }] } };
  const t = C.itemTable(item, { offer: { title: 'G&G TL-420X', specs: [{ name: 'Ресурс, стр.', value: '6000' }], rows: [] } });
  assert.deepEqual(t.rows.map((r) => [r.name, r.status, r.value]), [['Цвет', 'fixed', 'черный'], ['Ресурс (при 5% заполнении) стр.', 'product', '6000']]);
});

function db(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runfix-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = createProductBase({ db: repo.db, log: { log() {}, warn() {} } });
  return { repo, base };
}

test('картриджи к аппарату из своей базы: по совместимости карточек, серия покрывает исполнение, марка должна совпасть', (t) => {
  const { repo, base } = db(t);
  const card = (model, title, compat) => base.upsert({ kind: KIND.cartridge, brand: null, model, title, specs: [{ name: 'Совместимость', value: compat }, { name: 'Цвет', value: 'черный' }], sources: [] });
  card('CS-TL-420E', 'Картридж Cactus CS-TL-420E', 'M7100/P3010/P3300/M6700/M6800');
  card('TL-420X', 'Картридж Pantum TL-420X', 'Pantum P3010, M6800FDW, M7100DN');
  card('Q2612A', 'Картридж SAKURA Q2612A для HP LJ 1010, 1020, 3050', 'LJ 1010/1012/1015/1020/3015/3050');
  card('106R01159', 'Картридж Xerox 106R01159', 'Xerox Phaser 3117, 3122, 3050');
  // «3050» — ресурс в названии и чужой аппарат «CTP-3050D» без марки: не картриджи к HP LaserJet 3050
  base.upsert({ kind: KIND.cartridge, brand: null, model: 'W1510A', title: 'HP W1510A Картридж лазерный 151A черный (3050стр.) для LJ Pro 4003', specs: [{ name: 'Ресурс, страниц', value: '3050' }, { name: 'Совместимость', value: 'LJ Pro 4003, MFP 4103' }, { name: 'Цвет', value: 'черный' }], sources: [] });
  card('CP-5916A', 'Картридж лазерный BIGTECH CP-5916A чер. для CTP-3005D/3050D', 'CTP-3005D/3050D');
  assert.deepEqual(devicesOf('Тонер-картридж для принтера НР Laser Jet 3050'), [{ brand: 'HP', series: '3050' }]);
  assert.deepEqual(cartridgesForDevice(repo.db, 'Тонер-картридж для МФУ Pantum M6800FDW').map((c) => c.model), ['TL-420E', 'TL-420X'], 'приставка совместимого бренда снята');
  assert.deepEqual(cartridgesForDevice(repo.db, 'Тонер-картридж для принтера НР Laser Jet 3050').map((c) => c.model), ['Q2612A'], 'Xerox 3050 — другой аппарат');
  assert.deepEqual(cartridgesForDevice(repo.db, 'Тонер-картридж', [{ name: 'Совместимость', value: 'Совместимый тонер-картридж для МФУ Pantum M6800FDW' }]).length, 2);
  assert.deepEqual(cartridgesForDevice(repo.db, 'Картридж HP 59X для HP LaserJet M404'), [], 'модель картриджа названа — обычный поиск');
  assert.deepEqual(cartridgesForDevice(repo.db, 'Тонер-картридж для МФУ Pantum M7310DN'), [], 'в базе нет — не выдумываем');
});

test('закупка по цене единицы: в предложении о товаре количество — «по заявкам заказчика», а не «[ЗАПОЛНИТЬ]»', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'bids', 'package.js'), 'utf8');
  assert.match(src, /по заявкам заказчика в пределах цены контракта/);
  assert.equal((src.match(/qtyText\(it\)/g) || []).length, 2);
});

test('характеристики со страницы: обрывок тега посреди значения отрезается, пары с разметкой не берутся', () => {
  const html = '<table><tr><td>Модель</td><td>300.3У <div class="flexbox flexbox--row two_col</td></tr><tr><td>Ширина</td><td>800 мм</td></tr>'
    + '<tr><td>Глубина</td><td>400 мм</td></tr><tr><td>ID <span class="x</td><td>42515</td></tr><tr><td>Высота</td><td>1800 мм</td></tr></table>';
  const specs = specsFromPage(html);
  assert.equal(specs.find((s) => s.name === 'Модель').value, '300.3У');
  assert.ok(specs.every((s) => !/<|class=/.test(`${s.name} ${s.value}`)));
});

test('единицы в заявке: ГБ переводятся в Мбайт ТЗ, листы не подставляются в «шт», ресурс «шт.» и «стр.» — одно и то же', () => {
  const off = (name, value) => ({ title: 'x', specs: [{ name, value }], rows: [] });
  const row = (c, o) => C.rowOf(c, { offer: o });
  assert.equal(row({ name: 'Объем установленной оперативной памяти', value: 'не менее 1024 Мбайт', unit: 'Мбайт', fill: 'concrete' }, off('Объем установленной оперативной памяти', '1 Гб')).value, '1024 Мбайт');
  assert.equal(row({ name: 'Количество установленных лотков подачи бумаги', value: 'не менее 1 шт', unit: 'шт', fill: 'concrete' }, off('Количество установленных лотков подачи бумаги', 'Лоток: 250 листов')).status, 'pass');
  assert.equal(row({ name: 'Ресурс (при 5% заполнении) стр.', value: '≥ 6000 шт.', fill: 'concrete' }, off('Ресурс', '6000 стр.')).value, '6000');
});

test('сверка чисел: подписанное значение в характеристиках важнее чисел из «Похожих товаров»', () => {
  const { checkNumbers } = require('../server/offers/match');
  const ch = [{ name: 'Размер диагонали', value: '≥ 27' }];
  assert.equal(checkNumbers(ch, 'Essential S3 S24D300GAI\nДиагональ экрана: 24 "; Соотношение 16:9\nПохожие товары Монитор 27 " Exegate').fail.length, 1);
  assert.equal(checkNumbers(ch, 'Монитор Aquarius 27" IPS\nПохожие 24" монитор').ok.length, 1, 'без подписи — как раньше');
});

test('регион по адресу: края, области и республики, когда города нет в списке; «Московский проспект» — не Подмосковье', () => {
  const { regionFromText } = require('../server/offers/logistics');
  assert.equal(regionFromText('Красноярский край, ЗАТО г. Железногорск, ул. Кантатская, д.30'), 24);
  assert.equal(regionFromText('Алтайский край, г. Новоалтайск, ул. Геологов 72'), 22);
  assert.equal(regionFromText('Ленинградская обл., Всеволожский р-н'), 47);
  assert.equal(regionFromText('Республика Татарстан, г. Елабуга'), 16);
  assert.equal(regionFromText('г. Санкт-Петербург, Московский проспект, д. 5'), 78);
  assert.equal(regionFromText('комиссия по закупкам'), null);
});

test('бюджет платного поиска растёт с числом позиций: 4 на позицию, не выше потолка', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server/offers/index.js'), 'utf8');
  assert.match(src, /state\.maxApi = Math\.max\(config\.SEARCH_MAX_API_REQUESTS, Math\.min\(config\.SEARCH_MAX_API_REQUESTS_CAP/);
  const config = require('../server/config');
  const budget = (n) => Math.max(config.SEARCH_MAX_API_REQUESTS, Math.min(config.SEARCH_MAX_API_REQUESTS_CAP, n * config.SEARCH_API_PER_ITEM));
  assert.equal(budget(1), 20);
  assert.equal(budget(13), 52);
  assert.equal(budget(40), 80);
});

test('доставка считается до места поставки из разбора документации, а не до региона заказчика', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server/offers/index.js'), 'utf8');
  assert.match(src, /function destRegion\(tender\)/);
  assert.equal((src.match(/customerRegion: destRegion\(tender\)/g) || []).length, 2);
  assert.doesNotMatch(src, /customerRegion: tender\.region/);
});

test('ресурс голым числом в ТЗ — «не менее»: картридж повышенной ёмкости проходит', () => {
  const { specOf } = require('../server/offers/spec');
  const { checkNumbers } = require('../server/offers/match');
  const spec = specOf({ name: 'Картридж TN-2375', characteristics: [], spec: { identity: { model: 'TN-2375' }, required: [{ name: 'Ресурс', value: '10000', comparator: '=' }] } });
  assert.equal(spec.required[0].value, 'не менее 10000');
  const chars = spec.required.map((r) => ({ name: r.name, value: r.value }));
  assert.equal(checkNumbers(chars, 'Картридж Cactus CS-TN2375-MPS, ресурс 10400 стр.').fail.length, 0);
  assert.equal(checkNumbers(chars, 'Картридж TN-2375, ресурс 2600 стр.').fail.length, 1);
  assert.equal(specOf({ name: 'Монитор', characteristics: [], spec: { required: [{ name: 'Диагональ', value: '27', comparator: '=' }] } }).required[0].value, '27', 'прочее голое число — как было');
});

test('мебель: запрос по настоящему виду из «тип» и размерам Ш×Г×В, а не по названию КТРУ', () => {
  const { queriesFor, plainQuery } = require('../server/offers/sources/yandex-search');
  const { specOf, furnitureSearch } = require('../server/offers/spec');
  const item = { name: 'Стеллаж лабораторный', characteristics: [], spec: { required: [
    { name: 'тип', value: 'Стеллаж лабораторный (тумба медицинская)' }, { name: 'Высота', value: '≥ 900 ≤ 905' },
    { name: 'Глубина', value: '≥ 600 ≤ 605' }, { name: 'Ширина', value: '≥ 1000 ≤ 1005' }] } };
  const spec = specOf(item);
  assert.deepEqual(queriesFor(item, 2, { spec }), ['тумба медицинская 1000x600x900 купить', 'тумба медицинская 1000x600x900 цена']);
  assert.equal(plainQuery(item, spec), 'тумба медицинская 1000x600x900');
  const { specQueries } = require('../server/offers/sources/yandex-search');
  assert.equal(specQueries(item, spec, 1)[0], 'тумба медицинская 1000x600x900 купить', 'и в запросах для позиции без модели');
  assert.deepEqual(furnitureSearch({ required: [{ name: 'Высота', value: 'не менее 750' }, { name: 'Ширина', value: '1200' }, { name: 'Глубина', value: '600' }] }, 'Стол письменный'), { real: null, dims: '1200x600x750' });
  assert.equal(furnitureSearch({ required: [{ name: 'Ресурс', value: '3000' }] }, 'Картридж'), null, 'не мебель — как раньше');
});

test('габариты тройкой «600×600×900 мм» — все три числа видны сверке', () => {
  const { checkUnits } = require('../server/offers/spec');
  const req = [{ name: 'Глубина', value: '≥ 600 ≤ 605', unit: 'мм' }, { name: 'Высота', value: '≥ 900 ≤ 905', unit: 'мм' }, { name: 'Ширина', value: '≥ 1000 ≤ 1005', unit: 'мм' }];
  const r = checkUnits(req, 'Тумба медицинская ТМ-10-МД премиум 600×600×900 мм, колёса 50 мм');
  assert.deepEqual(r.ok, ['Глубина: ≥ 600 ≤ 605', 'Высота: ≥ 900 ≤ 905']);
  assert.equal(r.fail.length, 1, 'ширины 1000 нет — не подходит');
  assert.equal(checkUnits(req, 'Тумба 1000х600х900мм').fail.length, 0);
});

test('характеристики из пунктов списка: «Название: значение» берутся, а тяжёлая вёрстка не вешает разбор', () => {
  const { specsFromPage } = require('../server/offers/product');
  const ok = specsFromPage('<ul><li><b>Цвет:</b> белый</li><li><span>Ширина</span>: 1000 мм</li><li>Высота: <i>900 мм</i></li><li>Материал: металл</li></ul>');
  assert.deepEqual(ok.map((s) => [s.name, s.value]).slice(0, 4), [['Цвет', 'белый'], ['Ширина', '1000 мм'], ['Высота', '900 мм'], ['Материал', 'металл']]);
  // много вложенных тегов без двоеточия и без закрытия — раньше выражение перебирало варианты часами
  const evil = `<ul>${'<li>'.repeat(3)}${'<span class="x"> <b> <i> текст без двоеточия '.repeat(400)}</ul>`.repeat(5);
  const t0 = Date.now();
  specsFromPage(evil);
  assert.ok(Date.now() - t0 < 2000, `разбор занял ${Date.now() - t0} мс`);
});
