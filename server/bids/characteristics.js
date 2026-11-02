// Характеристики для заявки: «было по ТЗ → стало в заявке» по каждой позиции.
// Требование — из карточки КТРУ в извещении ЕИС (с инструкцией заказчика: конкретное значение / не менять / одно
// из перечисленных). Значение в заявку — по порядку надёжности: вписанное вами → у выбранного товара (страница
// продавца) → для «не менять» значение из ТЗ как есть → «на проход» (граница диапазона). «На проход» — запасной
// вариант: у реального товара значение может быть другим, а это недостоверные сведения в заявке. Если заказчик
// запретил «искусственное приведение значений», «на проход» не подставляется.

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
const stems = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 1).map((w) => w.slice(0, 5)));

/** Похожи ли названия характеристик: доля общих основ слов (0…1). */
function nameScore(a, b) {
  const x = stems(a);
  const y = stems(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  // короткое название целиком внутри длинного: «Диагональ» и «Размер диагонали», «Скорость печати» и «Скорость
  // черно-белой печати в формате А4». Но не «Объём накопителя» внутри «Ресурс на запись … всего объёма накопителя
  // (DWPD)» — у длинного названия другое главное (первое) слово: так в заявку попадал объём вместо ресурса.
  if (n && n === Math.min(x.size, y.size)) {
    const [long, short] = x.size >= y.size ? [x, y] : [y, x];
    if (long.size <= 3 || short.has([...long][0])) return Math.max(0.75, n / long.size);
  }
  return n / Math.max(x.size, y.size);
}

const NUM = /-?\d+(?:[.,]\d+)?/;
const toNum = (s) => { const m = NUM.exec(String(s ?? '').replace(/\s(?=\d{3}\b)/g, '')); return m ? Number(m[0].replace(',', '.')) : null; };
const decimals = (x) => { const s = String(x); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
const fmt = (x) => String(Math.round(x * 1e6) / 1e6).replace('.', ',');

/** Соответствует ли число диапазону характеристики (null — диапазона нет). */
/**
 * Значение ровно на границе, которая в условие не входит: «менее 2» и у товара 2, «более 1,5» и у товара 1,5.
 * Формально это несоответствие (граница строгая), но на странице продавца значение часто округлено — подсказываем
 * проверить точное по паспорту. null — если значение не на строгой границе.
 */
function strictBoundary(range, x) {
  if (!range || x == null) return null;
  if (range.max_op === 'less' && range.max != null && x === range.max) return { word: 'менее', bound: range.max };
  if (range.min_op === 'greater' && range.min != null && x === range.min) return { word: 'более', bound: range.min };
  return null;
}
const boundaryNote = (b, shown, tz) => `ровно ${shown}, а по ТЗ «${tz}» — значение «${b.word} ${String(b.bound).replace('.', ',')}» саму границу не включает. Проверьте точное значение по паспорту или сайту производителя: на странице продавца его часто округляют. Если оно действительно ${shown} — подберите другой товар`;

function inRange(range, x) {
  if (!range || x == null) return null;
  if (range.min != null) {
    if (range.min_op === 'greater' ? !(x > range.min) : !(x >= range.min)) return false;
  }
  if (range.max != null) {
    if (range.max_op === 'less' ? !(x < range.max) : !(x <= range.max)) return false;
  }
  return true;
}

/**
 * «На проход»: ближайшее к границе значение, которое ей удовлетворяет. «≥ 170» → 170; «> 2,6» → 2,7; «< 2» → 1;
 * «< 50» → 49; «≥ 250 и < 300» → 250. Шаг — по точности границы (целые → 1, десятые → 0,1).
 */
function passNumber(range) {
  if (!range) return null;
  const step = (x) => 10 ** -decimals(x);
  if (range.min != null) {
    const v = range.min_op === 'greater' ? range.min + step(range.min) : range.min;
    return inRange(range, v) ? v : null;
  }
  if (range.max != null) {
    const v = range.max_op === 'less' ? range.max - step(range.max) : range.max;
    return inRange(range, v) ? v : null;
  }
  return null;
}

/** Диапазон из текста ТЗ («не менее 145 мм», «≥ 8», «до 50») — когда в ЕИС он записан текстом. */
function rangeFromText(text) {
  const t = String(text ?? '').toLowerCase();
  const m = /(не менее|не более|более|менее|больше|меньше|≥|>=|≤|<=|>|<|от|до)\s*(-?\d+(?:[.,]\d+)?)/.exec(t);
  if (!m) return null;
  const n = Number(m[2].replace(',', '.'));
  const op = { 'не менее': 'greaterOrEqual', '≥': 'greaterOrEqual', '>=': 'greaterOrEqual', от: 'greaterOrEqual', более: 'greater', больше: 'greater', '>': 'greater',
    'не более': 'lessOrEqual', '≤': 'lessOrEqual', '<=': 'lessOrEqual', до: 'lessOrEqual', менее: 'less', меньше: 'less', '<': 'less' }[m[1]];
  return /less/i.test(op) ? { min: null, min_op: null, max: n, max_op: op } : { min: n, min_op: op, max: null, max_op: null };
}

/** Значение у выбранного товара: характеристика со страницы продавца с похожим названием, иначе — из сверки с ТЗ. */
function productValue(name, offer) {
  let best = null;
  for (const s of offer?.specs || []) {
    const score = nameScore(name, s.name);
    if (score >= 0.75 && (!best || score > best.score)) best = { score, value: String(s.value), from: s.from_label || 'страница продавца' };
  }
  if (best) return best;
  for (const r of offer?.rows || []) {
    const score = nameScore(name, r.name);
    if (score >= 0.75 && r.found && r.verdict !== 'unknown' && (!best || score > best.score)) best = { score, value: String(r.found), from: 'сверка со страницей продавца', verdict: r.verdict };
  }
  return best;
}

/**
 * Строка таблицы для одной характеристики.
 * @param c характеристика из извещения {name, value, fill, unit, range, options}
 * @param ctx {offer: {specs, rows}|null, saved: string|undefined, forbidPass: boolean}
 */
function rowOf(c, { offer = null, saved, forbidPass = false } = {}) {
  const range = c.range || rangeFromText(c.value);
  const unit = c.unit || '';
  const withUnit = (v) => (unit && v && !String(v).includes(unit) ? `${v} ${unit}` : v);
  const base = { name: c.name, tz: c.value, fill: c.fill || null, unit: unit || null };
  // что требует ТЗ дословно: для «не менять» — именно это и пишется в заявку
  const numeric = (c.options || []).every((o) => /^-?\d+(?:[.,]\d+)?$/.test(String(o).trim()));
  const fixedValue = (c.options?.length ? withUnit(c.options.join('; ')) : String(c.value || '').replace(/^\s*(?:≥|≤|>=|<=)\s*/, '')) || null;
  // одно точное значение без диапазона («2560 x 1440») — оно и пишется в заявку, как «не менять»
  const exact = c.fill !== 'fixed' && !range && c.options?.length === 1 && !(numeric && c.fill === 'one');
  const product = productValue(c.name, offer);
  let pass = null;
  if (c.fill === 'fixed') pass = fixedValue;
  else if (c.fill === 'one' && c.options?.length === 1) pass = c.options[0].replace(/^\s*(?:≥|≤|>=|<=|>|<)\s*/, '');
  else { const n = passNumber(range); pass = n != null ? withUnit(fmt(n)) : null; }

  if (saved != null && String(saved).trim()) {
    const n = toNum(saved);
    const fails = range && c.fill !== 'fixed' && inRange(range, n) === false;
    return { ...base, value: String(saved).trim(), source: 'вписано вами', status: fails ? 'conflict' : 'manual', note: fails ? (strictBoundary(range, n) ? `вписано ${boundaryNote(strictBoundary(range, n), String(saved).trim(), c.value)}` : `не проходит по ТЗ: нужно ${c.value}`) : null, product: product?.value || null, pass };
  }
  if (product) {
    if (c.fill === 'fixed') {
      // «не менять»: в заявку — значение из ТЗ; товар с явно другим значением — несоответствие
      const same = norm(product.value).includes(norm(fixedValue).slice(0, 12)) || norm(fixedValue).includes(norm(product.value).slice(0, 12));
      const differs = !same && product.verdict === 'no';
      return { ...base, value: fixedValue, source: 'из ТЗ (значение не меняется)', status: differs ? 'conflict' : 'fixed', note: differs ? `у товара: «${product.value}»` : null, product: product.value, pass };
    }
    // Единицы ТЗ и товара: «Количество лотков, шт» и «Лоток: 250 листов» — разные вещи (значение не берём);
    // «не менее 1024 Мбайт» и «1 Гб» — одно и то же в других единицах (переводим).
    const scaled = range ? inUnitsOf(`${c.unit || ''} ${c.value || ''}`, product.value, c.name) : null;
    if (range && scaled === false) return emptyOrPass();
    if (range) {
      const n = scaled ?? toNum(product.value);
      const ok = inRange(range, n);
      if (ok === true) return { ...base, value: withUnit(fmt(n)), source: product.from, status: 'product', note: null, product: product.value, pass };
      if (ok === false || product.verdict === 'no') return { ...base, value: '', source: product.from, status: 'conflict', note: strictBoundary(range, n) ? `у товара ${boundaryNote(strictBoundary(range, n), product.value, c.value)}` : `у товара ${product.value} — не проходит по ТЗ (${c.value})`, product: product.value, pass };
    } else if (product.verdict !== 'no') {
      return { ...base, value: product.value, source: product.from, status: 'product', note: null, product: product.value, pass };
    }
  }
  return emptyOrPass();

  function emptyOrPass() {
    if ((c.fill === 'fixed' || exact) && fixedValue) return { ...base, value: fixedValue, source: c.fill === 'fixed' ? 'из ТЗ (значение не меняется)' : 'из ТЗ (одно точное значение)', status: 'fixed', note: null, product: product?.value || null, pass };
    if (pass && !forbidPass) return { ...base, value: pass, source: 'граница из ТЗ', status: 'pass', note: 'у товара не подтверждено — проверьте, что у поставляемой модели именно так', product: product?.value || null, pass };
    return {
      ...base, value: '', source: null, status: 'empty', product: product?.value || null, pass,
      note: pass && forbidPass ? 'заказчик запретил «искусственное приведение значений» — впишите значение реального товара'
        : c.fill === 'one' && (c.options?.length || 0) > 1 ? `выберите одно: ${c.options.join(' / ')}` : 'впишите значение реального товара',
    };
  }
}

// Единицы, которые встречаются в ТЗ и на страницах: вид величины и множитель к основной единице вида
const UNITS = [
  [/(?<![а-яa-z])(тб|тбайт|терабайт\S*|tb)(?![а-яa-z])/i, 'byte', 1024 * 1024], [/(?<![а-яa-z])(гб|гбайт|гигабайт\S*|gb)(?![а-яa-z])/i, 'byte', 1024],
  [/(?<![а-яa-z])(мб|мбайт|мегабайт\S*|mb)(?![а-яa-z])/i, 'byte', 1],
  [/(?<![а-яa-z])(лист\S*|стр\S*|страниц\S*|отпечат\S*|копи[йи])(?![а-яa-z])/i, 'sheet', 1], [/(?<![а-яa-z])(шт\.?|штук\S*)(?![а-яa-z])/i, 'piece', 1],
  [/(?<![а-яa-z])(мм)(?![а-яa-z])/i, 'length', 1], [/(?<![а-яa-z])(см)(?![а-яa-z])/i, 'length', 10], [/(?<![а-яa-z])(м)(?![а-яa-z])/i, 'length', 1000],
];
const unitIn = (s) => UNITS.find(([re]) => re.test(String(s || ''))) || null;
/**
 * Число товара в единицах ТЗ: «1 Гб» при «Мбайт» → 1024. false — единицы разных видов («250 листов» при «шт»),
 * null — сравнить нельзя (единица не названа с одной из сторон) — тогда число берётся как есть.
 */
function inUnitsOf(tz, value, name = '') {
  const a = unitIn(tz);
  const b = unitIn(value);
  if (!a || !b) return null;
  // ресурс картриджа в ТЗ «≥ 6000 шт.», на странице «6000 стр.» — одно и то же; «Количество лотков, шт» и «лоток на
  // 250 листов» — нет
  const pages = /ресурс|страниц|отпечат|лист|копи/i.test(name) && [a[1], b[1]].every((k) => k === 'piece' || k === 'sheet');
  if (a[1] !== b[1] && !pages) return false;
  const n = toNum(value);
  return n == null ? null : (n * b[2]) / a[2];
}

/** Требования из документации (чтение ТЗ), которых нет в карточке ЕИС: на площадку не идут, но по ним проверяют. */
function extraRequirements(item, eisChars, offer) {
  const req = item.spec?.required || [];
  return req.filter((r) => !eisChars.some((c) => nameScore(c.name, r.name) >= 0.75)).map((r) => {
    const row = (offer?.rows || []).find((x) => nameScore(x.name, r.name) >= 0.8);
    return { name: r.name, tz: String(r.value ?? ''), verdict: row?.verdict || 'unknown', found: row?.found || null };
  });
}

/** Значение из характеристик товара по названию (страна, производитель). */
const specLike = (offer, re) => (offer?.specs || []).find((s) => re.test(String(s.name)))?.value || null;

/**
 * Таблица позиции целиком.
 * @param item позиция (eis_chars, spec, name, okpd2_code, ktru_code, quantity, unit, eis_measure)
 * @param ctx {offer: {title, specs, rows}|null, saved: {values, trademark, country}, forbidPass}
 */
function itemTable(item, { offer = null, saved = {}, forbidPass = false } = {}) {
  // У позиции без характеристик КТРУ (код ОКПД2: «Тонер-картридж для МФУ Pantum M7310DN», «Коммутатор … или
  // эквивалент») таблица была пустой — и в предложение о товаре не попадали ни ресурс, ни совместимость. Тогда строки —
  // из требований ТЗ: число с условием — конкретное значение товара, текст — как в ТЗ.
  const fromTz = !(item.eis_chars || []).length
    ? (item.spec?.required || item.characteristics || []).filter((r) => r?.name && r.value != null && String(r.value).trim()).map((r) => {
      const range = rangeFromText(r.value);
      return { name: r.name, value: String(r.value), unit: r.unit || null, fill: range ? 'concrete' : 'fixed', range, from_tz: true };
    })
    : [];
  const chars = (item.eis_chars || []).length ? item.eis_chars : fromTz;
  const rows = chars.map((c) => rowOf(c, { offer, saved: saved.values?.[c.name], forbidPass }));
  const count = (s) => rows.filter((r) => r.status === s).length;
  const trademark = saved.trademark ?? specLike(offer, /производител|бренд|торгов|марка/i) ?? null;
  const country = saved.country ?? specLike(offer, /страна/i) ?? null;
  return {
    item_id: item.id, idx: item.idx, name: item.name, code: item.ktru_code || item.okpd2_code || null, quantity: item.quantity ?? null, unit: item.unit || null,
    measure: item.eis_measure || null,
    trademark, trademark_source: saved.trademark != null ? 'вписано вами' : trademark ? 'со страницы товара' : null,
    country, country_source: saved.country != null ? 'вписано вами' : country ? 'со страницы товара' : null,
    offer: offer ? { title: offer.title || null, seller: offer.seller || null, url: offer.url || null } : null,
    rows, extra: fromTz.length ? [] : extraRequirements(item, chars, offer),
    counts: { total: rows.length, concrete: chars.filter((c) => c.fill === 'concrete').length, fixed: chars.filter((c) => c.fill === 'fixed').length,
      product: count('product'), fixed_filled: count('fixed'), manual: count('manual'), pass: count('pass'), conflict: count('conflict'), empty: count('empty') },
  };
}

/** Чего не хватает до подачи: страна и товарный знак у каждой позиции, пустые и не проходящие значения, «на проход». */
function problems(tables, { forbidPass = false } = {}) {
  const out = [];
  const list = (f) => tables.filter(f).map((t) => t.idx + 1);
  const noCountry = list((t) => !t.country);
  if (noCountry.length) out.push({ level: 'block', text: `Не указана страна происхождения — позиции ${noCountry.join(', ')}: без неё площадка не примет заявку` });
  const noMark = list((t) => !t.trademark);
  if (noMark.length) out.push({ level: 'warn', text: `Не указан товарный знак — позиции ${noMark.join(', ')} (если у товара его нет — впишите «отсутствует»)` });
  for (const t of tables) {
    if (t.counts.conflict) out.push({ level: 'block', text: `Позиция ${t.idx + 1}: ${t.counts.conflict} знач. не проходят по ТЗ — товар не соответствует или вписано не то` });
    if (t.counts.empty) out.push({ level: 'block', text: `Позиция ${t.idx + 1}: не заполнено ${t.counts.empty} знач.` });
    if (t.counts.pass) out.push({ level: forbidPass ? 'block' : 'warn', text: `Позиция ${t.idx + 1}: ${t.counts.pass} знач. «на проход» — у товара не подтверждены` });
  }
  if (!tables.length) out.push({ level: 'warn', text: 'В извещении нет характеристик по позициям (КТРУ) — заполните характеристики по ТЗ вручную' });
  return out;
}

/** Текст для площадки: по каждой позиции — товарный знак, страна, нацрежим и характеристики «название: значение». */
function exportText(tender, tables) {
  const lines = [`Заявка: закупка № ${tender.number}${tender.title ? ` — ${tender.title}` : ''}`, ''];
  for (const t of tables) {
    lines.push(`Позиция ${t.idx + 1}. ${t.name}${t.code ? ` (${t.code})` : ''}${t.quantity != null ? `, ${t.quantity} ${t.unit || ''}`.trimEnd() : ''}`);
    lines.push(`Товарный знак: ${t.trademark || '—'}`);
    lines.push(`Страна происхождения: ${t.country || '—'}`);
    if (t.measure && t.measure !== 'нет') lines.push(`Национальный режим (ПП РФ № 1875): ${t.measure}`);
    lines.push('Характеристики:');
    for (const r of t.rows) lines.push(`  ${r.name}: ${r.value || '—'}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** То же таблицей для Excel (CSV с разделителем «;», UTF-8 с BOM). */
function exportCsv(tables) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Позиция', 'Наименование', 'Код', 'Товарный знак', 'Страна', 'Характеристика', 'Требование ТЗ', 'Инструкция', 'Значение в заявку', 'Откуда'];
  const FILL = { concrete: 'конкретное значение', fixed: 'не менять', one: 'одно значение' };
  const rows = tables.flatMap((t) => t.rows.map((r) => [t.idx + 1, t.name, t.code, t.trademark, t.country, r.name, r.tz, FILL[r.fill] || '', r.value, r.source || '']));
  return `﻿${[head, ...rows].map((r) => r.map(q).join(';')).join('\r\n')}\r\n`;
}

/** Заказчик запретил «искусственное приведение значений показателей» — признак в тексте документации. */
const forbidsArtificial = (texts) => texts.some((t) => /искусственн[а-яё]*\s+приведени/i.test(String(t)));

module.exports = { itemTable, rowOf, passNumber, rangeFromText, inRange, strictBoundary, nameScore, problems, exportText, exportCsv, forbidsArtificial };
