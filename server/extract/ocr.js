// Распознавание текста (OCR): сканы PDF без текстового слоя и картинки (фото документа, скан в JPG/PNG/TIFF).
// Работает через программы tesseract и pdftoppm; если их нет — ready() вернёт false, и файл останется «сканом».
// Распознаём по одной странице и по одному файлу за раз: сервер небольшой, а страница занимает несколько секунд.
//
// Распознаются все страницы, которым это нужно, — партиями. maxPages — не «первые N страниц», а бюджет одного
// прохода: что не уместилось, возвращается списком pending и дочитывается следующим проходом
// («Повторить непрочитанные части»). Сбой на одной странице не отменяет уже распознанные.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('./tools');

/** Текст после распознавания: без пустых «мусорных» строк и разрывов страниц. */
const tidy = (s) => String(s || '').replace(/\f/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// Сколько страниц превращаем в картинки за один вызов, когда число страниц файла неизвестно.
const BATCH = 10;

function createOcr({
  run = tools.run, has = tools.has, enabled = true, langs = 'rus+eng', dpi = 200, maxPages = 200,
  pageTimeoutMs = 120000, tmpRoot = os.tmpdir(),
} = {}) {
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  let langArg = null;

  /** Можно ли распознавать картинки. Языки берём те, что установлены (русский обязателен для наших документов). */
  async function ready() {
    if (!enabled || !(await has('tesseract'))) return false;
    if (langArg == null) {
      try {
        const r = await run('tesseract', ['--list-langs'], { encoding: 'utf8', timeout: 15000 });
        const installed = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        langArg = langs.split('+').filter((l) => installed.includes(l)).join('+') || 'eng';
      } catch {
        langArg = langs;
      }
    }
    return true;
  }
  /** Можно ли распознавать сканы PDF (нужна ещё программа, которая превращает страницу в картинку). */
  const pdfReady = async () => (await ready()) && has('pdftoppm', ['-v']);

  const tmp = () => fs.mkdtempSync(path.join(tmpRoot, 'tender-ocr-'));
  const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка — не критично */ } };
  async function recognize(file) {
    const { stdout } = await run('tesseract', [file, 'stdout', '-l', langArg, '--psm', '3'], { timeout: pageTimeoutMs, encoding: 'utf8' });
    return tidy(stdout);
  }

  return {
    ready, pdfReady, maxPages,

    /** Текст с картинки. ext — расширение с точкой («.jpg»). */
    image(buffer, ext = '.png') {
      return exclusive(async () => {
        const dir = tmp();
        try {
          const file = path.join(dir, `image${/^\.[a-z0-9]+$/i.test(ext) ? ext : '.png'}`);
          fs.writeFileSync(file, buffer);
          return await recognize(file);
        } finally { cleanup(dir); }
      });
    },

    /**
     * Текст страниц PDF. pages — номера страниц (с 1); без них — все страницы файла, сколько бы их ни было.
     * @param budget сколько страниц распознать за этот проход (по умолчанию maxPages)
     * @returns {Promise<{pages: Array<{page, text}>, failed: Array<{page, error}>, pending: number[], total: number|null, truncated: boolean}>}
     *   failed — страницы, на которых распознавание упало; pending — не дошла очередь (бюджет прохода);
     *   total — сколько страниц в файле (null — конец файла не достигнут, число неизвестно);
     *   truncated — распознаны не все запрошенные страницы.
     */
    pdf(buffer, { pages = null, onPage = () => {}, budget = maxPages } = {}) {
      return exclusive(async () => {
        const dir = tmp();
        try {
          const file = path.join(dir, 'in.pdf');
          fs.writeFileSync(file, buffer);
          const out = [];
          const failed = [];
          if (pages) {
            const list = pages.slice(0, Math.max(0, budget));
            for (const [i, p] of list.entries()) {
              onPage(i + 1, list.length);
              const base = path.join(dir, `p${p}`);
              try {
                await run('pdftoppm', ['-r', String(dpi), '-f', String(p), '-l', String(p), '-gray', '-png', '-singlefile', file, base], { timeout: pageTimeoutMs });
                out.push({ page: p, text: await recognize(`${base}.png`) });
              } catch (err) {
                failed.push({ page: p, error: String(err.message || err).slice(0, 200) });
              } finally {
                fs.rmSync(`${base}.png`, { force: true });
              }
            }
            const pending = pages.slice(list.length);
            return { pages: out, failed, pending, total: null, truncated: pending.length > 0 || failed.length > 0 };
          }
          // Число страниц неизвестно (PDF не открылся обычным способом) — идём партиями, пока страницы не кончатся.
          let done = 0;
          let total = null;
          for (let from = 1; done < budget; from += BATCH) {
            const to = Math.min(from + BATCH - 1, from + (budget - done) - 1);
            let images = [];
            try {
              await run('pdftoppm', ['-r', String(dpi), '-f', String(from), '-l', String(to), '-gray', '-png', file, path.join(dir, 'p')], { timeout: pageTimeoutMs * 3 });
              images = fs.readdirSync(dir).filter((f) => /^p-\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
            } catch (err) {
              // первая же партия не получилась — файл не превращается в картинки вовсе; дальше — значит, страницы кончились
              if (from === 1) throw err;
            }
            if (!images.length) { total = from - 1; break; }
            for (const f of images) {
              const page = parseInt(f.slice(2), 10);
              onPage(done + 1, null);
              try { out.push({ page, text: await recognize(path.join(dir, f)) }); }
              catch (err) { failed.push({ page, error: String(err.message || err).slice(0, 200) }); }
              fs.rmSync(path.join(dir, f), { force: true });
              done++;
            }
            if (images.length < to - from + 1) { total = from + images.length - 1; break; } // партия неполная — это конец файла
          }
          return { pages: out, failed, pending: [], total, truncated: total == null || failed.length > 0 };
        } finally { cleanup(dir); }
      });
    },
  };
}

module.exports = { createOcr, tidy };
