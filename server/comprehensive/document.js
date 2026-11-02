// Документ отчёта из снимка — общий для DOCX и PDF (одни и те же цифры, статусы, версия и источники).
// Блоки: {h: 1|2, text} — заголовок; {p, bold?, muted?} — абзац; {table: {head, rows, widths}} — таблица.
// Неизвестное выводится словами («не подтверждено», «не рассчитано»), не нулём.

const { REC_TEXT, ROLE_LABEL } = require('./build');
const { evaluateReport } = require('./gates');
const { ruleById, RULES_VERSION_TEXT } = require('./rules');

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const money = (minor) => (minor == null ? 'не рассчитано' : `${(Number(minor) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`);
const msk = (iso) => {
  if (!iso) return 'не известно';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return `${d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} МСК`;
};
const GATE = { source_manifest: 'Документы закупки (все ли есть)', reading_general: 'Чтение документации', reading_spec: 'Чтение ТЗ (позиции, требования)', reading_requirements: 'Требования к заявке',
  legal: 'Правовая проверка', procedure: 'Процедура и сроки', participant: 'Участник', product: 'Товар', supplier: 'Поставщики', economics: 'Экономика', funding: 'Деньги (финансирование)' };
const STATUS = { pass: 'пройдено', fail: 'не пройдено', unknown: 'не подтверждено', not_applicable: 'не применяется', conditional: 'с условиями' };
const FACT = { verified: 'подтверждено', unverified: 'не подтверждено цитатой', reported: 'по загруженному аналитическому отчёту', conflict: 'противоречие', not_found_after_complete_review: 'не найдено при полном чтении', unknown: 'не известно' };
const STAGE = { found_by_search: 'найдено поиском', page_opened: 'открыта страница товара, цена есть', matched: 'соответствует ТЗ по странице', confirmed_by_quote: 'цена подтверждена КП' };
const CAT = { conflict: 'противоречие', risk: 'риск', commercial_risk: 'коммерческий риск', legal_review: 'правовой вопрос', unknown: 'неизвестное', product_mismatch: 'несоответствие товара', application: 'заявка', procedure: 'процедура' };
const COV = { complete: 'полностью', partial: 'частично', failed: 'не прочитано', unknown: 'неизвестно', duplicate: 'копия другого файла' };
// подписи полей для снимков без своих подписей (пример комплекта задания)
const KEY_LABEL = { nmck: 'НМЦК', bid_deadline: 'Окончание подачи заявок', auction_time: 'Время аукциона', delivery_duration: 'Срок поставки, дней', price_reference: 'Ориентир цены (не подтверждён)', security_rate: 'Обеспечение заявки, %' };
// состояние строки «что приложить» (модуль заявки)
const CHECK_STATE = { ok: 'есть', missing: 'нет', expired: 'срок истёк', expires_before_deadline: 'истечёт до окончания подачи', needs_confirm: 'нужно подтвердить',
  not_required: 'не требуется (решено вручную)', info: 'к сведению', verified: 'подтверждено', unverified: 'не подтверждено', manual_verified: 'подтверждено вручную', unavailable: 'проверить нельзя' };
const PACKAGE = { draft: 'собирается', needs_input: 'не хватает данных', needs_review: 'нужна проверка', blocked: 'заблокирована', prepared_for_transfer: 'готова к переносу на площадку',
  transfer_verified: 'перенос на площадку проверен', stale: 'устарела', unsupported: 'не поддерживается' };
const READY = { ready: 'готово', verified: 'готово', not_ready: 'не готово', partial: 'готово частично', blocked: 'заблокировано', unknown: 'не оценено' };
const ACT_STAGE = { analysis: 'изучение документов', suppliers: 'поставщики', calc: 'расчёт', bid: 'подготовка заявки', signing: 'подписание контракта', fulfillment: 'исполнение контракта' };
const ACT_STATUS = { todo: 'сделать', overdue: 'просрочено', blocked: 'уже недоступно', done: 'сделано', needs_review: 'проверить' };
const DAYK = { working: 'рабочих', calendar: 'календарных', unspecified: 'дней (вид не указан)', hours: 'часа' };

function blocks(report, { freshness = 'current', stale_reasons = [] } = {}) {
  // снимок из другого источника (пример из комплекта задания) может не иметь блоков сервиса — пустые, не падаем
  const r = { calendar: [], items: [], offers: [], sections: [], ...report, application: { checklist: [], missing_inputs: [], ...(report.application || {}) }, commercial: { ...(report.commercial || {}) } };
  const d = r.decision || evaluateReport(report, { now: r.snapshot.as_of, currentInputRevision: r.snapshot.input_revision });
  const out = [];
  const SEC = { verified: 'проверено', reported: 'по отчёту', needs_review: 'нужна сверка', needs_input: 'нужны данные' };
  const head = (id, text) => { out.push({ h: 2, text }); const sc = r.sections.find((x) => x.id === id); if (sc) out.push({ p: `Состояние раздела: ${SEC[sc.status] || sc.status}. ${sc.summary}`, muted: true }); };
  const fact = (k) => r.facts.find((f) => f.key === k);
  const factVal = (k) => { const f = fact(k); return f?.value ?? (f ? FACT[f.status] || f.status : 'не известно'); };
  const evText = (ids) => (ids || []).map((id) => r.evidence.find((e) => e.id === id)).filter(Boolean).map((e) => `${e.locator}${e.citation_verified ? '' : ' (цитата не подтверждена)'}`).join('; ');
  // нормы — названием и пунктом закона, а не служебным кодом
  const ruleText = (ids) => (ids || []).map((id) => { const x = r.rules.find((y) => y.id === id) || ruleById(id); return x ? `${x.act}, ${x.reference}${x.topic || ruleById(id)?.topic ? ` — ${x.topic || ruleById(id).topic}` : ''}` : null; }).filter(Boolean).join('; ');

  out.push({ h: 1, text: `Полный анализ закупки № ${r.scope.procurement_number}` });
  out.push({ p: `Проверка на ${msk(r.snapshot.as_of)} · номер отчёта ${r.snapshot.id || 'не сохранён'} · актуальность: ${freshness === 'stale' ? `устарел (${stale_reasons.join('; ') || 'изменились входные данные'})` : 'текущий'} · режим: ${r.snapshot.mode === 'illustrative' ? 'иллюстративный пример' : 'по данным сервиса'}`, muted: true });
  out.push({ p: 'Внутренний документ: закупочные цены, маржа и риски в пакет заявки не входят. Это не заключение о законности закупки и не гарантия допуска или победы.', muted: true });

  // 1 Решение
  head('decision', '1. Решение и следующие действия');
  out.push({ p: `Рекомендация: ${REC_TEXT[d.recommendation] || d.recommendation}`, bold: true });
  if (d.unknown_gates?.length) out.push({ p: `Не подтверждено: ${d.unknown_gates.map((g) => GATE[g] || g).join(', ')}.` });
  if (d.hard_stops?.length) out.push({ p: `Подтверждённые препятствия: ${d.hard_stops.map((g) => GATE[g] || g).join(', ')}.` });
  if (d.unsupported) out.push({ p: d.unsupported });
  out.push({ table: { head: ['Проверка', 'Статус', 'Основание'], widths: [26, 20, 54], rows: r.checks.map((c) => [GATE[c.gate] || c.gate, `${STATUS[c.status] || c.status}${c.validation_state === 'verified' || c.status === 'unknown' ? '' : ' (не подтверждено документами — в решении считается «не подтверждено»)'}`, `${c.rationale}${c.conditions?.length ? ` Условия: ${c.conditions.join('; ')}` : ''}`]) } });
  const top = r.findings.slice(0, 5);
  if (top.length) out.push({ p: `Главные вопросы (${top.length} из ${r.findings.length}): ${top.map((f) => f.title).join('; ')}.` });
  const cm = r.commercial || {};
  out.push({ table: { head: ['Показатель', 'Значение'], widths: [40, 60], rows: [
    ['Плановая прибыль', cm.net_profit_minor != null ? `${money(cm.net_profit_minor)} (${cm.status === 'verified' ? 'подтверждено' : 'оценка'})` : 'не рассчитано'],
    ['Максимально нужно своих денег', money(cm.funding_peak_minor)],
    ['Не хватает бюджета', cm.budget_minor == null ? 'бюджет не указан' : money(cm.budget_gap_minor)],
    ['Окончание подачи', `${msk(fact('bid_deadline')?.value)} (${FACT[fact('bid_deadline')?.status] || 'не известно'})`],
    ['Ближайшее действие', r.actions.find((a) => a.status === 'todo' || a.status === 'overdue')?.title || 'нет открытых задач'],
  ] } });

  // 2 Паспорт
  head('passport', '2. Паспорт закупки');
  out.push({ table: { head: ['Поле', 'Значение', 'Статус и источник'], widths: [24, 38, 38], rows: r.facts.map((f) => [f.label || KEY_LABEL[f.key] || f.key, /T\d\d:/.test(f.value || '') ? msk(f.value) : f.value == null ? '—' : cut(f.value, 300),`${FACT[f.status] || f.status}${f.evidence_ids?.length ? `: ${evText(f.evidence_ids)}` : ''}${f.alternatives ? `. Варианты (${f.alternatives.length}): ${f.alternatives.slice(0, 3).map((a) => `«${cut(a.value, 100)}»`).join(' / ')}` : ''}`]) } });

  // 3 Источники
  head('coverage', '3. Что прочитано и чего не хватает');
  const sm = r.source_manifest;
  out.push({ p: `Обязательных видов документов: ${sm.expected_primary_count ?? 'не установлено'}; получено файлов закупки: ${sm.received_primary_count}; не хватает: ${sm.missing_known_roles?.length ? sm.missing_known_roles.map((k) => ROLE_LABEL[k] || k).join(', ') : 'ничего'}${sm.expected_set_known ? '' : ' (полный ожидаемый комплект не установлен)'}.` });
  out.push({ table: { head: ['Источник', 'Роль', 'Получен', 'Охват', 'Ограничение'], widths: [30, 20, 10, 12, 28], rows: r.sources.map((s) => [s.name || s.id, ROLE_LABEL[s.kind] || s.kind, s.received ? 'да' : 'нет', COV[s.coverage] || s.coverage || '—', (s.limitations || []).join('; ') || '—']) } });

  // 4 Участник
  head('participant', '4. Требования к участнику');
  const app = r.application || {};
  if ((app.checklist || []).length) out.push({ table: { head: ['Требование', 'Чем закрывается', 'Состояние', 'Что сделать'], widths: [38, 20, 14, 28], rows: app.checklist.map((l) => [l.title, l.closure || '—', CHECK_STATE[l.state] || l.state || '—', l.action || '—']) } });
  else out.push({ p: 'Не собрано: дело заявки не открыто. Действие — на шаге «Заявка» нажать «Собрать заявку».' });

  // 5 Товары и нацрежим
  head('products', '5. Товары и национальный режим');
  if (!(r.items || []).length) out.push({ p: 'Позиции не загружены — нужен документ заказчика с описанием объекта закупки.' });
  for (const it of r.items || []) {
    out.push({ p: `Позиция ${it.idx + 1}. ${it.name}${it.code ? ` (${it.code})` : ''}${it.quantity != null ? `, ${it.quantity} ${it.unit || ''}` : ''}. Товар: ${it.offer?.title || 'не выбран'}${it.offer?.seller ? ` (${it.offer.seller})` : ''}. Знак: ${it.trademark || 'не указан'}. Страна: ${it.country || 'не указана'}.`, bold: true });
    if (it.characteristics.length) out.push({ table: { head: ['Характеристика', 'Требование и инструкция', 'В заявку', 'Откуда', 'Итог'], widths: [28, 26, 18, 18, 10], rows: it.characteristics.map((c) => [c.name, `${c.requirement || '—'}${c.fill ? ` (${{ concrete: 'конкретное', fixed: 'не менять', one: 'одно из' }[c.fill]})` : ''}`, c.value || '—', `${c.source || '—'}${c.note ? `. ${c.note}` : ''}`, { pass: 'да', fail: 'нет', unknown: '?' }[c.result] || c.result]) } });
    const nr = it.national_regime;
    out.push({ table: { head: ['Мера и норма', 'Условие срабатывания', 'Происхождение и реестр', 'Баллы', 'Итог'], widths: [18, 34, 26, 12, 10], rows: [[nr.measure ? `${nr.measure}${nr.act ? `, ${nr.act}` : ''}` : 'не известна', nr.trigger || '—', `${nr.origin}; ${nr.registry}`, nr.points, STATUS[nr.result] || nr.result]] } });
  }

  // 6 Контракт
  head('contract', '6. Контракт и обязательства');
  const contractKeys = ['subject', 'delivery_place', 'delivery_term', 'acceptance_term', 'payment_terms', 'advance', 'bid_security', 'contract_security', 'warranty', 'warranty_security', 'penalties', 'contract_term', 'national_regime'];
  out.push({ table: { head: ['Условие', 'Что требуется', 'Источник и статус'], widths: [22, 44, 34], rows: contractKeys.map((k) => fact(k)).filter(Boolean).map((f) => [f.label, f.value ?? '—', `${FACT[f.status] || f.status}${f.evidence_ids?.length ? `: ${evText(f.evidence_ids)}` : ''}`]) } });
  out.push({ p: 'Проверка норм: справочные правила (не утверждены человеком) — правовой вывод «соответствует» не делается. Пени и штрафы не вычисляются из сокращённого пересказа: нужна полная формула из проекта контракта.', muted: true });

  // 7 Календарь
  head('calendar', '7. Календарь');
  out.push({ table: { head: ['Событие', 'Начало отсчёта', 'Длительность', 'Официальный срок', 'Основание и состояние'], widths: [22, 22, 14, 16, 26], rows: r.calendar.map((c) => [c.title, c.start_event || '—', c.duration != null ? `${c.duration} ${c.unit === 'month' ? 'мес.' : DAYK[c.day_kind] || ''}` : c.until ? `до ${c.until}` : '—', c.official ? (c.group === 'procedure' && /T/.test(c.official) ? msk(c.official) : c.official) : c.expected_by_rule ? `ожид. ${msk(c.expected_by_rule)}` : '—', `${c.state}${c.text ? `. Текст: «${String(c.text).slice(0, 120)}»` : ''}`]) } });

  // 8 Поставщики
  head('suppliers', '8. Поставщики');
  if (!(r.offers || []).length) out.push({ p: 'Предложений нет. Действие — на шаге «Поставщики» запустить поиск; найденная поиском страница не считается подтверждённым предложением.' });
  else out.push({ table: { head: ['Товар и продавец', 'Цена за ед.', 'Наличие и доставка', 'Проверено', 'Ступень подтверждения'], widths: [34, 14, 18, 14, 20], rows: r.offers.map((o) => [`${o.title || '—'}${o.seller ? ` — ${o.seller}` : ''}${o.selected ? ' [выбран]' : ''}`, `${money(o.unit_price_minor)}, НДС ${o.vat}`, `${o.availability || 'наличие не указано'}${o.delivery_days != null ? `; доставка ${o.delivery_days} дн.` : ''}`, o.checked_at ? msk(o.checked_at) : '—', `${STAGE[o.stage] || o.stage}${o.checks ? `; ТЗ: ${o.checks.confirmed} из ${o.checks.total}` : ''}`]) } });

  // 9 Экономика
  head('economics', '9. Экономика и деньги');
  const sc = cm.scenarios || [];
  if (!sc.length) out.push({ p: 'Не рассчитано: расчёт сделки недоступен.' });
  else out.push({ table: { head: ['Показатель', ...sc.map((s) => s?.title || '—')], widths: [28, ...sc.map(() => Math.floor(72 / sc.length))], rows: [
    ['Цена контракта', ...sc.map((s) => money(s?.price_minor))], ['Выручка без НДС', ...sc.map((s) => money(s?.revenue_net_minor))], ['Затраты всего', ...sc.map((s) => money(s?.costs_minor))],
    ['Налог', ...sc.map((s) => money(s?.tax_minor))], ['Плановая прибыль', ...sc.map((s) => money(s?.profit_minor))], ['Цена без убытка', ...sc.map((s) => money(s?.breakeven_minor))],
    ['Пик своих денег', ...sc.map((s) => (s?.peak_need_minor != null ? `${money(s.peak_need_minor)}${s.peak_day != null ? `, день ${s.peak_day}` : ''}` : 'не рассчитано'))], ['Дефицит бюджета', ...sc.map((s) => (s?.gap_minor != null ? money(s.gap_minor) : 'бюджет не указан'))],
  ] } });
  if ((cm.assumptions || []).length) out.push({ p: `Допущения: ${cm.assumptions.join('; ')}.`, muted: true });
  out.push({ p: cm.note || '', muted: true });

  // 10 Проблемы
  head('issues', '10. Проблемы и вопросы');
  if (!r.findings.length) out.push({ p: 'Замечаний нет.' });
  else out.push({ table: { head: ['№', 'Вид', 'Суть', 'Откуда и по какой норме', 'Что сделать'], widths: [5, 13, 40, 20, 22], rows: r.findings.map((f, i) => [String(i + 1), CAT[f.category] || f.category, `${f.title}${f.details ? `. ${f.details}` : ''}`, [evText(f.evidence_ids), ruleText(f.rule_ids)].filter(Boolean).join('; ') || 'вывод сервиса по данным закупки', (f.action_ids || []).map((id) => r.actions.find((a) => a.id === id)?.title).filter(Boolean).join('; ') || '—']) } });
  out.push({ p: 'Число замечаний — не число нарушений заказчика. Правовой вопрос — сигнал для проверки, не установленное нарушение. Вопросы заказчику не отправляются автоматически.', muted: true });

  // 11 Заявка и план
  head('application', '11. Заявка и план действий');
  out.push({ p: `Заявка: ${PACKAGE[app.package_status] || app.package_status}. Документы и поля: ${READY[app.document_readiness] || app.document_readiness}. Действия на площадке: ${READY[app.platform_actions_readiness] || app.platform_actions_readiness}. Подана: нет (сервис заявки не подаёт — это делаете вы на площадке).` });
  if ((app.missing_inputs || []).length) out.push({ p: `Не хватает: ${app.missing_inputs.join('; ')}.` });
  if (r.actions.length) out.push({ table: { head: ['№', 'Задача', 'Этап', 'Состояние', 'Срок'], widths: [5, 47, 14, 12, 22], rows: r.actions.map((a, i) => [String(i + 1), a.title, ACT_STAGE[a.stage] || a.stage || '—', ACT_STATUS[a.status] || a.status, a.due_at ? `${msk(a.due_at)} (${a.due_reason})` : a.due_reason || 'не назначен']) } });

  // 12 Основания
  head('sources', '12. Основания и история');
  out.push({ p: 'Нормы, по которым сервис проверял закупку. Это ориентир, где читать: вывод «соответствует закону» сервис не делает, пока юрист не сверит нормы.' });
  out.push({ table: { head: ['О чём норма', 'Закон и пункт', 'Состояние', 'Где прочитать'], widths: [32, 24, 14, 30], rows: r.rules.map((x) => [x.topic || ruleById(x.id)?.topic || '—', `${x.act}, ${x.reference}`, x.verification_state === 'approved' ? 'сверена юристом' : 'справочная, юристом не сверена', x.url || '—']) } });
  out.push({ p: `Служебные отметки, чтобы отличать версии отчёта: ${r.snapshot.rules_version === 'research-2026-10-19' ? RULES_VERSION_TEXT : `набор норм ${r.snapshot.rules_version}`}; формула расчёта сделки — ${r.snapshot.calculator_version ? `версия ${String(r.snapshot.calculator_version).replace(/^deal-/, '')}` : 'не применялась'}; контрольная сумма отчёта ${String(r.snapshot.integrity || '—').slice(0, 12)} (меняется при любом изменении данных).`, muted: true });
  return out;
}

module.exports = { blocks, money, msk };
