// Сколько товара у продавца в наличии — со страницы товара.
//
// Нужно для набора партии: если у продавца с лучшей ценой товара меньше, чем требуется заказчику, остаток добирается
// у следующего. Число берём, только когда оно прямо названо на странице; «в наличии» без числа — количество неизвестно
// (его нужно уточнить), «более N» — известно, что не меньше N.
//
// Правила выведены по страницам 33 поставщиков из config/stores.json (docs/supplier-search-losses.md):
//  • берётся ПЕРВЫЙ по тексту признак после названия товара. Ниже на странице идут «похожие товары» со своими
//    остатками: раньше «более 100 шт» у соседнего товара перебивало «под заказ» у самого товара;
//  • «нет в наличии более 6 месяцев» — это срок, а не количество; «в наличии от 504 632 ₽» — цена;
//  • числа из служебных данных страницы (data-quantity, "stock": N, max у поля количества) не берём: у большинства
//    сайтов это размер шага или номер записи, а не остаток. Исключение — сайты, где атрибут проверен (stock_attr).

const NUM = '(\\d{1,3}(?:[ \\u00a0]\\d{3})+|\\d{1,7})';
const WHERE = '(?:в\\s+наличии|количество\\s+товара\\s+на\\s+склад(?:е|ах)|наличие(?:\\s+на\\s+склад(?:е|ах))?|на\\s+склад(?:е|ах)|остаток|остал[ао]сь|доступно(?:\\s+к\\s+заказу)?)';
// кабель и провод продают метрами, крепёж — упаковками: «В наличии : 1 000+ м», «100+ уп», «В наличии 0 м»
const UNIT = '(?:шт|ед\\.|единиц|упак|уп(?![а-яё])|pcs|м(?![а-яёa-z0-9²³])|кг(?![а-яё])|компл|рул|пар(?![а-яё]))';
// После числа — деньги, срок или магазины: это не количество товара.
const NOT_QTY = '(?!\\s*(?:\\d|₽|руб|р\\.|%|мес|недел|дн[еяй]|лет|год|час|магазин|пункт))';
const GAP = '[^.\\n\\d]{0,25}';
const int = (s) => Number(String(s).replace(/[^\d]/g, ''));

const SIGNALS = [
  // «в наличии более 10 шт», «на складе > 10», «Количество товара на складах: более 100»
  { re: `${WHERE}${GAP}(?:более|больше|свыше|>)\\s*${NUM}${NOT_QTY}`, at: (m) => ({ qty: int(m[1]), at_least: true }) },
  // «наличие: 10+ шт», «В наличии : 1 000+ шт»
  { re: `${WHERE}${GAP}${NUM}\\s*\\+`, at: (m) => ({ qty: int(m[1]), at_least: true }) },
  // «в наличии 12 шт», «В наличии · 11 шт», «Наличие на складах (0 шт.)», «осталось 3 шт» — число обязательно с единицей
  { re: `${WHERE}${GAP}${NUM}\\s*${UNIT}`, at: (m) => ({ qty: int(m[1]), at_least: false }) },
  // «В наличии 7 Получить спец. цену» — число без единицы, за ним с заглавной буквы начинается уже другая надпись
  { re: `в\\s+наличии\\s+(\\d{1,5})(?=\\s+[А-ЯЁA-Z][а-яёa-z])`, at: (m) => ({ qty: int(m[1]), at_least: false }), keepCase: true },
  // «В наличии: 106», «Количество товара на складах: 1 – 3» — без единицы, но сразу после двоеточия
  { re: `(?:в\\s+наличии|количество\\s+товара\\s+на\\s+склад(?:е|ах)|остаток(?:\\s+на\\s+складе)?)\\s*:\\s*${NUM}(\\s*[–—-]\\s*\\d{1,7})?${NOT_QTY}`, at: (m) => ({ qty: int(m[1]), at_least: Boolean(m[2]), upTo: m[2] ? int(m[2]) : null }) },
].map((s) => ({ ...s, re: s.keepCase ? new RegExp(s.re.replace('в\\s+наличии', '[Вв]\\s+наличии'), 'g') : new RegExp(s.re, 'gi') }));

const WORDS = [
  ['нет в наличии', /(?<![а-яё])(?:нет\s+в\s+наличии|временно\s+отсутствует|отсутствует\s+на\s+складе|нет\s+на\s+складе(?!,?\s+доступен)|распродан[оа]?(?![а-яё])|товар\s+закончился|снят\S*\s+с\s+(?:продажи|производства)|(?:товар\s+)?не\s+поставляется|нет\s+в\s+продаже)/gi],
  ['под заказ', /(?<![а-яё])(?:под\s+заказ|предзаказ|ожидается\s+поступлен\S*|доступен\s+к\s+заказу|(?:наличие|поставка)\s*:?\s*по\s+запросу|доступность\s*:\s*до\s+\d+\s+дн\S*)/gi],
  // «Доступность уточняйте», «Наличие и срок поставки уточняйте» — магазин прямо говорит, что сведений на странице нет
  ['уточнить', /(?:доступность|наличие(?:\s+и\s+срок\S*\s+поставки)?)\s*:?\s*уточня\S+|уточня\S+\s+наличие/gi],
  ['много', new RegExp(`${WHERE}[^.\\n\\d]{0,20}(?:много|достаточно|большое\\s+количество)`, 'gi')],
  ['мало', new RegExp(`${WHERE}[^.\\n\\d]{0,20}(?:мало(?![а-яё])|заканчивается|последн\\S+\\s+(?:штук|экземпляр))`, 'gi')],
  // «в наличии» и «на складе» как пометка у товара, а не в оговорках («при наличии на складе», «наличие на складе
  // носит информационный характер», «в наличии и под заказ 5000 позиций»)
  ['в наличии', /(?<![а-яё])(?<!(?:при|об|об\s+их|о|уточня\S+|уточнить|информаци\S+\s+о|товар\S*|позици\S+)\s+)(?:есть\s+)?в\s+наличии(?!\s+(?:нет|больше\s+нет|и\s+под\s+заказ|отсутств|уточня))/gi],
  ['в наличии', /(?<![а-яё])(?<!(?:наличи[иея]|отсутствует|продукции|товара|нет)\s+)(?:есть\s+)?на\s+складе(?!\s+(?:нет|отсутств|магазина|нос[ия]т|производител))/gi],
];

/**
 * Первый по тексту признак наличия. Число рядом с пометкой «в наличии» важнее самой пометки («В наличии · 11 шт»);
 * «нет в наличии» и «под заказ» выше по странице важнее числа ниже — оно относится к другому товару.
 * @returns {{qty: number|null, at_least: boolean, note: string|null, availability: string|null}}
 */
function scanStock(text) {
  const t = String(text || '').replace(/ /g, ' ');
  const found = [];
  for (const s of SIGNALS) {
    for (const m of t.matchAll(s.re)) { found.push({ index: m.index, end: m.index + m[0].length, num: s.at(m) }); break; }
  }
  for (const [word, re] of WORDS) {
    for (const m of t.matchAll(re)) { found.push({ index: m.index, end: m.index + m[0].length, word }); break; }
  }
  if (!found.length) return { qty: null, at_least: false, note: null, availability: null };
  found.sort((a, b) => a.index - b.index || Number(Boolean(b.num)) - Number(Boolean(a.num)));
  let first = found[0];
  // Магазин просит уточнять наличие — пометка «в наличии» ниже по странице к этому товару не относится.
  if (first.word === 'уточнить') {
    const next = found.find((f) => f.word === 'нет в наличии' || f.word === 'под заказ');
    if (!next || next.index > first.end + 120) return { qty: null, at_least: false, note: null, availability: null };
    first = next;
  }
  // «В наличии: Количество товара на складах: 1 – 3» — пометка, и сразу за ней число: берём число.
  if (first.word === 'в наличии' || first.word === 'много' || first.word === 'мало') {
    const num = found.find((f) => f.num && f.index <= first.end + 60 && !found.some((w) => w.word && w.word !== first.word && w.index > first.index && w.index < f.index));
    if (num) first = num;
  }
  if (first.num) {
    const { qty, at_least, upTo } = first.num;
    // «1 – 3» — известно, что не меньше одного: в расчёт идёт нижняя граница
    return { qty, at_least, note: upTo ? `от ${qty} до ${upTo}` : at_least ? `более ${qty}` : null, availability: qty > 0 ? 'в наличии' : 'нет в наличии' };
  }
  if (first.word === 'в наличии') return { qty: null, at_least: false, note: null, availability: 'в наличии' };
  if (first.word === 'нет в наличии') return { qty: null, at_least: false, note: null, availability: 'нет в наличии' };
  if (first.word === 'под заказ') return { qty: null, at_least: false, note: 'под заказ', availability: 'под заказ' };
  return { qty: null, at_least: false, note: first.word, availability: 'в наличии' }; // «много», «мало»
}

/**
 * @param text текст страницы возле товара
 * @returns {{qty: number|null, at_least: boolean, note: string|null}} qty — сколько есть (или не меньше скольки, если at_least);
 *   note — «более 10», «от 1 до 3», «под заказ», «много», «мало» или null
 */
function stockFromText(text) {
  const { qty, at_least, note } = scanStock(text);
  return { qty, at_least, note };
}

/** Количество из разметки страницы (schema.org inventoryLevel) — надёжнее текста. */
function stockFromStructured(level) {
  const v = level && typeof level === 'object' ? level.value : level;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && v !== '' && v != null ? { qty: n, at_least: false, note: null } : null;
}

/**
 * Наличие одним из трёх слов — что бы ни написал магазин или разметка страницы (InStock, PreOrder, «Есть на складе»).
 * Непонятное («В корзину») — null: это не сведения о наличии.
 * @returns {'в наличии'|'нет в наличии'|'под заказ'|null}
 */
function normalizeAvailability(raw) {
  const s = String(raw || '').split('/').pop().trim().toLowerCase();
  if (!s) return null;
  if (/outofstock|soldout|discontinued|нет\s+в\s+наличии|отсутств|распродан|снят|закончил|недоступ|не\s+поставля/.test(s)) return 'нет в наличии';
  if (/preorder|backorder|presale|под\s+заказ|предзаказ|по\s+запросу|ожидается|к\s+заказу/.test(s)) return 'под заказ';
  if (/instock|limitedavailability|instoreonly|onlineonly|в\s+наличии|на\s+складе|^есть|^много|^мало|^да$/.test(s)) return 'в наличии';
  return null;
}

/**
 * Наличие и количество товара со страницы — всё, что магазин показал: разметка, проверенный атрибут сайта, текст возле
 * названия товара.
 * @param {{text?: string, html?: string, level?: any, availability?: string, attr?: string}} p
 *   text — текст страницы, начиная с названия товара; level — schema.org inventoryLevel; availability — наличие из
 *   разметки или от нейросети; attr — имя атрибута с остатком на этом сайте (config/stores.json → stock_attr)
 * @returns {{qty: number|null, at_least: boolean, note: string|null, availability: string|null}}
 */
function readStock({ text = '', html = '', level = null, availability = null, attr = null } = {}) {
  const said = normalizeAvailability(availability);
  const numbered = (qty, at_least = false) => ({ qty, at_least, note: at_least ? `более ${qty}` : null, availability: qty > 0 ? 'в наличии' : 'нет в наличии' });
  const fromLevel = stockFromStructured(level);
  if (fromLevel) return numbered(fromLevel.qty);
  if (attr && /^[a-z][a-z0-9-]*$/i.test(attr)) {
    const m = new RegExp(`\\b${attr}\\s*=\\s*["'](\\d{1,7})["']`, 'i').exec(String(html));
    // Товара нет или он под заказ — число в атрибуте значит «сколько можно заказать», а не «сколько лежит на складе».
    if (m && said !== 'под заказ' && said !== 'нет в наличии') return numbered(Number(m[1]));
  }
  const scan = scanStock(text);
  if (scan.qty != null) return scan;
  const final = said || scan.availability;
  return { qty: null, at_least: false, note: final === 'под заказ' ? 'под заказ' : final === 'в наличии' ? (scan.note === 'много' || scan.note === 'мало' ? scan.note : null) : null, availability: final };
}

/** Как показать количество человеку. */
function stockLabel(o) {
  if (o.stock_qty != null) return o.stock_note && /^(более|от)\s/.test(o.stock_note) ? `${o.stock_note} шт` : `${o.stock_qty} шт`;
  return o.stock_note || null;
}

module.exports = { stockFromText, stockFromStructured, stockLabel, scanStock, readStock, normalizeAvailability };
