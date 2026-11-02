// Проверка цитат: каждую цитату ищем в тексте указанной страницы, чтобы ловить галлюцинации LLM.

const MIN_QUOTE_CHARS = 8;

function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/­/g, '')              // мягкие переносы
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, '$1$2') // перенос слова через дефис на новую строку
    .replace(/[«»"„“”'`’]/g, '')
    .replace(/[|″]/g, '')        // разделители ячеек таблицы и знак «то же, что выше»
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[\s ]+/g, '');
}

/** Цитата найдена в тексте? Многоточие в цитате означает пропуск — части ищутся по порядку. */
function quoteInText(quote, text) {
  const parts = String(quote).split(/\.{3}|…/).map(normalize).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (total < MIN_QUOTE_CHARS) return false;
  const hay = normalize(text);
  let from = 0;
  for (const part of parts) {
    const idx = hay.indexOf(part, from);
    if (idx === -1) return false;
    from = idx + part.length;
  }
  return true;
}

function findDoc(docs, name) {
  const n = String(name).trim().toLowerCase();
  if (!n) return null;
  return docs.find((d) => d.name.toLowerCase() === n)
    || docs.find((d) => d.name.toLowerCase().endsWith('/' + n) || d.name.toLowerCase().endsWith(n))
    || docs.find((d) => n.endsWith(d.name.toLowerCase().split('/').pop()))
    || null;
}

/**
 * Проверяет источник: цитата должна найтись именно в названном файле.
 *  - на названной странице — подтверждена;
 *  - на другой странице того же файла — подтверждена, номер страницы исправлен (модели путают номера), в `claimed_page`
 *    остаётся названная;
 *  - названного файла среди документов нет (имя искажено), а цитата есть ровно в одном файле — подтверждена, файл исправлен;
 *  - названный файл есть, но цитата найдена только в другом — НЕ подтверждена: `mismatch: 'other_file'` и `suggested`
 *    (где она нашлась). Похожий текст из другого документа источником не считается — это разбирает человек.
 * @param {{file, page, quote}} src
 * @param {Array<{id, name, pages}>} docs
 */
function verifySource(src, docs) {
  const quote = String(src.quote || '').trim();
  const page = Number(src.page) || 1;
  const doc = findDoc(docs, src.file);
  const base = { file: doc ? doc.name : String(src.file || ''), fileId: doc ? doc.id : null, page, quote, verified: false };
  if (!quote) return base;

  if (doc) {
    const p = doc.pages.find((x) => x.page === page);
    if (p && quoteInText(quote, p.text)) return { ...base, verified: true };
    const other = doc.pages.find((x) => quoteInText(quote, x.text));
    if (other) return { ...base, page: other.page, claimed_page: page, verified: true };
  }
  const hits = [];
  for (const d of docs) {
    const hit = d.pages.find((x) => quoteInText(quote, x.text));
    if (hit) hits.push({ file: d.name, fileId: d.id, page: hit.page });
  }
  if (!hits.length) return base;
  // имя файла искажено и спутать не с чем — исправляем; иначе это ссылка не на тот документ
  if (!doc && hits.length === 1) return { ...base, ...hits[0], claimed_file: String(src.file || ''), verified: true };
  return { ...base, mismatch: 'other_file', suggested: hits[0] };
}

module.exports = { normalize, quoteInText, verifySource };
