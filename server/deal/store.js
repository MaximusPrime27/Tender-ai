// Хранение расчёта сделки: ручные поправки (входы), экспресс-проверки и утверждённые снимки. Таблицы новые —
// существующие (закупки, позиции, предложения, расчёт выгодности) не меняются.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deal_inputs (
  tender_id  INTEGER PRIMARY KEY REFERENCES tenders(id) ON DELETE CASCADE,
  data_json  TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deal_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id   INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  group_id    TEXT NOT NULL,
  state       TEXT NOT NULL,                 -- clear | flagged | not_applicable
  note        TEXT,
  by_name     TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,                 -- на каких данных дана оценка: изменились — оценка устарела
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE TABLE IF NOT EXISTS deal_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id   INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  inputs_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  by_name     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deal_checks_tender ON deal_checks (tender_id, group_id);
CREATE INDEX IF NOT EXISTS deal_snapshots_tender ON deal_snapshots (tender_id, id);
`;

const J = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };

function createDealStore(db, now = () => new Date().toISOString()) {
  db.exec(SCHEMA);
  return {
    inputs: (tenderId) => J(db.prepare('SELECT data_json FROM deal_inputs WHERE tender_id = ?').get(tenderId)?.data_json, {}),
    saveInputs(tenderId, data) {
      db.prepare('INSERT INTO deal_inputs (tender_id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (tender_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at')
        .run(tenderId, JSON.stringify(data), now());
    },
    checks: (tenderId) => db.prepare('SELECT group_id, state, note, by_name AS by, inputs_hash, created_at AS at FROM deal_checks WHERE tender_id = ? AND revoked_at IS NULL ORDER BY id').all(tenderId),
    setCheck(tenderId, groupId, { state, note, by, inputsHash }) {
      db.prepare('UPDATE deal_checks SET revoked_at = ? WHERE tender_id = ? AND group_id = ? AND revoked_at IS NULL').run(now(), tenderId, groupId);
      if (state) db.prepare('INSERT INTO deal_checks (tender_id, group_id, state, note, by_name, inputs_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tenderId, groupId, state, note, by, inputsHash, now());
    },
    approve(tenderId, { inputsHash, result, by }) {
      db.prepare('INSERT INTO deal_snapshots (tender_id, inputs_hash, result_json, by_name, created_at) VALUES (?, ?, ?, ?, ?)').run(tenderId, inputsHash, JSON.stringify(result), by, now());
    },
    snapshots: (tenderId) => db.prepare('SELECT id, inputs_hash, by_name AS by, created_at AS at FROM deal_snapshots WHERE tender_id = ? ORDER BY id DESC LIMIT 20').all(tenderId),
    snapshot: (tenderId, id) => { const r = db.prepare('SELECT * FROM deal_snapshots WHERE tender_id = ? AND id = ?').get(tenderId, id); return r ? { ...r, result: J(r.result_json, null) } : null; },
  };
}

module.exports = { createDealStore };
