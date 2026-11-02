// Мебель в базе товаров (пакет мебели Quod): модель из названия мебели, запреты смысловых подмен материалов —
// ЛДСП и МДФ, ПВХ и ABS, натуральная кожа и экокожа (никакая «близость» не делает их одним и тем же).

const test = require('node:test');
const assert = require('node:assert/strict');
const { furnitureModel } = require('../server/offers/maker-search');
const { checkTraits } = require('../server/offers/traits');

test('модель мебели из названия: номер с буквами, латиница, заглавные; описание и бренд-слово перед номером — не модель', () => {
  assert.equal(furnitureModel('Кресло руководителя CHAIRMAN 523'), 'CHAIRMAN 523');
  assert.equal(furnitureModel('Стол ученический 111РВ регулируемый'), '111РВ');
  assert.equal(furnitureModel('Шкаф для одежды ШР-22 L500'), 'ШР-22 L500');
  assert.equal(furnitureModel('Стул ИЗО черный'), 'ИЗО');
  assert.equal(furnitureModel('Стол медицинский ФЕРРОПЛАСТ СММП-08-Я-ФП-03-08'), 'СММП-08-Я-ФП-03-08');
  assert.equal(furnitureModel('Кровать 2-х ярусная КМ-2'), 'КМ-2');
  assert.equal(furnitureModel('Парта школьная 2-местная'), null);
  assert.equal(furnitureModel('Тумба мобильная 3 ящика'), null);
});

test('материалы мебели не подменяют друг друга: столешница, корпус, кромка, обивка; «или» в ТЗ — не проверяется жёстко', () => {
  const check = (item, name, value, text) => checkTraits(item, [{ name, value }], { title: '', text });
  const tabletop = check('Стол письменный', 'Материал столешницы', 'ЛДСП толщиной 22 мм', 'Материал столешницы: МДФ 25 мм. Корпус: ЛДСП');
  assert.equal(tabletop.conflicts.length, 1);
  assert.equal(tabletop.conflicts[0].got_label, 'МДФ');
  assert.equal(check('Стол письменный', 'Материал столешницы', 'ЛДСП', 'Столешница: ЛДСП 22 мм').agreed.length, 1);
  // столешница из МДФ не мешает корпусу из ЛДСП
  assert.deepEqual(check('Стол письменный', 'Материал корпуса', 'ЛДСП', 'Материал столешницы: МДФ; Корпус: ЛДСП 16 мм').conflicts, []);
  assert.equal(check('Тумба приставная', 'Кромка', 'ПВХ 2 мм', 'Кромка: ABS 2 мм').conflicts[0].got_label, 'ABS');
  assert.equal(check('Кресло руководителя', 'Обивка', 'натуральная кожа', 'Обивка: экокожа').conflicts[0].got_label, 'экокожа (искусственная кожа)');
  assert.equal(check('Кресло офисное', 'Материал обивки', 'ткань или сетка', 'Материал обивки: сетка').agreed.length, 1);
  const either = check('Стол письменный', 'Материал столешницы', 'ЛДСП или МДФ', 'Столешница: МДФ');
  assert.deepEqual([either.conflicts.length, either.agreed.length], [0, 0], 'в ТЗ два допустимых материала — решает общая сверка');
  // к компьютерам мебельные признаки не относятся
  assert.deepEqual(check('Системный блок', 'Материал корпуса', 'ЛДСП', 'Корпус: металл').conflicts, []);
});
