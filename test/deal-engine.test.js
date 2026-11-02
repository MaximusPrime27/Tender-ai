// Расчёт сделки: числовые примеры A–J из задания «умный расчёт сделки» (версия 3) — синтетические данные.
// Суммы в тестах — в копейках (₽ × 100).

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../server/deal/engine');
const M = require('../server/deal/money');

const R = (rub) => Math.round(rub * 100); // ₽ → копейки (только для круглых сумм тестов)
const noVat = (id, kind, rub, extra = {}) => ({ id, kind, label: id, gross: R(rub), vat: 'without', deductible: null, ...extra });

test('деньги: копейки без двоичных дробей, разбор «1 234,56», пустое — не ноль, ошибки названы', () => {
  assert.equal(M.parseRub('1 234,56'), 123456);
  assert.equal(M.parseRub('1234,5 ₽'), 123450);
  assert.equal(M.parseRub(0.1 + 0.2), 30);
  assert.equal(M.parseRub(''), null);
  assert.equal(M.parseRub(null), null);
  assert.equal(M.parseRub(0), 0, 'ноль — подтверждённое значение, пустота — нет');
  for (const bad of ['12.345', 'abc', '-5', NaN, Infinity, -1]) assert.throws(() => M.parseRub(bad), M.MoneyError, String(bad));
  assert.throws(() => M.parsePct(150), /от 0 до 100/);
  assert.equal(M.parsePct('22,5'), 22.5);
  assert.throws(() => M.assertKop(2 ** 60), /целым числом копеек/);
  // HALF_UP: 0,5 копейки — вверх; отрицательные — симметрично
  assert.equal(M.mulDiv(1, 1, 2), 1);
  assert.equal(M.mulDiv(-1, 1, 2), -1);
  assert.equal(M.vatIncluded(R(122000), 22), R(22000));
});

const A = {
  seller_vat: { mode: 'not_payer' }, tax: { profile: 'revenue_pct', rate: 6 }, targets: { min_profit: 0, min_margin_pct: 10 },
  lines: [noVat('goods', 'goods', 700000), noVat('delivery', 'delivery', 20000), noVat('etp', 'etp_fee', 5000), noVat('guarantee', 'guarantee_fee', 6000), noVat('other', 'other', 4000)],
};

test('A. прибыль, маржа, наценка; цена без убытка и целевой порог на копеечной сетке; снижение', () => {
  const r = E.calcAt(A, R(1000000));
  assert.deepEqual([r.costs_total, r.tax, r.profit, r.margin_net_pct, r.markup_pct], [R(735000), R(60000), R(205000), 20.5, 36.05]);
  const b = E.priceBounds(A, { nmck: R(1000000) });
  assert.equal(b.break_even_price, 78191489);
  const be = E.calcAt(A, 78191489);
  assert.deepEqual([be.tax, be.profit], [4691489, 0]);
  assert.equal(E.calcAt(A, 78191488).profit, -1, 'на копейку ниже — убыток 0,01 ₽');
  assert.equal(b.target_price_floor, R(875000));
  const under = E.calcAt(A, R(875000) - 1);
  assert.ok(under.profit < M.pctOf(under.revenue_net, 10), 'на копейку ниже порога — маржа меньше 10%');
  assert.equal(b.max_decline_pct, 12.5);
  // цель недостижима — объяснение вместо ложного порога
  const impossible = E.priceBounds({ ...A, targets: { min_margin_pct: 95 } }, { nmck: R(1000000) });
  assert.equal(impossible.target_price_floor, null);
  assert.match(impossible.reasons.join(' '), /не получить/);
});

test('B. кассовый пик с возвратными обеспечениями: одновременные обязательства, нехватка при бюджете', () => {
  const ev = [
    { id: 'bid', day: 0, amount: -R(20000), kind: 'security_block' }, { id: 'goods', day: 1, amount: -R(700000), kind: 'supplier' },
    { id: 'perf', day: 1, amount: -R(50000), kind: 'security_block' }, { id: 'bid-back', day: 3, amount: R(20000), kind: 'security_release' },
    { id: 'delivery', day: 10, amount: -R(20000), kind: 'delivery' }, { id: 'pay', day: 40, amount: R(1000000), kind: 'customer' },
    { id: 'perf-back', day: 60, amount: R(50000), kind: 'security_release' },
  ];
  const c = E.cashflow(ev, { budget: R(700000) });
  assert.deepEqual([c.peak_need, c.peak_day, c.gap, c.end_balance, c.recovered_day], [R(770000), 1, R(70000), R(280000), 40]);
  // обеспечения в прибыль не входят: прибыль сделки = 1 000 000 − 700 000 − 20 000
  assert.equal(E.calcAt({ seller_vat: { mode: 'not_payer' }, tax: { profile: 'none' }, lines: [noVat('g', 'goods', 700000), noVat('d', 'delivery', 20000)] }, R(1000000)).profit, R(280000));
  // день оплаты и поступления совпал — расходы первыми
  assert.equal(E.cashflow([{ id: 'in', day: 5, amount: R(100) }, { id: 'out', day: 5, amount: -R(100) }]).peak_need, R(100));
});

test('C. разные поставщики и НДС: вычет только из строки с выделенным НДС и подтверждённым правом', () => {
  const C = { seller_vat: { mode: 'payer', rate: 22 }, tax: { profile: 'none' },
    lines: [{ id: 'A', kind: 'goods', label: 'A', gross: R(61000), vat: 'included', vat_rate: 22, deductible: true }, noVat('B', 'goods', 40000)] };
  const r = E.calcAt(C, R(122000));
  assert.deepEqual([r.revenue_net, r.vat_out, r.vat_in_deductible, r.vat_payable, r.costs_total, r.operating], [R(100000), R(22000), R(11000), R(11000), R(90000), R(10000)]);
  // вычет не подтверждён — строка считается целиком, с пометкой
  const un = E.calcAt({ ...C, lines: [{ ...C.lines[0], deductible: null }, C.lines[1]] }, R(122000));
  assert.equal(un.costs_total, R(101000));
  assert.ok(un.notes.some((n) => n.code === 'deduction_unconfirmed'));
  // режимы НДС не сливаются: «без НДС», 0% и освобождение — разные значения; неизвестный режим продавца — не ноль
  assert.equal(E.calcAt({ ...C, seller_vat: { mode: 'unknown' } }, R(122000)).profit, null);
  assert.throws(() => E.calcAt({ ...C, lines: [{ ...C.lines[1], vat: 'нет' }] }, R(122000)), /режим НДС/);
});

test('D. проценты по займу: простой процент, база 365, одно округление', () => {
  assert.equal(E.simpleInterest(R(100000), 20, 30), R(1643.84));
});

test('E. пример со скриншота: 1 000 000 ₽ и 900 000 ₽, доля 30% — распределение прибыли, а не второй расход', () => {
  const Ein = { seller_vat: { mode: 'not_payer' }, tax: { profile: 'revenue_pct', rate: 6 }, lines: [noVat('goods', 'goods', 550000), noVat('agg', 'aggregate', 50000)] };
  const r = E.calcAt(Ein, R(1000000));
  assert.deepEqual([r.tax, r.costs_total + r.tax, r.profit, r.margin_net_pct], [R(60000), R(660000), R(340000), 34]);
  const a = E.allocate(r.profit, [{ id: 'partner', label: 'Партнёр', pct: 30 }]);
  assert.deepEqual([a.shares[0].amount, a.company_rest], [R(102000), R(238000)]);
  assert.equal(E.allocate(r.profit, []).company_rest, R(340000), 'без доли результат компании прежний');
  const r9 = E.calcAt(Ein, R(900000));
  assert.deepEqual([r9.tax, r9.profit, r9.margin_net_pct], [R(54000), R(246000), 27.33]);
  const a9 = E.allocate(r9.profit, [{ id: 'partner', pct: 30 }]);
  assert.deepEqual([a9.shares[0].amount, a9.company_rest], [R(73800), R(172200)]);
  // при убытке доля 0, убыток виден; сумма долей больше 100% — ошибка
  assert.deepEqual([E.allocate(-R(5000), [{ id: 'p', pct: 30 }]).shares[0].amount, E.allocate(-R(5000), [{ id: 'p', pct: 30 }]).company_rest], [0, -R(5000)]);
  assert.throws(() => E.allocate(R(1000), [{ id: 'a', pct: 60 }, { id: 'b', pct: 50 }]), /больше 100%/);
  // агрегат и детальные строки той же суммы не складываются
  const both = E.calcAt({ ...Ein, lines: [...Ein.lines, noVat('d', 'delivery', 10000)] }, R(1000000));
  assert.equal(both.profit, null);
  assert.ok(both.problems.some((p) => p.code === 'aggregate_and_detail'));
});

test('F. оплаченный запас и прогноз от текущей даты: товар не списывается повторно', () => {
  const F = { seller_vat: { mode: 'not_payer' }, tax: { profile: 'none' }, lines: [noVat('stock', 'goods', 60000), noVat('d', 'delivery', 10000)] };
  assert.equal(E.calcAt(F, R(110000)).profit, R(40000));
  // от as_of: товар уже оплачен (в начальном остатке), впереди доставка и оплата заказчика
  const future = E.cashflow([{ id: 'd', day: 1, amount: -R(10000) }, { id: 'pay', day: 2, amount: R(110000) }], { budget: R(20000) });
  assert.deepEqual([future.peak_need, future.gap, future.end_balance], [R(10000), 0, R(100000)]);
  // полный цикл: товар и доставка до оплаты
  const full = E.cashflow([{ id: 'g', day: 0, amount: -R(60000) }, { id: 'd', day: 1, amount: -R(10000) }, { id: 'pay', day: 2, amount: R(110000) }]);
  assert.equal(full.peak_need, R(70000));
});

test('G. экономический порог не равен доступной цене: обеспечение по порогу цены и бюджет', () => {
  const G = { seller_vat: { mode: 'not_payer' }, tax: { profile: 'none' }, targets: { min_profit: 0, min_margin_pct: 0 }, lines: [noVat('g', 'goods', 600)] };
  const events = (p) => { const sec = p < R(800) ? R(100) : R(50); return [{ id: 'g', day: 0, amount: -R(600) }, { id: 's', day: 0, amount: -sec }, { id: 'pay', day: 5, amount: p }, { id: 's-back', day: 6, amount: sec }]; };
  assert.equal(E.priceBounds(G, { nmck: R(1000) }).break_even_price, R(600));
  const at750 = E.cashflow(events(R(750)), { budget: R(650) });
  assert.deepEqual([E.calcAt(G, R(750)).profit, at750.peak_need, at750.gap], [R(150), R(700), R(50)]);
  const at800 = E.cashflow(events(R(800)), { budget: R(650) });
  assert.deepEqual([E.calcAt(G, R(800)).profit, at800.peak_need, at800.gap], [R(200), R(650), 0]);
  assert.deepEqual(E.feasibleRanges(G, events, { lo: R(600), hi: R(1000), budget: R(650), breaks: [R(800)] }), [{ from: R(800), to: R(1000) }]);
});

test('H. основной налог и выходной НДС: два знаменателя маржи, НДС не вычитается дважды', () => {
  const H = { seller_vat: { mode: 'payer', rate: 22 }, tax: { profile: 'revenue_pct', rate: 6 },
    lines: [{ id: 'g', kind: 'goods', label: 'товар', gross: R(61000), vat: 'included', vat_rate: 22, deductible: true }] };
  const r = E.calcAt(H, R(122000));
  assert.deepEqual([r.revenue_net, r.costs_total, r.vat_out, r.vat_in_deductible, r.vat_payable, r.tax, r.profit, r.margin_net_pct, r.margin_gross_pct],
    [R(100000), R(50000), R(22000), R(11000), R(11000), R(6000), R(44000), 44, 36.07]);
  // денежная сверка: 122 000 − 61 000 − 11 000 − 6 000 = 44 000
  assert.equal(R(122000) - R(61000) - r.vat_payable - r.tax, r.profit);
});

test('I. бюджет сделки и портфель: один и тот же дефицит без двойного вычета', () => {
  const portfolio = E.cashflow([{ id: 'other', day: 0, amount: -R(20000) }, { id: 'this', day: 0, amount: -R(90000) }], { budget: R(100000) });
  assert.deepEqual([portfolio.peak_need, portfolio.gap], [R(110000), R(10000)]);
  const dedicated = E.cashflow([{ id: 'this', day: 0, amount: -R(90000) }], { budget: R(80000) });
  assert.equal(dedicated.gap, R(10000));
});

test('J. распределение одной копейки: наибольшие остатки, стабильный id, сумма не больше прибыли', () => {
  const a = E.allocate(1, [{ id: 'b', pct: 50 }, { id: 'a', pct: 50 }]);
  assert.deepEqual(a.shares.map((s) => [s.id, s.amount]), [['b', 0], ['a', 1]]);
  assert.deepEqual([a.fund, a.company_rest], [1, 0]);
  const swapped = E.allocate(1, [{ id: 'a', pct: 50 }, { id: 'b', pct: 50 }]);
  assert.deepEqual(swapped.shares.find((s) => s.id === 'a').amount, 1, 'порядок списка не меняет результат');
  // три равные доли от 1 ₽: фонд 0,99 ₽ округлён один раз, раздан без лишней копейки
  const three = E.allocate(R(1), [{ id: 'x', pct: 33 }, { id: 'y', pct: 33 }, { id: 'z', pct: 33 }]);
  assert.equal(three.shares.reduce((n, s) => n + s.amount, 0), three.fund);
});

test('комиссия площадки процентом с пределом пересчитывается при поиске цены', () => {
  const P = { seller_vat: { mode: 'not_payer' }, tax: { profile: 'none' }, targets: { min_profit: 0 },
    lines: [noVat('g', 'goods', 100000), { id: 'etp', kind: 'etp_fee', label: 'площадка', gross: null, vat: 'without', price_pct: { pct: 1, max: R(5000) } }] };
  assert.equal(E.calcAt(P, R(200000)).lines.find((l) => l.id === 'etp').amount, R(2000));
  assert.equal(E.calcAt(P, R(1000000)).lines.find((l) => l.id === 'etp').amount, R(5000), 'предел комиссии');
  // без убытка: P − 1% P (до копейки) − 100 000 ≥ 0 → 101 010,10 ₽ (комиссия 1 010,10 ₽, прибыль 0)
  assert.equal(E.priceBounds(P).break_even_price, 10101010);
  assert.equal(E.calcAt(P, 10101010).profit, 0);
  assert.ok(E.calcAt(P, 10101009).profit < 0);
});
