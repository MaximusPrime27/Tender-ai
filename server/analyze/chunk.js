// Нарезка документов на фрагменты под лимит входа нейросети с сохранением разметки «файл + страница».
// Каждый фрагмент помнит, какие диапазоны текста каких страниц в него вошли: по ним считается полнота отправки
// (объединением диапазонов — перекрытие не считается дважды) и находятся страницы несостоявшегося фрагмента.

const crypto = require('node:crypto');

const HEADER_RE = /^<<<ФАЙЛ: (.+?) \| СТРАНИЦА: (\d+)>>>$/gm;

const header = (file, page) => `<<<ФАЙЛ: ${file} | СТРАНИЦА: ${page}>>>`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Сколько символов конца предыдущей части повторяется в начале следующей, когда страницу приходится резать:
// строка таблицы или условие, попавшие на разрез, целиком окажутся хотя бы в одной из частей.
const OVERLAP_CHARS = 400;

/** Где резать текст не дальше позиции `limit`: по пустой строке, по концу строки, по концу предложения; иначе — ровно по лимиту. */
function cutPoint(text, from, limit) {
  if (limit >= text.length) return text.length;
  const min = from + Math.floor((limit - from) * 0.5); // не режем слишком рано: части не должны мельчать
  for (const sep of ['\n\n', '\n', '. ', '; ']) {
    const at = text.lastIndexOf(sep, limit - sep.length);
    if (at >= min) return at + sep.length;
  }
  return limit;
}

/** Начало следующей части: отступаем на перекрытие и выравниваем по началу строки, если она рядом. */
function overlapStart(text, end, prevFrom, overlap) {
  const want = Math.max(prevFrom + 1, end - overlap);
  const nl = text.indexOf('\n', want);
  return nl !== -1 && nl + 1 < end ? nl + 1 : want;
}

/**
 * Делит одну страницу на части не длиннее `room`, с перекрытием. Короткая страница — одна часть.
 * @returns {Array<{from, to, text}>} from/to — диапазон исходного текста страницы
 */
function splitPage(text, room, overlap = OVERLAP_CHARS) {
  if (text.length <= room) return [{ from: 0, to: text.length, text }];
  const ov = Math.min(overlap, Math.floor(room / 4));
  const parts = [];
  let from = 0;
  for (;;) {
    const to = cutPoint(text, from, from + room);
    parts.push({ from, to, text: text.slice(from, to) });
    if (to >= text.length) break;
    from = overlapStart(text, to, from, ov);
  }
  return parts;
}

/**
 * Очередь фрагментов: все страницы всех прочитанных файлов, от первой до последней, ничего не отбрасывается.
 * @param {Array<{id, name, status, pages: Array<{page, text}>}>} docs
 * @param {number} maxChars предел длины одного фрагмента
 * @returns {Array<{id, text, ranges: Array<{fileId, file, page, from, to}>}>}
 */
function buildChunkQueue(docs, maxChars, { overlap = OVERLAP_CHARS } = {}) {
  const units = [];
  for (const doc of docs) {
    if (doc.status !== 'ok') continue;
    for (const p of doc.pages) {
      if (!p.text.trim()) continue;
      const h = header(doc.name, p.page);
      // место под заголовок страницы и пометку о части
      const room = Math.max(maxChars - h.length - 140, 500);
      const parts = splitPage(p.text, room, overlap);
      // у таблицы первая строка — заголовок столбцов: повторяем его в каждой следующей части
      const firstLine = p.text.split('\n', 1)[0];
      const tableHead = parts.length > 1 && firstLine.includes(' | ') && firstLine.length < 600 ? firstLine : null;
      parts.forEach((part, i) => {
        const note = parts.length > 1
          ? `[часть ${i + 1} из ${parts.length} этой страницы${i ? '; начало повторяет конец предыдущей части' : ''}${i && tableHead ? `; заголовок таблицы: ${tableHead}` : ''}]\n`
          : '';
        units.push({ text: `${h}\n${note}${part.text}`, range: { fileId: doc.id ?? null, file: doc.name, page: p.page, from: part.from, to: part.to } });
      });
    }
  }

  const chunks = [];
  let cur = null;
  const flush = () => { if (cur) { chunks.push({ id: sha(cur.text).slice(0, 16), text: cur.text, ranges: cur.ranges }); cur = null; } };
  for (const u of units) {
    if (cur && cur.text.length + u.text.length + 2 > maxChars) flush();
    if (!cur) cur = { text: '', ranges: [] };
    cur.text += (cur.text ? '\n\n' : '') + u.text;
    cur.ranges.push(u.range);
  }
  flush();
  return chunks;
}

/**
 * Делит фрагмент на два меньших по тем же страницам — когда нейросеть не справилась с объёмом (ответ оборван
 * лимитом или запрос не поместился): повторять тот же слишком большой запрос бессмысленно.
 * @returns {Array} два фрагмента или пустой массив, если делить нечего
 */
function halveChunk(chunk, docs) {
  const byId = new Map(docs.map((d) => [`${d.id ?? ''}|${d.name}`, d]));
  const pages = [];
  for (const r of chunk.ranges) {
    const doc = byId.get(`${r.fileId ?? ''}|${r.file}`);
    const p = doc?.pages.find((x) => x.page === r.page);
    if (!p) return [];
    pages.push({ doc, page: p.page, text: p.text.slice(r.from, r.to), offset: r.from });
  }
  const total = pages.reduce((n, p) => n + p.text.length, 0);
  if (total < 1200) return [];
  const half = Math.ceil(total / 2) + 200;
  // каждая страница (её часть) режется под половинный лимит, затем части раскладываются в два фрагмента подряд
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { out.push({ id: sha(cur.text).slice(0, 16), text: cur.text, ranges: cur.ranges }); cur = null; } };
  for (const p of pages) {
    const h = header(p.doc.name, p.page);
    for (const part of splitPage(p.text, Math.max(half - h.length - 140, 500))) {
      const text = `${h}\n[часть страницы]\n${part.text}`;
      if (cur && cur.text.length + text.length + 2 > half + h.length + 140) flush();
      if (!cur) cur = { text: '', ranges: [] };
      cur.text += (cur.text ? '\n\n' : '') + text;
      cur.ranges.push({ fileId: p.doc.id ?? null, file: p.doc.name, page: p.page, from: p.offset + part.from, to: p.offset + part.to });
    }
  }
  flush();
  return out.length > 1 ? out : [];
}

/** Фрагменты одним списком строк (прежний вид; полнота по ним не считается). */
const buildChunks = (docs, maxChars) => buildChunkQueue(docs, maxChars).map((c) => c.text);

/** Обратный разбор чанка на страницы (нужен mock-провайдеру). */
function parseChunk(chunk) {
  const pages = [];
  const matches = [...chunk.matchAll(HEADER_RE)];
  matches.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : chunk.length;
    pages.push({ file: m[1], page: Number(m[2]), text: chunk.slice(start, end).trim() });
  });
  return pages;
}

module.exports = { buildChunks, buildChunkQueue, halveChunk, splitPage, parseChunk, header, sha, OVERLAP_CHARS };
