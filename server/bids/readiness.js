// Готовность заявки — детерминированно, по реестру требований и доказательствам. Нейросеть может объяснить результат,
// но статус назначить не может; внешний текст (документ заказчика, ответ модели) не снимает ни одной проверки.
//
// Статус пакета:
//   unsupported            — для сценария нет проверенного адаптера (ЕАТ, закрытая процедура, единственный поставщик…);
//   stale                  — изменились зависимости (документы, товар, досье, набор правил) после проверки;
//   blocked                — установлено критичное несоответствие (товар не подходит, просрочен документ, конфликт версий);
//   needs_input            — нет конкретных исходных данных или оригиналов (источник не получен, документ не загружен);
//   needs_review           — правовая, техническая или ручная проверка не завершена;
//   draft                  — комплект собирается (нет ни блокеров, ни завершённых проверок);
//   prepared_for_transfer  — локальные документы и поля проверены, остаются действия на площадке;
//   transfer_verified      — пользователь сверил фактический состав на площадке с текущей версией.
// Оси готовности считаются отдельно: документы, действия на площадке, возможность реально поставить товар.

const CRITICAL_FINDINGS = new Set(['product_mismatch', 'expired', 'version_changed', 'platform_mismatch', 'financial_mismatch', 'customer_conflict', 'applicant_conflict']);

/** Счётчики проверок: балльные и добровольные пункты не складываются с обязательными и их не компенсируют. */
function counters(requirements) {
  const applies = requirements.filter((r) => r.applicability === 'applies');
  const mandatory = applies.filter((r) => r.obligation === 'mandatory' || r.obligation === 'conditional');
  return {
    total: requirements.length,
    mandatory: mandatory.length,
    mandatory_pass: mandatory.filter((r) => r.decision === 'pass').length,
    mandatory_fail: mandatory.filter((r) => r.decision === 'fail').length,
    mandatory_unknown: mandatory.filter((r) => r.decision === 'unknown').length,
    conflicting: requirements.filter((r) => r.verification_state === 'conflicting').length,
    applicability_unknown: requirements.filter((r) => r.applicability === 'unknown').length,
    not_applicable: requirements.filter((r) => r.applicability === 'not_applicable').length,
    evaluation: applies.filter((r) => r.obligation === 'evaluation_only').length,
    evaluation_pass: applies.filter((r) => r.obligation === 'evaluation_only' && r.decision === 'pass').length,
    unverified_sources: applies.filter((r) => r.origin === 'tender_document' && r.sources.length && !r.sources.some((s) => s.verification === 'exact')).length,
    // и те, чья применимость ещё не установлена: их тоже предстоит применять
    draft_rules: new Set(requirements.filter((r) => r.applicability !== 'not_applicable' && r.origin === 'rule' && r.rule_status !== 'verified').flatMap((r) => r.legal_rule_ids)).size,
  };
}

/**
 * @param ctx {classification, requirements, findings, coverage: {analysis, spec}, attestations, priceApproved, priceRequired,
 *             adapterVerified, snapshotConfirmed, stale, transferVerified, postcheckOk, dossierChecked, productsChecked}
 * @returns {{status, axes, counters, conditions, blockers}}
 */
function readiness(ctx) {
  const { classification, requirements = [], findings = [] } = ctx;
  const c = counters(requirements);
  const open = findings.filter((f) => f.status !== 'resolved');
  const critical = open.filter((f) => f.severity === 'critical' || CRITICAL_FINDINGS.has(f.type));
  const applies = requirements.filter((r) => r.applicability === 'applies');
  const mandatory = applies.filter((r) => r.obligation === 'mandatory' || r.obligation === 'conditional');

  // девять условий «подготовлено к переносу» — каждое проверяется отдельно и показывается человеку
  const conditions = [
    { key: 'scenario', ok: Boolean(classification?.supported) && !classification.unknown?.length && classification.variant !== 'unknown' && ctx.coverage?.analysis?.status === 'complete' && (ctx.coverage?.spec == null || ctx.coverage.spec.status === 'complete') && c.draft_rules === 0,
      text: 'Режим, лот, правила и версии источников определены; документы прочитаны полностью; применённые правила подтверждены человеком' },
    { key: 'mandatory', ok: mandatory.length > 0 && c.mandatory_unknown === 0 && c.mandatory_fail === 0 && c.applicability_unknown === 0,
      text: 'Все применимые обязательные требования имеют доказательства и решение «выполнено»' },
    { key: 'conflicts', ok: critical.length === 0 && c.conflicting === 0 && c.unverified_sources === 0,
      text: 'Нет критичных конфликтов, неподтверждённых цитат и неизвестных существенных значений' },
    { key: 'checks', ok: Boolean(ctx.dossierChecked && ctx.productsChecked), text: 'Проверены участник, полномочия подписанта, выбранные товары и подтверждения к ним' },
    { key: 'attestations', ok: applies.filter((r) => r.evidence_kind === 'attestation').every((r) => (ctx.attestations || []).some((a) => a.requirement_id === r.id && a.valid)),
      text: 'Декларации подтверждены ответственным человеком; требуемые документы оформлены, а не только сгенерированы' },
    { key: 'postcheck', ok: Boolean(ctx.postcheckOk), text: 'Сформированные файлы прочитаны заново и сверены; нет незаполненных мест и сведений в запрещённой части' },
    { key: 'price', ok: !ctx.priceRequired || Boolean(ctx.priceApproved), text: 'Цена предложения утверждена человеком (когда она подаётся на этом этапе)' },
    { key: 'platform_tasks', ok: applies.filter((r) => ['registration'].includes(r.stage) && r.obligation === 'mandatory').every((r) => r.decision === 'pass'),
      text: 'Регистрация, сведения в реестрах и обеспечение проверены либо названы как невыполненные действия' },
    { key: 'adapter', ok: Boolean(ctx.adapterVerified && ctx.snapshotConfirmed), text: 'Правила площадки проверены; пользователь подтвердил именно текущий, неизменившийся набор данных' },
  ];

  let status;
  if (!classification?.supported && !(classification?.unknown?.length) && !(classification?.conflicts?.length)) status = 'unsupported';
  else if (ctx.stale) status = 'stale';
  else if (critical.length || c.mandatory_fail > 0 || classification?.conflicts?.length) status = 'blocked';
  else if (conditions.every((x) => x.ok)) status = ctx.transferVerified ? 'transfer_verified' : 'prepared_for_transfer';
  else if (open.some((f) => ['missing_document', 'unreadable_source'].includes(f.type)) || requirements.some((r) => r.verification_state === 'unavailable' && r.applicability !== 'not_applicable')) status = 'needs_input';
  else if (requirements.length && (c.mandatory_unknown > 0 || c.applicability_unknown > 0 || c.draft_rules > 0 || classification?.unknown?.length || open.length)) status = 'needs_review';
  else status = 'draft';

  const docReqs = mandatory.filter((r) => ['upload', 'etp_field'].includes(r.channel) && r.stage === 'application');
  const actionReqs = mandatory.filter((r) => ['action', 'operator_supplied', 'preaccreditation'].includes(r.channel) && ['registration', 'application', 'auction'].includes(r.stage));
  const axis = (list) => (!list.length ? 'unknown' : list.some((r) => r.decision === 'fail') ? 'blocked' : list.every((r) => r.decision === 'pass') ? 'ready' : 'not_ready');
  return {
    status,
    axes: {
      document_readiness: axis(docReqs),
      platform_actions_readiness: axis(actionReqs),
      // возможность поставить товар — отдельный вопрос от готовности бумаг: считается по подтверждённым предложениям поставщиков
      supplier_fulfillment_readiness: ctx.fulfillment || 'unknown',
    },
    counters: c,
    conditions,
    blockers: [
      ...critical.map((f) => ({ kind: f.type, text: f.text, finding_id: f.id })),
      ...mandatory.filter((r) => r.decision === 'fail').map((r) => ({ kind: 'requirement_failed', text: r.requirement, requirement_id: r.id, reason: r.reason })),
      ...(classification?.conflicts || []).map((x) => ({ kind: 'legal_applicability_unknown', text: x.text })),
    ],
  };
}

module.exports = { readiness, counters, CRITICAL_FINDINGS };
