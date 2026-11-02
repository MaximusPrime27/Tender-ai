// Добор характеристик предложения из своей базы товаров: только точная модель, без чужого бренда и спорных значений.
const test = require('node:test');
const assert = require('node:assert/strict');
const { baseSpecsFor } = require('../server/offers/base-enrich');

const card = { id: 7, brand: 'Pantum', model: 'TL-5120X', title: 'Картридж Pantum TL-5120X', kind: 'cartridge',
  specs: [{ name: 'Ресурс', value: '15000 стр.', from: 'сайт производителя' }, { name: 'Цвет', value: 'черный' }, { name: 'Оригинальность', value: 'оригинал' }, { name: 'Страна', value: 'Китай' }, { name: 'Технология печати', value: 'лазерная' }] };
const base = (over = {}) => ({ findModel: () => ({ id: 7, kind: over.kind || 'cartridge', niche: 'cartridges', model: 'TL-5120X' }), get: () => card });
const db = (conflicts = []) => ({ prepare: () => ({ all: () => conflicts }) });
const kindOfReal = require('../server/offers/product-base').kindOf;

test('своя база: дописываются только недостающие характеристики, без оригинальности, страны и спорных', () => {
  const kind = kindOfReal('Картридж Pantum TL-5120X');
  assert.ok(kind, 'вид товара узнаётся');
  const offer = { title: 'Картридж Pantum TL-5120X черный', specs: [{ name: 'Цвет', value: 'черный' }] };
  const r = baseSpecsFor({ productBase: base({ kind: kind.id }), db: db([{ name: 'Технология печати' }]), offer, item: { name: 'Картридж' } });
  const names = r.specs.map((x) => x.name);
  assert.deepEqual(names, ['Цвет', 'Ресурс']);
  assert.match(r.specs[1].src, /своя база/);
});

test('своя база: совместимый картридж другого бренда под модель оригинала — не берём; другой вид товара — не берём', () => {
  const kind = kindOfReal('Картридж Pantum TL-5120X');
  assert.equal(baseSpecsFor({ productBase: base({ kind: kind.id }), db: db(), offer: { title: 'Картридж EasyPrint LPM-TL-5120X совместимый', specs: [] }, item: { name: 'Картридж' } }), null);
  assert.equal(baseSpecsFor({ productBase: base({ kind: 'other-kind' }), db: db(), offer: { title: 'Картридж Pantum TL-5120X', specs: [] }, item: { name: 'Картридж' } }), null);
});

test('сверка без нейросети видит таблицу характеристик, а не только текст страницы', async () => {
  const { matchOffer } = require('../server/offers/match');
  const item = { name: 'Тумба для оргтехники', characteristics: [{ name: 'Материал корпуса', value: 'ЛДСП' }, { name: 'Назначение', value: 'Для оргтехники' }] };
  const offer = { title: 'Тумба ТС 06-01', text: 'Тумба. Цена 5 000 руб.', specs: [{ name: 'Материал корпуса', value: 'ЛДСП' }, { name: 'Назначение', value: 'для оргтехники', src: 'своя база: сайт производителя' }] };
  const r = await matchOffer(item, offer, {});
  assert.equal(r.checks.unknown, 0, JSON.stringify(r.checks.rows));
});

test('условия поставки (остаточный срок годности, доставка) не мешают «соответствует» и видны отдельно', async () => {
  const { matchOffer } = require('../server/offers/match');
  const item = { name: 'Перчатки смотровые', characteristics: [{ name: 'Материал', value: 'Нитрил' }, { name: 'Остаточный срок годности на момент поставки', value: 'не менее 80% от общего срока годности' }, { name: 'Доставка', value: 'до склада заказчика' }] };
  const r = await matchOffer(item, { title: 'Перчатки смотровые нитриловые', text: 'Материал: нитрил. Цена 500 руб.', specs: [{ name: 'Материал', value: 'нитрил' }] }, {});
  assert.equal(r.match, 'соответствует', JSON.stringify(r));
  assert.deepEqual(r.checks.supply.length, 2);
  assert.ok(r.notes.some((n) => /подтверждает поставщик/.test(n)));
});

test('аккумуляторы и медицина: карточка — бренд + модель; размер и стандарт без бренда моделью не считаются', () => {
  const { brandGuess, badModel } = require('../server/offers/product-base');
  assert.equal(brandGuess('Аккумулятор GIVER HYBRID 6CT-60L', [], '6CT-60L'), 'GIVER');
  assert.equal(brandGuess('Аккумулятор РУССКАЯ ЗВЕЗДА 6СТ-75NR оп 75 Ач', [], '6СТ-75NR'), 'РУССКАЯ ЗВЕЗДА');
  assert.equal(brandGuess('Мочеприемник 2000 мл', [{ name: 'Производитель', value: 'ООО «Медплант»' }]), 'Медплант');
  for (const m of ['90х25мм', 'ch18', '22G', '60Ah', '5 мл']) assert.equal(badModel(m), true, m);
  assert.equal(badModel('HZY12-100'), false);
});
