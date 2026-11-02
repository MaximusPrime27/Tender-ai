// Общий журнал агентов: прогоны, уроки (ошибки, которые агент поймал или человек поправил) и показатели по дням —
// чтобы управляющий видел динамику каждого агента и уроки накапливались, а не терялись между прогонами.
//
// Уроки — по коду ошибки и площадке/виду документа: «на ЭТП ГПБ в заявке не найдена форма декларации» и
// «на Сбербанк-АСТ …» — разные уроки. Агенты читают свои уроки перед работой (known) и сами решают, что с ними делать.

const DAY = 24 * 3600 * 1000;

function createJournal({ repo, clock = () => new Date() }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS agents_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      status TEXT NOT NULL, stats_json TEXT, error TEXT);
    CREATE INDEX IF NOT EXISTS agents_runs_agent ON agents_runs(agent, started_at);
    CREATE TABLE IF NOT EXISTS agents_lessons (
      agent TEXT NOT NULL, code TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', title TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, first_at TEXT, last_at TEXT, example_tender INTEGER, example_text TEXT,
      source TEXT, PRIMARY KEY (agent, code, scope));
    CREATE TABLE IF NOT EXISTS agents_metrics (
      agent TEXT NOT NULL, day TEXT NOT NULL, key TEXT NOT NULL, value REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (agent, day, key));`);
  const now = () => clock().toISOString();
  const day = (t = clock()) => new Date(t).toISOString().slice(0, 10);

  function startRun(agent) {
    return Number(db.prepare("INSERT INTO agents_runs (agent, started_at, status) VALUES (?, ?, 'running')").run(agent, now()).lastInsertRowid);
  }
  function finishRun(id, stats = {}, error = null) {
    db.prepare('UPDATE agents_runs SET finished_at = ?, status = ?, stats_json = ?, error = ? WHERE id = ?')
      .run(now(), error ? 'error' : 'done', JSON.stringify(stats), error ? String(error).slice(0, 500) : null, id);
  }

  /** Урок: source — 'self' (агент поймал сам), 'checker' (поймал проверяющий), 'human' (поправил человек). */
  function lesson(agent, code, title, { scope = '', tenderId = null, text = '', source = 'self' } = {}) {
    db.prepare(`INSERT INTO agents_lessons (agent, code, scope, title, count, first_at, last_at, example_tender, example_text, source)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, code, scope) DO UPDATE SET count = count + 1, title = excluded.title, last_at = excluded.last_at,
        example_tender = excluded.example_tender, example_text = excluded.example_text, source = excluded.source`)
      .run(agent, code, String(scope || ''), title, now(), now(), tenderId, String(text || '').slice(0, 300), source);
    metric(agent, 'lessons', 1);
  }
  /** Уроки агента (самые частые первыми); scope — только по этой площадке/виду и общие. */
  function known(agent, scope = null) {
    const rows = db.prepare('SELECT * FROM agents_lessons WHERE agent = ? ORDER BY count DESC, last_at DESC').all(agent);
    return scope == null ? rows : rows.filter((r) => r.scope === '' || r.scope === scope);
  }

  /** Показатель за сегодня: прибавить (add) или записать (set). */
  function metric(agent, key, value = 1, { set = false } = {}) {
    if (set) db.prepare('INSERT INTO agents_metrics (agent, day, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(agent, day, key) DO UPDATE SET value = excluded.value').run(agent, day(), key, Number(value) || 0);
    else db.prepare('INSERT INTO agents_metrics (agent, day, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(agent, day, key) DO UPDATE SET value = value + excluded.value').run(agent, day(), key, Number(value) || 0);
  }
  /** Динамика: сегодня против среднего за прошлые `days` дней (дни без записей не считаются). */
  function trend(agent, key, days = 7) {
    const today = day();
    const from = day(clock().getTime() - days * DAY);
    const rows = db.prepare('SELECT day, value FROM agents_metrics WHERE agent = ? AND key = ? AND day >= ? ORDER BY day').all(agent, key, from);
    const cur = rows.find((r) => r.day === today)?.value || 0;
    const past = rows.filter((r) => r.day !== today).map((r) => r.value);
    const avg = past.length ? past.reduce((a, b) => a + b, 0) / past.length : null;
    return { today: cur, avg: avg == null ? null : Math.round(avg * 10) / 10, days: past.length };
  }
  function lastRun(agent) {
    const r = db.prepare('SELECT * FROM agents_runs WHERE agent = ? ORDER BY id DESC LIMIT 1').get(agent);
    if (!r) return null;
    let stats = {};
    try { stats = JSON.parse(r.stats_json || '{}'); } catch { stats = {}; }
    return { ...r, stats };
  }
  function lessonsSince(sinceIso) {
    return db.prepare('SELECT * FROM agents_lessons WHERE last_at >= ? ORDER BY last_at DESC').all(sinceIso);
  }

  return { startRun, finishRun, lesson, known, metric, trend, lastRun, lessonsSince, day };
}

module.exports = { createJournal };
