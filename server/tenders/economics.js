// Калькулятор выгодности участия в закупке. Чистые функции без сети и БД.
// Модель: компания выигрывает торги, закупает товар у стороннего продавца, доставляет сама
// и получает оплату от заказчика после приёмки. Все суммы — рубли с округлением до копеек.

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const pct = (x) => (Number(x) || 0) / 100;

/** Настройки экономики по умолчанию (переопределяются в профиле компании). */
const ECONOMICS_DEFAULTS = {
  tax_mode: 'usn6',            // usn6 — УСН «доходы» 6%; usn15 — УСН «доходы минус расходы» 15%; osn — ОСН с НДС
  vat_rate: 22,                // НДС, % (с 2026 года — 22%)
  profit_tax_rate: 25,         // налог на прибыль для ОСН, %
  money_cost_rate: 20,         // стоимость денег, % годовых: заморозка обеспечений и оборотка
  bank_guarantee_rate: 3,      // комиссия банковской гарантии за обеспечение контракта, % годовых
  etp_fee_pct: 1,              // плата оператору площадки победителем, % от цены контракта
  etp_fee_cap: 5000,           // … но не больше, ₽
  expected_decline_pct: 10,    // ожидаемое снижение цены на торгах по умолчанию, %
  logistics_pct: 5,            // логистика по умолчанию, % от закупочной стоимости
  min_margin_pct: 10,          // минимальная приемлемая маржа, %
  min_profit: 10000,           // минимальная приемлемая прибыль, ₽
  default_delivery_days: 10,   // срок поставки, если не найден в документах, дней
  default_payment_days: 10,    // срок оплаты после поставки, если не найден, календарных дней
  bidding_days: 14,            // сколько дней заморожено обеспечение заявки (подача → итоги → контракт)
  min_days_to_deliver: 5,      // меньше этого срока на поставку — «мало времени»
  // Оценка доставки от продавца (поиск поставщиков)
  delivery_km_per_day: 500,    // средняя скорость транспортной компании, км в сутки
  delivery_handling_days: 2,   // отгрузка у продавца и выдача у перевозчика, дней
  delivery_min_cost: 1500,     // минимальная стоимость одной отправки, ₽
  delivery_reserve_days: 1,    // запас на непредвиденное, дней
};

/**
 * Прибыль при заданных закупочной стоимости и цене контракта (все прочие входы — из ctx).
 * Возвращает подробную раскладку, которую показывает интерфейс.
 */
function breakdown({ revenue, purchase, logistics, ctx }) {
  const s = ctx.settings;
  const cashDays = ctx.delivery_days + ctx.payment_days;
  const advance = r2(revenue * pct(ctx.advance_pct));
  const workingCapital = Math.max(0, r2(purchase + logistics - advance));
  const moneyCost = r2(workingCapital * pct(s.money_cost_rate) * cashDays / 365);
  const bidSecurity = r2(ctx.nmck * pct(ctx.bid_security_pct));
  const bidCost = r2(bidSecurity * pct(s.money_cost_rate) * s.bidding_days / 365);
  const contractSecurity = r2(revenue * pct(ctx.contract_security_pct));
  // Гарантия должна действовать весь срок контракта + 1 месяц.
  const guaranteeCost = r2(contractSecurity * pct(s.bank_guarantee_rate) * (cashDays + 30) / 365);
  const warrantySecurity = r2(revenue * pct(ctx.warranty_security_pct));
  const warrantyCost = r2(warrantySecurity * pct(s.bank_guarantee_rate) * 365 / 365);
  const etpFee = r2(Math.min(revenue * pct(s.etp_fee_pct), s.etp_fee_cap));
  const otherCosts = r2(moneyCost + bidCost + guaranteeCost + warrantyCost + etpFee);

  let tax;
  let vat = 0;
  let profit;
  if (s.tax_mode === 'osn') {
    const k = 1 + pct(s.vat_rate);
    // Предполагается, что продавцы и перевозчики — плательщики НДС (входной НДС к вычету).
    vat = r2(revenue - revenue / k - (purchase + logistics - (purchase + logistics) / k));
    const profitBeforeTax = r2(revenue / k - purchase / k - logistics / k - otherCosts);
    tax = r2(Math.max(0, profitBeforeTax) * pct(s.profit_tax_rate));
    profit = r2(profitBeforeTax - tax);
  } else if (s.tax_mode === 'usn15') {
    const expenses = r2(purchase + logistics + otherCosts);
    tax = r2(Math.max((revenue - expenses) * 0.15, revenue * 0.01)); // минимальный налог 1% от доходов
    profit = r2(revenue - expenses - tax);
  } else {
    tax = r2(revenue * 0.06);
    profit = r2(revenue - purchase - logistics - otherCosts - tax);
  }
  return {
    revenue: r2(revenue), purchase: r2(purchase), logistics: r2(logistics),
    etp_fee: etpFee, money_cost: moneyCost, bid_security: bidSecurity, bid_security_cost: bidCost,
    contract_security: contractSecurity, guarantee_cost: guaranteeCost,
    warranty_security: warrantySecurity, warranty_cost: warrantyCost,
    advance, vat, tax, profit,
    margin_pct: revenue > 0 ? r2((profit / revenue) * 100) : null,
    working_capital: workingCapital,
    own_money_peak: r2(Math.max(bidSecurity, workingCapital)),
    cash_days: cashDays,
  };
}

/** Порог прибыли, который считается приемлемым для выручки revenue. */
const requiredProfit = (revenue, s) => Math.max(s.min_profit, revenue * pct(s.min_margin_pct));

/** Бинарный поиск по монотонной функции: наибольшее x в [lo, hi], для которого ok(x). */
function searchMax(lo, hi, ok) {
  if (!ok(lo)) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid; else hi = mid;
  }
  return r2(lo);
}

/**
 * Полный расчёт.
 * @param input {
 *   nmck, items: [{quantity, unit_price, purchase_price|null}],
 *   decline_pct, logistics (₽|null), bid_security_pct, contract_security_pct, warranty_security_pct, advance_pct,
 *   delivery_days, payment_days, days_to_deadline, settings, sources
 * }
 */
function calculate(input) {
  const settings = { ...ECONOMICS_DEFAULTS, ...(input.settings || {}) };
  const nmck = Number(input.nmck) || 0;
  const items = input.items || [];
  const declinePct = input.decline_pct ?? settings.expected_decline_pct;
  const revenue = r2(nmck * (1 - pct(declinePct)));
  const ctx = {
    settings, nmck,
    advance_pct: input.advance_pct ?? 0,
    bid_security_pct: input.bid_security_pct ?? 0,
    contract_security_pct: input.contract_security_pct ?? 0,
    warranty_security_pct: input.warranty_security_pct ?? 0,
    delivery_days: input.delivery_days ?? settings.default_delivery_days,
    payment_days: input.payment_days ?? settings.default_payment_days,
  };

  const missing = items.filter((i) => i.purchase_price == null || !(i.quantity > 0));
  const reasons = [];
  const feasibility = [];
  if (input.days_to_deadline != null && input.days_to_deadline < 1) feasibility.push('подача заявок заканчивается меньше чем через сутки');
  if (ctx.delivery_days < settings.min_days_to_deliver) feasibility.push(`на поставку всего ${ctx.delivery_days} дн. — мало времени, чтобы закупить и привезти`);

  const base = {
    // own_price — цену назначили мы сами (заказчик свою не назвал)
    settings, inputs: { ...ctx, settings: undefined, decline_pct: declinePct, revenue, items, sources: input.sources || {}, own_price: Boolean(input.own_price),
      // own_bid — цена заказчика есть, но выручка посчитана от нашей цены предложения (она ниже цены заказчика)
      own_bid: Boolean(input.own_bid) },
    feasibility,
  };

  if (!nmck) {
    // Заказчик не назвал цену (запрос цен на площадке). Если известно, во сколько обойдётся товар, подсказываем,
    // какую цену предложить: без убытка и с порогом прибыли из профиля.
    const none = { ...base, verdict: 'нет данных', reasons: ['не известна НМЦК'], result: null, max_purchase: null, min_bid: null, costs: null, offer_price: null };
    if (!items.length || missing.length) return none;
    const purchase = r2(items.reduce((s, i) => s + i.purchase_price * i.quantity, 0));
    const logistics = input.logistics != null ? Number(input.logistics) : r2(purchase * pct(settings.logistics_pct));
    const at = (price) => breakdown({ revenue: price, purchase, logistics, ctx: { ...ctx, nmck: price } });
    return {
      ...none,
      reasons: ['не известна НМЦК', 'заказчик не назвал цену — введите свою цену предложения, и расчёт покажет маржу, выгоду и налоги'],
      costs: { purchase, logistics },
      offer_price: {
        breakeven: minPrice(purchase + logistics, (p) => at(p).profit >= 0),
        target: minPrice(purchase + logistics, (p) => at(p).profit >= requiredProfit(p, settings)),
      },
    };
  }
  if (!items.length || missing.length) {
    const what = !items.length ? 'не известны позиции закупки' : `нет закупочной цены для ${missing.length} из ${items.length} позиций`;
    return {
      ...base, verdict: 'нет данных',
      reasons: [what, 'укажите цену закупки вручную или дождитесь поиска поставщиков'],
      result: null,
      max_purchase: maxPurchase({ revenue, ctx, input, settings }),
      min_bid: null, costs: null, offer_price: null,
    };
  }

  const purchase = r2(items.reduce((s, i) => s + i.purchase_price * i.quantity, 0));
  const logisticsOf = (p) => (input.logistics != null ? Number(input.logistics) : r2(p * pct(settings.logistics_pct)));
  const result = breakdown({ revenue, purchase, logistics: logisticsOf(purchase), ctx });
  const need = requiredProfit(revenue, settings);

  let verdict;
  if (result.profit >= need) {
    verdict = 'выгодно';
    reasons.push(`прибыль ${fmt(result.profit)} ₽ (${result.margin_pct}%) — выше порога ${fmt(need)} ₽`);
  } else if (result.profit > 0) {
    verdict = 'на грани';
    reasons.push(`прибыль ${fmt(result.profit)} ₽ (${result.margin_pct}%) — ниже порога ${fmt(need)} ₽ из профиля`);
  } else {
    verdict = 'невыгодно';
    reasons.push(`при такой цене закупки получается убыток ${fmt(-result.profit)} ₽`);
  }
  if (feasibility.length) reasons.push(...feasibility);

  // Минимальная цена контракта, при которой прибыль ещё не ниже порога (до неё можно снижаться на торгах).
  const minRevenue = searchMax(0, nmck, (x) => {
    const rev = nmck - x;
    return breakdown({ revenue: rev, purchase, logistics: logisticsOf(purchase), ctx }).profit >= requiredProfit(rev, settings);
  });
  const min_bid = minRevenue == null ? null : {
    price: r2(nmck - minRevenue),
    max_decline_pct: r2((minRevenue / nmck) * 100),
  };

  // Цену назначили мы сами — рядом показываем ориентиры: без убытка и с порогом прибыли из профиля.
  let offer_price = null;
  if (input.own_price) {
    const at = (price) => breakdown({ revenue: price * (1 - pct(declinePct)), purchase, logistics: logisticsOf(purchase), ctx: { ...ctx, nmck: price } });
    offer_price = {
      breakeven: minPrice(purchase, (p) => at(p).profit >= 0),
      target: minPrice(purchase, (p) => at(p).profit >= requiredProfit(p * (1 - pct(declinePct)), settings)),
    };
  }

  return { ...base, verdict, reasons, result, max_purchase: maxPurchase({ revenue, ctx, input, settings }), min_bid, costs: { purchase, logistics: result.logistics }, offer_price };
}

/** Наименьшая цена (целые рубли), начиная с from, при которой выполняется ok; null — не нашлась в разумных пределах. */
function minPrice(from, ok) {
  let lo = Math.max(0, from);
  let hi = Math.max(1000, lo * 1.5);
  for (let i = 0; i < 30 && !ok(hi); i++) hi *= 2;
  if (!ok(hi)) return null;
  for (let i = 0; i < 60 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid; else lo = mid;
  }
  return Math.ceil(hi);
}

/** Максимальная закупочная стоимость (и цена за единицу, если позиция одна), при которой прибыль не ниже порога. */
function maxPurchase({ revenue, ctx, input, settings }) {
  const need = requiredProfit(revenue, settings);
  const logisticsOf = (p) => (input.logistics != null ? Number(input.logistics) : r2(p * pct(settings.logistics_pct)));
  const total = searchMax(0, revenue, (p) => breakdown({ revenue, purchase: p, logistics: logisticsOf(p), ctx }).profit >= need);
  if (total == null) return null;
  const items = input.items || [];
  const qtyKnown = items.length === 1 && items[0].quantity > 0;
  return { total, unit: qtyKnown ? r2(total / items[0].quantity) : null };
}

const fmt = (n) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 0 });

/**
 * «Что будет при другой цене»: тот же расчёт при нескольких ценах предложения — цена заказчика без снижения, −5%,
 * −10%, −15%, текущая цена расчёта и самая низкая цена, при которой прибыль ещё не ниже порога. Ничего не
 * сохраняет: считает той же функцией calculate, меняя только снижение. Только для закупок с ценой заказчика —
 * где её нет, ориентиры цены уже показаны рядом с полем (offer_price).
 * @returns {Array<{label, price, decline_pct, profit, margin_pct, verdict, current: boolean}>}
 */
function priceVariants(input, result) {
  const nmck = Number(input?.nmck) || 0;
  if (!(nmck > 0) || input.own_price || !result?.result) return [];
  const now = result.inputs.decline_pct;
  const rows = [
    { label: 'цена заказчика, без снижения', decline: 0 },
    { label: 'на 5% ниже', decline: 5 },
    { label: 'на 10% ниже', decline: 10 },
    { label: 'на 15% ниже', decline: 15 },
    { label: input.own_bid ? 'ваша цена' : 'как в расчёте сейчас', decline: now, current: true },
    ...(result.min_bid ? [{ label: 'самая низкая цена с вашей минимальной прибылью', decline: result.min_bid.max_decline_pct, price: result.min_bid.price, floor: true }] : []),
  ];
  const seen = new Map(); // одна цена — одна строка: «как сейчас» и «минимум» важнее круглых процентов
  for (const r of rows) {
    const price = r.price ?? Math.round(nmck * (1 - r.decline / 100) * 100) / 100;
    const prev = seen.get(price);
    if (prev && !r.current && !r.floor) continue;
    seen.set(price, { ...(prev || {}), ...r, price, label: prev?.current && r.floor ? `${prev.label} — она же минимальная с вашей прибылью` : r.current && prev?.floor ? `${r.label} — она же минимальная с вашей прибылью` : r.label, current: Boolean(r.current || prev?.current) });
  }
  return [...seen.values()].sort((a, b) => b.price - a.price).map((r) => {
    const res = r.current ? result : calculate({ ...input, decline_pct: r.decline });
    return {
      label: r.label, price: r.price, decline_pct: Math.round(r.decline * 100) / 100,
      profit: res.result?.profit ?? null, margin_pct: res.result?.margin_pct ?? null, verdict: res.verdict, current: Boolean(r.current),
    };
  });
}

module.exports = { calculate, breakdown, priceVariants, ECONOMICS_DEFAULTS, r2 };
