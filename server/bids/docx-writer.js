// Составление простого документа Word (DOCX) без сторонних библиотек: заголовки, абзацы, таблицы с рамкой.
// Файл собирается из трёх частей пакета OOXML; его открывают Word, LibreOffice и читает сам сервис (server/extract).
// Блоки: {h: 'заголовок'} | {p: 'абзац', bold, italic, align: 'center'|'right'} | {table: [[ячейка, …], …], header: true, widths: [доли]}
//        | {space: true}. Перевод строки в тексте — новый абзац внутри того же блока или ячейки.

const AdmZip = require('adm-zip');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const FONT = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>';

function run(text, { bold = false, italic = false, size = 24 } = {}) {
  return `<w:r><w:rPr>${FONT}${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
function para(text, o = {}) {
  const pr = `<w:pPr>${o.align ? `<w:jc w:val="${o.align}"/>` : ''}<w:spacing w:after="${o.after ?? 120}"/></w:pPr>`;
  return String(text ?? '').split('\n').map((line) => `<w:p>${pr}${run(line, o)}</w:p>`).join('');
}
function table(rows, { header = true, widths = null } = {}) {
  const cols = Math.max(...rows.map((r) => r.length), 1);
  // ширины колонок — доли от ширины таблицы (по умолчанию поровну)
  const share = (c) => (widths && widths.length === cols ? widths[c] / widths.reduce((s, w) => s + w, 0) : 1 / cols);
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
  const tblPr = `<w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders></w:tblPr>`;
  const grid = `<w:tblGrid>${Array.from({ length: cols }, (_, c) => `<w:gridCol w:w="${Math.floor(9000 * share(c))}"/>`).join('')}</w:tblGrid>`;
  const body = rows.map((r, i) => `<w:tr>${Array.from({ length: cols }, (_, c) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(5000 * share(c))}" w:type="pct"/></w:tcPr>${para(r[c] ?? '', { bold: header && i === 0, size: 22, after: 40 })}</w:tc>`).join('')}</w:tr>`).join('');
  return `<w:tbl>${tblPr}${grid}${body}</w:tbl>${para('', { after: 60 })}`;
}

/** @param blocks список блоков (см. начало файла) @returns Buffer с файлом DOCX */
function makeDocx(blocks) {
  const body = blocks.map((b) => {
    if (b.h != null) return para(b.h, { bold: true, size: 28, align: b.align || 'center', after: 200 });
    if (b.table) return table(b.table, { header: b.header !== false, widths: b.widths || null });
    if (b.space) return para('');
    return para(b.p, { bold: b.bold, italic: b.italic, align: b.align, size: b.size });
  }).join('');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>'));
  zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + body
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1418" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
    + '</w:body></w:document>'));
  return zip.toBuffer();
}

module.exports = { makeDocx };
