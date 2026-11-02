// Наладчик (решение владельца 31.10.2026: «агенты должны видеть недоработки и убирать их в кратчайшие сроки»).
// Раз в 10 минут из рабочего процесса смотрит, где агенты споткнулись, и сам применяет известное лечение:
//   • eis_docs     — ЕИС не отдал файлы (434/429/503): через 2 часа после последнего отказа — повтор закупки агентом
//                    заявок, по 5 за раз, файлы — не чаще раза в минуту (attachments.js);
//   • no_links     — в данных закупки нет ссылок на файлы (ГосПлан отдаёт закупку позже ленты ЕИС): повтор через 6 часов;
//   • search_limit — поиск урезан суточным лимитом: повтор, когда у платного поиска снова есть запас;
//   • повтор одной закупки — не больше 3 раз; срок подачи должен оставлять запас дней из настроек агента заявок.
// Что лечить нечем и что повторяется (3 и больше раз за сутки) — раз в сутки сообщение владельцу в Telegram: «нужна
// доработка» с примерами. Каждое лечение и его итог — в журнал (agent 'fixer'): управляющий показывает, сколько
// ошибок наладчик убрал сам и за сколько.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const REMEDIES = [
  { code: 'eis_docs', title: 'ЕИС не отдал файлы документации — повтор', re: /ЕИС ответил (434|429|5\d\d)|превышено время ожидания ответа ЕИС|ошибка соединения с ЕИС/i, after: 2 * HOUR },
  { code: 'no_links', title: 'В данных закупки не было ссылок на файлы — повтор', re: /нет ссылок на файлы документации/i, after: 6 * HOUR },
  { code: 'search_limit', title: 'Поиск был урезан суточным лимитом — повтор', re: /суточный лимит/i, after: HOUR, needBudget: true },
];
const MAX_TRIES = 3;
const PER_TICK = 5;

// причина ошибки без чисел и хвостов — чтобы одинаковые ошибки складывались
const norm = (s) => String(s || '').replace(/\d+/g, 'N').replace(/\s+/g, ' ').slice(0, 90).trim();

function createFixer({ repo, journal, bidAgent = null, config = {}, notify = null, clock = () => new Date(), log = console }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS fixer_tries (
      tender_id INTEGER NOT NULL, code TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, last_at TEXT, result TEXT,
      PRIMARY KEY (tender_id, code))`);
  const now = () => clock().toISOString();
  const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };
  const day = () => now().slice(0, 10);
  let lastTick = 0;

  /** Ошибки агента заявок за неделю: последняя запись по каждой закупке. */
  function failures() {
    const from = new Date(clock().getTime() - 7 * DAY).toISOString();
    const rows = all(`SELECT i.tender_id, i.reason, i.updated_at, i.status FROM bid_agent_items i
      WHERE i.id IN (SELECT MAX(id) FROM bid_agent_items WHERE created_at >= ? GROUP BY tender_id)`, from);
    return rows.filter((r) => r.status === 'error');
  }

  function budgetLeft() {
    const limit = Number(config.SEARCH_DAILY_MAX_API_REQUESTS) || 400;
    const used = Number(repo.getSetting(`usage:yandex:${day()}`) || 0);
    return limit - used;
  }

  /** Что можно повторить сейчас: [{tender_id, code}] */
  function plan() {
    const s = bidAgent?.settings?.() || { min_days: 3 };
    const fails = failures();
    // ЕИС отказывал недавно — ждём, иначе повтор только продлит блок
    const lastEis = fails.filter((f) => REMEDIES[0].re.test(f.reason)).map((f) => Date.parse(f.updated_at)).sort((a, b) => b - a)[0] || 0;
    const out = [];
    for (const f of fails) {
      const r = REMEDIES.find((x) => x.re.test(f.reason));
      if (!r) continue;
      const t = repo.getTender(f.tender_id);
      const deadline = t?.deadline_at || t?.deadline_from;
      if (!deadline || Date.parse(deadline) - clock().getTime() < (s.min_days ?? 3) * DAY) continue;
      const tr = db.prepare('SELECT tries, last_at FROM fixer_tries WHERE tender_id = ? AND code = ?').get(f.tender_id, r.code);
      if ((tr?.tries || 0) >= MAX_TRIES) continue;
      const since = Math.max(Date.parse(f.updated_at) || 0, tr?.last_at ? Date.parse(tr.last_at) : 0, r.code === 'eis_docs' ? lastEis : 0);
      if (clock().getTime() - since < r.after) continue;
      if (r.needBudget && budgetLeft() < 50) continue;
      out.push({ tender_id: f.tender_id, code: r.code, title: r.title });
    }
    return out;
  }

  /** Повторить закупки агентом заявок и записать итог. */
  async function heal() {
    if (!bidAgent || bidAgent.isRunning?.()) return null;
    const todo = plan().slice(0, PER_TICK);
    if (!todo.length) return null;
    for (const x of todo) {
      db.prepare(`INSERT INTO fixer_tries (tender_id, code, tries, last_at) VALUES (?, ?, 1, ?)
        ON CONFLICT(tender_id, code) DO UPDATE SET tries = tries + 1, last_at = excluded.last_at`).run(x.tender_id, x.code, now());
    }
    journal.metric('fixer', 'retried', todo.length);
    const r = await bidAgent.run({ reason: 'fixer', tenderIds: todo.map((x) => x.tender_id) });
    let fixed = 0;
    for (const x of todo) {
      const last = db.prepare('SELECT status, reason FROM bid_agent_items WHERE tender_id = ? ORDER BY id DESC LIMIT 1').get(x.tender_id);
      const ok = last && last.status !== 'error';
      db.prepare('UPDATE fixer_tries SET result = ? WHERE tender_id = ? AND code = ?').run(ok ? last.status : norm(last?.reason), x.tender_id, x.code);
      if (ok) {
        fixed++;
        journal.lesson('fixer', x.code, x.title, { tenderId: x.tender_id, text: `исправлено: ${last.status}`, source: 'self' });
      }
    }
    if (fixed) journal.metric('fixer', 'fixed', fixed);
    log.log?.(`[наладчик] повторил ${todo.length}, исправлено ${fixed}`);
    return { retried: todo.length, fixed, stats: r?.stats || null };
  }

  /** Ошибки без лечения или не вылеченные за 3 попытки, 3+ раза за сутки, — владельцу раз в сутки. */
  async function escalate() {
    const from = new Date(clock().getTime() - DAY).toISOString();
    const groups = new Map();
    for (const f of all("SELECT tender_id, reason FROM bid_agent_items WHERE status = 'error' AND updated_at >= ?", from)) {
      const r = REMEDIES.find((x) => x.re.test(f.reason));
      const tr = r ? db.prepare('SELECT tries FROM fixer_tries WHERE tender_id = ? AND code = ?').get(f.tender_id, r.code) : null;
      if (r && (tr?.tries || 0) < MAX_TRIES) continue;
      const k = norm(f.reason);
      const g = groups.get(k) || { text: k, n: 0, tenders: [] };
      g.n++; if (g.tenders.length < 3) g.tenders.push(f.tender_id);
      groups.set(k, g);
    }
    const bad = [...groups.values()].filter((g) => g.n >= 3);
    if (!bad.length) return 0;
    const key = `fixer:escalated:${day()}`;
    if (repo.getSetting(key)) return 0;
    for (const g of bad) journal.lesson('fixer', 'needs_fix', 'Ошибка без лечения — нужна доработка', { text: `${g.text} — ${g.n} раз`, tenderId: g.tenders[0], source: 'self' });
    const text = `🛠 <b>Наладчик: нужна доработка</b>\nЭти ошибки повторяются и сами не лечатся:\n${bad.map((g) => `• ${g.text} — ${g.n} раз за сутки`).join('\n')}\nСкажите об этом в чате с Claude — он разберёт и исправит.`;
    const ok = notify ? await notify(text).catch(() => false) : false;
    if (ok || !notify) repo.setSetting(key, now());
    journal.metric('fixer', 'escalated', bad.length);
    return bad.length;
  }

  /** Из рабочего процесса раз в минуту; работает раз в 10 минут. */
  async function tick() {
    if (clock().getTime() - lastTick < 10 * 60_000) return null;
    lastTick = clock().getTime();
    const healed = await heal().catch((err) => { log.warn?.(`[наладчик] ${err.message}`); return null; });
    const escalated = await escalate().catch((err) => { log.warn?.(`[наладчик] сообщение: ${err.message}`); return 0; });
    return healed || escalated ? { ...(healed || {}), escalated } : null;
  }

  /** Для управляющего. */
  function stats() {
    const t = (k) => journal.trend('fixer', k).today;
    const waiting = plan().length;
    const open = failures().length;
    return { retried: t('retried'), fixed: t('fixed'), escalated: t('escalated'), waiting, open };
  }

  return { tick, plan, heal, escalate, stats, REMEDIES };
}

module.exports = { createFixer, REMEDIES };
