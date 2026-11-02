// Единицы измерения: приводим цену продавца или прошлого контракта к единице заказчика.
// Пример: заказчик покупает дизель в тоннах, а в контрактах цена за литр; заказчик — пачки бумаги, продавец — коробки по 5 пачек.
// Неизвестный пересчёт → null («несопоставимо»), как и раньше: лучше «нет данных», чем маржа по чужой единице.

// Коды ОКЕИ → каноническая единица.
const OKEI = {
  796: 'шт', 778: 'упак', 704: 'набор', 715: 'пар', 839: 'компл', 163: 'г', 166: 'кг', 168: 'т', 111: 'мл', 112: 'л', 113: 'м3',
  6: 'м', 18: 'пог.м', 55: 'м2', 4: 'см', 3: 'мм', 616: 'бобина', 736: 'рулон', 728: 'пачка', 812: 'ящик', 356: 'ч', 642: 'ед',
};

// Слова → каноническая единица (порядок важен: длинные раньше коротких).
const WORDS = [
  [/^(штук[аи]?|шт\.?|штука)$/, 'шт'], [/^(упаковк[аи]?|упак\.?|уп\.?)$/, 'упак'], [/^(пачк[аи]|пач\.?)$/, 'пачка'],
  [/^(набор[ы]?|наб\.?)$/, 'набор'], [/^(комплект[ы]?|компл\.?|к-т)$/, 'компл'], [/^(пар[аы]?)$/, 'пар'],
  [/^(рулон[ы]?|рул\.?)$/, 'рулон'], [/^(коробк[аи]|кор\.?)$/, 'коробка'], [/^(ящик[и]?)$/, 'ящик'],
  [/^(тонн[аы]?|т|метрическая тонна.*)$/, 'т'], [/^(килограмм[ы]?|кг)$/, 'кг'], [/^(грамм[ы]?|г|гр\.?)$/, 'г'],
  [/^(литр[ы]?|л|дм3|кубический дециметр.*)$/, 'л'], [/^(миллилитр[ы]?|мл)$/, 'мл'], [/^(кубический метр|куб\.?\s*м|м3|м³)$/, 'м3'],
  [/^(погонный метр|пог\.?\s*м|п\.?\s*м)$/, 'пог.м'], [/^(метр[ы]?|м)$/, 'м'], [/^(квадратный метр|кв\.?\s*м|м2|м²)$/, 'м2'],
  [/^(условная единица|усл\.?\s*ед\.?|ед\.?|единица)$/, 'ед'],
];

/** Каноническая единица из кода ОКЕИ или текста («Тонна; метрическая тонна (1000 кг)» → «т»). */
function normUnit(u) {
  if (u == null || u === '') return null;
  if (typeof u === 'object') return normUnit(u.code != null ? Number(u.code) : u.nationalCode || u.name);
  if (typeof u === 'number' || /^\d+$/.test(String(u).trim())) return OKEI[Number(u)] || null;
  const s = String(u).toLowerCase().replace(/ё/g, 'е').split(/[;(]/)[0].trim().replace(/\s+/g, ' ');
  for (const [re, canon] of WORDS) if (re.test(s)) return canon;
  return s || null;
}

// Масса и объём: сколько базовых единиц в одной.
const MASS = { г: 0.001, кг: 1, т: 1000 };
const VOLUME = { мл: 0.001, л: 1, м3: 1000 };
const LENGTH = { мм: 0.001, см: 0.01, м: 1, 'пог.м': 1 };
// Плотность, кг/л — для пересчёта литров в тонны, если в ТЗ её нет.
const DENSITY = [
  [/дизел|дт\b|солярк/, 0.84], [/бензин|аи-?9[25]|аи-?98|аи-?80/, 0.75], [/керосин/, 0.8], [/мазут/, 0.95], [/масл/, 0.89], [/вода/, 1],
];

const PIECES = new Set(['шт', 'ед']);
const PACKS = new Set(['упак', 'пачка', 'набор', 'компл', 'коробка', 'ящик', 'рулон']);

function densityFor(name) {
  const s = String(name || '').toLowerCase().replace(/ё/g, 'е');
  return DENSITY.find(([re]) => re.test(s))?.[1] ?? null;
}

/**
 * Сколько «единиц заказчика» в одной «единице продавца». Цена за единицу заказчика = цена продавца / factor.
 * @param {string} from единица продавца/контракта
 * @param {string} to единица заказчика
 * @param {{packQty?: number, density?: number, name?: string}} ctx
 * @returns {number|null} null — пересчёт неизвестен
 */
function unitFactor(from, to, { packQty = null, density = null, name = '' } = {}) {
  const a = normUnit(from);
  const b = normUnit(to);
  if (!a || !b) return a === b ? 1 : null;
  if (a === b) return 1;
  if (PIECES.has(a) && PIECES.has(b)) return 1;
  for (const table of [MASS, VOLUME, LENGTH]) if (table[a] != null && table[b] != null) return table[a] / table[b];
  // масса ↔ объём через плотность (кг/л)
  const d = density ?? densityFor(name);
  if (d) {
    if (VOLUME[a] != null && MASS[b] != null) return (VOLUME[a] * d) / MASS[b];
    if (MASS[a] != null && VOLUME[b] != null) return MASS[a] / d / VOLUME[b];
  }
  // упаковка ↔ штука через фасовку
  if (packQty && packQty > 1) {
    if (PACKS.has(a) && PIECES.has(b)) return packQty;
    if (PIECES.has(a) && PACKS.has(b)) return 1 / packQty;
  }
  return null;
}

/** Цена за единицу заказчика или null, если единицы несопоставимы. */
function convertPrice(price, from, to, ctx) {
  if (price == null) return null;
  const f = unitFactor(from, to, ctx);
  return f ? Math.round((price / f) * 100) / 100 : null;
}

/** Фасовка из текста: «(10 шт в упаковке)», «500 листов», «упаковка 12 шт», «5 пачек в коробке». */
function packFromText(text) {
  const s = String(text || '').toLowerCase().replace(/ё/g, 'е');
  const m = s.match(/(\d{1,5})\s*(?:шт|штук|листов|лист|пачек|рулонов|пар)\.?\s*(?:в|\/)\s*(?:упак|уп|пачк|короб|ящик|наборе|рулон)/)
    || s.match(/(?:упаковк[аеи]|уп\.?|пачк[аеи]|коробк[аеи]|набор)\s*(?:по\s*)?(\d{1,5})\s*(?:шт|листов|пачек|пар)/)
    || s.match(/(\d{1,5})\s*листов/);
  return m ? Number(m[1]) : null;
}

module.exports = { normUnit, unitFactor, convertPrice, packFromText, densityFor, OKEI };
