// Экспресс-проверки сделки: семь групп. Начальное состояние — «не проверено», а не «риска нет».
// Состояния: not_checked | clear (проверено, риска нет) | flagged (есть признак риска) | not_applicable (есть основание) | conflict.
// Автоматически сервис может только найти признак риска или основание «не применяется» по фактам с источником;
// «проверено, риска нет» ставит человек — с автором и основанием. Изменились данные — ручная оценка устаревает.
// Весов, баллов и «светофора по сумме флажков» нет: финансовый эффект — изменение конкретного входа расчёта.

const GROUPS = [
  { id: 'customer_payments', title: 'Платёжная история заказчика' },
  { id: 'payment_terms', title: 'Порядок оплаты и сопровождения' },
  { id: 'national_regime', title: 'Происхождение товара и нацрежим' },
  { id: 'delivery', title: 'Реальность поставки в срок' },
  { id: 'supplier_price', title: 'Цена и наличие у поставщика' },
  { id: 'logistics', title: 'Особая логистика' },
  { id: 'tax_model', title: 'Совместимость налоговой модели' },
];

const field = (card, key) => card?.groups?.flatMap((g) => g.fields).find((f) => f.key === key && f.status === 'found') || null;
const srcOf = (f) => (f?.sources?.[0] ? { file: f.sources[0].file, page: f.sources[0].page, quote: f.sources[0].quote, verified: Boolean(f.sources[0].verified) } : null);

/**
 * @returns [{id, title, state, auto, severity, blocking, observed, evidence, next_action, effect, manual}]
 */
function buildChecks({ g, base, store, hash, repo }) {
  const card = g.tender.analysis_id ? repo.getAnalysis(g.tender.analysis_id)?.card : null;
  const complete = card?.meta?.coverage?.status === 'complete';
  const manual = new Map(store.checks(g.tender.id).map((m) => [m.group_id, m]));
  const out = [];
  const push = (id, o) => {
    const grp = GROUPS.find((x) => x.id === id);
    const m = manual.get(id);
    const row = { id, title: grp.title, state: 'not_checked', auto: null, severity: 'warning', blocking: false, observed: null, evidence: [], next_action: null, effect: null, ...o };
    // ручная оценка: действует, пока не изменились данные, на которых её дали
    if (m) {
      row.manual = { state: m.state, note: m.note, by: m.by, at: m.at, stale: m.inputs_hash !== hash };
      if (!row.manual.stale) row.state = m.state;
    }
    out.push(row);
  };

  // 1. Платёжная история: законного доступного источника в сервисе нет — только ручная проверка
  push('customer_payments', {
    observed: g.tender.customer_inn ? `ИНН заказчика ${g.tender.customer_inn}` : 'ИНН заказчика не известен',
    next_action: `Проверьте арбитражные дела заказчика${g.tender.customer_inn ? ` по ИНН ${g.tender.customer_inn}` : ''} в картотеке kad.arbitr.ru: споры о неоплате по поставкам за последние 2–3 года. Учитывайте роль заказчика, предмет и исход; апелляции одного дела — не новые случаи`,
    link: g.tender.customer_inn ? 'https://kad.arbitr.ru/' : null,
  });

  // 2. Порядок оплаты: срок из проекта контракта — в календарь денег
  const pay = field(card, 'payment_terms');
  const days = g.days.payment;
  push('payment_terms', {
    state: pay && days > 30 ? 'flagged' : 'not_checked', auto: pay && days > 30 ? 'срок оплаты больше 30 дней — деньги дольше заморожены' : null,
    observed: pay ? `${pay.value}` : !complete ? 'срок оплаты не найден: документация прочитана не полностью' : 'срок оплаты в документах не найден',
    evidence: pay ? [srcOf(pay)].filter(Boolean) : [],
    effect: `В расчёте денег оплата через ${days} дн. после поставки`,
    next_action: 'Сверьте срок и порядок приёмки и оплаты в проекте контракта. Казначейское сопровождение само по себе задержку не означает — смотрите его условия',
  });

  // 3. Нацрежим: мера определяется по позиции; запрет/ограничение — признак, требующий подтверждения по каждой позиции
  const nat = field(card, 'national_regime');
  const restricted = nat && /запрет|ограничен|преимуществ|1875/i.test(nat.value) && !/не (установлен|применя)/i.test(nat.value);
  push('national_regime', {
    state: restricted ? 'flagged' : 'not_checked', auto: restricted ? 'в документах установлены меры нацрежима' : null, blocking: false,
    observed: nat ? nat.value : !complete ? 'не найдено: документация прочитана не полностью' : 'в документах не найдено',
    evidence: nat ? [srcOf(nat)].filter(Boolean) : [],
    next_action: 'Для каждой позиции определите меру по ПП № 1875 и чем подтверждается происхождение именно предлагаемой модели (реестровая запись или иной документ). Страна бренда не равна стране происхождения',
  });

  // 4. Реальность поставки: срок продавца против срока договора
  const offerDays = [];
  for (const it of g.items) {
    const o = it.purchase_offer_id ? repo.getOffer(it.purchase_offer_id) : null;
    if (o?.delivery_days != null) offerDays.push({ item: it.name, days: Number(o.delivery_days), stock: o.stock_qty });
  }
  const worst = offerDays.length ? Math.max(...offerDays.map((x) => x.days)) : null;
  const late = worst != null && worst > g.days.delivery;
  push('delivery', {
    state: late ? 'flagged' : 'not_checked', auto: late ? `доставка от продавца ${worst} дн. — дольше срока поставки по договору (${g.days.delivery} дн.)` : null, blocking: late, severity: late ? 'critical' : 'warning',
    observed: worst != null ? `срок доставки выбранных продавцов — до ${worst} дн.; по договору — ${g.days.delivery} дн.` : 'срок доставки от продавцов не известен',
    next_action: late ? 'Найдите продавца ближе или с быстрой отправкой; уточните резерв товара' : 'Подтвердите у продавца наличие всей партии и дату отгрузки; заложите запас на приёмку',
  });

  // 5. Цена и наличие: подтверждение КП с автором и сроком
  const goods = g.lines.filter((l) => l.kind === 'goods');
  const expired = goods.filter((l) => l.status === 'expired');
  const allConfirmed = goods.length && goods.every((l) => l.status === 'confirmed');
  push('supplier_price', {
    state: expired.length ? 'conflict' : allConfirmed ? 'clear' : 'not_checked',
    auto: expired.length ? `срок действия КП истёк: ${expired.length} поз.` : allConfirmed ? 'цены всех позиций подтверждены КП с действующим сроком' : null,
    observed: `${goods.filter((l) => l.status === 'confirmed').length} из ${goods.length} позиций — цена подтверждена КП${allConfirmed ? '' : '; остальные — оценка (цена со страницы магазина, прошлый контракт или ручной ввод)'}`,
    next_action: 'Запросите КП с фиксацией цены и сроком действия; проверьте наличие всей партии. Отметьте каждую цену подтверждённой в расчёте',
  });

  // 6. Логистика: доставка посчитана оценкой — признак
  const deliv = g.lines.find((l) => l.kind === 'delivery' || l.kind === 'aggregate');
  const estimated = deliv && /оценка/.test(deliv.source || '');
  push('logistics', {
    state: estimated ? 'flagged' : 'not_checked', auto: estimated ? 'стоимость доставки — оценка, а не расчёт перевозчика' : null,
    observed: deliv ? `${deliv.label}: ${deliv.source}` : 'нет данных о доставке',
    next_action: 'Уточните адрес, доступ, разгрузку и пропуска; получите расчёт перевозчика по весу и объёму. Не добавляйте условный «северный процент» — нужен расчёт',
  });

  // 7. Налоговая модель: неплательщик НДС — вычет не применяется; плательщик — вычет по строкам должен быть подтверждён
  const payer = g.sellerVat.mode === 'payer';
  const unconfirmed = payer ? (base.calc?.notes || []).filter((n) => n.code === 'deduction_unconfirmed').length : 0;
  push('tax_model', {
    state: g.sellerVat.mode === 'not_payer' && g.sellerVat.status === 'confirmed' ? 'not_applicable' : unconfirmed ? 'flagged' : 'not_checked',
    auto: g.sellerVat.mode === 'not_payer' && g.sellerVat.status === 'confirmed' ? 'вы не плательщик НДС (анкета) — вычета входного НДС нет, расчёт это учитывает' : unconfirmed ? `вычет входного НДС не подтверждён по ${unconfirmed} строкам — расчёт считает их без вычета` : null,
    observed: `${g.sellerVat.mode === 'payer' ? `вы плательщик НДС ${g.sellerVat.rate}%` : g.sellerVat.mode === 'not_payer' ? 'вы не плательщик НДС' : 'НДС не указан'} (${g.sellerVat.source}); профиль: ${g.tax.source}`,
    effect: unconfirmed ? 'Строки без подтверждённого вычета уже посчитаны полной суммой — отдельной «надбавки» нет' : null,
    next_action: 'Уточните у поставщиков, есть ли НДС в цене, и отметьте режим НДС по строкам; сверьте налоговый профиль с бухгалтером',
  });
  return out;
}

module.exports = { buildChecks, GROUPS };
