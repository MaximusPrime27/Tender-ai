// Хранилище раздела «Финансы»: записи в SQLite, каждое сохранение проверяется проводками (ledger.js). Существующие таблицы
// не меняются. Удалённое помечается, а не стирается. Демо-данные в рабочую базу не попадают: база начинается пустой.
// Номер закупки у сделки (tender_number) оставлен для будущего автозаполнения сделки после подтверждения закупки.
const F = require('./ledger');

const GROUPS = { participants: 'finance_participants', accounts: 'finance_accounts', services: 'finance_services', deals: 'finance_deals', operations: 'finance_operations', budgets: 'finance_budgets' };
// статьи — часть структуры учёта, не выдуманные данные: без базовых статей проводки не считаются
const CATEGORIES = { goods: { name: 'Товар по тендерам', color: '#ef5360' }, logistics: { name: 'Доставка и исполнение', color: '#f39a33' }, ai: { name: 'ИИ и API', color: '#8b5cf6' }, infra: { name: 'Серверы и домены', color: '#2878ed' }, dev: { name: 'Разработка', color: '#14a899' }, admin: { name: 'Администрирование', color: '#64748b' }, other: { name: 'Прочее', color: '#bc6f33' } };
const SETTINGS = { name: 'Tenderoid', reserve: 0, taxReserve: 0 };
const USAGE_NAMES = { yandex: 'Яндекс: поиск поставщиков', yandex_scout: 'Яндекс: разведчик базы товаров', yandex_maker: 'Яндекс: поиск по модели', gigachat: 'GigaChat' };
const DEMO_MARK = /· демо\b|демо$/i;

function createFinance({ db, clock = () => new Date() }) {
  db.exec(`${Object.values(GROUPS).map((t) => `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, updated_at TEXT NOT NULL${t === GROUPS.deals ? ', tender_number TEXT' : ''});`).join('\n')}
    CREATE INDEX IF NOT EXISTS idx_finance_deals_tender ON finance_deals(tender_number);
    CREATE TABLE IF NOT EXISTS finance_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS finance_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, collection TEXT NOT NULL, record_id TEXT, action TEXT NOT NULL, before_json TEXT, after_json TEXT);`);
  const nowIso = () => clock().toISOString();
  const today = () => new Date(clock().getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10); // день по Москве
  const J = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
  const getMeta = (k, d) => J(db.prepare('SELECT value FROM finance_meta WHERE key = ?').get(k)?.value, d);
  const setMeta = (k, v) => db.prepare('INSERT INTO finance_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (err) { db.exec('ROLLBACK'); throw err; }
  };

  function load() {
    const state = { version: 2, asOf: today(), settings: getMeta('settings', SETTINGS), categories: getMeta('categories', CATEGORIES) };
    for (const [g, t] of Object.entries(GROUPS)) state[g] = db.prepare(`SELECT data FROM ${t} ORDER BY rowid`).all().map((r) => JSON.parse(r.data));
    state.audit = db.prepare('SELECT * FROM finance_audit ORDER BY seq').all().map((a) => ({ id: `audit-${a.seq}`, at: a.at, collection: a.collection, recordId: a.record_id, action: a.action, before: J(a.before_json, null), after: J(a.after_json, null) }));
    return state;
  }
  function upsert(group, rec) {
    const t = GROUPS[group];
    const deals = group === 'deals';
    db.prepare(`INSERT INTO ${t} (id, deleted, data, updated_at${deals ? ', tender_number' : ''}) VALUES (?, ?, ?, ?${deals ? ', ?' : ''})
      ON CONFLICT(id) DO UPDATE SET deleted = excluded.deleted, data = excluded.data, updated_at = excluded.updated_at${deals ? ', tender_number = excluded.tender_number' : ''}`)
      .run(rec.id, rec.deleted ? 1 : 0, JSON.stringify(rec), nowIso(), ...(deals ? [rec.tenderNumber || null] : []));
  }
  const audit = (collection, recordId, action, before, after, at = nowIso()) => db.prepare('INSERT INTO finance_audit (at, collection, record_id, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(at, collection, recordId ?? null, action, JSON.stringify(before ?? null), JSON.stringify(after ?? null));

  /** Любая правка записи: проводки пересчитываются целиком, нарушение — ошибка, база остаётся прежней. */
  function change({ collection, id, patch = null, action = 'save' }) {
    if (!['save', 'delete', 'restore'].includes(action)) throw new Error('Неизвестное действие');
    if (!GROUPS[collection]) throw new Error('Раздел не найден');
    if (typeof id !== 'string' || !id) throw new Error('Нет идентификатора записи');
    if (patch && typeof patch !== 'object') throw new Error('Неверные данные записи');
    if (collection === 'deals' && patch?.tenderNumber !== undefined && (typeof patch.tenderNumber !== 'string' || patch.tenderNumber.length > 64)) throw new Error('Проверьте номер закупки');
    const next = F.change(load(), collection, id, patch, action);
    const rec = next[collection].find((x) => x.id === id);
    const log = next.audit.at(-1);
    tx(() => { upsert(collection, rec); audit(collection, id, action, log.before, log.after); });
    return load();
  }
  function saveSettings({ name, reserve, taxReserve }) {
    const state = load();
    const before = state.settings;
    state.settings = { ...before, name: String(name ?? '').trim(), reserve, taxReserve };
    F.ledger(state);
    tx(() => { setMeta('settings', state.settings); audit('settings', 'project', 'save', before, state.settings); });
    return load();
  }
  const isDemo = (s) => (s.deals || []).some((d) => DEMO_MARK.test(String(d.customer || ''))) || (s.operations || []).some((o) => DEMO_MARK.test(String(o.description || '')));
  /**
   * Загрузка файла формата версии 2. Прежние записи, которых нет в файле, уходят в архив — не стираются. Учебный файл демо
   * отклоняется; { demoOk: true } только для проверки расчётов в тестах, по сети этот признак не передаётся.
   */
  function importState(file, { demoOk = false } = {}) {
    if (!file || typeof file !== 'object') throw new Error('Файл не прочитан');
    if (!demoOk && isDemo(file)) throw new Error('Это учебные данные демо, в рабочую базу они не загружаются');
    const next = { ...file, asOf: today() };
    F.ledger(next);
    tx(() => {
      for (const [g, t] of Object.entries(GROUPS)) {
        const keep = new Set(next[g].map((x) => x.id));
        for (const row of db.prepare(`SELECT id, data FROM ${t} WHERE deleted = 0`).all()) if (!keep.has(row.id)) upsert(g, { ...JSON.parse(row.data), deleted: true });
        for (const rec of next[g]) upsert(g, rec);
      }
      setMeta('settings', next.settings);
      setMeta('categories', next.categories);
      setMeta('started', true);
      for (const a of next.audit) audit(a.collection, a.recordId, a.action, a.before, a.after, a.at);
      audit('import', null, 'import', null, { operations: next.operations.length, deals: next.deals.length });
      F.ledger(load());
    });
    return load();
  }
  function start() { setMeta('started', true); return load(); }

  /** Платные запросы сервиса — только справка, операции из них не создаются. */
  function usage() {
    const day = today();
    const rows = {};
    for (const r of db.prepare("SELECT key, value FROM settings WHERE key LIKE 'usage:%'").all()) {
      const m = /^usage:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(r.key);
      if (!m || !m[2].startsWith(day.slice(0, 7))) continue;
      const u = rows[m[1]] || (rows[m[1]] = { name: USAGE_NAMES[m[1]] || m[1], today: 0, month: 0 });
      u.month += Number(r.value) || 0;
      if (m[2] === day) u.today += Number(r.value) || 0;
    }
    return Object.values(rows).sort((a, b) => b.month - a.month);
  }
  function meta() {
    const any = Object.values(GROUPS).some((t) => db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get());
    return { empty: !any && !getMeta('started', false), usage: usage() };
  }
  function exportCsv() {
    const s = load();
    const by = (g, id) => s[g].find((x) => x.id === id)?.name || '';
    const rows = [['Дата', 'Описание', 'Вид', 'Сумма, руб.', 'Сделка', 'Номер закупки', 'Сервис', 'Ответственный', 'Участник', 'Документ', 'Удалено'],
      ...s.operations.map((o) => [o.date, o.description, F.kinds[o.kind], (o.amount / 100).toFixed(2), by('deals', o.dealId), s.deals.find((d) => d.id === o.dealId)?.tenderNumber || '', by('services', o.serviceId), by('participants', o.owner), by('participants', o.partnerId), o.document || '', o.deleted ? 'Да' : 'Нет'])];
    return `﻿${rows.map((r) => r.map(F.csvCell).join(';')).join('\r\n')}`;
  }
  return { load, change, saveSettings, importState, start, meta, exportCsv };
}

module.exports = { createFinance };
