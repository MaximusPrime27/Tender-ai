// Фото товаров из документации закупки: картинки внутри файлов Word (.docx), в том числе в архивах.
// Маленькие картинки (логотипы, печати, подписи) и векторные EMF/WMF пропускаем. Для каждой картинки
// запоминаем текст перед ней — по нему потом понимаем, к какой позиции ТЗ относится фото.
// PDF и старый .doc не разбираем: картинки там достать надёжно без сторонних программ нельзя.

const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const MIN_BYTES = 15 * 1024;
const MAX_BYTES = 3 * 1024 * 1024; // больше Яндекс не принимает для поиска по картинке
const IMAGE_RE = /\.(png|jpe?g|gif|bmp)$/i;

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };
const xmlText = (s) => String(s).replace(/<w:tab\/>/g, ' ').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** Размер картинки по заголовку файла (PNG, JPEG, GIF, BMP) без сторонних библиотек. @returns {{width, height}|null} */
function imageSize(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.toString('ascii', 0, 2) === 'BM') return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

/**
 * Скан страницы документа, а не фото товара: крупная картинка с пропорциями листа А4 или Letter (1 : 1,29–1,41).
 * Такие вставляют в Word вместо текста (подписанное ТЗ, печати) — искать по ним в Яндексе бессмысленно.
 */
function looksLikeScannedPage(size) {
  if (!size?.width || !size?.height) return false;
  const long = Math.max(size.width, size.height);
  const ratio = long / Math.min(size.width, size.height);
  return long >= 1000 && ratio >= 1.25 && ratio <= 1.5; // А4 — 1,41, Letter — 1,29
}

/** Картинки одного .docx: [{name, ext, buffer, size, context}] — context — текст перед картинкой в документе. */
function imagesFromDocx(buf, fileName) {
  let zip;
  try { zip = new AdmZip(buf); } catch { return []; }
  const doc = zip.getEntry('word/document.xml')?.getData().toString('utf8') || '';
  const rels = zip.getEntry('word/_rels/document.xml.rels')?.getData().toString('utf8') || '';
  const target = Object.fromEntries([...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], `word/${m[2].replace(/^\.?\//, '')}`]));
  const out = [];
  const seen = new Set();
  for (const m of doc.matchAll(/r:embed="([^"]+)"/g)) {
    const entryName = target[m[1]];
    if (!entryName || seen.has(entryName) || !IMAGE_RE.test(entryName)) continue;
    const entry = zip.getEntry(entryName);
    if (!entry) continue;
    const data = entry.getData();
    if (data.length < MIN_BYTES || data.length > MAX_BYTES) continue;
    const dims = imageSize(data);
    if (looksLikeScannedPage(dims)) continue;
    seen.add(entryName);
    const before = xmlText(doc.slice(Math.max(0, m.index - 6000), m.index)).replace(/\s+/g, ' ').trim();
    const ext = entryName.split('.').pop().toLowerCase();
    out.push({ file: fileName, name: entryName.split('/').pop(), ext, mime: MIME[ext] || 'application/octet-stream', buffer: data, size: data.length, width: dims?.width ?? null, height: dims?.height ?? null, context: before.slice(-400) });
  }
  return out;
}

// В этих документах картинки — формулы, печати, образцы форм, а не фото товара.
const NOT_PRODUCT_DOC = /обосновани|нмцк|начальн\S*\s*\(?максимальн|требовани\S*\s+к\s+(заявк|содержани|участник|составу)|инструкци|проект\S*\s*(договор|контракт)|образ(ец|цы)\s+форм|форм[аы]\s+заявк|запрос|разъяснени/i;

/** Все фото из папки с документами разбора (файлы Word, архивы ZIP с Word, отдельные картинки). */
function extractPhotos(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (!fs.statSync(full).isFile()) continue;
    let name = f;
    try { name = decodeURIComponent(f); } catch { /* имя без кодирования */ }
    name = name.replace(/^\d{13}-/, ''); // префикс времени у загруженных вручную файлов
    const buf = fs.readFileSync(full);
    if (/\.docx$/i.test(name)) out.push(...imagesFromDocx(buf, name));
    else if (/\.zip$/i.test(name)) {
      try {
        for (const e of new AdmZip(buf).getEntries()) {
          if (!e.isDirectory && /\.docx$/i.test(e.entryName)) out.push(...imagesFromDocx(e.getData(), `${name}/${e.entryName}`));
        }
      } catch { /* повреждённый архив */ }
    } else if (IMAGE_RE.test(name) && buf.length >= MIN_BYTES && buf.length <= MAX_BYTES && !looksLikeScannedPage(imageSize(buf))) {
      const ext = name.split('.').pop().toLowerCase();
      out.push({ file: name, name, ext, mime: MIME[ext], buffer: buf, size: buf.length, context: '' });
    }
  }
  // Сначала — из ТЗ и описания объекта закупки; из обоснования цены, проекта контракта и форм — не берём.
  const tz = (x) => (/(тз|техническ|описани|специфик|оз)/i.test(x.file) ? 0 : 1);
  return out.filter((x) => !NOT_PRODUCT_DOC.test(x.file.split('/').pop())).sort((a, b) => tz(a) - tz(b));
}

module.exports = { extractPhotos, imagesFromDocx, imageSize, looksLikeScannedPage, NOT_PRODUCT_DOC, MIN_BYTES, MAX_BYTES };
