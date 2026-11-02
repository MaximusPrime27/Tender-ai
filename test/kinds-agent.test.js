const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createKindAgent } = require('../server/agents/kinds');
const { setKindModel } = require('../server/offers/kind-model');

function world() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tender_items (id INTEGER PRIMARY KEY, tender_id INT, idx INT, name TEXT, ktru_code TEXT, okpd2_code TEXT, purchase_offer_id INT, purchase_selected_by TEXT);
    CREATE TABLE offers (id INTEGER PRIMARY KEY, tender_id INT, item_id INT, title TEXT, source TEXT, match TEXT, price REAL, unit_price REAL);
    CREATE TABLE bid_agent_runs (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE bid_agent_items (id INTEGER PRIMARY KEY, tender_id INT, status TEXT, reason TEXT, summary_json TEXT, findings_json TEXT, decision TEXT, created_at TEXT, updated_at TEXT);`);
  const add = db.prepare('INSERT INTO tender_items (tender_id, name, ktru_code) VALUES (0, ?, ?)');
  for (let i = 0; i < 3; i++) {
    add.run('Комплект для переливания крови', '32.50.13.190-00022');
    add.run('Система для переливания крови', '32.50.13.190-00022');
    add.run('Система инфузионная', '32.50.13.190-00031');
    add.run('Катетер инфузионный', '32.50.13.190-00033');
    add.run('Набор инфузионный', '32.50.13.190-00034');
  }
  db.prepare("INSERT INTO tender_items (id, tender_id, idx, name, ktru_code, purchase_offer_id, purchase_selected_by) VALUES (100, 7, 0, 'Комплект для переливания крови', '32.50.13.190-00022', 1, 'agent')").run();
  const settings = new Map();
  const repo = { db, getItems: (t) => db.prepare('SELECT * FROM tender_items WHERE tender_id = ?').all(t), getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => settings.set(k, v) };
  const clock = () => new Date('2026-10-31T10:00:00Z');
  db.prepare("INSERT INTO bid_agent_items (tender_id, status, summary_json, findings_json, decision, created_at) VALUES (7, 'needs_work', ?, '[]', 'go', '2026-10-30T10:00:00Z')")
    .run(JSON.stringify({ verdict: 'выгодно', items: [{ id: 100, name: 'Комплект для переливания крови', offer: { title: 'Система инфузионная с иглой 21G' } }] }));
  const lessons = [];
  const journal = { metric() {}, trend: () => ({ today: 0 }), lesson: (...a) => lessons.push(a) };
  return { db, repo, clock, journal, lessons };
}

test('знаток товара: сам снимает заявку с другим товаром, запись и решение человека остаются', () => {
  const w = world();
  const a = createKindAgent({ repo: w.repo, journal: w.journal, clock: w.clock, log: {} });
  const r = a.afterRun();
  assert.equal(r.removed, 1);
  const b = w.db.prepare('SELECT * FROM bid_agent_items').get();
  assert.equal(b.status, 'needs_work');
  assert.equal(b.decision, 'go');
  assert.match(b.reason, /другой товар/);
  assert.equal(JSON.parse(b.findings_json)[0].code, 'other_kind');
  assert.equal(w.lessons[0][1], 'other_kind');
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM kind_examples WHERE verdict = 'wrong'").get().n, 1);
  assert.ok(w.db.prepare('SELECT COUNT(*) n FROM kind_cards').get().n >= 1);
  assert.equal(a.audit().removed, 0, 'повторно не снимает');
  setKindModel(null);
});

test('знаток товара: выбор человека не трогает; после прогона срабатывает один раз', () => {
  const w = world();
  w.db.prepare("UPDATE tender_items SET purchase_selected_by = 'user' WHERE id = 100").run();
  w.db.prepare("INSERT INTO bid_agent_runs (id, status) VALUES (5, 'done')").run();
  const a = createKindAgent({ repo: w.repo, journal: w.journal, clock: w.clock, log: {} });
  assert.equal(a.tick().removed, 0);
  assert.equal(a.tick(), null);
  setKindModel(null);
});
