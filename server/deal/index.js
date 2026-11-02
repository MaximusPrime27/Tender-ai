// Расчёт сделки по закупке: собирает входы из того, что уже есть в сервисе (цена, позиции и выбранные предложения,
// условия из разбора документации, профиль, анкета участника, полнота чтения, состояние заявки), добавляет ручные
// поправки и считает движком server/deal/engine.js. Ничего не отправляет наружу.
//
// У каждого существенного значения — источник и статус: confirmed (подтверждено), estimate (оценка), missing (нет),
// conflict (расходится), expired (истёк срок основания). Отсутствие значения не превращается в ноль.

const crypto = require('node:crypto');
const E = require('./engine');
const { parseRub, parsePct, MoneyError, pctOf, fmt } = require('./money');
const { createDealStore } = require('./store');
const { buildChecks, GROUPS } = require('./checks');

const ST = { confirmed: 'подтверждено', estimate: 'оценка', missing: 'нет данных', conflict: 'расхождение', expired: 'срок основания истёк', not_applicable: 'не применяется' };
const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);
const kop = (rub) => (rub == null || !Number.isFinite(Number(rub)) ? null : Math.round(Number(rub) * 100));

// Налоговый режим анкеты/профиля → профиль движка. Патент, НПД, АУСН в сделке не моделируются.
const TAX_FROM_DOSSIER = { usn_income: ['usn_income', 6], usn_income_expense: ['usn_income_expense', 15], osn: ['osn_profit', 25] };
const TAX_FROM_PROFILE = { usn6: ['usn_income', 6], usn15: ['usn_income_expense', 15], osn: ['osn_profit', null] };
const STD_RATE = { usn_income: 6, usn_income_expense: 15, osn_profit: 25 };

function createDealService({ repo, details = null, dossier = null, bids = null, clock = () => new Date() }) {
  const store = createDealStore(repo.db, () => clock().toISOString());

  /** Входы расчёта: из карточки закупки и ручных поправок. Без вычислений — только сбор и статусы. */
  async function gather(tenderId) {
    const tender = repo.getTender(tenderId);
    if (!tender) throw Object.assign(new Error('Закупка не найдена'), { status: 404 });
    let econ = repo.getEconomics(tenderId);
    if (!econ?.result?.inputs && details?.computeEconomics) { await details.computeEconomics(tenderId, { fetch: false }).catch(() => null); econ = repo.getEconomics(tenderId); }
    const inp = econ?.result?.inputs || {};
    const settings = { ...(econ?.result?.settings || {}), ...(repo.getProfile().economics || {}) };
    const ov = store.inputs(tenderId);
    const d = dossier?.get?.() || null;
    const items = repo.getItems(tenderId);
    const facts = [];
    const fact = (key, label, value, status, source) => { facts.push({ key, label, value, status, status_label: ST[status], source }); return value; };

    // --- цена ---
    const nmck = kop(tender.price);
    const calcRevenue = kop(inp.revenue);
    const contract = ov.contract_price != null ? kop(ov.contract_price) : calcRevenue;
    fact('contract_price', 'Ожидаемая цена договора', contract, contract == null ? 'missing' : ov.contract_price != null ? 'estimate' : 'estimate',
      ov.contract_price != null ? 'введена вами' : inp.own_bid || inp.own_price ? 'ваша цена предложения (шаг «Расчёт»)' : `цена заказчика минус ожидаемое снижение ${inp.decline_pct ?? '?'}%`);
    fact('nmck', 'Цена заказчика (НМЦК)', nmck, nmck == null ? 'missing' : 'confirmed', nmck == null ? 'не указана' : 'извещение');

    // --- НДС участника и налоговый профиль ---
    let sellerVat;
    if (ov.vat_payer != null) sellerVat = { mode: ov.vat_payer ? 'payer' : 'not_payer', status: 'estimate', source: 'указано в расчёте вручную' };
    else if (d?.data?.vat_payer != null) sellerVat = { mode: d.data.vat_payer ? 'payer' : 'not_payer', status: 'confirmed', source: 'анкета участника' };
    else if (settings.tax_mode === 'osn') sellerVat = { mode: 'payer', status: 'estimate', source: 'по налоговому режиму профиля (ОСН) — подтвердите в анкете' };
    else if (settings.tax_mode) sellerVat = { mode: 'not_payer', status: 'estimate', source: 'по налоговому режиму профиля (УСН) — с 2025 года УСН может платить НДС, подтвердите в анкете' };
    else sellerVat = { mode: 'unknown', status: 'missing', source: 'не указано' };
    sellerVat.rate = Number(ov.vat_rate ?? settings.vat_rate ?? 22);
    fact('seller_vat', 'Вы плательщик НДС', sellerVat.mode === 'payer' ? `да, ${sellerVat.rate}%` : sellerVat.mode === 'not_payer' ? 'нет' : null, sellerVat.status, sellerVat.source);

    let tax;
    const fromD = TAX_FROM_DOSSIER[d?.data?.tax_regime];
    const fromP = TAX_FROM_PROFILE[settings.tax_mode];
    if (ov.tax_profile) tax = { profile: ov.tax_profile, rate: Number(ov.tax_rate), status: 'estimate', source: 'выбран в расчёте вручную' };
    else if (fromD) tax = { profile: fromD[0], rate: fromD[1], status: 'estimate', source: 'налоговый режим из анкеты участника; ставка — стандартная' };
    else if (d?.data?.tax_regime) tax = { profile: null, rate: null, status: 'missing', source: `режим «${d.data.tax_regime}» в расчёте сделки не моделируется` };
    else if (fromP) tax = { profile: fromP[0], rate: fromP[1] ?? Number(settings.profit_tax_rate ?? 25), status: 'estimate', source: 'налоговый режим из профиля' };
    else tax = { profile: null, rate: null, status: 'missing', source: 'не указан' };
    if (tax.profile && ov.tax_confirmed_by) { tax.status = 'confirmed'; tax.source = `${tax.source}; подтверждено: ${ov.tax_confirmed_by}`; }
    fact('tax', 'Налоговый профиль', tax.profile ? `${E.TAX_PROFILES[tax.profile]?.label || tax.profile}, ${tax.rate}%` : null, tax.status, tax.source);

    // --- строки затрат ---
    const lines = [];
    const confirmations = ov.price_confirmations || {};
    for (const it of inp.items || []) {
      const qty = Number(it.quantity);
      const unit = it.purchase_price == null ? null : kop(it.purchase_price);
      const gross = unit == null || !(qty > 0) ? null : Math.round(unit * qty);
      const conf = confirmations[it.id];
      const today = clock().toISOString().slice(0, 10);
      // цена подтверждена коммерческим предложением — с автором, основанием и сроком действия
      const status = gross == null ? 'missing' : conf ? (conf.valid_until && conf.valid_until < today ? 'expired' : 'confirmed') : 'estimate';
      const vat = (ov.line_vat || {})[it.id] || {};
      lines.push({ id: `goods-${it.id}`, item_id: it.id, kind: 'goods', label: `${it.name}${qty > 0 ? ` × ${qty}` : ''}`, gross, vat: vat.mode || 'unknown', vat_rate: vat.rate ?? sellerVat.rate, deductible: vat.deductible ?? null,
        status, source: conf ? `КП: ${conf.basis} (${conf.by}${conf.valid_until ? `, действует до ${conf.valid_until}` : ''})` : it.purchase_source || 'цена не найдена',
        ...(it.purchase_warning && !conf ? { warning: it.purchase_warning } : {}) });
    }
    if (!(inp.items || []).length) lines.push({ id: 'goods', kind: 'goods', label: 'Товар', gross: null, vat: 'unknown', status: 'missing', source: 'позиции закупки не загружены' });
    const logistics = kop(econ?.result?.costs?.logistics ?? econ?.result?.result?.logistics);
    const logisticsEstimated = inp.sources?.logistics == null && ov.delivery == null;
    if (ov.aggregate_costs != null) {
      lines.push({ id: 'aggregate', kind: 'aggregate', label: 'Доставка и прочие затраты (одной суммой)', gross: kop(ov.aggregate_costs), vat: 'without', status: 'estimate', source: 'введено вами одной суммой' });
    } else {
      const deliv = ov.delivery != null ? kop(ov.delivery) : logistics;
      lines.push({ id: 'delivery', kind: 'delivery', label: 'Доставка', gross: deliv, vat: (ov.line_vat || {}).delivery?.mode || 'unknown', vat_rate: sellerVat.rate, deductible: (ov.line_vat || {}).delivery?.deductible ?? null,
        status: deliv == null ? 'missing' : ov.delivery != null ? 'estimate' : 'estimate',
        source: ov.delivery != null ? 'введено вами' : logisticsEstimated ? `оценка: ${settings.logistics_pct ?? 5}% от стоимости товара (профиль)` : 'расчёт доставки по выбранным продавцам' });
      for (const [i, x] of (ov.extra_lines || []).entries()) lines.push({ id: `extra-${i}`, kind: x.kind === 'install' ? 'install' : 'other', label: String(x.label || 'Прочие затраты').slice(0, 100), gross: kop(x.amount), vat: 'without', status: 'estimate', source: 'введено вами' });
    }
    // комиссия площадки: правило из профиля (процент и предел), не проверенный тариф конкретной площадки
    if (settings.etp_fee_pct > 0) lines.push({ id: 'etp', kind: 'etp_fee', label: `Плата площадке${tender.platform ? ` (${tender.platform})` : ''}`, gross: null, vat: 'without',
      price_pct: { pct: Number(settings.etp_fee_pct), max: settings.etp_fee_cap != null ? kop(settings.etp_fee_cap) : null }, status: 'estimate',
      source: `${settings.etp_fee_pct}% от цены, не больше ${settings.etp_fee_cap ?? '—'} ₽ — правило профиля; тариф площадки не сверен` });

    // --- обеспечения и сроки (для денег по датам) ---
    const days = {
      contract: Number(settings.bidding_days ?? 14),
      delivery: Number(ov.delivery_days ?? inp.delivery_days ?? settings.default_delivery_days ?? 10),
      payment: Number(ov.payment_days ?? inp.payment_days ?? settings.default_payment_days ?? 10),
      security_return: Number(ov.security_return_days ?? 30),
    };
    const src = inp.sources || {};
    fact('delivery_days', 'Срок поставки, дней', days.delivery, src.delivery_days?.includes('профил') || !src.delivery_days ? 'estimate' : 'confirmed', ov.delivery_days != null ? 'введено вами' : src.delivery_days || 'по умолчанию из профиля');
    fact('payment_days', 'Оплата после поставки, дней', days.payment, src.payment_days?.includes('профил') || !src.payment_days ? 'estimate' : 'confirmed', ov.payment_days != null ? 'введено вами' : src.payment_days || 'по умолчанию из профиля');
    const security = {
      bid_pct: Number(inp.bid_security_pct ?? 0), contract_pct: Number(inp.contract_security_pct ?? 0), advance_pct: Number(inp.advance_pct ?? 0),
      contract_mode: ov.contract_security_mode === 'guarantee' ? 'guarantee' : 'cash', guarantee_rate: Number(ov.guarantee_rate ?? settings.bank_guarantee_rate ?? 3),
    };
    fact('bid_security', 'Обеспечение заявки', security.bid_pct ? `${security.bid_pct}% от НМЦК` : 'не требуется', src.bid_security_pct?.includes('профил') ? 'estimate' : 'confirmed', src.bid_security_pct || 'извещение');
    fact('contract_security', 'Обеспечение исполнения', security.contract_pct ? `${security.contract_pct}% от цены договора, ${security.contract_mode === 'guarantee' ? 'банковской гарантией' : 'деньгами'}` : 'не требуется', src.contract_security_pct?.includes('профил') ? 'estimate' : 'confirmed', src.contract_security_pct || 'извещение');
    if (security.contract_pct && security.contract_mode === 'guarantee') {
      const termDays = days.delivery + days.payment + days.security_return;
      lines.push({ id: 'guarantee', kind: 'guarantee_fee', label: 'Комиссия банковской гарантии', gross: null, vat: 'exempt',
        price_pct: { pct: Math.round(security.contract_pct * security.guarantee_rate * termDays / 365 * 10000 / 100) / 10000 }, status: 'estimate',
        source: `${security.guarantee_rate}% годовых от суммы гарантии на ${termDays} дн. — оценка, условия конкретного банка не загружены` });
    }
    const budget = ov.budget != null ? kop(ov.budget) : null;
    fact('budget', 'Свои свободные деньги на сделку', budget, budget == null ? 'missing' : 'estimate', budget == null ? 'не указано' : 'указано вами');
    const loan = ov.loan && ov.loan.amount > 0 ? { amount: kop(ov.loan.amount), rate: Number(ov.loan.rate || 0), confirmed: Boolean(ov.loan.confirmed) } : null;

    const targets = { min_profit: kop(settings.min_profit ?? 0) || 0, min_margin_pct: Number(settings.min_margin_pct ?? 0) };
    const stress = { goods_pct: Number(ov.stress?.goods_pct ?? 5), delivery_pct: Number(ov.stress?.delivery_pct ?? 20), payment_delay_days: Number(ov.stress?.payment_delay_days ?? 15) };
    return { tender, econ, settings, ov, d, items, facts, nmck, contract, sellerVat, tax, lines, days, security, budget, loan, targets, stress, reward: ov.reward || { enabled: false, shares: [] } };
  }

  /** Движок: вход для конкретного варианта (стресс меняет конкретные строки и даты, а не цвет). */
  function engineInput(g, mod = {}) {
    const k = (v, pct) => (v == null ? null : Math.round(v * (1 + (pct || 0) / 100)));
    const lines = g.lines.map((l) => (l.kind === 'goods' ? { ...l, gross: k(l.gross, mod.goods_pct) } : l.kind === 'delivery' ? { ...l, gross: k(l.gross, mod.delivery_pct) } : l));
    const days = { ...g.days, payment: g.days.payment + (mod.payment_delay_days || 0) };
    // проценты по займу — расход по фактическому сроку займа (от заключения до оплаты заказчика)
    if (g.loan) lines.push({ id: 'interest', kind: 'interest', label: `Проценты по займу ${g.loan.rate}% годовых`, gross: E.simpleInterest(g.loan.amount, g.loan.rate, days.delivery + days.payment), vat: 'exempt', status: g.loan.confirmed ? 'confirmed' : 'estimate', source: g.loan.confirmed ? 'условия займа подтверждены вами' : 'желаемый заём — условия не подтверждены' });
    return { input: { seller_vat: g.sellerVat, tax: g.tax, lines, targets: g.targets }, days };
  }

  /** События денег при цене price: день 0 — подача заявки, дальше — заключение, поставка, оплата, возвраты. */
  function events(g, days, price, calc) {
    const C = days.contract;
    const pay = C + days.delivery + days.payment;
    const ev = [];
    const add = (id, day, amount, kind, label, estimate = true, order) => { if (amount) ev.push({ id, day, amount, kind, label, estimate, ...(order != null ? { order } : {}) }); };
    const bid = g.nmck ? pctOf(g.nmck, g.security.bid_pct) : 0;
    add('bid-block', 0, -bid, 'security_block', 'Блокировка обеспечения заявки', false);
    add('bid-release', C, bid, 'security_release', 'Освобождение обеспечения заявки (после заключения договора — оценка)');
    // антидемпинговое правило 44-ФЗ: при снижении на 25% и больше обеспечение исполнения — в 1,5 раза (осторожное допущение)
    const decline = g.nmck ? (g.nmck - price) / g.nmck : 0;
    const k = String(g.tender.law) === '44' && decline >= 0.25 ? 1.5 : 1;
    const contractSec = g.security.contract_mode === 'cash' ? Math.round(pctOf(price, g.security.contract_pct) * k) : 0;
    add('perf-block', C, -contractSec, 'security_block', `Обеспечение исполнения деньгами${k > 1 ? ' (×1,5 — антидемпинговая мера)' : ''}`);
    add('advance', C, pctOf(price, g.security.advance_pct), 'customer', 'Аванс заказчика');
    for (const l of calc.lines) {
      if (l.amount == null) continue;
      const day = l.kind === 'goods' ? C : l.kind === 'delivery' || l.kind === 'aggregate' ? C + 1 : l.kind === 'guarantee_fee' ? C : l.kind === 'etp_fee' ? C : l.kind === 'interest' ? pay : C + days.delivery;
      add(`pay-${l.id}`, day, -l.amount, l.kind === 'interest' ? 'loan' : 'supplier', `Оплата: ${l.label}`, true, l.kind === 'interest' ? 3 : undefined);
    }
    // заём берут под оплату поставщику — он приходит раньше неё; гасят из оплаты заказчика — после неё
    if (g.loan) { add('loan-in', C, g.loan.amount, 'loan', 'Получение займа (тело — не доход)', true, 0); add('loan-out', pay, -g.loan.amount, 'loan', 'Погашение займа (тело — не расход)', true, 3); }
    add('customer-pay', pay, price - pctOf(price, g.security.advance_pct), 'customer', 'Оплата заказчика после приёмки');
    add('perf-release', pay + days.security_return, contractSec, 'security_release', 'Возврат обеспечения исполнения (оценка срока)');
    // налог и НДС — уплата после получения денег (оценка срока; точный календарь — у бухгалтера)
    if (calc.tax) add('tax', pay + 30, -calc.tax, 'tax', 'Уплата налога (резерв, оценка срока)');
    if (calc.vat_payable) add('vat', pay + 30, -calc.vat_payable, 'tax', 'Уплата НДС (оценка срока)');
    return ev;
  }

  /** Один вариант: прибыль, границы цены, деньги по датам, допустимые цены. */
  function variant(g, name, label, mod) {
    const { input, days } = engineInput(g, mod);
    if (g.contract == null) return { name, label, calc: null, problems: ['Нет ожидаемой цены договора'] };
    const calc = E.calcAt(input, g.contract);
    const bounds = E.priceBounds(input, { nmck: g.nmck });
    const ev = calc.profit == null ? [] : events(g, days, g.contract, calc);
    const cash = calc.profit == null ? null : E.cashflow(ev, { budget: g.budget });
    let ranges = null;
    if (calc.profit != null && g.nmck && bounds.supported && bounds.target_price_floor != null && bounds.target_price_floor <= g.nmck) {
      const build = (p) => events(g, days, p, E.calcAt(input, p));
      const breaks = String(g.tender.law) === '44' ? [Math.ceil(g.nmck * 0.75) + 1] : [];
      try { ranges = E.feasibleRanges(input, build, { lo: bounds.target_price_floor, hi: g.nmck, budget: g.budget, breaks }); } catch { ranges = null; }
    }
    const reward = calc.profit != null && g.reward.enabled ? E.allocate(calc.profit, g.reward.shares || []) : null;
    return { name, label, mod, days, calc, bounds, cash, ranges, reward };
  }

  /** Полный расчёт закупки: варианты, проверки, качество, оси, следующее действие. */
  async function view(tenderId) {
    const g = await gather(tenderId);
    const hash = sha({ contract: g.contract, nmck: g.nmck, lines: g.lines.map((l) => [l.id, l.gross, l.vat, l.deductible, l.status, l.price_pct]), vat: g.sellerVat, tax: g.tax, days: g.days, security: g.security, budget: g.budget, loan: g.loan, reward: g.reward, v: E.FORMULA_VERSION });
    const base = variant(g, 'base', 'Базовый', {});
    const cautious = variant(g, 'cautious', `Осторожный: товар +${g.stress.goods_pct}%, доставка +${g.stress.delivery_pct}%, оплата позже на ${g.stress.payment_delay_days} дн.`, g.stress);
    const checks = buildChecks({ g, base, store, hash, repo });
    const reasons = qualityReasons(g, base);
    const quality = reasons.some((r) => r.level === 'incomplete') ? 'incomplete' : reasons.some((r) => r.level === 'needs_review') ? 'needs_review'
      : reasons.some((r) => r.level === 'estimate') ? 'calculated_with_estimates' : 'verified_snapshot';
    const doc = bids?.statusFor ? bids.statusFor(tenderId) : null;
    const goodsBlocked = checks.some((c) => c.blocking && c.state === 'flagged');
    const axes = {
      economy: base.calc?.economy || 'unknown',
      money: !base.cash || g.budget == null ? 'unknown' : base.cash.gap > 0 ? 'shortfall' : 'sufficient',
      goods: goodsBlocked ? 'blocked' : checks.filter((c) => ['delivery', 'supplier_price'].includes(c.id)).every((c) => c.state === 'clear') ? 'verified' : 'needs_review',
      documents: doc ? doc.status : 'module_unavailable',
    };
    const last = store.snapshots(tenderId)[0] || null;
    return {
      tender: { id: g.tender.id, number: g.tender.number, title: g.tender.title, law: g.tender.law, platform: g.tender.platform },
      versions: { formula: E.FORMULA_VERSION, rounding: E.ROUNDING_POLICY, inputs_hash: hash, computed_at: clock().toISOString() },
      facts: g.facts, lines: g.lines.map(({ price_pct, ...l }) => ({ ...l, depends_on_price: Boolean(price_pct), status_label: ST[l.status] })),
      inputs: { ...g.ov, budget: g.budget == null ? null : g.budget / 100 },
      variants: [base, cautious], checks, quality: { status: quality, reasons }, axes,
      next_action: nextAction(g, base, reasons, checks),
      snapshot: last ? { id: last.id, at: last.at, by: last.by, current: last.inputs_hash === hash } : null,
      stress: g.stress, groups: GROUPS.map((x) => x.id),
    };
  }

  // факт расчёта → поле формы «Исходные данные расчёта», где его можно вписать
  const FACT_FIELD = { contract_price: 'contract_price', delivery_days: 'delivery_days', payment_days: 'payment_days', budget: 'budget' };

  function qualityReasons(g, base) {
    const out = [];
    const add = (level, code, text, action, extra = {}) => out.push({ level, code, text, action, ...extra });
    for (const l of g.lines) {
      if (l.status === 'missing') add('incomplete', 'line_missing', `Нет суммы: ${l.label}`, l.kind === 'goods' ? 'Выберите товар на шаге «Поставщики» или впишите свою цену в таблице «Что закупают» (шаг «Документы»)' : 'Укажите сумму', l.item_id ? { item_id: l.item_id } : {});
      else if (l.warning) add('needs_review', 'price_far', `Проверьте цену: ${l.label} — ${l.warning}`, 'Откройте страницу продавца и сверьте цену; если она другая — впишите свою цену', { item_id: l.item_id });
      else if (l.status === 'expired') add('needs_review', 'price_expired', `Срок действия КП истёк: ${l.label}`, 'Запросите у поставщика подтверждение цены и отметьте новое КП', l.item_id ? { focus: `dkp-${l.item_id}` } : {});
      else if (l.status === 'estimate' && l.kind === 'goods') add('estimate', 'price_estimate', `Цена — оценка, не КП: ${l.label} (${l.source})`, 'Получите коммерческое предложение и отметьте цену подтверждённой', l.item_id ? { focus: `dkp-${l.item_id}` } : {});
    }
    for (const f of g.facts) if (f.status === 'missing' && f.key !== 'budget') add('incomplete', `fact_${f.key}`, `${f.label}: нет данных (${f.source})`, 'Укажите значение', FACT_FIELD[f.key] ? { focus: `dealf-${FACT_FIELD[f.key]}` } : {});
    if (g.sellerVat.status === 'estimate') add('estimate', 'vat_estimate', `НДС: ${g.sellerVat.source}`, 'Укажите в анкете участника, платите ли вы НДС', { focus: 'dealf-vat_payer' });
    if (g.tax.status === 'estimate') add('estimate', 'tax_estimate', 'Налоговый профиль — стандартная ставка, не сверен с бухгалтером', 'Сверьте режим и ставку с бухгалтером', { focus: 'dealf-tax_profile' });
    // полнота документов: расчёт по неполной спецификации — не расчёт всей закупки
    const gaps = g.econ?.result?.spec_gaps || [];
    for (const x of gaps) add('incomplete', 'spec_gap', x, 'Дочитайте документацию на шаге «Документация»');
    for (const p of base.calc?.problems || []) add(p.code === 'aggregate_and_detail' ? 'needs_review' : 'incomplete', p.code, p.text, 'Исправьте входные данные');
    const decline = g.nmck && g.contract ? (g.nmck - g.contract) / g.nmck : 0;
    if (String(g.tender.law) === '44' && decline >= 0.25) add('needs_review', 'antidumping', 'Снижение 25% и больше: по ст. 37 44-ФЗ обеспечение исполнения увеличивается (в расчёте — ×1,5) или нужно подтверждение добросовестности', 'Проверьте антидемпинговые требования извещения');
    if (g.loan && !g.loan.confirmed) add('estimate', 'loan_unconfirmed', 'Заём не подтверждён банком: в расчёте — ваши допущения', 'Подтвердите условия займа', { focus: 'dealf-loan_confirmed' });
    if (g.facts.find((f) => f.key === 'payment_days')?.status === 'estimate') add('estimate', 'payment_days_default', 'Срок оплаты не найден в документах — взят из профиля', 'Найдите срок оплаты в проекте контракта');
    return out;
  }

  function nextAction(g, base, reasons, checks) {
    const first = (code) => reasons.find((r) => r.code === code);
    const pick = first('line_missing') || first('spec_gap') || first('fact_contract_price') || first('price_expired') || first('aggregate_and_detail')
      || (g.budget == null ? { text: 'Не указано, сколько своих денег вы готовы вложить в сделку', action: 'Укажите сумму — сервис покажет, хватит ли денег до оплаты заказчика', focus: 'dealf-budget' } : null)
      || (base.cash?.gap > 0 ? { text: `Не хватает ${fmt(base.cash.gap)} на день ${base.cash.peak_day}`, action: `Найдите заём или поставщика с отсрочкой платежа${g.security.contract_pct && g.security.contract_mode === 'cash' ? '; сравните с вариантом «обеспечение банковской гарантией»' : ''}`, focus: 'dealf-loan_amount' } : null)
      || first('price_estimate')
      || (() => { const c = checks.find((x) => x.state === 'not_checked' || x.state === 'flagged'); return c ? { text: `Проверка «${c.title}»: ${c.state === 'flagged' ? 'есть признак риска' : 'не проверено'}`, action: c.next_action, focus: `dcheck-${c.id}` } : null; })()
      || first('vat_estimate') || first('tax_estimate');
    const at = pick ? { ...(pick.focus ? { focus: pick.focus } : {}), ...(pick.item_id != null ? { item_id: pick.item_id } : {}) } : {};
    return pick ? { text: pick.text, action: pick.action, ...at } : { text: 'Существенных вопросов нет', action: 'Утвердите расчёт', focus: 'dealApprove' };
  }

  return {
    store, view, gather,
    /** Сохранить ручные поправки (частично): значения проверяются, пустое — убрать поправку. */
    async save(tenderId, patch = {}) {
      const cur = store.inputs(tenderId);
      const next = { ...cur };
      const money = (k, label) => { if (patch[k] === undefined) return; if (patch[k] === null || patch[k] === '') delete next[k]; else next[k] = parseRub(patch[k], label) / 100; };
      money('contract_price', 'Цена договора');
      money('aggregate_costs', 'Доставка и прочие затраты');
      money('delivery', 'Доставка');
      money('budget', 'Свои деньги');
      for (const k of ['delivery_days', 'payment_days', 'security_return_days']) {
        if (patch[k] === undefined) continue;
        if (patch[k] === null || patch[k] === '') { delete next[k]; continue; }
        const n = Number(patch[k]);
        if (!Number.isInteger(n) || n < 0 || n > 730) throw new MoneyError('срок — целое число дней от 0 до 730');
        next[k] = n;
      }
      if (patch.vat_payer !== undefined) { if (patch.vat_payer === null) delete next.vat_payer; else next.vat_payer = Boolean(patch.vat_payer); }
      if (patch.tax_profile !== undefined) {
        if (!patch.tax_profile) { delete next.tax_profile; delete next.tax_rate; }
        else { if (!E.TAX_PROFILES[patch.tax_profile]) throw new MoneyError('неизвестный налоговый профиль'); next.tax_profile = patch.tax_profile; next.tax_rate = parsePct(patch.tax_rate ?? STD_RATE[patch.tax_profile] ?? 0, 'ставка налога', { max: 99 }); }
      }
      if (patch.tax_confirmed_by !== undefined) { if (!patch.tax_confirmed_by) delete next.tax_confirmed_by; else next.tax_confirmed_by = String(patch.tax_confirmed_by).slice(0, 120); }
      if (patch.contract_security_mode !== undefined) next.contract_security_mode = patch.contract_security_mode === 'guarantee' ? 'guarantee' : 'cash';
      if (patch.guarantee_rate !== undefined) next.guarantee_rate = parsePct(patch.guarantee_rate, 'ставка гарантии', { max: 50 });
      if (patch.loan !== undefined) {
        if (!patch.loan) delete next.loan;
        else next.loan = { amount: parseRub(patch.loan.amount, 'сумма займа') / 100, rate: parsePct(patch.loan.rate, 'ставка займа', { max: 100 }), confirmed: Boolean(patch.loan.confirmed) };
      }
      if (patch.stress !== undefined) next.stress = { goods_pct: parsePct(patch.stress.goods_pct ?? 5, 'рост цены товара', { max: 100 }), delivery_pct: parsePct(patch.stress.delivery_pct ?? 20, 'рост доставки', { max: 300 }), payment_delay_days: Math.max(0, Math.min(365, Number(patch.stress.payment_delay_days ?? 15) || 0)) };
      if (patch.reward !== undefined) {
        const shares = (patch.reward?.shares || []).map((s, i) => ({ id: String(s.id || `share-${i + 1}`), label: String(s.label || 'Получатель').slice(0, 80), pct: parsePct(s.pct, 'доля') }));
        E.allocate(1, shares); // проверка суммы долей
        next.reward = { enabled: Boolean(patch.reward?.enabled), shares };
      }
      if (patch.extra_lines !== undefined) next.extra_lines = (patch.extra_lines || []).slice(0, 10).map((x) => ({ label: String(x.label || 'Прочие затраты').slice(0, 100), amount: parseRub(x.amount, 'сумма') / 100, kind: x.kind === 'install' ? 'install' : 'other' }));
      if (patch.line_vat !== undefined) {
        next.line_vat = {};
        for (const [k, v] of Object.entries(patch.line_vat || {})) {
          if (!E.VAT_MODES.includes(v.mode)) throw new MoneyError('режим НДС строки: в цене / без НДС / освобождено / 0% / неизвестно');
          next.line_vat[k] = { mode: v.mode, rate: v.rate == null ? undefined : parsePct(v.rate, 'ставка НДС', { max: 50 }), deductible: v.deductible == null ? null : Boolean(v.deductible) };
        }
      }
      if (patch.price_confirmation) {
        const c = patch.price_confirmation;
        next.price_confirmations = { ...(next.price_confirmations || {}) };
        if (c.revoke) delete next.price_confirmations[c.item_id];
        else {
          if (String(c.basis || '').trim().length < 5 || !String(c.by || '').trim()) throw new MoneyError('Подтверждение цены: укажите основание (например, «КП № 15 от 16.10») и кто подтвердил');
          if (c.valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(c.valid_until)) throw new MoneyError('Срок действия КП — дата ГГГГ-ММ-ДД');
          next.price_confirmations[c.item_id] = { basis: String(c.basis).trim().slice(0, 200), by: String(c.by).trim().slice(0, 120), valid_until: c.valid_until || null, at: clock().toISOString() };
        }
      }
      store.saveInputs(tenderId, next);
      return view(tenderId);
    },
    /** Ручная оценка экспресс-проверки: с автором; привязана к текущим данным. */
    async setCheck(tenderId, groupId, { state, note, by }) {
      if (!GROUPS.some((x) => x.id === groupId)) throw Object.assign(new Error('Нет такой проверки'), { status: 404 });
      if (state && !['clear', 'flagged', 'not_applicable'].includes(state)) throw Object.assign(new Error('Состояние: проверено — риска нет / есть признак риска / не применяется'), { status: 400 });
      if (state && (!String(by || '').trim() || String(note || '').trim().length < 5)) throw Object.assign(new Error('Укажите, кто проверил, и на чём основана оценка (не короче 5 символов)'), { status: 400 });
      const v = await view(tenderId);
      store.setCheck(tenderId, groupId, { state: state || null, note: String(note || '').slice(0, 500), by: String(by || '').slice(0, 120), inputsHash: v.versions.inputs_hash });
      return view(tenderId);
    },
    /** Утвердить текущий расчёт: снимок сохраняется; при изменении данных он остаётся историей, а расчёт помечается устаревшим. */
    async approve(tenderId, { by }) {
      if (!String(by || '').trim()) throw Object.assign(new Error('Укажите, кто утверждает расчёт'), { status: 400 });
      const v = await view(tenderId);
      store.approve(tenderId, { inputsHash: v.versions.inputs_hash, result: v, by: String(by).trim().slice(0, 120) });
      return view(tenderId);
    },
  };
}

module.exports = { createDealService };
