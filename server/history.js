// История работы с закупками: какие закупки вы открывали и на чём остановились — чтобы вернуться, не ища заново.
// Хранится на сервере (видно и с телефона, и с компьютера). Просмотр записывается при открытии закупки и шага;
// «что сделано» не логируется отдельно, а считается по текущим данным: выбран товар, расчёт, заявка, файлы, анализ.
// При первом запуске история заполняется по уже сделанному: свой выбор товара, свои цены, расчёт, заявка, анализ.

const STEPS = new Set(['overview', 'docs', 'suppliers', 'calc', 'summary', 'bid', 'full']);

function createHistory({ repo, clock = () => new Date() }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS tender_visits (
    tender_id INTEGER PRIMARY KEY,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    last_step TEXT,
    visits INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS tender_visits_last ON tender_visits (hidden, last_at)');
  const has = (t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));

  // Заполнить один раз по уже сделанному (без автоматических действий сервиса: автоподбор и воронка не в счёт)
  if (repo.getSetting?.('history_backfilled_v1') == null) {
    const parts = [
      "SELECT tender_id, MAX(COALESCE(t.first_seen_at, t.published_at)) at FROM tender_items i JOIN tenders t ON t.id = i.tender_id WHERE i.purchase_selected_by = 'user' OR i.purchase_price_manual IS NOT NULL GROUP BY tender_id",
      "SELECT id tender_id, first_seen_at at FROM tenders WHERE source = 'manual'",
      ...(has('deal_inputs') ? ['SELECT tender_id, updated_at at FROM deal_inputs'] : []),
      ...(has('bid_cases') ? ['SELECT tender_id, updated_at at FROM bid_cases'] : []),
      ...(has('comprehensive_reports') ? ['SELECT tender_id, MAX(started_at) at FROM comprehensive_reports GROUP BY tender_id'] : []),
    ];
    const rows = db.prepare(`SELECT tender_id, MIN(at) first_at, MAX(at) last_at FROM (${parts.join(' UNION ALL ')}) WHERE tender_id IS NOT NULL GROUP BY tender_id`).all();
    const now = clock().toISOString();
    const ins = db.prepare('INSERT OR IGNORE INTO tender_visits (tender_id, first_at, last_at, last_step, visits) VALUES (?, ?, ?, NULL, 0)');
    for (const r of rows) ins.run(r.tender_id, r.first_at || now, r.last_at || now);
    repo.setSetting?.('history_backfilled_v1', String(rows.length));
  }

  /** Закупка открыта (или открыт её шаг). Скрытая из истории закупка при новом открытии возвращается. */
  function visit(tenderId, step = null) {
    if (!repo.getTender(tenderId)) return null;
    const now = clock().toISOString();
    const s = STEPS.has(step) ? step : null;
    db.prepare(`INSERT INTO tender_visits (tender_id, first_at, last_at, last_step, visits, hidden) VALUES (?, ?, ?, ?, 1, 0)
      ON CONFLICT(tender_id) DO UPDATE SET last_at = excluded.last_at, last_step = COALESCE(excluded.last_step, last_step), visits = visits + 1, hidden = 0`).run(tenderId, now, now, s);
    return { ok: true };
  }

  function hide(tenderId) { db.prepare('UPDATE tender_visits SET hidden = 1 WHERE tender_id = ?').run(tenderId); return { ok: true }; }

  /** На чём остановились по закупке — по текущим данным, без обращений к сети. */
  function progressOf(t) {
    const items = db.prepare('SELECT id, purchase_offer_id, purchase_price_manual FROM tender_items WHERE tender_id = ?').all(t.id);
    const allocated = new Set(db.prepare('SELECT DISTINCT item_id FROM item_allocations WHERE tender_id = ?').all(t.id).map((x) => x.item_id));
    const chosen = items.filter((i) => i.purchase_offer_id != null || i.purchase_price_manual != null || allocated.has(i.id)).length;
    const analysis = t.analysis_id ? db.prepare('SELECT status FROM analyses WHERE id = ?').get(t.analysis_id) : null;
    const eco = db.prepare('SELECT verdict, profit, margin_pct, confirmed FROM tender_economics WHERE tender_id = ?').get(t.id) || null;
    const dealApproved = has('deal_snapshots') ? db.prepare('SELECT created_at FROM deal_snapshots WHERE tender_id = ? ORDER BY id DESC LIMIT 1').get(t.id) : null;
    const bid = has('bid_cases') ? db.prepare('SELECT id, status, updated_at FROM bid_cases WHERE tender_id = ? ORDER BY id DESC LIMIT 1').get(t.id) : null;
    const files = bid && has('bid_versions') ? db.prepare('SELECT version, status, created_at FROM bid_versions WHERE case_id = ? ORDER BY version DESC LIMIT 1').get(bid.id) : null;
    const full = has('comprehensive_reports') ? db.prepare('SELECT recommendation, started_at FROM comprehensive_reports WHERE tender_id = ? ORDER BY started_at DESC LIMIT 1').get(t.id) : null;
    return {
      analysis: analysis?.status || null,
      items: items.length, chosen,
      economics: eco ? { verdict: eco.verdict, profit: eco.profit, margin_pct: eco.margin_pct, confirmed: Boolean(eco.confirmed) } : null,
      deal_approved_at: dealApproved?.created_at || null,
      bid: bid ? { status: bid.status, at: bid.updated_at } : null,
      files: files ? { version: files.version, status: files.status, at: files.created_at } : null,
      full: full ? { recommendation: full.recommendation, at: full.started_at } : null,
    };
  }

  /** История: последние открытые сверху. */
  function list({ limit = 100 } = {}) {
    const rows = db.prepare(`SELECT v.*, t.id, t.number, t.title, t.price, t.deadline_at, t.law, t.platform, t.analysis_id, t.region, t.source
      FROM tender_visits v JOIN tenders t ON t.id = v.tender_id WHERE v.hidden = 0 ORDER BY v.last_at DESC LIMIT ?`).all(Math.min(500, Math.max(1, Number(limit) || 100)));
    return {
      items: rows.map((r) => ({
        tender_id: r.tender_id, number: r.number, title: r.title, price: r.price, deadline_at: r.deadline_at, law: r.law, platform: r.platform, region: r.region, manual: r.source === 'manual',
        first_at: r.first_at, last_at: r.last_at, last_step: r.last_step, visits: r.visits,
        progress: progressOf(r),
      })),
    };
  }

  return { visit, hide, list };
}

module.exports = { createHistory };
