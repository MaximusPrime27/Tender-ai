// Товарные позиции закупки: что, сколько, какие характеристики, цена заказчика за единицу.
// 44-ФЗ — из извещения (purchaseObjectsInfo), 223-ФЗ — из лотов (lotItems). Структуры сверены
// с реальными ответами ГосПлан в samples/tenders/.

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const num = (v) => {
  if (v == null) return null;
  const x = typeof v === 'object' ? v.value : v;
  const n = Number(String(x).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const unitOf = (okei) => (okei ? okei.nationalCode || okei.name || okei.code || null : null);

const NOTATION = {
  greaterOrEqual: 'не менее', greater: 'более', lessOrEqual: 'не более', less: 'менее',
};

/** Значение характеристики КТРУ в читаемом виде: «не менее 3.6 ГГц», «Да», «от 8 до 16 ГБ». */
function formatCharValue(v) {
  if (!v || typeof v !== 'object') return String(v ?? '');
  if (v.qualityDescription) return String(v.qualityDescription);
  const unit = unitOf(v.OKEI);
  const withUnit = (s) => (unit ? `${s} ${unit}` : s);
  const r = v.rangeSet?.valueRange;
  if (r) {
    const parts = [];
    if (r.min != null) parts.push(`${NOTATION[r.minMathNotation] || 'от'} ${r.min}`);
    if (r.max != null) parts.push(`${NOTATION[r.maxMathNotation] || 'до'} ${r.max}`);
    return withUnit(parts.join(' и '));
  }
  const concrete = v.valueSet?.concreteValue ?? v.concreteValue;
  if (concrete != null) return withUnit(arr(concrete).join(', '));
  const prim = Object.entries(v).find(([k, x]) => !/sid|OKEI|valueFormat/i.test(k) && (typeof x === 'string' || typeof x === 'number'));
  return prim ? withUnit(String(prim[1])) : '';
}

function parseCharacteristics(ch) {
  if (!ch) return [];
  const list = [
    ...arr(ch.characteristicsUsingReferenceInfo),
    ...arr(ch.characteristicsUsingTextForm),
    ...arr(ch.characteristicsNotUsingReferenceInfo),
  ];
  return list
    .filter((c) => c && c.name)
    .map((c) => ({ name: String(c.name), value: arr(c.values?.value).map(formatCharValue).filter(Boolean).join(' / ') }));
}

// Инструкция заказчика по заполнению характеристики в заявке (characteristicsFillingInstruction.code в ЕИС):
// 2 — участник указывает конкретное значение; 3 — указывает только одно значение из перечисленных;
// 6 — значение не может изменяться (переносится в заявку как есть).
const FILL = { 2: 'concrete', 3: 'one', 6: 'fixed' };
const numOrNull = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

/**
 * Характеристики позиции из карточки КТРУ — для таблицы «по ТЗ → в заявку»: как в ЕИС, с инструкцией заказчика.
 * [{name, value, fill: 'concrete'|'one'|'fixed'|null, fill_note, unit, range: {min, min_op, max, max_op}|null, options: [..]}]
 */
function parseEisChars(ch) {
  if (!ch) return [];
  return [...arr(ch.characteristicsUsingReferenceInfo), ...arr(ch.characteristicsUsingTextForm), ...arr(ch.characteristicsNotUsingReferenceInfo)]
    .filter((c) => c && c.name)
    .map((c) => {
      const values = arr(c.values?.value);
      const ins = c.characteristicsFillingInstruction || {};
      const first = values.find((v) => v && typeof v === 'object') || {};
      const r = first.rangeSet?.valueRange;
      const range = r && (r.min != null || r.max != null)
        ? { min: numOrNull(r.min), min_op: r.min != null ? r.minMathNotation || 'greaterOrEqual' : null, max: numOrNull(r.max), max_op: r.max != null ? r.maxMathNotation || 'lessOrEqual' : null }
        : null;
      const options = values.map((v) => (v?.qualityDescription ? String(v.qualityDescription) : null)).filter(Boolean);
      const concrete = arr(first.valueSet?.concreteValue ?? first.concreteValue).map(String);
      return {
        name: String(c.name), value: values.map(formatCharValue).filter(Boolean).join(' / '),
        fill: FILL[ins.code] || null, fill_note: ins.name ? String(ins.name) : null,
        unit: unitOf(first.OKEI), range, options: options.length ? options : concrete,
      };
    });
}

const yes = (v) => v === true || String(v).toLowerCase() === 'true';
/** Мера национального режима позиции по отметкам извещения: «запрет», «ограничение», «преимущество», «нет»; null — отметок нет. */
function measureOf(r) {
  if (!r) return null;
  const k = [yes(r.isProhibitionForeignPurchaseObjects) && 'запрет', yes(r.isRestrictForeignPurchaseObjects) && 'ограничение', yes(r.isPreferenseRFPurchaseObjects) && 'преимущество'].filter(Boolean);
  return k.length ? k.join(' + ') : 'нет';
}

/** Позиции из извещения 44-ФЗ (ответ /fz44/purchases/{n}/notification). */
function itemsFrom44Notification(notification) {
  const info = notification?.source?.notificationInfo?.purchaseObjectsInfo;
  if (!info) return [];
  const items = [];

  const goods = arr(info.notDrugPurchaseObjectsInfo?.purchaseObject ?? info.purchaseObject);
  for (const o of goods) {
    const quantity = num(o.quantity);
    items.push({
      name: String(o.name || o.KTRU?.name || o.OKPD2?.OKPDName || 'Позиция'),
      ktru_code: o.KTRU?.code || null,
      okpd2_code: o.OKPD2?.OKPDCode || o.OKPD2?.code || null,
      characteristics: parseCharacteristics(o.KTRU?.characteristics || o.characteristics),
      eis_chars: parseEisChars(o.KTRU?.characteristics || o.characteristics),
      eis_measure: measureOf(o.restrictionsInfo),
      quantity,
      unit: unitOf(o.OKEI),
      unit_price: num(o.price),
      sum: num(o.sum),
      source: 'notification',
    });
  }

  for (const d of arr(info.drugPurchaseObjectsInfo?.drugPurchaseObjectInfo)) {
    const drug = arr(d.objectInfoUsingReferenceInfo?.drugsInfo?.drugInfo)[0]
      || arr(d.objectInfoUsingTextForm?.drugsInfo?.drugInfo)[0] || {};
    const quantity = arr(d.drugQuantityCustomersInfo?.drugQuantityCustomerInfo)
      .reduce((s, q) => s + (num(q.quantity ?? q.drugQuantity) || 0), 0) || null;
    items.push({
      name: String(drug.MNNInfo?.MNNName || drug.MNNName || notification?.source?.commonInfo?.purchaseObjectInfo || 'Лекарственный препарат'),
      ktru_code: drug.KTRUInfo?.code || drug.KTRU?.code || null,
      okpd2_code: drug.OKPD2Info?.OKPDCode || drug.OKPD2?.OKPDCode || null,
      characteristics: [
        drug.medicamentalFormInfo?.medicamentalFormName && { name: 'Лекарственная форма', value: drug.medicamentalFormInfo.medicamentalFormName },
        drug.dosageInfo?.dosageGRLSValue && { name: 'Дозировка', value: drug.dosageInfo.dosageGRLSValue },
      ].filter(Boolean),
      quantity,
      unit: drug.dosageInfo?.dosageUserName || unitOf(drug.dosageInfo?.dosageUserOKEI || drug.OKEI) || 'ед.',
      unit_price: num(d.pricePerUnit),
      sum: num(d.positionPrice),
      source: 'notification',
    });
  }
  return items;
}

/** Позиции из закупки 223-ФЗ (ответ /fz223/purchases/{n}). Цены за единицу в 223-ФЗ обычно нет. */
/**
 * «Дополнительные сведения» позиции 223-ФЗ — обычно наименование товара, но бывает юридическая оговорка
 * («Ограничение закупок товаров, происходящих из иностранных государств… по перечню согласно приложению N 2»).
 * Такую строку наименованием не считаем — берём название кода ОКПД2.
 */
function usableInfo(info) {
  const s = String(info || '').trim();
  if (!s || s === '-') return null;
  if (/ограничени[ея] закупок|происходящих из иностранн|национальн(ый|ого) режим|приоритет товаров|постановлени[ея] правительства|согласно приложению|запрет на допуск/i.test(s)) return null;
  return s;
}

function itemsFrom223Purchase(purchase) {
  const items = [];
  for (const doc of arr(purchase?.docs)) {
    for (const lot of arr(doc?.source?.lots?.lot)) {
      const lotItems = arr(lot?.lotData?.lotItems?.lotItem);
      const lotSum = num(lot?.lotData?.initialSum);
      for (const li of lotItems) {
        const quantity = num(li.qty);
        const single = lotItems.length === 1;
        items.push({
          name: String(usableInfo(li.additionalInfo) || li.okpd2?.name || 'Позиция').slice(0, 500),
          ktru_code: null,
          okpd2_code: li.okpd2?.code || null,
          characteristics: [],
          quantity,
          unit: li.okei?.name || null,
          unit_price: single && lotSum && quantity ? Math.round((lotSum / quantity) * 100) / 100 : null,
          sum: single ? lotSum : null,
          source: 'notification',
        });
      }
    }
    if (items.length) break; // в docs бывает несколько редакций извещения — берём первую с позициями
  }
  return items;
}

module.exports = { itemsFrom44Notification, itemsFrom223Purchase, parseCharacteristics, parseEisChars, formatCharValue };
