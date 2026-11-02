// Таблицы из документов Word — без потери строк и столбцов. Обычное извлечение текста превращает таблицу в поток
// абзацев: где кончается одна позиция и начинается другая, к какому товару относится «25 шт», уже не видно.
// Здесь каждая строка таблицы — одна строка текста, ячейки разделены « | », объединённые ячейки раскрыты:
//   ячейка, объединённая по вертикали, в строках-продолжениях обозначается знаком «″» («то же, что выше») —
//   столбцы не съезжают, а строка-продолжение не теряет связь со своей позицией.
// В таком виде таблицу читает и нейросеть, и «читатель по правилам» (server/tenders/rule-items.js).

const SAME = '″'; // то же значение, что в ячейке выше (объединение по вертикали)
const SEP = ' | ';

const unescape = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

/** Текст фрагмента HTML: абзацы и строки — через `join`, теги убраны. */
function htmlText(html, join = '\n') {
  return unescape(html
    .replace(/<\/t[dh]>/gi, ' ') // ячейки вложенной таблицы не слипаются
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\u0001')
    .replace(/<[^>]+>/g, ''))
    .split('\u0001').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(join);
}

/** Границы таблиц верхнего уровня (вложенные таблицы остаются внутри ячеек). */
function topTables(html) {
  const out = [];
  const re = /<(\/?)table\b[^>]*>/gi;
  let depth = 0;
  let start = -1;
  let m;
  while ((m = re.exec(html))) {
    if (!m[1]) { if (depth === 0) start = m.index; depth++; }
    else if (depth > 0) { depth--; if (depth === 0) out.push({ from: start, to: m.index + m[0].length }); }
  }
  return out;
}

/** Ячейки одной строки верхнего уровня: содержимое и размеры объединения. */
function rowCells(rowHtml) {
  const cells = [];
  const re = /<(\/?)(td|th|table)\b([^>]*)>/gi;
  let depth = 0; // вложенные таблицы
  let open = null;
  let m;
  while ((m = re.exec(rowHtml))) {
    const [tag, close, name, attrs] = m;
    if (name.toLowerCase() === 'table') { depth += close ? -1 : 1; continue; }
    if (depth > 0) continue;
    if (!close) open = { at: m.index + tag.length, colspan: Number(/colspan="?(\d+)/i.exec(attrs)?.[1] || 1), rowspan: Number(/rowspan="?(\d+)/i.exec(attrs)?.[1] || 1) };
    else if (open) { cells.push({ text: htmlText(rowHtml.slice(open.at, m.index), '; '), colspan: open.colspan, rowspan: open.rowspan }); open = null; }
  }
  return cells;
}

/** Строки таблицы верхнего уровня (строки вложенных таблиц не считаются отдельными). */
function tableRows(tableHtml) {
  const inner = tableHtml.replace(/^<table\b[^>]*>/i, '').replace(/<\/table>$/i, '');
  const rows = [];
  const re = /<(\/?)(tr|table)\b[^>]*>/gi;
  let depth = 0;
  let start = -1;
  let m;
  while ((m = re.exec(inner))) {
    const name = m[2].toLowerCase();
    if (name === 'table') { depth += m[1] ? -1 : 1; continue; }
    if (depth > 0) continue;
    if (!m[1]) start = m.index + m[0].length;
    else if (start >= 0) { rows.push(inner.slice(start, m.index)); start = -1; }
  }
  return rows;
}

/**
 * Таблица HTML → сетка: объединения раскрыты, у каждой клетки — текст и пометка, продолжение ли это.
 * @returns {Array<Array<{text: string, same: boolean}>>} same — клетка-продолжение объединения по вертикали
 */
function tableGrid(tableHtml) {
  const grid = [];
  tableRows(tableHtml).forEach((rowHtml, r) => {
    if (!grid[r]) grid[r] = [];
    let c = 0;
    for (const cell of rowCells(rowHtml)) {
      while (grid[r][c]) c++;
      for (let i = 0; i < cell.rowspan; i++) {
        if (!grid[r + i]) grid[r + i] = [];
        // по горизонтали продолжение — пустая клетка (текст уже есть слева), по вертикали — «то же, что выше»
        for (let j = 0; j < cell.colspan; j++) grid[r + i][c + j] = { text: i === 0 && j === 0 ? cell.text : i > 0 && j === 0 ? cell.text : '', same: i > 0 && j === 0 };
      }
      c += cell.colspan;
    }
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  return grid.filter(Boolean).map((row) => Array.from({ length: width }, (_, i) => row[i] || { text: '', same: false }));
}

/** Сетка → строки текста: ячейки через « | », продолжения объединений — «″», пустые хвосты срезаны. */
function gridLines(grid) {
  // столбцы, пустые во всех строках (артефакты разметки), убираем целиком
  const used = grid[0] ? grid[0].map((_, c) => grid.some((row) => row[c].text)) : [];
  return grid.map((row) => {
    const cells = row.filter((_, c) => used[c]).map((cell) => (cell.same && cell.text ? SAME : cell.text.replace(/\s*\|\s*/g, ' / ')));
    while (cells.length > 1 && !cells[cells.length - 1]) cells.pop();
    return cells.join(SEP);
  }).filter((line) => line.replace(/[|″\s]/g, ''));
}

/**
 * HTML документа (из mammoth) → текст, в котором таблицы сохранены построчно.
 * @returns {{text: string, tables: number}}
 */
function htmlWithTables(html) {
  const parts = [];
  let at = 0;
  let tables = 0;
  for (const t of topTables(html)) {
    const before = htmlText(html.slice(at, t.from));
    if (before) parts.push(before);
    const lines = gridLines(tableGrid(html.slice(t.from, t.to)));
    if (lines.length) { parts.push(lines.join('\n')); tables++; }
    at = t.to;
  }
  const tail = htmlText(html.slice(at));
  if (tail) parts.push(tail);
  // пустая строка между блоками: таблица не сливается с абзацем перед ней и после неё
  return { text: parts.join('\n\n'), tables };
}

module.exports = { htmlWithTables, tableGrid, gridLines, htmlText, SAME, SEP };
