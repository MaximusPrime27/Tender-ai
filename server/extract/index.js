// Текст из файлов документации закупки. Читаются:
//   документы   — PDF (в том числе сканы: текст распознаётся), DOCX/DOCM, старый DOC, RTF, ODT, TXT, HTML, XML;
//   таблицы     — XLSX, XLSM, XLSB, XLS, ODS, CSV;
//   презентации — PPTX, ODP;
//   картинки    — JPG, PNG, TIFF, BMP, GIF (текст распознаётся);
//   архивы      — ZIP, RAR, 7z, TAR, GZ (раскрываются, вложенные архивы — тоже).
// Тип определяется по содержимому, а не по расширению: в документации закупок RTF и HTML часто лежат под
// видом .doc, а DOCX — под видом .zip. Не читаются только файлы без текста: электронные подписи, чертежи, видео.
// Распознавание сканов и распаковка RAR/7z требуют программ tesseract, pdftoppm и bsdtar (deploy/install-tools.sh);
// без них такие файлы помечаются непрочитанными с понятной причиной.

const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const WordExtractor = require('word-extractor');
const { createOcr } = require('./ocr');
const crypto = require('node:crypto');
const { createArchiver } = require('./archive');
const { htmlWithTables, SAME } = require('./tables');
const { fileCoverage, unreadableCoverage, compactList } = require('../analyze/coverage');

const FRAGMENT_CHARS = 3000;
const MAX_ZIP_DEPTH = 3;
// Меньше этого числа значимых символов на страницу — считаем страницу PDF сканом без текстового слоя.
const SCAN_CHARS_PER_PAGE = 25;
// Картинки меньше этого размера — логотипы, печати, подписи: распознавать в них нечего.
const MIN_OCR_IMAGE_BYTES = 20 * 1024;

const MIME = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.rtf': 'application/rtf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.webp': 'image/webp',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
};

const WORD = new Set(['.docx', '.docm', '.dotx', '.dotm']);
const SHEET = new Set(['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods']);
const TEXT = new Set(['.txt', '.csv', '.md', '.log', '.json']);
const HTML = new Set(['.html', '.htm', '.xhtml', '.mht', '.mhtml']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif', '.webp']);
const ARCHIVE = new Set(['.rar', '.7z', '.tar', '.gz', '.tgz']);
const ARCHIVE_TITLE = { '.rar': 'RAR', '.7z': '7z', '.tar': 'TAR', '.gz': 'GZ', '.tgz': 'TGZ' };

// Файлы, в которых текста документации нет в принципе, — их не читаем и не считаем проблемой.
const NO_TEXT = {
  '.sig': 'Файл электронной подписи — текста в нём нет',
  '.sign': 'Файл электронной подписи — текста в нём нет',
  '.sgn': 'Файл электронной подписи — текста в нём нет',
  '.p7s': 'Файл электронной подписи — текста в нём нет',
  '.p7b': 'Сертификат электронной подписи — текста в нём нет',
  '.cer': 'Сертификат электронной подписи — текста в нём нет',
  '.crt': 'Сертификат электронной подписи — текста в нём нет',
  '.emf': 'Векторный рисунок — текста в нём нет',
  '.wmf': 'Векторный рисунок — текста в нём нет',
  '.dwg': 'Чертёж — откройте его в программе для чертежей',
  '.dxf': 'Чертёж — откройте его в программе для чертежей',
  '.ppt': 'Старая презентация PowerPoint (.ppt) — пересохраните её как .pptx или PDF',
  '.msg': 'Письмо Outlook — откройте его вручную',
  '.exe': 'Программа — не документ',
  '.mp4': 'Видео — текста в нём нет',
  '.avi': 'Видео — текста в нём нет',
  '.mp3': 'Звукозапись — текста в ней нет',
};
// Из «файлов без текста» эти могут оказаться документами закупки: их пропуск — пробел в чтении, а не норма.
const MAYBE_DOCUMENT = new Set(['.ppt', '.msg', '.dwg', '.dxf']);
// Служебные файлы внутри архивов: их даже не показываем в списке.
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|~\$)/i;

const latin = (buffer, n) => buffer.subarray(0, n).toString('latin1');

/** Что внутри ZIP: документ Word/Excel/PowerPoint, документ OpenOffice или обычный архив. */
function zipKind(buffer, ext) {
  let names;
  let zip;
  try {
    zip = new AdmZip(buffer);
    names = new Set(zip.getEntries().map((e) => e.entryName));
  } catch {
    return ['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.docm', '.xlsm'].includes(ext) ? ext : '.zip';
  }
  if (names.has('word/document.xml')) return '.docx';
  if (names.has('xl/workbook.xml') || names.has('xl/workbook.bin')) return ext === '.xlsb' ? '.xlsb' : '.xlsx';
  if (names.has('ppt/presentation.xml')) return '.pptx';
  if (names.has('mimetype') && names.has('content.xml')) {
    const mime = zip.getEntry('mimetype').getData().toString('latin1');
    if (mime.includes('spreadsheet')) return '.ods';
    if (mime.includes('presentation')) return '.odp';
    return '.odt';
  }
  return '.zip';
}

/** Тип файла по содержимому; расширение — только когда содержимое ничего не говорит. */
function detectType(name, buffer) {
  const head = buffer.subarray(0, 8);
  const ext = path.extname(name).toLowerCase();
  if (latin(head, 4) === 'Rar!') return '.rar';
  if (head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '.7z';
  if (latin(head, 5) === '%PDF-') return '.pdf';
  if (latin(head, 5) === '{\\rtf') return '.rtf'; // RTF часто лежит под расширением .doc
  if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (latin(head, 4) === 'GIF8') return '.gif';
  if (latin(head, 4) === 'II*\0' || latin(head, 4) === 'MM\0*') return '.tif';
  if (head[0] === 0x1f && head[1] === 0x8b) return ext === '.tgz' ? '.tgz' : '.gz';
  const isOle = head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (isOle) return ['.xls', '.ppt', '.msg'].includes(ext) ? ext : '.doc';
  if (latin(head, 2) === 'PK') return zipKind(buffer, ext);
  // Текстовые форматы под чужим расширением: выгрузки из учётных систем — HTML или XML с расширением .doc / .xls.
  const start = buffer.subarray(0, 800).toString('latin1').replace(/^\xef\xbb\xbf/, '').trimStart().toLowerCase();
  if (/^(<!doctype html|<html|<head|<body|<meta|<table)/.test(start)) return '.html';
  if (start.startsWith('<?xml') && !HTML.has(ext)) return /<html[\s>]/.test(start) ? '.html' : '.xml';
  return ext;
}

/** Делит длинный текст на фрагменты ~FRAGMENT_CHARS по границам абзацев. */
function splitFragments(text, size = FRAGMENT_CHARS) {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paragraphs = clean.split('\n');
  const pages = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) pages.push({ page: pages.length + 1, text: buf.trim() });
    buf = '';
  };
  for (const p of paragraphs) {
    if (p.length > size) {
      flush();
      for (let i = 0; i < p.length; i += size) {
        buf = p.slice(i, i + size);
        flush();
      }
      continue;
    }
    if (buf.length + p.length + 1 > size) flush();
    buf += (buf ? '\n' : '') + p;
  }
  flush();
  return pages;
}

const chars = (s) => String(s || '').replace(/\s/g, '').length;
/** Текст без настоящих страниц (Word, RTF, HTML…): условные блоки; извлечён весь текст файла, поэтому охват полный. */
function textResult(text, emptyMessage) {
  const pages = String(text || '').trim() ? splitFragments(text) : [];
  return pages.length
    ? { status: 'ok', pages, coverage: fileCoverage({ unit: 'block', expected: pages.length, processed: pages.length, method: 'text' }) }
    : { status: 'error', message: emptyMessage, pages: [], coverage: unreadableCoverage(true, 'empty') };
}

/** Есть ли на странице PDF что-то нарисованное (картинка-скан, таблица линиями, схема): true/false, null — узнать не удалось. */
async function pageHasGraphics(pdf, pageNo) {
  try {
    const page = await pdf.getPage(pageNo);
    const ops = await page.getOperatorList();
    return ops.fnArray.length > 0;
  } catch {
    return null;
  }
}

/**
 * PDF: текст из текстового слоя; страницы без него (сканы) распознаются — все, сколько бы их ни было.
 * Номера страниц сохраняются — по ним разбор ссылается на источник.
 * Страница без текста и без единого рисунка — подтверждённо пустая; страница с рисунком, на которой текст
 * получить не удалось, остаётся непрочитанной (на ней может быть таблица-картинка или схема с требованиями).
 * @param known Map страница → текст, распознанный раньше (повторный проход дочитывает только остальное)
 */
async function extractPdf(buffer, { ocr, onNote = () => {}, known = null } = {}) {
  let pages = null;
  let totalPages = 0;
  let pdf = null;
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    pdf = await getDocumentProxy(new Uint8Array(buffer));
    const r = await extractText(pdf, { mergePages: false });
    totalPages = r.totalPages;
    pages = r.text.map((t, i) => ({ page: i + 1, text: t.trim() }));
  } catch (err) {
    // Файл не открылся как PDF с текстом (повреждён, нестандартный). Последняя попытка — распознать как картинки.
    if (!ocr || !(await ocr.pdfReady())) throw err;
    onNote('распознаю страницы как картинки');
    const r = await ocr.pdf(buffer, { onPage: (i) => onNote(`распознаю скан: страница ${i}`) });
    const got = r.pages.filter((p) => chars(p.text) >= SCAN_CHARS_PER_PAGE);
    if (!got.length) throw err;
    const seen = r.pages.length + (r.failed || []).length;
    const unread = [
      ...r.pages.filter((p) => chars(p.text) < SCAN_CHARS_PER_PAGE).map((p) => ({ unit: p.page, reason: 'scan_no_text' })),
      ...(r.failed || []).map((f) => ({ unit: f.page, reason: 'ocr_failed', note: f.error })),
      ...(r.total == null ? [{ unit: null, reason: 'unknown_tail', note: `распознаны первые ${seen} стр. — конец файла не достигнут` }] : []),
    ];
    const tail = r.total == null ? `; файл длиннее — распознаны первые ${seen} стр., остальные не прочитаны` : '';
    return {
      status: 'ok', pages: got,
      message: `Файл открылся только как набор картинок — текст распознан автоматически (${got.length} стр.${tail}), возможны опечатки`,
      coverage: fileCoverage({ unit: 'page', expected: r.total ?? null, processed: got.length, unread, ocr: got.map((p) => p.page), method: 'ocr_images' }),
    };
  }

  // уже распознанное раньше — подставляем сразу
  if (known) for (const p of pages) { const t = known.get(p.page); if (t && chars(t) > chars(p.text)) { p.text = t; p.ocr = true; } }
  const hasText = (p) => chars(p.text) >= SCAN_CHARS_PER_PAGE;
  const empty = pages.filter((p) => !hasText(p));
  if (!empty.length) {
    return { status: 'ok', pages: strip(pages), coverage: fileCoverage({ unit: 'page', expected: totalPages, processed: pages.length, ocr: pages.filter((p) => p.ocr).map((p) => p.page), method: 'text_layer' }) };
  }

  // пустые листы отделяем от страниц-картинок: на первых читать нечего, вторые нужно распознать
  const blank = [];
  const scans = [];
  for (const p of empty) ((await pageHasGraphics(pdf, p.page)) === false ? blank : scans).push(p.page);
  const blankSet = new Set(blank);
  const isScan = pages.reduce((n, p) => n + chars(p.text), 0) < SCAN_CHARS_PER_PAGE * Math.max(totalPages, 1);
  const cover = (unread, ocrPages) => fileCoverage({
    unit: 'page', expected: totalPages, processed: pages.filter(hasText).length,
    empty: blank, unread, ocr: [...new Set([...pages.filter((p) => p.ocr).map((p) => p.page), ...ocrPages])], method: isScan ? 'ocr' : 'text_layer+ocr',
  });
  if (!scans.length) {
    if (!pages.some(hasText)) return { status: 'error', message: 'В файле PDF только пустые страницы — текста и изображений нет', pages: [], coverage: unreadableCoverage(false, 'blank') };
    return { status: 'ok', pages: strip(pages), coverage: cover([], []) };
  }

  if (!ocr || !(await ocr.pdfReady())) {
    return isScan
      ? { status: 'scan_no_text', message: 'Скан без текстового слоя — на сервере нет программы распознавания текста, откройте файл вручную', pages: [], coverage: unreadableCoverage(true, 'no_ocr') }
      : { status: 'ok', pages: strip(pages), message: `Страниц-сканов без текста: ${scans.length} из ${totalPages} — они не прочитаны`, coverage: cover(scans.map((n) => ({ unit: n, reason: 'no_ocr' })), []) };
  }
  // Скан целиком — распознаём все страницы; обычный PDF с несколькими отсканированными листами — только их.
  const wanted = (isScan ? pages.filter((p) => !blankSet.has(p.page) && !p.ocr) : pages.filter((p) => scans.includes(p.page))).map((p) => p.page);
  let recognized;
  try {
    recognized = await ocr.pdf(buffer, { pages: wanted, onPage: (i, n) => onNote(`распознаю скан: страница ${i} из ${n}`) });
  } catch (err) {
    return isScan && !pages.some(hasText)
      ? { status: 'scan_no_text', message: `Скан распознать не удалось: ${err.message}`, pages: [], coverage: unreadableCoverage(true, 'ocr_failed') }
      : { status: 'ok', pages: strip(pages), message: `Страницы-сканы (${scans.length}) распознать не удалось: ${err.message}`, coverage: cover(scans.map((n) => ({ unit: n, reason: 'ocr_failed', note: String(err.message).slice(0, 200) })), []) };
  }
  const byPage = new Map(recognized.pages.map((p) => [p.page, p.text]));
  const ocrPages = [];
  for (const p of pages) {
    const t = byPage.get(p.page);
    if (t && chars(t) > chars(p.text)) { p.text = t; ocrPages.push(p.page); }
  }
  const failed = new Map((recognized.failed || []).map((f) => [f.page, f.error]));
  const pending = new Set(recognized.pending || []);
  // что осталось без текста: упало распознавание, не дошла очередь или на странице рисунок без распознанного текста
  const unread = pages.filter((p) => !hasText(p) && !blankSet.has(p.page)).map((p) => (failed.has(p.page)
    ? { unit: p.page, reason: 'ocr_failed', note: failed.get(p.page) }
    : pending.has(p.page) ? { unit: p.page, reason: 'ocr_budget' } : { unit: p.page, reason: 'scan_no_text' }));
  if (!pages.some(hasText)) {
    return { status: 'scan_no_text', message: 'Скан распознан, но текста на страницах не нашлось (пустые листы, фото или очень плохое качество)', pages: [], coverage: unreadableCoverage(true, 'scan_no_text') };
  }
  const left = unread.length ? `; не прочитано страниц: ${unread.length} (${compactList(unread.map((u) => u.unit))})` : '';
  return {
    status: 'ok', pages: strip(pages),
    message: isScan
      ? `Скан: текст распознан автоматически (${ocrPages.length} стр.${left}) — возможны опечатки, важные цифры сверяйте с оригиналом`
      : `Распознано страниц-сканов: ${ocrPages.length} из ${scans.length}${left} — в них возможны опечатки`,
    coverage: cover(unread, ocrPages),
  };
}
/** Страницы без служебных пометок. */
const strip = (pages) => pages.map(({ page, text }) => ({ page, text }));

/** Большие картинки внутри документа Word: сканы листов, вставленные в файл. Мелкие (логотипы, печати) не считаются. */
function docxImages(buffer) {
  try {
    return new AdmZip(buffer).getEntries()
      .filter((e) => /^word\/media\/[^/]+\.(png|jpe?g|tiff?|bmp|gif)$/i.test(e.entryName) && e.header.size >= MIN_OCR_IMAGE_BYTES)
      .map((e) => ({ name: e.entryName.split('/').pop(), buffer: e.getData() }));
  } catch {
    return [];
  }
}

async function extractDocx(buffer, { ocr, onNote = () => {} } = {}) {
  // Таблицы сохраняем построчно (ячейки через « | »): так видно, какое количество и какие характеристики относятся
  // к какой позиции. Не получилось разобрать разметку — берём обычный текст, как раньше.
  let text = '';
  let tables = 0;
  try {
    const { value: html } = await mammoth.convertToHtml({ buffer });
    ({ text, tables } = htmlWithTables(html || ''));
  } catch { text = ''; }
  if (!text.trim()) ({ value: text } = await mammoth.extractRawText({ buffer }));
  const pages = splitFragments(text || '');
  // Текст на картинках (вставленные сканы) в текстовый слой не попадает — распознаём отдельно.
  const images = docxImages(buffer);
  const unread = [];
  const ocrBlocks = [];
  let noText = 0;
  if (images.length) {
    const can = Boolean(ocr && (await ocr.ready()));
    const budget = can ? Math.min(images.length, ocr.maxPages) : 0;
    for (const [i, img] of images.entries()) {
      if (i >= budget) { unread.push({ unit: null, reason: can ? 'ocr_budget' : 'no_ocr', note: `изображение ${img.name}` }); continue; }
      onNote(`распознаю текст на изображении ${i + 1} из ${images.length}`);
      try {
        const text = await ocr.image(img.buffer, path.extname(img.name).toLowerCase());
        if (chars(text) >= SCAN_CHARS_PER_PAGE) {
          pages.push({ page: pages.length + 1, text: `[Изображение из документа: ${img.name} — текст распознан автоматически, возможны опечатки]\n${text}` });
          ocrBlocks.push(pages.length);
        } else noText++;
      } catch (err) {
        unread.push({ unit: null, reason: 'ocr_failed', note: `изображение ${img.name}: ${String(err.message).slice(0, 120)}` });
      }
    }
  }
  if (!pages.length) return { status: 'error', message: 'В документе Word нет текста (возможно, внутри только картинки-сканы)', pages: [], coverage: unreadableCoverage(true, 'empty') };
  const notes = [
    ocrBlocks.length ? `распознан текст на изображениях: ${ocrBlocks.length}` : null,
    unread.length ? `изображений не прочитано: ${unread.length}` : null,
    noText ? `изображений без текста (фото, схемы): ${noText} — посмотрите их в файле` : null,
  ].filter(Boolean);
  return {
    status: 'ok', pages, ...(notes.length ? { message: `В документе есть изображения: ${notes.join('; ')}` } : {}),
    coverage: { ...fileCoverage({ unit: 'block', expected: pages.length + unread.length, processed: pages.length, unread, ocr: ocrBlocks, method: 'text' }), images_no_text: noText, tables },
  };
}

/** Старый Word (.doc, до 2007 года) — в документации госзакупок встречается часто. */
async function extractDoc(buffer) {
  const doc = await new WordExtractor().extract(buffer);
  const text = [doc.getBody(), doc.getFootnotes(), doc.getEndnotes()].filter((t) => t && t.trim()).join('\n\n');
  return textResult(text, 'В файле .doc нет текста');
}

// Служебные группы RTF, в которых нет текста документа (шрифты, стили, картинки, метаданные).
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata', 'colorschememapping',
  'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'filetbl',
  'revtbl', 'pgdsctbl', 'wgrffmtfilter', 'fldinst', 'bkmkstart', 'bkmkend', 'protusertbl', 'defchp', 'defpap']);

/** Текст из RTF: байты \'hh — в кодировке \ansicpg (обычно 1251), \uN — Юникод, \par/\cell — переносы. */
function rtfToText(buffer) {
  const src = buffer.toString('latin1');
  const cp = Number(/\\ansicpg(\d+)/.exec(src)?.[1]) || 1251;
  let decoder;
  try { decoder = new TextDecoder(`windows-${cp}`); } catch { decoder = new TextDecoder('windows-1251'); }
  const out = [];
  let bytes = [];
  const flush = () => { if (bytes.length) { out.push(decoder.decode(Uint8Array.from(bytes))); bytes = []; } };
  const stack = [];
  let st = { skip: false, uc: 1 };
  let skipChars = 0; // символы-заменители после \uN
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { flush(); stack.push(st); st = { ...st }; continue; }
    if (ch === '}') { flush(); st = stack.pop() || { skip: false, uc: 1 }; continue; }
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === "'") {
        const b = parseInt(src.substr(i + 2, 2), 16);
        i += 3;
        if (skipChars > 0) { skipChars--; continue; }
        if (!st.skip && Number.isFinite(b)) bytes.push(b);
        continue;
      }
      if (next === '*') { st.skip = true; i++; continue; }
      if (next === '\\' || next === '{' || next === '}') { i++; if (!st.skip) { flush(); out.push(next); } continue; }
      if (next === '~') { i++; if (!st.skip) { flush(); out.push(' '); } continue; }
      if (next === '\n' || next === '\r') { i++; if (!st.skip) { flush(); out.push('\n'); } continue; }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i + 1, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      const [, word, arg] = m;
      if (RTF_SKIP.has(word)) { st.skip = true; continue; }
      if (word === 'uc') { st.uc = Number(arg) || 0; continue; }
      if (st.skip) continue;
      if (word === 'u') {
        flush();
        const n = Number(arg);
        out.push(String.fromCharCode(n < 0 ? n + 65536 : n));
        skipChars = st.uc;
        continue;
      }
      if (word === 'par' || word === 'line' || word === 'row' || word === 'sect' || word === 'page') { flush(); out.push('\n'); }
      else if (word === 'cell' || word === 'tab') { flush(); out.push('\t'); }
      continue;
    }
    if (ch === '\r' || ch === '\n') continue;
    if (skipChars > 0) { skipChars--; continue; }
    if (!st.skip) { flush(); out.push(ch); }
  }
  flush();
  return out.join('').replace(/[ \t]+\n/g, '\n');
}

/**
 * Таблица: каждый лист (и скрытый тоже) — отдельные фрагменты по группам строк; в каждом фрагменте повторяется
 * строка заголовков и указаны лист и номера строк — по ним находится источник значения.
 * Объединённые ячейки: значение повторяется во всех ячейках объединения — строки-продолжения не теряют связь с позицией.
 */
function extractSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const pages = [];
  const sheets = [];
  wb.SheetNames.forEach((name, si) => {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) return;
    const hidden = Boolean(wb.Workbook?.Sheets?.[si]?.Hidden);
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (const m of ws['!merges'] || []) {
      if ((m.e.r - m.s.r + 1) * (m.e.c - m.s.c + 1) > 400) continue;
      const src = ws[XLSX.utils.encode_cell(m.s)];
      if (!src) continue;
      // по вертикали — «то же, что выше» (строка-продолжение не теряет связь с позицией); по горизонтали текст не повторяем
      for (let r = m.s.r + 1; r <= m.e.r; r++) {
        const addr = XLSX.utils.encode_cell({ r, c: m.s.c });
        if (!ws[addr] || ws[addr].v == null || ws[addr].v === '') ws[addr] = { t: 's', v: SAME, w: SAME };
      }
    }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: true, defval: '' });
    const lines = [];
    rows.forEach((cells, i) => {
      const vals = cells.map((v) => String(v ?? '').replace(/\s*\n\s*/g, ' ').trim());
      while (vals.length && !vals[vals.length - 1]) vals.pop();
      if (vals.some(Boolean)) lines.push({ row: range.s.r + i + 1, text: vals.join(' | ') });
    });
    if (!lines.length) return;
    sheets.push(name);
    const head = lines[0];
    const title = `Лист «${name}»${hidden ? ' (скрытый лист)' : ''}`;
    let cur = [];
    let size = 0;
    const flush = () => {
      if (!cur.length) return;
      const repeat = cur[0].row !== head.row && head.text.length < 600 ? [head.text] : [];
      const rowsNote = cur.length > 1 || lines.length > 1 ? `, строки ${cur[0].row}–${cur[cur.length - 1].row}` : '';
      pages.push({
        page: pages.length + 1,
        text: [`${title}${lines.length > cur.length ? rowsNote : ''}`, ...repeat, ...cur.map((l) => l.text)].join('\n'),
        locator: { sheet: name, rows: [cur[0].row, cur[cur.length - 1].row] },
      });
      cur = [];
      size = 0;
    };
    for (const l of lines) {
      if (size + l.text.length + 1 > FRAGMENT_CHARS && cur.length) flush();
      cur.push(l);
      size += l.text.length + 1;
    }
    flush();
  });
  if (!pages.length) return { status: 'error', message: 'В таблице нет данных', pages: [], coverage: unreadableCoverage(false, 'empty') };
  return { status: 'ok', pages, coverage: { ...fileCoverage({ unit: 'sheet_rows', expected: pages.length, processed: pages.length, method: 'cells' }), sheets } };
}

/** Текст в кодировке файла: UTF-8 (с пометкой и без), UTF-16, иначе Windows-1251. charset — подсказка из самого файла. */
function decodeText(buffer, charset = null) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  if (charset && !/^utf-?8$/i.test(charset)) {
    try { return new TextDecoder(charset).decode(buffer); } catch { /* неизвестная кодировка — определяем сами */ }
  }
  const utf8 = buffer.toString('utf8').replace(/^﻿/, '');
  const broken = (utf8.match(/�/g) || []).length;
  return broken > 3 ? new TextDecoder('windows-1251').decode(buffer) : utf8;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', deg: '°', times: '×', sup2: '²', sup3: '³', plusmn: '±', le: '≤', ge: '≥', numero: '№' };
const unescapeXml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z0-9]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

/** HTML → текст: без скриптов и стилей, абзацы и строки таблиц — с новой строки, ячейки — через « | ». */
function htmlToText(buffer) {
  const head = buffer.subarray(0, 2000).toString('latin1');
  const charset = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] || /encoding\s*=\s*["']([\w-]+)/i.exec(head)?.[1] || null;
  const html = decodeText(buffer, charset);
  return unescapeXml(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title|xml)[\s>][\s\S]*?<\/\1>/gi, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table|\/section|\/article|hr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[  ]+/g, ' ').replace(/ ?\| ?\n/g, '\n').replace(/\n /g, '\n').trim();
}

/** XML → текст: значения элементов, каждое с новой строки. Для выгрузок и документов Word 2003 в XML. */
function xmlToText(buffer) {
  const head = buffer.subarray(0, 300).toString('latin1');
  const xml = decodeText(buffer, /encoding\s*=\s*["']([\w-]+)/i.exec(head)?.[1] || null);
  return unescapeXml(xml
    .replace(/<\?[\s\S]*?\?>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    // знаки «<» внутри CDATA — текст, а не теги
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
    .replace(/<(w:binData|pkg:binaryData|o:DocumentProperties)[\s>][\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(w:p|text:p|p|row|item)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ').replace(/\n /g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** Документ или презентация OpenOffice / LibreOffice (ODT, ODP): текст лежит в content.xml. */
function extractOdf(buffer) {
  const entry = new AdmZip(buffer).getEntry('content.xml');
  if (!entry) return { status: 'error', message: 'В файле OpenOffice нет содержимого', pages: [] };
  const text = unescapeXml(entry.getData().toString('utf8')
    .replace(/<text:tab[^>]*\/>/g, '\t').replace(/<text:line-break[^>]*\/>/g, '\n').replace(/<text:s[^>]*\/>/g, ' ')
    // ячейка таблицы — в одну строку: абзацы внутри неё склеиваем, ячейки разделяем « | »
    .replace(/<table:table-cell[^>]*>([\s\S]*?)<\/table:table-cell>/g, (m, cell) => `${cell.replace(/<\/(text:p|text:h)>/g, ' ')} | `)
    .replace(/<\/(text:p|text:h|table:table-row|draw:page)>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/ ?\| ?\n/g, '\n').replace(/[  ]{2,}/g, ' ');
  return textResult(text, 'В документе OpenOffice нет текста');
}

/** Презентация PowerPoint (PPTX): текст каждого слайда — отдельной «страницей». */
function extractPptx(buffer) {
  const zip = new AdmZip(buffer);
  const slides = zip.getEntries().filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => parseInt(a.entryName.match(/\d+/)[0], 10) - parseInt(b.entryName.match(/\d+/)[0], 10));
  const pages = slides.map((e, i) => ({
    page: i + 1,
    text: unescapeXml(e.getData().toString('utf8').replace(/<\/a:p>/g, '\n').replace(/<a:br[^>]*\/>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{2,}/g, '\n').trim(),
  })).filter((p) => p.text);
  return pages.length ? { status: 'ok', pages } : { status: 'error', message: 'В презентации нет текста', pages: [] };
}

/** Картинка: скан или фото документа — текст распознаётся. */
async function extractImage(buffer, type, { ocr } = {}) {
  if (buffer.length < MIN_OCR_IMAGE_BYTES) return { coverage: unreadableCoverage(false, 'tiny_image'), status: 'unsupported', message: 'Маленькая картинка (логотип, печать или подпись) — текста в ней нет', pages: [] };
  if (!ocr || !(await ocr.ready())) return { coverage: unreadableCoverage(true, 'no_ocr'), status: 'scan_no_text', message: 'Изображение — на сервере нет программы распознавания текста, откройте файл вручную', pages: [] };
  const text = await ocr.image(buffer, type);
  if (chars(text) < SCAN_CHARS_PER_PAGE) return { coverage: unreadableCoverage(true, 'scan_no_text'), status: 'scan_no_text', message: 'На изображении текст не найден (фото, схема или очень плохое качество)', pages: [] };
  return { coverage: fileCoverage({ unit: 'image', expected: 1, processed: 1, ocr: [1], method: 'ocr' }), status: 'ok', pages: splitFragments(text), message: 'Изображение: текст распознан автоматически — возможны опечатки, важные цифры сверяйте с оригиналом' };
}

/**
 * Имена файлов в ZIP из ЕИС часто в CP866, причём флаг UTF-8 бывает выставлен неверно.
 * Поэтому смотрим на сами байты: валидный UTF-8 — берём как есть, иначе декодируем CP866.
 */
function zipEntryName(entry) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(entry.rawEntryName);
  } catch {
    return new TextDecoder('ibm866').decode(entry.rawEntryName);
  }
}

// Общие экземпляры: распознавание идёт по одному файлу за раз на весь сервер.
let shared = null;
function defaults() {
  if (!shared) {
    const config = require('../config');
    // Временные файлы (страницы-картинки, распакованные архивы) — в папке данных сервиса: она точно доступна
    // на запись, в отличие от системной /tmp, которая на сервере может быть закрыта.
    const tmpRoot = path.join(config.DATA_DIR, 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    shared = {
      ocr: createOcr({ enabled: config.OCR_ENABLED, langs: config.OCR_LANGS, maxPages: config.OCR_MAX_PAGES, dpi: config.OCR_DPI, tmpRoot }),
      archiver: createArchiver({ tmpRoot }),
    };
  }
  return shared;
}

/** Файлы архива: ZIP читаем сами; RAR, 7z и «битые» ZIP — внешней программой. null — распаковать нечем. */
async function archiveEntries(buffer, type, archiver) {
  if (type === '.zip') {
    try {
      return new AdmZip(buffer).getEntries().filter((e) => !e.isDirectory).map((e) => ({ name: zipEntryName(e), buffer: e.getData() }));
    } catch (err) {
      // Например, два файла с одним именем в оглавлении — библиотека отказывается, внешняя программа справляется.
      if (!(await archiver.available())) throw err;
    }
  }
  if (!(await archiver.available())) return null;
  return archiver.extractAll(buffer, type);
}

/**
 * Содержимое сохранённого файла документации, в том числе лежащего внутри архива (имя «Документация.zip/ТЗ/1_ООЗ.docx»):
 * диск хранит сам архив, нужный файл достаём из него (вложенные архивы — тоже).
 * @param {string} diskPath путь к загруженному файлу (архиву или самому документу)
 * @param {string} name имя файла в разборе
 * @returns {Promise<Buffer|null>}
 */
async function readStoredFile(diskPath, name, { archiver = defaults().archiver } = {}) {
  let buffer = fs.readFileSync(diskPath);
  let rest = String(name || '');
  // «a.zip/b/c.docx» → в архиве a.zip ищем «b/c.docx»; если внутри снова архив — повторяем.
  for (let depth = 0; depth <= MAX_ZIP_DEPTH; depth++) {
    const m = /^(.*?\.(?:zip|rar|7z|tar|gz|tgz))\/(.+)$/i.exec(rest);
    if (!m) return buffer;
    const inner = m[2];
    const kind = detectType(m[1], buffer);
    const entries = await archiveEntries(buffer, ARCHIVE.has(kind) ? kind : '.zip', archiver);
    if (!entries) return null;
    const exact = entries.find((e) => e.name === inner);
    if (exact) return exact.buffer;
    const nested = entries.find((e) => /\.(zip|rar|7z|tar|gz|tgz)$/i.test(e.name) && inner.startsWith(`${e.name}/`));
    if (!nested) return null;
    buffer = nested.buffer;
    rest = inner;
  }
  return null;
}

/** Результат без отчёта о полноте (старые форматы): текст извлечён целиком — условные блоки, охват полный. */
function withBlocks(r) {
  if (r.coverage) return r;
  return r.status === 'ok'
    ? { ...r, coverage: fileCoverage({ unit: 'block', expected: r.pages.length, processed: r.pages.length, method: 'text' }) }
    : { ...r, coverage: unreadableCoverage(true, r.status) };
}

/**
 * Извлекает текст из файла. Архивы раскрываются рекурсивно, поэтому результат — массив.
 * opts.onNote(text) — что сейчас делается внутри долгого файла («распознаю скан: страница 3 из 12»).
 * @returns {Promise<Array<{name, mime, status, message?, pages: Array<{page, text}>}>>}
 */
async function extractFile({ name, buffer }, depth = 0, opts = {}) {
  const ocr = opts.ocr || defaults().ocr;
  const archiver = opts.archiver || defaults().archiver;
  const type = detectType(name, buffer);
  // sha256 — версия файла: изменился документ — изменился хеш, и результаты прежней версии больше не действуют
  const base = { name, mime: MIME[type] || 'application/octet-stream', sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
  // blocking: файл мог содержать условия закупки, и мы его не прочли (архив не распакован, неизвестный формат);
  // не blocking — в файле текста документации нет в принципе (подпись, сертификат, видео)
  const skip = (message, blocking = true) => [{ ...base, status: 'unsupported', message, pages: [], coverage: unreadableCoverage(blocking, 'unsupported') }];

  if (!buffer.length) return [{ ...base, status: 'error', message: 'Пустой файл (0 байт)', pages: [], coverage: unreadableCoverage(true, 'empty') }];
  if (NO_TEXT[type]) return skip(NO_TEXT[type], MAYBE_DOCUMENT.has(type));

  try {
    if (type === '.pdf') return [{ ...base, ...(await extractPdf(buffer, { ocr, onNote: opts.onNote, known: opts.known?.get(name) || null })) }];
    if (WORD.has(type)) return [{ ...base, ...(await extractDocx(buffer, { ocr, onNote: opts.onNote })) }];
    if (type === '.doc') return [withBlocks({ ...base, ...(await extractDoc(buffer)) })];
    if (type === '.rtf') return [{ ...base, ...textResult(rtfToText(buffer), 'В файле RTF нет текста') }];
    if (SHEET.has(type)) return [{ ...base, ...extractSheet(buffer) }];
    if (type === '.odt' || type === '.odp') return [withBlocks({ ...base, ...extractOdf(buffer) })];
    if (type === '.pptx') return [withBlocks({ ...base, ...extractPptx(buffer) })];
    if (HTML.has(type)) return [{ ...base, ...textResult(htmlToText(buffer), 'В файле HTML нет текста') }];
    if (type === '.xml') return [{ ...base, ...textResult(xmlToText(buffer), 'В файле XML нет текста') }];
    if (TEXT.has(type)) return [{ ...base, ...textResult(decodeText(buffer), 'Пустой текстовый файл') }];
    if (IMAGE.has(type)) {
      opts.onNote?.('распознаю текст на изображении');
      return [{ ...base, ...(await extractImage(buffer, type, { ocr })) }];
    }
    if (type === '.zip' || ARCHIVE.has(type)) {
      if (depth >= MAX_ZIP_DEPTH) return skip('Слишком глубокая вложенность архивов');
      opts.onNote?.('распаковываю архив');
      const entries = await archiveEntries(buffer, type, archiver);
      if (!entries) return skip(`Архив ${ARCHIVE_TITLE[type] || ''} — на сервере нет программы распаковки; распакуйте его и загрузите файлы или ZIP`);
      const out = [];
      for (const entry of entries) {
        if (JUNK.test(entry.name)) continue;
        out.push(...(await extractFile({ name: `${name}/${entry.name}`, buffer: entry.buffer }, depth + 1, opts)));
      }
      return out.length ? out : [{ ...base, status: 'error', message: 'Пустой архив', pages: [], coverage: unreadableCoverage(false, 'empty') }];
    }
    return skip(`Формат «${type || 'без расширения'}» не читается — текста в таких файлах обычно нет; откройте вручную, если это документ`);
  } catch (err) {
    const why = /password|encrypt/i.test(err.message) ? 'файл защищён паролем' : err.message;
    return [{ ...base, status: 'error', message: `Не удалось прочитать файл: ${why}`, pages: [], coverage: unreadableCoverage(true, 'error') }];
  }
}

module.exports = { extractFile, splitFragments, detectType, rtfToText, htmlToText, xmlToText, readStoredFile, MIME };
