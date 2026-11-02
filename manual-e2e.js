// Прогон ручного добавления на чистой базе: docx, xlsx, pdf, скан, rar, битый файл. Запускается рядом с /root/ev.
const fs = require('node:fs'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const AdmZip = require('adm-zip'); const XLSX = require('xlsx'); const { PDFDocument, rgb } = require('pdf-lib'); const fontkit = require('@pdf-lib/fontkit');
const BASE = process.argv[2]; const OUT = '/root/e2e-files'; fs.mkdirSync(OUT, { recursive: true });
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const TZ = ['№ | Наименование товара | Ед. изм. | Количество | Цена за единицу', '1 | Шприц инъекционный однократного применения 5 мл | шт | 1000 | 12,50', '2 | Перчатки смотровые нитриловые размер M | пара | 500 | 18,00'];
const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
function docx(f) {
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  z.addFile('_rels/.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  const cell = (c) => `<w:tc><w:p><w:r><w:t>${c.trim()}</w:t></w:r></w:p></w:tc>`;
  const tbl = `<w:tbl>${TZ.map((l) => `<w:tr>${l.split('|').map(cell).join('')}</w:tr>`).join('')}</w:tbl>`;
  z.addFile('word/document.xml', Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${para('Техническое задание')}${tbl}<w:sectPr/></w:body></w:document>`));
  z.writeZip(f);
}
function xlsx(f) { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(TZ.map((l) => l.split('|').map((c) => c.trim()))), 'ТЗ'); XLSX.writeFile(wb, f, { bookType: f.endsWith('.xls') ? 'xls' : 'xlsx' }); }
async function pdf(f) {
  const d = await PDFDocument.create(); d.registerFontkit(fontkit); const font = await d.embedFont(fs.readFileSync(FONT));
  const p = d.addPage([842, 595]); ['Техническое задание', ...TZ].forEach((l, i) => p.drawText(l, { x: 30, y: 540 - i * 30, size: 13, font, color: rgb(0, 0, 0) }));
  fs.writeFileSync(f, await d.save());
}
async function scan(src, f) {
  execFileSync('pdftoppm', ['-r', '200', '-png', '-singlefile', src, '/root/e2e-files/page']);
  const d = await PDFDocument.create(); const img = await d.embedPng(fs.readFileSync('/root/e2e-files/page.png'));
  const p = d.addPage([img.width, img.height]); p.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height }); fs.writeFileSync(f, await d.save());
}
const SET = [
  { title: 'docx', files: ['ТЗ шприцы.docx'] }, { title: 'xlsx', files: ['ТЗ шприцы.xlsx'] }, { title: 'xls', files: ['ТЗ шприцы.xls'] }, { title: 'pdf', files: ['ТЗ шприцы.pdf'] },
  { title: 'скан', files: ['ТЗ шприцы скан.pdf'] }, { title: 'rar', files: ['Архив заказчика.rar'] },
  { title: 'битый+docx', files: ['Битый договор.docx', 'ТЗ шприцы.docx'] }, { title: 'только битый', files: ['Битый договор.docx'] },
];
(async () => {
  docx(`${OUT}/ТЗ шприцы.docx`); xlsx(`${OUT}/ТЗ шприцы.xlsx`); xlsx(`${OUT}/ТЗ шприцы.xls`); await pdf(`${OUT}/ТЗ шприцы.pdf`); await scan(`${OUT}/ТЗ шприцы.pdf`, `${OUT}/ТЗ шприцы скан.pdf`);
  fs.writeFileSync(`${OUT}/Битый договор.docx`, 'это не документ');
  fs.copyFileSync(process.argv[3], `${OUT}/Архив заказчика.rar`);
  const out = [];
  for (const s of SET) {
    const form = new FormData(); form.set('platform', 'ЕАТ «Берёзка»');
    for (const n of s.files) form.append('files', new Blob([fs.readFileSync(`${OUT}/${n}`)]), n);
    const r = await fetch(`${BASE}/api/tenders/manual`, { method: 'POST', body: form }); const j = await r.json();
    if (!j.id) { out.push({ set: s.title, http: r.status, err: j.error }); continue; }
    let v = null;
    for (let i = 0; i < 90; i++) { await new Promise((ok) => setTimeout(ok, 2000)); v = await (await fetch(`${BASE}/api/tenders/${j.id}`)).json(); const a = await (await fetch(`${BASE}/api/analyses/${j.analysisId}`)).json(); if (['done', 'error', 'failed'].includes(a.status)) { v.a = a; break; } }
    await new Promise((ok) => setTimeout(ok, 3000));
    const t = await (await fetch(`${BASE}/api/tenders/${j.id}`)).json();
    out.push({ set: s.title, status: v?.a?.status, title: t.title || t.tender?.title, items: (t.items || t.tender?.items || []).map((x) => `${x.name} × ${x.quantity}`), files: (v?.a?.files || []).map((f) => `${f.original_name}: ${f.status}${f.message ? ` — ${f.message}` : ''}`) });
  }
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
