// Генерирует синтетический комплект закупки samples/sample-44fz.zip:
//   Извещение.pdf (3 страницы), Проект_контракта.docx, ТЗ.docx.
// Намеренно заложенные риски (эталон для проверки анализа):
//   1) срок поставки в извещении (10 дней) и в контракте (30 дней) различается;
//   2) пени 0,5% в день — выше обычного;
//   3) оплата через 30 рабочих дней;
//   4) товарный знак без «или эквивалент».

const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const OUT = __dirname;
const FONT_CANDIDATES = ['C:\\Windows\\Fonts\\arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/Library/Fonts/Arial.ttf'];

const NOTICE_PAGES = [
  [
    'ИЗВЕЩЕНИЕ О ПРОВЕДЕНИИ ЭЛЕКТРОННОГО АУКЦИОНА',
    'Извещение о закупке № 0373100000126000042.',
    'Закупка осуществляется в соответствии с Федеральным законом от 05.04.2013 № 44-ФЗ.',
    'Способ определения поставщика: электронный аукцион.',
    'Заказчик: ГБУ города Москвы «Городская поликлиника № 7», ИНН 7701234567.',
    'Объект закупки: поставка многофункциональных устройств для нужд поликлиники.',
    'Код по ОКПД2: 26.20.18.000 «Устройства периферийные с двумя или более функциями».',
    'Начальная (максимальная) цена контракта: 1 250 000,00 рублей.',
    'Валюта: российский рубль.',
  ],
  [
    'Дата и время окончания срока подачи заявок: 29.09.2026 09:00 (МСК).',
    'Дата подведения итогов определения поставщика: 01.10.2026.',
    'Место поставки товара: г. Москва, ул. Лесная, д. 12.',
    'Срок поставки товара: в течение 10 календарных дней с даты заключения контракта.',
    'Размер обеспечения заявки: 1 % от НМЦК, что составляет 12 500,00 рублей.',
    'Размер обеспечения исполнения контракта: 10 % от цены контракта.',
    'Обеспечение гарантийных обязательств: 1 % от НМЦК.',
    'Аванс не предусмотрен.',
  ],
  [
    'Требования к участникам закупки: единые требования согласно ч. 1 ст. 31 Закона № 44-ФЗ.',
    'Заявка должна содержать: предложение о цене контракта, характеристики предлагаемого товара, документы, подтверждающие страну происхождения товара.',
    'Национальный режим: применяется ограничение в соответствии с постановлением Правительства РФ от 23.12.2024 № 1875.',
    'Критерии оценки заявок: не применяются, победитель определяется по наименьшей цене.',
  ],
];

const CONTRACT = [
  'ПРОЕКТ КОНТРАКТА № ____ на поставку многофункциональных устройств',
  '1. Предмет контракта',
  '1.1. Поставщик обязуется поставить многофункциональные устройства (далее — Товар) в соответствии со спецификацией, а Заказчик обязуется принять и оплатить Товар.',
  '2. Цена контракта и порядок оплаты',
  '2.1. Цена контракта является твёрдой и определяется на весь срок исполнения контракта.',
  '2.2. Оплата производится в течение 30 (тридцати) рабочих дней с даты подписания Заказчиком документа о приёмке.',
  '3. Сроки поставки',
  '3.1. Срок поставки Товара: 30 календарных дней с даты заключения контракта.',
  '3.2. Место поставки товара: г. Москва, ул. Лесная, д. 12.',
  '4. Ответственность сторон',
  '4.1. За каждый день просрочки исполнения обязательства Поставщик уплачивает пеню в размере 0,5 % от цены контракта.',
  '4.2. За каждый факт неисполнения обязательств Поставщик уплачивает штраф в размере 10 % от цены контракта.',
  '5. Расторжение контракта',
  '5.1. Заказчик вправе принять решение об одностороннем отказе от исполнения контракта в случае нарушения Поставщиком сроков поставки более чем на 5 дней.',
];

const TZ = [
  'ТЕХНИЧЕСКОЕ ЗАДАНИЕ',
  'Наименование товара: многофункциональное устройство (принтер, сканер, копир).',
  'Количество: 25 штук.',
  'Товарный знак: «Kyocera», модель: «ECOSYS M2540dn».',
  'Формат печати: A4. Скорость печати: не менее 40 страниц в минуту.',
  'Интерфейсы: USB 2.0, Ethernet 10/100/1000.',
  'Гарантийный срок: не менее 12 месяцев с даты подписания документа о приёмке.',
  'Требования к картриджам: допускается применение картриджей производителя устройства или эквивалентных.',
];

function wrap(text, font, size, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

async function makePdf(pages) {
  const fontPath = FONT_CANDIDATES.find((p) => fs.existsSync(p));
  if (!fontPath) throw new Error('Не найден TTF-шрифт с кириллицей (Arial/DejaVuSans)');
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(fontPath), { subset: true });
  const size = 11;
  for (const paragraphs of pages) {
    const page = doc.addPage([595, 842]);
    let y = 790;
    for (const para of paragraphs) {
      for (const line of wrap(para, font, size, 495)) {
        page.drawText(line, { x: 50, y, size, font, color: rgb(0, 0, 0) });
        y -= size * 1.5;
      }
      y -= size * 0.6;
    }
  }
  return Buffer.from(await doc.save());
}

// Картинка 1×1 — «скан»: страница, на которой нет текста, но есть изображение (как у настоящего отсканированного листа).
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
/** Добавить в PDF страницу-скан: изображение на весь лист, текстового слоя нет. */
async function addScanPage(doc) {
  const img = await doc.embedPng(PIXEL_PNG);
  const page = doc.addPage([595, 842]);
  page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  return page;
}
/** PDF из n страниц-сканов (без текстового слоя). */
async function makeScanPdf(n) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) await addScanPage(doc);
  return Buffer.from(await doc.save());
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Минимальный валидный DOCX без внешних библиотек. */
function makeDocx(paragraphs) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'));
  zip.addFile('_rels/.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'));
  // Абзац — строка; таблица — {table: [[ячейка, …], …]}, ячейка — строка или {text, colspan, vmerge: 'start' | 'cont'}
  // (объединение по вертикали: 'start' — первая ячейка, 'cont' — продолжение). Перевод строки в ячейке — новый абзац.
  const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const cellXml = (c) => {
    const o = typeof c === 'string' ? { text: c } : c;
    const pr = `${o.colspan ? `<w:gridSpan w:val="${o.colspan}"/>` : ''}${o.vmerge === 'start' ? '<w:vMerge w:val="restart"/>' : o.vmerge === 'cont' ? '<w:vMerge/>' : ''}`;
    return `<w:tc>${pr ? `<w:tcPr>${pr}</w:tcPr>` : ''}${String(o.text ?? '').split('\n').map(para).join('')}</w:tc>`;
  };
  const body = paragraphs.map((p) => (typeof p === 'string' ? para(p)
    : `<w:tbl>${p.table.map((row) => `<w:tr>${row.map(cellXml).join('')}</w:tr>`).join('')}</w:tbl>`)).join('');
  zip.addFile('word/document.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`));
  return zip.toBuffer();
}

async function main() {
  const notice = await makePdf(NOTICE_PAGES);
  const contract = makeDocx(CONTRACT);
  const tz = makeDocx(TZ);

  const zip = new AdmZip();
  zip.addFile('Извещение.pdf', notice);
  zip.addFile('Проект_контракта.docx', contract);
  zip.addFile('ТЗ.docx', tz);
  // Имена в UTF-8: выставляем флаг, иначе распаковщики прочитают их как CP866.
  for (const e of zip.getEntries()) e.header.flags |= 0x800;
  const zipPath = path.join(OUT, 'sample-44fz.zip');
  zip.writeZip(zipPath);

  // Отдельные файлы — для загрузки по одному и для тестов.
  const dir = path.join(OUT, 'out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Извещение.pdf'), notice);
  fs.writeFileSync(path.join(dir, 'Проект_контракта.docx'), contract);
  fs.writeFileSync(path.join(dir, 'ТЗ.docx'), tz);
  fs.writeFileSync(path.join(dir, 'fake.rar'), Buffer.concat([Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1'), Buffer.alloc(64)]));

  console.log(`Создано: ${zipPath}`);
  console.log(`Отдельные файлы: ${dir}`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { makePdf, makeDocx, makeScanPdf, addScanPage, NOTICE_PAGES, CONTRACT, TZ };
