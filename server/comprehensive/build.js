// Полный анализ закупки: один доказательный снимок из уже работающих модулей сервиса — разбор документации
// (поля с цитатами, полнота чтения, противоречия, риски), извещение ЕИС (структурированные сведения), позиции и
// характеристики для заявки, предложения поставщиков, расчёт сделки (деньги по датам) и модуль заявки.
// Новых нейросетевых вызовов нет: модуль сводит проверенные результаты и кодом вычисляет статусы и рекомендацию
// (gates.js — по эталону комплекта). Задание: design-kit/comprehensive-analysis/CLAUDE_CODE_TASK.md.
//
// Четыре вопроса не смешиваются: что написал заказчик (факты), соответствует ли это норме (legal), соответствуем ли
// мы и наш товар (participant, product, supplier), выгодно и исполнимо ли участие (economics, funding).
// Неизвестное ≠ 0 ≠ «не найдено при полном чтении» ≠ «не применяется» (последнее — только с основанием).

const crypto = require('node:crypto');
const { evaluateReport, REQUIRED_GATES } = require('./gates');
const { RULES, RULES_VERSION } = require('./rules');

const SCHEMA_VERSION = '1.0';
const BUILDER_VERSION = 'tender-ai-comprehensive-1';
const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const kop = (rub) => (rub == null || !Number.isFinite(Number(rub)) ? null : String(Math.round(Number(rub) * 100)));

// Роли первичных документов 44-ФЗ и признаки в имени файла. Секундарный аналитический отчёт другой программы —
// отдельная роль: он даёт кандидаты утверждений, но не доказывает условия закупки.
const ROLE_RULES = [
  ['secondary_analysis', /анализ[_\s-]*закупк|tender[_\s-]*analysis|отч[её]т[_\s-]*(об?\s*)?анализ|разбор[_\s-]*закупк/i],
  ['draft_contract', /проект[_\s-]*(гос|муниц)?[_\s-]*(контракт|договор)|контракт|договор/i],
  ['nmck_justification', /обосновани[а-яё]*[_\s-]*(нмцк|начальн|цен)|нмцк/i],
  ['technical_specification', /(^|[^а-яё])тз([^а-яё]|$)|техническ[а-яё]*[_\s-]*задани|описани[а-яё]*[_\s-]*объект|спецификац/i],
  ['bid_instructions', /требовани[а-яё]*[_\s-]*к[_\s-]*(содержани|состав)[а-яё]*[_\s-]*заявк|инструкци[а-яё]*[_\s-]*(по|к)[_\s-]*заполнени/i],
  ['notice_document', /извещени/i],
  ['signature', /\.(sig|p7s)$/i],
];
const ROLE_LABEL = {
  notice: 'Извещение (структурированные сведения ЕИС)', notice_document: 'Извещение (файл)', technical_specification: 'Описание объекта закупки / ТЗ',
  draft_contract: 'Проект контракта', nmck_justification: 'Обоснование НМЦК', bid_instructions: 'Требования к содержанию заявки',
  secondary_analysis: 'Аналитический отчёт другой программы (вторичный)', signature: 'Файл подписи', other: 'Прочий документ',
  aggregator: 'Служебный: лента закупок', calculation: 'Служебный: расчёт', supplier: 'Служебный: поставщик', manual: 'Служебный: прочее',
};
const roleOf = (name) => (ROLE_RULES.find(([, re]) => re.test(String(name || ''))) || ['other'])[0];
// Ожидаемый первичный комплект электронного аукциона 44-ФЗ (ст. 42): структурированное извещение, описание объекта,
// проект контракта, обоснование НМЦК. Требования к заявке входят в извещение — отдельный файл не ожидаем.
const EXPECTED_44 = ['notice', 'technical_specification', 'draft_contract', 'nmck_justification'];

// 14 видов сроков из AUDIT_REFERENCE.md (раздел 5) — и где их искать в разборе
const TERM_KINDS = [
  { id: 'T01', title: 'Поставка', field: 'delivery_term' },
  { id: 'T02', title: 'Срок действия контракта', field: 'contract_term' },
  { id: 'T03', title: 'Оплата', field: 'payment_terms' },
  { id: 'T04', title: 'Приёмка (рассмотрение документа о приёмке)', field: 'acceptance_term' },
  { id: 'T05', title: 'Гарантийный срок', field: 'warranty' },
  { id: 'T06', title: 'Возврат обеспечения исполнения', field: null },
  { id: 'T07', title: 'Рассмотрение независимой гарантии', field: null },
  { id: 'T08', title: 'Новое обеспечение при отзыве лицензии банка', field: null },
  { id: 'T09', title: 'Устранение недостатков товара', field: null },
  { id: 'T10', title: 'Ответ на претензию', field: null },
  { id: 'T11', title: 'Уведомление о непреодолимой силе', field: null },
  { id: 'T12', title: 'Уплата неустойки по требованию', field: null },
  { id: 'T13', title: 'Уведомление об одностороннем отказе', field: null },
  { id: 'T14', title: 'Срок независимой гарантии (сверх обязательств)', field: null },
];

/** Срок из текста: длительность, вид дней и событие начала отсчёта. Дату без подтверждённого события не считаем. */
function parseTerm(text) {
  const t = String(text || '');
  const m = /(?:не\s+(?:более|позднее)|в\s+течение|до)?\s*(\d{1,3})\s*(?:\([^)]*\)\s*)?(рабоч[а-яё]*|календарн[а-яё]*)?\s*(дн[а-яё]*|день|месяц[а-яё]*)/i.exec(t);
  const event = /(с\s+(?:даты|момента|дня)\s+[^.;,]{3,80}|после\s+[^.;,]{3,80})/i.exec(t)?.[1]?.trim() || null;
  const until = /(?:по|до)\s+(\d{2}\.\d{2}\.\d{4})/.exec(t)?.[1] || null;
  if (!m && !until) return { duration: null, day_kind: null, event, until };
  return {
    duration: m ? Number(m[1]) : null,
    unit: m ? (/месяц/i.test(m[3]) ? 'month' : 'day') : null,
    day_kind: m ? (/рабоч/i.test(m[2] || '') ? 'working' : /календар/i.test(m[2] || '') ? 'calendar' : 'unspecified') : null,
    event, until,
  };
}

const fieldsOf = (analysis) => (analysis?.card?.groups || []).flatMap((g) => g.fields || []);

/**
 * Собрать отчёт. input — данные сервиса (см. service.js gather), now — момент проверки (ISO с поясом).
 * Возвращает снимок по контракту reference/report.schema.json и дополнительные разделы (calendar, items, offers…).
 */
function buildReport(input, { now }) {
  const { tender, card = null, analysis = null, items = [], chars = null, offers = [], deal = null, bid = null } = input;
  const evidence = [];
  const facts = [];
  const findings = [];
  const actions = [];
  const addEv = (e) => { const id = e.id || `e${evidence.length + 1}`; if (!evidence.some((x) => x.id === id)) evidence.push({ valid_until: null, checked_at: now, ...e, id }); return id; };
  const addFinding = (f) => { if (!findings.some((x) => x.id === f.id)) findings.push({ evidence_ids: [], rule_ids: [], action_ids: [], ...f }); return f.id; };
  const addAction = (a) => { if (!actions.some((x) => x.id === a.id)) actions.push({ status: 'todo', due_at: null, due_reason: null, depends_on: [], finding_ids: [], ...a }); return a.id; };

  // ---------- источники и полнота ----------
  const law = String(tender.law || '');
  const manual = tender.source === 'manual';
  const conditions = card?.details?.conditions || {};
  const noticeKnown = law === '44' && (card?.details?.items_source === 'notification' || conditions.notice_version != null || Boolean(analysis?.card?.meta?.eis_notice));
  const sources = [];
  if (noticeKnown) {
    sources.push({ id: 's-notice', kind: 'notice', name: `Извещение № ${tender.number} (ЕИС, структурированные сведения)`, url: tender.eis_url || null, received: true, primary: true,
      sha256: null, revision: conditions.notice_version != null ? `редакция ${conditions.notice_version}` : 'редакция не известна', published_at: conditions.notice_published_at || null,
      coverage: 'complete', limitations: ['Структурированные поля извещения; печатная форма и вложения — отдельными источниками'] });
  }
  for (const f of analysis?.files || []) {
    const role = roleOf(f.original_name);
    if (role === 'signature') continue;
    const cov = f.coverage?.status || (f.status === 'done' || f.status === 'ok' ? 'unknown' : 'failed');
    sources.push({ id: `s-f${f.id}`, kind: role, name: f.original_name, url: null, received: !['error', 'unsupported'].includes(f.status), primary: role !== 'secondary_analysis',
      sha256: f.sha256 || null, revision: null, published_at: null, coverage: f.coverage?.reason === 'rendition' ? 'duplicate' : cov,
      limitations: [f.message, f.coverage?.reason === 'rendition' ? 'печатная копия другого файла' : null, role === 'secondary_analysis' ? 'Отчёт другой программы: не заменяет документацию заказчика' : null].filter(Boolean) });
  }
  const secondaryOnly = sources.length > 0 && sources.every((s) => !s.primary);
  const expectedKnown = law === '44' && !manual && Boolean(analysis) && !secondaryOnly;
  const roles = new Set(sources.filter((s) => s.primary && s.received).map((s) => s.kind));
  if (roles.has('notice_document')) roles.add('notice');
  const missingRoles = law === '44' ? EXPECTED_44.filter((r) => !roles.has(r)) : [];
  // ожидаемые, но не полученные — остаются в знаменателе полноты
  for (const r of missingRoles) sources.push({ id: `s-missing-${r}`, kind: r, name: ROLE_LABEL[r], url: null, received: false, primary: true, sha256: null, revision: null, coverage: 'failed', limitations: ['Не получен — нет в комплекте разбора'] });
  const source_manifest = {
    expected_set_known: expectedKnown, expected_primary_count: law === '44' ? EXPECTED_44.length : null,
    received_primary_count: sources.filter((s) => s.primary && s.received).length, missing_known_roles: missingRoles,
  };
  const covOf = (s) => (['complete', 'partial', 'failed', 'unknown'].includes(s) ? s : 'unknown');
  const coverage = {
    general: analysis?.status === 'done' ? covOf(analysis.card?.meta?.coverage?.status) : 'unknown',
    specification: covOf(card?.details?.spec_coverage?.status),
    bid_requirements: !bid ? 'unknown' : bid.readiness?.conditions?.find((c) => c.key === 'scenario')?.ok ? 'complete' : (bid.requirements || []).length ? 'partial' : 'unknown',
  };
  if (sources.some((s) => s.kind === 'secondary_analysis')) coverage.secondary_document = 'complete';

  // ---------- доказательства и факты ----------
  const fields = fieldsOf(analysis);
  const fileByName = (name) => sources.find((s) => s.name === name || String(name || '').endsWith(s.name) || String(s.name).endsWith(String(name || '').split('/').pop()));
  const evOfField = (f) => {
    if (f.origin === 'eis') return [addEv({ id: `e-n-${f.key}`, source_id: 's-notice', locator: `ЕИС: извещение, «${f.label}»`, quote: String(f.value).slice(0, 300), citation_verified: true, eligible_for_decision: true })];
    return (f.sources || []).slice(0, 2).map((s, i) => {
      const src = fileByName(s.file);
      const secondary = src?.kind === 'secondary_analysis';
      return addEv({ id: `e-${f.key}-${i}`, source_id: src?.id || 's-unknown', locator: `${s.file || 'файл не указан'}${s.page != null ? `, стр. ${s.page}` : ''}`,
        quote: String(s.quote || f.value || '').slice(0, 300), citation_verified: s.verified === true, eligible_for_decision: s.verified === true && !secondary && Boolean(src) });
    });
  };
  const factOf = (key, label, f, { unit = null, event_kind = null } = {}) => {
    if (!f) { facts.push({ id: `f-${key}`, key, label, value: null, unit, event_kind, status: analysis?.status === 'done' && coverage.general === 'complete' ? 'not_found_after_complete_review' : 'unknown', evidence_ids: [] }); return; }
    const ev = evOfField(f);
    const verified = ev.length && ev.every((id) => evidence.find((e) => e.id === id)?.eligible_for_decision);
    const status = f.conflict ? 'conflict' : f.status === 'found' ? (verified ? 'verified' : sources.find((s) => s.id === evidence.find((e) => e.id === ev[0])?.source_id)?.kind === 'secondary_analysis' ? 'reported' : 'unverified') : f.status === 'not_found' ? 'not_found_after_complete_review' : 'unknown';
    facts.push({ id: `f-${key}`, key, label, value: f.status === 'found' ? String(f.value) : null, unit, event_kind, status, evidence_ids: ev,
      alternatives: f.conflict ? (f.alternatives || []).map((a) => ({ value: String(a.value), sources: (a.sources || []).map((s) => `${s.file}, стр. ${s.page}`) })) : undefined,
      doc_value: f.doc_value || undefined });
  };
  const byKey = (k) => fields.find((f) => f.key === k && f.status === 'found') || fields.find((f) => f.key === k) || null;
  const structured = (key, label, value, { unit = null, event_kind = null, quote = null } = {}) => {
    if (value == null || value === '') return null;
    const id = addEv({ id: `e-t-${key}`, source_id: noticeKnown ? 's-notice' : 's-feed', locator: noticeKnown ? `ЕИС: извещение, «${label}»` : 'лента закупок (карточка сервиса)', quote: String(quote ?? value).slice(0, 300), citation_verified: noticeKnown, eligible_for_decision: noticeKnown });
    facts.push({ id: `f-${key}`, key, label, value: String(value), unit, event_kind, status: noticeKnown ? 'verified' : 'unverified', evidence_ids: [id] });
    return id;
  };
  structured('number', 'Номер закупки', tender.number);
  structured('law', 'Закон', law === '44' ? '44-ФЗ' : law === '223' ? '223-ФЗ' : law === 'com' ? 'коммерческая' : law || null);
  structured('nmck', 'НМЦК', tender.price != null ? tender.price.toFixed(2) : null, { unit: tender.currency || 'RUB' });
  structured('bid_deadline', 'Окончание подачи заявок', tender.deadline_at, { event_kind: 'submission_deadline' });
  structured('platform', 'Площадка', tender.platform || null);
  structured('customer_inn', 'ИНН заказчика', tender.customer_inn || null);
  for (const [k, l, o] of [['procurement_method', 'Способ закупки'], ['customer', 'Заказчик'], ['subject', 'Предмет'], ['results_date', 'Подведение итогов', { event_kind: 'results' }],
    ['delivery_place', 'Место поставки'], ['delivery_term', 'Срок поставки'], ['acceptance_term', 'Срок приёмки'], ['payment_terms', 'Оплата'], ['advance', 'Аванс'],
    ['bid_security', 'Обеспечение заявки'], ['contract_security', 'Обеспечение исполнения'], ['warranty', 'Гарантия'], ['warranty_security', 'Обеспечение гарантийных обязательств'],
    ['penalties', 'Пени и штрафы'], ['national_regime', 'Национальный режим'], ['contract_term', 'Срок действия контракта'], ['auction_date', 'Дата и время аукциона', { event_kind: 'auction' }]]) {
    if (!facts.some((f) => f.key === k)) factOf(k, l, byKey(k), o || {});
  }

  // ---------- процедура и календарь ----------
  const nowMs = Date.parse(now);
  const deadlineMs = tender.deadline_at ? Date.parse(tender.deadline_at) : null;
  const closed = deadlineMs != null && deadlineMs <= nowMs;
  const calendar = [];
  calendar.push({ id: 'P-deadline', group: 'procedure', title: 'Окончание подачи заявок', start_event: 'извещение', duration: null, day_kind: null,
    official: tender.deadline_at || null, timezone: tender.deadline_at ? 'UTC в базе; показ — по Москве' : null, internal: null,
    basis: noticeKnown ? 'ЕИС: извещение' : 'лента закупок', state: tender.deadline_at ? (closed ? 'прошёл' : 'действует') : 'не известен' });
  const auctionF = byKey('auction_date');
  const expectedAuction = deadlineMs != null && /аукцион/i.test(String(byKey('procurement_method')?.value || analysis?.card?.meta?.eis_notice?.facts?.procurement_method || '')) ? new Date(deadlineMs + 2 * 3600e3).toISOString() : null;
  calendar.push({ id: 'P-auction', group: 'procedure', title: 'Начало аукциона', start_event: 'окончание подачи заявок', duration: 2, day_kind: 'hours',
    official: auctionF?.value || null, expected_by_rule: expectedAuction, internal: null, basis: '44-ФЗ, п. 23 ч. 1 ст. 42: аукцион через 2 часа после окончания подачи — это ожидаемое время; официальное — по ЕИС и площадке', rule_ids: ['L42'],
    state: auctionF ? 'из документов' : expectedAuction ? 'ожидаемое по норме — сверить с площадкой' : 'не известно' });
  if (auctionF && deadlineMs != null) {
    const a = Date.parse(String(auctionF.value).replace(/(\d{2})\.(\d{2})\.(\d{4})\s*(\d{1,2}):(\d{2})/, '$3-$2-$1T$4:$5:00+03:00'));
    if (Number.isFinite(a) && Math.abs(a - deadlineMs) < 60e3) {
      addFinding({ id: 'C-L42', category: 'conflict', title: 'Время аукциона совпадает с окончанием подачи', details: `В документах аукцион — ${auctionF.value}, тогда как по п. 23 ч. 1 ст. 42 он начинается через два часа после окончания подачи. Официальный календарь не переписан: сверить с ЕИС и площадкой.`,
        evidence_ids: evOfField(auctionF), rule_ids: ['L42'], action_ids: [addAction({ id: 'a-calendar', title: 'Сверить время аукциона и окончания подачи с ЕИС и площадкой', stage: 'analysis' })] });
    }
  }
  calendar.push({ id: 'P-results', group: 'procedure', title: 'Подведение итогов', start_event: null, duration: null, day_kind: null, official: byKey('results_date')?.value || null, internal: null, basis: 'извещение / документация', state: byKey('results_date') ? 'из документов' : 'не известно' });
  for (const k of TERM_KINDS) {
    const f = k.field ? byKey(k.field) : null;
    const p = f?.status === 'found' ? parseTerm(f.value) : null;
    calendar.push({ id: k.id, group: 'contract', title: k.title, text: f?.status === 'found' ? String(f.value) : null,
      start_event: p?.event || null, duration: p?.duration ?? null, unit: p?.unit || null, day_kind: p?.day_kind || null, until: p?.until || null,
      official: null, internal: null, evidence_ids: f?.status === 'found' ? evOfField(f) : [],
      // относительный срок не превращаем в дату без подтверждённого события и календаря
      state: f?.status === 'found' ? (p?.event ? 'относительный срок: дата появится после события' : 'найден текст; событие начала не выделено') : k.field ? 'не найдено в разборе' : 'не извлекается — дочитать проект контракта' });
  }

  // ---------- позиции, характеристики, нацрежим ----------
  const tables = chars?.tables || [];
  const itemsOut = items.map((it) => {
    const t = tables.find((x) => x.item_id === it.id) || null;
    const measure = it.eis_measure || null;
    return {
      item_id: it.id, idx: it.idx, name: it.name, code: it.ktru_code || it.okpd2_code || null, quantity: it.quantity ?? null, unit: it.unit || null,
      offer: t?.offer || null, trademark: t?.trademark || null, country: t?.country || null,
      characteristics: (t?.rows || []).map((r) => ({ name: r.name, requirement: r.tz, fill: r.fill, value: r.value || null, source: r.source, result: r.status === 'product' || r.status === 'fixed' || r.status === 'manual' ? (r.product || r.status !== 'fixed' ? 'pass' : 'unknown') : r.status === 'conflict' ? 'fail' : 'unknown', status: r.status, note: r.note || null })),
      counts: t?.counts || null,
      national_regime: {
        measure, act: measure && measure !== 'нет' ? 'ПП РФ № 1875 (ред. от 30.09.2026)' : null, rule_ids: measure && measure !== 'нет' ? ['L14', 'NR'] : [],
        trigger: measure === 'ограничение' ? 'Заявки с иностранным товаром отклоняются, если подана хотя бы одна соответствующая заявка с российским товаром; наличие такой заявки до торгов неизвестно — это условный риск, а не запрет'
          : measure === 'запрет' ? 'Иностранный товар не допускается' : measure === 'преимущество' ? 'При оценке цена российского товара снижается условно; цена контракта (выручка) не уменьшается' : null,
        origin: t?.country ? `страна: ${t.country} (вписано/со страницы — не подтверждение происхождения)` : 'не указано',
        registry: 'реестровая запись не проверена (ГИСП: доступа нет) — номер должен относиться к производителю, модели и исполнению',
        points: 'баллы/уровень (ПП № 719): не проверены', result: !measure ? 'unknown' : measure === 'нет' ? 'not_applicable' : 'conditional',
      },
    };
  });
  for (const it of itemsOut) {
    const nr = it.national_regime;
    if (nr.measure && nr.measure !== 'нет') {
      addFinding({ id: `NR-${it.item_id}`, category: 'legal_review', title: `Позиция ${it.idx + 1}: ${nr.measure} (ПП 1875)`, details: nr.trigger, evidence_ids: [], rule_ids: nr.rule_ids,
        action_ids: [addAction({ id: `a-origin-${it.item_id}`, title: `Позиция ${it.idx + 1}: подтвердить происхождение конкретной модели (реестровая запись производителя и исполнения)`, stage: 'bid' })] });
    }
    if ((it.counts?.conflict || 0) > 0) {
      addFinding({ id: `PR-${it.item_id}`, category: 'product_mismatch', title: `Позиция ${it.idx + 1}: ${it.counts.conflict} характеристик выбранного товара не проходят по ТЗ`, details: 'Несоответствие выбранной модели — препятствие этой модели, а не всей закупки: можно подобрать другую.',
        action_ids: [addAction({ id: `a-model-${it.item_id}`, title: `Позиция ${it.idx + 1}: подобрать модель, соответствующую ТЗ`, stage: 'suppliers' })] });
    }
  }

  // ---------- поставщики: ступени подтверждения ----------
  const confirmations = deal?.inputs?.price_confirmations || {};
  const offersOut = offers.filter((o) => o.source !== 'contracts').map((o) => {
    const stage = confirmations[o.item_id] && items.find((i) => i.id === o.item_id)?.purchase_offer_id === o.id ? 'confirmed_by_quote'
      : o.match === 'соответствует' ? 'matched' : o.unit_price != null && o.url ? 'page_opened' : 'found_by_search';
    return { offer_id: o.id, item_id: o.item_id, seller: o.seller_name || o.domain || null, inn: o.seller_inn || null, url: o.url || null, title: o.title || null,
      unit_price_minor: kop(o.unit_price), vat: 'не указан на странице', availability: o.availability || null, stock_qty: o.stock_qty ?? null,
      delivery_days: o.delivery_days ?? null, delivery_cost_minor: kop(o.delivery_cost), checked_at: o.price_date || o.created_at || null,
      match: o.match || null, checks: o.match_checks ? { confirmed: o.match_checks.confirmed, total: o.match_checks.of ?? o.match_checks.total, failed: o.match_checks.failed } : null,
      selected: items.some((i) => i.purchase_offer_id === o.id), stage };
  });
  // выбранные и лучше подтверждённые — сверху, дальше по цене
  const STAGE_RANK = { confirmed_by_quote: 0, matched: 1, page_opened: 2, found_by_search: 3 };
  offersOut.sort((x, y) => (y.selected - x.selected) || (STAGE_RANK[x.stage] - STAGE_RANK[y.stage]) || ((Number(x.unit_price_minor) || Infinity) - (Number(y.unit_price_minor) || Infinity)));
  // цена со страницы магазина живёт недолго: выбранный товар с ценой старше 3 дней — перепроверить до подачи
  const PRICE_TTL = 3 * 86400e3;
  for (const o of offersOut.filter((x) => x.selected && x.stage !== 'confirmed_by_quote' && x.checked_at && Date.parse(now) - Date.parse(x.checked_at) > PRICE_TTL)) {
    const days = Math.floor((Date.parse(now) - Date.parse(o.checked_at)) / 86400e3);
    addFinding({ id: `O-old-${o.offer_id}`, category: 'commercial_risk', title: `Цена выбранного товара проверялась ${days} дн. назад`, details: `${o.title || 'товар'}${o.seller ? ` (${o.seller})` : ''}: цена и наличие на странице могли измениться — расчёт опирается на старую цену.`,
      action_ids: [addAction({ id: `a-old-${o.offer_id}`, title: `Перепроверить цену и наличие: ${o.seller || o.title || 'выбранный товар'} (кнопка «Проверить ссылку» на шаге «Поставщики»)`, stage: 'suppliers' })] });
  }

  // ---------- экономика и деньги (существующий расчёт сделки) ----------
  const variantOut = (v) => (!v ? null : {
    title: v.label || v.name, price_minor: v.calc?.price != null ? String(v.calc.price) : null, revenue_net_minor: v.calc?.revenue_net != null ? String(v.calc.revenue_net) : null,
    costs_minor: v.calc?.costs_total != null ? String(v.calc.costs_total) : null, tax_minor: v.calc?.tax != null ? String(v.calc.tax) : null,
    profit_minor: v.calc?.profit != null ? String(v.calc.profit) : null, economy: v.calc?.economy || 'unknown',
    peak_need_minor: v.cash?.peak_need != null ? String(v.cash.peak_need) : null, peak_day: v.cash?.peak_day ?? null, gap_minor: v.cash?.gap != null ? String(v.cash.gap) : null,
    breakeven_minor: v.bounds?.break_even_price != null ? String(v.bounds.break_even_price) : null,
  });
  const base = deal?.variants?.[0] || null;
  const commercial = {
    status: !deal ? 'unknown' : deal.quality?.status === 'verified_snapshot' ? 'verified' : deal.quality?.status === 'incomplete' ? 'unknown' : 'estimate',
    currency: 'RUB', nmck_minor: kop(tender.price), contract_price_minor: base?.calc?.price != null ? String(base.calc.price) : null,
    net_profit_minor: base?.calc?.profit != null ? String(base.calc.profit) : null, funding_peak_minor: base?.cash?.peak_need != null ? String(base.cash.peak_need) : null,
    budget_minor: deal?.inputs?.budget != null ? kop(deal.inputs.budget) : null, budget_gap_minor: base?.cash?.gap != null ? String(base.cash.gap) : null,
    selected_offer_ids: offersOut.filter((o) => o.selected).map((o) => o.offer_id),
    scenarios: deal ? deal.variants.map(variantOut) : [],
    assumptions: (deal?.facts || []).filter((f) => f.status !== 'confirmed').map((f) => `${f.label}: ${f.status === 'missing' ? 'нет данных' : 'оценка'} (${f.source || 'источник не указан'})`),
    missing_inputs: (deal?.quality?.reasons || []).filter((r) => r.level === 'incomplete').map((r) => r.text),
    note: 'Номинал возвратного обеспечения — блокировка денег в календаре, не расход; комиссия гарантии — отдельный расход. Неизвестные затраты не заменены нулём.',
  };
  for (const r of deal?.quality?.reasons || []) {
    if (r.level === 'incomplete' || r.level === 'needs_review') {
      addFinding({ id: `D-${r.code}${r.item_id ? `-${r.item_id}` : ''}`, category: r.level === 'incomplete' ? 'unknown' : 'risk', title: r.text, details: r.action || '',
        rule_ids: r.code === 'antidumping' ? ['L37', 'L96'] : [], action_ids: [addAction({ id: `a-deal-${r.code}${r.item_id ? `-${r.item_id}` : ''}`, title: r.action || r.text, stage: 'calc' })] });
    }
  }

  // ---------- заявка ----------
  const application = {
    package_status: bid ? bid.status : 'needs_input',
    document_readiness: bid?.readiness?.axes?.document_readiness || 'unknown',
    platform_actions_readiness: bid?.readiness?.axes?.platform_actions_readiness || 'unknown',
    supplier_fulfillment_readiness: bid?.readiness?.axes?.supplier_fulfillment_readiness || 'unknown',
    submitted: false,
    checklist: (bid?.checklist || []).map((l) => ({ title: l.title, closure: l.closure_label || l.closure, state: l.state, action: l.action || null })),
    characteristics_problems: chars?.problems || [],
    missing_inputs: [
      ...(!bid ? ['Дело заявки не открыто: на шаге «Заявка» нажмите «Собрать заявку»'] : []),
      ...(bid?.dossier && !bid.dossier.exists ? ['Анкета участника не заполнена'] : []),
      ...((chars?.problems || []).filter((p) => p.level === 'block').map((p) => p.text)),
    ],
    note: 'Внутренний отчёт, закупочные цены и маржа в пакет заявки не входят. Готовность локального пакета ≠ подача.',
  };
  for (const b of bid?.readiness?.blockers || []) {
    if (closed && /срок\s+подачи/i.test(b.text)) continue; // то же, что «Срок подачи заявок прошёл» ниже
    addFinding({ id: `B-${sha(b.text).slice(0, 8)}`, category: b.kind === 'legal_applicability_unknown' ? 'legal_review' : 'application', title: b.text, details: b.reason || '',
      action_ids: [addAction({ id: `a-bid-${sha(b.text).slice(0, 8)}`, title: `Заявка: ${b.text}`, stage: 'bid' })] });
  }

  // ---------- противоречия и риски разбора ----------
  const short = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  for (const f of fields.filter((x) => x.conflict)) {
    // официальное значение из извещения ЕИС (если есть) — рядом с вариантами из документов
    const official = facts.find((x) => x.key === f.key && x.status === 'verified' && x.evidence_ids.some((id) => id.startsWith('e-t-') || id.startsWith('e-n-')));
    const alts = (f.alternatives || []).slice(0, 4).map((a) => `«${short(a.value, 140)}»`);
    addFinding({ id: `X-${f.key}`, category: 'conflict', title: `«${f.label}» указано в документах по-разному`,
      details: `${official ? `В извещении ЕИС: ${official.value}. ` : ''}Варианты в документах: ${alts.join(' / ')}${(f.alternatives || []).length > 4 ? ` и ещё ${f.alternatives.length - 4}` : ''}`,
      evidence_ids: evOfField(f), action_ids: [addAction({ id: `a-x-${f.key}`, title: `Установить действующее значение «${f.label}» (сверить редакции, при необходимости — запрос разъяснений)`, stage: 'analysis' })] });
  }
  for (const [i, r] of (analysis?.card?.risks || []).entries()) {
    // противоречия уже показаны по полям выше — риск того же вида не дублируем
    if (r.type === 'противоречие_в_документации' && fields.some((x) => x.conflict)) continue;
    const text = r.text || r.title || r.risk || r.explanation || '';
    const kind = r.type ? String(r.type).replace(/_/g, ' ') : 'риск';
    addFinding({ id: `R-${i + 1}`, category: 'risk', title: short(`${kind[0].toUpperCase()}${kind.slice(1)}: ${text}`, 160), details: short(r.explanation && r.explanation !== text ? r.explanation : r.impact || '', 600),
      severity: r.level || null,
      evidence_ids: r.source ? [addEv({ id: `e-risk-${i + 1}`, source_id: fileByName(r.source.file)?.id || 's-unknown', locator: `${r.source.file}, стр. ${r.source.page}`, quote: String(r.source.quote || '').slice(0, 300), citation_verified: r.source.verified === true, eligible_for_decision: r.source.verified === true })] : [] });
  }
  if (secondaryOnly) {
    addFinding({ id: 'S-secondary', category: 'unknown', title: 'Есть только аналитический отчёт другой программы', details: 'Его сведения нужно проверять: это пересказ, а не документы заказчика. Нужны сами документы закупки из ЕИС или с площадкие документы ЕИС/площадки.',
      action_ids: [addAction({ id: 'a-primary', title: 'Получить актуальный комплект ЕИС/площадки (извещение, описание объекта, проект контракта, обоснование НМЦК)', stage: 'analysis' })] });
  } else if (missingRoles.length) {
    addFinding({ id: 'S-missing', category: 'unknown', title: `Не получены: ${missingRoles.map((r) => ROLE_LABEL[r]).join(', ')}`, details: 'Этот документ обязателен для такой закупки, а его нет в загруженных файлах. Пока его нет, выводы, которые от него зависят, не окончательные.',
      action_ids: [addAction({ id: 'a-primary', title: 'Догрузить недостающие документы закупки', stage: 'analysis' })] });
  }
  if (closed) addFinding({ id: 'P-closed', category: 'procedure', title: 'Срок подачи заявок прошёл', details: 'Подача на этой стадии невозможна; новые задачи «подать» не создаются.', evidence_ids: facts.find((f) => f.key === 'bid_deadline')?.evidence_ids || [] });

  // ---------- проверки (gates): статус кодом, доказательства — по графу ----------
  const eligible = (ids) => ids.length > 0 && ids.every((id) => evidence.find((e) => e.id === id)?.eligible_for_decision === true);
  const gate = (g, status, rationale, evIds = [], extra = {}) => {
    const ok = status === 'unknown' ? false : eligible(evIds);
    return { gate: g, status: ok || status === 'unknown' ? status : 'unknown', validation_state: ok ? 'verified' : 'unverified', rationale: ok || status === 'unknown' ? rationale : `${rationale} (${extra.unverified_note || 'не подтверждено документами'})`,
      evidence_ids: evIds, rule_ids: extra.rule_ids || [], checked_at: now, valid_until: extra.valid_until || null, hard_stop: Boolean(extra.hard_stop), applicability_reason: extra.applicability_reason || null, conditions: extra.conditions || [] };
  };
  const manifestEv = sources.filter((s) => s.primary && s.received).map((s) => addEv({ id: `e-src-${s.id}`, source_id: s.id, locator: s.kind === 'notice' ? 'ЕИС: извещение' : `файл «${s.name}»`, quote: `${ROLE_LABEL[s.kind] || s.kind}${s.sha256 ? `, SHA256 ${s.sha256.slice(0, 12)}…` : ''}`, citation_verified: true, eligible_for_decision: true }));
  const deadlineEv = facts.find((f) => f.key === 'bid_deadline')?.evidence_ids || [];
  const calcEv = deal ? [addEv({ id: 'e-calc', source_id: 's-calculator', locator: `расчёт сделки, формула ${deal.versions?.formula || '?'}`, quote: `качество данных: ${deal.quality?.status}`, citation_verified: true, eligible_for_decision: deal.quality?.status === 'verified_snapshot' })] : [];
  const nrItems = itemsOut.filter((i) => i.national_regime.result === 'conditional');
  const checks = [
    gate('source_manifest', !expectedKnown ? 'unknown' : missingRoles.length ? 'unknown' : 'pass', !expectedKnown ? 'Неизвестно, какие документы обязательны для этой закупки' : missingRoles.length ? `Не получены: ${missingRoles.map((r) => ROLE_LABEL[r]).join(', ')}` : 'Все обязательные документы закупки загружены', manifestEv),
    gate('reading_general', coverage.general === 'complete' ? 'pass' : 'unknown', `Документация прочитана: ${COV_RU[coverage.general] || coverage.general}`, coverage.general === 'complete' ? manifestEv : []),
    gate('reading_spec', coverage.specification === 'complete' ? 'pass' : 'unknown', `ТЗ (позиции и требования) прочитано: ${COV_RU[coverage.specification] || coverage.specification}`, coverage.specification === 'complete' ? manifestEv : []),
    gate('reading_requirements', coverage.bid_requirements === 'complete' ? 'pass' : 'unknown', `Требования к заявке собраны: ${COV_RU[coverage.bid_requirements] || coverage.bid_requirements}`, coverage.bid_requirements === 'complete' ? manifestEv : []),
    // правовые правила пока справочные (не утверждены человеком) — правовая проверка не может быть «пройдена»
    gate('legal', 'unknown', 'Нормы закона внесены в сервис как справочные и юристом не сверены — вывод «соответствует закону» сервис не делает, нужна проверка человеком', [], { rule_ids: RULES.map((r) => r.id) }),
    closed ? gate('procedure', 'fail', 'Срок подачи заявок прошёл', deadlineEv, { hard_stop: true })
      : !tender.deadline_at ? gate('procedure', 'unknown', 'Срок подачи не известен')
        : gate('procedure', findings.some((f) => f.id === 'C-L42') ? 'conditional' : 'pass', findings.some((f) => f.id === 'C-L42') ? 'Срок подачи действует; время аукциона нужно сверить' : 'Срок подачи действует', deadlineEv, { conditions: findings.some((f) => f.id === 'C-L42') ? ['Сверить время аукциона с ЕИС/площадкой'] : [] }),
    gate('participant', !bid ? 'unknown' : bid.readiness?.conditions?.find((c) => c.key === 'checks')?.ok ? 'pass' : 'unknown', !bid ? 'Дело заявки не открыто — участник не проверен' : 'Проверка участника и подписанта (модуль заявки)', []),
    itemsOut.some((i) => (i.counts?.conflict || 0) > 0) ? gate('product', 'fail', 'У выбранной модели есть характеристики, не проходящие по ТЗ', manifestEv)
      : itemsOut.length && itemsOut.every((i) => i.offer && i.counts && !i.counts.empty && !i.counts.pass)
        ? gate('product', nrItems.length ? 'conditional' : 'pass', 'Значения всех характеристик подтверждены у выбранных товаров', manifestEv, { conditions: nrItems.map((i) => `Позиция ${i.idx + 1}: ${i.national_regime.measure} — подтвердить происхождение модели`) })
        : gate('product', 'unknown', 'Не по всем позициям выбран товар с подтверждёнными характеристиками'),
    offersOut.filter((o) => o.selected).length && items.every((i) => offersOut.some((o) => o.selected && o.item_id === i.id && o.stage === 'confirmed_by_quote'))
      ? gate('supplier', 'pass', 'Цены выбранных предложений подтверждены КП', items.map((i) => { const c = confirmations[i.id]; return addEv({ id: `e-quote-${i.id}`, source_id: 's-supplier', locator: `подтверждение цены: ${c.basis}`, quote: `подтвердил: ${c.by}, ${c.at}`, citation_verified: true, eligible_for_decision: true, checked_at: c.at || now, valid_until: c.valid_until ? new Date(c.valid_until).toISOString() : null }); })) : gate('supplier', 'unknown', 'Цены со страниц продавцов не подтверждены КП (найдено ≠ подтверждено)'),
    !base?.calc || base.calc.economy === 'unknown' ? gate('economics', 'unknown', 'Расчёт не готов: не хватает данных')
      : base.calc.economy === 'loss' ? gate('economics', 'fail', 'Убыток в базовом сценарии при выбранных товарах', calcEv, { hard_stop: true })
        : gate('economics', deal.quality?.status === 'verified_snapshot' ? 'pass' : 'unknown', `Расчёт: ${ECON_RU[base.calc.economy] || base.calc.economy}; данные: ${QUAL_RU[deal.quality?.status] || deal.quality?.status}`, calcEv),
    deal?.axes?.money === 'shortfall' ? gate('funding', 'fail', 'Не хватает своих денег до оплаты заказчика', calcEv, { hard_stop: true, unverified_note: 'расчёт на оценках — станет препятствием, когда цены подтвердятся' })
      : deal?.axes?.money === 'sufficient' ? gate('funding', 'pass', 'Своих денег хватает по календарю денег', calcEv) : gate('funding', 'unknown', 'Не указано, сколько своих денег; финансовая исполнимость не проверена'),
  ];

  // служебные источники, на которые ссылаются доказательства (не документы закупки — в полноту не входят)
  const AUX = { 's-feed': ['aggregator', 'Лента закупок сервиса (карточка из ЕИС)'], 's-calculator': ['calculation', 'Расчёт сделки сервиса'],
    's-supplier': ['supplier', 'Подтверждения цен поставщиков (КП, письма)'], 's-unknown': ['manual', 'Файл не определён по ссылке разбора'] };
  for (const id of new Set(evidence.map((e) => e.source_id))) {
    if (AUX[id] && !sources.some((s) => s.id === id)) sources.push({ id, kind: AUX[id][0], name: AUX[id][1], url: null, received: true, primary: false, sha256: null, revision: null, coverage: null, limitations: ['Служебный источник сервиса, не документ закупки'] });
  }

  // ---------- рекомендация кодом ----------
  const snapshot = { id: null, input_revision: input.input_revision || sha({ tender: tender.id, now }), as_of: now, mode: 'live', rules_version: RULES_VERSION,
    // полный анализ не обращается к нейросети: сводит готовый разбор документации (его промпты — в самом разборе)
    prompts_version: analysis ? `разбор документации № ${analysis.id}` : 'не применялись',
    calculator_version: deal?.versions?.formula || null, builder_version: BUILDER_VERSION };
  const scope = { procurement_number: tender.number, lot_id: null, law: law === '44' ? '44fz' : law === '223' ? '223fz' : law || 'unknown', procedure: String(byKey('procurement_method')?.value || analysis?.card?.meta?.eis_notice?.facts?.procurement_method || 'не установлена'), basis: noticeKnown ? 'primary' : secondaryOnly ? 'reported' : 'partial' };
  const report = { schema_version: SCHEMA_VERSION, snapshot, scope, source_manifest, coverage, sources, evidence, facts, checks, findings, actions, commercial, application,
    rules: RULES.map((r) => ({ id: r.id, topic: r.topic, act: r.act, reference: r.reference, url: r.url, verification_state: r.verification_state, effective_from: r.effective_from, effective_until: r.effective_until })) };
  const decision = evaluateReport(report, { now, currentInputRevision: snapshot.input_revision });
  // 223-ФЗ без положения заказчика и неизвестный режим — правовая ветка не поддержана
  if (law !== '44') decision.unsupported = law === '223' ? 'Ветка 223-ФЗ: нужно положение заказчика — правовая проверка не завершена' : 'Режим закупки не поддержан правовыми правилами — 44-ФЗ по умолчанию не применяется';

  // ---------- план действий от текущего времени ----------
  for (const a of actions) {
    if (closed && ['bid', 'suppliers', 'calc'].includes(a.stage)) { a.status = 'blocked'; a.due_reason = 'Срок подачи прошёл — действие для этой процедуры недоступно'; continue; }
    if (deadlineMs != null && ['bid', 'suppliers', 'calc', 'analysis'].includes(a.stage)) { a.due_at = new Date(deadlineMs - 24 * 3600e3).toISOString(); a.due_reason = 'внутренний срок: за сутки до окончания подачи (официальный срок не меняется)'; if (Date.parse(a.due_at) < nowMs) a.status = 'overdue'; }
    else a.due_reason = 'срок не назначен: нет подтверждённого дедлайна';
  }

  report.decision = decision;
  report.expected_decision = decision.recommendation;
  report.calendar = calendar;
  report.items = itemsOut;
  report.offers = offersOut;
  report.sections = sectionsOf(report, { tender, closed });
  return report;
}

const COV_RU = { complete: 'полностью', partial: 'частично', failed: 'не прочитано', unknown: 'неизвестно' };
const ECON_RU = { profitable: 'прибыльно', loss: 'убыточно', break_even: 'в ноль', below_target: 'прибыль ниже цели', unknown: 'не рассчитано' };
const QUAL_RU = { verified_snapshot: 'подтверждены', calculated_with_estimates: 'с оценками', needs_review: 'нужна сверка', incomplete: 'неполные' };
const PACKAGE_RU = { draft: 'собирается', needs_input: 'не хватает данных', needs_review: 'нужна проверка', blocked: 'заблокирована', prepared_for_transfer: 'готова к переносу на площадку', transfer_verified: 'перенос проверен', stale: 'устарела', unsupported: 'не поддерживается' };
const REC_TEXT = { insufficient_data: 'Недостаточно данных', do_not_participate: 'Не участвовать', participate_with_conditions: 'Участвовать с условиями', participate: 'Участвовать' };

/** Двенадцать разделов шаблона: у каждого статус и короткое резюме; пустой раздел — с причиной и действием. */
function sectionsOf(r, { tender, closed }) {
  const d = r.decision;
  const gateTitle = { source_manifest: 'комплект документов', reading_general: 'чтение документации', reading_spec: 'чтение ТЗ', reading_requirements: 'требования к заявке', legal: 'правовая проверка', procedure: 'процедура и сроки', participant: 'участник', product: 'товар', supplier: 'поставщики', economics: 'экономика', funding: 'деньги' };
  const why = d.recommendation === 'do_not_participate' ? `подтверждённые препятствия: ${d.hard_stops.map((g) => gateTitle[g] || g).join(', ')}`
    : d.recommendation === 'insufficient_data' ? `не подтверждено: ${d.unknown_gates.map((g) => gateTitle[g] || g).join(', ') || 'полнота источников'}` : 'применимые проверки пройдены';
  const st = (ok, partial) => (ok ? 'verified' : partial ? 'needs_review' : 'needs_input');
  const items = r.items || [];
  return [
    { id: 'decision', title: 'Решение и следующие действия', status: d.recommendation === 'insufficient_data' ? 'needs_input' : 'verified', summary: `${REC_TEXT[d.recommendation]}: ${why}.${closed ? ' Срок подачи прошёл.' : ''}` },
    { id: 'passport', title: 'Паспорт закупки', status: r.scope.basis === 'primary' ? 'verified' : 'reported', summary: `${tender.number} — ${tender.title || ''}`.trim() },
    { id: 'coverage', title: 'Что прочитано и чего не хватает', status: st(r.source_manifest.expected_set_known && !r.source_manifest.missing_known_roles.length, r.sources.length > 0), summary: `Первичных файлов получено: ${r.source_manifest.received_primary_count}; ${r.source_manifest.missing_known_roles.length ? `не хватает: ${r.source_manifest.missing_known_roles.map((k) => ROLE_LABEL[k] || k).join(', ')}` : r.source_manifest.expected_set_known ? 'обязательные документы есть' : 'полный комплект не установлен'}. Прочитано: документация — ${COV_RU[r.coverage.general] || r.coverage.general}, ТЗ — ${COV_RU[r.coverage.specification] || r.coverage.specification}, требования к заявке — ${COV_RU[r.coverage.bid_requirements] || r.coverage.bid_requirements}.` },
    { id: 'participant', title: 'Требования к участнику', status: st(r.checks.find((c) => c.gate === 'participant')?.status === 'pass', r.application.checklist.length > 0), summary: r.application.checklist.length ? `Требований в списке: ${r.application.checklist.length}` : 'Дело заявки не открыто — требования к участнику не собраны.' },
    { id: 'products', title: 'Товары и национальный режим', status: st(r.checks.find((c) => c.gate === 'product')?.status === 'pass', items.length > 0), summary: items.length ? `Позиций: ${items.length}; с выбранным товаром: ${items.filter((i) => i.offer).length}; мера нацрежима: ${[...new Set(items.map((i) => i.national_regime.measure).filter(Boolean))].join(', ') || 'не известна'}.` : 'Позиции не загружены.' },
    { id: 'contract', title: 'Контракт и обязательства', status: 'needs_review', summary: 'Условия — по разбору документации с местом в документе; проверка норм — справочными правилами (не утверждены).' },
    { id: 'calendar', title: 'Календарь', status: 'needs_review', summary: `Сроков контракта с текстом: ${r.calendar.filter((c) => c.group === 'contract' && c.text).length} из 14; остальные — дочитать проект контракта.` },
    { id: 'suppliers', title: 'Поставщики', status: st(r.checks.find((c) => c.gate === 'supplier')?.status === 'pass', r.offers.length > 0), summary: r.offers.length ? `Предложений: ${r.offers.length}; подтверждено КП: ${r.offers.filter((o) => o.stage === 'confirmed_by_quote').length}; совпало с ТЗ: ${r.offers.filter((o) => o.stage === 'matched').length}.` : 'Предложений нет — поиск поставщиков не запускался или ничего не найдено.' },
    { id: 'economics', title: 'Экономика и деньги', status: r.commercial.status === 'verified' ? 'verified' : r.commercial.status === 'estimate' ? 'needs_review' : 'needs_input', summary: r.commercial.net_profit_minor != null ? `Плановая прибыль ${(Number(r.commercial.net_profit_minor) / 100).toLocaleString('ru-RU')} ₽ (${r.commercial.status === 'verified' ? 'подтверждено' : 'оценка'}).` : 'Не рассчитано.' },
    { id: 'issues', title: 'Проблемы и вопросы', status: r.findings.length ? 'needs_review' : 'verified', summary: `Замечаний: ${r.findings.length} (это не число нарушений заказчика).` },
    { id: 'application', title: 'Заявка и план действий', status: r.application.package_status === 'prepared_for_transfer' || r.application.package_status === 'transfer_verified' ? 'verified' : 'needs_input', summary: `Заявка: ${PACKAGE_RU[r.application.package_status] || r.application.package_status}; подана: нет. Задач: ${r.actions.length}.` },
    { id: 'sources', title: 'Основания и история', status: 'reported', summary: `Источников: ${r.sources.length}; ссылок на документы: ${r.evidence.length}; норм закона: ${r.rules.length} (справочные, юристом не сверены).` },
  ];
}

module.exports = { buildReport, parseTerm, roleOf, TERM_KINDS, REC_TEXT, SCHEMA_VERSION, BUILDER_VERSION, ROLE_LABEL };
