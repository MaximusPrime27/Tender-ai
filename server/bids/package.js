// Файлы заявки, их повторная проверка и папка для переноса на площадку.
// Файлы составляются только под требования этой закупки: какие части есть в заявке и что в какую часть идёт,
// определяет сценарий (закон и способ закупки). Значения берутся из подтверждённых данных: анкеты участника,
// проверенных документов, выбранного товара с показателями и утверждённой человеком цены. Чего нет — в черновике
// стоит явная метка «заполнить»; с такой меткой итоговая выгрузка невозможна.
// Сервис ничего не подаёт и не подписывает: архив — это папка для ручного переноса, а не поданная заявка.

const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const XLSX = require('xlsx');
const { makeDocx } = require('./docx-writer');
const { applicationBlocks } = require('./application');
const { FIELDS, TAX_REGIMES, SME } = require('./dossier');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** Метка незаполненного места: по ней черновик отличается от готового файла. */
const todo = (what) => `[ЗАПОЛНИТЬ: ${what}]`;
const TODO_RE = /\[ЗАПОЛНИТЬ[:\]]/;
const hasTodo = (v) => TODO_RE.test(String(v ?? ''));

const PART_TITLE = { application: 'заявка', 'part-1': 'первая часть заявки', 'part-2': 'вторая часть заявки', price: 'ценовое предложение' };

/**
 * В какую часть заявки идёт документ этого вида — по сценарию. null — файлом не подаётся.
 * Закупки среди малого бизнеса по 223-ФЗ (кроме запроса котировок): товар — в первую часть, участник — во вторую,
 * цена — отдельно; сведения об участнике и цена в первой части — основание отклонения.
 */
function partFor(kind, scenario) {
  const smeParts = ['223_sme_eauction', '223_sme_ecompetition', '223_sme_eproposal'].includes(scenario);
  if (kind === 'product') return smeParts ? 'part-1' : 'application';
  if (kind === 'participant') return /^44_/.test(scenario) ? null : smeParts ? 'part-2' : 'application'; // по 44-ФЗ сведения об участнике передаёт площадка
  if (kind === 'price') return ['44_equotation', '223_sme_equotation'].includes(scenario) ? 'application' : ['223_sme_ecompetition', '223_sme_eproposal'].includes(scenario) ? 'price' : null;
  if (kind === 'declaration') return smeParts ? 'part-2' : 'application';
  return 'application';
}

const money = (n) => `${Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} руб.`;
/** «Да», «есть», «наличие» → true; «Нет», «отсутствует», «без» → false; иное — null. */
const yesNo = (s) => { const t = String(s ?? '').trim().toLowerCase(); return /^(да|есть|имеется|наличие)(?![а-яё])/.test(t) ? true : /^(нет|отсутств|без)/.test(t) ? false : null; };
/** Первое число в тексте: «не менее 10000» → 10000, «1,5» → 1.5. */
const numOf = (s) => { const m = /(\d[\d\s]*(?:[.,]\d+)?)/.exec(String(s ?? '')); return m ? Number(m[1].replace(/\s/g, '').replace(',', '.')) : NaN; };
const fileSafe = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);

/** Значение поля анкеты для документа: человеческое, а не код из базы. */
function dossierValue(key, data) {
  const v = data[key];
  if (v === undefined || v === null || v === '') return null;
  if (key === 'tax_regime') return TAX_REGIMES[v] || v;
  if (key === 'sme') return SME[v] || v;
  if (key === 'vat_payer') return v ? 'да' : 'нет';
  if (key === 'signer') return v === 'self' ? 'лично' : 'представитель по доверенности';
  return String(v);
}

/**
 * Составить файлы и поля заявки.
 * @param ctx {
 *   tender, classification, requirements, checklist, items: [{id, name, quantity, unit}],
 *   chosen: Map(itemId → {offer: {title, seller}}), dossier (или null), price: {value, by, at} | null,
 *   declaration: {set, confirmed: [ids], by, at} | null — набор положений и то, что из них подтверждено,
 *   forms: [{name, buffer, sha256}] — формы заказчика из документации, originals: [{line, document, buffer}]
 * }
 * @returns {{files, fields, actions, problems}}
 *   files: [{id, path, part, purpose, kind: 'generated'|'original'|'form', buffer, expect: [{label, value, required}], todo: число меток, draft, reason}]
 */
function buildPackage(ctx) {
  const { tender, classification, requirements = [], checklist = [], items = [], chosen = new Map(), dossier = null, price = null, declaration = null, forms = [], originals = [], chars = null, customer = null } = ctx;
  const scenario = classification?.scenario || null;
  const files = [];
  const fields = [];
  const actions = [];
  const problems = [];
  if (!classification?.supported) return { files, fields, actions, problems: [{ kind: 'unsupported', text: 'Для этого вида закупки подготовка заявки не поддерживается' }] };
  // конкурс по 44-ФЗ: пока не установлено, сколько частей в заявке, раскладывать документы по частям нельзя
  if (classification.variant === 'unknown') return { files, fields, actions, problems: [{ kind: 'structure_unknown', text: 'Структура заявки не установлена (число частей зависит от критериев оценки) — файлы не составляются, чтобы цена и сведения об участнике не попали в неподходящую часть' }] };

  const applies = requirements.filter((r) => r.applicability === 'applies');
  // Закупка по цене единицы (ч. 24 ст. 22 44-ФЗ): количества нет ни у одной позиции, товар поставляется по заявкам —
  // в предложении количество не указывается, это не пропуск
  const byUnitPrice = items.length > 0 && items.every((i) => i.quantity == null || i.quantity === '');
  const qtyText = (it) => (it.quantity != null && it.quantity !== '' ? `${it.quantity} ${it.unit || ''}`.trim()
    : byUnitPrice ? 'по заявкам заказчика в пределах цены контракта (закупка по цене единицы товара)' : todo(`количество — «${it.name}»`));
  const head = [`Закупка № ${tender.number}`, tender.title].filter(Boolean);
  const add = (f) => {
    const texts = [...(f.expect || []).map((e) => e.value), ...(f.extraText || [])];
    files.push({ kind: 'generated', draft: false, ...f, todo: texts.filter(hasTodo).length, sha256: sha256(f.buffer), bytes: f.buffer.length });
  };
  const field = (part, key, label, value, source) => fields.push({ part, part_title: PART_TITLE[part] || part, key, label, value: value ?? todo(label), filled: value != null && !hasTodo(value), source });
  const d = dossier?.data || {};
  const dkind = dossier?.kind || 'ip';
  const who = dossier ? dossier.name : todo('участник закупки — заполните анкету');

  // --- предложение о товаре ---
  const productPart = partFor('product', scenario);
  const anonymous = productPart === 'part-1'; // в первой части нет сведений об участнике и цены
  const blocks = [{ h: 'Предложение участника закупки в отношении объекта закупки' }, ...head.map((p) => ({ p, align: 'center' })), { space: true }];
  const expect = [];
  const sheet = [['Позиция', 'Показатель', 'Требование заказчика', 'Предлагаемое значение']];
  let unconfirmed = 0;
  for (const it of items) {
    const pick = chosen.get(it.id) || null;
    // Характеристики для заявки по позиции (char-service): требование ТЗ с инструкцией заказчика → значение в заявку,
    // товарный знак и страна. Если их нет — по-старому, из реестра требований и страницы выбранного товара.
    const ct = (chars?.tables || []).find((t) => t.item_id === it.id) || null;
    const pos = `Позиция ${(it.idx ?? 0) + 1}`;
    if (ct) {
      const model = pick?.offer?.title || ct.offer?.title || todo(`модель товара по позиции «${it.name}» — выберите товар на шаге «Поставщики» или укажите модель`);
      const rows = [['Показатель', 'Требование заказчика', 'Предлагаемое значение'],
        ['Наименование и модель товара', it.name, model],
        ['Изготовитель, товарный знак', 'при наличии', ct.trademark || todo(`товарный знак — «${it.name}» (нет знака — «отсутствует»)`)],
        ['Страна происхождения товара', '—', ct.country || todo(`страна происхождения — «${it.name}»`)],
        ['Количество', `${it.quantity ?? ''} ${it.unit || ''}`.trim() || '—', qtyText(it)]];
      for (const r of ct.rows || []) {
        // «да» при требовании «Нет» (и наоборот) — противоречие ТЗ, даже если сверка его пропустила
        // (25.10: «Наличие сканера отпечатка пальца: Нет → да» ушло в предложение о товаре)
        const flip = yesNo(r.tz) != null && yesNo(r.value) != null && yesNo(r.tz) !== yesNo(r.value);
        // число в 10 и более раз больше нижней границы ТЗ — вероятно, лишний ноль («не менее 10000» → «100000»)
        const big = /не менее|не меньше|от\s/i.test(String(r.tz || '')) && numOf(r.tz) > 0 && numOf(r.value) >= numOf(r.tz) * 10;
        if (big) problems.push({ kind: 'suspicious_value', text: `${pos}, «${r.name}»: значение ${r.value} в ${Math.round(numOf(r.value) / numOf(r.tz))} раз больше требования «${r.tz}» — проверьте, нет ли лишнего нуля` });
        const value = r.status === 'conflict' || flip ? todo(`«${r.name}»: у выбранного товара «${r.product || r.value}» — не соответствует ТЗ («${r.tz}»)`)
          : r.value ? String(r.value) : todo(`«${r.name}» — значение по документу изготовителя`);
        if (r.value && ['pass', 'product'].includes(r.status)) unconfirmed++;
        rows.push([`${r.name}${r.unit && !String(r.name).includes(r.unit) ? `, ${r.unit}` : ''}`, r.tz || '', value]);
      }
      blocks.push({ p: `Позиция ${(it.idx ?? 0) + 1}: ${it.name}`, bold: true }, { table: rows });
      for (const row of rows.slice(1)) { expect.push({ label: row[0], value: row[2], required: true, item: it.name }); sheet.push([`${pos}. ${it.name}`, ...row]); }
      field(productPart, `item-${it.id}-model`, `${pos} — модель товара`, hasTodo(model) ? null : model, 'выбранный товар');
      field(productPart, `item-${it.id}-trademark`, `${pos} — товарный знак`, ct.trademark || null, 'характеристики для заявки');
      field(productPart, `item-${it.id}-country`, `${pos} — страна происхождения`, ct.country || null, 'характеристики для заявки');
      for (const r of ct.rows || []) field(productPart, `item-${it.id}-ch-${r.name}`, `${pos} — ${r.name}`, r.value && r.status !== 'conflict' ? String(r.value) : null, 'характеристики для заявки');
      continue;
    }
    const tech = applies.filter((r) => r.scope?.item_id === it.id && r.category === 'technical' && r.origin === 'tender_document');
    const model = pick?.offer?.title || todo(`модель товара по позиции «${it.name}» — выберите товар на шаге «Поставщики»`);
    const rows = [['Показатель', 'Требование заказчика', 'Предлагаемое значение'],
      ['Наименование и модель товара', it.name, model],
      ['Изготовитель, товарный знак', 'при наличии', todo(`изготовитель и товарный знак — «${it.name}»`)],
      ['Страна происхождения товара', '—', todo(`страна происхождения — «${it.name}»`)],
      ['Количество', `${it.quantity ?? ''} ${it.unit || ''}`.trim() || '—', qtyText(it)]];
    for (const r of tech) {
      // значение товара берётся из подтверждённого; найденное только на странице продавца — показывается, но помечается
      const known = r.candidate_value != null && String(r.candidate_value).trim() !== '';
      const value = r.decision === 'fail' ? todo(`«${r.normalized?.field}»: у выбранного товара «${r.candidate_value}» — не соответствует ТЗ`)
        : known ? String(r.candidate_value) : todo(`«${r.normalized?.field || r.requirement}» — значение по документу изготовителя`);
      if (known && r.decision !== 'pass' && r.decision !== 'fail') unconfirmed++;
      rows.push([r.normalized?.field || r.requirement, r.normalized?.value || '', value]);
    }
    blocks.push({ p: `Позиция: ${it.name}`, bold: true }, { table: rows });
    for (const row of rows.slice(1)) { expect.push({ label: row[0], value: row[2], required: true, item: it.name }); sheet.push([it.name, ...row]); }
    field(productPart, `item-${it.id}-model`, `Модель товара — «${it.name}»`, pick?.offer?.title || null, 'выбранный товар');
    field(productPart, `item-${it.id}-country`, `Страна происхождения — «${it.name}»`, null, 'документ изготовителя');
    for (const r of tech) field(productPart, `item-${it.id}-${r.id}`, `${r.normalized?.field || r.requirement} — «${it.name}»`, r.decision === 'pass' && r.candidate_value != null ? String(r.candidate_value) : null, 'показатель товара');
  }
  if (!items.length) problems.push({ kind: 'no_items', text: 'У закупки нет позиций — предложение о товаре составить не из чего' });
  else if (!anonymous) {
    // Заявка одним документом — по образцу заявок владельца (bids/application.js): участник, заказчик, товар таблицей,
    // декларация, реквизиты. Цена в таблице — только когда она подаётся в заявке (котировки, закупочная сессия).
    const appRows = items.map((it) => {
      const ct = (chars?.tables || []).find((t) => t.item_id === it.id) || null;
      const pick = chosen.get(it.id) || null;
      return { name: it.name, unit: it.unit, quantity: it.quantity, unit_price: it.unit_price,
        country: ct?.country || todo(`страна происхождения — «${it.name}»`),
        model: pick?.offer?.title || ct?.offer?.title || todo(`модель товара — «${it.name}» (выберите товар на шаге «Поставщики»)`) };
    });
    const withPrice = Boolean(partFor('price', scenario)) && partFor('price', scenario) !== 'price';
    const attachments = originals.map((o) => o.line.title);
    const app = applicationBlocks({ tender, procedure: classification.procedure, customer: customer || {}, dossier, rows: appRows, price: withPrice && price ? price.value : null, attachments, todo });
    add({ id: 'application-form', path: `uploads/${productPart}/Заявка на участие.docx`, part: productPart,
      purpose: 'Заявка одним документом по образцу ваших заявок: участник и заказчик, товар, декларация, реквизиты счёта',
      buffer: makeDocx(app.blocks), expect: app.expect });
  }
  if (items.length) {
    if (!anonymous) blocks.push({ space: true }, { p: `Участник закупки: ${who}${d.inn ? `, ИНН ${d.inn}` : ''}` });
    add({
      id: 'product-proposal', path: `uploads/${productPart}/Предложение о товаре.docx`, part: productPart, purpose: 'Предложение в отношении объекта закупки: модель, изготовитель, страна происхождения и показатели каждой позиции',
      buffer: makeDocx(blocks), expect, extraText: anonymous ? [] : [who], unconfirmed,
      forbid: anonymous ? [d.inn, d.fio, d.full_name, d.phone, d.email].filter(Boolean) : [],
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), 'Показатели');
    add({ id: 'product-table', path: `uploads/${productPart}/Показатели товара.xlsx`, part: productPart, purpose: 'Те же показатели таблицей — для переноса в поля площадки', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
      expect: expect.map((e) => ({ ...e })), forbid: anonymous ? [d.inn, d.fio, d.full_name, d.phone, d.email].filter(Boolean) : [] });
    if (unconfirmed) problems.push({ kind: 'unconfirmed_values', text: `В предложении о товаре есть значения со страницы продавца, не подтверждённые документом изготовителя: ${unconfirmed}` });
  }

  // --- сведения об участнике ---
  const participantPart = partFor('participant', scenario);
  const rowsP = [['Сведения', 'Значение']];
  const expectP = [];
  for (const [key, label, required] of FIELDS[dkind]) {
    if (key.startsWith('eruz_') || (key === 'signer_fio' && d.signer !== 'representative')) continue;
    const v = dossierValue(key, d);
    if (v == null && !required) continue;
    const value = v ?? todo(`${label} — заполните анкету участника`);
    rowsP.push([label, value]);
    expectP.push({ label, value, required: true });
    if (participantPart) field(participantPart, `participant-${key}`, label, v, 'анкета участника');
  }
  if (participantPart) {
    add({ id: 'participant-info', path: `uploads/${participantPart}/Сведения об участнике.docx`, part: participantPart, purpose: 'Сведения об участнике закупки',
      buffer: makeDocx([{ h: 'Сведения об участнике закупки' }, ...head.map((p) => ({ p, align: 'center' })), { space: true }, { table: rowsP }]), expect: expectP });
  } else {
    actions.push({ kind: 'registry', text: 'Сведения об участнике заказчику передаёт оператор площадки из единого реестра участников закупок — отдельным файлом они не подаются. Убедитесь, что в реестре они совпадают с анкетой.' });
  }

  // --- декларация: по умолчанию подтверждается на площадке; файлом — только если так требует закупка ---
  const declReq = applies.find((r) => r.evidence_kind === 'attestation');
  if (declReq) {
    const set = declaration?.set || null;
    const list = (set?.statements || []).filter((s) => !s.only || s.only === dkind);
    const confirmed = new Set(declaration?.confirmed || []);
    const allConfirmed = list.length > 0 && list.every((s) => confirmed.has(s.id));
    const asFile = declReq.channel === 'upload' || checklist.some((l) => l.requirement_id === 'req-doc-application-composition' && /деклараци/i.test(l.title));
    if (asFile && list.length) {
      const part = partFor('declaration', scenario);
      const rowsD = [['Основание', 'Положение', 'Подтверждение'], ...list.map((s) => [s.ref, s.text, confirmed.has(s.id) ? `подтверждено: ${declaration.by}, ${String(declaration.at).slice(0, 10)}` : todo('подтвердите положение')])];
      add({ id: 'declaration', path: `uploads/${part}/Декларация о соответствии${allConfirmed ? '' : ' (проект)'}.docx`, part, purpose: `${set.title} (${set.article})`, draft: !allConfirmed,
        reason: allConfirmed ? null : 'не каждое положение подтверждено — в итоговую выгрузку не идёт',
        buffer: makeDocx([{ h: set.title }, { p: set.article, align: 'center' }, ...head.map((p) => ({ p, align: 'center' })), { space: true }, { p: `Участник закупки: ${who} — подтверждает:` }, { table: rowsD }]),
        expect: list.map((s) => ({ label: s.ref, value: confirmed.has(s.id) ? 'подтверждено' : todo('подтвердите положение'), required: true })) });
    } else {
      actions.push({ kind: 'declaration', done: allConfirmed, text: `Декларацию о соответствии подтвердите на площадке при подаче заявки — отдельный файл для неё не нужен.${list.length ? ` Положений: ${list.length}; подтверждено вами в сервисе: ${list.filter((s) => confirmed.has(s.id)).length}.` : ''}`, statements: list.map((s) => ({ ref: s.ref, text: s.text, confirmed: confirmed.has(s.id) })) });
    }
    if (set?.status !== 'verified') problems.push({ kind: 'declaration_draft', text: 'Положения декларации в сервисе — черновик, не сверенный с действующей редакцией закона. Действует текст декларации на площадке' });
  }

  // --- цена: только утверждённая человеком и только когда она подаётся в заявке ---
  const pricePart = partFor('price', scenario);
  const priceReq = applies.find((r) => r.category === 'price');
  if (pricePart) {
    const value = price ? money(price.value) : todo('цена предложения — утвердите её на шаге «Заявка»');
    // НДС: только по явному ответу в анкете; ставку и сумму сервис не подставляет
    const vat = d.vat_payer === false ? 'НДС не облагается' : d.vat_payer === true ? todo('ставка и сумма НДС в цене') : todo('плательщик ли НДС — укажите в анкете');
    const rowsC = [['Сведения', 'Значение'], ['Цена предложения', value], ['НДС', vat]];
    add({ id: 'price-proposal', path: `uploads/${pricePart}/Ценовое предложение.docx`, part: pricePart, purpose: 'Ценовое предложение участника',
      buffer: makeDocx([{ h: 'Ценовое предложение' }, ...head.map((p) => ({ p, align: 'center' })), { space: true }, { table: rowsC }, ...(pricePart === 'price' ? [] : [{ p: `Участник закупки: ${who}${d.inn ? `, ИНН ${d.inn}` : ''}` }])]),
      expect: [{ label: 'Цена предложения', value, required: true }, { label: 'НДС', value: vat, required: true }] });
    field(pricePart, 'price', 'Цена предложения', price ? money(price.value) : null, 'утверждена вами');
  } else if (priceReq) {
    actions.push({ kind: 'price', text: 'Цена подаётся на торгах, а не файлом в заявке. Подготовьте её отдельно: ниже какой цены вы не опускаетесь, видно на шаге «Расчёт».' });
  }

  // --- оригиналы участника, которые требует эта закупка: без изменений ---
  for (const o of originals) {
    const part = participantPart || 'application';
    files.push({ id: `original-${o.document.id}`, kind: 'original', path: `uploads/${part}/${fileSafe(o.document.file_name || o.document.title)}`, part, purpose: `${o.line.title} — оригинал из документов участника`,
      buffer: o.buffer, sha256: sha256(o.buffer), bytes: o.buffer.length, expected_sha256: o.document.sha256, todo: 0, draft: false, expect: [] });
  }
  // --- формы заказчика: кладутся как есть, заполняет человек ---
  for (const f of forms) {
    files.push({ id: `form-${f.sha256.slice(0, 8)}`, kind: 'form', path: `forms/${fileSafe(f.name.split('/').pop())}`, part: null, purpose: 'Форма из документации заказчика — заполняется вручную; значения для неё — в списке полей',
      buffer: f.buffer, sha256: sha256(f.buffer), bytes: f.buffer.length, expected_sha256: f.sha256, todo: 0, draft: false, expect: [] });
  }
  if (forms.length) actions.push({ kind: 'forms', text: `В документации заказчика есть формы (${forms.length}). Сервис их не заполняет: они лежат в папке forms без изменений, значения для них — в файлах etp-fields. Заполните формы сами.` });

  // --- действия на площадке и невыполненные строки списка «что приложить» ---
  for (const r of applies.filter((x) => x.evidence_kind === 'security' && x.stage === 'application')) actions.push({ kind: 'security', done: r.decision === 'pass', text: `Обеспечение заявки: ${r.reason || r.requirement}. Расчётная сумма, платёжка или проект гарантии обеспечением не считаются.` });
  for (const l of checklist.filter((x) => !['ok', 'not_required', 'info'].includes(x.state))) problems.push({ kind: 'checklist', line_id: l.id, text: `${l.title}: ${l.note || l.state}` });
  return { files, fields, actions, problems };
}

// ---------- повторное чтение составленных файлов ----------
const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[″|]/g, ' ').replace(/[\s ]+/g, ' ').trim();

/**
 * Прочитать файл обратно и сверить с тем, из чего он составлен.
 * @param file {path, buffer, kind, expect: [{label, value, required}], forbid: [строки, которых в файле быть не должно], expected_sha256}
 * @param extract async ({name, buffer}) → [{status, pages: [{text}]}] — чтение файла (server/extract)
 * @returns {Promise<{ok, issues: [{kind, text}]}>}
 *   row_lost — строка таблицы пропала; value_lost — подпись есть, а значения нет; placeholder — осталась метка
 *   «заполнить»; unreadable — файл не читается; leak — в файле сведения, которых в этой части быть не должно;
 *   changed — оригинал изменился (не совпал sha256).
 */
async function verifyFile(file, extract) {
  const issues = [];
  if (file.kind !== 'generated') {
    if (file.expected_sha256 && sha256(file.buffer) !== file.expected_sha256) issues.push({ kind: 'changed', text: 'Файл отличается от загруженного оригинала (не совпала контрольная сумма)' });
    return { ok: !issues.length, issues };
  }
  let text = '';
  try {
    const parts = await extract({ name: file.path.split('/').pop(), buffer: file.buffer });
    if (!parts.length || parts.some((p) => p.status !== 'ok')) issues.push({ kind: 'unreadable', text: 'Составленный файл не читается обратно' });
    text = parts.flatMap((p) => (p.pages || []).map((pg) => pg.text || '')).join('\n');
  } catch (err) { issues.push({ kind: 'unreadable', text: `Составленный файл не читается обратно: ${err.message}` }); }
  if (!issues.length) {
    const lines = text.split('\n').map(norm).filter(Boolean);
    const whole = norm(text);
    for (const e of file.expect || []) {
      const label = norm(e.label);
      const value = norm(e.value);
      const at = lines.filter((l) => l.includes(label));
      if (!at.length) { issues.push({ kind: 'row_lost', text: `В файле нет строки «${e.label}»${e.item ? ` (позиция «${e.item}»)` : ''}` }); continue; }
      if (e.required && !value) { issues.push({ kind: 'value_lost', text: `Пустое обязательное поле «${e.label}»` }); continue; }
      if (value && !at.some((l) => l.includes(value)) && !whole.includes(value)) issues.push({ kind: 'value_lost', text: `У строки «${e.label}» в файле нет значения «${String(e.value).slice(0, 80)}»` });
    }
    const marks = (text.match(/\[ЗАПОЛНИТЬ[:\]]/g) || []).length;
    if (marks) issues.push({ kind: 'placeholder', text: `В файле остались незаполненные места: ${marks}` });
    for (const bad of file.forbid || []) if (bad && whole.includes(norm(bad))) issues.push({ kind: 'leak', text: `В файле есть сведения, которых в этой части заявки быть не должно: «${String(bad).slice(0, 40)}»` });
  }
  return { ok: !issues.length, issues };
}

// ---------- папка для переноса ----------
const csv = (rows) => rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');

function checklistMd({ tender, classification, pkg, draft, version, blockers = [] }) {
  const L = [];
  L.push(`# Перенос заявки на площадку — закупка № ${tender.number}`);
  if (draft) L.push('', '> **ЧЕРНОВИК.** Этот комплект не готов к подаче: в нём есть незаполненные места или невыполненные проверки. Подавать его нельзя.');
  L.push('', `${tender.title || ''}`, '', `Вид закупки: ${classification.procedure_title || classification.scenario} · версия комплекта: ${version}`, '',
    'Сервис заявку не подаёт и не подписывает. Этот архив — папка для ручного переноса: файлы и значения вы переносите на площадку сами и подписываете своей электронной подписью.', '');
  if (blockers.length) { L.push('## Что мешает подаче', ''); for (const b of blockers) L.push(`- ${b}`); L.push(''); }
  const parts = [...new Set(pkg.files.filter((f) => f.part).map((f) => f.part))];
  for (const p of parts) {
    L.push(`## ${PART_TITLE[p] ? PART_TITLE[p][0].toUpperCase() + PART_TITLE[p].slice(1) : p}`, '', 'Файлы для загрузки:');
    for (const f of pkg.files.filter((x) => x.part === p)) L.push(`- [ ] \`${f.path}\` — ${f.purpose}${f.draft ? ' — **проект, не подавать**' : ''}${f.todo ? ` — незаполненных мест: ${f.todo}` : ''}`);
    const fl = pkg.fields.filter((x) => x.part === p);
    if (fl.length) { L.push('', 'Значения для полей площадки:'); for (const x of fl) L.push(`- [ ] ${x.label}: ${x.value}`); }
    L.push('');
  }
  const forms = pkg.files.filter((f) => f.kind === 'form');
  if (forms.length) { L.push('## Формы заказчика (заполняются вручную)', ''); for (const f of forms) L.push(`- [ ] \`${f.path}\``); L.push(''); }
  if (pkg.actions.length) {
    L.push('## Действия на площадке', '');
    for (const a of pkg.actions) {
      L.push(`- [ ] ${a.text}`);
      for (const s of a.statements || []) L.push(`  - ${s.confirmed ? '✓' : '○'} ${s.ref}: ${s.text}`);
    }
    L.push('');
  }
  L.push('## После переноса', '', '- [ ] Сверьте на площадке каждый загруженный файл и каждое поле с этим списком.', '- [ ] Убедитесь, что заявка подписана и площадка показала подтверждение приёма. Без подтверждения заявка не подана.', '');
  return L.join('\n');
}

/**
 * Собрать архив. Внутри: application-transfer/ — то, что переносится на площадку; review-internal/ — для своей
 * проверки (в заявку не идёт). Закупочных цен, прибыли и данных поставщика в application-transfer нет.
 * @returns {{buffer, name, manifest}}
 */
function buildZip({ tender, caseView, classification, pkg, draft, version, snapshot, hashes = {}, checks = [], approvals = {}, internal = {}, now = new Date(), blockers = [] }) {
  const zip = new AdmZip();
  const put = (p, data) => zip.addFile(p, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
  const T = 'application-transfer/';
  const listed = [];
  for (const f of pkg.files) {
    // проект (например, декларация без подтверждений) в итоговую выгрузку не идёт
    if (!draft && f.draft) continue;
    put(T + f.path, f.buffer);
    listed.push({ path: f.path, sha256: f.sha256, bytes: f.bytes, part: f.part, kind: f.kind, purpose: f.purpose, draft: Boolean(f.draft), unfilled: f.todo || 0 });
  }
  const fieldsJson = pkg.fields.map(({ part, part_title, key, label, value, filled, source }) => ({ part, part_title, key, label, value, filled, source }));
  put(`${T}etp-fields.json`, JSON.stringify(fieldsJson, null, 2));
  put(`${T}etp-fields.csv`, `﻿${csv([['Часть заявки', 'Поле', 'Значение', 'Заполнено', 'Откуда'], ...fieldsJson.map((f) => [f.part_title, f.label, f.value, f.filled ? 'да' : 'нет', f.source])])}`);
  put(`${T}transfer-checklist.md`, checklistMd({ tender, classification, pkg, draft, version, blockers }));
  const manifest = {
    schema_version: 1,
    kind: draft ? 'draft' : 'transfer',
    notice: 'Архив — папка для ручного переноса на площадку. Он не является поданной заявкой и не подтверждает её приём.',
    tender: { id: tender.id, number: tender.number, law: tender.law, lot: caseView.lot_id, title: tender.title },
    package: { version, status: caseView.status, scenario: classification.scenario, created_at: now.toISOString() },
    hashes: { inputs: snapshot, dossier: hashes.dossier ?? null, rule_pack: hashes.rule_pack ?? null, declarations: hashes.declarations ?? null, platform_adapter: null },
    files: listed,
    fields: { total: fieldsJson.length, filled: fieldsJson.filter((f) => f.filled).length },
    actions: pkg.actions.map((a) => ({ kind: a.kind, text: a.text, done: a.done ?? null })),
    signature: 'не подписано: заявка подписывается электронной подписью на площадке',
    checks: checks.map((c) => ({ path: c.path, ok: c.ok, issues: c.issues })),
    approvals,
    blockers,
  };
  put(`${T}manifest.json`, JSON.stringify(manifest, null, 2));

  const R = 'review-internal/';
  put(`${R}requirements.json`, JSON.stringify(caseView.requirements || [], null, 2));
  put(`${R}requirement-evidence-matrix.csv`, `﻿${csv([['Требование', 'Откуда', 'Обязательность', 'Этап', 'Куда', 'Решение', 'Причина', 'Доказательства'],
    ...(caseView.requirements || []).map((r) => [r.requirement, r.origin === 'rule' ? `правило ${(r.legal_rule_ids || []).join(', ')}` : (r.sources || []).map((s) => `${s.file}, стр. ${s.locator?.page ?? '?'}`).join('; '), r.obligation, r.stage, r.channel, r.decision, r.reason || '', (r.evidence_ids || []).join(', ')])])}`);
  put(`${R}coverage-report.json`, JSON.stringify(internal.coverage || {}, null, 2));
  put(`${R}conflicts.md`, ['# Несостыковки', '', ...((caseView.findings || []).length ? caseView.findings.map((f) => `- **${f.id}** (${f.severity}): ${f.text}${f.action ? ` — что сделать: ${f.action}` : ''}`) : ['Несостыковок не найдено.']), ''].join('\n'));
  put(`${R}registry-checks.json`, JSON.stringify(internal.registry || {}, null, 2));
  put(`${R}source-index.json`, JSON.stringify(caseView.sources || [], null, 2));
  put(`${R}reviewer-decisions.json`, JSON.stringify(internal.decisions || {}, null, 2));
  put(`${R}fulfillment-risks.md`, ['# Что проверить до подачи: сможем ли поставить', '', ...(internal.risks?.length ? internal.risks.map((x) => `- ${x}`) : ['Замечаний нет.']), ''].join('\n'));
  const name = `${draft ? 'ЧЕРНОВИК-' : ''}заявка-${fileSafe(tender.number)}-v${version}.zip`;
  return { buffer: zip.toBuffer(), name, manifest };
}

module.exports = { buildPackage, verifyFile, buildZip, checklistMd, partFor, todo, hasTodo, PART_TITLE, sha256 };
