// Учёт полноты чтения документации: что получено, что прочитано, что отправлено нейросети и что от неё принято.
// Полнота здесь — технический охват («всё учтённое содержимое прошло обработку»), а не правильность понимания:
// качество извлечения проверяется отдельно (цитаты, сверка позиций, противоречия).
//
// Состояния: complete — обработано всё учтённое; partial — часть не обработана (пропуски перечислены);
// unknown — полноту установить нельзя (например, неизвестно, сколько страниц в файле); failed — не обработано ничего.

const STATUSES = ['complete', 'partial', 'unknown', 'failed'];

/** Итог по нескольким частям: всё полно → complete; ничего не вышло → failed; есть пропуски → partial; иначе unknown. */
function combine(list) {
  const s = list.filter(Boolean);
  if (!s.length) return 'unknown';
  if (s.every((x) => x === 'complete')) return 'complete';
  if (s.every((x) => x === 'failed')) return 'failed';
  if (s.some((x) => x === 'partial' || x === 'failed')) return 'partial';
  return 'unknown';
}

/** Объединение диапазонов [from, to): пересечения и стыки склеиваются — перекрытие не считается дважды. */
function mergeRanges(ranges) {
  const sorted = ranges.filter((r) => r && r.to > r.from).map((r) => ({ from: r.from, to: r.to })).sort((a, b) => a.from - b.from);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push(r);
  }
  return out;
}

const rangesLength = (ranges) => mergeRanges(ranges).reduce((n, r) => n + (r.to - r.from), 0);

/** Какие части [0, length) не покрыты диапазонами. */
function gaps(length, ranges) {
  const out = [];
  let at = 0;
  for (const r of mergeRanges(ranges)) {
    if (r.from > at) out.push({ from: at, to: Math.min(r.from, length) });
    at = Math.max(at, r.to);
    if (at >= length) break;
  }
  if (at < length) out.push({ from: at, to: length });
  return out.filter((g) => g.to > g.from);
}

/** «58 из 64» или «58» — дробь показываем, только когда знаменатель известен. */
const fraction = (done, total) => (total == null ? String(done) : `${done} из ${total}`);

const UNIT_WORDS = { page: 'стр.', block: 'блок', sheet_rows: 'лист', image: 'изобр.' };

/** Что не прочитано в файле — одной строкой для человека. */
function unreadNote(c) {
  if (!c?.unread?.length) return '';
  const byReason = new Map();
  for (const u of c.unread) {
    if (!byReason.has(u.reason)) byReason.set(u.reason, []);
    byReason.get(u.reason).push(u.unit);
  }
  return [...byReason].map(([reason, units]) => `${UNREAD_REASONS[reason] || reason}: ${UNIT_WORDS[c.unit] || ''} ${compactList(units)}`.replace(/\s+/g, ' ')).join('; ');
}

const UNREAD_REASONS = {
  ocr_budget: 'не распознано (лимит распознавания за один проход)',
  ocr_failed: 'распознавание не удалось',
  no_ocr: 'скан — нет программы распознавания',
  scan_no_text: 'текст не распознан (скан, таблица-картинка или схема)',
  unknown_tail: 'конец файла не проверен',
};

// Электронные подписи, сертификаты, векторные рисунки: текста документации в них нет в принципе.
const NO_TEXT_NAME = /\.(sig|sign|sgn|p7s|p7b|cer|crt|emf|wmf)$/i;

/** 1,2,3,7,9,10 → «1–3, 7, 9–10» */
function compactList(nums) {
  const s = [...new Set(nums.filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}–${s[j]}` : String(s[i]));
    i = j;
  }
  return out.join(', ');
}

/**
 * Полнота извлечения текста из одного файла.
 * @param {{unit, expected: number|null, processed: number, empty?: number[], unread?: Array<{unit, reason, note?}>, ocr?: number[], method?: string}} c
 */
function fileCoverage(c) {
  const unread = c.unread || [];
  const empty = c.empty || [];
  let status;
  if (unread.length) status = c.processed > 0 ? 'partial' : 'failed';
  else if (c.expected == null) status = 'unknown';
  else status = c.processed + empty.length >= c.expected ? 'complete' : 'partial';
  return { unit: c.unit, expected: c.expected ?? null, processed: c.processed, empty, unread, ocr: c.ocr || [], method: c.method || null, status };
}

/** Файл не открылся совсем (ошибка, скан без распознавания, не распакованный архив) — блокирует ли он вывод о закупке. */
function unreadableCoverage(blocking, reason) {
  return { unit: null, expected: null, processed: 0, empty: [], unread: [], ocr: [], method: null, status: blocking ? 'failed' : 'complete', blocking, reason: reason || null, skipped: !blocking };
}

/**
 * Сводный отчёт разбора: загрузка → извлечение текста → отправка фрагментов → принятые ответы.
 * @param files [{id, name, status, message, pages, coverage, sha256}] все файлы разбора (в том числе не скачанные)
 * @param chunks [{id, status, ranges}] фрагменты задачи; status: ok | failed | skipped (бюджет)
 * @param pageLengths Map «fileId:page» → длина текста страницы
 */
function analysisCoverage({ files, chunks, pageLengths, budgetLeft = null }) {
  const downloadFailed = files.filter((f) => f.status === 'error' && /^Не скачан/i.test(f.message || ''));
  // Файл без текста документации (подпись, сертификат, рисунок) пробелом не считается. У файлов, сохранённых до
  // появления отчёта о полноте, пометки нет — узнаём такие по расширению.
  const noText = (f) => (f.coverage ? f.coverage.blocking === false : NO_TEXT_NAME.test(f.name || ''));
  const unreadable = files.filter((f) => f.status !== 'ok' && !downloadFailed.includes(f) && !noText(f));
  const skipped = files.filter((f) => f.status !== 'ok' && !downloadFailed.includes(f) && noText(f));
  const readable = files.filter((f) => f.status === 'ok');
  const download = {
    expected: files.length - skipped.length, received: files.length - skipped.length - downloadFailed.length,
    failed: downloadFailed.map((f) => ({ name: f.name, reason: f.message })),
    status: downloadFailed.length ? (downloadFailed.length === files.length - skipped.length ? 'failed' : 'partial') : 'complete',
  };

  // извлечение текста: страницы считаем только там, где единица — настоящая страница; у остальных — условные блоки
  let pagesExpected = 0;
  let pagesProcessed = 0;
  let pagesUnknown = false;
  const fileGaps = [];
  for (const f of readable) {
    const c = f.coverage;
    if (!c) { pagesUnknown = true; continue; }
    if (c.unit === 'page') {
      if (c.expected == null) pagesUnknown = true; else pagesExpected += c.expected;
      pagesProcessed += c.processed + c.empty.length;
    }
    if (c.status !== 'complete') fileGaps.push({ file: f.name, fileId: f.id, status: c.status, note: unreadNote(c) || (c.expected == null ? 'сколько в файле страниц, установить не удалось' : 'часть файла не прочитана'), unread: c.unread });
  }
  const extract = {
    files_readable: readable.length,
    files_unreadable: unreadable.map((f) => ({ name: f.name, fileId: f.id, reason: f.message || f.status })),
    files_skipped: skipped.map((f) => ({ name: f.name, reason: f.message || f.status })),
    pages_expected: pagesUnknown ? null : pagesExpected, pages_processed: pagesProcessed,
    gaps: fileGaps,
    status: combine([
      ...readable.map((f) => f.coverage?.status || 'unknown'),
      ...unreadable.map(() => 'failed'),
    ]),
  };

  // отправка и принятие: по объединению исходных диапазонов текста, перекрытие не считается дважды
  const byPage = new Map(); // «fileId:page» → {sent: [], accepted: []}
  for (const ch of chunks) {
    for (const r of ch.ranges || []) {
      const k = `${r.fileId}:${r.page}`;
      if (!byPage.has(k)) byPage.set(k, { sent: [], accepted: [] });
      if (ch.status !== 'skipped') byPage.get(k).sent.push(r);
      if (ch.status === 'ok') byPage.get(k).accepted.push(r);
    }
  }
  let charsTotal = 0;
  let charsSent = 0;
  let charsAccepted = 0;
  const notAccepted = [];
  for (const [k, len] of pageLengths) {
    if (!len) continue;
    charsTotal += len;
    const p = byPage.get(k) || { sent: [], accepted: [] };
    charsSent += Math.min(len, rangesLength(p.sent));
    const acc = Math.min(len, rangesLength(p.accepted));
    charsAccepted += acc;
    if (acc < len) {
      const [fileId, page] = k.split(':').map(Number);
      notAccepted.push({ fileId, page, missing: gaps(len, p.accepted) });
    }
  }
  const built = chunks.length;
  const accepted = chunks.filter((c) => c.status === 'ok').length;
  const failed = chunks.filter((c) => c.status === 'failed');
  const skippedChunks = chunks.filter((c) => c.status === 'skipped');
  const send = {
    chunks_built: built, chunks_sent: built - skippedChunks.length, chunks_skipped: skippedChunks.length,
    skip_reason: skippedChunks.some((c) => c.error_kind === 'quota') ? 'quota' : skippedChunks.length ? 'budget' : null,
    chars_total: charsTotal, chars_sent: charsSent,
    status: !built ? 'failed' : charsSent >= charsTotal && !skippedChunks.length ? 'complete' : charsSent > 0 ? 'partial' : 'failed',
  };
  const accept = {
    chunks_accepted: accepted, chunks_failed: failed.length,
    failed: failed.map((c) => ({ id: c.id, kind: c.error_kind || null, reason: c.error || null, pages: pagesOf(c) })),
    chars_accepted: charsAccepted, not_accepted: notAccepted,
    status: !built ? 'failed' : charsAccepted >= charsTotal ? 'complete' : charsAccepted > 0 ? 'partial' : 'failed',
  };
  const status = combine([download.status, extract.status, send.status, accept.status]);
  return { status, download, extract, send, accept, budget_left: budgetLeft, blocking: blockers({ download, extract, send, accept }) };
}

const pagesOf = (chunk) => {
  const by = new Map();
  for (const r of chunk.ranges || []) {
    if (!by.has(r.file)) by.set(r.file, []);
    by.get(r.file).push(r.page);
  }
  return [...by].map(([file, pages]) => ({ file, pages: [...new Set(pages)].sort((a, b) => a - b) }));
};

/** Пропуски, из-за которых вывод о закупке нельзя считать окончательным, — каждый с действием для человека. */
function blockers({ download, extract, send, accept }) {
  const out = [];
  for (const f of download.failed) out.push({ kind: 'source_unavailable', text: `Не получен файл «${f.name}»: ${String(f.reason || '').replace(/^Не скачан:\s*/i, '')}`, action: 'upload_file' });
  for (const f of extract.files_unreadable) out.push({ kind: 'file_unreadable', text: `Файл «${f.name}» не прочитан: ${f.reason}`, action: 'upload_file' });
  for (const g of extract.gaps) out.push({ kind: g.status === 'unknown' ? 'pages_unknown' : 'pages_unread', text: `«${g.file}»: ${g.note}`, action: 'retry', fileId: g.fileId });
  if (send.chunks_skipped) out.push({ kind: 'budget', text: `Не отправлено нейросети фрагментов: ${send.chunks_skipped} — ${send.skip_reason === 'quota' ? 'у нейросети закончился оплаченный пакет запросов' : 'исчерпан лимит разбора за один проход'}`, action: 'retry' });
  for (const c of accept.failed) {
    const where = c.pages.map((p) => `«${p.file}», стр. ${compactList(p.pages)}`).join('; ');
    out.push({ kind: 'chunk_failed', text: `Нейросеть не разобрала фрагмент (${where})${c.reason ? `: ${c.reason}` : ''}`, action: 'retry' });
  }
  return out;
}

/** Короткая строка для карточки: «Получено 5 из 6 вложений; обработано 58 из 64 страниц; принято 12 из 14 фрагментов». */
function describe(cov) {
  if (!cov) return 'Разбор сделан прежней версией сервиса — полнота чтения неизвестна';
  const parts = [`получено вложений: ${fraction(cov.download.received, cov.download.expected)}`];
  const unread = cov.extract.files_unreadable.length;
  parts.push(`прочитано файлов: ${fraction(cov.extract.files_readable, cov.extract.files_readable + unread)}`);
  if (cov.extract.pages_processed || cov.extract.pages_expected) parts.push(`обработано страниц PDF: ${fraction(cov.extract.pages_processed, cov.extract.pages_expected)}`);
  parts.push(`принято фрагментов: ${fraction(cov.accept.chunks_accepted, cov.send.chunks_built)}`);
  return parts.join('; ');
}

module.exports = { STATUSES, combine, mergeRanges, rangesLength, gaps, fraction, compactList, fileCoverage, unreadableCoverage, analysisCoverage, describe, unreadNote, UNREAD_REASONS };
