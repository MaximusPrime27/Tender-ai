// Минимальный контракт отчёта (design-kit/comprehensive-analysis/reference/report.schema.json): JSON-выгрузка
// строго по схеме, без лишних полей. Внутренний снимок богаче (календарь, позиции, предложения, подписи полей) —
// здесь он проецируется на словари схемы. Плюс небольшой валидатор тех ключевых слов Draft 2020-12, что есть в схеме.

const SCHEMA = require('./report.schema.json'); // копия из комплекта задания

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] === undefined ? null : o[k]]));
const iso = (v, fallback) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : fallback; };
const minor = (v) => (v == null || v === '' ? null : String(v));

const FACT_STATUS = { verified: 'verified', reported: 'reported', unverified: 'reported', conflict: 'disputed', disputed: 'disputed', not_found_after_complete_review: 'unknown', unknown: 'unknown' };
const PRIMARY_KINDS = new Set(['notice', 'technical_specification', 'draft_contract', 'nmck_justification', 'bid_instruction', 'bid_forms', 'protocol', 'clarification', 'other', 'primary_procurement']);
const SOURCE_KIND = (k) => (PRIMARY_KINDS.has(k) ? 'primary_procurement' : ['secondary_analysis', 'aggregator', 'participant', 'supplier', 'manufacturer', 'registry', 'legal_rule', 'calculation', 'manual'].includes(k) ? k : k === 'feed' ? 'aggregator' : 'manual');
const COVERAGE = (v) => (['complete', 'partial', 'unknown', 'failed'].includes(v) ? v : v === 'duplicate' ? 'complete' : 'unknown');
const CATEGORY = { conflict: 'conflict', unknown: 'unknown', legal_review: 'legal_review', commercial_risk: 'commercial_risk', confirmed_failure: 'confirmed_failure',
  risk: 'commercial_risk', procedure: 'confirmed_failure', product_mismatch: 'confirmed_failure', application: 'unknown' };
const STAGE = (s) => (['analysis', 'bid', 'signing', 'fulfillment'].includes(s) ? s : ['suppliers', 'calc'].includes(s) ? 'bid' : 'analysis');
const READY = (v) => (['unknown', 'partial', 'verified', 'blocked'].includes(v) ? v : v === 'not_ready' ? 'partial' : v === 'ready' ? 'verified' : 'unknown');
const PACKAGE = ['draft', 'needs_input', 'needs_review', 'blocked', 'prepared_for_transfer', 'transfer_verified', 'stale', 'unsupported'];

/** Отчёт по контракту схемы из внутреннего снимка. */
function toContract(r) {
  const asOf = iso(r.snapshot?.as_of, new Date(0).toISOString());
  const cm = r.commercial || {};
  return {
    schema_version: '1.0',
    snapshot: { ...pick(r.snapshot, ['id', 'input_revision', 'mode', 'rules_version', 'prompts_version', 'calculator_version']), id: String(r.snapshot?.id || 'unsaved'), as_of: asOf, prompts_version: String(r.snapshot?.prompts_version || 'не применялись'), mode: r.snapshot?.mode === 'illustrative' ? 'illustrative' : 'live' },
    scope: { procurement_number: String(r.scope?.procurement_number || ''), lot_id: r.scope?.lot_id ?? null,
      law: ['44fz', '223fz', 'other', 'unknown'].includes(r.scope?.law) ? r.scope.law : 'other', procedure: String(r.scope?.procedure || 'не установлена'),
      basis: r.scope?.basis === 'primary' || r.scope?.basis === 'verified' ? 'verified' : r.scope?.basis === 'reported' || r.scope?.basis === 'partial' ? 'reported' : 'unknown' },
    source_manifest: pick(r.source_manifest, ['expected_set_known', 'expected_primary_count', 'received_primary_count', 'missing_known_roles']),
    coverage: { general: COVERAGE(r.coverage?.general), specification: COVERAGE(r.coverage?.specification), bid_requirements: COVERAGE(r.coverage?.bid_requirements), secondary_document: COVERAGE(r.coverage?.secondary_document) },
    sources: (r.sources || []).map((s) => ({ id: s.id, kind: SOURCE_KIND(s.kind), name: String(s.name || s.id), url: s.url || null, received: Boolean(s.received),
      sha256: /^[a-f0-9]{64}$/.test(s.sha256 || '') ? s.sha256 : null, revision: s.revision ?? null, limitations: (s.limitations || []).map(String) })),
    evidence: (r.evidence || []).map((e) => ({ id: e.id, source_id: e.source_id, locator: String(e.locator || '—'), quote: String(e.quote ?? ''), citation_verified: Boolean(e.citation_verified),
      eligible_for_decision: Boolean(e.eligible_for_decision), checked_at: iso(e.checked_at, asOf), valid_until: e.valid_until ? iso(e.valid_until, null) : null })),
    facts: (r.facts || []).map((f) => ({ id: f.id, key: f.key, value: f.value ?? null, unit: f.unit ?? null, status: FACT_STATUS[f.status] || 'unknown', evidence_ids: f.evidence_ids || [] })),
    checks: (r.checks || []).map((c) => ({ ...pick(c, ['gate', 'status', 'validation_state', 'rationale', 'evidence_ids', 'rule_ids', 'applicability_reason']),
      checked_at: iso(c.checked_at, asOf), valid_until: c.valid_until ? iso(c.valid_until, null) : null, hard_stop: Boolean(c.hard_stop), conditions: c.conditions || [],
      evidence_ids: c.evidence_ids || [], rule_ids: c.rule_ids || [] })),
    findings: (r.findings || []).map((f) => ({ id: f.id, category: CATEGORY[f.category] || 'unknown', title: String(f.title || f.id), details: String(f.details || f.title || f.id),
      evidence_ids: f.evidence_ids || [], rule_ids: f.rule_ids || [], action_ids: f.action_ids || [] })),
    actions: (r.actions || []).map((a) => ({ id: a.id, title: a.title, stage: STAGE(a.stage), status: ['todo', 'overdue', 'blocked', 'done', 'needs_review'].includes(a.status) ? a.status : 'needs_review',
      due_at: a.due_at ? iso(a.due_at, null) : null, due_reason: a.due_reason ?? null, depends_on: a.depends_on || [], finding_ids: a.finding_ids || [] })),
    commercial: { status: cm.status === 'verified' || cm.status === 'evaluated' ? 'evaluated' : cm.status === 'estimate' || cm.status === 'provisional' ? 'provisional' : 'unknown', currency: 'RUB',
      nmck_minor: minor(cm.nmck_minor), unverified_price_reference_minor: minor(cm.unverified_price_reference_minor),
      selected_offer_id: cm.selected_offer_id != null ? String(cm.selected_offer_id) : cm.selected_offer_ids?.length ? cm.selected_offer_ids.map(String).join(',') : null,
      contract_price_minor: minor(cm.contract_price_minor), net_profit_minor: minor(cm.net_profit_minor), funding_peak_minor: minor(cm.funding_peak_minor), missing_inputs: (cm.missing_inputs || []).map(String) },
    application: { package_status: PACKAGE.includes(r.application?.package_status) ? r.application.package_status : 'needs_input', document_readiness: READY(r.application?.document_readiness),
      platform_actions_readiness: READY(r.application?.platform_actions_readiness), submitted: false, missing_inputs: (r.application?.missing_inputs || []).map(String) },
    sections: (r.sections || []).map((s) => ({ id: s.id, title: s.title, status: ['reported', 'verified', 'needs_input', 'needs_review'].includes(s.status) ? s.status : 'needs_review', summary: String(s.summary || ''), fact_ids: s.fact_ids || [], finding_ids: s.finding_ids || [] })),
    expected_decision: r.decision?.recommendation || r.expected_decision,
    rules: (r.rules || []).map((x) => pick(x, ['id', 'act', 'reference', 'url', 'verification_state', 'effective_from', 'effective_until'])),
  };
}

// ---------- валидатор: type, required, properties, additionalProperties, items, enum, const, anyOf, minLength, pattern, format, minimum ----------
const typeOk = (t, v) => (t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
  : t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === t);
function validate(schema, value, at = '$', errors = []) {
  if (schema.anyOf) {
    if (!schema.anyOf.some((s) => !validate(s, value, at, []).length)) errors.push(`${at}: не подходит ни один вариант anyOf`);
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at}: ожидалось ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: «${value}» не из списка ${schema.enum.join('|')}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => typeOk(t, value))) { errors.push(`${at}: тип ${types.join('|')}, получено ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`); return errors; }
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: пустая строка`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: не по шаблону ${schema.pattern}`);
    if (schema.format === 'date-time' && !(/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)))) errors.push(`${at}: не дата-время`);
    if (schema.format === 'uri' && !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) errors.push(`${at}: не ссылка`);
  }
  if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) errors.push(`${at}: меньше ${schema.minimum}`);
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, errors));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${at}.${k}: обязательное поле отсутствует`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) validate(schema.properties[k], v, `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}.${k}: лишнее поле`);
    }
  }
  return errors;
}
const validateReport = (report) => validate(SCHEMA, report);

module.exports = { toContract, validate, validateReport, SCHEMA };
