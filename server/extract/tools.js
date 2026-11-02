// Запуск внешних программ для чтения документов: tesseract (распознавание текста на сканах и картинках),
// pdftoppm (страница PDF → картинка), bsdtar (распаковка RAR и 7z). На сервере ставятся командой
// deploy/install-tools.sh. Если программы нет, соответствующие файлы просто помечаются как непрочитанные.

const { execFile } = require('node:child_process');

/** @returns {Promise<{stdout: Buffer|string, stderr: string}>} */
function run(cmd, args, { timeout = 120000, cwd, encoding = 'buffer', env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout, cwd, encoding, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
      // UTF-8: иначе bsdtar не может создать файлы с русскими именами, а tesseract портит вывод
      env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', ...(env || {}) },
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve({ stdout, stderr: String(stderr || '') });
    });
  });
}

const known = new Map();
/** Есть ли программа на этой машине (проверяется один раз). Ненулевой код выхода — программа есть; ENOENT — нет. */
function has(cmd, args = ['--version']) {
  if (!known.has(cmd)) {
    known.set(cmd, run(cmd, args, { timeout: 15000, encoding: 'utf8' }).then(() => true, (err) => err.code !== 'ENOENT' && err.code !== 'EACCES'));
  }
  return known.get(cmd);
}

module.exports = { run, has };
