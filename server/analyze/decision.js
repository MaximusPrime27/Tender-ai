// Качество разбора и решение об участии — раздельно и по правилам в коде. Нейросеть даёт текст резюме и кандидата
// рекомендации; окончательность решения она назначить не может: неполный разбор, противоречие в документах или
// неподтверждённое существенное условие делают решение предварительным, что бы ни написала модель.
//
//   analysis_status              complete | incomplete | needs_review | failed — ход и качество разбора
//   decision_status              final | preliminary                           — можно ли считать вывод окончательным
//   participation_recommendation участвовать | участвовать с оговорками | не участвовать | недостаточно данных

const crypto = require('node:crypto');

// Условия, без которых решение об участии принять нельзя.
const ESSENTIAL = ['subject', 'nmck', 'bid_deadline', 'delivery_term', 'delivery_place', 'payment_terms'];
const NOT_ENOUGH = 'недостаточно данных';

const gapKey = (b) => crypto.createHash('sha1').update(`${b.kind}|${b.text}`).digest('hex').slice(0, 12);

/**
 * Статус каждого существенного значения карточки:
 *   confirmed — найдено, цитата подтверждена в названном файле;
 *   conflict — в документах разные значения;
 *   requires_manual_check — найдено, но цитата не подтверждена (или найдена только в другом файле);
 *   not_found_after_complete_review — не найдено, хотя прочитано всё;
 *   unknown_due_to_incomplete_review — не найдено, но часть документов не прочитана: «нет» утверждать нельзя.
 */
function reviewField(f, complete) {
  if (f.conflict) return 'conflict';
  if (f.status === 'found' && f.origin === 'eis') return 'confirmed';
  if (f.status === 'found') return (f.sources || []).some((s) => s?.verified) ? 'confirmed' : 'requires_manual_check';
  return complete ? 'not_found_after_complete_review' : 'unknown_due_to_incomplete_review';
}

/**
 * @param coverage отчёт analysisCoverage
 * @param groups   группы полей карточки (у полей уже проставлен review)
 * @param risks    риски [{type, level, explanation, sources}]
 * @param legal    правовой вывод или null
 * @param candidate рекомендация-кандидат от нейросети
 * @param confirmedGaps ключи пробелов, которые человек проверил сам
 */
function decide({ coverage, groups, risks = [], legal = null, candidate = null, confirmedGaps = [] }) {
  const confirmed = new Set(confirmedGaps.map((g) => (typeof g === 'string' ? g : g.key)));
  const blockers = (coverage?.blocking || []).map((b) => ({ ...b, key: gapKey(b) }));
  const open = blockers.filter((b) => !confirmed.has(b.key));
  const fields = groups.flatMap((g) => g.fields);
  const conflicts = fields.filter((f) => f.review === 'conflict');
  const unverified = fields.filter((f) => ESSENTIAL.includes(f.key) && f.review === 'requires_manual_check');
  const missing = fields.filter((f) => ESSENTIAL.includes(f.key) && f.review === 'not_found_after_complete_review');
  const unknown = fields.filter((f) => ESSENTIAL.includes(f.key) && f.review === 'unknown_due_to_incomplete_review');
  const realRisks = risks.filter((r) => r.type !== 'противоречие_в_документации' && (r.level === 'high' || r.level === 'medium'));
  const highRisks = realRisks.filter((r) => r.level === 'high' && (r.sources || []).some((s) => s?.verified));
  const legalIssues = legal?.issues || [];
  const fatal = legalIssues.some((i) => i.fatal);

  // причины — структурированно: что это, откуда, что сделать, как влияет на решение
  const reasons = [];
  for (const b of open) reasons.push({ kind: b.kind === 'source_unavailable' ? 'source_unavailable' : 'incomplete_reading', text: b.text, action: b.action === 'upload_file' ? 'Загрузите этот файл вручную или проверьте его сами' : 'Нажмите «Повторить непрочитанные части»', impact: 'решение предварительное', gap: b.key });
  // у противоречия — каждое значение со своим местом в документе: открыть и сравнить, не разыскивая самому
  for (const f of conflicts) reasons.push({ kind: 'document_conflict', field: f.key, text: `«${f.label}» указано в документах по-разному: ${(f.alternatives || []).map((a) => `«${a.value}»`).join(' / ')}`, source: f.sources?.[0] || null,
    alternatives: (f.alternatives || []).map((a) => ({ value: a.value, source: a.sources?.[0] || null })), action: 'Сверьте по документам или запросите разъяснение у заказчика', impact: 'решение предварительное' });
  for (const f of unverified) reasons.push({ kind: 'unverified_source', text: `«${f.label}»: значение найдено, но цитата в названном файле не подтверждена`, source: f.sources?.[0] || null, action: 'Проверьте значение в документе', impact: 'решение предварительное' });
  for (const f of unknown) reasons.push({ kind: 'incomplete_reading', text: `«${f.label}» не найдено, но часть документов не прочитана — утверждать, что его нет, нельзя`, action: 'Дочитайте пропущенные части', impact: 'решение предварительное' });
  for (const f of missing) reasons.push({ kind: 'missing_condition', text: `«${f.label}» в документации не найдено (прочитано всё)`, action: 'Уточните у заказчика', impact: 'оговорка' });
  for (const r of realRisks) reasons.push({ kind: 'confirmed_risk', text: r.explanation, source: r.sources?.[0] || null, level: r.level, action: 'Оцените, приемлемо ли это условие', impact: r.level === 'high' ? 'оговорка' : 'учесть' });
  for (const i of legalIssues) reasons.push({ kind: 'legal_issue', text: i.condition, action: i.fatal ? 'Серьёзное условие — решите, участвовать ли' : 'Можно направить заказчику запрос разъяснений', impact: i.fatal ? 'может быть причиной отказа' : 'оговорка' });

  const hasReservations = realRisks.length > 0 || legalIssues.length > 0 || missing.length > 0;
  let analysisStatus;
  if (coverage?.status === 'failed') analysisStatus = 'failed';
  else if (open.length || unknown.length) analysisStatus = 'incomplete';
  else if (conflicts.length || unverified.length) analysisStatus = 'needs_review';
  else analysisStatus = 'complete';

  let recommendation;
  let decisionStatus = 'final';
  let note = null;
  if (analysisStatus === 'incomplete' || analysisStatus === 'failed') {
    decisionStatus = 'preliminary';
    // Подтверждённое препятствие может обосновать предварительное «не участвовать» и при неполном чтении.
    if (candidate === 'не участвовать' && (highRisks.length || fatal)) { recommendation = 'не участвовать'; note = 'Найдено серьёзное препятствие; разбор при этом неполный — остальные условия не проверены.'; }
    else { recommendation = NOT_ENOUGH; note = 'Разбор неполный: часть документации не прочитана, окончательное решение принимать рано.'; }
  } else {
    if (analysisStatus === 'needs_review') { decisionStatus = 'preliminary'; note = 'Документы прочитаны полностью, но есть противоречия или неподтверждённые значения — решение предварительное.'; }
    recommendation = candidate && candidate !== NOT_ENOUGH ? candidate : null;
    // Оговорки должны быть конкретными: без рисков, спорных условий и недостающих сведений «с оговорками» не остаётся.
    if (recommendation === 'участвовать с оговорками' && !hasReservations && !conflicts.length && !unverified.length) recommendation = 'участвовать';
    // И наоборот: подтверждённый серьёзный риск не может сопровождаться рекомендацией без оговорок.
    if (recommendation === 'участвовать' && (highRisks.length || fatal)) recommendation = 'участвовать с оговорками';
    if (!recommendation) { recommendation = NOT_ENOUGH; decisionStatus = 'preliminary'; note = note || 'Нейросеть не дала рекомендацию.'; }
  }

  return {
    analysis_status: analysisStatus,
    decision_status: decisionStatus,
    participation_recommendation: recommendation,
    candidate: candidate || null,
    note,
    reasons,
    gaps: blockers.map((b) => ({ ...b, confirmed: confirmed.has(b.key) })),
    counts: { blockers: open.length, conflicts: conflicts.length, unverified: unverified.length, risks: realRisks.length, legal: legalIssues.length },
  };
}

module.exports = { decide, reviewField, gapKey, ESSENTIAL, NOT_ENOUGH };
