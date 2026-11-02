// Итоги торгов (этап 5 пакета агентов). Агент заявок проверял итоги только своих закупок — их мало, и снижение по
// нише набиралось неделями. Здесь итоги собираются по всем закупкам 44-ФЗ из ленты в наших нишах: срок подачи прошёл
// 10–120 дней назад — значит, контракт, скорее всего, уже заключён. По одному запросу к источнику контрактов раз в
// OUTCOMES_EVERY_MIN минут и не больше OUTCOMES_DAILY в сутки (источник медленный и не наш).
//
// Чему учится:
//   • снижение цены на торгах по нише и по заказчику (decline): у заказчика — с 2 итогов, по нише — с 5;
//   • точность прогноза: для закупок, которые готовил агент заявок, — насколько ошибся ожидаемый процент снижения;
//     ошибка больше 10 пунктов — урок агенту заявок;
//   • кто выигрывает: ИНН победителей по нишам (конкуренты).

const DAY = 24 * 3600 * 1000;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

function createOutcomesAgent({ repo, source = null, journal, config = {}, clock = () => new Date(), log = console }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS outcomes (
      tender_id INTEGER PRIMARY KEY, direction TEXT, customer_inn TEXT, region TEXT, nmck REAL, contract_price REAL,
      decline_pct REAL, winner_inn TEXT, tries INTEGER NOT NULL DEFAULT 0, status TEXT, checked_at TEXT);
    CREATE INDEX IF NOT EXISTS outcomes_dir ON outcomes(direction, status);
    CREATE INDEX IF NOT EXISTS outcomes_cust ON outcomes(customer_inn, status);`);
  const now = () => clock().toISOString();
  const today = () => new Date(clock().getTime() + 3 * 3600000).toISOString().slice(0, 10);
  const every = (config.OUTCOMES_EVERY_MIN ?? 2) * 60000;
  const daily = config.OUTCOMES_DAILY ?? 200;
  const used = () => Number(repo.getSetting(`usage:outcomes:${today()}`) || 0);

  /** Итоги, которые агент заявок уже собрал сам, — в общую таблицу (один раз и при каждом запуске — дёшево). */
  function importOwn() {
    let n = 0;
    try {
      for (const r of db.prepare(`SELECT i.tender_id, i.outcome_json, t.direction, t.customer_inn, t.region, t.price FROM bid_agent_items i JOIN tenders t ON t.id = i.tender_id
          WHERE i.outcome_json IS NOT NULL AND i.tender_id NOT IN (SELECT tender_id FROM outcomes WHERE status = 'done')`).all()) {
        let o = {};
        try { o = JSON.parse(r.outcome_json); } catch { continue; }
        if (o.decline_pct == null) continue;
        db.prepare(`INSERT OR REPLACE INTO outcomes (tender_id, direction, customer_inn, region, nmck, contract_price, decline_pct, winner_inn, tries, status, checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'done', ?)`).run(r.tender_id, r.direction, r.customer_inn, r.region, r.price, o.contract_price, o.decline_pct, o.supplier_inn || null, now());
        n++;
      }
    } catch { /* агент заявок выключен */ }
    return n;
  }

  /** Следующая закупка для проверки: 44-ФЗ, срок прошёл 10–120 дней назад, наши ниши; заказчики с открытыми закупками — первыми. */
  function next() {
    const t = clock().getTime();
    return db.prepare(`SELECT t.id, t.number, t.price, t.direction, t.customer_inn, t.region FROM tenders t
      LEFT JOIN outcomes o ON o.tender_id = t.id
      WHERE t.law = '44' AND t.direction IS NOT NULL AND t.price > 0
        AND t.deadline_at BETWEEN ? AND ?
        AND (o.tender_id IS NULL OR (o.status = 'none' AND o.tries < 3 AND o.checked_at < ?))
      ORDER BY CASE WHEN t.customer_inn IN (SELECT customer_inn FROM tenders WHERE deadline_at > ? AND customer_inn IS NOT NULL) THEN 0 ELSE 1 END, t.deadline_at DESC LIMIT 1`)
      .get(new Date(t - 120 * DAY).toISOString(), new Date(t - 10 * DAY).toISOString(), new Date(t - 7 * DAY).toISOString(), new Date(t).toISOString());
  }

  async function checkOne(t) {
    repo.setSetting(`usage:outcomes:${today()}`, used() + 1);
    let list = [];
    try { list = await source.contractsByPurchase(t.number); } catch (err) { log.warn?.(`[итоги торгов] ${t.number}: ${err.message}`); return null; }
    const price = list.reduce((s, c) => s + (Number(c.price) || 0), 0);
    const tries = (db.prepare('SELECT tries FROM outcomes WHERE tender_id = ?').get(t.id)?.tries || 0) + 1;
    if (!price) {
      db.prepare(`INSERT OR REPLACE INTO outcomes (tender_id, direction, customer_inn, region, nmck, tries, status, checked_at) VALUES (?, ?, ?, ?, ?, ?, 'none', ?)`)
        .run(t.id, t.direction, t.customer_inn, t.region, t.price, tries, now());
      journal.metric('outcomes', 'no_contract', 1);
      return { found: false };
    }
    const decline = Math.round((1 - price / t.price) * 1000) / 10;
    const winner = list[0]?.supplier_inn || (Array.isArray(list[0]?.suppliers) ? list[0].suppliers[0]?.inn || list[0].suppliers[0] : null) || null;
    // снижение вне 0–80% — не та закупка или несколько лотов: не учим
    const ok = decline >= 0 && decline < 80;
    db.prepare(`INSERT OR REPLACE INTO outcomes (tender_id, direction, customer_inn, region, nmck, contract_price, decline_pct, winner_inn, tries, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.id, t.direction, t.customer_inn, t.region, t.price, price, decline, typeof winner === 'string' ? winner : null, tries, ok ? 'done' : 'odd', now());
    journal.metric('outcomes', 'found', 1);
    if (ok) calibrate(t.id, decline);
    return { found: true, decline };
  }

  /** Агент заявок готовил эту закупку: насколько ошибся его прогноз снижения. */
  function calibrate(tenderId, actual) {
    let row = null;
    try { row = db.prepare('SELECT summary_json FROM bid_agent_items WHERE tender_id = ? AND summary_json IS NOT NULL ORDER BY id DESC LIMIT 1').get(tenderId); } catch { return; }
    let s = {};
    try { s = JSON.parse(row?.summary_json || '{}'); } catch { return; }
    const predicted = s.econ?.decline_pct;
    if (predicted == null) return;
    const err = Math.round(Math.abs(actual - predicted) * 10) / 10;
    journal.metric('outcomes', 'forecasts', 1);
    journal.metric('outcomes', 'forecast_err_sum', err);
    if (err > 10) journal.lesson('bid', 'decline_forecast', 'Прогноз снижения цены ошибся больше чем на 10 пунктов', { scope: s.platform || '', tenderId, text: `ждали ${predicted}%, на торгах ${actual}%`, source: 'checker' });
  }

  /**
   * Ожидаемое снижение: по заказчику (2+ итога), иначе по нише (5+), иначе null.
   * @returns {{pct, samples, by: 'customer'|'niche'}|null}
   */
  function decline(direction, customerInn = null) {
    const pick = (rows, min, by) => { const d = rows.map((r) => r.decline_pct); return d.length >= min ? { pct: Math.round(median(d) * 10) / 10, samples: d.length, by } : null; };
    const cust = customerInn ? db.prepare("SELECT decline_pct FROM outcomes WHERE status = 'done' AND customer_inn = ? AND direction = ?").all(customerInn, direction) : [];
    return pick(cust, 2, 'customer') || pick(db.prepare("SELECT decline_pct FROM outcomes WHERE status = 'done' AND direction = ? AND checked_at >= ?").all(direction, new Date(clock().getTime() - 180 * DAY).toISOString()), 5, 'niche');
  }

  let last = 0;
  /** Из рабочего процесса раз в минуту: одна закупка раз в OUTCOMES_EVERY_MIN, не больше OUTCOMES_DAILY в сутки. */
  async function tick() {
    if (!source?.contractsByPurchase || Date.now() - last < every || used() >= daily) return null;
    last = Date.now();
    if (!repo.getSetting(`outcomes:imported:${today()}`)) { importOwn(); repo.setSetting(`outcomes:imported:${today()}`, '1'); }
    const t = next();
    return t ? checkOne(t) : null;
  }

  function stats() {
    const n = db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT direction) d FROM outcomes WHERE status = 'done'").get();
    const by = db.prepare("SELECT direction, COUNT(*) n FROM outcomes WHERE status = 'done' GROUP BY 1 HAVING n >= 5 ORDER BY n DESC LIMIT 5").all()
      .map((r) => ({ direction: r.direction, ...decline(r.direction) }));
    const f = journal.trend('outcomes', 'forecasts', 30);
    const e = journal.trend('outcomes', 'forecast_err_sum', 30);
    const forecasts = f.today + (f.avg || 0) * f.days;
    const errSum = e.today + (e.avg || 0) * e.days;
    return { total: n.n, niches: n.d, today: journal.trend('outcomes', 'found').today, used: used(), daily, by, forecast_err: forecasts ? Math.round((errSum / forecasts) * 10) / 10 : null };
  }

  return { tick, checkOne, next, decline, importOwn, calibrate, stats };
}

module.exports = { createOutcomesAgent };
