// Полный анализ закупки: сбор входов из модулей сервиса, неизменяемые снимки с историей, актуальность, экспорт.
// Снимок — один на запуск; экран, JSON, DOCX и PDF строятся из одного и того же сохранённого снимка.
// Поздний ответ старого запуска не заменяет новый: «последний» — по времени начала запуска.

const crypto = require('node:crypto');
const { buildReport, BUILDER_VERSION } = require('./build');
const { RULES_VERSION } = require('./rules');

const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

function createComprehensiveService({ repo, details = null, deal = null, bids = null, charService = null, clock = () => new Date(), log = console }) {
  repo.db.exec(`CREATE TABLE IF NOT EXISTS comprehensive_reports (
    id TEXT PRIMARY KEY,
    tender_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    as_of TEXT NOT NULL,
    input_revision TEXT NOT NULL,
    recommendation TEXT NOT NULL,
    report_json TEXT NOT NULL
  )`);
  repo.db.exec('CREATE INDEX IF NOT EXISTS comprehensive_reports_tender ON comprehensive_reports (tender_id, started_at)');

  /** Всё, от чего зависит отчёт. Каждый модуль может быть недоступен — остальные продолжают работу. */
  async function gather(tenderId) {
    const tender = repo.getTender(tenderId);
    if (!tender) return null;
    const safe = async (label, fn) => { try { return await fn(); } catch (err) { log.warn?.(`[полный анализ] ${label}: ${err.message}`); return null; } };
    const card = details?.getCard ? await safe('карточка', () => details.getCard(tenderId)) : null;
    const analysis = tender.analysis_id ? repo.getAnalysis(tender.analysis_id) : null;
    const items = repo.getItems(tenderId);
    const offers = repo.getOffers(tenderId);
    const dealView = deal?.view ? await safe('расчёт сделки', () => deal.view(tenderId)) : null;
    const bid = bids?.forTender ? await safe('заявка', () => bids.forTender(tenderId)) : null;
    const chars = charService?.view ? await safe('характеристики', () => charService.view(tenderId)) : null;
    const input_revision = sha({
      builder: BUILDER_VERSION, rules: RULES_VERSION,
      tender: [tender.number, tender.price, tender.deadline_at, tender.platform, tender.analysis_id],
      analysis: analysis ? [analysis.id, analysis.status, analysis.updated_at || analysis.created_at, (analysis.files || []).map((f) => [f.id, f.sha256, f.status])] : null,
      conditions: card?.details?.conditions || null, spec: card?.details?.spec_coverage?.status || null,
      items: items.map((i) => [i.id, i.purchase_offer_id, i.purchase_price_manual, i.purchase_selected_by, (i.eis_chars || []).length, i.eis_measure]),
      offers: offers.map((o) => [o.id, o.unit_price, o.price_date, o.match, o.availability]),
      deal: dealView?.versions?.inputs_hash || null, bid: bid ? [bid.id, bid.status, bid.updated_at] : null,
      chars: chars ? (chars.tables || []).map((t) => [t.item_id, t.trademark, t.country, t.counts]) : null,
    });
    return { tender, card, analysis, items, offers, deal: dealView, bid, chars, input_revision };
  }

  const rowOf = (r) => (r ? { id: r.id, tender_id: r.tender_id, started_at: r.started_at, as_of: r.as_of, input_revision: r.input_revision, recommendation: r.recommendation, report: JSON.parse(r.report_json) } : null);

  /** Новый снимок. Строится сразу: модуль сводит готовые результаты, без новых обращений к нейросети. */
  async function run(tenderId) {
    const started_at = clock().toISOString();
    const input = await gather(tenderId);
    if (!input) return null;
    const now = clock().toISOString();
    const report = buildReport(input, { now });
    const id = `${input.tender.number || tenderId}-${now.replace(/\D/g, '').slice(0, 14)}-${input.input_revision.slice(0, 6)}`;
    report.snapshot.id = id;
    report.snapshot.integrity = sha({ ...report, snapshot: { ...report.snapshot, integrity: null } });
    repo.db.prepare('INSERT INTO comprehensive_reports (id, tender_id, started_at, as_of, input_revision, recommendation, report_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, tenderId, started_at, now, input.input_revision, report.decision.recommendation, JSON.stringify(report));
    return { ...rowOf(repo.db.prepare('SELECT * FROM comprehensive_reports WHERE id = ?').get(id)), freshness: 'current' };
  }

  function history(tenderId) {
    return repo.db.prepare('SELECT id, started_at, as_of, recommendation FROM comprehensive_reports WHERE tender_id = ? ORDER BY started_at DESC LIMIT 30').all(tenderId);
  }

  /** Снимок закупки (последний или по id) с проверкой актуальности: изменились входы — stale, вывод не текущий. */
  async function get(tenderId, snapshotId = null, { checkFreshness = true } = {}) {
    const row = snapshotId
      ? repo.db.prepare('SELECT * FROM comprehensive_reports WHERE id = ? AND tender_id = ?').get(snapshotId, tenderId)
      : repo.db.prepare('SELECT * FROM comprehensive_reports WHERE tender_id = ? ORDER BY started_at DESC LIMIT 1').get(tenderId);
    if (!row) return null;
    const out = rowOf(row);
    if (!checkFreshness) return out;
    const cur = await gather(tenderId);
    const reasons = [];
    if (!cur || cur.input_revision !== row.input_revision) reasons.push('изменились документы, товары, цены, расчёт или правила');
    // проверки со сроком действия (цена со страницы, КП) — снимок стареет и по времени
    const now = Date.parse(clock().toISOString());
    if ((out.report.checks || []).some((c) => c.valid_until && Date.parse(c.valid_until) <= now)
      || (out.report.evidence || []).some((e) => e.valid_until && Date.parse(e.valid_until) <= now)) reasons.push('истёк срок действия проверки или КП');
    // цена была свежей на момент снимка, а с тех пор устарела (если устарела ещё до снимка — это замечание в самом отчёте)
    const asOf = Date.parse(out.as_of);
    if (out.report.offers?.some((o) => o.selected && o.stage !== 'confirmed_by_quote' && o.checked_at && now - Date.parse(o.checked_at) > 3 * 86400e3 && asOf - Date.parse(o.checked_at) <= 3 * 86400e3)) reasons.push('цена выбранного товара проверялась больше 3 дней назад');
    return { ...out, freshness: reasons.length ? 'stale' : 'current', stale_reasons: reasons };
  }

  return { run, get, history, gather };
}

module.exports = { createComprehensiveService };
