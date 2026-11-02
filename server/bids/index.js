// Подготовка заявки: дело по конкретной закупке и лоту. Собирает сценарий, реестр требований, несостыковки и
// готовность — из того, что уже есть в сервисе (разбор документации с отчётом о полноте, позиции и ТЗ, выбранные
// предложения поставщиков), и ничего не отправляет наружу: подача, подписание, платежи — не действия сервиса.
//
// Каждая проверка привязана к отпечатку входных данных (snapshot). Изменились документы, позиции, выбранный товар,
// цена или набор правил — дело становится «устаревшим», а подтверждения человека, данные на прежних данных, не действуют.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { classify } = require('./classify');
const { loadRulePacks, activePack, rulesFor } = require('./rules');
const { buildRequirements } = require('./requirements');
const { validate } = require('./validate');
const { readiness } = require('./readiness');
const { createBidStore } = require('./store');
const { buildChecklist, dossierChecked, applyChecklist } = require('./checklist');
const { buildPackage, verifyFile, buildZip, hasTodo } = require('./package');

// Положения декларации — отдельный файл с пометкой «черновик»: тексты не сверены человеком с действующей редакцией.
const DECLARATIONS_FILE = path.join(__dirname, '..', '..', 'config', 'bid-declarations.json');
const loadDeclarations = (file = DECLARATIONS_FILE) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { id: null, status: 'draft', sets: [] }; } };
// Формы заказчика в документации узнаются по имени файла: «форма», «образец», «заявка на участие», «анкета участника».
const FORM_NAME = /(^|[\s_\-.(№])(форм[аы]|образ[е]?ц[ыа]?)([\s_\-.)]|$)|заявк[аи] на участие|анкета участника/i;
const FORM_EXT = /\.(docx|doc|rtf|xlsx|xls|odt)$/i;

const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

function createBidService({ repo, source = null, clock = () => new Date(), log = console, rulesDir = undefined, dossier = null, dataDir = null, extract = null, declarationsFile = undefined }) {
  // чтение составленных файлов обратно — тем же способом, каким читаются документы заказчика
  const readBack = extract || ((f) => require('../extract').extractFile(f, 0, {}));
  const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
  /** Своя цена предложения, заданная на шаге «Расчёт» (число) или null. */
  const ownPrice = (tenderId) => { const v = Number(repo.getEconomics?.(tenderId)?.overrides?.price); return v > 0 ? Math.round(v * 100) / 100 : null; };
  const store = createBidStore(repo.db, () => clock().toISOString());
  // Характеристики для заявки (char-service): товарный знак, страна и значения «по ТЗ → в заявку» по каждой позиции.
  // Подключаются после создания сервиса (setCharSource): предложение о товаре составляется из тех же данных, что на экране.
  let charSource = null;
  const pack = () => activePack(loadRulePacks(rulesDir));

  /** Всё, от чего зависит заявка, — одним объектом (без сети). */
  function inputs(tender) {
    const analysis = tender.analysis_id ? repo.getAnalysis(tender.analysis_id) : null;
    const card = analysis?.status === 'done' ? analysis.card : null;
    const d = repo.getDetails(tender.id);
    const items = repo.getItems(tender.id);
    const files = analysis?.files || [];
    // выбранный товар позиции: одно предложение на всё количество (набор из нескольких продавцов — это разные товары)
    const allocations = repo.getAllocations ? repo.getAllocations(tender.id) : [];
    const chosen = new Map();
    for (const it of items) {
      const ids = [...new Set(allocations.filter((a) => a.item_id === it.id).map((a) => a.offer_id))];
      const offerId = ids.length === 1 ? ids[0] : !ids.length ? it.purchase_offer_id : null;
      const o = offerId ? repo.getOffer(offerId) : null;
      if (o) chosen.set(it.id, { offer: { id: o.id, seller: o.seller_name || o.domain || null, url: o.product_url || o.url || null, title: o.product_title || o.title || null, unit_price: o.unit_price ?? null }, rows: o.match_checks?.rows || [] });
    }
    return { analysis, card, details: d, items, files, chosen, coverage: { analysis: card?.meta?.coverage || null, spec: d?.spec_coverage || null } };
  }

  /** Отпечаток входных данных: по нему видно, что после проверки что-то изменилось. */
  function snapshotOf(tender, inp, p) {
    return sha({
      tender: [tender.law, tender.number, tender.price, tender.deadline_at, tender.platform],
      files: inp.files.map((f) => [f.original_name, f.sha256, f.status, f.coverage?.status ?? null]),
      coverage: [inp.coverage.analysis?.status ?? null, inp.coverage.spec?.status ?? null, inp.coverage.spec?.reconcile?.ok ?? null],
      items: inp.items.map((i) => [i.id, i.name, i.quantity, i.unit, (i.spec?.required || []).map((r) => [r.name, r.value])]),
      chosen: [...inp.chosen].map(([itemId, c]) => [itemId, c.offer.id, c.offer.unit_price, c.rows.map((r) => [r.name, r.verdict, r.found])]),
      // свои значения характеристик, знак и страна: изменились — составленные файлы устаревают
      chars: inp.items.map((i) => repo.getSetting?.(`bidchars:${i.id}`) || null),
      rules: p?.hash ?? null,
      // своя цена предложения: изменилась — её утверждение больше не действует (пока цены нет, отпечаток прежний)
      ...(ownPrice(tender.id) != null ? { own_price: ownPrice(tender.id) } : {}),
      // анкета участника и его документы: изменились — проверенная заявка устаревает (пока анкеты нет, отпечаток прежний)
      ...(dossier?.fingerprint() ? { dossier: dossier.fingerprint() } : {}),
    }).slice(0, 32);
  }

  // Извещение запрашивается у источника не при каждом действии: запросы к ЕИС идут по одному в минуту, и кнопки
  // «подтвердить», «собрать черновик» ждали бы эту очередь. Свежее извещение берётся по «Проверить заново».
  const notices = new Map();
  const NOTICE_TTL_MS = 30 * 60000;
  async function notificationOf(tender, { fresh = false } = {}) {
    if (!source?.getDetailsDoc || tender.source === 'manual') return null;
    const hit = notices.get(tender.id);
    // источник не ответил — несколько минут не переспрашиваем: иначе каждое действие ждало бы его заново
    if (!fresh && hit && clock().getTime() - hit.at < (hit.failed ? 5 * 60000 : NOTICE_TTL_MS)) return hit.doc;
    try { const doc = await source.getDetailsDoc(tender); notices.set(tender.id, { at: clock().getTime(), doc }); return doc; }
    catch (err) { log.warn?.(`[bids] извещение закупки ${tender.number} не получено: ${err.message}`); notices.set(tender.id, { at: clock().getTime(), doc: null, failed: true }); return null; }
  }

  /** Пересобрать дело: сценарий → правила → реестр → проверка → готовность. Сохраняется одной транзакцией. */
  async function rebuild(caseId, { notification = undefined, fresh = false } = {}) {
    const c = store.getCase(caseId);
    if (!c) throw Object.assign(new Error('Дело не найдено'), { status: 404 });
    const tender = repo.getTender(c.tender_id);
    const inp = inputs(tender);
    const p = pack();
    const note = notification === undefined ? await notificationOf(tender, { fresh }) : notification;
    const classification = classify({ tender, notification: note, card: inp.card });
    const rules = rulesFor(p, classification.scenario, store.ruleVerifications());
    const snapshot = snapshotOf(tender, inp, p);
    const reqs = buildRequirements({ tender, classification, rules, card: inp.card, files: inp.files, items: inp.items, coverage: inp.coverage, lotId: c.lot_id });
    const { requirements: checked, findings } = validate({
      requirements: reqs, classification, coverage: inp.coverage, tender, now: clock(), chosen: inp.chosen,
      attestations: store.attestations(caseId), decisions: store.decisions(caseId), snapshot,
    });
    // список «что приложить»: что закрыто анкетой и документами участника, переносится в решения реестра
    const lines = checklistOf(caseId, tender, classification, checked, inp);
    // цена: «выполнено» — только когда человек утвердил именно эту цену на этих данных
    const approval = store.priceApproval(caseId);
    const priceOk = Boolean(approval && approval.snapshot === snapshot && approval.price === ownPrice(tender.id));
    const requirements = applyChecklist(checked, lines).map((r) => (r.category === 'price' && r.stage === 'application' && r.applicability === 'applies' && r.decision !== 'pass' && priceOk
      ? { ...r, decision: 'pass', verification_state: 'manual_verified', candidate_value: approval.price, reason: `Цена ${approval.price} руб. утверждена: ${approval.by}, ${String(approval.at).slice(0, 10)}` } : r));
    // составленные файлы: повторная проверка засчитывается, только если пакет собран на этих же данных
    const built = store.latestVersion(caseId);
    const postcheckOk = Boolean(built && built.snapshot === snapshot && built.manifest?.postcheck_ok);
    const ready = readiness({
      classification, requirements, findings, coverage: inp.coverage,
      dossierChecked: dossierChecked(lines, dossier?.get() || null), postcheckOk,
      productsChecked: lines.some((l) => l.closure === 'product') && lines.filter((l) => l.closure === 'product').every((l) => l.state === 'ok'), attestations: store.attestations(caseId).filter((a) => a.snapshot === snapshot).map((a) => ({ ...a, valid: true })),
      // цена на этапе заявки нужна там, где её подают вместе с заявкой (котировки, вторые части)
      priceRequired: requirements.some((r) => r.category === 'price' && r.stage === 'application' && r.applicability === 'applies'),
      priceApproved: requirements.some((r) => r.category === 'price' && r.decision === 'pass'),
    });
    const sources = inp.files.map((f) => ({
      document_id: `file-${f.id}`, name: f.original_name, sha256: f.sha256,
      status: f.status !== 'ok' ? (f.coverage?.blocking === false ? 'not_applicable' : /^Не скачан/i.test(f.message || '') ? 'missing' : 'unreadable') : f.coverage?.status === 'complete' ? 'received' : 'partial',
    }));
    store.saveResult(caseId, { status: ready.status, scenario: classification, readiness: ready, snapshot, pack: p, requirements, findings, sources });
    return view(caseId);
  }

  /** Список «что приложить» — по реестру требований, анкете участника и его документам на сегодня. */
  function checklistOf(caseId, tender, classification, requirements, inp) {
    return buildChecklist({
      requirements, classification, dossier: dossier?.get() || null, deadline: tender.deadline_at || null, now: clock(),
      choices: store.choices(caseId), itemNames: new Map(inp.items.map((i) => [i.id, i.name])),
    });
  }

  /** Положения декларации для этой закупки и то, какие из них подтверждены на текущих данных. */
  function declarationOf(caseId, classification, snapshot) {
    const all = loadDeclarations(declarationsFile);
    const set = (all.sets || []).find((s) => s.law === classification?.law) || null;
    if (!set) return null;
    const kind = dossier?.get()?.kind || 'ip';
    const statements = set.statements.filter((s) => !s.only || s.only === kind);
    const att = store.attestations(caseId).filter((a) => a.snapshot === snapshot && Array.isArray(a.statements)).pop() || null;
    return { set: { ...set, statements, status: all.status || 'draft', pack: all.id }, confirmed: att ? att.statements.filter((id) => statements.some((s) => s.id === id)) : [], by: att?.by || null, at: att?.at || null, note: all.note || null };
  }

  /** Формы заказчика из документации и оригиналы участника, которые требует список «что приложить». */
  async function attachments(inp, lines) {
    const forms = [];
    const analysisFiles = inp.analysis ? repo.getFilesFull(inp.analysis.id) : [];
    for (const f of analysisFiles.filter((x) => FORM_NAME.test(String(x.name).split('/').pop()) && FORM_EXT.test(x.name) && x.path).slice(0, 5)) {
      try {
        const buffer = await require('../extract').readStoredFile(f.path, f.name);
        if (buffer?.length) forms.push({ name: f.name, buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
      } catch (err) { log.warn?.(`[bids] форма «${f.name}» не прочитана: ${err.message}`); }
    }
    const originals = [];
    const seen = new Set();
    for (const l of lines.filter((x) => x.closure === 'dossier_document' && x.state === 'ok' && x.document && !seen.has(x.document.id))) {
      seen.add(l.document.id);
      const file = dossier?.documentFile(l.document.id);
      if (file) originals.push({ line: l, document: { ...l.document, sha256: dossier.get().documents.find((d) => d.id === l.document.id)?.sha256 || null }, buffer: fs.readFileSync(file.path) });
    }
    return { forms, originals };
  }

  /** Собрать файлы заявки на текущих данных и прочитать каждый обратно. Ничего не сохраняет. */
  async function compose(caseId) {
    const c = store.getCase(caseId);
    const tender = repo.getTender(c.tender_id);
    const inp = inputs(tender);
    const requirements = store.requirements(caseId);
    const lines = checklistOf(caseId, tender, c.scenario, requirements, inp);
    const approval = store.priceApproval(caseId);
    const price = approval && approval.snapshot === c.snapshot && approval.price === ownPrice(tender.id) ? { value: approval.price, by: approval.by, at: approval.at } : null;
    const declaration = declarationOf(caseId, c.scenario, c.snapshot);
    const { forms, originals } = await attachments(inp, lines);
    const chars = charSource ? await charSource(tender.id).catch((err) => { log.warn?.(`[bids] характеристики для заявки: ${err.message}`); return null; }) : null;
    const pkg = buildPackage({ tender, classification: c.scenario, requirements, checklist: lines, items: inp.items, chosen: inp.chosen, dossier: dossier?.get() || null, price, declaration, forms, originals, chars,
      customer: { ...(repo.getDetails(tender.id)?.conditions?.customer || {}), inn: repo.getDetails(tender.id)?.conditions?.customer_inn || tender.customer_inn || null } });
    const checks = [];
    for (const f of pkg.files) checks.push({ id: f.id, path: f.path, ...(await verifyFile(f, readBack)) });
    return { c, tender, inp, pkg, checks, declaration, price };
  }

  /** Коротко о составленном пакете — для показа на шаге «Заявка». */
  function packageView(c, tender, stale) {
    const v = store.latestVersion(c.id);
    const own = ownPrice(tender.id);
    const approval = store.priceApproval(c.id);
    const declaration = c.snapshot ? declarationOf(c.id, c.scenario, c.snapshot) : null;
    return {
      built: v ? { version: v.version, at: v.created_at, current: !stale && v.snapshot === c.snapshot, postcheck_ok: Boolean(v.manifest?.postcheck_ok), files: v.manifest?.files || [], fields: v.manifest?.fields || [], actions: v.manifest?.actions || [], problems: v.manifest?.problems || [] } : null,
      price: { own, approved: approval && approval.snapshot === c.snapshot && approval.price === own ? { price: approval.price, by: approval.by, at: approval.at } : null },
      declaration: declaration ? { title: declaration.set.title, article: declaration.set.article, status: declaration.set.status, note: declaration.note, by: declaration.by, at: declaration.at,
        statements: declaration.set.statements.map((s) => ({ id: s.id, ref: s.ref, text: s.text, confirmed: declaration.confirmed.includes(s.id) })) } : null,
    };
  }

  /** Что мешает итоговой выгрузке — словами, для человека. */
  function finalBlockers(view, built) {
    const out = [];
    if (view.stale) out.push('Данные закупки изменились после проверки — нажмите «Проверить заново»');
    if (!['prepared_for_transfer', 'transfer_verified'].includes(view.status)) for (const x of (view.readiness?.conditions || []).filter((k) => !k.ok)) out.push(`Не выполнено условие готовности: ${x.text}`);
    if (!built) out.push('Файлы заявки ещё не составлены — нажмите «Собрать черновик»');
    else {
      if (!built.current) out.push('Файлы составлены на прежних данных — соберите черновик заново');
      for (const f of built.files) {
        if (f.todo) out.push(`В файле «${f.path.split('/').pop()}» остались незаполненные места: ${f.todo}`);
        if (f.check && !f.check.ok) for (const i of f.check.issues.filter((x) => x.kind !== 'placeholder')) out.push(`«${f.path.split('/').pop()}»: ${i.text}`);
        if (f.draft) out.push(`«${f.path.split('/').pop()}» — проект: ${f.reason || 'не оформлен'}`);
      }
      if ((built.fields || []).some((f) => !f.filled)) out.push(`Не заполнены значения для полей площадки: ${built.fields.filter((f) => !f.filled).length}`);
    }
    return [...new Set(out)];
  }

  /** Дело для показа. Если входные данные изменились после проверки — статус «устарело». */
  function view(caseId) {
    const c = store.getCase(caseId);
    if (!c) return null;
    const tender = repo.getTender(c.tender_id);
    const p = pack();
    const inp = inputs(tender);
    const current = c.snapshot ? snapshotOf(tender, inp, p) : null;
    const stale = Boolean(c.snapshot && current !== c.snapshot);
    const d = dossier?.get() || null;
    return {
      checklist: c.snapshot ? checklistOf(caseId, tender, c.scenario, store.requirements(caseId), inp) : [],
      // person — кто ставит отметки по умолчанию: подписант заявки из анкеты (представитель, руководитель или сам ИП)
      dossier: d ? { exists: true, kind: d.kind, name: d.name, complete: d.state.complete, missing: d.state.missing.map((m) => m.label),
        person: String(d.data?.signer_fio || d.data?.head_fio || d.data?.fio || '').trim() || null } : { exists: false },
      package: packageView(c, tender, stale),
      id: c.id, tender_id: c.tender_id, lot_id: c.lot_id, dossier_id: c.dossier_id, updated_at: c.updated_at,
      status: stale ? 'stale' : c.status, stale,
      scenario: c.scenario, readiness: c.readiness,
      requirements: store.requirements(caseId), findings: store.findings(caseId), sources: c.snapshot ? store.sources(caseId, c.snapshot) : [],
      // кто и когда поставил отметки (показываются рядом с галочкой)
      attestations: store.attestations(caseId).map(({ requirement_id, by, at }) => ({ requirement_id, by, at })),
      decisions: store.decisions(caseId).map(({ requirement_id, reviewer, at }) => ({ requirement_id, reviewer, at })),
      rules: { pack: c.rule_pack, current_pack: p?.id ?? null, note: p?.note ?? null, changed: Boolean(c.rule_pack_hash && p && c.rule_pack_hash !== p.hash) },
    };
  }

  return {
    store,
    /** Открыть дело по закупке (создать, если его нет) и собрать его. */
    async open(tenderId, { lotId = 'lot-1', dossierId = null, notification = undefined } = {}) {
      const tender = repo.getTender(tenderId);
      if (!tender) throw Object.assign(new Error('Закупка не найдена'), { status: 404 });
      const existing = store.findCase(tenderId, lotId, dossierId);
      const id = existing ? existing.id : store.createCase(tenderId, lotId, dossierId);
      return { created: !existing, view: await rebuild(id, { notification, fresh: true }) };
    },
    rebuild, view,
    /** Положения декларации этой закупки (id) — для автоматического подтверждения агентом пакета. */
    declarationIds(caseId) { const c = store.getCase(caseId); return c ? (declarationOf(caseId, c.scenario, c.snapshot)?.set?.statements || []).map((s) => s.id) : []; },
    /** Требуется ли цена в заявке и утверждена ли она. */
    priceState(caseId) { const c = store.getCase(caseId); if (!c) return null; const req = store.requirements(caseId).some((r) => r.category === 'price' && r.stage === 'application' && r.applicability === 'applies'); return { required: req, approved: Boolean(store.priceApproval(caseId)), own: ownPrice(c.tender_id), tender_id: c.tender_id }; },
    /** Что мешает итоговой выгрузке — для агента итогового пакета. */
    blockers(caseId) { const v = view(caseId); return v ? finalBlockers(v, v.package.built) : []; },
    forTender: (tenderId) => { const c = store.findCase(tenderId); return c ? view(c.id) : null; },
    /** Коротко о заявке по закупке — для списков (корзина): {id, status} или null, если заявку ещё не собирали. */
    statusFor: (tenderId) => { const c = store.findCase(tenderId); return c ? { id: c.id, status: c.status } : null; },

    /** Подтверждение положения (декларации) ответственным человеком — на текущих данных. */
    async attest(caseId, requirementId, { by, note = null, revoke = false, statements = null }) {
      const c = store.getCase(caseId);
      if (!c) throw Object.assign(new Error('Дело не найдено'), { status: 404 });
      const r = store.requirements(caseId).find((x) => x.id === requirementId);
      if (!r) throw Object.assign(new Error('Такого требования в деле нет'), { status: 404 });
      if (r.evidence_kind !== 'attestation') throw Object.assign(new Error('Это требование подтверждается не заявлением, а документом или проверкой'), { status: 409 });
      if (revoke) store.revokeAttestation(caseId, requirementId);
      else {
        if (!String(by || '').trim()) throw Object.assign(new Error('Укажите, кто подтверждает'), { status: 400 });
        const fresh = view(caseId);
        if (fresh.stale) throw Object.assign(new Error('Данные закупки изменились после проверки — сначала нажмите «Проверить заново»'), { status: 409 });
        // положения декларации подтверждаются по одному: принимаются только те, что есть в наборе для этой закупки
        const known = declarationOf(caseId, c.scenario, c.snapshot)?.set?.statements.map((s) => s.id) || [];
        const picked = Array.isArray(statements) ? [...new Set(statements.map(String))].filter((id) => known.includes(id)) : null;
        if (picked && known.length && picked.length < known.length) throw Object.assign(new Error(`Подтвердите каждое положение декларации: отмечено ${picked.length} из ${known.length}`), { status: 400 });
        store.attest(caseId, requirementId, { snapshot: c.snapshot, by: String(by).trim().slice(0, 120), note, statements: picked });
      }
      return rebuild(caseId);
    },

    /**
     * Решение проверяющего по вопросу толкования или применимости — с основанием и подписью.
     * Фактическое несоответствие (у товара другое значение) так не снимается.
     */
    async decide(caseId, requirementId, { decision, basis, reviewer, role = null, revoke = false }) {
      const c = store.getCase(caseId);
      if (!c) throw Object.assign(new Error('Дело не найдено'), { status: 404 });
      const r = store.requirements(caseId).find((x) => x.id === requirementId);
      if (!r) throw Object.assign(new Error('Такого требования в деле нет'), { status: 404 });
      if (revoke) { store.revokeDecision(caseId, requirementId); return rebuild(caseId); }
      if (!['pass', 'not_applicable'].includes(decision)) throw Object.assign(new Error('Решение: «выполнено» или «не применяется»'), { status: 400 });
      if (String(basis || '').trim().length < 10 || !String(reviewer || '').trim()) throw Object.assign(new Error('Нужны основание решения (не короче 10 символов) и имя проверяющего'), { status: 400 });
      if (r.evidence_kind === 'attestation') throw Object.assign(new Error('Декларация подтверждается отдельно — кнопкой «Подтвердить декларацию»'), { status: 409 });
      if (r.decision === 'fail') throw Object.assign(new Error('Это фактическое несоответствие: у выбранного товара другое значение. Решением проверяющего оно не снимается — выберите подходящий товар или получите разъяснение заказчика'), { status: 409 });
      if (view(caseId).stale) throw Object.assign(new Error('Данные закупки изменились после проверки — сначала нажмите «Проверить заново»'), { status: 409 });
      store.decide(caseId, requirementId, { snapshot: c.snapshot, decision, basis: String(basis).trim().slice(0, 1000), reviewer: String(reviewer).trim().slice(0, 120), role });
      return rebuild(caseId);
    },

    /**
     * Утвердить цену предложения. Берётся «своя цена», заданная на шаге «Расчёт»; расчётная рекомендуемая цена
     * сама в заявку не попадает. Утверждение действует для этой цены и этих данных.
     */
    /** Подключить характеристики для заявки: fn(tenderId) → вид char-service (tables с rows, trademark, country). */
    setCharSource(fn) { charSource = typeof fn === 'function' ? fn : null; },

    async approvePrice(caseId, { by, revoke = false } = {}) {
      const c = store.getCase(caseId);
      if (!c) throw fail(404, 'Дело не найдено');
      if (revoke) { store.revokePrice(caseId); return rebuild(caseId); }
      const price = ownPrice(c.tender_id);
      if (price == null) throw fail(409, 'Своя цена предложения не задана. Задайте её на шаге «Расчёт» — сервис не подставляет в заявку рассчитанную рекомендуемую цену');
      if (!String(by || '').trim()) throw fail(400, 'Укажите, кто утверждает цену');
      const fresh = await rebuild(caseId);
      if (fresh.stale) throw fail(409, 'Данные закупки изменились — сначала нажмите «Проверить заново»');
      store.approvePrice(caseId, { price, snapshot: store.getCase(caseId).snapshot, by: String(by).trim().slice(0, 120) });
      return rebuild(caseId);
    },

    /**
     * «Собрать черновик»: составить файлы заявки на текущих данных, прочитать каждый обратно и сохранить версию.
     * Файлы лежат в DATA_DIR/bids/case-<id>/v<N>/ и скачиваются по одному или архивом.
     */
    async draft(caseId) {
      if (!store.getCase(caseId)) throw fail(404, 'Дело не найдено');
      const before = await rebuild(caseId);
      if (before.status === 'unsupported') throw fail(409, 'Для этого вида закупки подготовка заявки не поддерживается');
      const { c, pkg, checks } = await compose(caseId);
      const generated = pkg.files.filter((f) => f.kind === 'generated');
      // нет предложения о товаре (у закупки нет позиций) — пакет неполон, даже если остальные файлы в порядке
      const postcheckOk = generated.some((f) => f.id === 'product-proposal') && checks.every((k) => k.ok) && !pkg.files.some((f) => f.todo || f.draft) && !pkg.fields.some((f) => !f.filled);
      const dir = (version) => path.join(dataDir || path.join(require('node:os').tmpdir(), 'tender-ai-bids'), 'bids', `case-${caseId}`, `v${version}`);
      store.saveVersion(caseId, {
        snapshot: c.snapshot, status: postcheckOk ? 'checked' : 'draft',
        manifest: {
          postcheck_ok: postcheckOk,
          files: pkg.files.map((f) => ({ id: f.id, path: f.path, part: f.part, purpose: f.purpose, kind: f.kind, draft: Boolean(f.draft), reason: f.reason || null, todo: f.todo || 0, unconfirmed: f.unconfirmed || 0, sha256: f.sha256, bytes: f.bytes, check: checks.find((k) => k.id === f.id) })),
          fields: pkg.fields, actions: pkg.actions, problems: pkg.problems,
        },
        artifacts: (version) => pkg.files.map((f) => {
          const target = path.join(dir(version), f.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, f.buffer);
          return { name: f.id, part: f.part, purpose: f.purpose, path: target, sha256: f.sha256 };
        }),
      });
      return rebuild(caseId);
    },

    /** Один составленный файл последней версии: {path, name} или null. */
    packageFile(caseId, fileId) {
      const v = store.latestVersion(caseId);
      const a = v ? store.artifacts(caseId, v.version).find((x) => x.name === fileId) : null;
      return a && fs.existsSync(a.path) ? { path: a.path, name: path.basename(a.path) } : null;
    },

    /**
     * Архив для переноса. Черновик выгружается всегда и помечен «ЧЕРНОВИК»; итоговый — только когда выполнены
     * условия готовности, файлы составлены на текущих данных, прочитаны обратно и в них нет незаполненных мест.
     * @returns {{buffer, name, manifest}}
     */
    async exportZip(caseId, { final = false } = {}) {
      if (!store.getCase(caseId)) throw fail(404, 'Дело не найдено');
      let v = view(caseId);
      if (v.status === 'unsupported') throw fail(409, 'Для этого вида закупки подготовка заявки не поддерживается');
      if (!v.package.built || !v.package.built.current) v = await this.draft(caseId);
      const blockers = finalBlockers(v, v.package.built);
      if (final && blockers.length) throw fail(409, `Выгрузить для переноса пока нельзя: ${blockers.length} причин. Доступна выгрузка черновика.`, { blockers });
      const { c, tender, inp, pkg, checks, declaration, price } = await compose(caseId);
      const d = dossier?.get() || null;
      const p = pack();
      return buildZip({
        tender, caseView: v, classification: c.scenario, pkg, draft: !final, version: v.package.built.version, snapshot: c.snapshot, now: clock(), blockers,
        hashes: { dossier: dossier?.fingerprint() || null, rule_pack: p?.hash || null, declarations: declaration?.set?.pack || null },
        checks,
        approvals: { price: price ? { price: price.value, by: price.by, at: price.at } : null, declaration: declaration?.by ? { by: declaration.by, at: declaration.at, statements: declaration.confirmed } : null },
        internal: {
          coverage: inp.coverage,
          registry: d ? { participant: d.name, eruz_number: d.data.eruz_number || null, eruz_valid_until: d.data.eruz_valid_until || null, eruz_checked_at: d.data.eruz_checked_at || null, note: 'Сведения внесены участником; по реестру сервис их не проверял' } : {},
          decisions: { decisions: store.decisions(caseId), attestations: store.attestations(caseId), checklist_choices: store.choices(caseId), price: store.priceApproval(caseId) },
          risks: [...inp.chosen].map(([itemId, x]) => { const it = inp.items.find((i) => i.id === itemId); return `Позиция ${it ? `${(it.idx ?? 0) + 1} (${it.name})` : itemId}: товар «${x.offer.title || 'без названия'}» у продавца ${x.offer.seller || 'не указан'} — перед подачей подтвердите у продавца наличие всей партии, срок и цену`; }),
        },
      });
    },

    /**
     * Решение человека по строке списка «что приложить»: взять другой документ из хранилища или отметить
     * «не требуется» с причиной. Исходный вывод сервиса сохраняется (auto_state) и виден рядом.
     */
    async choose(caseId, lineId, { document_id = null, not_required = false, reason = null, by = null, revoke = false } = {}) {
      const c = store.getCase(caseId);
      if (!c) throw Object.assign(new Error('Дело не найдено'), { status: 404 });
      const line = (view(caseId).checklist || []).find((l) => l.id === lineId);
      if (!line) throw Object.assign(new Error('Такой строки в списке нет'), { status: 404 });
      if (revoke) { store.revokeChoice(caseId, lineId); return rebuild(caseId); }
      if (not_required) {
        if (String(reason || '').trim().length < 10 || !String(by || '').trim()) throw Object.assign(new Error('Нужны причина (не короче 10 символов) и имя того, кто решил'), { status: 400 });
        store.choose(caseId, lineId, { notRequired: true, reason: String(reason).trim().slice(0, 500), by: String(by).trim().slice(0, 120) });
      } else {
        if (line.closure !== 'dossier_document') throw Object.assign(new Error('Документ выбирается только для строк, которые закрываются документом участника'), { status: 409 });
        if (!line.candidates.some((d) => d.id === Number(document_id))) throw Object.assign(new Error('Такого документа подходящего вида в хранилище нет'), { status: 400 });
        store.choose(caseId, lineId, { documentId: Number(document_id), by: String(by || '').trim().slice(0, 120) || null });
      }
      return rebuild(caseId);
    },

    /** Набор правил с действующими статусами — для показа и подтверждения. */
    rules() {
      const p = pack();
      if (!p) return null;
      const scenarios = [...new Set(p.rules.flatMap((r) => r.scenarios))];
      const all = new Map();
      for (const s of scenarios) for (const r of rulesFor(p, s, store.ruleVerifications())) all.set(r.id, r);
      return { id: p.id, title: p.title, note: p.note, hash: p.hash, checked_at: p.checked_at, rules: [...all.values()] };
    },
    /** Человек сверил правило с действующей редакцией: кто и когда. Действует для этого отпечатка набора правил. */
    verifyRule(ruleId, { by, note = null, revoke = false }) {
      const p = pack();
      if (!p?.rules.some((r) => r.id === ruleId)) throw Object.assign(new Error('Такого правила в действующем наборе нет'), { status: 404 });
      if (revoke) store.unverifyRule(ruleId, p.hash);
      else {
        if (!String(by || '').trim()) throw Object.assign(new Error('Укажите, кто проверил правило'), { status: 400 });
        store.verifyRule({ ruleId, packId: p.id, packHash: p.hash, by: String(by).trim().slice(0, 120), note });
      }
      return this.rules();
    },
  };
}

module.exports = { createBidService };
