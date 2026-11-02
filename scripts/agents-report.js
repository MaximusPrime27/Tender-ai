// Короткая сводка по агентам за последние дни: прогоны, ошибки, показатели по дням, частые уроки, открытые задачи.
// База только читается. Вывод рассчитан на экран телефона.
//   node scripts/agents-report.js [путь к app.db] [--days 7]
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const file = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'data/app.db';
if (!fs.existsSync(file)) { console.error(`Нет файла базы: ${file}. Укажите путь: node scripts/agents-report.js <путь к app.db>`); process.exit(1); }
const days = Number(arg('days', 7));
const db = new DatabaseSync(file, { readOnly: true });
const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };
const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

console.log(`АГЕНТЫ за ${days} дн. (с ${since})\n`);

console.log('== Прогоны: агент | всего | ошибок | последний');
for (const r of all(`SELECT agent, COUNT(*) n, SUM(status='error') err, MAX(started_at) last
  FROM agents_runs WHERE started_at >= ? GROUP BY agent ORDER BY agent`, since)) {
  console.log(`${r.agent} | ${r.n} | ${r.err} | ${String(r.last).slice(5, 16).replace('T', ' ')}`);
}

console.log('\n== Последние ошибки');
for (const r of all(`SELECT agent, started_at, error FROM agents_runs WHERE status='error' AND started_at >= ?
  ORDER BY started_at DESC LIMIT 8`, since)) {
  console.log(`${String(r.started_at).slice(5, 16)} ${r.agent}: ${String(r.error).slice(0, 120)}`);
}

console.log('\n== Показатели по дням (агент.показатель: значения по дням, старые → новые)');
const dayList = all('SELECT DISTINCT day FROM agents_metrics WHERE day >= ? ORDER BY day', since).map((r) => r.day);
console.log(`дни: ${dayList.map((d) => d.slice(5)).join(' ')}`);
const series = {};
for (const r of all('SELECT agent, day, key, value FROM agents_metrics WHERE day >= ?', since)) {
  (series[`${r.agent}.${r.key}`] ??= {})[r.day] = r.value;
}
for (const k of Object.keys(series).sort()) {
  const v = dayList.map((d) => (series[k][d] == null ? '-' : +Number(series[k][d]).toFixed(2)));
  console.log(`${k}: ${v.join(' ')}`);
}

console.log('\n== Частые уроки (агент | код | площадка | раз | источник)');
for (const r of all(`SELECT agent, code, scope, count, source, title FROM agents_lessons
  WHERE last_at >= ? ORDER BY count DESC LIMIT 15`, since)) {
  console.log(`${r.agent} | ${r.code} | ${r.scope || '—'} | ${r.count} | ${r.source || ''} — ${String(r.title).slice(0, 70)}`);
}

console.log('\n== Задачи управляющего: открытые и закрытые за период');
for (const r of all(`SELECT status, whom, what, goal, deadline, result FROM agent_tasks
  WHERE status='open' OR closed_at >= ? ORDER BY status, deadline LIMIT 15`, since)) {
  console.log(`[${r.status}] ${r.whom}: ${String(r.what).slice(0, 70)} | цель: ${String(r.goal).slice(0, 50)} | срок ${String(r.deadline).slice(5, 10)}${r.result ? ` | итог: ${String(r.result).slice(0, 50)}` : ''}`);
}
