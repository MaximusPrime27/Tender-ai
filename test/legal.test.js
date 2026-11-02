// Правовой вывод по документации закупки и письмо заказчику «О спорных вопросах и предложениях по их разрешению».

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { legalReview, buildLetter, ruleIssues, loadNorms, payDays } = require('../server/analyze/legal');
const { customerFromDoc } = require('../server/tenders/customer');
const { analyzeDocs } = require('../server/analyze');
const { create: createMock } = require('../server/llm/mock');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const readFix = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const src = (quote) => [{ file: 'Проект контракта.docx', page: 3, quote, verified: true }];
const field = (key, label, value) => ({ key, label, value, status: 'found', sources: src(value) });
/** Карточка разбора с заданными условиями. */
const cardOf = (fields, risks = []) => ({ groups: [{ key: 'money', title: 'Деньги', fields: [field('law', 'Закон', '44-ФЗ'), ...fields] }], risks });
const llmAnswering = (answer) => ({ async complete() { return { text: JSON.stringify(answer), usage: { in: 1, out: 1 } }; } });

test('перечень норм: у каждой нормы статья, суть и источник; дата сверки указана', () => {
  const norms = loadNorms();
  assert.ok(norms.norms.length >= 8);
  assert.match(norms.checked_at, /^\d{4}-\d{2}-\d{2}$/);
  for (const n of norms.norms) {
    assert.ok(n.id && n.article && n.rule && n.title, `норма ${n.id}`);
    assert.match(n.source, /^https:\/\//, `у нормы ${n.id} есть ссылка на текст закона`);
    assert.equal(n.law, '44');
  }
  assert.equal(new Set(norms.norms.map((n) => n.id)).size, norms.norms.length, 'идентификаторы не повторяются');
});

test('правовой вывод: числовые нормы 44-ФЗ проверяются без нейросети', () => {
  assert.deepEqual(payDays('в течение 30 (тридцати) календарных дней'), { days: 30, kind: 'календарных' });
  assert.deepEqual(payDays('не более 7 рабочих дней с даты подписания'), { days: 7, kind: 'рабочих' });
  const ids = (fields) => ruleIssues(cardOf(fields), { law: '44' }).map((x) => x.norm_id);

  // срок оплаты
  assert.deepEqual(ids([field('payment_terms', 'Срок и порядок оплаты', 'в течение 30 календарных дней с даты приёмки')]), ['44-34-13.1']);
  assert.deepEqual(ids([field('payment_terms', 'Срок и порядок оплаты', 'в течение 10 рабочих дней')]), ['44-34-13.1']);
  assert.deepEqual(ids([field('payment_terms', 'Срок и порядок оплаты', 'не более 7 рабочих дней с даты подписания документа о приёмке')]), []);
  assert.deepEqual(ids([field('payment_terms', 'Срок и порядок оплаты', 'по факту поставки')]), [], 'срок не назван числом — замечания нет');
  // обеспечение исполнения контракта: 0,5–30%
  assert.deepEqual(ids([field('contract_security', 'Обеспечение исполнения контракта', '35 % от цены контракта')]), ['44-96-6']);
  assert.deepEqual(ids([field('contract_security', 'Обеспечение исполнения контракта', '5% НМЦК')]), []);
  // обеспечение заявки: предел зависит от НМЦК
  const bid = field('bid_security', 'Обеспечение заявки', '3 % начальной (максимальной) цены контракта');
  assert.deepEqual(ids([field('nmck', 'НМЦК', '5 000 000,00 руб.'), bid]), ['44-44-2'], 'при цене до 20 млн — не больше 1%');
  assert.deepEqual(ids([field('nmck', 'НМЦК', '30 000 000,00 руб.'), bid]), [], 'при цене выше 20 млн — до 5%');
  assert.deepEqual(ids([bid]), [], 'цена не известна — 3% не оспариваем');
  // обеспечение гарантийных обязательств: не более 10%
  assert.deepEqual(ids([field('warranty_security', 'Обеспечение гарантийных обязательств', '15%')]), ['44-96-2.2']);

  // право одностороннего отказа оставлено только заказчику
  assert.deepEqual(ids([field('termination', 'Одностороннее расторжение', 'Заказчик вправе в одностороннем порядке отказаться от исполнения контракта. Поставщик таким правом не обладает.')]), ['44-95-9-19']);
  assert.deepEqual(ids([field('termination', 'Одностороннее расторжение', 'Стороны вправе принять решение об одностороннем отказе по основаниям ГК РФ')]), []);

  const issue = ruleIssues(cardOf([field('payment_terms', 'Срок и порядок оплаты', 'в течение 30 календарных дней')]), { law: '44' })[0];
  assert.match(issue.condition, /Срок и порядок оплаты: в течение 30 календарных дней/);
  assert.match(issue.proposal, /7 \(семи\) рабочих дней/);
  assert.equal(issue.sources[0].file, 'Проект контракта.docx', 'у замечания — ссылка на документ, как у рисков');
  // для 223-ФЗ числовые нормы 44-ФЗ не применяются
  assert.deepEqual(ruleIssues(cardOf([field('payment_terms', 'Срок и порядок оплаты', 'в течение 60 календарных дней')]), { law: '223' }), []);
});

test('правовой вывод: нейросеть ссылается только на нормы из перечня; чужая «статья» отбрасывается', async () => {
  const risks = [
    { type: 'заточка_под_поставщика', level: 'high', explanation: 'указана модель одного производителя без слов «или эквивалент»', sources: src('принтер Pantum BP5100DN') },
    { type: 'нестандартное_требование', level: 'medium', explanation: 'требуется офис в городе заказчика', sources: src('наличие офиса в г. Хабаровске') },
  ];
  const answer = { issues: [
    { risk: 1, field: null, condition: 'модель одного производителя', why: 'ограничивает число участников', norm_id: '44-33-1-1', proposal: 'Дополнить словами «или эквивалент».', fatal: false },
    { risk: 2, field: null, condition: 'офис в городе заказчика', why: 'требование к участнику не связано с поставкой', norm_id: 'статья 999 выдуманного закона', proposal: 'Исключить требование.', fatal: false },
    { risk: 2, field: null, condition: 'повтор того же риска', why: 'повтор', norm_id: null, proposal: '', fatal: false },
  ], reasons: ['два спорных условия'] };
  const legal = await legalReview({ card: cardOf([], risks), llm: llmAnswering(answer) });
  assert.equal(legal.issues.length, 2, 'один риск — одно замечание');
  assert.deepEqual([legal.verdict, legal.decision, legal.law, legal.llm_used], ['есть спорные условия', 'направить обращение', '44', true]);
  const [a, b] = legal.issues;
  assert.equal(a.norm.article, 'пункт 1 части 1 статьи 33 Закона № 44-ФЗ');
  assert.match(a.norm.source, /consultant\.ru/);
  assert.equal(a.needs_lawyer, false);
  assert.equal(a.sources[0].quote, 'принтер Pantum BP5100DN', 'цитата и страница — из риска, на котором основано замечание');
  assert.deepEqual([b.norm, b.needs_lawyer], [null, true], 'нормы нет в перечне — «требует проверки юристом», выдуманная статья не показывается');
  assert.equal(legal.with_norm, 1);
  assert.ok(legal.norms_checked_at);

  // норма из перечня, но не по теме замечания — тоже отбрасывается; норма по теме — принимается
  const office = (normId) => legalReview({ card: cardOf([], [risks[1]]), llm: llmAnswering({ issues: [{ risk: 1, condition: 'участник должен иметь офис и склад в городе заказчика', why: 'требование к участнику не предусмотрено законом', norm_id: normId, proposal: 'Исключить.', fatal: false }], reasons: [] }) });
  assert.equal((await office('44-33-1-1')).issues[0].norm, null, 'норма о товарных знаках к требованию об офисе не относится');
  assert.equal((await office('44-31-6')).issues[0].norm.article, 'часть 6 статьи 31 Закона № 44-ФЗ');

  // то, что уже нашла числовая проверка, нейросеть не дублирует
  const both = await legalReview({ card: cardOf([field('payment_terms', 'Срок и порядок оплаты', 'в течение 30 календарных дней')]),
    llm: llmAnswering({ issues: [{ risk: null, field: 'payment_terms', condition: 'оплата 30 дней', why: 'долго', norm_id: '44-34-13.1', proposal: '', fatal: false }], reasons: [] }) });
  assert.deepEqual(both.issues.map((x) => x.origin), ['rule']);
});

test('правовой вывод: итог — замечаний нет, обращение или отказ; сбой нейросети не мешает числовой проверке', async () => {
  const clean = await legalReview({ card: cardOf([field('payment_terms', 'Срок и порядок оплаты', '7 рабочих дней')]), llm: llmAnswering({ issues: [], reasons: [] }) });
  assert.deepEqual([clean.verdict, clean.decision, clean.issues.length], ['противоречий не найдено', 'замечаний нет', 0]);
  assert.equal(buildLetter({ legal: clean }), null, 'замечаний нет — письмо не нужно');

  const fatal = await legalReview({ card: cardOf([], [{ type: 'заточка_под_поставщика', level: 'high', explanation: 'товар единственного производителя', sources: [] }]),
    llm: llmAnswering({ issues: [{ risk: 1, condition: 'товар единственного производителя, замена не допускается', why: 'поставить иной товар нельзя', norm_id: '44-33-1-1', proposal: '', fatal: true }], reasons: ['участвовать бессмысленно'] }) });
  // серьёзное условие, но время на запрос есть — сначала обращение, условие помечено
  assert.equal(fatal.decision, 'направить обращение');
  assert.equal(fatal.issues[0].fatal, true);
  assert.match(fatal.reasons.join(' '), /Серьёзных: 1. Если заказчик не изменит эти условия — от участия лучше отказаться/);
  assert.ok(buildLetter({ legal: fatal }));
  // то же, но до окончания подачи заявок меньше трёх дней: запрос уже не подать — отказ
  const fatalArgs = { card: cardOf([], [{ type: 'заточка_под_поставщика', level: 'high', explanation: 'товар единственного производителя', sources: [] }]),
    llm: llmAnswering({ issues: [{ risk: 1, condition: 'товар единственного производителя, замена не допускается', why: 'поставить иной товар нельзя', norm_id: '44-33-1-1', proposal: '', fatal: true }], reasons: [] }) };
  const late = await legalReview({ ...fatalArgs, tender: { law: '44', deadline_at: '2026-10-11T06:00:00Z' }, now: new Date('2026-10-09T09:00:00Z') });
  assert.deepEqual([late.decision, late.request_too_late, late.request_by], ['отказаться от участия', true, '2026-10-08T06:00:00.000Z']);
  assert.match(late.reasons.join(' '), /Срок подачи запроса разъяснений истёк/);
  assert.equal(buildLetter({ legal: late }), null, 'решено отказаться — письмо не формируется');
  const inTime = await legalReview({ ...fatalArgs, tender: { law: '44', deadline_at: '2026-10-20T06:00:00Z' }, now: new Date('2026-10-09T09:00:00Z') });
  assert.deepEqual([inTime.decision, inTime.request_too_late], ['направить обращение', false]);
  // обычные (не серьёзные) замечания при истёкшем сроке — не отказ, но об истёкшем сроке сказано
  const lateMinor = await legalReview({ card: cardOf([field('contract_security', 'Обеспечение исполнения контракта', '40%')]), tender: { law: '44', deadline_at: '2026-10-10T06:00:00Z' }, now: new Date('2026-10-09T09:00:00Z') });
  assert.equal(lateMinor.decision, 'направить обращение');
  assert.match(lateMinor.reasons.join(' '), /Срок подачи запроса разъяснений уже истёк/);

  const broken = await legalReview({ card: cardOf([field('contract_security', 'Обеспечение исполнения контракта', '40%')]), llm: { async complete() { throw new Error('сеть недоступна'); } } });
  assert.deepEqual(broken.issues.map((x) => x.norm.id), ['44-96-6']);
  assert.equal(broken.llm_used, false);
  assert.match(broken.notes.join(' '), /проверены только числовые нормы/);

  // 223-ФЗ: спорное показывается, но без ссылок на нормы 44-ФЗ
  const law223 = await legalReview({ card: cardOf([], [{ type: 'жёсткие_штрафы', level: 'high', explanation: 'штраф 30%', sources: [] }]), tender: { law: '223' },
    llm: llmAnswering({ issues: [{ risk: 1, condition: 'штраф 30%', why: 'несоразмерно', norm_id: '44-34-8', proposal: 'Снизить штраф.', fatal: false }], reasons: [] }) });
  assert.deepEqual([law223.issues[0].norm, law223.issues[0].needs_lawyer], [null, true]);
  assert.match(law223.notes.join(' '), /223-ФЗ и коммерческих перечень норм не составлен/);
});

test('правовой вывод: модель расходников и запчастей к оборудованию заказчика без «или эквивалент» — не замечание', async () => {
  // Норма о товарных знаках прямо разрешает это; нейросеть исключение пропускает — его проверяет код.
  const answer = { issues: [{ risk: 1, field: null, condition: 'Поставка конкретных моделей картриджей OKI', why: 'нет слов «или эквивалент»', norm_id: '44-33-1-1', proposal: 'Допустить эквиваленты.', fatal: true }], reasons: ['ограничение конкуренции'] };
  const risks = [{ type: 'заточка_под_поставщика', level: 'high', explanation: 'указаны модели картриджей OKI', sources: src('картридж OKI 46490632') }];
  const legal = await legalReview({ card: cardOf([], risks), llm: llmAnswering(answer) });
  assert.deepEqual([legal.issues.length, legal.decision], [0, 'замечаний нет']);
  assert.match(legal.notes.join(' '), /закон это допускает/);
  // тот же ответ нейросети про принтер — замечание остаётся
  const printer = await legalReview({ card: cardOf([], [{ ...risks[0], explanation: 'указана модель принтера' }]),
    llm: llmAnswering({ ...answer, issues: [{ ...answer.issues[0], condition: 'Поставка принтера конкретной модели', fatal: false }] }) });
  assert.deepEqual(printer.issues.map((x) => x.norm.id), ['44-33-1-1']);
});

test('заказчик из извещения: организация, ФИО контактного лица, контакты, место поставки', () => {
  const c44 = customerFromDoc({ law: '44' }, readFix('fz44-notification-0132600015226000103.json'));
  assert.equal(c44.person, 'Храмова Светлана Вячеславовна');
  assert.deepEqual([c44.first_name, c44.middle_name], ['Светлана', 'Вячеславовна']);
  assert.match(c44.org, /УПРАВЛЕНИЕ СТРОИТЕЛЬСТВА/);
  assert.match(c44.placer, /АДМИНИСТРАЦИЯ/, 'закупку размещает уполномоченный орган — он указан отдельно');
  assert.equal(c44.email, 'zakazdknnov@yandex.ru');
  assert.ok(c44.phone && c44.address);
  assert.match(c44.delivery_place, /Дальнее Константиново/);

  const c223 = customerFromDoc({ law: '223' }, readFix('fz223-purchase-32616385078.json'));
  assert.match(c223.person, /^Подлинова И\. Ю\.$/);
  assert.match(c223.org, /ТЕАТР ДРАМЫ/);
  assert.ok(c223.email && c223.phone);
  assert.equal(c223.delivery_place, undefined, '«согласно закупочной документации» — не адрес');
  assert.deepEqual(customerFromDoc({ law: '44' }, null), {});
});

test('письмо заказчику: адресат по ФИО, каждое спорное условие с нормой и предложением, срок подачи запроса', async () => {
  const legal = await legalReview({
    card: cardOf([field('payment_terms', 'Срок и порядок оплаты', 'в течение 30 календарных дней')], [{ type: 'нестандартное_требование', level: 'medium', explanation: 'офис в городе заказчика', sources: src('наличие офиса в г. Хабаровске') }]),
    llm: llmAnswering({ issues: [{ risk: 1, condition: 'требуется офис в городе заказчика', why: 'не связано с поставкой товара', norm_id: null, proposal: 'Исключить требование.', fatal: false }], reasons: [] }),
  });
  const customer = customerFromDoc({ law: '44' }, readFix('fz44-notification-0132600015226000103.json'));
  const tender = { law: '44', number: '0132600015226000103', title: 'Поставка оргтехники', deadline_at: '2026-10-20T06:00:00.000Z' };
  const letter = buildLetter({ legal, tender, customer, now: new Date('2026-10-09T09:00:00Z') });

  assert.equal(letter.addressee.person, 'Храмова Светлана Вячеславовна');
  assert.match(letter.subject, /О спорных вопросах и предложениях по их разрешению — закупка № 0132600015226000103/);
  assert.match(letter.body, /^Кому: Храмова Светлана Вячеславовна, УПРАВЛЕНИЕ СТРОИТЕЛЬСТВА/);
  assert.match(letter.body, /Уважаемый\(ая\) Светлана Вячеславовна!/);
  assert.match(letter.body, /О спорных вопросах и предложениях по их разрешению/);
  assert.match(letter.body, /Закупка № 0132600015226000103 «Поставка оргтехники»/);
  assert.match(letter.body, /части 5 статьи 42 Федерального закона от 05\.04\.2013 № 44-ФЗ/);
  assert.match(letter.body, /1\. Срок и порядок оплаты: в течение 30 календарных дней/);
  assert.match(letter.body, /Норма: часть 13\.1 статьи 34 Закона № 44-ФЗ\./);
  assert.match(letter.body, /Предлагаем: Изложить условие в редакции/);
  assert.match(letter.body, /Где указано: Проект контракта\.docx, стр\. 3/);
  assert.match(letter.body, /2\. требуется офис в городе заказчика/);
  assert.match(letter.body, /Норма: \[укажите применимую норму после проверки юристом\]/, 'нормы нет в перечне — в письме пометка, а не выдуманная статья');
  assert.match(letter.body, /От: \[наименование вашей организации/);
  assert.equal(letter.send_by, '2026-10-17T06:00:00.000Z', 'запрос — не позднее чем за три дня до окончания подачи заявок');

  // контактное лицо не известно — пометка вместо имени
  const blank = buildLetter({ legal, tender, customer: {} });
  assert.match(blank.body, /Кому: \[ФИО контактного лица заказчика — см\. извещение\], \[наименование заказчика\]/);
  assert.match(blank.body, /Уважаемые коллеги!/);
});

test('разбор документации: правовой вывод появляется в карточке сам', async () => {
  const text = 'Закупка проводится по 44-ФЗ. Оплата производится заказчиком в течение 30 календарных дней с даты подписания документа о приёмке товара. '
    + 'Обеспечение исполнения контракта установлено в размере 35 % от начальной (максимальной) цены контракта. Срок поставки товара — 10 рабочих дней с даты заключения контракта.';
  const stages = [];
  const { card } = await analyzeDocs([{ id: 1, name: 'Проект контракта.docx', status: 'ok', pages: [{ page: 1, text }] }], createMock(), { maxChars: 8000, onProgress: (p) => stages.push(p.stage) });
  assert.ok(stages.includes('legal'), 'этап правовой проверки виден в ходе разбора');
  assert.ok(card.legal, 'вывод в карточке');
  const ids = card.legal.issues.map((x) => x.norm?.id);
  assert.ok(ids.includes('44-34-13.1') && ids.includes('44-96-6'), `замечания: ${ids.join(', ')}`);
  assert.equal(card.legal.decision, 'направить обращение');
  assert.ok(card.legal.issues.every((x) => x.sources.length && x.sources[0].file === 'Проект контракта.docx'));
});

test('правовой вывод и письмо через API: проверка по кнопке, адресат из извещения, скачивание', async () => {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-legal-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '', LLM_PROVIDER: 'mock',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, SUPPLIER_INDEX: false, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0, OFFER_SOURCES: 'manual',
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: FIX }) });
  const url = (p) => `http://127.0.0.1:${s.server.address().port}${p}`;
  const api = async (p, opts = {}) => { const res = await fetch(url(p), { method: opts.method, headers: opts.json ? { 'Content-Type': 'application/json' } : undefined, body: opts.json ? JSON.stringify(opts.json) : undefined }); return { status: res.status, body: await res.json() }; };
  try {
    await s.sync.run();
    await s.funnel.idle();
    // закупка, у которой в примерах есть извещение с контактным лицом
    const tender = s.repo.db.prepare("SELECT id, number FROM tenders WHERE number = '0132600015226000103'").get();
    assert.ok(tender, 'закупка из примеров загружена');
    await api(`/api/tenders/${tender.id}`); // позиции и условия закупки
    // сведения о заказчике сохранились вместе с условиями закупки — и отдаются итоговой странице
    assert.equal((await api(`/api/tenders/${tender.id}`)).body.details.conditions.customer.person, 'Храмова Светлана Вячеславовна');
    // у закупок, чьи условия сохранены раньше, сведений нет — они дочитываются из извещения по запросу, один раз
    const cond = s.repo.getDetails(tender.id).conditions;
    delete cond.customer;
    s.repo.db.prepare('UPDATE tender_details SET conditions_json = ? WHERE tender_id = ?').run(JSON.stringify(cond), tender.id);
    const before = s.repo.getEconomics(tender.id)?.computed_at;
    const customer = (await api(`/api/tenders/${tender.id}/customer`)).body.customer;
    assert.equal(customer.person, 'Храмова Светлана Вячеславовна');
    assert.match(customer.delivery_place, /Дальнее Константиново/);
    assert.equal(s.repo.getDetails(tender.id).conditions.customer.email, 'zakazdknnov@yandex.ru', 'дописано в условия закупки');
    assert.equal(s.repo.getEconomics(tender.id)?.computed_at, before, 'позиции и расчёт при этом не тронуты');
    assert.equal((await api('/api/tenders/999999/customer')).status, 404);

    // разбор, сделанный до появления проверки: правового вывода в карточке нет
    const id = 'legal-test-analysis';
    s.repo.createAnalysis({ id, title: 'Проверка письма' });
    const card = { ...cardOf([field('payment_terms', 'Срок и порядок оплаты', 'в течение 30 календарных дней')], [{ type: 'заточка_под_поставщика', level: 'high', explanation: 'модель без эквивалента', sources: src('Pantum BP5100DN') }]),
      questions: [], summary: { status: 'found', text: 'итог', recommendation: { value: 'участвовать с оговорками', reasons: [] } }, meta: { chunks: 1, failedChunks: 0, warnings: [], files: [] } };
    s.repo.finishAnalysis(id, { card, provider: 'mock', model: 'rules-v1', durationMs: 1 });
    s.repo.setTenderAnalysis(tender.id, id);

    assert.equal((await api(`/api/analyses/${id}/letter`)).status, 409, 'сначала нужна проверка');
    const legal = await api(`/api/analyses/${id}/legal`, { method: 'POST', json: {} });
    assert.equal(legal.status, 200);
    assert.deepEqual(legal.body.issues.map((x) => x.norm?.id).sort(), ['44-33-1-1', '44-34-13.1']);
    assert.equal((await api(`/api/analyses/${id}`)).body.card.legal.decision, 'направить обращение', 'вывод сохранён в карточке');

    const letter = (await api(`/api/analyses/${id}/letter`)).body;
    assert.equal(letter.addressee.person, 'Храмова Светлана Вячеславовна', 'адресат — контактное лицо из извещения');
    assert.match(letter.body, new RegExp(`Закупка № ${tender.number}`));
    assert.ok(s.repo.getDetails(tender.id).conditions.customer.person, 'сведения о заказчике сохранены в условиях закупки');

    const file = await fetch(url(`/api/analyses/${id}/letter.md`));
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type'), /text\/markdown/);
    assert.match(file.headers.get('content-disposition'), /attachment; filename="pismo-zakazchiku-/);
    assert.match(await file.text(), /^# О спорных вопросах и предложениях по их разрешению/);
    // выгрузка разбора содержит раздел о соответствии закону
    assert.match(await (await fetch(url(`/api/analyses/${id}/export.md`))).text(), /## Соответствие закону[\s\S]*часть 13\.1 статьи 34/);
    assert.equal((await api('/api/analyses/нет-такого/legal', { method: 'POST', json: {} })).status, 404);
  } finally {
    await s.close();
  }
});
