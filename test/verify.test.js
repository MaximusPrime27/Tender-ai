const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteInText, verifySource } = require('../server/analyze/verify');

const docs = [
  { id: 1, name: 'lot.zip/Извещение.pdf', pages: [
    { page: 1, text: 'Начальная (максимальная) цена контракта:\n1 250 000,00 рублей.' },
    { page: 2, text: 'Срок поставки товара: в течение 10 кален-\nдарных дней с даты заключения контракта.' },
  ] },
  { id: 2, name: 'lot.zip/Проект_контракта.docx', pages: [
    { page: 1, text: '4.1. Пеня в размере 0,5 % от цены контракта за каждый день просрочки.' },
  ] },
];

test('цитата с другими пробелами, переносами строк и регистром подтверждается', () => {
  assert.equal(quoteInText('начальная (максимальная) цена контракта: 1 250 000,00 рублей', docs[0].pages[0].text), true);
  assert.equal(quoteInText('в течение 10 календарных дней', docs[0].pages[1].text), true);
});

test('выдуманная цитата не подтверждается', () => {
  const r = verifySource({ file: 'lot.zip/Извещение.pdf', page: 1, quote: 'цена контракта: 2 000 000,00 рублей' }, docs);
  assert.equal(r.verified, false);
});

test('слишком короткая цитата не считается подтверждением', () => {
  assert.equal(quoteInText('10', docs[0].pages[1].text), false);
});

test('цитата с многоточием: части ищутся по порядку', () => {
  assert.equal(quoteInText('Пеня в размере 0,5 % … за каждый день просрочки', docs[1].pages[0].text), true);
  assert.equal(quoteInText('за каждый день просрочки … Пеня в размере 0,5 %', docs[1].pages[0].text), false);
});

test('верная цитата с неправильным номером страницы: ссылка исправляется', () => {
  const r = verifySource({ file: 'lot.zip/Извещение.pdf', page: 1, quote: 'Срок поставки товара: в течение 10 календарных дней' }, docs);
  assert.equal(r.verified, true);
  assert.equal(r.page, 2);
  assert.equal(r.fileId, 1);
});

test('короткое имя файла без пути архива сопоставляется с документом', () => {
  const r = verifySource({ file: 'Проект_контракта.docx', page: 1, quote: 'Пеня в размере 0,5 % от цены контракта' }, docs);
  assert.equal(r.verified, true);
  assert.equal(r.file, 'lot.zip/Проект_контракта.docx');
  assert.equal(r.fileId, 2);
});

test('пустая цитата — не подтверждена', () => {
  assert.equal(verifySource({ file: 'Извещение.pdf', page: 1, quote: '' }, docs).verified, false);
});
