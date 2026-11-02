// Распаковка архивов, которые не умеет встроенная библиотека: RAR, 7z, tar, gz — и ZIP с ошибками в оглавлении.
// Работает через программу bsdtar; если её нет — available() вернёт false, и архив останется непрочитанным.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('./tools');

function createArchiver({ run = tools.run, has = tools.has, tmpRoot = os.tmpdir(), maxFiles = 400, maxBytes = 400 * 1024 * 1024, timeoutMs = 180000 } = {}) {
  const available = () => has('bsdtar');

  /**
   * Все файлы архива. Распаковываем во временную папку (она удаляется), пути выше неё bsdtar сам не допускает.
   * @returns {Promise<Array<{name: string, buffer: Buffer}>>} name — путь внутри архива через «/»
   */
  async function extractAll(buffer, ext = '.rar') {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'tender-arc-'));
    try {
      const file = path.join(dir, `archive${/^\.[a-z0-9]+$/i.test(ext) ? ext : ''}`);
      const outDir = path.join(dir, 'out');
      fs.mkdirSync(outDir);
      fs.writeFileSync(file, buffer);
      try {
        await run('bsdtar', ['-xf', file, '-C', outDir, '--no-same-owner', '--no-same-permissions'], { timeout: timeoutMs });
      } catch (err) {
        const why = /pass(word|phrase)|encrypt/i.test(err.stderr || '') ? 'архив защищён паролем'
          : (err.stderr || err.message || '').split('\n').filter(Boolean).pop() || 'ошибка распаковки';
        // Часть файлов могла распаковаться до ошибки — отдаём их, если есть; иначе сообщаем причину.
        if (!fs.readdirSync(outDir).length) throw new Error(why);
      }
      const out = [];
      let total = 0;
      const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (out.length >= maxFiles) return;
          const full = path.join(d, e.name);
          const name = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(full, name);
          else if (e.isFile()) { // ссылки и устройства пропускаем
            const size = fs.statSync(full).size;
            if (total + size > maxBytes) continue;
            total += size;
            out.push({ name, buffer: fs.readFileSync(full) });
          }
        }
      };
      walk(outDir, '');
      return out;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка — не критично */ }
    }
  }

  return { available, extractAll };
}

module.exports = { createArchiver };
