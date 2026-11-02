// Список «что приложить к заявке» по конкретной закупке: по каждому применимому требованию — что требуется,
// откуда требование, чем оно закрывается (документ участника, сведения анкеты, заявление, документ на товар,
// действие на площадке) и в каком это состоянии. Нейросети здесь нет: список строится из реестра требований,
// анкеты участника и его документов.
//
// Состояния строки:
//   ok                      — есть и годится;
//   missing                 — нет (документа, сведений, выбранного товара);
//   expired                 — срок действия документа истёк;
//   expires_before_deadline — документ действует сегодня, но истечёт до окончания подачи заявок;
//   needs_confirm           — есть, но человек ещё не подтвердил (документ не отмечен проверенным, декларация не подтверждена);
//   not_required            — человек отметил «не требуется» с причиной (исходный вывод сервиса сохраняется в auto_state);
//   info                    — к сведению: в состав заявки не входит (цена на торгах, обеспечение контракта, документы «на баллы»).

const { DOC_KIND, docStatus } = require('./dossier');

const CLOSURE = {
  dossier_data: 'сведения анкеты участника',
  dossier_document: 'документ участника',
  registry: 'сведения в реестре участников закупок',
  attestation: 'заявление участника',
  product: 'сведения и документы на товар',
  price: 'цена предложения',
  action: 'действие на площадке',
  review: 'проверка человеком',
};

// Какие документы участника называют заказчики в составе заявки — по словам в тексте требования.
const MENTIONS = [
  ['egrip_extract', /выписк[а-яё]*\s+из\s+(един[а-яё]*\s+государственн[а-яё]*\s+реестр[а-яё]*\s+индивидуальн|ЕГРИП)/i],
  ['egrul_extract', /выписк[а-яё]*\s+из\s+(един[а-яё]*\s+государственн[а-яё]*\s+реестр[а-яё]*\s+юридическ|ЕГРЮЛ)/i],
  ['power_of_attorney', /доверенност/i],
  ['license', /лиценз/i],
  ['sro', /саморегулир|(?<![а-яё])СРО(?![а-яё])/i],
  ['experience', /опыт[а-яё]*\s+(исполнени|поставк|выполнени|работ)|исполненн[а-яё]*\s+(контракт|договор)/i],
  ['sme_extract', /реестр[а-яё]*\s+(субъектов\s+)?мал[а-яё]*\s+и\s+средн/i],
  ['usn_notice', /упрощ[её]нн[а-яё]*\s+систем/i],
  ['charter', /устав|учредительн[а-яё]*\s+документ/i],
  ['head_appointment', /назначени[а-яё]*\s+(на\s+должность|руководител)|полномочи[а-яё]*\s+руководител/i],
  ['major_deal', /крупн[а-яё]*\s+сделк/i],
];

/** Виды документов участника, названные в тексте заказчика: [{kind, fragment}] — fragment — слова, по которым узнано. */
function detectDocKinds(text) {
  const out = [];
  for (const [kind, re] of MENTIONS) {
    const m = String(text || '').match(re);
    if (m) out.push({ kind, fragment: String(text).slice(Math.max(0, m.index - 40), m.index + m[0].length + 60).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/**
 * Подобрать документ из хранилища: сначала действующий на день окончания подачи и проверенный, затем
 * действующий непроверенный, затем остальные.
 * @returns {{document, state, candidates}}
 */
function pickDocument(docs, kinds, { now, deadline, chosenId = null }) {
  const candidates = docs.filter((d) => kinds.includes(d.kind) && !d.archived_at);
  if (!candidates.length) return { document: null, state: 'missing', candidates };
  const rank = (d) => { const s = docStatus(d, { now, deadline }); return (s === 'expired' ? 4 : s === 'expires_before_deadline' ? 2 : 0) + (d.verified_at ? 0 : 1); };
  const chosen = chosenId ? candidates.find((d) => d.id === chosenId) : null;
  const document = chosen || [...candidates].sort((a, b) => rank(a) - rank(b) || b.id - a.id)[0];
  const s = docStatus(document, { now, deadline });
  const state = s === 'expired' ? 'expired' : s === 'expires_before_deadline' ? 'expires_before_deadline' : document.verified_at ? 'ok' : 'needs_confirm';
  return { document, state, candidates };
}

const docBrief = (d) => (d ? { id: d.id, kind: d.kind, title: d.title, file_name: d.file_name, issued_at: d.issued_at, valid_until: d.valid_until, verified_at: d.verified_at } : null);
const docNote = (state, d, kinds) => {
  const names = kinds.map((k) => `«${DOC_KIND.get(k)?.label || k}»`).join(' или ');
  if (state === 'missing') return `В хранилище документов участника нет документа ${names}`;
  if (state === 'expired') return `Срок действия документа «${d.title}» истёк ${d.valid_until}`;
  if (state === 'expires_before_deadline') return `Документ «${d.title}» действует до ${d.valid_until} — это раньше окончания подачи заявок`;
  if (state === 'needs_confirm') return `Документ «${d.title}» загружен, но не отмечен проверенным`;
  return `Документ «${d.title}»${d.valid_until ? `, действует до ${d.valid_until}` : ''}, проверен ${String(d.verified_at).slice(0, 10)}`;
};
const docAction = (state, kinds) => (state === 'missing' ? `Получите документ и загрузите его в «Профиль» → «Документы участника»${DOC_KIND.get(kinds[0])?.where ? `. Где взять: ${DOC_KIND.get(kinds[0]).where}` : ''}`
  : state === 'expired' || state === 'expires_before_deadline' ? 'Получите свежий документ и замените файл в «Профиль» → «Документы участника»'
    : state === 'needs_confirm' ? 'Откройте документ, убедитесь, что он верный и читается, и поставьте отметку «проверено мной»' : null);

/**
 * @param ctx {
 *   requirements — реестр после проверки (validate); classification — сценарий;
 *   dossier — анкета с state и documents (dossier.get()) или null; deadline — срок окончания подачи (ISO) или null;
 *   now — дата; choices — решения человека по строкам: [{line_id, document_id, not_required, reason, by, at}];
 *   itemNames — Map(id позиции → название)
 * }
 * @returns {Array} строки списка
 */
function buildChecklist({ requirements = [], classification = null, dossier = null, deadline = null, now = new Date(), choices = [], itemNames = new Map() }) {
  if (!classification?.supported) return [];
  const docs = dossier?.documents || [];
  const kind = dossier?.kind || 'ip';
  const choiceOf = new Map(choices.map((c) => [c.line_id, c]));
  const lines = [];
  const basis = (r) => ({ origin: r.origin, rule_ids: r.legal_rule_ids || [], rule_status: r.rule_status || null, sources: r.sources || [] });
  const push = (l) => {
    const line = { requirement_id: null, obligation: 'mandatory', document: null, candidates: [], doc_kinds: [], note: null, action: null, basis: null, ...l, closure_label: CLOSURE[l.closure] };
    line.auto_state = line.state;
    const c = choiceOf.get(line.id);
    if (c?.not_required) { line.state = 'not_required'; line.choice = { not_required: true, reason: c.reason, by: c.by, at: c.at }; }
    else if (c?.document_id) line.choice = { document_id: c.document_id, by: c.by, at: c.at };
    lines.push(line);
  };
  const docLine = (o, kinds) => {
    const chosenId = choiceOf.get(o.id)?.document_id || null;
    const p = pickDocument(docs, kinds, { now, deadline, chosenId });
    push({ ...o, closure: 'dossier_document', doc_kinds: kinds, state: p.state, document: docBrief(p.document), candidates: p.candidates.map(docBrief), note: docNote(p.state, p.document, kinds), action: docAction(p.state, kinds) });
  };

  // --- сведения об участнике ---
  const st = dossier?.state;
  push({
    id: 'dossier-data', title: 'Сведения об участнике: ФИО или наименование, ИНН, адрес, банковские реквизиты, контакты', closure: 'dossier_data',
    state: !dossier ? 'missing' : st.complete ? 'ok' : 'missing',
    note: !dossier ? 'Анкета участника не заполнена' : st.complete ? `Анкета заполнена: ${dossier.name}` : `В анкете не заполнено: ${st.missing.map((m) => m.label).join(', ')}`,
    action: !dossier || !st.complete ? 'Заполните анкету: «Профиль» → «Анкета участника»' : null,
    basis: { origin: 'service', rule_ids: [], rule_status: null, sources: [] },
  });
  if (dossier?.data?.signer === 'representative') {
    docLine({ id: 'signer-poa', title: `Доверенность на представителя, который подписывает заявку${dossier.data.signer_fio ? ` (${dossier.data.signer_fio})` : ''}`, basis: { origin: 'service', rule_ids: [], rule_status: null, sources: [] } }, ['power_of_attorney']);
  }

  // --- по реестру требований ---
  const applies = requirements.filter((r) => r.applicability === 'applies');
  const manual = (r) => (r.decision === 'pass' && r.verification_state === 'manual_verified' ? r.reason : null);
  const techByItem = new Map();
  for (const r of applies) {
    const inBid = ['registration', 'application'].includes(r.stage);
    // показатели товара — одной строкой на позицию: вместе с правилом «предложение о товаре» и страной происхождения
    if (r.scope?.item_id != null && (r.category === 'technical' || ['product', 'origin'].includes(r.evidence_kind))) {
      if (!techByItem.has(r.scope.item_id)) techByItem.set(r.scope.item_id, []);
      techByItem.get(r.scope.item_id).push(r);
      continue;
    }
    const b = basis(r);
    const common = { id: `line-${r.id}`, requirement_id: r.id, title: r.requirement, obligation: r.obligation, basis: b };
    if (r.evidence_kind === 'registry_check') {
      const d = dossier?.data || {};
      const until = d.eruz_valid_until ? new Date(`${d.eruz_valid_until}T23:59:59Z`).getTime() : null;
      const state = manual(r) ? 'ok' : !dossier ? 'missing' : !until || !d.eruz_checked_at ? 'needs_confirm' : until < now.getTime() ? 'expired' : deadline && until < new Date(deadline).getTime() ? 'expires_before_deadline' : 'ok';
      push({
        ...common, closure: 'registry', state,
        note: manual(r) || (!dossier ? 'Анкета участника не заполнена' : !until ? 'В анкете не указано, до какой даты действует регистрация в едином реестре участников закупок'
          : !d.eruz_checked_at ? 'В анкете не указано, когда вы сверяли свои сведения в реестре участников'
            : state === 'expired' ? `Регистрация в реестре участников закончилась ${d.eruz_valid_until}`
              : state === 'expires_before_deadline' ? `Регистрация в реестре участников действует до ${d.eruz_valid_until} — это раньше окончания подачи заявок`
                : `Регистрация в реестре участников действует до ${d.eruz_valid_until}, сведения сверены ${d.eruz_checked_at}`),
        action: state === 'ok' ? null : state === 'expired' || state === 'expires_before_deadline' ? 'Продлите регистрацию в едином реестре участников закупок на сайте zakupki.gov.ru и обновите дату в анкете'
          : 'Откройте свою запись в едином реестре участников закупок (zakupki.gov.ru), сверьте сведения и впишите в анкету срок регистрации и дату сверки',
      });
    } else if (r.evidence_kind === 'attestation') {
      push({ ...common, closure: 'attestation', state: r.decision === 'pass' ? 'ok' : 'needs_confirm', note: r.decision === 'pass' ? r.reason : 'Положения декларации не подтверждены', action: r.decision === 'pass' ? null : 'Нажмите «Подтвердить декларацию» в перечне требований ниже' });
    } else if (r.evidence_kind === 'document') {
      const kinds = /оценк|балл/i.test(r.requirement) || r.obligation === 'evaluation_only' ? ['experience'] : ['license', 'sro', 'experience'];
      if (r.obligation === 'evaluation_only' && !docs.some((d) => kinds.includes(d.kind))) push({ ...common, closure: 'dossier_document', doc_kinds: kinds, state: 'info', note: 'Документы для оценки заявки влияют на баллы, а не на допуск. Без них заявку не отклонят', action: 'Если хотите получить баллы — загрузите документы об опыте в «Документы участника»' });
      else if (manual(r)) push({ ...common, closure: 'dossier_document', doc_kinds: kinds, state: 'ok', note: manual(r) });
      else docLine(common, kinds);
    } else if (r.evidence_kind === 'price_confirmation') {
      push({ ...common, closure: 'price', state: !inBid ? 'info' : r.decision === 'pass' ? 'ok' : 'needs_confirm',
        note: !inBid ? 'Цена подаётся на торгах, файлом в заявку не прикладывается' : r.decision === 'pass' ? r.reason : 'Цена предложения не утверждена', action: !inBid || r.decision === 'pass' ? null : r.required_action });
    } else if (r.evidence_kind === 'security') {
      push({ ...common, closure: 'action', state: !inBid ? 'info' : r.decision === 'pass' ? 'ok' : 'needs_confirm',
        note: !inBid ? 'В состав заявки не входит: понадобится при заключении контракта' : r.decision === 'pass' ? r.reason : r.reason || 'Обеспечение заявки не подтверждено', action: !inBid || r.decision === 'pass' ? null : r.required_action });
    } else {
      // состав заявки по документации, структура частей, источник, без которого перечень неполон
      push({ ...common, closure: 'review', state: !inBid ? 'info' : r.decision === 'pass' ? 'ok' : r.verification_state === 'unavailable' ? 'missing' : 'needs_confirm', note: r.reason, action: r.decision === 'pass' ? null : r.required_action });
      // документы участника, которые заказчик называет в составе заявки
      if (r.id === 'req-doc-application-composition' && r.sources?.length) {
        for (const m of detectDocKinds(r.requirement)) {
          const k = DOC_KIND.get(m.kind);
          const o = { id: `doc-${m.kind}`, requirement_id: r.id, title: `Заказчик называет в составе заявки: ${k.label}`, obligation: 'mandatory', basis: { ...b, fragment: m.fragment } };
          if (!k.for.includes(kind)) push({ ...o, closure: 'dossier_document', doc_kinds: [m.kind], state: 'info', note: `Этот документ бывает только у ${kind === 'ip' ? 'организаций' : 'предпринимателей'} — к вам не относится` });
          else if (m.kind === 'power_of_attorney' && dossier?.data?.signer !== 'representative') push({ ...o, closure: 'dossier_document', doc_kinds: [m.kind], state: 'info', note: 'Доверенность нужна, только если заявку подписывает представитель. В анкете указано, что подписываете вы сами' });
          else if (m.kind === 'power_of_attorney' && lines.some((l) => l.id === 'signer-poa')) continue;
          else docLine(o, [m.kind]);
        }
      }
    }
  }

  // --- товар: одна строка на позицию ---
  for (const [itemId, list] of techByItem) {
    const tech = list.filter((r) => r.category === 'technical' && r.origin === 'tender_document');
    const rule = list.find((r) => r.origin === 'rule' && r.category === 'technical') || list[0];
    const origin = list.find((r) => r.evidence_kind === 'origin');
    const failed = tech.filter((r) => r.decision === 'fail');
    const unknown = tech.filter((r) => r.decision === 'unknown');
    const notChosen = tech.some((r) => /не выбран/i.test(r.reason || ''));
    const name = itemNames.get(itemId) || (rule.requirement.match(/позиция «(.+)»$/) || [])[1] || `позиция ${itemId}`;
    const state = failed.length || notChosen ? 'missing' : unknown.length || (origin && origin.decision !== 'pass') || !tech.length ? 'needs_confirm' : 'ok';
    push({
      id: `item-${itemId}`, requirement_id: rule.id, title: `Предложение о товаре — «${name}»: модель, изготовитель, показатели${origin ? ', страна происхождения' : ''}`, closure: 'product', obligation: 'mandatory', basis: basis(rule),
      state,
      note: notChosen ? 'Товар для этой позиции не выбран' : failed.length ? `Выбранный товар не соответствует ТЗ: показателей с другим значением — ${failed.length}`
        : !tech.length ? 'Требования ТЗ к этой позиции не прочитаны — сверять не с чем'
          : unknown.length ? `Показателей ТЗ: ${tech.length}; не подтверждено документом изготовителя: ${unknown.length}`
            : origin && origin.decision !== 'pass' ? 'Страна происхождения товара не подтверждена' : `Все показатели ТЗ подтверждены: ${tech.length}`,
      action: notChosen ? 'Выберите товар на шаге «Поставщики»' : failed.length ? 'Выберите подходящий товар или получите разъяснение заказчика'
        : state === 'ok' ? null : 'Запросите у поставщика документ изготовителя на предлагаемую модель и отметьте показатели выполненными в перечне требований',
    });
  }
  return lines;
}

/**
 * Проверены ли участник и его документы для этой закупки: анкета заполнена, и каждая обязательная строка
 * про сведения участника, его документы и реестр участников — «есть» или снята человеком как «не требуется».
 */
function dossierChecked(lines, dossier) {
  if (!dossier?.state?.complete) return false;
  return lines.filter((l) => ['dossier_data', 'dossier_document', 'registry'].includes(l.closure) && l.state !== 'info' && l.obligation !== 'evaluation_only')
    .every((l) => l.state === 'ok' || l.state === 'not_required');
}

/**
 * Перенести подтверждённое анкетой и документами в решения реестра: проверенная регистрация в реестре участников
 * и действующий проверенный документ закрывают требование без отдельной кнопки «отметить выполненным».
 */
function applyChecklist(requirements, lines) {
  const byReq = new Map();
  for (const l of lines) if (l.requirement_id && ['registry', 'dossier_document'].includes(l.closure) && l.id === `line-${l.requirement_id}`) byReq.set(l.requirement_id, l);
  return requirements.map((r) => {
    const l = byReq.get(r.id);
    if (!l || r.decision === 'pass' || r.applicability !== 'applies' || l.state !== 'ok') return r;
    return { ...r, decision: 'pass', verification_state: 'verified', reason: `По анкете участника: ${l.note}`, evidence_ids: [...(r.evidence_ids || []), l.document ? `dossier-doc-${l.document.id}` : 'dossier'] };
  });
}

module.exports = { buildChecklist, dossierChecked, applyChecklist, detectDocKinds, pickDocument, CLOSURE };
