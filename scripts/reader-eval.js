// Качество читателя по правилам на настоящих закупках: правила читают сохранённые тексты документов, ответ сверяется
// с данными ЕИС (цена заказчика, срок подачи). База только читается.
//   node scripts/reader-eval.js <путь к app.db> [сколько закупок, по умолчанию 300] [--show nmck]
const { DatabaseSync } = require('node:sqlite');
const { readByRules } = require('../server/analyze/rules');
const { grade } = require('../server/analyze/learn');
const { noticeFacts } = require('../server/tenders/notice-facts');

const file = process.argv[2];
const limit = Number(process.argv[3]) || 300;
const show = process.argv.includes('--show') ? process.argv[process.argv.indexOf('--show') + 1] : null;
const db = new DatabaseSync(file, { readOnly: true });
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const rows = db.prepare(`SELECT t.* FROM tenders t JOIN analyses a ON a.id = t.analysis_id WHERE a.status = 'done' ORDER BY t.id DESC LIMIT ?`).all(limit);
const sum = {};
for (const t of rows) {
  const docs = db.prepare('SELECT * FROM files WHERE analysis_id = ? ORDER BY id').all(t.analysis_id)
    .map((f) => ({ id: f.id, name: f.original_name, status: f.status, pages: J(f.text_json, []) })).filter((d) => d.status === 'ok' && d.pages.length);
  if (!docs.length) continue;
  const facts = noticeFacts(t, null).facts;
  const fields = readByRules(docs).fields;
  for (const g of grade(fields, facts, docs)) {
    const s = (sum[g.key] ||= { agree: 0, mismatch: 0, missed: 0, absent: 0 });
    s[g.result]++;
    if (show === g.key && g.result !== 'agree' && g.result !== 'absent') console.log(`${t.id} ${g.result}: прочитано «${g.rules || '—'}», в ЕИС «${g.eis}»`);
  }
}
for (const [k, s] of Object.entries(sum)) {
  const n = s.agree + s.mismatch + s.missed;
  console.log(`${k}: верно ${s.agree} из ${n} (${n ? Math.round((s.agree / n) * 100) : 0}%), не то ${s.mismatch}, не нашёл ${s.missed}, в документах нет ${s.absent}`);
}
