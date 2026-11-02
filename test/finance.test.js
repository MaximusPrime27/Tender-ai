const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const F = require('../server/finance/ledger');
const { createFinance } = require('../server/finance/store');

// расчёты и учебные данные — прямо из файла демо: сервер должен совпасть с ним до копейки
const html = fs.readFileSync(path.join(__dirname, '../docs/crm-demo/Tender_AI_Service_CRM_Demo.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const box = {}; box.globalThis = box;
vm.createContext(box);
vm.runInContext(scripts[0], box);
vm.runInContext(scripts[1], box);
const { TAFinance: Demo, TADemo } = box;
const copy = (x) => JSON.parse(JSON.stringify(x));
const clock = () => new Date('2026-10-21T09:00:00Z');
const mem = () => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'); return db; };
const store = () => createFinance({ db: mem(), clock });
const seeded = () => { const s = store(); s.importState(copy(TADemo.seed()), { demoOk: true }); return s; };

test('финансы: отчёты и итоги сделок сервера совпадают с демо до копейки', () => {
  const seed = copy(TADemo.seed());
  const state = seeded().load();
  for (const [from, to] of [['2026-05-01', '2026-05-31'], ['2026-08-01', '2026-08-31'], ['2026-10-01', '2026-10-21'], ['2000-01-01', '2026-10-21']]) {
    assert.deepEqual(copy(F.report(state, from, to)), copy(Demo.report(seed, from, to)));
    assert.deepEqual(copy(F.expenseRows(state, from, to)), copy(Demo.expenseRows(seed, from, to)));
  }
  for (const d of seed.deals) assert.deepEqual(copy(F.dealSummary(state, d.id)), copy(Demo.dealSummary(seed, d.id)));
  for (const b of seed.budgets) assert.equal(F.budgetActual(state, b), Demo.budgetActual(seed, b));
});

test('финансы: неверная операция отклоняется, база не меняется', () => {
  const s = seeded();
  const before = s.load().operations.length;
  const bad = { kind: 'acceptance', amount: 100, date: '2026-10-21', description: 'x', payer: 'project', order: 999, category: 'goods', dealId: 'deal-1' };
  assert.throws(() => s.change({ collection: 'operations', id: 'bad-1', patch: bad }), /Приёмка уже есть/);
  assert.throws(() => s.change({ collection: 'operations', id: 'bad-2', patch: { ...bad, kind: 'overhead', date: '2030-01-01' } }), /позже даты учёта/);
  assert.throws(() => s.change({ collection: 'operations', id: 'bad-3', patch: { ...bad, kind: 'overhead', amount: -5 } }), /Недопустимая сумма/);
  assert.equal(s.load().operations.length, before);
});

test('финансы: удаление помечает запись, восстановление возвращает, история пишется', () => {
  const s = seeded();
  const r0 = F.report(s.load(), '2000-01-01', '2026-10-21');
  s.change({ collection: 'operations', id: 'op-1', action: 'delete' });
  const after = s.load();
  assert.equal(after.operations.find((o) => o.id === 'op-1').deleted, true);
  assert.notEqual(F.report(after, '2000-01-01', '2026-10-21').cash, r0.cash);
  s.change({ collection: 'operations', id: 'op-1', action: 'restore' });
  assert.equal(F.report(s.load(), '2000-01-01', '2026-10-21').cash, r0.cash);
  assert.deepEqual(s.load().audit.slice(-2).map((a) => a.action), ['delete', 'restore']);
});

test('финансы: своя сделка от нуля — закупка, приёмка, оплата, прибыль; номер закупки хранится', () => {
  const db = mem();
  const s = createFinance({ db, clock });
  assert.equal(s.meta().empty, true);
  s.change({ collection: 'participants', id: 'p', patch: { name: 'Участник', color: '#112233', deleted: false } });
  s.change({ collection: 'accounts', id: 'a', patch: { name: 'Счёт', deleted: false } });
  s.change({ collection: 'deals', id: 'd', patch: { name: 'Рыба', customer: 'Школа', stage: 'won', planSale: 4018000, planBuy: 3000000, planDirect: 0, owner: 'p', tenderNumber: '32616525795', deleted: false } });
  const op = (id, kind, amount, order, extra = {}) => s.change({ collection: 'operations', id, patch: { kind, amount, date: '2026-10-20', description: kind, payer: 'project', order, category: kind === 'capital' ? 'other' : 'goods', accountId: 'a', dealId: 'd', ...extra, deleted: false } });
  op('c', 'capital', 5000000, 1, { partnerId: 'p', dealId: null });
  op('b', 'purchase', 3000000, 2);
  op('r', 'acceptance', 4018000, 3, { accountId: null });
  op('m', 'receipt', 4018000, 4);
  const st = s.load();
  assert.equal(s.meta().empty, false);
  const sum = F.dealSummary(st, 'd');
  assert.equal(sum.result, 1018000);
  assert.equal(sum.receivable, 0);
  assert.equal(F.report(st, '2026-10-01', '2026-10-21').result, 1018000);
  assert.equal(db.prepare('SELECT tender_number t FROM finance_deals').get().t, '32616525795');
});

test('финансы: учебный файл демо в рабочую базу не загружается, свой JSON — загружается, старое уходит в архив', () => {
  const s = store();
  assert.throws(() => s.importState(copy(TADemo.seed())), /учебные данные/);
  assert.equal(s.meta().empty, true);
  s.change({ collection: 'accounts', id: 'old', patch: { name: 'Старый', deleted: false } });
  const file = copy(TADemo.seed());
  for (const d of file.deals) d.customer = 'Заказчик';
  for (const o of file.operations) o.description = o.description.replace(' · демо', '');
  s.importState(file);
  const st = s.load();
  assert.equal(st.accounts.find((a) => a.id === 'old').deleted, true);
  assert.equal(st.deals.length, file.deals.length);
});

test('финансы: ячейка CSV с «=» обезвреживается, BOM и разделитель на месте', () => {
  assert.equal(F.csvCell('=СУММ(A1)'), `"'=СУММ(A1)"`);
  const s = store();
  s.change({ collection: 'participants', id: 'p', patch: { name: 'У', color: '#112233', deleted: false } });
  s.change({ collection: 'accounts', id: 'a', patch: { name: 'С', deleted: false } });
  s.change({ collection: 'operations', id: 'o', patch: { kind: 'capital', amount: 100, date: '2026-10-20', description: '=HYPERLINK("x")', payer: 'project', order: 1, category: 'other', accountId: 'a', partnerId: 'p', deleted: false } });
  const csv = s.exportCsv();
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.ok(csv.split('\r\n')[0].includes('";"'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
});
