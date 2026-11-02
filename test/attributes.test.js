// Словарь характеристик: синонимы названий и значений (RAM — оперативная память, Wired — проводная), сверка по таблице
// характеристик без нейросети; модель принтера в ТЗ у картриджа; «undefined» вместо пустого значения.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bySpecs, applySpecs } = require('../server/offers/attributes');
const { fitsNumeric, matchOffer } = require('../server/offers/match');
const { specOf, sameProductDet } = require('../server/offers/spec');
const { applyRules } = require('../server/offers/match-rules');

const v = (name, need, specs, title = '') => bySpecs({ name, need }, specs, title, { fitsNumeric })?.verdict ?? null;

test('синонимы названий и значений: проводная/Wired, лазерная/«картридж лазерный», RAM, SSD, раскладка, тип клавиатуры', () => {
  assert.equal(v('Тип подключения', 'Проводная', [{ name: 'Wired/Wireless', value: 'Wired' }]), 'yes');
  assert.equal(v('Тип печати', 'Электрографическая', [{ name: 'Вид товара', value: 'Картридж лазерный' }]), 'yes');
  assert.equal(v('Объем оперативной памяти', 'не менее 16 ГБ', [{ name: 'RAM', value: '16 GB' }]), 'yes');
  assert.equal(v('Тип накопителя', 'SSD', [{ name: 'Накопитель', value: 'твердотельный 512 Гб' }]), 'yes');
  assert.equal(v('Раскладка клавиатуры', 'QWERTY / ЙЦУКЕН', [{ name: 'Раскладка', value: 'русская/английская' }]), 'yes');
  assert.equal(v('Тип', 'Полноразмерная', [{ name: 'Keyboard Type', value: 'Standard' }]), 'yes');
});

test('«не подходит» — только по проверяемому факту: другой цвет, ресурс меньше; упаковка и брутто не в счёт', () => {
  assert.equal(v('Цвет печати', 'Черный', [{ name: 'Цвет', value: 'голубой' }]), 'no');
  assert.equal(v('Количество отпечатков', '≥ 25000', [{ name: 'Максимальный ресурс страниц', value: '13000 страниц' }]), 'no');
  assert.equal(v('Вес', 'не более 1 кг', [{ name: 'Вес брутто', value: '1.5 кг' }]), null);
  assert.equal(v('Материал столешницы', 'ЛДСП', [{ name: 'Материал столешницы', value: 'МДФ' }]), 'no');
});

test('значение из названия товара: «совместимый для Kyocera», «Black»; бренд Hi-Black — не цвет', () => {
  assert.equal(v('оригинальность', 'совместимый', [], 'Тонер-картридж TK-5290K совместимый для Kyocera'), 'yes');
  assert.equal(v('Цвет печати', 'Черный', [], 'Картридж Катюша THM247 Black'), 'yes');
  assert.equal(v('Цвет печати', 'Черный', [], 'Тонер-картридж Hi-Black (HB-TK-5290C) для Kyocera'), null);
});

test('свойства нет в словаре — строка с тем же названием: число и слова требования', () => {
  assert.equal(v('Ширина сиденья', 'не менее 400 мм', [{ name: 'Ширина сиденья', value: '420 мм' }]), 'yes');
  assert.equal(v('Ширина сиденья', 'не менее 400 мм', [{ name: 'Ширина сиденья', value: '380 мм' }]), 'no');
  assert.equal(v('Покрытие каркаса', 'порошковая краска', [{ name: 'Покрытие каркаса', value: 'полимерное порошковое' }]), 'yes');
});

test('таблица противоречит «да» нейросети — противоречие, а не молчаливое «да»', () => {
  const rows = [{ name: 'Цвет печати', need: 'Черный', verdict: 'yes', found: 'черный' }];
  applySpecs(rows, [{ name: 'Цвет', value: 'голубой' }], '', { fitsNumeric });
  assert.equal(rows[0].verdict, 'conflict');
});

test('сверка товара: недостающее нейросетью закрывает таблица характеристик (без нейросети)', async () => {
  const llm = { complete: async () => ({ text: JSON.stringify({ kind: true, checks: { 1: '?', 2: '?' } }) }) };
  const r = await matchOffer({ name: 'Клавиатура', characteristics: [{ name: 'Тип подключения', value: 'Проводная' }, { name: 'Раскладка клавиатуры', value: 'QWERTY / ЙЦУКЕН' }] },
    { title: 'Клавиатура A4Tech KR-750', text: 'Клавиатура. Характеристики: Wired/Wireless: Wired; Раскладка: русская/английская', specs: [{ name: 'Wired/Wireless', value: 'Wired' }, { name: 'Раскладка', value: 'русская/английская' }] }, { llm, system: 'm' });
  assert.equal(r.checks.confirmed, 2);
  assert.match(r.checks.rows[0].method, /таблица характеристик/);
});

test('нейросеть отказала (модерация) — доказанное таблицей всё равно подтверждается, остальное «не проверено»', async () => {
  const llm = { retryDelayMs: 0, complete: async () => { throw new Error('ответ не по схеме'); } };
  const r = await matchOffer({ name: 'Картридж', characteristics: [{ name: 'Цвет печати', value: 'Голубой' }, { name: 'Количество отпечатков', value: '≥ 13000' }, { name: 'оригинальность', value: 'совместимый' }, { name: 'Наличие чипа', value: 'да' }] },
    { title: 'Тонер-картридж Hi-Black (HB-TK-5290C)', text: 'Цвет: голубой. Максимальный ресурс страниц: 13000 страниц', specs: [{ name: 'Цвет', value: 'голубой' }, { name: 'Максимальный ресурс страниц', value: '13000 страниц' }, { name: 'Время выхода первого отпечатка', value: '≤5.9 сек' }] }, { llm, system: 'm' });
  const by = Object.fromEntries(r.checks.rows.map((x) => [x.name, x.verdict]));
  // Hi-Black делает только совместимые картриджи — бренд в названии это доказывает
  assert.deepEqual(by, { 'Цвет печати': 'yes', 'Количество отпечатков': 'yes', 'оригинальность': 'yes', 'Наличие чипа': 'unknown' });
  // нейросеть не ответила — на требования отвечают правила; про чип на странице ничего нет
  assert.match(r.checks.rows[3].found, /нейросеть не ответила|не указано/);
});

test('картридж: модель принтера из ТЗ — совместимость, а не модель картриджа; «undefined» — пусто', () => {
  const item = { name: 'Картридж для электрографических печатающих устройств', characteristics: [{ name: 'совместимость', value: 'Катюша М240' }],
    spec: { identity: { model: 'М240', brand: 'Катюша', compatible_with: 'undefined', standard: 'undefined' }, required: [] } };
  const s = specOf(item);
  assert.equal(s.identity.model, null);
  assert.equal(s.identity.compatible_with, 'Катюша М240');
  assert.equal(s.identity.standard, null);
  assert.notEqual(sameProductDet(s, 'Картридж Катюша TK240A').verdict, 'different');
  assert.equal(specOf({ name: 'Картридж', characteristics: [], spec: { identity: { model: 'undefined' }, required: [] } }).identity.model, null);
});

test('оригинальный картридж: «совместимые принтеры» на странице не делают его совместимым', () => {
  const one = (title, text) => { const rows = [{ name: 'оригинальность', need: 'оригинальный', verdict: 'unknown', found: '' }]; applyRules(rows, text, { title }); return rows[0].verdict; };
  assert.equal(one('Оригинальный тонер-картридж Kyocera TK-3430', 'Совместимые картриджи: G&G, NetProduct'), 'yes');
  assert.equal(one('Картридж Катюша TK240A Black', 'Похожие товары: картридж совместимый NV Print'), 'yes');
  assert.equal(one('Картридж G&G GG-TK3430', 'Тип: совместимый'), 'no');
  assert.equal(one('Картридж для Kyocera TK-3430', 'Оригинальный картридж. Также есть совместимые аналоги'), 'conflict');
});

test('ёмкость картриджа: H у Canon/Ricoh и X у HP в модели — повышенная; «стандартной» — не подходит; ёмкость батареи — не то', () => {
  assert.equal(v('Емкость', 'Повышенная', [], 'Картридж Cactus M C2000H 842451 (CS-MC2000HY)'), 'yes');
  assert.equal(v('Емкость', 'Повышенная', [], 'Лазерный картридж Cactus CS-CE255X-MPS'), 'yes');
  assert.equal(v('Емкость', 'Повышенная', [], 'Картридж 069 стандартной емкости'), 'no');
  assert.equal(v('Емкость', 'Повышенная', [], 'Монитор 1920x1080'), null);
  assert.equal(v('Емкость батареи', '≥ 56', [], 'Ноутбук 15.6 X1502VA'), null);
});
