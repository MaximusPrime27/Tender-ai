// Сколько документации видела нейросеть при прежнем чтении и сколько видит теперь — по уже сохранённым текстам
// разборов, без обращения к нейросети и без расходов.
//   node scripts/reading-coverage-report.js --data <папка с app.db> [--top 5] [--ids 12,34]
// Прежние правила (до доработки «полное чтение»):
//   позиции из документов  — первые 6 страниц каждого файла, склейка обрезалась по LLM_MAX_CHARS_PER_CHUNK;
//   требования ТЗ          — страницы по важности, пока помещаются в один LLM_MAX_CHARS_PER_CHUNK; остальные пропускались;
//   сканы                  — распознавались первые 40 страниц файла.
// Теперь: все страницы всех файлов идут в очередь фрагментов (buildChunkQueue).

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { buildChunkQueue } = require('../server/analyze/chunk');
const { rangesLength } = require('../server/analyze/coverage');

const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const dir = arg('data');
if (!dir) { console.error('Укажите папку с базой: --data <папка с app.db>'); process.exit(1); }
const LIMIT = Number(arg('limit', 24000));
const top = Number(arg('top', 5));
const ids = arg('ids') ? arg('ids').split(',').map(Number) : null;

const TZ_FILE = /(^|[^а-яё])(тз|т\.з\.)([^а-яё]|$)|техническ\S*\s+задан|описани\S*\s+(объекта|оз)|спецификац/i;
const NOT_TZ_FILE = /обосновани|нмцк|требовани\S*\s+к\s+(заявк|содержани|участник)|инструкци|проект\S*\s+контракт|запрос|разъяснен/i;
const TZ_PAGE = /техническое задание|описание объекта закупки|спецификаци|наименование товара|характеристик/i;

const db = new DatabaseSync(path.join(dir, 'app.db'), { readOnly: true });
const tenders = ids
  ? ids.map((id) => db.prepare('SELECT t.id, t.number, t.title, t.analysis_id FROM tenders t WHERE t.id = ?').get(id)).filter(Boolean)
  : db.prepare(`SELECT t.id, t.number, t.title, t.analysis_id, (SELECT SUM(LENGTH(f.text_json)) FROM files f WHERE f.analysis_id = t.analysis_id) AS size
      FROM tenders t JOIN analyses a ON a.id = t.analysis_id WHERE a.status = 'done' ORDER BY size DESC LIMIT ?`).all(top);

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const rows = [];
for (const t of tenders) {
  const files = db.prepare("SELECT id, original_name, status, message, text_json FROM files WHERE analysis_id = ? ORDER BY id").all(t.analysis_id);
  const docs = files.filter((f) => f.status === 'ok').map((f) => ({ id: f.id, name: f.original_name, status: 'ok', pages: JSON.parse(f.text_json || '[]') })).filter((d) => d.pages.length);
  const pages = docs.flatMap((d) => d.pages.filter((p) => (p.text || '').trim()).map((p) => ({ file: d.name, page: p.page, text: p.text })));
  const totalChars = pages.reduce((n, p) => n + p.text.length, 0);

  // прежнее извлечение позиций: первые 6 страниц файла, склейка до LIMIT символов
  const firstSix = docs.flatMap((d) => d.pages.filter((p) => p.page <= 6 && (p.text || '').trim()).map((p) => `<<<ФАЙЛ: ${d.name} | СТРАНИЦА: ${p.page}>>>\n${p.text}`));
  const itemsOldChars = Math.min(firstSix.join('\n\n').length, LIMIT);

  // прежнее чтение ТЗ: страницы по важности, пока помещаются в LIMIT
  const scored = pages.map((pg, order) => {
    const fileScore = (TZ_FILE.test(pg.file) ? 5 : 0) - (NOT_TZ_FILE.test(pg.file) ? 4 : 0);
    const nums = (pg.text.match(/\d\s*(шт|г\/м|мм|см|кг|л\b|мл|гб|мгц|ггц|вт|%)/gi) || []).length;
    return { ...pg, order, score: fileScore + (TZ_PAGE.test(pg.text) ? 3 : 0) + Math.min(3, Math.floor(nums / 5)) };
  });
  let size = 0;
  let specOldPages = 0;
  let specOldChars = 0;
  let skippedTzPages = 0;
  for (const pg of scored.slice().sort((a, b) => b.score - a.score || a.order - b.order)) {
    const block = pg.text.length + pg.file.length + 30;
    if (size + block > LIMIT) { if (pg.score >= 3) skippedTzPages++; continue; }
    size += block; specOldPages++; specOldChars += pg.text.length;
  }

  // теперь: очередь фрагментов по всем страницам
  const queue = buildChunkQueue(docs, LIMIT);
  const byPage = new Map();
  for (const c of queue) for (const r of c.ranges) { const k = `${r.fileId}:${r.page}`; if (!byPage.has(k)) byPage.set(k, []); byPage.get(k).push(r); }
  const newChars = [...byPage.values()].reduce((n, r) => n + rangesLength(r), 0);

  const ocrCut = files.filter((f) => /распознаны первые \d+ из \d+/.test(f.message || '')).map((f) => `${f.original_name}: ${f.message.match(/распознаны первые \d+ из \d+/)[0]}`);
  rows.push({
    id: t.id, number: t.number, title: String(t.title).slice(0, 60),
    files: `${docs.length} из ${files.length}`, pages: pages.length, chars: totalChars,
    items_old: `${pct(itemsOldChars, totalChars)} текста (стр. 1–6 каждого файла, до ${LIMIT} симв.)`,
    spec_old: `${specOldPages} из ${pages.length} стр. (${pct(specOldChars, totalChars)} текста)${skippedTzPages ? `; пропущено страниц, похожих на ТЗ: ${skippedTzPages}` : ''}`,
    now: `${pct(newChars, totalChars)} текста, фрагментов: ${queue.length}`,
    ocr_cut: ocrCut,
    n: { pages: pages.length, specOldPages, itemsOldShare: totalChars ? itemsOldChars / totalChars : 1, specOldShare: totalChars ? specOldChars / totalChars : 1, skippedTzPages, chunks: queue.length },
  });
}

// --summary — только итог по всем закупкам, без построчного вывода
const brief = process.argv.includes('--summary');
for (const r of brief ? [] : rows) {
  console.log(`\nЗакупка ${r.id} (№ ${r.number}) — ${r.title}`);
  console.log(`  файлов с текстом: ${r.files}; страниц/частей текста: ${r.pages}; символов: ${r.chars}`);
  console.log(`  позиции из документов, раньше: ${r.items_old}`);
  console.log(`  требования ТЗ, раньше:        ${r.spec_old}`);
  console.log(`  теперь (позиции и ТЗ):        ${r.now}`);
  if (r.ocr_cut.length) console.log(`  сканы, обрезанные лимитом 40 страниц: ${r.ocr_cut.join('; ')}`);
}
if (!rows.length) console.log('Закупок с готовым разбором не найдено.');
if (brief && rows.length) {
  const withText = rows.filter((r) => r.n.pages > 0);
  const cnt = (f) => withText.filter(f).length;
  console.log(`Закупок с разобранной документацией: ${withText.length}`);
  console.log(`  прежнее чтение ТЗ видело не все страницы: ${cnt((r) => r.n.specOldPages < r.n.pages)} (${pct(cnt((r) => r.n.specOldPages < r.n.pages), withText.length)})`);
  console.log(`  из них видело меньше половины текста: ${cnt((r) => r.n.specOldShare < 0.5)}; меньше 10% текста: ${cnt((r) => r.n.specOldShare < 0.1)}`);
  console.log(`  при этом пропускались страницы, похожие на ТЗ: ${cnt((r) => r.n.skippedTzPages > 0)} закупок`);
  console.log(`  прежнее извлечение позиций видело меньше половины текста: ${cnt((r) => r.n.itemsOldShare < 0.5)} (${pct(cnt((r) => r.n.itemsOldShare < 0.5), withText.length)})`);
  console.log(`  теперь на чтение ТЗ нужно больше одного фрагмента: ${cnt((r) => r.n.chunks > 1)}; больше 20 (не уложится в один проход): ${cnt((r) => r.n.chunks > 20)}`);
  const sorted = withText.map((r) => r.n.chunks).sort((a, b) => a - b);
  console.log(`  фрагментов на закупку: в среднем ${(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1)}, медиана ${sorted[Math.floor(sorted.length / 2)]}, максимум ${sorted.at(-1)} — раньше на чтение ТЗ уходил один запрос`);
}
