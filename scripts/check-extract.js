// Проверка чтения файлов документации: что сервис достанет из файла на этой машине.
//   node scripts/check-extract.js <файл> [ещё файлы…]     — прочитать файлы с диска
//   node scripts/check-extract.js --unread [N]            — перечитать до N файлов из базы, которые раньше не прочитались
// Печатает статус, причину, число страниц и начало текста. В базу ничего не пишет.
const fs = require('node:fs');
const path = require('node:path');
const { extractFile, readStoredFile } = require('../server/extract');

async function show(name, buffer) {
  const t0 = Date.now();
  const files = await extractFile({ name, buffer }, 0, { onNote: (n) => process.stdout.write(`   … ${n}\r`) });
  for (const f of files) {
    const text = f.pages.map((p) => p.text).join(' ').replace(/\s+/g, ' ');
    console.log(`${f.status.padEnd(12)} ${f.name}`);
    if (f.message) console.log(`             ${f.message}`);
    if (f.pages.length) console.log(`             стр.: ${f.pages.length}, символов: ${text.length} · «${text.slice(0, 160)}»`);
  }
  console.log(`             (${((Date.now() - t0) / 1000).toFixed(1)} с)\n`);
  return files;
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--unread') {
    const config = require('../server/config');
    const { openDb } = require('../server/db');
    const repo = openDb(config.DATA_DIR, { recoverInterrupted: false });
    const rows = repo.db.prepare(`SELECT original_name, path, status, message FROM files
      WHERE status IN ('scan_no_text', 'unsupported', 'error') AND path IS NOT NULL
        AND original_name NOT LIKE '%.sig' AND original_name NOT LIKE '%.sign' AND message NOT LIKE 'Не скачан%'
      ORDER BY id DESC LIMIT ?`).all(Number(args[1]) || 10);
    const seen = new Set();
    let better = 0;
    for (const r of rows) {
      if (seen.has(`${r.path}|${r.original_name}`) || !fs.existsSync(r.path)) continue;
      seen.add(`${r.path}|${r.original_name}`);
      console.log(`было: ${r.status} — ${r.message || ''}`);
      const buffer = await readStoredFile(r.path, r.original_name);
      if (!buffer) { console.log(`             не найден в архиве: ${r.original_name}\n`); continue; }
      const files = await show(r.original_name, buffer);
      if (files.some((f) => f.status === 'ok')) better++;
    }
    console.log(`Проверено файлов: ${seen.size}, теперь читается: ${better}`);
    return;
  }
  if (!args.length) { console.error('Укажите файл или --unread'); process.exit(1); }
  for (const file of args) await show(path.basename(file), fs.readFileSync(file));
})().catch((err) => { console.error(err); process.exit(1); });
