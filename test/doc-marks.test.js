// Недочёты разбора для просмотра документа целиком: только этого файла, без повторов, с понятным описанием.
const test = require('node:test');
const assert = require('node:assert/strict');
const { docMarks, sameFile } = require('../server/doc-marks');

const card = {
  groups: [{ fields: [
    { key: 'advance', label: 'Аванс', conflict: true, alternatives: [
      { value: 'не предусмотрен', sources: [{ file: 'Проект контракта.docx', fileId: 7, page: 3, quote: 'Аванс не предусмотрен' }] },
      { value: '30%', sources: [{ file: 'Извещение.pdf', fileId: 8, page: 1, quote: 'аванс 30%' }] }] },
    { key: 'subject', label: 'Предмет', status: 'found', sources: [{ file: 'Проект контракта.docx', fileId: 7, page: 1, quote: 'Поставка' }] },
  ] }],
  risks: [{ explanation: 'Короткий срок поставки', sources: [{ file: 'Проект контракта.docx', fileId: 7, page: 5, quote: 'в течение 3 дней' }] }],
  legal: { issues: [{ condition: 'Двойное основание расторжения', why: 'возмещение ущерба — не основание', sources: [{ file: 'Проект контракта.docx', fileId: 7, page: 5, quote: 'в течение 3 дней' }] }] },
};

test('недочёты: только этого файла, по страницам, одна цитата — одна отметка с объединённым описанием', () => {
  const m = docMarks(card, 7, 'Проект контракта.docx');
  assert.deepEqual(m.map((x) => [x.page, x.kind]), [[3, 'conflict'], [5, 'risk']]);
  assert.match(m[0].text, /«Аванс» указано в документах по-разному: «не предусмотрен» \/ «30%»/);
  assert.match(m[1].text, /Короткий срок поставки\nДвойное основание расторжения\. Почему: возмещение ущерба/);
  assert.deepEqual(m[1].kinds, ['risk', 'legal']);
  assert.equal(m[1].title, 'Риск, Правовой вопрос');
  assert.equal(docMarks(card, 8, 'Извещение.pdf').length, 1);
  assert.equal(docMarks(null, 7, 'x').length, 0);
  // найденное без недочёта (предмет закупки) не отмечается
  assert.ok(!m.some((x) => x.quote === 'Поставка'));
});

test('файл без номера узнаётся по имени, в том числе с путём архива', () => {
  assert.equal(sameFile({ file: 'docs.zip/+Проект контракта.docx' }, 7, 'Проект контракта.docx'), true);
  assert.equal(sameFile({ file: 'Извещение.pdf' }, 7, 'Проект контракта.docx'), false);
  assert.equal(sameFile({ file: 'Проект контракта.docx', fileId: 8 }, 7, 'Проект контракта.docx'), false, 'номер файла важнее имени');
});
