// Реестр требований заявки: каждое требование — отдельная запись со своим основанием, источником, этапом,
// каналом представления и решением. Запись связывает цепочку «закупка и лот → правило → документ и версия →
// страница и цитата → требуемое сведение → подтверждение → файл или поле ЭТП → проверка».
//
// Откуда берутся записи:
//   rule             — из набора правил сценария (server/bids/rules.js);
//   tender_document  — из документации закупки: требования ТЗ к каждой позиции (с цитатой и страницей),
//                      условия из разбора (обеспечение, нацрежим, требования к участнику, состав заявки).
// Нейросеть здесь ничего не решает: применимость, обязательность и решение считает код.

const { comparatorOf, unitOfValue } = require('../offers/spec');

const ENUMS = {
  applicability: ['applies', 'not_applicable', 'unknown'],
  obligation: ['mandatory', 'conditional', 'evaluation_only', 'optional', 'potentially_unlawful'],
  stage: ['registration', 'application', 'auction', 'contract_conclusion', 'performance', 'warranty'],
  channel: ['upload', 'etp_field', 'operator_supplied', 'preaccreditation', 'action', 'internal_only'],
  verification_state: ['unverified', 'source_verified', 'verified', 'manual_verified', 'expired', 'conflicting', 'unavailable'],
  decision: ['pass', 'fail', 'unknown', 'not_applicable'],
};

const field = (card, key) => card?.groups?.flatMap((g) => g.fields).find((f) => f.key === key) || null;
const NO_RE = /не (требуется|установлен|предусмотрен|применя)|отсутствует|^нет(?![а-яё])|(?<![\d.,])0\s*(%|руб)/i;

/** Источник из разбора → ссылка реестра: документ, версия (хеш), страница, цитата и то, подтверждена ли она. */
function sourceRef(s, files) {
  if (!s) return null;
  const f = files.find((x) => x.id === s.fileId) || files.find((x) => (x.original_name || x.name) === s.file) || null;
  return {
    document_id: f ? `file-${f.id}` : null, file: s.file || null, sha256: f?.sha256 || null,
    locator: { page: s.page ?? null }, quote: s.quote || null,
    // exact — цитата найдена в названном файле; mismatch — только в другом файле; unverified — не найдена
    verification: s.verified ? 'exact' : s.mismatch ? 'source_mismatch' : 'unverified',
    ...(s.mismatch ? { suggested: s.suggested || null } : {}),
  };
}

/**
 * Применимо ли условное правило — по разбору документации.
 *   найдено значение, говорящее «не требуется» → не применяется; найдено иное → применяется;
 *   не найдено при полном чтении → не применяется (с этой причиной); при неполном → неизвестно.
 */
function conditionState(rule, card, complete) {
  const key = { bid_security: 'bid_security', contract_security: 'contract_security', national_regime: 'national_regime', special_requirements: 'participant_requirements' }[rule.condition];
  if (!key) return { applicability: 'applies', reason: null, source: null };
  const f = field(card, key);
  if (f?.status === 'found' && f.value) {
    const src = f.sources?.[0] || null;
    if (rule.condition !== 'special_requirements' && NO_RE.test(f.value)) return { applicability: 'not_applicable', reason: `По документации: «${f.label}» — ${f.value}`, source: src };
    // «требования к участнику» есть почти всегда (единые требования ст. 31) — специальными они становятся при лицензии, СРО, опыте
    if (rule.condition === 'special_requirements' && !/лиценз|сро|саморегулир|опыт|допуск|аттестат|разрешен/i.test(f.value)) return { applicability: 'not_applicable', reason: 'В требованиях к участнику нет лицензий, СРО и дополнительных требований', source: src };
    return { applicability: 'applies', reason: `По документации: «${f.label}» — ${f.value}`, source: src, value: f.value, conflict: Boolean(f.conflict) };
  }
  if (complete) return { applicability: 'not_applicable', reason: 'В документации такого условия нет (прочитана полностью)', source: null };
  return { applicability: 'unknown', reason: 'Условие в документации не найдено, но она прочитана не полностью — утверждать, что его нет, нельзя', source: null };
}

/**
 * Реестр требований одного дела.
 * @param ctx {tender, classification, rules, card, files, items, coverage: {analysis, spec}, lotId}
 *   rules — правила сценария с действующим статусом; items — позиции с spec.required; files — файлы разбора (id, sha256)
 * @returns {Array} записи реестра
 */
function buildRequirements({ tender, classification, rules, card, files = [], items = [], coverage = {}, lotId = 'lot-1' }) {
  const out = [];
  const complete = coverage.analysis?.status === 'complete';
  const base = (o) => ({
    tender_id: tender.id, lot_id: lotId, scope: { item_id: null, party_id: null }, normalized: null, part: null,
    legal_rule_ids: [], sources: [], dependencies: [], candidate_value: null, evidence_ids: [],
    verification_state: 'unverified', decision: 'unknown', reason: null, required_action: null, ...o,
  });

  // --- из правил сценария ---
  for (const r of rules) {
    const cond = r.obligation === 'conditional' ? conditionState(r, card, complete) : { applicability: 'applies', reason: null, source: null };
    const src = cond.source ? [sourceRef(cond.source, files)].filter(Boolean) : [];
    const common = {
      category: r.category, requirement: r.requirement, applicability: cond.applicability, obligation: r.obligation, stage: r.stage, channel: r.channel,
      origin: 'rule', legal_rule_ids: [r.id], sources: src, rule_status: r.status, evidence_kind: r.evidence,
      reason: cond.reason, required_action: r.action,
      // не применяется — решать нечего; применимость неизвестна — и решение неизвестно
      decision: cond.applicability === 'not_applicable' ? 'not_applicable' : 'unknown',
      candidate_value: cond.value ?? null,
    };
    if (r.per_item && items.length) {
      for (const it of items) out.push(base({ ...common, id: `req-${r.id}-item-${it.id}`, scope: { item_id: it.id, party_id: null }, requirement: `${r.requirement} — позиция «${it.name}»` }));
    } else out.push(base({ ...common, id: `req-${r.id}` }));
  }

  // --- из документации: требования ТЗ к каждой позиции ---
  for (const it of items) {
    for (const [n, q] of (it.spec?.required || []).entries()) {
      const src = q.source ? sourceRef({ ...q.source, fileId: files.find((f) => (f.original_name || f.name) === q.source.file)?.id }, files) : null;
      out.push(base({
        id: `req-item-${it.id}-${n + 1}`, category: 'technical', scope: { item_id: it.id, party_id: null },
        requirement: `${q.name}: ${q.value}`, normalized: { field: q.name, operator: q.comparator || comparatorOf(q.value), value: q.value, unit: q.unit || unitOfValue(q.value) || null },
        applicability: 'applies', obligation: 'mandatory', stage: 'application', channel: 'etp_field', part: 'technical',
        origin: 'tender_document', sources: src ? [src] : [],
        // цитата найдена в названном документе — источник подтверждён; сам факт (что товар этому соответствует) — отдельная проверка
        verification_state: src?.verification === 'exact' ? 'source_verified' : 'unverified',
        reason: src?.verification === 'source_mismatch' ? 'Цитата названа в одном документе, а найдена в другом — проверьте, к какой редакции относится требование' : null,
        required_action: 'Подтвердите показатель документом изготовителя на предлагаемую модель',
        evidence_kind: 'product',
        dependencies: [`req-44-43-object-proposal-item-${it.id}`].filter((d) => out.some((x) => x.id === d)),
      }));
    }
  }

  // --- из документации: состав заявки, как его описал заказчик ---
  const comp = field(card, 'application_composition');
  if (comp?.status === 'found' && comp.value) {
    const src = (comp.sources || []).map((s) => sourceRef(s, files)).filter(Boolean);
    out.push(base({
      id: 'req-doc-application-composition', category: 'structure', requirement: `Состав заявки по документации заказчика: ${comp.value}`,
      applicability: 'applies', obligation: 'mandatory', stage: 'application', channel: 'upload', origin: 'tender_document', sources: src,
      verification_state: src.some((s) => s.verification === 'exact') ? 'source_verified' : 'unverified',
      required_action: 'Сверьте перечень заказчика с требованиями закона для этого способа закупки: лишнее требование — повод для вопроса, а не для молчаливого исключения',
      evidence_kind: 'legal_review',
    }));
  } else if (classification?.supported) {
    out.push(base({
      id: 'req-doc-application-composition', category: 'structure', requirement: 'Состав заявки по документации заказчика',
      applicability: complete ? 'applies' : 'unknown', obligation: 'mandatory', stage: 'application', channel: 'upload', origin: 'tender_document',
      reason: complete ? 'В прочитанной документации раздел о составе заявки не найден' : 'Раздел о составе заявки не найден, документация прочитана не полностью',
      required_action: complete ? 'Найдите требования к составу заявки в извещении на площадке и загрузите файл с ними' : 'Дочитайте документацию: требования к составу заявки могут быть в непрочитанной части',
      evidence_kind: 'source_required',
    }));
  }

  // --- источник, без которого перечень неполон (положение о закупке заказчика по 223-ФЗ) ---
  for (const r of rules.filter((x) => x.requires_source)) {
    const rec = out.find((x) => x.id === `req-${r.id}`);
    if (rec) { rec.source_required = r.requires_source; rec.verification_state = 'unavailable'; }
  }
  return out;
}

module.exports = { buildRequirements, conditionState, sourceRef, ENUMS };
