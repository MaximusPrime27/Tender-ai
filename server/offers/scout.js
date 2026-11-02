// Агент поиска поставщиков (сначала мебель): работает в рабочем процессе (server/worker.js) понемногу весь день.
// Берёт открытые закупки своих ниш, где товар не найден или «ни одно не подходит», и пробует снова:
//   • бесплатно — своя база товаров (карточки Мерлиона, сайтов фабрик, найденные раньше);
//   • платно (Яндекс, свой суточный лимит SCOUT_DAILY_REQUESTS) — поиск поставщиков, каждая попытка с другими
//     формулировками: 1-я — вид и размеры, 2-я — синонимы и «от производителя», 3-я — розница и маркетплейсы;
//   • нашёл подходящие предложения по всем позициям — агент заявок считает прибыль (выгодная — в ленту и Telegram);
//   • не нашёл за SCOUT_MAX_ATTEMPTS попыток или SCOUT_GIVEUP_DAYS дней — «нужен запрос цены»: компании ниши,
//     которым стоит написать (черновики запроса — на шаге «Поставщики»; отправляет человек).

const DAY = 86400000;
const GOOD = ['соответствует', 'частично'];

function createScout({ repo, offers = null, bidAgent = null, config = {}, clock = () => new Date(), log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 5000 }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS scout_tasks (
    tender_id INTEGER PRIMARY KEY, niche TEXT, status TEXT NOT NULL DEFAULT 'searching', attempts INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0, first_at TEXT, last_at TEXT, found_at TEXT, note TEXT, missing_json TEXT, companies_json TEXT)`);
  const now = () => clock().toISOString();
  const today = () => new Date(clock().getTime() + 3 * 3600000).toISOString().slice(0, 10);
  const lim = () => ({
    // свои ниши плюс слабые ниши от разведчика поставщиков (agents/sources.js: где чаще всего нет товара)
    niches: [...new Set([...(config.SCOUT_NICHES || ['g-furniture']), ...(() => { try { return JSON.parse(repo.getSetting('scout:auto_niches') || '[]'); } catch { return []; } })()])], daily: config.SCOUT_DAILY_REQUESTS ?? 60, attempts: config.SCOUT_MAX_ATTEMPTS ?? 3,
    retryHours: config.SCOUT_RETRY_HOURS ?? 12, giveupDays: config.SCOUT_GIVEUP_DAYS ?? 3, minDays: config.SCOUT_MIN_DAYS ?? 2,
  });
  const used = () => Number(repo.getSetting(`usage:yandex_scout:${today()}`) || 0);
  const addUsed = (n) => repo.setSetting(`usage:yandex_scout:${today()}`, used() + n);

  /** Позиции закупки, по которым нет подходящего предложения (сверено «соответствует»/«частично» без «нет»). */
  function missing(tenderId) {
    const offs = repo.getOffers(tenderId).filter((o) => o.source !== 'contracts' && GOOD.includes(o.match) && !(o.match_checks?.rows || []).some((r) => r.verdict === 'no'));
    return repo.getItems(tenderId).filter((i) => !offs.some((o) => o.item_id === i.id));
  }

  /** Закупки для попытки: ниши агента, в работе, срок подачи не ближе SCOUT_MIN_DAYS, цена — по настройкам агента заявок. */
  function candidates() {
    const l = lim();
    const priceMax = bidAgent?.settings?.().price_max ?? null;
    const minDeadline = new Date(clock().getTime() + l.minDays * DAY).toISOString();
    const rows = db.prepare(`SELECT t.id, t.direction, t.price, t.deadline_at, t.analysis_id FROM tenders t
      WHERE t.status = 'scored' AND t.deadline_at > ? AND t.direction IN (${l.niches.map(() => '?').join(',')})
        ${priceMax ? 'AND (t.price IS NULL OR t.price <= ?)' : ''} ORDER BY t.deadline_at LIMIT 300`).all(minDeadline, ...l.niches, ...(priceMax ? [priceMax] : []));
    const retry = new Date(clock().getTime() - l.retryHours * 3600000).toISOString();
    return rows.filter((t) => {
      const task = db.prepare('SELECT status, attempts, last_at FROM scout_tasks WHERE tender_id = ?').get(t.id);
      if (!task) return true;
      return task.status === 'searching' && task.attempts < l.attempts && (!task.last_at || task.last_at < retry);
    });
  }

  async function waitSearch(searchId, minutes = 25) {
    const end = Date.now() + minutes * 60000;
    for (;;) {
      const s = repo.getOfferSearch(searchId);
      if (s && ['done', 'error'].includes(s.status)) return s;
      if (Date.now() > end) return s;
      await sleep(pollMs);
    }
  }

  /** Компании ниши, которым стоит написать запрос цены (каталог поставщиков по направлению). */
  function companies(niche) {
    try { return (offers?.supplierCatalog?.(niche) || []).slice(0, 5).map((c) => ({ name: c.name || c.site, site: c.site })); } catch { return []; }
  }

  /** Одна попытка по одной закупке. @returns {object|null} что сделано; null — делать нечего (лимит, нет закупок). */
  async function tick() {
    const l = lim();
    if (!offers) return null;
    if (used() >= l.daily) return { skipped: 'лимит' };
    const t = candidates()[0];
    if (!t) return null;
    const at = now();
    const task = db.prepare('SELECT * FROM scout_tasks WHERE tender_id = ?').get(t.id) || { attempts: 0, requests: 0, first_at: at };
    db.prepare(`INSERT INTO scout_tasks (tender_id, niche, status, attempts, requests, first_at, last_at) VALUES (?, ?, 'searching', ?, ?, ?, ?)
      ON CONFLICT(tender_id) DO UPDATE SET last_at = excluded.last_at`).run(t.id, t.direction, task.attempts, task.requests, task.first_at || at, at);
    let lack = missing(t.id);
    const before = lack.length;
    // товар уже был найден раньше — искать нечего; прибыль посчитает утренний прогон агента заявок (мебель — в его
    // нишах). Звать его отсюда нельзя: у старого поиска он запустил бы новый платный поиск мимо лимита агента поиска.
    if (!before) {
      db.prepare("UPDATE scout_tasks SET status = 'found', last_at = ?, note = ?, missing_json = '[]' WHERE tender_id = ?").run(now(), 'товар уже был найден раньше — прибыль посчитает агент заявок', t.id);
      return { tender_id: t.id, status: 'found', spent: 0, earlier: true };
    }
    // бесплатно: своя база товаров (Мерлион, сайты фабрик, найденное раньше)
    for (const item of lack) { try { await offers.baseCheck?.(t.id, item.id); } catch { /* вид товара базой не охвачен */ } }
    lack = missing(t.id);
    let spent = 0;
    let searched = false;
    if (lack.length) {
      // платно: поиск поставщиков с формулировками попытки; документацию заново не читаем, если она не разобрана (ЕИС)
      const searchId = offers.start(t.id, { variant: task.attempts, auto: !t.analysis_id });
      const s = await waitSearch(searchId);
      spent = s?.api_requests || 0;
      addUsed(spent);
      searched = true;
      lack = missing(t.id);
    }
    const attempts = task.attempts + (searched ? 1 : 0);
    const old = clock().getTime() - new Date(task.first_at || at).getTime() > l.giveupDays * DAY;
    let status = 'searching';
    let note = `попытка ${attempts}: ${before ? `без товара было ${before} поз.` : 'товар был'}, осталось ${lack.length}${spent ? `, запросов к Яндексу ${spent}` : ''}`;
    if (!lack.length) {
      status = 'found';
      note = `подходящие предложения есть по всем позициям (попытка ${attempts})`;
    } else if (attempts >= l.attempts || old) {
      status = 'quote';
      note = `за ${attempts} попыток не нашлось подходящего по ${lack.length} поз. — нужен запрос цены у производителей`;
    }
    db.prepare(`UPDATE scout_tasks SET status = ?, attempts = ?, requests = requests + ?, last_at = ?, note = ?, missing_json = ?,
      found_at = CASE WHEN ? = 'found' THEN ? ELSE found_at END, companies_json = CASE WHEN ? = 'quote' THEN ? ELSE companies_json END WHERE tender_id = ?`)
      .run(status, attempts, spent, now(), note, JSON.stringify(lack.map((i) => ({ id: i.id, idx: i.idx, name: String(i.name).slice(0, 120) }))),
        status, now(), status, JSON.stringify(companies(t.direction)), t.id);
    log.log?.(`[scout] закупка ${t.id}: ${note}`);
    // нашлось — агент заявок считает прибыль; выгодная уходит в ленту и Telegram
    if (status === 'found' && bidAgent) {
      try { await bidAgent.run({ reason: 'manual', tenderIds: [t.id] }); } catch (err) { log.warn?.(`[scout] агент заявок: ${err.message}`); }
    }
    return { tender_id: t.id, status, spent };
  }

  /** Для страницы: задачи агента и расход лимита за сегодня. */
  function view(limit = 60) {
    const rows = db.prepare(`SELECT s.*, t.title, t.price, t.deadline_at FROM scout_tasks s JOIN tenders t ON t.id = s.tender_id
      ORDER BY CASE s.status WHEN 'found' THEN 0 WHEN 'quote' THEN 1 WHEN 'searching' THEN 2 ELSE 3 END, s.last_at DESC LIMIT ?`).all(limit)
      .map((r) => ({ ...r, missing: JSON.parse(r.missing_json || '[]'), companies: JSON.parse(r.companies_json || '[]'), missing_json: undefined, companies_json: undefined }));
    // выгодность по последнему решению агента заявок (его может не быть — агент выключен)
    let verdicts = new Map();
    try {
      verdicts = new Map(db.prepare('SELECT tender_id, summary_json FROM bid_agent_items WHERE id IN (SELECT MAX(id) FROM bid_agent_items GROUP BY tender_id)').all()
        .map((r) => { try { return [r.tender_id, JSON.parse(r.summary_json || '{}').verdict || null]; } catch { return [r.tender_id, null]; } }));
    } catch { verdicts = new Map(); }
    return {
      niches: lim().niches, daily: lim().daily, used_today: used(), queue: candidates().length,
      tasks: rows.map((r) => ({ ...r, verdict: verdicts.get(r.tender_id) || null })),
    };
  }

  return { tick, view, candidates, missing };
}

module.exports = { createScout };
