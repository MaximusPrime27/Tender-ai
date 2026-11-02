// Печатные копии документов. Заказчики часто выкладывают один документ трижды: оригинал («ТЗ.docx»), его печатную
// форму («ТЗ.docx.pdf») и файл подписи («ТЗ.docx.sig»). Читать копию второй раз незачем: это вдвое больше запросов
// к нейросети, а страницы-картинки со штампом подписи в копии выглядят как «непрочитанное».
// Копией PDF считается, только если совпали и имя, и текст: то же имя без «.pdf» у прочитанного оригинала рядом
// и почти все слова копии есть в оригинале. Не совпало — файл читается как обычно.
// Отдельный случай — пакет подписи из ЕИС: «ТЗ.docx» и точно «ТЗ.docx.pdf». Если документ состоит из картинок,
// страницы копии распознаются с шумом (а часть не распознаётся вовсе), и сравнение всего текста не сходится.
// Тогда сравниваем только страницы копии с настоящим текстовым слоем — при условии, что сам документ прочитан полностью.

const { unreadableCoverage } = require('../analyze/coverage');

const ORIGINALS = /\.(docx|docm|doc|rtf|odt|xlsx|xlsm|xls|ods)$/i;
// Доля слов копии, которые есть в оригинале; и насколько копия может быть длиннее оригинала (колонтитулы, штамп).
const MIN_SHARED = 0.9;
const MAX_LONGER = 1.25;

const textOf = (f) => (f.pages || []).map((p) => p.text || '').join('\n');
const words = (text) => new Set(String(text).toLowerCase().match(/[a-zа-яё0-9]{4,}/gi) || []);
const dirOf = (name) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '');
const baseOf = (name) => name.slice(name.lastIndexOf('/') + 1);

/** Оригинал, печатной копией которого может быть PDF: «X.docx.pdf» → «X.docx»; «X.pdf» → «X.docx», «X.doc»… */
function originalFor(pdf, files) {
  const stem = baseOf(pdf.name).replace(/\.pdf$/i, '');
  const near = files.filter((f) => f !== pdf && f.status === 'ok' && dirOf(f.name) === dirOf(pdf.name) && ORIGINALS.test(f.name));
  return near.find((f) => baseOf(f.name).toLowerCase() === stem.toLowerCase())
    || near.find((f) => baseOf(f.name).replace(ORIGINALS, '').toLowerCase() === stem.toLowerCase())
    || null;
}

/** Текст страниц с текстовым слоем: распознанные со сканов страницы в сравнение не идут. */
function layerText(f) {
  const ocr = new Set(f.coverage?.ocr || []);
  return (f.pages || []).filter((p) => !ocr.has(p.page)).map((p) => p.text || '').join('\n');
}

/**
 * Тот же ли текст: почти все слова копии встречаются в оригинале, и копия не длиннее его заметно.
 * layerOnly — у копии берутся только страницы с текстовым слоем (для точной пары «X.docx» + «X.docx.pdf»).
 */
function sameText(copy, original, { layerOnly = false } = {}) {
  const a = layerOnly ? layerText(copy) : textOf(copy);
  const b = textOf(original);
  if (a.trim().length < 200 || !b.trim()) return false; // по короткому тексту судить нельзя
  if (a.length > b.length * MAX_LONGER) return false;
  const wa = words(a);
  const wb = words(b);
  if (!wa.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / wa.size >= MIN_SHARED;
}

/**
 * Пометить печатные копии: такой файл не читается и не считается пробелом (как файл подписи).
 * @param files результаты извлечения текста: [{name, status, pages, coverage, …}]
 * @returns тот же список; у копий status = 'unsupported', страниц нет, в сообщении — какой оригинал прочитан
 */
function markRenditions(files) {
  return files.map((f) => {
    if (f.status !== 'ok' || !/\.pdf$/i.test(f.name)) return f;
    const original = originalFor(f, files);
    if (!original) return f;
    // точная пара «X.docx» + «X.docx.pdf», и сам документ прочитан полностью — шум распознавания не учитываем
    const exact = baseOf(original.name).toLowerCase() === baseOf(f.name).replace(/\.pdf$/i, '').toLowerCase();
    const same = sameText(f, original) || (exact && original.coverage?.status === 'complete' && sameText(f, original, { layerOnly: true }));
    if (!same) return f;
    return { ...f, status: 'unsupported', pages: [], message: `Печатная копия документа «${baseOf(original.name)}» — прочитан сам документ`, coverage: unreadableCoverage(false, 'rendition') };
  });
}

module.exports = { markRenditions, sameText, originalFor };
