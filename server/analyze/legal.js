// Правовой вывод по документации закупки: есть ли в условиях противоречия закону и что с этим делать.
//
// Итог — одно из двух: «отказаться от участия» или «направить обращение заказчику» (тогда собирается письмо
// «О спорных вопросах и предложениях по их разрешению»); если спорного нет — «замечаний нет».
// Откуда берутся замечания:
//   1) числовые нормы (срок оплаты, размеры обеспечений) проверяет код — по значениям из карточки разбора;
//   2) остальное — нейросеть: по найденным рискам и полям, со ссылкой только на нормы из перечня.
// Номера статей нейросеть не называет: она выбирает норму из config/legal-norms.json по идентификатору. Нормы
// не из перечня отбрасываются, замечание тогда помечается «норма требует проверки юристом».
// Это предварительная проверка, а не юридическое заключение.

const fs = require('node:fs');
const path = require('node:path');
const { LegalSchema, callJson } = require('./json');

const DEFAULT_NORMS = path.join(__dirname, '..', '..', 'config', 'legal-norms.json');
const loadPrompt = () => fs.readFileSync(path.join(__dirname, 'prompts', 'legal.md'), 'utf8');

let cache = null;
/** Перечень норм: {checked_at, checked_source, norms: [{id, law, article, title, rule, source}]}. Файла нет — пустой. */
function loadNorms(file = DEFAULT_NORMS) {
  try {
    const stat = fs.statSync(file);
    const stamp = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (cache?.stamp === stamp) return cache.data;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = {
      checked_at: raw.checked_at || null, checked_source: raw.checked_source || null,
      norms: (raw.norms || []).filter((n) => n && n.id && n.article && n.rule),
      // к чему относится норма: по этим словам проверяется, что нейросеть привязала её по теме
      // у нормы есть applies — слова, по которым она считается относящейся к замечанию (см. legalReview)
    };
    cache = { stamp, data };
    return data;
  } catch {
    return { checked_at: null, checked_source: null, norms: [] };
  }
}

const allFields = (card) => (card.groups || []).flatMap((g) => g.fields || []);
const fieldOf = (card, key) => allFields(card).find((f) => f.key === key && f.status === 'found' && String(f.value || '').trim()) || null;
const num = (s) => Number(String(s).replace(/\s/g, '').replace(',', '.'));

/** Первый процент в значении поля: «5 % от НМЦК» → 5. */
function pctOf(value) {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:%|процент)/i.exec(String(value || ''));
  const v = m ? num(m[1]) : NaN;
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

/** НМЦК из карточки: «1 234 567,89 руб.» → число. */
function nmckOf(card) {
  const m = /(\d[\d\s]{3,}(?:[.,]\d{1,2})?)/.exec(String(fieldOf(card, 'nmck')?.value || ''));
  const v = m ? num(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Срок оплаты: «в течение 30 календарных дней» → {days: 30, kind: 'календарных'}; kind — null, если вид дней не назван. */
function payDays(value) {
  const m = /(\d{1,3})\s*(?:\([^)]{0,40}\)\s*)?(рабочих|рабочего|банковских|календарных|календарного)?\s*(?:дн|день|дня)/i.exec(String(value || ''));
  if (!m) return null;
  const kind = /рабоч|банков/i.test(m[2] || '') ? 'рабочих' : /календар/i.test(m[2] || '') ? 'календарных' : null;
  return { days: Number(m[1]), kind };
}

/** Какой закон у закупки: '44' | '223' | 'com' | null. */
function lawOf(card, tender) {
  if (tender?.law) return String(tender.law);
  const v = String(fieldOf(card, 'law')?.value || '');
  return /44/.test(v) ? '44' : /223/.test(v) ? '223' : null;
}

/** Замечания по числовым нормам 44-ФЗ — без нейросети, по значениям из карточки разбора. */
function ruleIssues(card, { law }) {
  if (law !== '44') return [];
  const out = [];
  const add = (key, why, normId, proposal) => {
    const f = fieldOf(card, key);
    out.push({ origin: 'rule', field: key, condition: `${f.label}: ${String(f.value).replace(/\s+/g, ' ').trim().slice(0, 300)}`, why, norm_id: normId, proposal, fatal: false, sources: (f.sources || []).slice(0, 2) });
  };

  const pay = payDays(fieldOf(card, 'payment_terms')?.value);
  if (pay && ((pay.kind === 'рабочих' && pay.days > 7) || (pay.kind === 'календарных' && pay.days > 14) || (!pay.kind && pay.days > 10))) {
    add('payment_terms', `в документации срок оплаты — ${pay.days} ${pay.kind || ''} дней, а закон отводит заказчику не более семи рабочих дней (до десяти — только в прямо названных случаях)`.replace(/\s+/g, ' '),
      '44-34-13.1', 'Изложить условие в редакции: «Оплата производится в срок не более 7 (семи) рабочих дней с даты подписания заказчиком документа о приёмке».');
  }

  const contract = pctOf(fieldOf(card, 'contract_security')?.value);
  if (contract != null && (contract > 30 || (contract > 0 && contract < 0.5))) {
    add('contract_security', `обеспечение исполнения контракта установлено в размере ${contract}%, а закон допускает от 0,5% до 30% начальной (максимальной) цены контракта`,
      '44-96-6', 'Установить размер обеспечения исполнения контракта в пределах от 0,5% до 30% начальной (максимальной) цены контракта.');
  }

  const bid = pctOf(fieldOf(card, 'bid_security')?.value);
  const nmck = nmckOf(card);
  if (bid != null && bid > 0) {
    // предел зависит от НМЦК; если она не известна, замечание — только при превышении большего из пределов
    const limit = nmck == null ? 5 : nmck > 20e6 ? 5 : 1;
    if (bid > limit || bid < 0.5) {
      add('bid_security', `обеспечение заявки установлено в размере ${bid}%, а закон допускает от 0,5% до ${limit}% начальной (максимальной) цены контракта${nmck == null ? '' : nmck > 20e6 ? ' (цена выше 20 млн ₽)' : ' (цена не выше 20 млн ₽)'}`,
        '44-44-2', `Установить размер обеспечения заявки в пределах от 0,5% до ${limit}% начальной (максимальной) цены контракта.`);
    }
  }

  // Заказчик оставил право одностороннего отказа только себе.
  const termination = String(fieldOf(card, 'termination')?.value || '');
  if (/(поставщик|исполнител|подрядчик)\S*[^.]{0,60}(таким\s+правом\s+не\s+обладает|не\s+вправе[^.]{0,60}(отказ|расторг)|не\s+имеет\s+права[^.]{0,60}(отказ|расторг))/i.test(termination)) {
    add('termination', 'контракт даёт право одностороннего отказа только заказчику, а закон даёт такое право и поставщику, если оно есть у заказчика',
      '44-95-9-19', 'Дополнить контракт условием: «Поставщик вправе принять решение об одностороннем отказе от исполнения контракта по основаниям, предусмотренным Гражданским кодексом Российской Федерации».');
  }

  const warranty = pctOf(fieldOf(card, 'warranty_security')?.value);
  if (warranty != null && warranty > 10) {
    add('warranty_security', `обеспечение гарантийных обязательств установлено в размере ${warranty}%, а закон допускает не более 10% начальной (максимальной) цены контракта`,
      '44-96-2.2', 'Установить размер обеспечения гарантийных обязательств не более 10% начальной (максимальной) цены контракта.');
  }
  return out;
}

// Расходные материалы и запасные части к оборудованию заказчика: норма о товарных знаках прямо разрешает называть
// их модель без слов «или эквивалент». Нейросеть это исключение пропускает, поэтому проверяем сами.
const CONSUMABLES = /картридж|тонер|расходнS*s+материал|запаснS*s+част|запчаст|фотобарабан|драм-?юнит|комплектS*s+(?:для|к)s/i;

/**
 * Правовой вывод по карточке разбора.
 * @param {{card: {groups, risks}, tender?: object, llm?: object, norms?: object, onUsage?: Function}} p
 * @returns {Promise<object>} {verdict, decision, reasons, issues, law, norms_checked_at, notes, llm_used}
 */
async function legalReview({ card, tender = null, llm = null, norms = loadNorms(), onUsage = () => {}, now = new Date() }) {
  const law = lawOf(card, tender);
  const known = norms.norms.filter((n) => String(n.law) === String(law));
  const byId = new Map(known.map((n) => [n.id, n]));
  const notes = [];
  const raw = ruleIssues(card, { law });
  let reasons = [];
  let llmUsed = false;

  const risks = card.risks || [];
  if (llm) {
    const fields = allFields(card).filter((f) => f.status === 'found').map((f) => ({ key: f.key, label: f.label, value: String(f.value).slice(0, 500) }));
    try {
      const { data, usage } = await callJson(llm, {
        system: loadPrompt(), schema: LegalSchema, task: 'legal',
        user: JSON.stringify({
          law: law === '44' ? '44-ФЗ' : law === '223' ? '223-ФЗ' : law === 'com' ? 'коммерческая закупка' : 'не определён',
          fields, risks: risks.map((r, i) => ({ n: i + 1, type: r.type, level: r.level, explanation: r.explanation })),
          norms: known.map((n) => ({ id: n.id, article: n.article, title: n.title, rule: n.rule })),
        }, null, 1),
      });
      onUsage(usage);
      llmUsed = true;
      reasons = data.reasons;
      const seenRisks = new Set();
      for (const x of data.issues) {
        const risk = x.risk != null ? risks[x.risk - 1] : null;
        const field = x.field ? fieldOf(card, x.field) : null;
        // Норма принимается, только если она из перечня и по теме замечания: нейросеть иногда берёт «ближайшую».
        const topic = `${x.condition} ${x.why} ${risk?.explanation || ''} ${field?.label || ''}`;
        const candidate = x.norm_id && byId.has(x.norm_id) ? byId.get(x.norm_id) : null;
        const normId = candidate && (!candidate.applies || new RegExp(candidate.applies, 'i').test(topic)) ? candidate.id : null;
        // то же, что уже нашла числовая проверка, или тот же риск второй раз — не повторяем
        if (normId && raw.some((r) => r.norm_id === normId)) continue;
        if (risk && seenRisks.has(x.risk)) continue;
        if (risk) seenRisks.add(x.risk);
        if (!x.condition.trim() || !x.why.trim()) continue;
        if (normId === '44-33-1-1' && CONSUMABLES.test(`${x.condition} ${fieldOf(card, 'subject')?.value || ''} ${tender?.title || ''}`)) {
          notes.push('Модель расходных материалов или запасных частей к оборудованию заказчика названа без слов «или эквивалент» — закон это допускает, поэтому условие не отмечено как спорное.');
          continue;
        }
        raw.push({ origin: 'llm', field: field ? x.field : null, condition: x.condition.trim().slice(0, 500), why: x.why.trim().slice(0, 700), norm_id: normId,
          proposal: x.proposal.trim().slice(0, 700), fatal: x.fatal, sources: ((risk || field)?.sources || []).slice(0, 2) });
      }
    } catch (err) {
      onUsage(err.usage);
      notes.push(`Нейросеть не ответила на правовую проверку (${String(err.message).slice(0, 160)}) — проверены только числовые нормы: срок оплаты и размеры обеспечений.`);
    }
  } else {
    notes.push('Проверены только числовые нормы: срок оплаты и размеры обеспечений.');
  }

  if (law !== '44') {
    notes.push(law === '223' || law === 'com'
      ? 'Для закупок по 223-ФЗ и коммерческих перечень норм не составлен: там действует положение о закупке самого заказчика. Спорные условия показаны без ссылок на закон — их нужно проверить у юриста.'
      : 'Закон, по которому идёт закупка, не определён — спорные условия показаны без ссылок на нормы.');
  }

  const issues = raw.map(({ norm_id: id, ...x }) => {
    const n = id ? byId.get(id) : null;
    return { ...x, norm: n ? { id: n.id, article: n.article, title: n.title, rule: n.rule, source: n.source || null } : null, needs_lawyer: !n };
  });
  const fatal = issues.filter((x) => x.fatal);
  // Запрос разъяснений по 44-ФЗ подаётся не позднее чем за три дня до окончания подачи заявок.
  const deadline = tender?.deadline_at ? new Date(tender.deadline_at) : null;
  const requestBy = law === '44' && deadline && !Number.isNaN(deadline.getTime()) ? new Date(deadline.getTime() - 3 * 86400000) : null;
  const tooLate = Boolean(requestBy && requestBy.getTime() < now.getTime());
  // Отказ — только когда серьёзное условие уже не оспорить: срок запроса истёк. Иначе сначала обращение к заказчику.
  const decision = !issues.length ? 'замечаний нет' : fatal.length && tooLate ? 'отказаться от участия' : 'направить обращение';
  if (!issues.length) reasons = ['Спорных условий в документации не найдено.'];
  else if (decision === 'отказаться от участия') reasons = ['Срок подачи запроса разъяснений истёк, а условия, с которыми участвовать не стоит, остались:', ...fatal.map((x) => x.why)];
  else {
    reasons = [`Спорных условий: ${issues.length}. Их можно снять обращением к заказчику до подачи заявки.`];
    if (fatal.length) reasons.push(`Серьёзных: ${fatal.length}. Если заказчик не изменит эти условия — от участия лучше отказаться.`);
    if (tooLate) reasons.push('Срок подачи запроса разъяснений уже истёк: остаётся участвовать на этих условиях или не участвовать.');
  }
  return {
    verdict: issues.length ? 'есть спорные условия' : 'противоречий не найдено',
    decision, reasons: reasons.slice(0, 5), issues, law,
    request_by: requestBy ? requestBy.toISOString() : null, request_too_late: tooLate,
    with_norm: issues.filter((x) => x.norm).length,
    norms_checked_at: norms.checked_at, norms_source: norms.checked_source,
    notes: [...new Set(notes)], llm_used: llmUsed,
  };
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Письмо заказчику «О спорных вопросах и предложениях по их разрешению». Только текст: сервис его не отправляет.
 * @param {{legal, tender?, customer?, title?, now?: Date}} p customer — из извещения (customer.js)
 * @returns {{addressee, subject, body, send_by, basis}|null} null — письмо не нужно (замечаний нет или решено отказаться)
 */
function buildLetter({ legal, tender = null, customer = {}, title = '', now = new Date() }) {
  if (!legal || legal.decision !== 'направить обращение' || !legal.issues?.length) return null;
  const is44 = String(legal.law) === '44';
  const person = customer.person || null;
  const org = customer.org || customer.placer || null;
  const greeting = customer.first_name && customer.middle_name && customer.first_name.length > 2
    ? `Уважаемый(ая) ${customer.first_name} ${customer.middle_name}!` : person ? `Уважаемый(ая) ${person}!` : 'Уважаемые коллеги!';
  const purchase = tender ? `№ ${tender.number} «${oneLine(tender.title)}»` : oneLine(title) || '[номер и предмет закупки]';
  const subject = `О спорных вопросах и предложениях по их разрешению — закупка ${tender ? `№ ${tender.number}` : oneLine(title).slice(0, 80)}`;

  const lines = [
    `Кому: ${[person || '[ФИО контактного лица заказчика — см. извещение]', org || '[наименование заказчика]'].join(', ')}`,
    ...(customer.email || customer.phone ? [`Контакты заказчика: ${[customer.email, customer.phone].filter(Boolean).join(', ')}`] : []),
    'От: [наименование вашей организации, ИНН, контактное лицо, телефон, электронная почта]',
    '',
    is44 ? 'Запрос о даче разъяснений положений извещения об осуществлении закупки' : 'Запрос разъяснений положений документации о закупке',
    'О спорных вопросах и предложениях по их разрешению',
    '',
    `Закупка ${purchase}`,
    '',
    greeting,
    '',
    `Изучив извещение и документацию о закупке, просим разъяснить перечисленные ниже положения и рассмотреть наши предложения по их изменению${is44 ? ' (запрос направляется на основании части 5 статьи 42 Федерального закона от 05.04.2013 № 44-ФЗ)' : ''}. Предлагаемые редакции просим учесть в проекте контракта.`,
    '',
  ];
  legal.issues.forEach((x, i) => {
    lines.push(`${i + 1}. ${oneLine(x.condition)}`);
    for (const s of x.sources || []) lines.push(`   Где указано: ${s.file}, стр. ${s.page}: «${oneLine(s.quote).slice(0, 300)}»`);
    lines.push(`   В чём вопрос: ${oneLine(x.why)}`);
    lines.push(x.norm ? `   Норма: ${x.norm.article}. ${oneLine(x.norm.rule)}` : '   Норма: [укажите применимую норму после проверки юристом]');
    if (x.proposal) lines.push(`   Предлагаем: ${oneLine(x.proposal)}`);
    lines.push('');
  });
  lines.push('Просим разместить разъяснения в установленный срок и при необходимости внести изменения в извещение и проект контракта.', '',
    `${now.toLocaleDateString('ru-RU')}`, '[должность, ФИО, подпись]');

  // Запрос по 44-ФЗ можно подать не позднее чем за три дня до окончания подачи заявок.
  const deadline = tender?.deadline_at ? new Date(tender.deadline_at) : null;
  const sendBy = is44 && deadline && !Number.isNaN(deadline.getTime()) ? new Date(deadline.getTime() - 3 * 86400000).toISOString() : null;
  return {
    addressee: { person, org, email: customer.email || null, phone: customer.phone || null },
    subject, body: lines.join('\n'), send_by: sendBy,
    basis: is44 ? 'часть 5 статьи 42 Закона № 44-ФЗ: запрос подаётся через электронную площадку, не более трёх запросов, не позднее чем за три дня до окончания подачи заявок' : null,
  };
}

module.exports = { legalReview, buildLetter, ruleIssues, loadNorms, payDays, pctOf, nmckOf, lawOf };
