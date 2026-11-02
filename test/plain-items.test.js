const test = require('node:test');
const assert = require('node:assert/strict');
const { withTabTables, singleProduct, tabTablesToPipes } = require('../server/tenders/plain-items');
const { itemsFromTables, pickItems } = require('../server/tenders/rule-items');

// как отдаёт старый .doc: ячейки через табуляцию, перенос внутри ячейки рвёт строку (закупка MANUAL-20261030-1)
const DOC = `Технические характеристики и параметры поставляемых картриджей:
№ п/п\tНаименование картриджа\tСовместимость (модели принтеров/МФУ)\tЕд. изм.\tКол-во\tМинимальный ресурс печати\t
1.\tПринт-картридж
(054(Н), Black) \tCanon LBP 623Cdw i-Sensys\tшт.\t1\t3 100\t
2.\tПринт-картридж
(737)\tCanon i-Sensys MF217w\tшт.\t2\t8 000\t
3.\tДрам-картридж (фотобарабан) (DO-428)\tPANTUM M7108DN/RU\tшт.\t3\t30 000\t

Требования к качеству:
Картриджи должны быть новыми.`;

test('таблица старого .doc читается без нейросети: все позиции, перенос в ячейке склеен', () => {
  const docs = [withTabTables({ name: 'ТЗ.doc', pages: [{ page: 1, text: DOC }] })];
  const { items } = pickItems(itemsFromTables(docs).items);
  assert.equal(items.length, 3);
  assert.match(items[0].name, /Принт-картридж \(054\(Н\), Black\)/);
  assert.equal(items[1].quantity, 2);
  assert.equal(items[2].quantity, 3);
  assert.equal(items[0].unit, 'шт');
});

test('текст без таблицы не меняется', () => {
  assert.equal(tabTablesToPipes('Первый\tвторой\nтретий'), 'Первый\tвторой\nтретий');
});

test('лист характеристик одного товара: название и подписи со значениями, разделы пропущены', () => {
  const text = 'Характеристики FNIRSI 2C53P\nОбщие данные\nПроизводитель (бренд)\nFNIRSI\nМодель (серия)\n2C53P\nОсновные характеристики\nПолоса пропускания, МГц\n50\nТип\nцифровой запоминающий (DSO)';
  const [item] = singleProduct([{ name: 'х.docx', pages: [{ page: 1, text }] }]);
  assert.equal(item.name, 'FNIRSI 2C53P');
  assert.deepEqual(item.characteristics.map((c) => c.name), ['Производитель (бренд)', 'Модель (серия)', 'Полоса пропускания, МГц', 'Тип']);
  assert.equal(item.characteristics[2].value, '50');
});

test('карточка площадки: предмет закупки становится позицией, общие слова — нет', () => {
  const page = (s) => [{ name: 'а.htm', pages: [{ page: 1, text: `Номер | 1\nНаименование закупки (предмет контракта) | ${s}\nСпособ закупки | сессия` }] }];
  assert.equal(singleProduct(page('Закупка осциллографа-мультиметра FNiRSi 2C53P для лаборатории 241.'))[0].name, 'осциллографа-мультиметра FNiRSi 2C53P для лаборатории 241');
  assert.equal(singleProduct(page('Поставка расходных материалов для нужд университета')).length, 0);
});

test('читатель понимает карточку площадки: предмет, цена, срок подачи, заказчик', () => {
  const { EXTRACTORS } = require('../server/analyze/rules');
  const text = `Дата и время окончания подачи предложений (по МСК) | 02.11.2026 17:00
Наименование организации | ИАП РАН
ИНН организации | 7809003600
Наименование закупки (предмет контракта) | Закупка осциллографа FNiRSi 2C53P
Стартовая цена / максимальная цена, руб | 13115.00`;
  const docs = [{ name: 'а.htm', pages: [{ page: 1, text }] }];
  assert.match(EXTRACTORS.subject(docs).value, /осциллографа/);
  assert.match(EXTRACTORS.bid_deadline(docs).value, /02.11.2026 17:00/);
  assert.match(EXTRACTORS.customer(docs).value, /ИАП РАН, ИНН 7809003600/);
  assert.match(EXTRACTORS.nmck(docs).value, /13.115/);
});
