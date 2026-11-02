// Детерминированная проверка реестра требований: решения по записям и список несостыковок.
// Здесь нет нейросети. Неизвестное не проходит: без доказательства решение остаётся «неизвестно».
// Фактическое несоответствие (у выбранного товара другое значение, срок истёк) кнопкой «игнорировать» не снимается:
// решение проверяющего допустимо только для вопросов толкования и применимости, с основанием и подписью.

const FINDING_TYPES = ['customer_conflict', 'applicant_conflict', 'product_mismatch', 'unsupported_origin', 'missing_document', 'unreadable_source',
  'source_mismatch', 'expired', 'platform_mismatch', 'legal_applicability_unknown', 'version_changed', 'financial_mismatch'];
// Что делать с несостыковкой — пять разных действий, а не общее «исправьте».
const ACTIONS = { fix_bid: 'исправить в нашей заявке', provide_document: 'предоставить документ', verify: 'проверить подлинность или актуальность', ask_supplier: 'получить подтверждение поставщика', ask_customer: 'подготовить вопрос заказчику' };

const finding = (o) => ({ severity: 'major', requirement_id: null, values: [], consequence: null, owner: 'пользователь', status: 'open', ...o });

/**
 * @param ctx {
 *   requirements, classification, coverage: {analysis, spec}, tender, now,
 *   chosen: Map(itemId → {offer: {id, seller, url, title}, rows: [{name, need, verdict, found}]} | null),
 *   attestations: [{requirement_id, snapshot, by, at}], decisions: [{requirement_id, decision, basis, reviewer, at, snapshot}],
 *   snapshot: строка-отпечаток текущих входных данных
 * }
 * @returns {{requirements: Array, findings: Array}} requirements — копии с обновлёнными решениями
 */
function validate({ requirements, classification, coverage = {}, tender, now = new Date(), chosen = new Map(), attestations = [], decisions = [], snapshot = null }) {
  const findings = [];
  const out = requirements.map((r) => ({ ...r, sources: [...r.sources], evidence_ids: [...r.evidence_ids] }));
  const byId = new Map(out.map((r) => [r.id, r]));

  // --- полнота чтения: отсутствие результата в непрочитанной части не означает отсутствия требований ---
  const gaps = (coverage.analysis?.blocking || []).slice(0, 20);
  if (!coverage.analysis) findings.push(finding({ id: 'READ-000', type: 'unreadable_source', text: 'Документация закупки не разобрана или разобрана прежней версией без отчёта о полноте чтения', action_kind: 'verify', action: 'Разберите документацию заново на шаге «Документация»' }));
  gaps.forEach((g, i) => findings.push(finding({
    id: `READ-${String(i + 1).padStart(3, '0')}`, type: g.kind === 'source_unavailable' ? 'missing_document' : 'unreadable_source', text: g.text, // пробел в чтении — это «не хватает данных», а не установленное несоответствие
    consequence: 'В непрочитанной части могут быть требования к заявке — перечень нельзя считать полным',
    action_kind: g.action === 'upload_file' ? 'provide_document' : 'verify', action: g.action === 'upload_file' ? 'Загрузите этот файл вручную' : 'Нажмите «Повторить непрочитанные части» в разборе документации',
  })));
  if (coverage.spec && coverage.spec.status !== 'complete') findings.push(finding({ id: 'READ-SPEC', type: 'unreadable_source', text: 'Требования ТЗ к товарам прочитаны не по всей документации', action_kind: 'verify', action: 'Дочитайте ТЗ на шаге «Документация»' }));
  if (coverage.spec?.reconcile && !coverage.spec.reconcile.ok) {
    const r = coverage.spec.reconcile;
    findings.push(finding({
      id: 'TECH-RECON', type: 'customer_conflict', severity: 'critical', text: `Состав позиций в извещении и в ТЗ не сверен: в закупке ${r.items}, в ТЗ ${r.tz}, сопоставлено ${r.matched}`,
      values: [...r.unmatched_items.map((n) => ({ value: n, where: 'есть в закупке, нет в ТЗ' })), ...r.unmatched_tz.map((n) => ({ value: n, where: 'есть в ТЗ, нет в закупке' })), ...r.quantity_conflicts.map((q) => ({ value: `${q.name}: ${q.values.join(' / ')}`, where: 'количество расходится' }))],
      action_kind: 'ask_customer', action: 'Сверьте по документам; при расхождении подготовьте вопрос заказчику',
    }));
  }

  // --- сценарий и правила ---
  for (const c of classification?.conflicts || []) findings.push(finding({ id: `LEGAL-${c.kind}`, type: 'legal_applicability_unknown', severity: 'critical', text: c.text, values: (c.values || []).map((v) => ({ value: String(typeof v === 'object' ? JSON.stringify(v) : v) })), action_kind: 'ask_customer', action: 'Источники указывают разное — выбрать большинством нельзя. Сверьте извещение и документацию' }));
  for (const u of classification?.unknown || []) findings.push(finding({ id: `LEGAL-unknown-${u}`, type: 'legal_applicability_unknown', text: (classification.reasons || [])[0] || `Не установлено: ${u}`, action_kind: 'verify', action: 'Уточните по извещению на площадке' }));
  const drafts = [...new Set(out.filter((r) => r.origin === 'rule' && r.applicability !== 'not_applicable' && r.rule_status !== 'verified').flatMap((r) => r.legal_rule_ids))];
  if (drafts.length) findings.push(finding({ id: 'LEGAL-rules-draft', type: 'legal_applicability_unknown', text: `Правила состава заявки не подтверждены человеком: ${drafts.length}. Это черновики по открытым текстам закона — редакции не сверены`, values: drafts.map((v) => ({ value: v })), action_kind: 'verify', action: 'Сверьте каждое правило с действующей редакцией закона и подтвердите его (кто проверил и когда)' }));

  // --- срок подачи ---
  if (tender?.deadline_at && new Date(tender.deadline_at) < now) findings.push(finding({ id: 'TIME-deadline', type: 'expired', severity: 'critical', text: `Срок подачи заявок истёк: ${new Date(tender.deadline_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (мск)`, action_kind: 'verify', action: 'Проверьте на площадке, не продлён ли срок' }));

  // --- по записям реестра ---
  const validAtt = new Map(attestations.filter((a) => !snapshot || a.snapshot === snapshot).map((a) => [a.requirement_id, a]));
  const validDec = new Map(decisions.filter((d) => !snapshot || d.snapshot === snapshot).map((d) => [d.requirement_id, d]));
  let tech = 0;
  for (const r of out) {
    if (r.applicability === 'not_applicable') { r.decision = 'not_applicable'; continue; }
    if (r.applicability === 'unknown') { r.decision = 'unknown'; continue; }

    // источник требования
    const bad = r.sources.find((s) => s.verification === 'source_mismatch');
    if (bad) {
      findings.push(finding({ id: `SRC-${r.id}`, type: 'source_mismatch', requirement_id: r.id, text: `Требование «${r.requirement.slice(0, 120)}»: цитата названа в «${bad.file}», а найдена в «${bad.suggested?.file || 'другом документе'}»`,
        values: [{ value: bad.quote, where: `названо: ${bad.file}, стр. ${bad.locator?.page ?? '?'}` }, { value: bad.quote, where: `найдено: ${bad.suggested?.file || '?'}, стр. ${bad.suggested?.page ?? '?'}` }],
        consequence: 'Требование может относиться к другой редакции или к другому документу', action_kind: 'verify', action: 'Откройте оба документа и решите, какой из них источник' }));
    }
    if (r.verification_state === 'conflicting') findings.push(finding({ id: `CONF-${r.id}`, type: 'customer_conflict', severity: 'critical', requirement_id: r.id, text: `В документах заказчика условие указано по-разному: ${r.requirement.slice(0, 140)}`, action_kind: 'ask_customer', action: 'Подготовьте запрос разъяснений; до ответа конфликт не считается разрешённым' }));

    // технические требования: что у выбранного товара
    if (r.category === 'technical' && r.origin === 'tender_document' && r.scope.item_id != null) {
      const pick = chosen.get(r.scope.item_id);
      if (!pick) { r.decision = 'unknown'; r.reason = r.reason || 'Товар для этой позиции не выбран'; r.required_action = 'Выберите предложение на шаге «Поставщики»'; continue; }
      const row = pick.rows.find((x) => x.name === r.normalized?.field);
      if (row?.verdict === 'no') {
        tech++;
        r.decision = 'fail';
        r.candidate_value = row.found;
        r.reason = `У выбранного товара — «${row.found}», требуется «${r.normalized.value}»`;
        findings.push(finding({
          id: `TECH-${String(tech).padStart(3, '0')}`, type: 'product_mismatch', severity: 'critical', requirement_id: r.id,
          text: `ТЗ требует «${r.normalized.field}: ${r.normalized.value}». У выбранного товара (${pick.offer.seller || 'продавец'}) — «${row.found}». Подтверждать значение из ТЗ нельзя`,
          values: [{ value: r.normalized.value, where: r.sources[0] ? `${r.sources[0].file}, стр. ${r.sources[0].locator?.page ?? '?'}` : 'ТЗ' }, { value: row.found, where: pick.offer.url || 'страница товара' }],
          consequence: 'Заявка с таким товаром не соответствует ТЗ', action_kind: 'fix_bid', action: 'Выберите подходящий товар или получите официальное разъяснение заказчика. Кнопкой «игнорировать» это не снимается',
        }));
        continue;
      }
      // «подходит» по странице продавца — это кандидат, а не документальное подтверждение
      if (row?.verdict === 'yes') { r.candidate_value = row.found; r.reason = 'Совпадение найдено на странице продавца; документом изготовителя не подтверждено'; r.required_action = 'Запросите у поставщика паспорт или техническое описание модели'; }
      else { r.reason = r.reason || 'У выбранного товара этот показатель не найден'; r.required_action = 'Запросите показатель у поставщика'; }
      r.decision = 'unknown';
      r.evidence_ids.push(`offer-${pick.offer.id}`);
      const d = validDec.get(r.id);
      if (d && d.decision === 'pass' && row?.verdict !== 'no') { r.decision = 'pass'; r.verification_state = 'manual_verified'; r.reason = `Подтверждено: ${d.basis} (${d.reviewer})`; }
      continue;
    }

    // декларации: только подтверждение уполномоченного человека на текущих данных
    if (r.evidence_kind === 'attestation') {
      const a = validAtt.get(r.id);
      if (a) { r.decision = 'pass'; r.verification_state = 'manual_verified'; r.reason = `Подтверждено: ${a.by}, ${String(a.at).slice(0, 10)}`; }
      else { r.decision = 'unknown'; r.reason = 'requires_attestation: положения декларации не подтверждены ответственным человеком'; }
      continue;
    }

    // остальное: решение проверяющего с основанием (толкование, применимость, проверка реестра, обеспечение)
    const d = validDec.get(r.id);
    if (d && ['pass', 'not_applicable'].includes(d.decision)) {
      r.decision = d.decision;
      r.verification_state = 'manual_verified';
      r.reason = `Решение проверяющего: ${d.basis} (${d.reviewer}, ${String(d.at).slice(0, 10)})`;
    }
    if (r.verification_state === 'unavailable' && r.decision !== 'pass') {
      findings.push(finding({ id: `SRC-need-${r.id}`, type: 'missing_document', requirement_id: r.id, text: r.source_required === 'customer_regulation' ? 'Не получено положение о закупке заказчика (действующая редакция): без него перечень требований по 223-ФЗ неполон' : `Не получен источник: ${r.requirement.slice(0, 120)}`, action_kind: 'provide_document', action: 'Скачайте документ на сайте заказчика или в ЕИС и загрузите его' }));
    }
  }
  return { requirements: out, findings };
}

module.exports = { validate, FINDING_TYPES, ACTIONS };
