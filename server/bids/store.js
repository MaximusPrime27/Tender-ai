// Хранение дел по подготовке заявок. Таблицы создаются при первом обращении (CREATE TABLE IF NOT EXISTS) — старые
// данные закупок, расчётов и предложений не затрагиваются. Связи настоящие: дело привязано к закупке, лоту и досье;
// требования, несостыковки, подтверждения и версии — к делу. Доказательства прежних версий не удаляются: записи
// отзываются (revoked_at) или архивируются (archived_at).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS participant_dossiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                       -- company | ip
  name        TEXT NOT NULL,
  data_json   TEXT NOT NULL DEFAULT '{}',          -- реквизиты, руководитель, подписант, налоговый режим…
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS participant_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id   INTEGER NOT NULL REFERENCES participant_dossiers(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                      -- вид документа: устав, выписка, доверенность, лицензия…
  title        TEXT NOT NULL,
  path         TEXT,
  sha256       TEXT,
  issued_at    TEXT,
  valid_until  TEXT,
  scope        TEXT,                               -- область действия (на что распространяется)
  original     INTEGER NOT NULL DEFAULT 0,         -- 1 — оригинал, предоставленный участником
  verified_at  TEXT,
  verified_by  TEXT,
  source       TEXT,
  restrictions TEXT,
  archived_at  TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bid_cases (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id          INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  lot_id             TEXT NOT NULL DEFAULT 'lot-1',
  dossier_id         INTEGER REFERENCES participant_dossiers(id),
  status             TEXT NOT NULL DEFAULT 'draft',
  scenario_json      TEXT,
  readiness_json     TEXT,
  snapshot           TEXT,                         -- отпечаток входных данных на момент последней проверки
  rule_pack          TEXT,
  rule_pack_hash     TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bid_cases_tender ON bid_cases(tender_id, lot_id);
CREATE TABLE IF NOT EXISTS bid_source_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id      INTEGER NOT NULL REFERENCES bid_cases(id) ON DELETE CASCADE,
  document_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  sha256       TEXT,
  role         TEXT,
  status       TEXT NOT NULL,                      -- received | missing | unreadable | partial | superseded | not_applicable
  snapshot     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bid_requirements (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id   INTEGER NOT NULL REFERENCES bid_cases(id) ON DELETE CASCADE,
  req_id    TEXT NOT NULL,
  data_json TEXT NOT NULL,
  UNIQUE (case_id, req_id)
);
CREATE TABLE IF NOT EXISTS bid_evidence (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id            INTEGER NOT NULL REFERENCES bid_cases(id) ON DELETE CASCADE,
  evidence_id        TEXT NOT NULL,
  kind               TEXT NOT NULL,
  ref_json           TEXT,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  created_at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bid_findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     INTEGER NOT NULL REFERENCES bid_cases(id) ON DELETE CASCADE,
  finding_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  data_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (case_id, finding_id)
);
CREATE TABLE IF NOT EXISTS bid_artifacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id    INTEGER NOT NULL REFERENCES bid_cases(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  part       TEXT,
  purpose    TEXT,
  path       TEXT,
  sha256     TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bid_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id       INTEGER NOT NULL REFERENCES bid_cases(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  snapshot      TEXT NOT NULL,
  status        TEXT NOT NULL,
  manifest_json TEXT,
  confirmed_by  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (case_id, version)
);
CREATE TABLE IF NOT EXISTS bid_attestations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id        INTEGER NOT NULL REFERENCES bid_cases(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL,
  snapshot       TEXT NOT NULL,                    -- на каких данных дано подтверждение: изменились — оно не действует
  by_name        TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT NOT NULL,
  revoked_at     TEXT
);
CREATE TABLE IF NOT EXISTS bid_registry_checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id         INTEGER NOT NULL REFERENCES bid_cases(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL,                   -- ok | not_found | expired | unavailable
  checked_at      TEXT NOT NULL,
  valid_for_hours INTEGER,
  data_json       TEXT
);
CREATE TABLE IF NOT EXISTS bid_rule_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     TEXT NOT NULL,
  pack_id     TEXT NOT NULL,
  pack_hash   TEXT NOT NULL,
  status      TEXT NOT NULL,                       -- verified | superseded
  verified_by TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  note        TEXT,
  UNIQUE (rule_id, pack_hash)
);
CREATE TABLE IF NOT EXISTS bid_review_decisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id        INTEGER NOT NULL REFERENCES bid_cases(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL,
  decision       TEXT NOT NULL,                    -- pass | not_applicable
  basis          TEXT NOT NULL,                    -- основание решения
  reviewer       TEXT NOT NULL,
  role           TEXT,
  snapshot       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  revoked_at     TEXT
);
`;

// Решения человека по строкам списка «что приложить»: выбран другой документ или «не требуется» с причиной.
const SCHEMA_CHOICES = `
CREATE TABLE IF NOT EXISTS bid_checklist_choices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id      INTEGER NOT NULL REFERENCES bid_cases(id) ON DELETE CASCADE,
  line_id      TEXT NOT NULL,
  document_id  INTEGER,
  not_required INTEGER NOT NULL DEFAULT 0,
  reason       TEXT,
  by_name      TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
`;

// Утверждение цены предложения человеком: на каких данных и какая именно цена утверждена.
const SCHEMA_PRICE = `
CREATE TABLE IF NOT EXISTS bid_price_approvals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id    INTEGER NOT NULL REFERENCES bid_cases(id) ON DELETE CASCADE,
  price      REAL NOT NULL,
  snapshot   TEXT NOT NULL,
  by_name    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
`;

const J = (v, d) => (v == null ? d : JSON.parse(v));

function createBidStore(db, now = () => new Date().toISOString()) {
  db.exec(SCHEMA);
  db.exec(SCHEMA_CHOICES);
  db.exec(SCHEMA_PRICE);
  // какие положения декларации подтверждены (каждое — отдельно)
  if (!db.prepare('PRAGMA table_info(bid_attestations)').all().some((c) => c.name === 'statements_json')) db.exec('ALTER TABLE bid_attestations ADD COLUMN statements_json TEXT');
  // имя загруженного файла документа участника (для скачивания под тем же именем)
  if (!db.prepare('PRAGMA table_info(participant_documents)').all().some((c) => c.name === 'file_name')) db.exec('ALTER TABLE participant_documents ADD COLUMN file_name TEXT');
  const caseRow = (r) => (r ? { ...r, scenario: J(r.scenario_json, null), readiness: J(r.readiness_json, null), scenario_json: undefined, readiness_json: undefined } : null);
  return {
    findCase(tenderId, lotId = 'lot-1', dossierId = null) {
      return caseRow(db.prepare('SELECT * FROM bid_cases WHERE tender_id = ? AND lot_id = ? AND COALESCE(dossier_id, 0) = COALESCE(?, 0) ORDER BY id LIMIT 1').get(tenderId, lotId, dossierId));
    },
    getCase: (id) => caseRow(db.prepare('SELECT * FROM bid_cases WHERE id = ?').get(id)),
    createCase(tenderId, lotId = 'lot-1', dossierId = null) {
      const r = db.prepare('INSERT INTO bid_cases (tender_id, lot_id, dossier_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(tenderId, lotId, dossierId, now(), now());
      return Number(r.lastInsertRowid);
    },
    /** Результат проверки — одной транзакцией: статус, сценарий, реестр, несостыковки, снимок источников. */
    saveResult(caseId, { status, scenario, readiness, snapshot, pack, requirements, findings, sources }) {
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE bid_cases SET status = ?, scenario_json = ?, readiness_json = ?, snapshot = ?, rule_pack = ?, rule_pack_hash = ?, updated_at = ? WHERE id = ?')
          .run(status, JSON.stringify(scenario), JSON.stringify(readiness), snapshot, pack?.id ?? null, pack?.hash ?? null, now(), caseId);
        db.prepare('DELETE FROM bid_requirements WHERE case_id = ?').run(caseId);
        const insReq = db.prepare('INSERT INTO bid_requirements (case_id, req_id, data_json) VALUES (?, ?, ?)');
        for (const r of requirements) insReq.run(caseId, r.id, JSON.stringify(r));
        db.prepare('DELETE FROM bid_findings WHERE case_id = ?').run(caseId);
        const insF = db.prepare('INSERT INTO bid_findings (case_id, finding_id, type, severity, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const f of findings) insF.run(caseId, f.id, f.type, f.severity, f.status, JSON.stringify(f), now());
        db.prepare('DELETE FROM bid_source_versions WHERE case_id = ? AND snapshot = ?').run(caseId, snapshot);
        const insS = db.prepare('INSERT INTO bid_source_versions (case_id, document_id, name, sha256, role, status, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const s of sources) insS.run(caseId, s.document_id, s.name, s.sha256 ?? null, s.role ?? null, s.status, snapshot, now());
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
    requirements: (caseId) => db.prepare('SELECT data_json FROM bid_requirements WHERE case_id = ? ORDER BY id').all(caseId).map((r) => JSON.parse(r.data_json)),
    findings: (caseId) => db.prepare('SELECT data_json FROM bid_findings WHERE case_id = ? ORDER BY id').all(caseId).map((r) => JSON.parse(r.data_json)),
    sources: (caseId, snapshot) => db.prepare('SELECT document_id, name, sha256, role, status FROM bid_source_versions WHERE case_id = ? AND snapshot = ? ORDER BY id').all(caseId, snapshot),

    attest(caseId, requirementId, { snapshot, by, note = null, statements = null }) {
      db.prepare('UPDATE bid_attestations SET revoked_at = ? WHERE case_id = ? AND requirement_id = ? AND revoked_at IS NULL').run(now(), caseId, requirementId);
      db.prepare('INSERT INTO bid_attestations (case_id, requirement_id, snapshot, by_name, note, statements_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(caseId, requirementId, snapshot, by, note, statements ? JSON.stringify(statements) : null, now());
    },
    revokeAttestation: (caseId, requirementId) => db.prepare('UPDATE bid_attestations SET revoked_at = ? WHERE case_id = ? AND requirement_id = ? AND revoked_at IS NULL').run(now(), caseId, requirementId).changes > 0,
    attestations: (caseId) => db.prepare('SELECT requirement_id, snapshot, by_name AS by, note, statements_json, created_at AS at FROM bid_attestations WHERE case_id = ? AND revoked_at IS NULL').all(caseId)
      .map(({ statements_json, ...a }) => ({ ...a, statements: J(statements_json, null) })),

    approvePrice(caseId, { price, snapshot, by }) {
      db.prepare('UPDATE bid_price_approvals SET revoked_at = ? WHERE case_id = ? AND revoked_at IS NULL').run(now(), caseId);
      db.prepare('INSERT INTO bid_price_approvals (case_id, price, snapshot, by_name, created_at) VALUES (?, ?, ?, ?, ?)').run(caseId, price, snapshot, by, now());
    },
    revokePrice: (caseId) => db.prepare('UPDATE bid_price_approvals SET revoked_at = ? WHERE case_id = ? AND revoked_at IS NULL').run(now(), caseId).changes > 0,
    priceApproval: (caseId) => db.prepare('SELECT price, snapshot, by_name AS by, created_at AS at FROM bid_price_approvals WHERE case_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1').get(caseId) || null,

    /** Версия составленного пакета: что составлено, на каких данных и чем закончилась повторная проверка файлов. */
    saveVersion(caseId, { snapshot, status, manifest, artifacts }) {
      const version = Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM bid_versions WHERE case_id = ?').get(caseId).v) + 1;
      db.prepare('INSERT INTO bid_versions (case_id, version, snapshot, status, manifest_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(caseId, version, snapshot, status, JSON.stringify(manifest), now());
      const ins = db.prepare('INSERT INTO bid_artifacts (case_id, version, name, part, purpose, path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const a of artifacts(version)) ins.run(caseId, version, a.name, a.part ?? null, a.purpose ?? null, a.path, a.sha256, now());
      return version;
    },
    latestVersion(caseId) {
      const r = db.prepare('SELECT version, snapshot, status, manifest_json, created_at FROM bid_versions WHERE case_id = ? ORDER BY version DESC LIMIT 1').get(caseId);
      return r ? { version: r.version, snapshot: r.snapshot, status: r.status, manifest: J(r.manifest_json, {}), created_at: r.created_at } : null;
    },
    artifacts: (caseId, version) => db.prepare('SELECT name, part, purpose, path, sha256 FROM bid_artifacts WHERE case_id = ? AND version = ? ORDER BY id').all(caseId, version),

    decide(caseId, requirementId, { snapshot, decision, basis, reviewer, role = null }) {
      db.prepare('UPDATE bid_review_decisions SET revoked_at = ? WHERE case_id = ? AND requirement_id = ? AND revoked_at IS NULL').run(now(), caseId, requirementId);
      db.prepare('INSERT INTO bid_review_decisions (case_id, requirement_id, decision, basis, reviewer, role, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(caseId, requirementId, decision, basis, reviewer, role, snapshot, now());
    },
    revokeDecision: (caseId, requirementId) => db.prepare('UPDATE bid_review_decisions SET revoked_at = ? WHERE case_id = ? AND requirement_id = ? AND revoked_at IS NULL').run(now(), caseId, requirementId).changes > 0,
    decisions: (caseId) => db.prepare('SELECT requirement_id, decision, basis, reviewer, role, snapshot, created_at AS at FROM bid_review_decisions WHERE case_id = ? AND revoked_at IS NULL').all(caseId),

    choose(caseId, lineId, { documentId = null, notRequired = false, reason = null, by = null }) {
      db.prepare('UPDATE bid_checklist_choices SET revoked_at = ? WHERE case_id = ? AND line_id = ? AND revoked_at IS NULL').run(now(), caseId, lineId);
      db.prepare('INSERT INTO bid_checklist_choices (case_id, line_id, document_id, not_required, reason, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(caseId, lineId, documentId, notRequired ? 1 : 0, reason, by, now());
    },
    revokeChoice: (caseId, lineId) => db.prepare('UPDATE bid_checklist_choices SET revoked_at = ? WHERE case_id = ? AND line_id = ? AND revoked_at IS NULL').run(now(), caseId, lineId).changes > 0,
    choices: (caseId) => db.prepare('SELECT line_id, document_id, not_required, reason, by_name AS by, created_at AS at FROM bid_checklist_choices WHERE case_id = ? AND revoked_at IS NULL').all(caseId).map((c) => ({ ...c, not_required: Boolean(c.not_required) })),

    verifyRule({ ruleId, packId, packHash, by, note = null, status = 'verified' }) {
      db.prepare('INSERT INTO bid_rule_versions (rule_id, pack_id, pack_hash, status, verified_by, verified_at, note) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (rule_id, pack_hash) DO UPDATE SET status = excluded.status, verified_by = excluded.verified_by, verified_at = excluded.verified_at, note = excluded.note')
        .run(ruleId, packId, packHash, status, by, now(), note);
    },
    unverifyRule: (ruleId, packHash) => db.prepare('DELETE FROM bid_rule_versions WHERE rule_id = ? AND pack_hash = ?').run(ruleId, packHash).changes > 0,
    ruleVerifications: () => db.prepare('SELECT rule_id, pack_id, pack_hash, status, verified_by, verified_at, note FROM bid_rule_versions').all(),
  };
}

module.exports = { createBidStore, SCHEMA };
