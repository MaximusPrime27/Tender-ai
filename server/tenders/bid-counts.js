// Сколько заявок уже подано. Открытый реестр Сбербанк-АСТ показывает по закупке 44-ФЗ число поданных заявок, пока идёт
// приём (у 223-ФЗ и коммерческих закупок там всегда 0 — их не спрашиваем). Других площадок пока нет.
//
// Что проверяем: закупки 44-ФЗ из корзины заявок и из отчёта агента заявок (последние 7 дней), у которых срок подачи
// ещё не прошёл, — не чаще раза в BID_COUNT_STALE_MIN минут на закупку; открытую страницу закупки — так же, по запросу.
// Закупку, которой на Сбербанк-АСТ нет, переспрашиваем не раньше чем через сутки (её могли опубликовать позже).
// Запрос — один поиск по номеру в реестре, с паузой площадки (SBERAST_DELAY_MS).

function createBidCounts({ repo, lookup, staleMin = 180, maxPerTick = 40, clock = () => new Date(), log = console }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS bid_counts (
    tender_id INTEGER PRIMARY KEY REFERENCES tenders(id) ON DELETE CASCADE,
    platform TEXT, found INTEGER NOT NULL DEFAULT 0, count INTEGER, stage TEXT, checked_at TEXT NOT NULL, history_json TEXT)`);
  const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

  function get(tenderId) {
    const r = db.prepare('SELECT * FROM bid_counts WHERE tender_id = ?').get(tenderId);
    if (!r) return null;
    return { platform: r.platform, found: Boolean(r.found), count: r.count, stage: r.stage, checked_at: r.checked_at, history: J(r.history_json, []) };
  }

  const open = (t) => !t.deadline_at || Date.parse(t.deadline_at) > clock().getTime();
  /** Пора ли спросить площадку: закупка 44-ФЗ, срок не прошёл (или идёт работа комиссии — число окончательное), данные устарели. */
  function due(t, row = get(t.id)) {
    if (!t || String(t.law) !== '44' || !/^\d{19}$/.test(String(t.number || ''))) return false;
    if (!row) return true;
    const age = clock().getTime() - Date.parse(row.checked_at);
    if (!row.found) return age > 24 * 3600e3 && open(t);
    if (!open(t)) return !/комисси|заверш|отмен/i.test(row.stage || '') && age > staleMin * 60e3;
    return age > staleMin * 60e3;
  }

  /** Спросить площадку и сохранить. @returns {object|null} то же, что get() */
  async function refresh(t, { force = false } = {}) {
    if (!t || String(t.law) !== '44') return null;
    const row = get(t.id);
    if (!force && !due(t, row)) return row;
    const r = await lookup(String(t.number));
    const at = clock().toISOString();
    const history = row?.history || [];
    if (r && (!history.length || history[history.length - 1].count !== r.count)) history.push({ at, count: r.count });
    db.prepare(`INSERT INTO bid_counts (tender_id, platform, found, count, stage, checked_at, history_json) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tender_id) DO UPDATE SET platform = excluded.platform, found = excluded.found, count = excluded.count, stage = excluded.stage,
        checked_at = excluded.checked_at, history_json = excluded.history_json`)
      .run(t.id, r ? 'Сбербанк-АСТ' : null, r ? 1 : 0, r ? r.count : null, r?.stage || null, at, JSON.stringify(history.slice(-30)));
    return get(t.id);
  }

  /** Закупки, по которым число заявок нужно держать свежим: корзина заявок и отчёт агента заявок. */
  function watched() {
    const ids = new Set();
    try { for (const r of db.prepare('SELECT tender_id FROM bid_cart').all()) ids.add(r.tender_id); } catch { /* корзины ещё нет */ }
    try {
      const since = new Date(clock().getTime() - 7 * 86400e3).toISOString();
      for (const r of db.prepare("SELECT DISTINCT tender_id FROM bid_agent_items WHERE status != 'rejected' AND created_at >= ?").all(since)) ids.add(r.tender_id);
    } catch { /* агента заявок ещё не было */ }
    return [...ids];
  }

  let lastTick = 0;
  /** Для рабочего процесса: раз в 15 минут обновить устаревшие (не больше maxPerTick за раз). */
  async function tick() {
    if (clock().getTime() - lastTick < 15 * 60e3) return { checked: 0 };
    lastTick = clock().getTime();
    let checked = 0;
    for (const id of watched()) {
      if (checked >= maxPerTick) break;
      const t = repo.getTender(id);
      if (!due(t)) continue;
      try { await refresh(t); checked++; } catch (err) { log.warn?.(`[заявки поданы] ${t.number}: ${err.message}`); break; }
    }
    if (checked) log.log?.(`[заявки поданы] проверено закупок: ${checked}`);
    return { checked };
  }

  return { get, due, refresh, tick, watched };
}

module.exports = { createBidCounts };
