// Полный анализ закупки: приёмочные сценарии из design-kit/comprehensive-analysis (CLAUDE_CODE_TASK.md, VALIDATION.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const AdmZip = require('adm-zip');
const { buildReport, parseTerm, roleOf } = require('../server/comprehensive/build');
const { createComprehensiveService } = require('../server/comprehensive/service');
const { toContract, validateReport } = require('../server/comprehensive/contract');
const { blocks } = require('../server/comprehensive/document');
const { toDocx } = require('../server/comprehensive/export-docx');
const { toPdf } = require('../server/comprehensive/export-pdf');
const example = require('./fixtures/comprehensive/report-0342100024526000062.json');

const NOW = '2026-10-20T09:00:00.000Z';
const src = (file, quote, page = 1) => [{ file, page, quote, verified: true }];
const field = (key, label, value, file = 'Проект контракта.docx') => ({ key, label, status: 'found', value, sources: src(file, value) });
const FILES = [
  { id: 1, original_name: 'Описание объекта закупки.docx', status: 'done', sha256: 'a'.repeat(64), coverage: { status: 'complete' } },
  { id: 2, original_name: 'Проект контракта.docx', status: 'done', sha256: 'b'.repeat(64), coverage: { status: 'complete' } },
  { id: 3, original_name: 'Обоснование НМЦК.xlsx', status: 'done', sha256: 'c'.repeat(64), coverage: { status: 'complete' } },
];
function input({ files = FILES, fields = [], deadline = '2026-10-25T07:00:00.000Z', items = [], deal = null, notice = true, method = 'Электронный аукцион' } = {}) {
  return {
    tender: { id: 1, number: '0300000000026000001', law: '44', price: 100000, deadline_at: deadline, platform: 'РТС-тендер', title: 'Поставка ноутбуков', source: 'eis' },
    card: notice ? { details: { items_source: 'notification', conditions: { notice_version: 2 }, spec_coverage: { status: 'complete' } } } : null,
    analysis: { id: 7, status: 'done', files, card: { meta: { coverage: { status: 'complete' } }, groups: [{ fields: [field('procurement_method', 'Способ закупки', method, 'Извещение.pdf'), ...fields] }], risks: [] } },
    items, offers: [], deal, bid: null, chars: null, input_revision: 'rev-1',
  };
}

test('только аналитический отчёт другой программы → «недостаточно данных», комплект не установлен', () => {
  const r = buildReport({ ...input({ notice: false, files: [{ id: 9, original_name: '📊_Анализ_закупки_0342100024526000062.docx', status: 'done', sha256: 'd'.repeat(64), coverage: { status: 'complete' } }],
    fields: [{ key: 'nmck', label: 'НМЦК', status: 'found', value: '50291.00', sources: src('📊_Анализ_закупки_0342100024526000062.docx', '50 291,00') }] }) }, { now: NOW });
  assert.equal(r.decision.recommendation, 'insufficient_data');
  assert.equal(r.source_manifest.expected_set_known, false);
  assert.equal(r.sources[0].kind, 'secondary_analysis');
  assert.ok(r.findings.some((f) => f.id === 'S-secondary'));
  // сведения из вторичного отчёта — «по отчёту», не «подтверждено»
  assert.ok(r.facts.filter((f) => f.key === 'nmck').every((f) => f.status !== 'verified'));
  assert.ok(r.evidence.filter((e) => e.source_id === 's-f9').every((e) => e.eligible_for_decision === false));
});

test('нет обоснования НМЦК → документ остаётся в знаменателе, комплект «не подтверждено»', () => {
  const r = buildReport(input({ files: FILES.slice(0, 2) }), { now: NOW });
  assert.deepEqual(r.source_manifest.missing_known_roles, ['nmck_justification']);
  const missing = r.sources.find((s) => s.kind === 'nmck_justification');
  assert.equal(missing.received, false);
  assert.equal(r.checks.find((c) => c.gate === 'source_manifest').status, 'unknown');
  assert.equal(r.decision.recommendation, 'insufficient_data');
});

test('срок подачи прошёл → подтверждённое препятствие, задачи «подать» недоступны', () => {
  const r = buildReport(input({ deadline: '2026-10-13T03:00:00.000Z', items: [{ id: 5, idx: 0, name: 'Ноутбук', quantity: 2, unit: 'шт', eis_measure: 'ограничение' }] }), { now: NOW });
  const proc = r.checks.find((c) => c.gate === 'procedure');
  assert.equal(proc.status, 'fail');
  assert.equal(proc.hard_stop, true);
  assert.equal(proc.validation_state, 'verified');
  assert.equal(r.decision.recommendation, 'do_not_participate');
  assert.deepEqual(r.decision.hard_stops, ['procedure']);
  assert.ok(r.actions.filter((a) => a.stage === 'bid').every((a) => a.status === 'blocked'));
});

test('ограничение по ПП 1875 — условие, а не запрет и не препятствие', () => {
  const r = buildReport(input({ items: [{ id: 5, idx: 0, name: 'Ноутбук', quantity: 2, unit: 'шт', eis_measure: 'ограничение' }] }), { now: NOW });
  const nr = r.items[0].national_regime;
  assert.equal(nr.result, 'conditional');
  assert.match(nr.trigger, /условный риск, а не запрет/);
  const f = r.findings.find((x) => x.id === 'NR-5');
  assert.equal(f.category, 'legal_review');
  assert.notEqual(r.decision.recommendation, 'do_not_participate');
  assert.ok(!r.decision.hard_stops.includes('product'));
});

test('неизвестное ≠ 0: без расчёта прибыль и деньги «не рассчитано», а не ноль', () => {
  const r = buildReport(input(), { now: NOW });
  assert.equal(r.commercial.net_profit_minor, null);
  assert.equal(r.commercial.funding_peak_minor, null);
  assert.equal(r.checks.find((c) => c.gate === 'economics').status, 'unknown');
  const text = JSON.stringify(blocks(r));
  assert.match(text, /Плановая прибыль","не рассчитано/);
  assert.doesNotMatch(text, /Плановая прибыль","0,00/);
  // не утверждённые правовые правила не дают «соответствует»
  assert.equal(r.checks.find((c) => c.gate === 'legal').status, 'unknown');
  assert.ok(r.rules.every((x) => x.verification_state === 'research_reference'));
});

test('время аукциона совпадает с окончанием подачи → противоречие L42, календарь не переписан', () => {
  const r = buildReport(input({ fields: [field('auction_date', 'Дата и время аукциона', '25.10.2026 10:00', 'Извещение.pdf')] }), { now: NOW });
  const c = r.findings.find((f) => f.id === 'C-L42');
  assert.ok(c);
  assert.deepEqual(c.rule_ids, ['L42']);
  const auction = r.calendar.find((x) => x.id === 'P-auction');
  assert.equal(auction.official, '25.10.2026 10:00');
  assert.equal(auction.expected_by_rule, '2026-10-25T09:00:00.000Z');
  assert.equal(r.checks.find((x) => x.gate === 'procedure').status, 'conditional');
});

test('сроки контракта: длительность, вид дней и событие без выдуманной даты', () => {
  assert.deepEqual(parseTerm('в течение 10 (десяти) рабочих дней с даты подписания документа о приёмке'), { duration: 10, unit: 'day', day_kind: 'working', event: 'с даты подписания документа о приёмке', until: null });
  assert.equal(parseTerm('не более 7 дней').day_kind, 'unspecified');
  const r = buildReport(input({ fields: [field('payment_terms', 'Оплата', 'в течение 7 рабочих дней с даты подписания документа о приёмке')] }), { now: NOW });
  const t03 = r.calendar.find((x) => x.id === 'T03');
  assert.equal(t03.duration, 7);
  assert.equal(t03.official, null);
  assert.equal(r.calendar.filter((x) => x.group === 'contract').length, 14);
  assert.equal(roleOf('Приложение № 2 - Обоснование НМЦК.DOCX'), 'nmck_justification');
});

test('найдено поиском ≠ подтверждено: проверка поставщиков проходит только с КП', () => {
  const items = [{ id: 5, idx: 0, name: 'Ноутбук', purchase_offer_id: 1 }];
  const offers = [{ id: 1, item_id: 5, unit_price: 1000, url: 'https://shop.example/p', price_date: '2026-10-19T08:00:00.000Z', seller_name: 'Магазин' }];
  const dealNo = { inputs: {}, variants: [], quality: { status: 'incomplete', reasons: [] }, facts: [] };
  const r1 = buildReport({ ...input({ items, deal: dealNo }), offers }, { now: NOW });
  assert.equal(r1.offers[0].stage, 'page_opened');
  assert.equal(r1.checks.find((c) => c.gate === 'supplier').status, 'unknown');
  const dealKp = { ...dealNo, inputs: { price_confirmations: { 5: { basis: 'КП № 12 от 19.10.2026', by: 'менеджер', at: '2026-10-19T10:00:00.000Z', valid_until: null } } } };
  const r2 = buildReport({ ...input({ items, deal: dealKp }), offers }, { now: NOW });
  assert.equal(r2.offers[0].stage, 'confirmed_by_quote');
  const sup = r2.checks.find((c) => c.gate === 'supplier');
  assert.equal(sup.status, 'pass');
  assert.equal(sup.validation_state, 'verified');
  assert.ok(r2.sources.some((s) => s.id === 's-supplier' && s.primary === false));
});

test('цена выбранного товара старше 3 дней → замечание и задача перепроверить', () => {
  const items = [{ id: 5, idx: 0, name: 'Ноутбук', purchase_offer_id: 1 }];
  const offers = [{ id: 1, item_id: 5, unit_price: 1000, url: 'https://shop.example/p', price_date: '2026-10-10T08:00:00.000Z', seller_name: 'Магазин' }];
  const r = buildReport({ ...input({ items }), offers }, { now: NOW });
  assert.ok(r.findings.some((f) => f.id === 'O-old-1' && /10 дн/.test(f.title)));
  assert.ok(r.actions.some((a) => a.id === 'a-old-1'));
});

test('документация прочитана полностью, ТЗ — нет: статусы независимы, товар не признан соответствующим', () => {
  const x = input({ items: [{ id: 5, idx: 0, name: 'Ноутбук' }] });
  x.card.details.spec_coverage.status = 'partial';
  const r = buildReport(x, { now: NOW });
  assert.equal(r.checks.find((c) => c.gate === 'reading_general').status, 'pass');
  assert.equal(r.checks.find((c) => c.gate === 'reading_spec').status, 'unknown');
  assert.equal(r.checks.find((c) => c.gate === 'product').status, 'unknown');
  assert.equal(r.decision.recommendation, 'insufficient_data');
});

test('повторная сборка тех же данных: те же идентификаторы, без дублей замечаний и задач', () => {
  const x = input({ items: [{ id: 5, idx: 0, name: 'Ноутбук', eis_measure: 'ограничение' }], fields: [field('auction_date', 'Дата и время аукциона', '25.10.2026 10:00')] });
  const a = buildReport(x, { now: NOW });
  const b = buildReport(x, { now: NOW });
  assert.deepEqual(a.findings.map((f) => f.id), b.findings.map((f) => f.id));
  assert.equal(new Set(a.findings.map((f) => f.id)).size, a.findings.length);
  assert.equal(new Set(a.actions.map((f) => f.id)).size, a.actions.length);
  assert.equal(new Set(a.evidence.map((f) => f.id)).size, a.evidence.length);
});

test('КП с истёкшим сроком: снимок стареет по времени без изменения файлов', async () => {
  const db = new DatabaseSync(':memory:');
  const base = input({ items: [{ id: 5, idx: 0, name: 'Ноутбук', purchase_offer_id: 1 }] });
  const deal = { inputs: { price_confirmations: { 5: { basis: 'КП № 12', by: 'менеджер', at: '2026-10-19T10:00:00.000Z', valid_until: '2026-10-21T00:00:00.000Z' } } }, variants: [], quality: { status: 'incomplete', reasons: [] }, facts: [] };
  const repo = { db, getTender: () => ({ ...base.tender, analysis_id: 7 }), getAnalysis: () => base.analysis, getItems: () => base.items,
    getOffers: () => [{ id: 1, item_id: 5, unit_price: 1000, url: 'https://shop.example/p', price_date: '2026-10-19T08:00:00.000Z' }] };
  let t = Date.parse(NOW);
  const svc = createComprehensiveService({ repo, details: { getCard: async () => base.card }, deal: { view: async () => deal }, clock: () => new Date(t), log: { warn() {} } });
  const s = await svc.run(1);
  assert.equal(s.report.checks.find((c) => c.gate === 'supplier').status, 'pass');
  t = Date.parse('2026-10-21T01:00:00.000Z');
  const later = await svc.get(1, s.id);
  assert.equal(later.freshness, 'stale');
  assert.match(later.stale_reasons.join(' '), /КП/);
});

test('223-ФЗ без положения заказчика: правовая ветка не поддержана, 44-ФЗ не применяется по умолчанию', () => {
  const x = input();
  x.tender.law = '223';
  const r = buildReport(x, { now: NOW });
  assert.equal(r.scope.law, '223fz');
  assert.equal(r.source_manifest.expected_set_known, false);
  assert.deepEqual(r.source_manifest.missing_known_roles, []);
  assert.match(r.decision.unsupported, /положение заказчика/);
  assert.equal(r.decision.recommendation, 'insufficient_data');
});

test('JSON-выгрузка соответствует схеме отчёта; пример комплекта проходит; лишнее поле — ошибка', () => {
  const r = buildReport(input({ items: [{ id: 5, idx: 0, name: 'Ноутбук', eis_measure: 'ограничение' }], fields: [field('auction_date', 'Дата и время аукциона', '25.10.2026 10:00')] }), { now: NOW });
  r.snapshot.id = 'test-1';
  assert.deepEqual(validateReport(toContract(r)), []);
  assert.equal(toContract(r).expected_decision, r.decision.recommendation);
  assert.deepEqual(validateReport(example), []);
  assert.ok(validateReport({ ...example, extra: 1 }).some((e) => /лишнее поле/.test(e)));
  assert.ok(validateReport({ ...example, commercial: { ...example.commercial, nmck_minor: 5 } }).length > 0);
});

test('снимок: история, проверка принадлежности закупке, «устарел» при изменении входов', async () => {
  const db = new DatabaseSync(':memory:');
  const state = { offers: [{ id: 1, item_id: 5, unit_price: 1000, url: 'https://shop.example/p', price_date: '2026-10-19T08:00:00.000Z' }] };
  const base = input({ items: [{ id: 5, idx: 0, name: 'Ноутбук', eis_measure: 'ограничение' }] });
  const repo = { db, getTender: (id) => (id === 1 ? { ...base.tender, analysis_id: 7 } : id === 2 ? { ...base.tender, id: 2, number: 'other' } : null),
    getAnalysis: () => base.analysis, getItems: () => base.items, getOffers: () => state.offers };
  let t = Date.parse(NOW);
  const svc = createComprehensiveService({ repo, details: { getCard: async () => base.card }, clock: () => new Date(t), log: { warn() {} } });
  const s1 = await svc.run(1);
  assert.equal(s1.freshness, 'current');
  assert.equal(s1.report.snapshot.id, s1.id);
  assert.match(s1.report.snapshot.integrity, /^[a-f0-9]{64}$/);
  assert.equal((await svc.get(1)).freshness, 'current');
  assert.equal(await svc.get(2, s1.id), null, 'чужой снимок по другой закупке не отдаётся');
  state.offers = [{ ...state.offers[0], unit_price: 1200 }];
  const st = await svc.get(1, s1.id);
  assert.equal(st.freshness, 'stale');
  assert.ok(st.stale_reasons.length);
  t += 60e3;
  const s2 = await svc.run(1);
  assert.notEqual(s2.id, s1.id);
  assert.deepEqual(svc.history(1).map((h) => h.id), [s2.id, s1.id]);
  assert.equal((await svc.get(1, s1.id)).report.snapshot.id, s1.id, 'прошлый снимок не перезаписан');
});

test('DOCX и PDF строятся из того же снимка: номер, снимок, рекомендация и суммы совпадают', async () => {
  const r = buildReport(input({ deadline: '2026-10-13T03:00:00.000Z' }), { now: NOW });
  r.snapshot.id = 'snap-xyz';
  const docx = toDocx(r);
  const zip = new AdmZip(docx);
  const xml = zip.readAsText('word/document.xml');
  const text = xml.replace(/<[^>]+>/g, ' ');
  assert.match(text, /0300000000026000001/);
  assert.match(text, /Не участвовать/);
  assert.match(zip.readAsText('word/footer1.xml'), /snap-xyz/);
  assert.match(xml, /<w:tblHeader\/>/, 'шапка таблицы повторяется на каждой странице');
  assert.match(text, /не рассчитано/);
  const pdf = await toPdf(r);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 5000);
});

test('пример комплекта (вторичный отчёт) выгружается в DOCX и PDF без ошибок', async () => {
  const docx = toDocx(example);
  assert.match(new AdmZip(docx).readAsText('word/document.xml'), /Недостаточно данных/);
  const pdf = await toPdf(example);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('просмотр в браузере: тот же отчёт и кнопки «Скачать в Word» и «Открыть PDF»', () => {
  const { toHtml } = require('../server/comprehensive/export-html');
  const r = buildReport(input({ deadline: '2026-10-13T03:00:00.000Z' }), { now: NOW });
  r.snapshot.id = 'snap-xyz';
  const html = toHtml(r, { links: { docx: '/x?format=docx', pdf: '/x?format=pdf&inline=1' } });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Скачать в Word \(\.docx\)/);
  assert.match(html, /href="\/x\?format=pdf&amp;inline=1"/);
  assert.match(html, /Не участвовать/);
  assert.match(html, /0300000000026000001/);
  assert.doesNotMatch(html, /<script/i, 'на странице нет скриптов, кроме кнопки печати');
});
