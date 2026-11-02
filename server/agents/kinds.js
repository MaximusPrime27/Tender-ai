// Знаток товара (этап 1а пакета «автономность», 31.10.2026): работа товароведа без нейросети. Ведёт карточки видов товара,
// учится на контрактах, на выборе и отказах владельца и на собственных ошибках, после каждого прогона проверяет отобранные
// заявки и сам снимает те, где товар оказался другим. Заявка не удаляется: остаётся с пометкой и причиной.
//
// Откуда учится (kind_examples): right — строки контрактов, сверенные как подходящие, и выбор человека; wrong — товар, который
// человек заменил, и то, что поймала самопроверка. Новое правило сверяется на накопленных примерах (scripts/kind-holdout.js).
const { buildKindModel, checkKind, setKindModel, getKindModel, kindOfItem, KIND_ON } = require('../offers/kind-model');

const DAY = 24 * 3600 * 1000;

function createKindAgent({ repo, journal, clock = () => new Date(), log = console }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS kind_examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_name TEXT NOT NULL, ktru_code TEXT, title TEXT NOT NULL, verdict TEXT NOT NULL,
      source TEXT NOT NULL, tender_id INTEGER, why TEXT, at TEXT NOT NULL, UNIQUE (item_name, title, verdict));
    CREATE TABLE IF NOT EXISTS kind_cards (
      kind_key TEXT PRIMARY KEY, label TEXT NOT NULL, n INTEGER NOT NULL, codes_json TEXT, synonyms_json TEXT, purpose_json TEXT,
      core_json TEXT, wrong_json TEXT, price_low REAL, price_high REAL, updated_at TEXT NOT NULL);`);
  const now = () => clock().toISOString();
  const J = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

  /** Новый пример: true, если такого ещё не было. */
  function remember({ item_name: name, ktru_code: code = null, title, verdict, source, tender_id: tenderId = null, why = null }) {
    if (!name || !title) return false;
    const r = db.prepare('INSERT OR IGNORE INTO kind_examples (item_name, ktru_code, title, verdict, source, tender_id, why, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(String(name).slice(0, 300), code, String(title).slice(0, 300), verdict, source, tenderId, why, now());
    return r.changes > 0;
  }
  /** Сбор примеров: контракты и выбор человека. Только добавление: прежние примеры не меняются. */
  function collect() {
    let added = 0;
    const rows = db.prepare(`SELECT i.name, i.ktru_code, o.title, o.tender_id FROM offers o JOIN tender_items i ON i.id = o.item_id
      WHERE o.source = 'contracts' AND o.match = 'соответствует' AND o.title IS NOT NULL
      UNION ALL SELECT i.name, i.ktru_code, o.title, o.tender_id FROM tender_items i JOIN offers o ON o.id = i.purchase_offer_id WHERE i.purchase_selected_by = 'user'`).all();
    for (const r of rows) if (remember({ item_name: r.name, ktru_code: r.ktru_code, title: r.title, verdict: 'right', source: 'контракт или выбор человека', tender_id: r.tender_id })) added++;
    // человек заменил товар агента: отвергнутый товар — ошибочный пример
    for (const b of db.prepare("SELECT tender_id, summary_json FROM bid_agent_items WHERE summary_json LIKE '%\"corrected\"%'").all()) {
      for (const it of J(b.summary_json, {}).items || []) {
        if (it.corrected && it.offer?.title && remember({ item_name: it.name, ktru_code: it.ktru_code || null, title: it.offer.title, verdict: 'wrong', source: 'человек заменил товар', tender_id: b.tender_id })) added++;
      }
    }
    return added;
  }
  /** Пересборка модели и карточек. Выучить без примеров тоже можно: основа — позиции закупок. */
  function relearn() {
    const added = collect();
    const items = db.prepare('SELECT name, ktru_code FROM tender_items').all();
    const examples = db.prepare('SELECT item_name, ktru_code, title, verdict FROM kind_examples').all();
    const model = buildKindModel(items, examples);
    setKindModel(model);
    const put = db.prepare(`INSERT INTO kind_cards (kind_key, label, n, codes_json, synonyms_json, purpose_json, core_json, wrong_json, price_low, price_high, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind_key) DO UPDATE SET label = excluded.label, n = excluded.n, codes_json = excluded.codes_json,
      synonyms_json = excluded.synonyms_json, purpose_json = excluded.purpose_json, core_json = excluded.core_json, wrong_json = excluded.wrong_json,
      price_low = excluded.price_low, price_high = excluded.price_high, updated_at = excluded.updated_at`);
    const prices = priceRanges(model);
    const had = db.prepare('SELECT COUNT(*) n FROM kind_cards').get().n;
    db.exec('BEGIN');
    try {
      for (const k of model.kinds.values()) {
        if (k.n < 3) continue;
        const p = prices.get(k.id);
        put.run(k.id, k.label, k.n, JSON.stringify([...k.codes]), JSON.stringify([...k.names.keys()].slice(0, 12)), JSON.stringify(k.purpose), JSON.stringify(k.core), JSON.stringify([...k.wrong]), p?.low ?? null, p?.high ?? null, now());
      }
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    const total = db.prepare('SELECT COUNT(*) n FROM kind_cards').get().n;
    journal?.metric('kinds', 'cards', total, { set: true });
    journal?.metric('kinds', 'cards_new', Math.max(0, total - had));
    journal?.metric('kinds', 'examples_new', added);
    return { kinds: model.kinds.size, cards: total, examples: examples.length, added };
  }
  /** Обычная цена вида — из контрактов: нижняя и верхняя четверть. Для проверки цены и для самой карточки. */
  function priceRanges(model) {
    const byKind = new Map();
    for (const r of db.prepare("SELECT i.name, i.ktru_code, COALESCE(o.unit_price, o.price) p FROM offers o JOIN tender_items i ON i.id = o.item_id WHERE o.source = 'contracts' AND o.match = 'соответствует' AND COALESCE(o.unit_price, o.price) > 0").all()) {
      const k = kindOfItem(model, { name: r.name, ktru_code: r.ktru_code });
      if (k) { if (!byKind.has(k.id)) byKind.set(k.id, []); byKind.get(k.id).push(r.p); }
    }
    const out = new Map();
    for (const [id, list] of byKind) {
      if (list.length < 3) continue;
      list.sort((a, b) => a - b);
      out.set(id, { low: list[Math.floor(list.length / 4)], high: list[Math.floor((list.length * 3) / 4)] });
    }
    return out;
  }

  /**
   * Самопроверка: у заявок последних 30 дней сверяется вид выбранного товара. Другой товар — заявка снимается с «готова»
   * и остаётся с причиной, урок и пример записываются. Выбор человека не трогается; решение человека сохраняется.
   * Вне медицины модель только наблюдает: считает, сколько сказала бы, и ничего не меняет.
   */
  function audit() {
    if (!getKindModel()) relearn();
    const model = getKindModel();
    const since = new Date(clock().getTime() - 30 * DAY).toISOString();
    const stat = { checked: 0, removed: 0, shadow: 0, repeat: 0 };
    for (const b of db.prepare("SELECT id, tender_id, status, reason, summary_json, findings_json FROM bid_agent_items WHERE status IN ('ready', 'needs_work') AND created_at >= ?").all(since)) {
      const summary = J(b.summary_json, {});
      const findings = J(b.findings_json, []);
      if (findings.some((f) => f.code === 'other_kind')) continue;
      const items = repo.getItems(b.tender_id);
      const bad = [];
      for (const it of summary.items || []) {
        if (!it.offer?.title) continue;
        const item = items.find((x) => x.id === it.id);
        if (!item || item.purchase_selected_by === 'user') continue;
        stat.checked++;
        const k = checkKind(model, item, it.offer);
        if (k.verdict !== 'other') continue;
        if (!KIND_ON.test(String(item.ktru_code || item.okpd2_code || ''))) { stat.shadow++; continue; }
        const known = db.prepare("SELECT 1 FROM kind_examples WHERE item_name = ? AND title = ? AND verdict = 'wrong'").get(String(item.name).slice(0, 300), String(it.offer.title).slice(0, 300));
        if (known) stat.repeat++;
        remember({ item_name: item.name, ktru_code: item.ktru_code, title: it.offer.title, verdict: 'wrong', source: 'самопроверка', tender_id: b.tender_id, why: k.why });
        journal?.lesson('bid', 'other_kind', 'Выбран другой товар: совпали размеры, но не вид и не назначение', { scope: k.kind || '', tenderId: b.tender_id, text: `«${String(item.name).slice(0, 60)}» → «${String(it.offer.title).slice(0, 80)}»: ${k.why}`.slice(0, 280), source: 'self' });
        bad.push(`позиция ${(item.idx ?? 0) + 1} — ${k.why}`);
      }
      if (!bad.length) continue;
      stat.removed++;
      findings.unshift({ level: 'block', code: 'other_kind', text: `Другой товар: ${bad.join('; ')}`.slice(0, 500) });
      summary.verdict = 'товар не подтверждён';
      db.prepare("UPDATE bid_agent_items SET status = 'needs_work', reason = ?, summary_json = ?, findings_json = ?, updated_at = ? WHERE id = ?")
        .run(`другой товар: ${bad[0]}`.slice(0, 300), JSON.stringify(summary), JSON.stringify(findings), now(), b.id);
    }
    if (journal) for (const k of Object.keys(stat)) journal.metric('kinds', k, stat[k]);
    return stat;
  }
  /** После прогона: выучить новое, проверить заявки, ошибки сразу войти в модель. */
  function afterRun() {
    const learned = relearn();
    const a = audit();
    if (a.removed) relearn();
    log.log?.(`[знаток товара] карточек ${learned.cards}, новых примеров ${learned.added}, снято заявок ${a.removed}, повторов ${a.repeat}`);
    return { ...learned, ...a };
  }
  /** Из рабочего процесса: закончился новый прогон агента заявок — учиться и проверять. */
  function tick() {
    const run = db.prepare("SELECT id, status FROM bid_agent_runs ORDER BY id DESC LIMIT 1").get();
    if (!run || run.status === 'running' || Number(repo.getSetting('kinds:last_run') || 0) >= run.id) return null;
    repo.setSetting('kinds:last_run', String(run.id));
    return afterRun();
  }
  function stats() {
    const t = (key) => journal?.trend('kinds', key).today || 0;
    const by = db.prepare('SELECT verdict, COUNT(*) n FROM kind_examples GROUP BY verdict').all();
    return {
      cards: db.prepare('SELECT COUNT(*) n FROM kind_cards').get().n,
      right: by.find((x) => x.verdict === 'right')?.n || 0,
      wrong: by.find((x) => x.verdict === 'wrong')?.n || 0,
      today: { removed: t('removed'), repeat: t('repeat'), cards_new: t('cards_new'), examples_new: t('examples_new'), shadow: t('shadow') },
    };
  }
  return { relearn, audit, afterRun, tick, remember, stats };
}

module.exports = { createKindAgent };
