// Агент подготовки заявки (этап 3 пакета агентов). Работает внутри прогона агента заявок, до и после сборки пакета:
//   • prefill — до сборки: дописывает в характеристики заявки товарный знак и страну, которые вы раньше ставили этому
//     же товару в других заявках (память правок человека): ту же ошибку «нет страны происхождения» он больше не делает;
//   • review — после сборки: разбирает, что не готово (замечания проверки, файлы с пропусками, непройденные
//     обязательные требования), и копит это уроками по площадке и закону — видно, где заявки чаще всего не готовы;
//   • динамика требований: какие требования к заявке встречаются на площадке; новое, которого на этой площадке
//     раньше не было (после 5 разобранных заявок), — урок «новое требование»: так видны изменения форм и правил.
// Проверяющий (agents/checker.js, checkApplication) смотрит на итог: «готово» при открытых критичных замечаниях —
// ошибка агента заявок, а не готовая заявка.

const { modelFromTitle } = require('../offers/product-base');

const FINDING_TITLE = {
  customer_conflict: 'Противоречие в документах заказчика', applicant_conflict: 'Противоречие в данных участника',
  product_mismatch: 'Товар не проходит требование ТЗ', unsupported_origin: 'Страна происхождения не подтверждена',
  missing_document: 'Не хватает документа', unreadable_source: 'Документация прочитана не полностью',
  source_mismatch: 'Цитата требования не в том документе', expired: 'Истёк срок', platform_mismatch: 'Не та площадка',
  legal_applicability_unknown: 'Не установлено, какие правила применяются', version_changed: 'Документы изменились',
  financial_mismatch: 'Расхождение в цене',
};
const MIN_CASES_FOR_NEW = 5;

const memKey = (title) => {
  // по модели — только настоящей («WD40EFZZ», «TL-420X»): буквы и цифры, от 5 знаков; иначе бренд («exegate») или
  // обрывок («3 8гр») связал бы разные товары — по полному названию
  const m = modelFromTitle ? modelFromTitle(String(title || '')) : null;
  const real = m && /\d/.test(m) && /[a-zа-я]/i.test(m) && m.replace(/[^a-zа-я0-9]/gi, '').length >= 5;
  // в названии только бренд («ExeGate») — товар не узнать: не запоминаем
  if (!real && String(title || '').trim().split(/\s+/).length < 3) return '';
  return (real ? m : String(title || '')).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim().slice(0, 120);
};

function createApplicationAgent({ repo, journal, charService = null, clock = () => new Date(), log = console }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS app_memory (
      key TEXT PRIMARY KEY, trademark TEXT, country TEXT, count INTEGER NOT NULL DEFAULT 1, last_at TEXT);
    CREATE TABLE IF NOT EXISTS app_requirements (
      scope TEXT NOT NULL, rkey TEXT NOT NULL, title TEXT, count INTEGER NOT NULL DEFAULT 1, first_at TEXT, last_at TEXT,
      PRIMARY KEY (scope, rkey));
    CREATE TABLE IF NOT EXISTS app_cases (case_id INTEGER PRIMARY KEY, scope TEXT, at TEXT);`);
  const now = () => clock().toISOString();
  const offerTitle = (item) => {
    const o = item.purchase_offer_id ? repo.getOffer(item.purchase_offer_id) : null;
    return o ? (o.product_title || o.title || '') : '';
  };

  /** Память правок человека: товарный знак и страна, которые вы ставили выбранному товару. */
  function learnFromUser() {
    let n = 0;
    for (const r of db.prepare("SELECT key, value FROM settings WHERE key LIKE 'bidchars:%'").all()) {
      let v = {};
      try { v = JSON.parse(r.value || '{}'); } catch { continue; }
      if (!v.trademark && !v.country) continue;
      const item = db.prepare('SELECT * FROM tender_items WHERE id = ?').get(Number(r.key.slice(9)));
      const key = item ? memKey(offerTitle(item)) : '';
      if (!key) continue;
      const was = db.prepare('SELECT * FROM app_memory WHERE key = ?').get(key);
      if (was && was.trademark === (v.trademark || was.trademark) && was.country === (v.country || was.country)) continue;
      db.prepare(`INSERT INTO app_memory (key, trademark, country, last_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET trademark = COALESCE(excluded.trademark, trademark), country = COALESCE(excluded.country, country), count = count + 1, last_at = excluded.last_at`)
        .run(key, v.trademark || null, v.country || null, now());
      n++;
    }
    if (n) journal.metric('application', 'learned_from_user', n);
    return n;
  }

  /** До сборки пакета: знак и страна из памяти для позиций, где их нет. @returns {number} сколько позиций дописано */
  function prefill(tenderId) {
    if (!charService?.save) return 0;
    learnFromUser();
    let n = 0;
    for (const item of repo.getItems(tenderId)) {
      let cur = {};
      try { cur = JSON.parse(repo.getSetting(`bidchars:${item.id}`) || '{}'); } catch { cur = {}; }
      if (cur.trademark && cur.country) continue;
      const mem = db.prepare('SELECT * FROM app_memory WHERE key = ?').get(memKey(offerTitle(item)));
      if (!mem || (!mem.trademark && !mem.country)) continue;
      try {
        charService.save(tenderId, { item_id: item.id, ...(cur.trademark ? {} : mem.trademark ? { trademark: mem.trademark } : {}), ...(cur.country ? {} : mem.country ? { country: mem.country } : {}) });
        n++;
      } catch (err) { log.warn?.(`[заявка] память правок: ${err.message}`); }
    }
    if (n) journal.metric('application', 'prefilled', n);
    return n;
  }

  /**
   * После сборки: что не готово — уроками по площадке и закону; новые требования — сигнал изменений.
   * @param view — bids.view(caseId)
   * @returns {{problems: Array<{code, text}>, ready: boolean}}
   */
  function review(view, { platform = '', law = '', tenderId = null } = {}) {
    if (!view) return { problems: [], ready: false };
    const scope = [platform, law ? `${law}-ФЗ` : ''].filter(Boolean).join(' · ');
    const problems = [];
    for (const f of (view.findings || []).filter((x) => x.status !== 'resolved' && x.status !== 'closed')) {
      problems.push({ code: `finding_${f.type}`, text: `${FINDING_TITLE[f.type] || f.type}: ${String(f.text || '').slice(0, 140)}`, critical: f.severity === 'critical' });
    }
    for (const file of view.package?.built?.files || []) if (file.todo) problems.push({ code: 'todo_file', text: `В файле «${file.path}» не заполнено мест: ${file.todo}` });
    const c = view.readiness?.counters;
    if (c?.mandatory_fail) problems.push({ code: 'mandatory_fail', text: `Не проходят обязательные требования: ${c.mandatory_fail}`, critical: true });
    if (view.dossier && !view.dossier.exists) problems.push({ code: 'no_dossier', text: 'Нет анкеты участника — реквизиты в заявку не подставятся' });
    else if (view.dossier && !view.dossier.complete) problems.push({ code: 'dossier_incomplete', text: `В анкете участника не заполнено: ${(view.dossier.missing || []).slice(0, 4).join(', ')}` });

    // урок — один раз на закупку и вид проблемы
    const seenCodes = new Set();
    for (const p of problems) {
      if (seenCodes.has(p.code)) continue;
      seenCodes.add(p.code);
      journal.lesson('application', p.code, p.text.split(':')[0], { scope, tenderId, text: p.text, source: 'self' });
    }
    // динамика требований на площадке
    const firstTime = !db.prepare('SELECT 1 FROM app_cases WHERE case_id = ?').get(view.id);
    if (firstTime) {
      const cases = db.prepare('SELECT COUNT(*) n FROM app_cases WHERE scope = ?').get(scope).n;
      for (const r of view.requirements || []) {
        const rkey = (r.legal_rule_ids || []).join(',') || String(r.requirement || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!rkey) continue;
        const was = db.prepare('SELECT 1 FROM app_requirements WHERE scope = ? AND rkey = ?').get(scope, rkey);
        db.prepare(`INSERT INTO app_requirements (scope, rkey, title, first_at, last_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(scope, rkey) DO UPDATE SET count = count + 1, last_at = excluded.last_at`).run(scope, rkey, String(r.requirement || '').slice(0, 200), now(), now());
        if (!was && cases >= MIN_CASES_FOR_NEW && r.origin === 'rule') {
          journal.lesson('application', 'new_requirement', 'Новое требование к заявке на площадке', { scope, tenderId, text: String(r.requirement || '').slice(0, 200), source: 'self' });
          journal.metric('application', 'new_requirements', 1);
        }
      }
      db.prepare('INSERT INTO app_cases (case_id, scope, at) VALUES (?, ?, ?)').run(view.id, scope, now());
    }
    const ready = !problems.some((p) => p.critical);
    journal.metric('application', 'reviewed', 1);
    journal.metric('application', ready ? 'ready' : 'not_ready', 1);
    journal.metric('application', 'problems', problems.length);
    return { problems, ready };
  }

  /** Для управляющего: доля готовых заявок и частые причины. */
  function stats() {
    const t = (k) => journal.trend('application', k);
    const top = db.prepare("SELECT code, title, scope, count FROM agents_lessons WHERE agent = 'application' ORDER BY count DESC LIMIT 3").all();
    return { reviewed: t('reviewed'), ready: t('ready'), prefilled: t('prefilled').today, memory: db.prepare('SELECT COUNT(*) n FROM app_memory').get().n, top };
  }

  return { prefill, review, learnFromUser, stats };
}

module.exports = { createApplicationAgent, FINDING_TITLE, memKey };
