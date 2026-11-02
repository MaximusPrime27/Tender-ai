// DOCX из снимка полного анализа: настоящий Word-документ (OOXML), а не HTML с расширением .docx.
// Заголовки — стилями, таблицы с повтором шапки на каждой странице, номера страниц в нижнем колонтитуле.

const AdmZip = require('adm-zip');
const { blocks } = require('./document');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // символы, запрещённые в XML 1.0
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const run = (text, { bold = false, color = null, size = null } = {}) =>
  `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}${size ? `<w:sz w:val="${size}"/>` : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (text, opts = {}) => `<w:p>${opts.style ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : ''}${run(text, opts)}</w:p>`;

const PAGE_TW = 9638; // ширина текста A4 при полях 2 см, в twips
function table({ head, rows, widths }) {
  const sum = widths.reduce((a, b) => a + b, 0) || 1;
  const tw = widths.map((w) => Math.round((w / sum) * PAGE_TW));
  const cell = (text, i, isHead) => `<w:tc><w:tcPr><w:tcW w:w="${tw[i]}" w:type="dxa"/>${isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="EDE4DA"/>' : ''}</w:tcPr>${String(text ?? '').split('\n').map((line) => `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(line, { bold: isHead, size: 18 })}</w:p>`).join('')}</w:tc>`;
  const border = '<w:top w:val="single" w:sz="4" w:color="BFB2A3"/><w:left w:val="single" w:sz="4" w:color="BFB2A3"/><w:bottom w:val="single" w:sz="4" w:color="BFB2A3"/><w:right w:val="single" w:sz="4" w:color="BFB2A3"/><w:insideH w:val="single" w:sz="4" w:color="BFB2A3"/><w:insideV w:val="single" w:sz="4" w:color="BFB2A3"/>';
  return `<w:tbl><w:tblPr><w:tblW w:w="${PAGE_TW}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${border}</w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>`
    + `<w:tblGrid>${tw.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
    + `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${head.map((h, i) => cell(h, i, true)).join('')}</w:tr>`
    + rows.map((r) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${r.map((c, i) => cell(c, i, false)).join('')}</w:tr>`).join('')
    + '</w:tbl><w:p><w:pPr><w:spacing w:after="60"/></w:pPr></w:p>';
}

function bodyXml(list) {
  return list.map((b) => {
    if (b.h) return para(b.text, { style: b.h === 1 ? 'Heading1' : 'Heading2' });
    if (b.table) return table(b.table);
    if (b.p != null) return b.p === '' ? '' : para(b.p, { bold: b.bold, color: b.muted ? '6B5E52' : null, size: b.muted ? 18 : null });
    return '';
  }).join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="20"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="8A4B2A"/><w:sz w:val="32"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="8A4B2A"/><w:sz w:val="26"/></w:rPr></w:style>'
  + '</w:styles>';
const footer = (label) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run(`${label} · стр. `, { size: 16, color: '6B5E52' })}<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t>1</w:t></w:r><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;

/** Буфер .docx. Тот же список блоков, что и у PDF, — цифры и статусы совпадают с экраном и JSON. */
function toDocx(report, opts = {}) {
  const list = blocks(report, opts);
  const label = `Закупка ${report.scope.procurement_number} · отчёт ${report.snapshot.id || '—'}`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${bodyXml(list)}<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(`Полный анализ закупки ${report.scope.procurement_number}`)}</dc:title><dc:creator>Tender AI</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${esc(report.snapshot.as_of)}</dcterms:created></cp:coreProperties>`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(CONTENT_TYPES, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(RELS, 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(DOC_RELS, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(doc, 'utf8'));
  zip.addFile('word/styles.xml', Buffer.from(STYLES, 'utf8'));
  zip.addFile('word/footer1.xml', Buffer.from(footer(label), 'utf8'));
  zip.addFile('docProps/core.xml', Buffer.from(core, 'utf8'));
  return zip.toBuffer();
}

module.exports = { toDocx };
