// Подготовка заявки (этап 2), основа: сценарий закупки, правила состава, реестр требований, проверка и готовность.
// Данные в тестах — вымышленные (кроме сохранённых примеров извещений в samples/tenders). Номера в скобках —
// сценарии приёмки из задания (раздел 13); покрыты те, что относятся к уже сделанной части модуля.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { createLlm } = require('../server/llm');
const { classify, readMethod } = require('../server/bids/classify');
const { loadRulePacks, activePack, rulesFor } = require('../server/bids/rules');
const { buildRequirements } = require('../server/bids/requirements');
const { validate } = require('../server/bids/validate');
const { readiness, counters } = require('../server/bids/readiness');
const { fileCoverage } = require('../server/analyze/coverage');
const { makeDocx } = require('../samples/make-samples');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const notice = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const cardOf = (fields) => ({ groups: [{ key: 'g', title: 'g', fields: Object.entries(fields).map(([key, v]) => (typeof v === 'object' ? { key, label: key, status: 'found', sources: [], ...v } : { key, label: key, status: 'found', value: v, sources: [] })) }] });
const COMPLETE = { analysis: { status: 'complete', blocking: [] }, spec: { status: 'complete', reconcile: { ok: true, items: 1, tz: 1, matched: 1, unmatched_items: [], unmatched_tz: [], quantity_conflicts: [] } } };
const PACK = activePack(loadRulePacks());
const tender44 = { id: 1, law: '44', number: '0132600015226000103', title: 'Поставка коммутаторов', platform: 'Фабрикант', deadline_at: '2026-12-01T09:00:00.000Z' };

test('сценарий закупки: способ и закон — по признакам источников; неизвестное не превращается в «нет» (2, 4, 35)', () => {
  // 44-ФЗ, извещение из ЕИС: электронный аукцион
  const a = classify({ tender: tender44, notification: notice('fz44-notification-0132600015226000103.json') });
  assert.deepEqual([a.scenario, a.supported, a.procedure, a.electronic, a.competitive], ['44_eauction', true, 'auction', true, true]);
  // закупка по ч. 12 ст. 93 («электронный магазин») — не конкурентная заявка
  const small = classify({ tender: { ...tender44, number: '0332200035226000280' }, notification: notice('fz44-notification-0332200035226000280.json') });
  assert.deepEqual([small.scenario, small.supported, small.procedure, small.competitive], [null, false, 'small_purchase', false]);
  assert.match(small.reasons[0], /малая закупка|электронный магазин/);
  // 223-ФЗ только для МСП и 223-ФЗ у единственного поставщика — разные ветки
  const sme = classify({ tender: { law: '223', number: '32616386849', title: 'Поставка' }, notification: notice('fz223-purchase-32616386849.json') });
  assert.deepEqual([sme.scenario, sme.sme, sme.procedure], ['223_sme_equotation', true, 'quotation']);
  const single = classify({ tender: { law: '223', number: '32616386083', title: 'Поставка' }, notification: notice('fz223-purchase-32616386083.json') });
  assert.deepEqual([single.scenario, single.supported, single.procedure], [null, false, 'single_supplier']);
  // закупочная сессия ЕАТ: название источника закон не определяет, конкурентный состав не применяется
  const eat = classify({ tender: { law: 'com', number: 'EAT-100200300', title: 'Поставка картриджей', platform: 'ЕАТ «Берёзка»', source: 'manual' }, card: cardOf({ law: '44-ФЗ', procurement_method: 'Электронный аукцион' }) });
  assert.deepEqual([eat.scenario, eat.supported], [null, false]);
  assert.match(eat.reasons[0], /ЕАТ/);

  // только разбор документации: способ есть, а «только для МСП» никто не назвал — признак остаётся неизвестным
  const unknownSme = classify({ tender: { law: '223', number: '1', title: 'Поставка' }, card: cardOf({ procurement_method: 'Запрос предложений в электронной форме' }) });
  assert.deepEqual([unknownSme.scenario, unknownSme.sme, unknownSme.unknown], [null, 'unknown', ['sme']]);
  // форма не названа — электронная ли процедура, неизвестно
  assert.deepEqual(classify({ tender: { law: '44', number: '1', title: 'Поставка' }, card: cardOf({ procurement_method: 'аукцион' }) }).unknown, ['electronic']);
  // источники расходятся: большинством не решается
  const conflict = classify({ tender: tender44, notification: notice('fz44-notification-0132600015226000103.json'), card: cardOf({ procurement_method: 'Запрос котировок в электронной форме', law: '223-ФЗ' }) });
  assert.equal(conflict.scenario, null);
  assert.deepEqual(conflict.conflicts.map((c) => c.kind).sort(), ['law', 'procedure']);
  // конкурс по 44-ФЗ: вариант структуры (ч. 2 или ч. 19 ст. 48) заранее не выбран (3)
  const comp = classify({ tender: { law: '44', number: '2', title: 'Открытый конкурс в электронной форме на поставку мебели' } });
  assert.deepEqual([comp.scenario, comp.variant], ['44_ecompetition', 'unknown']);
  assert.equal(readMethod('Конкурентный отбор').procedure, 'other');
  assert.equal(readMethod('Закрытый аукцион в электронной форме').closed, true);
});

test('правила состава — версионированный черновик: разные способы — разное место цены; подтверждает человек (2, 38)', () => {
  assert.ok(PACK && PACK.rules.length >= 15);
  assert.ok(PACK.rules.every((r) => r.status === 'draft'), 'ни одно правило не объявлено проверенным заранее');
  const auction = rulesFor(PACK, '44_eauction');
  const quotation = rulesFor(PACK, '44_equotation');
  // аукцион: цена — на торгах, не в заявке; котировки: цена — в составе заявки
  assert.deepEqual(auction.filter((r) => r.category === 'price').map((r) => [r.stage, r.channel]), [['auction', 'action']]);
  assert.deepEqual(quotation.filter((r) => r.category === 'price').map((r) => [r.stage, r.channel]), [['application', 'etp_field']]);
  // сведения об участнике в электронной процедуре 44-ФЗ передаёт оператор — это не файл для загрузки (1)
  const op = auction.find((r) => r.id === '44-43-participant-operator');
  assert.deepEqual([op.channel, op.stage, op.evidence], ['operator_supplied', 'registration', 'registry_check']);
  // обеспечение исполнения контракта — этап заключения контракта, не заявки (22)
  assert.equal(auction.find((r) => r.id === '44-96-contract-security').stage, 'contract_conclusion');
  // 223-ФЗ среди МСП и прочие 223-ФЗ — разные наборы (4)
  assert.ok(rulesFor(PACK, '223_sme_equotation').some((r) => r.id === '223-3.4-sme-quotation'));
  assert.deepEqual(rulesFor(PACK, '223_other_competitive').map((r) => r.id).sort(), ['223-2-customer-regulation', '223-origin']);
  assert.ok(auction.every((r) => r.url && r.act && r.pack_hash === PACK.hash), 'у каждого правила — акт, ссылка и отпечаток набора');

  // подтверждение действует только для того набора, который человек проверял: изменился файл правил — снова черновик
  const v = [{ rule_id: '44-49-auction-price', pack_hash: PACK.hash, status: 'verified', verified_by: 'Юрист', verified_at: '2026-10-11' }];
  assert.equal(rulesFor(PACK, '44_eauction', v).find((r) => r.id === '44-49-auction-price').status, 'verified');
  assert.equal(rulesFor({ ...PACK, hash: 'другая-редакция' }, '44_eauction', v).find((r) => r.id === '44-49-auction-price').status, 'draft');
  assert.deepEqual(rulesFor(PACK, null), [], 'нет сценария — нет универсального шаблона');
});

/** Реестр и проверка для вымышленной закупки коммутаторов по 44-ФЗ. */
function caseOf({ card = cardOf({}), coverage = COMPLETE, rows = null, verifications = [], attestations = [], decisions = [], tender = tender44, scenario = '44_eauction', snapshot = 's1', now = new Date('2026-10-11T09:00:00Z'), required } = {}) {
  const classification = { scenario, supported: true, unknown: [], conflicts: [], reasons: [], variant: null };
  const files = [{ id: 7, original_name: 'ТЗ.docx', sha256: 'aaa' }, { id: 8, original_name: 'Проект контракта.docx', sha256: 'bbb' }];
  const items = [{ id: 202, name: 'Коммутатор', quantity: 4, spec: { required: required || [{ name: 'Число портов', value: 'не менее 24', comparator: '>=', unit: null, source: { file: 'ТЗ.docx', page: 3, quote: 'Число портов не менее 24', verified: true } }] } }];
  const built = buildRequirements({ tender, classification, rules: rulesFor(PACK, scenario, verifications), card, files, items, coverage });
  const chosen = new Map(rows ? [[202, { offer: { id: 55, seller: 'ООО «Сеть»', url: 'https://example.test/sw16' }, rows }]] : []);
  const r = validate({ requirements: built, classification, coverage, tender, now, chosen, attestations, decisions, snapshot });
  return { ...r, classification, ready: readiness({ classification, requirements: r.requirements, findings: r.findings, coverage, attestations: attestations.filter((a) => a.snapshot === snapshot).map((a) => ({ ...a, valid: true })) }) };
}
const byId = (list, id) => list.find((x) => x.id === id);

test('реестр требований: у каждой записи — основание, этап, канал и источник; условное требование не выдумывается (1, 8, 13)', () => {
  const c = caseOf({ card: cardOf({ bid_security: { value: '1 % от НМЦК', sources: [{ file: 'Проект контракта.docx', fileId: 8, page: 2, quote: 'Размер обеспечения заявки: 1 %', verified: true }] }, national_regime: 'не применяется' }) });
  const op = byId(c.requirements, 'req-44-43-participant-operator');
  assert.deepEqual([op.origin, op.channel, op.stage, op.legal_rule_ids, op.decision], ['rule', 'operator_supplied', 'registration', ['44-43-participant-operator'], 'unknown']);
  assert.match(op.required_action, /актуальны/);
  // обеспечение заявки: применяется, источник — конкретный документ, его версия и страница
  const sec = byId(c.requirements, 'req-44-44-bid-security');
  assert.equal(sec.applicability, 'applies');
  assert.deepEqual(sec.sources[0], { document_id: 'file-8', file: 'Проект контракта.docx', sha256: 'bbb', locator: { page: 2 }, quote: 'Размер обеспечения заявки: 1 %', verification: 'exact' });
  // нацрежим по документации не применяется — запись остаётся в реестре с причиной, решать по ней нечего
  const origin = byId(c.requirements, 'req-44-43-origin-item-202');
  assert.deepEqual([origin.applicability, origin.decision], ['not_applicable', 'not_applicable']);
  assert.match(origin.reason, /не применяется/);
  // обеспечение исполнения не найдено, документация прочитана полностью — не применяется (с этой причиной)
  assert.match(byId(c.requirements, 'req-44-96-contract-security').reason, /прочитана полностью/);
  // техническое требование: нормализовано, связано с позицией и источником
  const tech = byId(c.requirements, 'req-item-202-1');
  assert.deepEqual([tech.category, tech.scope.item_id, tech.normalized, tech.verification_state, tech.stage, tech.channel],
    ['technical', 202, { field: 'Число портов', operator: '>=', value: 'не менее 24', unit: null }, 'source_verified', 'application', 'etp_field']);
  assert.equal(tech.sources[0].sha256, 'aaa');

  // документация прочитана не полностью: «не найдено» — это «неизвестно», а не «требований нет» (13)
  const partial = caseOf({ coverage: { analysis: { status: 'partial', blocking: [{ kind: 'chunk_failed', text: 'Нейросеть не разобрала фрагмент («Проект контракта.docx», стр. 5)', action: 'retry' }] }, spec: COMPLETE.spec } });
  assert.deepEqual([byId(partial.requirements, 'req-44-44-bid-security').applicability, byId(partial.requirements, 'req-44-44-bid-security').decision], ['unknown', 'unknown']);
  assert.ok(partial.findings.some((f) => f.type === 'unreadable_source' && /не разобрала фрагмент/.test(f.text)));
  assert.equal(partial.ready.status, 'needs_input');
  assert.equal(partial.ready.counters.applicability_unknown >= 2, true);
});

test('товар не соответствует ТЗ: блок без возможности «игнорировать»; совпадение на странице продавца — ещё не доказательство (14, 36)', () => {
  // у выбранного коммутатора 16 портов при требовании не менее 24
  const bad = caseOf({ rows: [{ name: 'Число портов', need: 'не менее 24', verdict: 'no', found: '16' }] });
  const tech = byId(bad.requirements, 'req-item-202-1');
  assert.deepEqual([tech.decision, tech.candidate_value], ['fail', '16']);
  const f = bad.findings.find((x) => x.type === 'product_mismatch');
  assert.deepEqual([f.id, f.severity, f.requirement_id, f.action_kind], ['TECH-001', 'critical', 'req-item-202-1', 'fix_bid']);
  assert.deepEqual(f.values, [{ value: 'не менее 24', where: 'ТЗ.docx, стр. 3' }, { value: '16', where: 'https://example.test/sw16' }], 'обе стороны несоответствия — со своими источниками');
  assert.match(f.text, /Подтверждать значение из ТЗ нельзя/);
  assert.equal(bad.ready.status, 'blocked');
  assert.ok(bad.ready.blockers.some((b) => b.kind === 'product_mismatch'));
  // решение проверяющего «выполнено» фактическое несоответствие не снимает
  const forced = caseOf({ rows: [{ name: 'Число портов', need: 'не менее 24', verdict: 'no', found: '16' }], decisions: [{ requirement_id: 'req-item-202-1', decision: 'pass', basis: 'считаю, что подходит', reviewer: 'Иванов', snapshot: 's1', at: '2026-10-11' }] });
  assert.equal(byId(forced.requirements, 'req-item-202-1').decision, 'fail');
  assert.equal(forced.ready.status, 'blocked');

  // «24» на странице продавца: кандидат есть, но это не документ изготовителя — решение «неизвестно»
  const ok = caseOf({ rows: [{ name: 'Число портов', need: 'не менее 24', verdict: 'yes', found: '24' }] });
  const t2 = byId(ok.requirements, 'req-item-202-1');
  assert.deepEqual([t2.decision, t2.candidate_value, t2.evidence_ids], ['unknown', '24', ['offer-55']]);
  assert.match(t2.reason, /документом изготовителя не подтверждено/);
  // товар не выбран — не «соответствует»
  assert.match(byId(caseOf().requirements, 'req-item-202-1').reason, /не выбран/);
});

test('декларация, цитата из другого документа, истёкший срок, счётчики (7, 12, 20, 27, 31)', () => {
  // декларация: текст правила — не подтверждение; нужен человек, и только на текущих данных
  const none = caseOf();
  assert.match(byId(none.requirements, 'req-44-43-declaration').reason, /requires_attestation/);
  const att = [{ requirement_id: 'req-44-43-declaration', snapshot: 's1', by: 'Директор Петров', at: '2026-10-11T09:00:00Z' }];
  const yes = caseOf({ attestations: att });
  assert.deepEqual([byId(yes.requirements, 'req-44-43-declaration').decision, byId(yes.requirements, 'req-44-43-declaration').verification_state], ['pass', 'manual_verified']);
  // данные изменились после подтверждения (другой снимок) — подтверждение не действует (31)
  assert.equal(byId(caseOf({ attestations: att, snapshot: 's2' }).requirements, 'req-44-43-declaration').decision, 'unknown');

  // цитата названа в ТЗ, а найдена только в проекте контракта — источник не подтверждён, отдельная находка (12)
  const mis = caseOf({ required: [{ name: 'Гарантия', value: 'не менее 36 месяцев', comparator: '>=', source: { file: 'ТЗ.docx', page: 1, quote: 'Гарантия не менее 36 месяцев', verified: false, mismatch: 'other_file', suggested: { file: 'Проект контракта.docx', page: 9 } } }] });
  const req = byId(mis.requirements, 'req-item-202-1');
  assert.deepEqual([req.verification_state, req.sources[0].verification], ['unverified', 'source_mismatch']);
  const sm = mis.findings.find((x) => x.type === 'source_mismatch');
  assert.deepEqual(sm.values.map((v) => v.where), ['названо: ТЗ.docx, стр. 1', 'найдено: Проект контракта.docx, стр. 9']);
  assert.equal(mis.ready.conditions.find((x) => x.key === 'conflicts').ok, false);

  // срок подачи истёк — на дату проверки, а не «когда-то» (27)
  const late = caseOf({ now: new Date('2026-12-02T00:00:00Z') });
  assert.ok(late.findings.some((f) => f.type === 'expired' && f.severity === 'critical'));
  assert.equal(late.ready.status, 'blocked');

  // балльный документ не компенсирует обязательный и сам допуск не блокирует (7)
  const comp = caseOf({ scenario: '44_ecompetition' });
  const ev = byId(comp.requirements, 'req-44-48-evaluation-docs');
  assert.equal(ev.obligation, 'evaluation_only');
  const c = counters(comp.requirements);
  assert.equal(c.evaluation, 1);
  assert.ok(c.mandatory > 0 && c.mandatory_pass === 0, 'обязательные считаются отдельно от балльных');
  assert.ok(!comp.ready.blockers.some((b) => /оценк/.test(b.text || '')));
});

test('готовность: черновые правила не дают «готово»; 223-ФЗ без положения заказчика; неподдержанный сценарий (5, 35, 38)', () => {
  // всё подтверждено человеком, но правила — черновик: статус «готово к переносу» невозможен
  const draft = caseOf();
  assert.ok(draft.findings.some((f) => f.id === 'LEGAL-rules-draft'));
  assert.equal(draft.ready.conditions.find((x) => x.key === 'scenario').ok, false);
  assert.notEqual(draft.ready.status, 'prepared_for_transfer');
  assert.equal(draft.ready.status, 'needs_review');
  assert.deepEqual(Object.keys(draft.ready.axes), ['document_readiness', 'platform_actions_readiness', 'supplier_fulfillment_readiness']);

  // движок готовности: все девять условий — и только тогда «подготовлено к переносу»; это не «подано»
  const pass = (o) => ({ id: o.id, applicability: 'applies', obligation: 'mandatory', stage: 'application', channel: 'upload', origin: 'rule', rule_status: 'verified', legal_rule_ids: [o.id], sources: [], decision: 'pass', verification_state: 'manual_verified', ...o });
  const reqs = [pass({ id: 'a' }), pass({ id: 'b', stage: 'registration', channel: 'operator_supplied' }), pass({ id: 'c', evidence_kind: 'attestation', channel: 'action' }), { ...pass({ id: 'd' }), obligation: 'evaluation_only', decision: 'unknown' }];
  const full = { classification: { supported: true, unknown: [], conflicts: [], variant: null }, requirements: reqs, findings: [], coverage: COMPLETE, attestations: [{ requirement_id: 'c', valid: true }],
    dossierChecked: true, productsChecked: true, postcheckOk: true, adapterVerified: true, snapshotConfirmed: true };
  assert.equal(readiness(full).status, 'prepared_for_transfer');
  assert.equal(readiness({ ...full, transferVerified: true }).status, 'transfer_verified');
  assert.equal(readiness({ ...full, stale: true }).status, 'stale');
  // по одному условию: любое невыполненное — готовности нет
  for (const [key, patch] of [['checks', { dossierChecked: false }], ['postcheck', { postcheckOk: false }], ['adapter', { adapterVerified: false }], ['attestations', { attestations: [] }], ['price', { priceRequired: true, priceApproved: false }]]) {
    const r = readiness({ ...full, ...patch });
    assert.notEqual(r.status, 'prepared_for_transfer', key);
    assert.equal(r.conditions.find((x) => x.key === key).ok, false, key);
  }
  assert.notEqual(readiness({ ...full, requirements: [...reqs, { ...pass({ id: 'e' }), decision: 'unknown' }] }).status, 'prepared_for_transfer', 'одно неизвестное обязательное требование — не готово');

  // 223-ФЗ вне МСП: без положения о закупке заказчика перечень неполон — нужен источник (5)
  const other = caseOf({ scenario: '223_other_competitive', tender: { ...tender44, law: '223' } });
  assert.ok(other.findings.some((f) => f.type === 'missing_document' && /положение о закупке/.test(f.text)));
  assert.equal(other.ready.status, 'needs_input');
  assert.ok(!other.requirements.some((r) => r.legal_rule_ids.includes('44-43-participant-operator')), 'перечень 44-ФЗ на 223-ФЗ не переносится');

  // сценарий не поддержан — явный статус, а не маскировка под обычную конкурентную заявку (35)
  const eat = classify({ tender: { law: 'com', number: 'EAT-1', title: 'Поставка', platform: 'ЕАТ «Берёзка»' } });
  assert.equal(readiness({ classification: eat, requirements: [], findings: [] }).status, 'unsupported');
});

test('дело по закупке через сервис: сценарий из извещения, реестр, декларация, правила, устаревание', async () => {
  const mock = createLlm('mock');
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-bids-')), PORT: 0, LLM_PROVIDER: 'mock', TENDER_SOURCE: 'fixture', FIXTURES_DIR: FIX, TELEGRAM_BOT_TOKEN: '', SUPPLIER_INDEX: false,
    OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '', ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
  };
  const s = startServer(config, { scheduler: false, llmFactory: () => mock, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: FIX }) });
  const api = async (p, opts = {}) => { const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, { ...opts, headers: opts.json ? { 'Content-Type': 'application/json' } : opts.headers, body: opts.json ? JSON.stringify(opts.json) : opts.body }); return { status: res.status, body: await res.json().catch(() => null) }; };
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0132600015226000103'").get().id;
    assert.deepEqual((await api(`/api/tenders/${id}/bids`)).body, { none: true }, 'дела ещё нет');
    // документация закупки: разбор с отчётом о полноте (вымышленный текст)
    const aId = 'a-bid-1';
    s.repo.createAnalysis({ id: aId, title: 'Документация' });
    s.repo.addFile(aId, { name: 'Извещение.docx', status: 'ok', sha256: 'h1', coverage: fileCoverage({ unit: 'block', expected: 1, processed: 1 }),
      pages: [{ page: 1, text: 'Объект закупки: поставка коммутаторов. Размер обеспечения заявки: 1 % от НМЦК. Заявка должна содержать: предложение участника в отношении объекта закупки, характеристики товара.' }] });
    const analysis = await require('../server/analyze').analyzeDocs(s.repo.getFilesFull(aId), mock, { maxChars: 24000 });
    s.repo.finishAnalysis(aId, { card: analysis.card, provider: 'mock', model: 'rules-v1', durationMs: 1 });
    s.repo.setTenderAnalysis(id, aId);

    const opened = await api(`/api/tenders/${id}/bids`, { method: 'POST' });
    assert.equal(opened.status, 200);
    const v = opened.body;
    assert.deepEqual([v.scenario.scenario, v.scenario.supported, v.lot_id, v.rules.pack], ['44_eauction', true, 'lot-1', PACK.id]);
    assert.ok(v.scenario.signals.some((x) => x.source === 'извещение' && /Электронный аукцион/.test(x.text)));
    assert.ok(v.requirements.some((r) => r.id === 'req-44-43-participant-operator'));
    assert.equal(byId(v.requirements, 'req-44-44-bid-security').applicability, 'applies');
    assert.equal(byId(v.requirements, 'req-doc-application-composition').origin, 'tender_document');
    assert.deepEqual(v.sources.map((x) => [x.name, x.sha256, x.status]), [['Извещение.docx', 'h1', 'received']]);
    assert.equal(v.status, 'needs_review');
    assert.equal(v.readiness.counters.draft_rules > 0, true);
    assert.equal((await api(`/api/tenders/${id}/bids`)).body.id, v.id, 'повторное открытие — то же дело, а не новое');

    // декларация: без имени подтверждающего — отказ; с именем — «выполнено»
    assert.equal((await api(`/api/bids/${v.id}/attestations`, { method: 'POST', json: { requirement_id: 'req-44-43-declaration' } })).status, 400);
    assert.equal((await api(`/api/bids/${v.id}/attestations`, { method: 'POST', json: { requirement_id: 'req-44-44-bid-security', by: 'Петров' } })).status, 409, 'обеспечение заявлением не подтверждается');
    const att = await api(`/api/bids/${v.id}/attestations`, { method: 'POST', json: { requirement_id: 'req-44-43-declaration', by: 'Директор Петров' } });
    assert.equal(byId(att.body.requirements, 'req-44-43-declaration').decision, 'pass');
    // решение проверяющего — только с основанием и подписью
    assert.equal((await api(`/api/bids/${v.id}/review-decisions`, { method: 'POST', json: { requirement_id: 'req-44-43-participant-operator', decision: 'pass', basis: 'ок' } })).status, 400);
    const dec = await api(`/api/bids/${v.id}/review-decisions`, { method: 'POST', json: { requirement_id: 'req-44-43-participant-operator', decision: 'pass', basis: 'Сведения в ЕРУЗ сверены 17.09.2026, руководитель и адрес актуальны', reviewer: 'Петров' } });
    assert.deepEqual([byId(dec.body.requirements, 'req-44-43-participant-operator').decision, byId(dec.body.requirements, 'req-44-43-participant-operator').verification_state], ['pass', 'manual_verified']);

    // правило подтверждает человек: после этого черновиков становится меньше
    const rulesBefore = (await api('/api/bid-rules')).body;
    assert.ok(rulesBefore.rules.every((r) => r.status === 'draft'));
    assert.equal((await api('/api/bid-rules/нет-такого/verify', { method: 'POST', json: { by: 'Юрист' } })).status, 404);
    assert.equal((await api('/api/bid-rules/44-49-auction-price/verify', { method: 'POST', json: {} })).status, 400);
    const rulesAfter = (await api('/api/bid-rules/44-49-auction-price/verify', { method: 'POST', json: { by: 'Юрист Сидорова', note: 'сверено с редакцией на 11.10.2026' } })).body;
    assert.deepEqual((({ status, verified_by }) => [status, verified_by])(rulesAfter.rules.find((r) => r.id === '44-49-auction-price')), ['verified', 'Юрист Сидорова']);
    const re = (await api(`/api/bids/${v.id}/validate`, { method: 'POST' })).body;
    assert.equal(re.readiness.counters.draft_rules, v.readiness.counters.draft_rules - 1);
    assert.equal(byId(re.requirements, 'req-44-43-declaration').decision, 'pass', 'подтверждение правила не отменяет подтверждения на тех же данных');

    // данные закупки изменились (заказчик перенёс срок) — дело устарело, подтверждения больше не действуют (31)
    s.repo.db.prepare('UPDATE tenders SET deadline_at = ? WHERE id = ?').run('2026-10-30T09:00:00.000Z', id);
    const stale = (await api(`/api/bids/${v.id}`)).body;
    assert.deepEqual([stale.status, stale.stale], ['stale', true]);
    assert.equal((await api(`/api/bids/${v.id}/attestations`, { method: 'POST', json: { requirement_id: 'req-44-43-declaration', by: 'Петров' } })).status, 409, 'на устаревших данных подтверждать нельзя');
    const fresh = (await api(`/api/bids/${v.id}/validate`, { method: 'POST' })).body;
    assert.equal(fresh.stale, false);
    assert.equal(byId(fresh.requirements, 'req-44-43-declaration').decision, 'unknown', 'прежнее подтверждение относилось к другим данным');

    // закупка из своих документов с ЕАТ — явное «не поддерживается», без подстановки состава конкурентной заявки (35)
    const fd = new FormData();
    fd.append('files', new Blob([makeDocx(['Поставка бумаги. Количество: 10 пачек.'])]), 'ТЗ.docx');
    fd.append('number', '555');
    const m = await api('/api/tenders/manual', { method: 'POST', body: fd });
    await s.analyses.idle();
    await s.manualIdle();
    const eat = (await api(`/api/tenders/${m.body.id}/bids`, { method: 'POST' })).body;
    assert.deepEqual([eat.status, eat.scenario.supported, eat.requirements.filter((r) => r.origin === 'rule').length], ['unsupported', false, 0]);
    assert.equal((await api('/api/bids/999999')).status, 404);
  } finally { await s.close(); }
});
