const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const XLSX = require('xlsx');
const { extractFile, splitFragments } = require('../server/extract');
const { makePdf, makeDocx, NOTICE_PAGES, CONTRACT } = require('../samples/make-samples');

test('PDF: текст извлекается постранично с правильными номерами страниц', async () => {
  const buffer = await makePdf(NOTICE_PAGES);
  const [f] = await extractFile({ name: 'Извещение.pdf', buffer });
  assert.equal(f.status, 'ok');
  assert.equal(f.pages.length, 3);
  assert.deepEqual(f.pages.map((p) => p.page), [1, 2, 3]);
  assert.match(f.pages[0].text, /Начальная \(максимальная\) цена контракта/);
  assert.match(f.pages[1].text, /10 календарных дней/);
  assert.match(f.pages[2].text, /№ 1875/);
  assert.doesNotMatch(f.pages[0].text, /10 календарных дней/);
});

test('PDF без текстового слоя помечается как скан', async () => {
  const { PDFDocument } = require('pdf-lib');
  const { addScanPage } = require('../samples/make-samples');
  const doc = await PDFDocument.create();
  await addScanPage(doc);
  await addScanPage(doc);
  const [f] = await extractFile({ name: 'scan.pdf', buffer: Buffer.from(await doc.save()) });
  assert.equal(f.status, 'scan_no_text');
  assert.equal(f.pages.length, 0);
});

test('DOCX: текст извлекается, фрагменты нумеруются с 1', async () => {
  const [f] = await extractFile({ name: 'Контракт.docx', buffer: makeDocx(CONTRACT) });
  assert.equal(f.status, 'ok');
  assert.equal(f.pages[0].page, 1);
  assert.match(f.pages[0].text, /0,5 % от цены контракта/);
});

test('XLSX: все листы попадают в текст', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Наименование', 'Кол-во'], ['МФУ', 25]]), 'Спецификация');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['НМЦК', 1250000]]), 'Расчёт');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const [f] = await extractFile({ name: 'spec.xlsx', buffer });
  assert.equal(f.status, 'ok');
  const all = f.pages.map((p) => p.text).join('\n');
  assert.match(all, /Лист «Спецификация»/);
  assert.match(all, /МФУ \| 25/);
  assert.match(all, /Лист «Расчёт»/);
});

test('ZIP: рекурсивно раскрывается, вложенные файлы получают путь в имени', async () => {
  const inner = new AdmZip();
  inner.addFile('ТЗ.docx', makeDocx(['Техническое задание', 'Товарный знак: «Kyocera».']));
  const outer = new AdmZip();
  outer.addFile('Извещение.pdf', await makePdf([['Извещение о закупке № 0373100000126000042 на поставку оборудования']]));
  outer.addFile('docs.zip', inner.toBuffer());
  outer.addFile('Подпись.sig', Buffer.from('signature'));
  for (const e of outer.getEntries()) e.header.flags |= 0x800;

  const files = await extractFile({ name: 'lot.zip', buffer: outer.toBuffer() });
  const byName = Object.fromEntries(files.map((f) => [f.name, f]));
  assert.equal(byName['lot.zip/Извещение.pdf'].status, 'ok');
  assert.equal(byName['lot.zip/Извещение.pdf'].pages[0].page, 1);
  assert.equal(byName['lot.zip/docs.zip/ТЗ.docx'].status, 'ok');
  assert.match(byName['lot.zip/docs.zip/ТЗ.docx'].pages[0].text, /Kyocera/);
  assert.equal(byName['lot.zip/Подпись.sig'].status, 'unsupported');
});

test('ZIP с именами в CP866 (как из ЕИС) читается без кракозябр', async () => {
  const zip = new AdmZip();
  zip.addFile('XX.docx', makeDocx(['Текст']));
  // Подменяем байты имени на «ТЗ» в CP866 (Т=0x92, З=0x87) в локальном и центральном заголовках.
  const buf = zip.toBuffer();
  const needle = Buffer.from('XX.docx');
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + 1)) {
    buf[i] = 0x92;
    buf[i + 1] = 0x87;
  }
  const files = await extractFile({ name: 'a.zip', buffer: buf });
  assert.equal(files[0].name, 'a.zip/ТЗ.docx');
});

test('RAR и 7z помечаются unsupported, битый DOC — error, а не падение', async () => {
  const rar = await extractFile({ name: 'x.rar', buffer: Buffer.from('Rar!\x1a\x07\x00', 'latin1') });
  assert.equal(rar[0].status, 'unsupported');
  const sevenZ = await extractFile({ name: 'x.7z', buffer: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]) });
  assert.equal(sevenZ[0].status, 'unsupported');
  const doc = await extractFile({ name: 'x.doc', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]) });
  assert.equal(doc[0].status, 'error');
});

test('Битый DOCX даёт статус error, а не исключение', async () => {
  const [f] = await extractFile({ name: 'bad.docx', buffer: Buffer.from('PK\x03\x04garbage', 'latin1') });
  assert.equal(f.status, 'error');
});

test('splitFragments режет по абзацам и не теряет текст', () => {
  const text = Array.from({ length: 50 }, (_, i) => `Абзац ${i} ` + 'x'.repeat(200)).join('\n');
  const pages = splitFragments(text, 1000);
  assert.ok(pages.length > 5);
  assert.ok(pages.every((p) => p.text.length <= 1000));
  assert.equal(pages.map((p) => p.text).join('\n'), text);
});

test('RTF: кириллица в байтах (cp1251) и Юникоде, служебные группы пропускаются; RTF под расширением .doc', async () => {
  const rtf = Buffer.from(String.raw`{\rtf1\ansi\ansicpg1251{\fonttbl{\f0 Times;}}{\*\generator Word;}{\pict 0102}\pard \'cc\'ee\'ed\'e8\'f2\'ee\'f0 24\cell \u1044\'3f\u1072?\par \'c4\'e8\'e0\'e3\'ee\'ed\'e0\'eb\'fc\par}`, 'latin1');
  const [f] = await extractFile({ name: 'ТЗ.doc', buffer: rtf });
  assert.equal(f.status, 'ok');
  assert.equal(f.mime, 'application/rtf');
  assert.equal(f.pages[0].text, 'Монитор 24\tДа\nДиагональ');
});
