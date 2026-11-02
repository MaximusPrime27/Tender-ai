// Расчёт сделки: прибыль, НДС, налоговый резерв, границы цены, деньги по датам. Чистые функции: без сети и БД.
// Все суммы — целые копейки; проценты — точной дробью, округление HALF_UP до копейки на каждой строке.
// Версии формул и округления записываются в результат: одинаковые входы дают одинаковый ответ везде.
//
// Что считается чем:
//   выручка без НДС = цена договора − выходной НДС (если мы плательщик НДС);
//   экономическая стоимость строки = сумма без входного НДС, только если НДС в ней выделен, ставка известна и вычет
//     подтверждён; иначе — вся сумма (вычета нет);
//   операционный результат = выручка без НДС − экономические затраты;
//   налоговый резерв — по профилю (управленческая оценка по одной сделке, не окончательный налог периода);
//   прибыль = операционный результат − налоговый резерв.
// Возвратные обеспечения — не расход: это блокировка денег в календаре (cashflow), а не строка затрат.

const { MoneyError, assertKop, pctOf, vatIncluded, mulDiv } = require('./money');

const FORMULA_VERSION = 'deal-1';
const ROUNDING_POLICY = 'kop-half-up-per-line-1';

// Налоговые профили — алгоритм, а не только ставка. Это модели планирования одной сделки.
const TAX_PROFILES = {
  usn_income: { label: 'УСН «доходы»', base: 'revenue_net', note: 'Резерв от выручки без НДС. Уменьшение налога на страховые взносы и годовые итоги не учитываются.' },
  usn_income_expense: { label: 'УСН «доходы минус расходы»', base: 'revenue_minus_costs', note: 'Резерв от разницы выручки и затрат сделки. Минимальный налог 1% считается по итогам года, а не по сделке, — здесь не применяется.' },
  osn_profit: { label: 'ОСН, налог на прибыль', base: 'operating', note: 'Резерв от операционного результата сделки. Не учитывает убытки и расходы других сделок периода.' },
  revenue_pct: { label: 'Технический: процент от выручки', base: 'revenue_net', note: 'Упрощённая модель: процент от выручки без НДС.' },
  none: { label: 'Без основного налога', base: null, note: 'Основной налог не считается (технический профиль).' },
};

const VAT_MODES = ['included', 'without', 'exempt', 'zero', 'unknown'];
const LINE_KINDS = { goods: 'товар', delivery: 'доставка', etp_fee: 'комиссия площадки', guarantee_fee: 'комиссия банковской гарантии', install: 'монтаж и настройка', interest: 'проценты по займу', aggregate: 'доставка и прочие затраты одной суммой', other: 'прочие затраты' };

const pctNum = (num, den) => (den ? Math.round((num / den) * 10000) / 100 : null);

/** Сумма строки при цене договора price: фиксированная или процентом от цены с минимумом и пределом. */
function lineAmount(line, price) {
  if (line.price_pct) {
    let v = pctOf(price, line.price_pct.pct);
    if (line.price_pct.min != null) v = Math.max(v, line.price_pct.min);
    if (line.price_pct.max != null) v = Math.min(v, line.price_pct.max);
    return v;
  }
  return line.gross;
}

/**
 * Расчёт при цене договора price (копейки, с НДС, если мы его платим).
 * @param input {
 *   seller_vat: {mode: 'payer'|'not_payer'|'unknown', rate},
 *   tax: {profile, rate},
 *   lines: [{id, kind, label, gross|null, vat: 'included'|'without'|'exempt'|'zero'|'unknown', vat_rate, deductible: true|false|null, price_pct?}],
 *   targets: {min_profit, min_margin_pct}
 * }
 * @returns результат с полем problems — что мешает посчитать (тогда денежные итоги null)
 */
function calcAt(input, price) {
  assertKop(price, 'цена договора');
  const problems = [];
  const notes = [];
  const sv = input.seller_vat || { mode: 'unknown' };
  if (!['payer', 'not_payer'].includes(sv.mode)) problems.push({ code: 'seller_vat_unknown', text: 'Не указано, платите ли вы НДС: без этого нельзя посчитать выручку без НДС' });
  const profile = TAX_PROFILES[input.tax?.profile];
  if (!profile) problems.push({ code: 'tax_profile_unknown', text: 'Не выбран налоговый профиль' });
  if (profile && profile.base && !(input.tax.rate >= 0 && input.tax.rate < 100)) problems.push({ code: 'tax_rate', text: 'Ставка налога должна быть от 0 до 100%' });
  if (sv.mode === 'payer' && !(sv.rate > 0 && sv.rate < 100)) problems.push({ code: 'vat_rate', text: 'Не указана ставка НДС' });

  const lines = (input.lines || []).map((l) => {
    if (!VAT_MODES.includes(l.vat)) throw new MoneyError(`строка «${l.label}»: неизвестный режим НДС`);
    const amount = lineAmount(l, price);
    if (amount == null) { problems.push({ code: 'line_missing', line: l.id, text: `Нет суммы: ${l.label}` }); return { ...l, amount: null, cost: null, vat_in: 0 }; }
    assertKop(amount, l.label);
    let vatIn = 0;
    // входной НДС уменьшает затраты, только если мы плательщик, НДС в строке выделен по известной ставке и вычет подтверждён
    if (sv.mode === 'payer' && l.vat === 'included' && l.vat_rate > 0 && l.deductible === true) vatIn = vatIncluded(amount, l.vat_rate);
    else if (sv.mode === 'payer' && (l.vat === 'unknown' || (l.vat === 'included' && l.deductible == null))) notes.push({ code: 'deduction_unconfirmed', line: l.id, text: `${l.label}: вычет входного НДС не подтверждён — строка считается без вычета` });
    return { ...l, amount, vat_in: vatIn, cost: amount - vatIn };
  });
  // одна и та же сумма не может прийти и одной строкой «прочие затраты», и детальными строками
  if (lines.some((l) => l.kind === 'aggregate') && lines.some((l) => ['delivery', 'other', 'install'].includes(l.kind))) {
    problems.push({ code: 'aggregate_and_detail', text: 'Доставка и прочие затраты указаны и одной суммой, и по строкам — выберите одно, чтобы не посчитать их дважды' });
  }

  const vatOut = sv.mode === 'payer' && sv.rate > 0 ? vatIncluded(price, sv.rate) : 0;
  const revenueNet = price - vatOut;
  const out = { price, vat_out: vatOut, revenue_net: revenueNet, lines, problems, notes, formula_version: FORMULA_VERSION, rounding_policy: ROUNDING_POLICY };
  if (problems.length) return { ...out, costs_total: null, operating: null, tax: null, profit: null, economy: 'unknown' };

  const costs = lines.reduce((n, l) => n + l.cost, 0);
  const vatIn = lines.reduce((n, l) => n + l.vat_in, 0);
  const operating = revenueNet - costs;
  let taxBase = 0;
  if (profile.base === 'revenue_net') taxBase = revenueNet;
  else if (profile.base === 'revenue_minus_costs') taxBase = Math.max(0, revenueNet - costs);
  else if (profile.base === 'operating') taxBase = Math.max(0, operating);
  const tax = profile.base ? pctOf(taxBase, input.tax.rate) : 0;
  const profit = operating - tax;
  const vatPayable = vatOut - vatIn;
  if (vatPayable < 0) notes.push({ code: 'vat_negative', text: 'Входной НДС больше выходного: разница переносится по правилам налогового периода, денег из бюджета расчёт не ждёт' });

  const t = input.targets || {};
  const need = Math.max(t.min_profit || 0, pctOf(revenueNet, t.min_margin_pct || 0));
  const economy = profit < 0 ? 'loss' : profit === 0 ? 'break_even' : profit >= need ? 'profitable' : 'below_target';
  return {
    ...out,
    costs_total: costs, vat_in_deductible: vatIn, vat_payable: Math.max(0, vatPayable), vat_carry: Math.max(0, -vatPayable),
    operating, tax_base: taxBase, tax, tax_note: profile.note, profit,
    // у каждого процента — свой знаменатель: маржа на выручку без НДС и на всю цену договора — разные числа
    margin_net_pct: pctNum(profit, revenueNet), margin_gross_pct: pctNum(profit, price), markup_pct: pctNum(revenueNet - costs, costs),
    required_profit: need, economy,
  };
}

/** Прибыль не убывает с ростом цены (иначе поиск порога бинарным делением недопустим). */
function monotone(input) {
  const dep = (input.lines || []).filter((l) => l.price_pct);
  return dep.every((l) => l.price_pct.pct < 100) && !(input.tax?.rate >= 100);
}

/** Наименьшая цена (копейки) в [lo, hi], при которой ok — по монотонной функции; проверяются найденная и предыдущая. */
function minPriceWhere(lo, hi, ok) {
  if (!ok(hi)) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid; else lo = mid + 1;
  }
  if (!ok(lo) || (lo > 0 && ok(lo - 1))) throw new MoneyError('поиск цены: функция немонотонна на этом интервале');
  return lo;
}

/**
 * Границы цены: без убытка, целевой порог (рублёвый минимум и минимальная маржа одновременно), допустимое снижение.
 * @param nmck цена заказчика (копейки) — для процента снижения; null — процент не считается
 */
function priceBounds(input, { nmck = null } = {}) {
  if (!monotone(input)) return { supported: false, reason: 'Модель затрат с такими зависимостями от цены не поддержана для поиска порога' };
  const probe = calcAt(input, nmck || 100);
  if (probe.problems.length) return { supported: false, reason: probe.problems.map((p) => p.text).join('; ') };
  const t = input.targets || {};
  const profitAt = (p) => calcAt(input, p).profit;
  const targetOk = (p) => { const r = calcAt(input, p); return r.profit >= (t.min_profit || 0) && r.profit >= pctOf(r.revenue_net, t.min_margin_pct || 0); };
  // верхняя граница поиска: удваиваем, пока условие не выполнится (или не станет ясно, что недостижимо)
  const findHi = (ok) => { let hi = Math.max(nmck || 0, 100); for (let i = 0; i < 60 && !ok(hi); i++) { hi *= 2; if (hi > 1e15) return null; } return ok(hi) ? hi : null; };
  const hiBe = findHi((p) => profitAt(p) >= 0);
  const hiT = findHi(targetOk);
  const breakEven = hiBe == null ? null : minPriceWhere(0, hiBe, (p) => profitAt(p) >= 0);
  const target = hiT == null ? null : minPriceWhere(0, hiT, targetOk);
  const out = { supported: true, break_even_price: breakEven, target_price_floor: target, reasons: [] };
  if (target == null) out.reasons.push('Целевую прибыль не получить ни при какой цене при этих затратах');
  if (nmck && target != null) {
    if (target > nmck) { out.max_decline_pct = null; out.reasons.push('Целевой порог выше цены заказчика: в пределах НМЦК целевой прибыли не получить'); }
    // процент округляется вниз: цена по нему не должна оказаться ниже порога
    else out.max_decline_pct = Math.floor(((nmck - target) * 10000) / nmck) / 100;
  }
  return out;
}

/**
 * Доля прибыли получателям (управленческое распределение, не расход): от одной общей базы — положительной прибыли.
 * Фонд округляется один раз, копейки раздаются методом наибольших остатков; равенство — по стабильному id.
 */
function allocate(profit, shares = []) {
  const total = shares.reduce((n, s) => n + Number(s.pct || 0), 0);
  if (shares.some((s) => !(s.pct >= 0) || s.pct > 100)) throw new MoneyError('доля — от 0 до 100%');
  if (total > 100) throw new MoneyError(`сумма долей ${total}% больше 100%`);
  const base = Math.max(0, profit || 0);
  const S = 1000000n;
  const exact = shares.map((s) => ({ s, num: BigInt(base) * BigInt(Math.round(s.pct * 10000)) }));
  const fund = mulDiv(base, Math.round(total * 10000), 1000000);
  const rows = exact.map((e) => ({ id: String(e.s.id), label: e.s.label, pct: e.s.pct, amount: Number(e.num / S), rem: e.num % S }));
  let left = fund - rows.reduce((n, r) => n + r.amount, 0);
  const order = [...rows].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of order) { if (left <= 0) break; r.amount += 1; left -= 1; }
  const paid = rows.reduce((n, r) => n + r.amount, 0);
  return { base, fund, shares: rows.map(({ rem, ...r }) => r), company_rest: (profit || 0) - paid };
}

/**
 * Деньги по датам. События: {id, day, amount (знак: + приход, − расход), kind, label}. Блокировка обеспечения —
 * минус, его возврат — плюс; в прибыль они не входят. Если известен только день, расходы проводятся раньше
 * поступлений того же дня (осторожное допущение). Порядок, известный по смыслу, задаёт order: заём приходит до
 * оплаты, на которую взят (0), погашается из оплаты заказчика (3); по умолчанию расход — 1, приход — 2.
 * @returns {peak_need, peak_day, gap, end_balance, recovered_day, timeline}
 */
function cashflow(events, { budget = null } = {}) {
  const rank = (e) => e.order ?? (e.amount < 0 ? 1 : 2);
  const list = events.map((e, i) => ({ ...e, i, amount: assertKop(e.amount, e.label || 'событие') }))
    .sort((a, b) => a.day - b.day || rank(a) - rank(b) || a.i - b.i);
  let balance = 0;
  let min = 0;
  let peakDay = null;
  const timeline = [];
  for (const e of list) {
    balance += e.amount;
    timeline.push({ id: e.id, day: e.day, kind: e.kind, label: e.label, amount: e.amount, balance, source: e.source || null, estimate: Boolean(e.estimate) });
    if (balance < min) { min = balance; peakDay = e.day; }
  }
  const peak = -min;
  let recovered = null;
  if (peak > 0) for (const r of timeline) if (r.day >= peakDay && r.balance >= 0) { recovered = r.day; break; }
  return { peak_need: peak, peak_day: peakDay, gap: budget == null ? null : Math.max(0, peak - budget), end_balance: balance, recovered_day: recovered, timeline, order_policy: 'расходы раньше поступлений того же дня; заём приходит до оплаты поставщику, гасится из оплаты заказчика' };
}

/** Простые проценты: остаток × ставка × дни / 365, одно округление (копейки). */
function simpleInterest(principal, annualPct, days) {
  return mulDiv(principal, Math.round(annualPct * 10000) * days, 1000000 * 365);
}

/**
 * Проверка конкретных цен с учётом денег: каждая цена пересчитывается целиком (прибыль и календарь).
 * buildEvents(price) → события для этой цены. Возвращает допустимые диапазоны в [lo, hi] на сетке цен:
 * внутри участков между порогами правил потребность в деньгах — выпуклая функция цены, поэтому допустимые
 * цены участка — отрезок; на порогах правил участки разбиваются.
 * @param breaks — пороги цены, на которых меняются правила (например, размер обеспечения)
 */
function feasibleRanges(input, buildEvents, { lo, hi, budget, breaks = [] }) {
  const t = input.targets || {};
  const ok = (p) => {
    const r = calcAt(input, p);
    if (r.profit == null || r.profit < (t.min_profit || 0) || r.profit < pctOf(r.revenue_net, t.min_margin_pct || 0)) return false;
    return budget == null || cashflow(buildEvents(p), { budget }).gap === 0;
  };
  const cuts = [...new Set([lo, ...breaks.filter((b) => b > lo && b <= hi), hi + 1])].sort((a, b) => a - b);
  const ranges = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k];
    const b = cuts[k + 1] - 1;
    if (a > b) continue;
    // в участке условие выполняется на отрезке: ищем любую подходящую точку, затем края
    let inside = ok(a) ? a : ok(b) ? b : null;
    if (inside == null) {
      // выпуклость: минимум потребности — тернарным поиском, условие проверяем там
      let x = a; let y = b;
      const need = (p) => cashflow(buildEvents(p), { budget }).peak_need;
      for (let i = 0; i < 80 && y - x > 2; i++) { const m1 = x + Math.floor((y - x) / 3); const m2 = y - Math.floor((y - x) / 3); if (need(m1) <= need(m2)) y = m2; else x = m1; }
      for (let p = x; p <= y; p++) if (ok(p)) { inside = p; break; }
    }
    if (inside == null) continue;
    let l = a; let r = inside;
    while (l < r) { const m = Math.floor((l + r) / 2); if (ok(m)) r = m; else l = m + 1; }
    let L = inside; let R = b;
    while (L < R) { const m = Math.ceil((L + R) / 2); if (ok(m)) L = m; else R = m - 1; }
    ranges.push({ from: l, to: L });
  }
  // соседние отрезки склеиваются
  const merged = [];
  for (const g of ranges) { const last = merged[merged.length - 1]; if (last && g.from <= last.to + 1) last.to = Math.max(last.to, g.to); else merged.push({ ...g }); }
  return merged;
}

module.exports = { calcAt, priceBounds, allocate, cashflow, simpleInterest, feasibleRanges, TAX_PROFILES, LINE_KINDS, VAT_MODES, FORMULA_VERSION, ROUNDING_POLICY };
