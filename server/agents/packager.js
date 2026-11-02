// Итоговый пакет документов (этап 6 пакета агентов). Работает внутри прогона агента заявок сразу после «Собрать
// черновик»: доводит пакет до состояния «можно выгружать для переноса» и учится на своих и чужих ошибках.
//   • самопочинка: файлы составлены на прежних данных или не прочитались обратно — пересобирает один раз;
//   • память выбора: какой документ участника вы ставили в строку «что приложить» (доверенность, лицензия, выписка) —
//     в следующей заявке тот же документ ставится сам, если он среди подходящих; «не требуется» сам не ставит;
//   • ошибки сборки: каждая проблема файла (пустое поле, потерянная строка, лишние сведения, незаполненные места,
//     проект вместо документа, поля площадки) — урок по «площадка · закон»; что исчезло к следующей сборке — исправлено;
//   • страна происхождения и товарный знак: ищет сам (agents/marks.js) — характеристики, страница товара, своя база;
//     ваша правка против найденного — урок «ошибся»;
//   • итог: можно ли выгружать итоговый архив и что мешает — словами.
// Проверяющий (checker.checkPackage) сверяет итог с самим пакетом: «можно выгружать» при незаполненных местах или
// непрочитанных файлах — ошибка агента, урок ему.

const BY = 'агент пакета (как вы выбирали раньше)';
// Автоматический режим (решение владельца 31.10.2026 — «запустим в автомате и посмотрим»): агент сам подтверждает
// декларацию, утверждает цену и ставит страну и знак из спорных источников. Подпись и подачу по-прежнему делает человек;
// каждое такое действие подписано AUTO_BY, видно в заявке и снимается одной кнопкой. Выключается PACKAGE_AUTO=false.
const AUTO_BY = 'агент пакета (автоматически, проверьте перед подачей)';
const ISSUE = {
  row_lost: 'Потеряна строка', value_lost: 'Пустое или потерянное значение', placeholder: 'Незаполненные места',
  leak: 'Лишние сведения в части заявки', unreadable: 'Файл не читается обратно', changed: 'Файл отличается от оригинала',
};
const fileName = (f) => String(f.path || f.id || '').split('/').pop();
const kindsKey = (line) => (line.doc_kinds || []).slice().sort().join(',');

function createPackager({ repo, journal, bids = null, marks = null, charService = null, auto = true, clock = () => new Date(), log = console }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS pkg_choices (
      kinds TEXT PRIMARY KEY, document_id INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1, last_at TEXT);
    CREATE TABLE IF NOT EXISTS pkg_cases (case_id INTEGER PRIMARY KEY, codes TEXT, final_ok INTEGER, at TEXT);`);
  const now = () => clock().toISOString();

  /** Выбор человека в этой заявке — в память (по виду документа). */
  function learn(view) {
    let n = 0;
    for (const l of view.checklist || []) {
      if (l.closure !== 'dossier_document' || !l.choice?.document_id || String(l.choice.by || '').startsWith('агент')) continue;
      const k = kindsKey(l);
      if (!k) continue;
      const was = db.prepare('SELECT document_id FROM pkg_choices WHERE kinds = ?').get(k);
      if (was?.document_id === l.choice.document_id) continue;
      db.prepare(`INSERT INTO pkg_choices (kinds, document_id, last_at) VALUES (?, ?, ?)
        ON CONFLICT(kinds) DO UPDATE SET document_id = excluded.document_id, count = count + 1, last_at = excluded.last_at`).run(k, l.choice.document_id, now());
      n++;
    }
    if (n) journal.metric('package', 'learned_choices', n);
    return n;
  }

  /** Строки без документа, где ваш прежний выбор подходит, — поставить его. */
  async function applyChoices(caseId, view) {
    let n = 0;
    for (const l of view.checklist || []) {
      if (l.closure !== 'dossier_document' || l.choice || l.state === 'ok' || l.state === 'info') continue;
      const mem = db.prepare('SELECT document_id FROM pkg_choices WHERE kinds = ?').get(kindsKey(l));
      if (!mem || !(l.candidates || []).some((d) => d.id === mem.document_id)) continue;
      try { await bids.choose(caseId, l.id, { document_id: mem.document_id, by: BY }); n++; } catch (err) { log.warn?.(`[пакет] выбор документа: ${err.message}`); }
    }
    if (n) journal.metric('package', 'auto_choices', n);
    return n;
  }

  /** Проблемы собранного пакета: [{code, text, file}]. */
  function problemsOf(view) {
    const built = view.package?.built;
    if (!built) return [{ code: 'not_built', text: 'Файлы заявки не составлены' }];
    const out = [];
    if (!built.files.some((f) => f.id === 'product-proposal')) out.push({ code: 'no_product_proposal', text: 'Нет предложения о товаре' });
    for (const f of built.files) {
      if (f.todo) out.push({ code: `${f.id}:todo`, text: `«${fileName(f)}»: незаполненных мест ${f.todo}`, file: f.id });
      if (f.draft) out.push({ code: `${f.id}:draft`, text: `«${fileName(f)}» — проект: ${f.reason || 'не оформлен'}`, file: f.id });
      for (const i of (f.check?.issues || []).filter((x) => x.kind !== 'placeholder')) out.push({ code: `${f.id}:${i.kind}`, text: `«${fileName(f)}»: ${i.text}`, file: f.id });
    }
    const empty = (built.fields || []).filter((f) => !f.filled).length;
    if (empty) out.push({ code: 'platform_fields', text: `Не заполнены поля площадки: ${empty}` });
    return out;
  }

  /**
   * После «Собрать черновик» агентом заявок.
   * @returns {{final_ok, blockers: string[], problems: Array<{code,text}>, redrafted, chosen, fixed}}
   */
  async function afterDraft(caseId, { platform = '', law = '', tenderId = null } = {}) {
    if (!bids) return null;
    const scope = [platform, law ? `${law}-ФЗ` : ''].filter(Boolean).join(' · ');
    let view = bids.view(caseId);
    if (!view) return null;
    learn(view);
    try { marks?.judge(); } catch (err) { log.warn?.(`[пакет] сверка страны и знака: ${err.message}`); }
    let redrafted = 0;
    const chosen = await applyChoices(caseId, view);
    // страна и знак, которых нет в заявке, — найти самому
    let marked = 0;
    if (marks && charService && tenderId) {
      try {
        const chars = await charService.view(tenderId);
        const offerOf = (itemId) => { const it = repo.getItems(tenderId).find((i) => i.id === itemId); return it?.purchase_offer_id ? repo.getOffer(it.purchase_offer_id) : null; };
        marked = await marks.fill(tenderId, chars, offerOf, charService);
      } catch (err) { log.warn?.(`[пакет] страна и знак: ${err.message}`); }
    }
    const autoDone = auto ? await autoConfirm(caseId, view, tenderId) : 0;
    const built = view.package?.built;
    const broken = built && (!built.current || built.files.some((f) => (f.check?.issues || []).some((i) => i.kind === 'unreadable')));
    if (chosen || marked || broken || autoDone) {
      try { await bids.draft(caseId); redrafted = 1; journal.metric('package', 'redrafted', 1); } catch (err) { log.warn?.(`[пакет] пересборка: ${err.message}`); }
      view = bids.view(caseId);
    }
    const problems = problemsOf(view);
    // спорные находки страны и знака — подсказкой человеку, в заявку сами не ставятся
    const items = tenderId ? repo.getItems(tenderId) : [];
    for (const s of marks?.suggestions?.(tenderId) || []) {
      const it = items.find((i) => i.id === s.item_id);
      problems.push({ code: 'marks_suggest', text: `Позиция ${it ? (it.idx ?? 0) + 1 : ''} «${String(it?.name || '').slice(0, 60)}»: у поставщика страна или знак не указаны; ${[s.country && `страна — ${s.country}`, s.trademark && `знак — ${s.trademark}`].filter(Boolean).join(', ')} (${s.how}) — проверьте и впишите сами` });
    }
    const blockers = bids.blockers ? bids.blockers(caseId) : problems.map((p) => p.text);
    const finalOk = !blockers.length && !problems.length;

    // уроки: вид проблемы — один раз на закупку; что было в прошлой сборке этой заявки и исчезло — исправлено
    const codes = [...new Set(problems.map((p) => p.code))];
    const prev = db.prepare('SELECT codes FROM pkg_cases WHERE case_id = ?').get(caseId);
    const before = prev ? JSON.parse(prev.codes || '[]') : [];
    const fixed = before.filter((c) => !codes.includes(c)).length;
    for (const c of codes.filter((x) => !before.includes(x))) {
      const p = problems.find((x) => x.code === c);
      const kind = c.split(':')[1];
      journal.lesson('package', c, kind ? `${ISSUE[kind] || (kind === 'todo' ? 'Незаполненные места' : kind === 'draft' ? 'Проект вместо документа' : kind)} в файле ${p.file}` : p.text.split(':')[0], { scope, tenderId, text: p.text, source: 'self' });
    }
    db.prepare('INSERT OR REPLACE INTO pkg_cases (case_id, codes, final_ok, at) VALUES (?, ?, ?, ?)').run(caseId, JSON.stringify(codes), finalOk ? 1 : 0, now());
    journal.metric('package', 'built', 1);
    journal.metric('package', finalOk ? 'final_ok' : 'final_blocked', 1);
    if (fixed) journal.metric('package', 'fixed', fixed);
    return { final_ok: finalOk, blockers: blockers.slice(0, 10), problems: problems.slice(0, 10), redrafted, chosen, marked, fixed, auto: autoDone };
  }

  /** Автоматический режим: декларация, цена, спорные страна и знак. @returns {number} сколько действий сделано */
  async function autoConfirm(caseId, view, tenderId) {
    let n = 0;
    // 1) страна и знак из спорных источников (своя база, тот же товар у других поставщиков) — сразу в заявку
    if (marks && charService && tenderId) {
      for (const s of marks.suggestions?.(tenderId) || []) {
        try {
          await charService.save(tenderId, { item_id: s.item_id, ...(s.country ? { country: s.country } : {}), ...(s.trademark ? { trademark: s.trademark } : {}) });
          db.prepare('INSERT OR REPLACE INTO marks_auto (item_id, offer_id, domain, trademark, country, how, at) VALUES (?, NULL, ?, ?, ?, ?, ?)').run(s.item_id, 'спорный источник', s.trademark || null, s.country || null, `авто: ${s.how || ''}`, now());
          n++; journal.metric('package', 'auto_marks', 1);
        } catch (err) { log.warn?.(`[пакет] авто страна и знак: ${err.message}`); }
      }
    }
    // данные закупки изменились после проверки — подтверждать на старых нельзя: сначала проверить заново
    // (31.10: «авто декларация: данные изменились» — автоматический режим не срабатывал)
    if (view.stale && bids.rebuild) {
      try { view = await bids.rebuild(caseId); } catch (err) { log.warn?.(`[пакет] проверить заново: ${err.message}`); return n; }
    }
    // 2) декларация: все положения
    const ids = bids.declarationIds ? bids.declarationIds(caseId) : [];
    for (const r of (view.requirements || []).filter((x) => x.evidence_kind === 'attestation' && x.applicability === 'applies')) {
      if ((view.attestations || []).some((a) => a.requirement_id === r.id)) continue;
      try { await bids.attest(caseId, r.id, { by: AUTO_BY, statements: ids.length ? ids : null }); n++; journal.metric('package', 'auto_attest', 1); }
      catch (err) { log.warn?.(`[пакет] авто декларация: ${err.message}`); }
    }
    // 3) цена: если подаётся в заявке — своя цена = цена при ожидаемом снижении (не ниже безубыточности), утвердить
    const ps = bids.priceState ? bids.priceState(caseId) : null;
    if (ps?.required && !ps.approved) {
      try {
        if (ps.own == null) {
          const e = repo.getEconomics?.(tenderId) || {};
          const t = repo.getTender(tenderId);
          const decl = Number(e.result?.inputs?.decline_pct) || 0;
          const cost = Number(e.result?.result?.cost ?? e.result?.cost) || 0;
          // себестоимость не посчитана — снижать не на что опереться: начальная цена
          const price = cost > 0 ? Math.max(Math.round((Number(t?.price) || 0) * (1 - decl / 100) * 100) / 100, cost) : Number(t?.price) || 0;
          if (price > 0) repo.saveEconomics(tenderId, { overrides: { ...(e.overrides || {}), price }, result: e.result || null, opportunity: e.opportunity ?? null, confirmed: e.confirmed ?? null });
        }
        await bids.approvePrice(caseId, { by: AUTO_BY }); n++; journal.metric('package', 'auto_price', 1);
      } catch (err) { log.warn?.(`[пакет] авто цена: ${err.message}`); }
    }
    return n;
  }

  /** Для управляющего. */
  function stats() {
    const t = (k) => journal.trend('package', k);
    const top = db.prepare("SELECT code, title, scope, count FROM agents_lessons WHERE agent = 'package' ORDER BY count DESC LIMIT 3").all();
    return { built: t('built'), final_ok: t('final_ok'), redrafted: t('redrafted').today, chosen: t('auto_choices').today, marks: t('marks_found').today, fixed: t('fixed').today, memory: db.prepare('SELECT COUNT(*) n FROM pkg_choices').get().n, top, suggest: marks?.readiness?.() || [] };
  }

  return { afterDraft, learn, problemsOf, stats, autoConfirm };
}

module.exports = { createPackager, BY, AUTO_BY };
