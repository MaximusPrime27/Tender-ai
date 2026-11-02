// PDF из снимка полного анализа: шрифт с кириллицей (DejaVu, встраивается), перенос строк и таблиц по страницам,
// шапка таблицы повторяется на новой странице, номер страницы и снимок — внизу каждой страницы.

const fs = require('node:fs');
const path = require('node:path');
const { blocks } = require('./document');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const A4 = [595.28, 841.89];
const M = 48; // поля
const C = { text: [0.17, 0.14, 0.12], muted: [0.42, 0.37, 0.32], head: [0.54, 0.29, 0.16], line: [0.75, 0.70, 0.64], fill: [0.93, 0.89, 0.85] };

async function toPdf(report, opts = {}) {
  const { PDFDocument, rgb } = require('pdf-lib');
  const fontkit = require('@pdf-lib/fontkit');
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`Полный анализ закупки ${report.scope.procurement_number}`);
  pdf.setCreator('Tender AI');
  const regular = await pdf.embedFont(fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans.ttf')), { subset: true });
  const bold = await pdf.embedFont(fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')), { subset: true });
  const col = (c) => rgb(...c);
  // символы, которых нет в шрифте, не должны ломать выгрузку
  const glyphs = new Set(regular.getCharacterSet());
  const clean = (s) => String(s ?? '').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000B-\u001F\u200B-\u200F\uFEFF]/g, '')
    .replace(/[^\n]/gu, (ch) => (glyphs.has(ch.codePointAt(0)) ? ch : '?'));

  const W = A4[0] - 2 * M;
  let page; let y;
  const newPage = () => { page = pdf.addPage(A4); y = A4[1] - M; };
  newPage();

  const wrap = (text, font, size, width) => {
    const out = [];
    for (const raw of clean(text).split('\n')) {
      let line = '';
      for (const word of raw.split(/ +/)) {
        const cand = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(cand, size) <= width) { line = cand; continue; }
        if (line) out.push(line);
        // слово длиннее строки (ссылка, хэш) — режем по символам
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width) {
          let n = w.length;
          while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
          out.push(w.slice(0, n)); w = w.slice(n);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  };
  const ensure = (h) => { if (y - h < M + 18) newPage(); };
  const text = (str, { font = regular, size = 10, color = C.text, gapAfter = 5, keepWithNext = 0 } = {}) => {
    const lh = size * 1.32;
    const lines = wrap(str, font, size, W);
    ensure(Math.min(lines.length, 2) * lh + keepWithNext);
    for (const l of lines) { ensure(lh); page.drawText(l, { x: M, y: y - size, size, font, color: col(color) }); y -= lh; }
    y -= gapAfter;
  };

  const table = ({ head, rows, widths }) => {
    const size = 8; const lh = size * 1.3; const pad = 3;
    const sum = widths.reduce((a, b) => a + b, 0) || 1;
    const cw = widths.map((w) => (w / sum) * W);
    const layout = (cells, font) => cells.map((c, i) => wrap(c, font, size, cw[i] - 2 * pad));
    const drawRow = (lines, font, fill, from = 0, count = null) => {
      const n = count ?? Math.max(...lines.map((l) => l.length - from), 1);
      const h = n * lh + 2 * pad;
      let x = M;
      lines.forEach((l, i) => {
        if (fill) page.drawRectangle({ x, y: y - h, width: cw[i], height: h, color: col(C.fill) });
        page.drawRectangle({ x, y: y - h, width: cw[i], height: h, borderColor: col(C.line), borderWidth: 0.5 });
        l.slice(from, from + n).forEach((s, k) => page.drawText(s, { x: x + pad, y: y - pad - size - k * lh + 1, size, font, color: col(C.text) }));
        x += cw[i];
      });
      y -= h;
    };
    const headLines = layout(head, bold);
    const headH = Math.max(...headLines.map((l) => l.length)) * lh + 2 * pad;
    ensure(headH + lh * 2 + 2 * pad);
    drawRow(headLines, bold, true);
    for (const r of rows) {
      const lines = layout(r, regular);
      const total = Math.max(...lines.map((l) => l.length), 1);
      let from = 0;
      while (from < total) {
        // сколько строк ячейки помещается на странице; длинная строка таблицы переносится на следующую страницу
        let fit = Math.floor((y - M - 18 - 2 * pad) / lh);
        if (fit < Math.min(2, total - from)) { newPage(); drawRow(headLines, bold, true); fit = Math.floor((y - M - 18 - 2 * pad) / lh); }
        const n = Math.min(fit, total - from);
        drawRow(lines, regular, false, from, n);
        from += n;
      }
    }
    y -= 8;
  };

  for (const b of blocks(report, opts)) {
    if (b.h === 1) text(b.text, { font: bold, size: 16, color: C.head, gapAfter: 8, keepWithNext: 30 });
    else if (b.h) { y -= 6; text(b.text, { font: bold, size: 12.5, color: C.head, gapAfter: 6, keepWithNext: 40 }); }
    else if (b.table) table(b.table);
    else if (b.p) text(b.p, { font: b.bold ? bold : regular, size: b.muted ? 8.5 : 10, color: b.muted ? C.muted : C.text });
  }

  const pages = pdf.getPages();
  const label = clean(`Закупка ${report.scope.procurement_number} · отчёт ${report.snapshot.id || '—'}`);
  pages.forEach((p, i) => {
    const s = `${label} · стр. ${i + 1} из ${pages.length}`;
    p.drawText(s, { x: (A4[0] - regular.widthOfTextAtSize(s, 7.5)) / 2, y: M / 2, size: 7.5, font: regular, color: col(C.muted) });
  });
  return Buffer.from(await pdf.save());
}

module.exports = { toPdf };
