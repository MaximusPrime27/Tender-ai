// Воронка агента заявок за выбранные прогоны: причины отсева, частично подобранные закупки, что блокирует пакет,
// платные запросы на выгодную заявку. База только читается. --baseline <файл> дополнительно сохраняет эталон:
// выбранные товары, статусы сверки и вердикты по всем заявкам — с ним сравниваются правки подбора.
//   node scripts/pipeline-report.js <путь к app.db> [--from <номер прогона>] [--to <номер>] [--baseline <файл.json>]
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const J = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const q = (sql, ...a) => db.prepare(sql).all(...a);
const from = Number(arg('from', 39));
const to = Number(arg('to', 1e9));
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const top = (o, n = 12) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);

const items = q('SELECT * FROM bid_agent_items WHERE run_id BETWEEN ? AND ?', from, to);
const runs = q('SELECT id, reason, started_at, finished_at, stats_json FROM bid_agent_runs WHERE id BETWEEN ? AND ? ORDER BY id', from, to);
const stats = runs.map((r) => J(r.stats_json, {}));
console.log(`Прогоны ${from}–${runs.at(-1)?.id ?? '?'}: ${runs.length}, закупок ${items.length}, выгодных ${stats.reduce((s, x) => s + (x.profitable || 0), 0)}`);

const status = {};
const why = {};
const niche = {};
for (const i of items) {
  bump(status, i.status);
  if (i.status === 'error') bump(why, `ошибка: ${String(i.reason || '').replace(/\d+/g, 'N').slice(0, 50)}`);
  if (i.status !== 'rejected') continue;
  const r = String(i.reason || '');
  const k = /из 0 найден/.test(r) ? 'нет ни одного предложения' : /ни одно не подходит/.test(r) ? 'предложения есть, не подходят' : /дороже/.test(r) ? 'дороже цены заказчика' : /наличии/.test(r) ? 'нет в наличии' : /невыгодно/.test(r) ? 'невыгодно' : r.slice(0, 50);
  bump(why, k);
  bump(niche, q('SELECT direction FROM tenders WHERE id = ?', i.tender_id)[0]?.direction || 'без ниши');
}
console.log('По статусам:', status);
console.log('Причины:', top(why));
console.log('Отсевы по нишам:', top(niche));

// закупки, отсеянные из-за части позиций: какая доля суммы без товара
let part = 0;
const shares = [];
for (const i of items.filter((x) => x.status === 'rejected' && /нет подходящего товара/.test(x.reason || ''))) {
  const rows = q('SELECT id, unit_price, quantity FROM tender_items WHERE tender_id = ?', i.tender_id);
  const ok = new Set(q("SELECT DISTINCT item_id FROM offers WHERE tender_id = ? AND match IN ('соответствует', 'частично') AND source != 'contracts'", i.tender_id).map((r) => r.item_id));
  const sum = (l) => l.reduce((s, r) => s + (Number(r.unit_price) || 0) * (Number(r.quantity) || 0), 0);
  const miss = rows.filter((r) => !ok.has(r.id));
  if (rows.length > 1 && miss.length && miss.length < rows.length) { part++; if (sum(rows)) shares.push(Math.round((sum(miss) / sum(rows)) * 100)); }
}
shares.sort((a, b) => a - b);
console.log(`Товар найден не на все позиции: ${part} закупок; доля суммы без товара: до 30% — ${shares.filter((x) => x <= 30).length}, до 50% — ${shares.filter((x) => x <= 50).length}`);

const blockers = {};
const ready = items.filter((i) => ['ready', 'needs_work'].includes(i.status));
for (const i of ready) for (const b of J(i.summary_json, {}).bid?.package?.blockers || []) bump(blockers, String(b).replace(/\d+/g, 'N').slice(0, 70));
console.log(`Заявки: ${ready.length}, готовы к выгрузке: ${ready.filter((i) => J(i.summary_json, {}).bid?.package?.final_ok).length}`);
console.log('Что блокирует пакет:', top(blockers));

const days = [...new Set(runs.map((r) => String(r.started_at).slice(0, 10)))];
const paid = days.reduce((s, d) => s + Number(q('SELECT value FROM settings WHERE key = ?', `usage:yandex:${d}`)[0]?.value || 0), 0);
const profitable = stats.reduce((s, x) => s + (x.profitable || 0), 0);
console.log(`Платных запросов за ${days.length} дн.: ${paid}, на выгодную заявку: ${profitable ? Math.round(paid / profitable) : '—'}`);

const file = arg('baseline');
if (file) {
  const offers = q(`SELECT o.id, o.tender_id, o.item_id, o.title, o.domain, o.source, o.price, o.url, o.match, i.name AS item_name, i.ktru_code,
    CASE WHEN i.purchase_offer_id = o.id THEN 1 ELSE 0 END AS chosen
    FROM offers o JOIN tender_items i ON i.id = o.item_id WHERE o.tender_id IN (SELECT DISTINCT tender_id FROM bid_agent_items WHERE run_id BETWEEN ? AND ?)`, from, to);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), runs: [from, to], items: items.map((i) => ({ tender_id: i.tender_id, status: i.status, reason: i.reason, verdict: J(i.summary_json, {}).verdict || null })), offers }));
  console.log(`Эталон: ${file}, закупок ${items.length}, предложений ${offers.length}`);
}
