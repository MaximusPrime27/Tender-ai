// Сверка найденного товара с характеристиками позиции из ТЗ.
// Числа проверяются детерминированно («не менее 6» против «8 ядер»), остальное — нейросетью (task: 'match').

const { checkKind, getKindModel, KIND_ON } = require('./kind-model');
const { z } = require('zod');
const { callJson } = require('../analyze/json');
const { checkTraits, conflictNote } = require('./traits');
const { applyRules, quoteAround } = require('./match-rules');
const { applySpecs } = require('./attributes');
const { applyCpu } = require('./cpu');

const MATCH_ORDER = { 'соответствует': 3, 'частично': 2, 'не хватает данных': 1, 'не соответствует': 0 };

const num = (s) => Number(String(s).replace(/[\s\u00a0]/g, '').replace(',', '.'));
// число в требовании: «10 000» (пробел между тысячами) — одно число, а не 10 и 000
const NUM = '\\d{1,3}(?:[\\s\\u00a0]\\d{3})+(?![\\d.,])|\\d+(?:[.,]\\d+)?';

/** Требование из ТЗ → {min, minStrict, max, maxStrict} или null, если это не число. */
function parseRequirement(value) {
  const v = String(value || '').toLowerCase();
  const r = {};
  // «более» — только само по себе: в «не более 3 кг» это верхняя граница, а не нижняя. Раньше такое требование
  // читалось как «больше 3 и не больше 3» — и под него не подходил ни один товар. «от» — отдельным словом («частот 50» — не оно).
  const m1 = v.match(new RegExp(`(не менее|(?<!не\\s)(?<![а-яё])более|(?<![а-яё])от|≥|>=)\\s*(${NUM})`));
  const m2 = v.match(new RegExp(`(не более|(?<!не )менее|(?<![а-яё])до|≤|<=)\\s*(${NUM})`));
  if (m1) { r.min = num(m1[2]); r.minStrict = m1[1] === 'более'; }
  if (m2) { r.max = num(m2[2]); r.maxStrict = m2[1] === 'менее'; }
  if (!m1 && !m2) {
    const exact = v.match(new RegExp(`^\\s*(${NUM})\\s*[a-zа-яё%]*\\s*$`, 'i'));
    if (exact) { r.min = num(exact[1]); r.max = num(exact[1]); }
  }
  return Object.keys(r).length ? r : null;
}

/** Ключевое слово характеристики, по которому ищем число в описании товара. */
// Только однозначные характеристики: сравнение чисел не должно давать ложных «не соответствует».
const KEYWORDS = [
  // «6 ядер», «4 ядра», «10-ядерный», «ядер: 16»
  [/^количество ядер процессора/i, /(\d+)\s*-?\s*(?:х\s*)?яд(?:ер|ра|ро)|ядер\S*\s*[:—-]?\s*(\d+)/i],
  [/^количество потоков процессора/i, /(\d+)\s*поток|поток\S*\s*[:—-]?\s*(\d+)/i],
  [/^частота процессора/i, /(\d+(?:[.,]\d+)?)\s*ГГц/i],
  [/^объ[её]м (установленной )?оперативной памяти/i, /(\d+)\s*(?:Гб|ГБ|GB|Мб|МБ|MB)\s*(?:DDR|ОЗУ|оперативн|RAM)|(?:ОЗУ|RAM|оперативн\S*\s*памят\S*)\s*[:—-]?\s*(\d+)\s*(?:Гб|ГБ|GB|Мб|МБ|MB)/i, 'gb'],
  [/^ресурс/i, /ресурс\S*\s*[:—-]?\s*(\d[\d\s]*)\s*(?:стр|отп)/i],
  [/^(размер\s+)?диагонал/i, /(\d+(?:[.,]\d+)?)\s*(?:"|″|“|”|дюйм)/i],
  [/^(общий )?объ[её]м накопител/i, /(\d+)\s*(?:Гб|ГБ|GB|Тб|ТБ|TB)\s*(?:SSD|HDD)|(?:SSD|HDD)\s*[:—-]?\s*(\d+)\s*(?:Гб|ГБ|GB|Тб|ТБ|TB)|объ[её]м накопител[а-яё]*(?:\s+[а-яё]+){0,2}\s*[:—-]?\s*(\d+)\s*(?:Гб|ГБ|GB|Тб|ТБ|TB)/i, 'gb'],
  [/^скорость печати/i, /(\d+)\s*(?:стр\S*\s*\/?\s*мин|ppm)/i],
];

// Сколько гигабайт в единице: в ТЗ пишут «256 Мбайт», в магазине — «1 ГБ»; в ТЗ «500 Гбайт», в магазине — «1 ТБ».
const unitGb = (s) => (/тб|тбайт|терабайт|tb/i.test(s) ? 1000 : /мб|мбайт|мегабайт|mb/i.test(s) ? 1 / 1024 : 1);

/** Детерминированная проверка чисел. @returns {{ok: [...], fail: [...], unknown: [...]}} */
function checkNumbers(characteristics, text) {
  const out = { ok: [], fail: [], unknown: [] };
  for (const ch of characteristics || []) {
    const req = parseRequirement(ch.value);
    const kw = KEYWORDS.find(([re]) => re.test(ch.name));
    if (!req || !kw) continue;
    const re = new RegExp(kw[1].source, 'gi');
    const valueOf = (m) => {
      const raw = num(String(m.slice(1).find((g) => g != null)).replace(/\s/g, ''));
      if (kw[2] !== 'gb') return raw;
      // Объём памяти и накопителя — в единицы требования.
      const unit = /\d\s*(тб|tb|гб|gb|мб|mb)/i.exec(m[0])?.[1] || 'гб';
      return (raw * unitGb(unit)) / unitGb(ch.value);
    };
    // Подписанное значение в характеристиках товара («Диагональ экрана: 24"») важнее любого числа на странице: ниже
    // бывают «Похожие товары» с другими размерами («Монитор 27" Exegate…») — 24-дюймовый проходил как 27-дюймовый.
    const label = kw[0].source.replace(/^\^/, '').replace(/\((?!\?)/g, '(?:');
    const labelled = [...text.matchAll(new RegExp(`(?:${label})[^:\\n]{0,30}:\\s*(?:${kw[1].source})`, 'gi'))].map(valueOf).filter((x) => !Number.isNaN(x));
    const values = labelled.length ? labelled : [...text.matchAll(re)].map(valueOf).filter((x) => !Number.isNaN(x));
    // Объём накопителя магазины пишут прямо в названии товара («8ТБ Жёсткий диск …») — это надёжнее, чем текст страницы,
    // где рядом перечислены другие объёмы той же серии.
    if (kw[2] === 'gb' && /накопител/i.test(ch.name)) {
      for (const m of String(text).split('\n')[0].matchAll(/(\d+(?:[.,]\d+)?)\s*(тб|tb|гб|gb)(?![a-zа-яё])/gi)) values.push((num(m[1]) * unitGb(m[2])) / unitGb(ch.value));
    }
    // «максимальная/турбо» — наибольшее из чисел, «базовая/минимальная» — наименьшее. Одно число при таком уточнении
    // неоднозначно (какая частота указана на странице — не ясно) — считаем, что данных не хватает.
    const qualified = /максим|турбо|базов|минимал/i.test(ch.name);
    if (!values.length || (qualified && values.length === 1 && !/базов/i.test(ch.name))) { out.unknown.push(ch.name); continue; }
    const fits = (x) => (req.min == null || (req.minStrict ? x > req.min : x >= req.min)) && (req.max == null || (req.maxStrict ? x < req.max : x <= req.max));
    // На странице одно и то же пишут по-разному и не по одному разу: «2/8/6 ядер» (по видам ядер) и ниже «ядер: 16»;
    // рядом бывают и чужие товары. «Не подходит» говорим, только если ни одно из найденных чисел не подходит.
    const found = /максим|турбо/i.test(ch.name) ? Math.max(...values) : /базов|минимал/i.test(ch.name) ? Math.min(...values) : values.find(fits) ?? values[0];
    if (fits(found)) out.ok.push(`${ch.name}: нужно ${ch.value}, у товара ${found} — подходит`);
    else out.fail.push(`${ch.name}: нужно ${ch.value}, у товара ${found}`);
  }
  return out;
}

// Ответ нейросети: по каждому требованию ТЗ (по номеру) — «да: …», «нет: …» или «?».
const CheckSchema = z.object({
  kind: z.boolean().catch(true),
  checks: z.record(z.string(), z.coerce.string()).catch({}),
});

// Требований в ТЗ бывает и 160: сверяем пачками по PACK_SIZE за один вызов нейросети, но проверяем все.
// Пачка, на которую нейросеть не ответила, остаётся «не проверено» и не даёт полного соответствия.
const PACK_SIZE = 40;
const OFFER_TEXT_MAX = 9000; // столько текста страницы уходит в один вызов; длиннее — для пачки берём относящиеся к ней места
const PART_SHARE = 0.3;      // подтверждено меньше этой доли (и меньше трёх требований) — «не хватает данных»

// Единицы измерения: семейство и множитель — чтобы сравнить «8 ТБ» с «8000 Гбайт», «3.5"» с «3,5 дюйм».
const UNIT_FAMILIES = [
  [/^(тб|тбайт\S*|терабайт\S*|tb)$/i, 'byte', 4], [/^(гб|гбайт\S*|гигабайт\S*|gb)$/i, 'byte', 3], [/^(мб|мбайт\S*|мегабайт\S*|mb)$/i, 'byte', 2], [/^(кб|кбайт\S*|kb)$/i, 'byte', 1],
  [/^(ггц|ghz)$/i, 'hz', 1e9], [/^(мгц|mhz)$/i, 'hz', 1e6], [/^(кгц|khz)$/i, 'hz', 1e3], [/^(гц|hz)$/i, 'hz', 1],
  [/^(мм|mm)$/i, 'len', 1], [/^(см|cm)$/i, 'len', 10], [/^(м|m)$/i, 'len', 1000], [/^(дюйм\S*|"|″|''|inch\S*)$/i, 'len', 25.4],
  [/^(кг|kg)$/i, 'mass', 1000], [/^(г|гр|g)$/i, 'mass', 1],
  [/^(л|l)$/i, 'vol', 1000], [/^(мл|ml)$/i, 'vol', 1],
  [/^(квт|kw)$/i, 'power', 1000], [/^(вт|w)$/i, 'power', 1],
  [/^(гбит\/с(ек)?|gbps|гбит)$/i, 'rate', 1000], [/^(мбит\/с(ек)?|mbps|мбит)$/i, 'rate', 1],
];
// единица, в которой одно и то же число значит разное (г и кг, мм и м, мл и л); дюйм однозначен
const scaleUnit = (u) => Boolean(u) && ['mass', 'len', 'vol'].includes(u[1]) && u[2] !== 25.4;
const unitOf = (u) => UNIT_FAMILIES.find(([re]) => re.test(String(u || '').replace(/\.$/, ''))) || null;
const numberWithUnit = (s) => {
  const m = /(\d+(?:[.,]\d+)?)\s*([a-zа-яё"″']+(?:\/[a-zа-яё]+)?)?/i.exec(String(s).replace(/(\d)\s(?=\d{3}(?!\d))/g, '$1'));
  return m ? { n: num(m[1]), unit: unitOf(m[2]) } : null;
};

/**
 * Подходит ли найденное на странице значение под числовое требование — с переводом единиц.
 * @returns {boolean|null} null — судить нельзя (требование не числовое, единицы разных видов)
 */
function fitsNumeric(need, found) {
  // В ТЗ из ЕИС единица в скобках: «≥ 10 (Мегабайт)», «≥ 16 (Гигабайт)» — без скобок она узнаётся, и «4 МБ» при нужных
  // 10 — «не подходит», а не «не подтверждено»
  need = String(need ?? '').replace(/[()]/g, ' ');
  const req = parseRequirement(need);
  const got = numberWithUnit(found);
  if (!req || !got || Number.isNaN(got.n)) return null;
  // единица — после первого числа или в конце: «не менее 0.54 и не более 0.66 мм»
  const stripped = String(need).replace(/не менее|не более|более|менее|от|до|≥|≤|>=|<=/gi, ' ');
  const needUnit = numberWithUnit(stripped)?.unit || unitOf(/([a-zа-яё"″']+)\s*$/i.exec(stripped.trim())?.[1]) || null;
  const fits = (x) => (req.min == null || (req.minStrict ? x > req.min : x >= req.min)) && (req.max == null || (req.maxStrict ? x < req.max : x <= req.max));
  if (needUnit && got.unit) {
    if (needUnit[1] !== got.unit[1]) return null;
    // Объём памяти считают и тысячами, и по 1024: подходит, если подходит хотя бы при одном счёте.
    if (needUnit[1] === 'byte') return [1000, 1024].some((k) => fits(got.n * k ** (got.unit[2] - needUnit[2])));
    return fits((got.n * got.unit[2]) / needUnit[2]);
  }
  // Единица названа только с одной стороны или не распознана — сравниваем числа как есть, если ни одна не из «чужого» семейства.
  // Масса, длина и объём — только когда единица есть у требования: «≥ 5» (единица ТЗ потерялась, там было «5 кг») и
  // «50 г» у товара — не подтверждение (25.10 так прошёл тюбик 50 г при «не менее 5 кг»).
  if (!needUnit && scaleUnit(got.unit)) return null;
  if ((needUnit && !got.unit) || (!needUnit && got.unit)) return fits(got.n) ? true : null;
  return fits(got.n);
}

/**
 * Нейросеть сказала «нет», хотя среди найденного ею же есть число, подходящее под «не менее» («10/100/1000/2500 Мбит/с»
 * при «≥ 1000 Мбит/сек», «4800-6400 МГц» при «≥ 5600 МГц»). Засчитываем, только когда единицы с обеих сторон известны
 * и одного вида: «4 ядра (8 потоков)» при «ядер ≥ 8» так не засчитается.
 */
function fixFalseNo(rows) {
  for (const r of rows) {
    if (r.verdict !== 'no' || !r.found) continue;
    const need = String(r.need ?? '').replace(/[()]/g, ' ');
    const req = parseRequirement(need);
    if (!req || req.min == null || req.max != null) continue;
    const needUnit = numberWithUnit(need.replace(/не менее|не более|более|менее|от|до|≥|≤|>=|<=/gi, ' '))?.unit;
    if (!needUnit) continue;
    const hit = (String(r.found).match(/\d+(?:[.,]\d+)?\s*[a-zа-яё"″']+(?:\/[a-zа-яё]+)?/gi) || [])
      .find((t) => numberWithUnit(t)?.unit?.[1] === needUnit[1] && fitsNumeric(r.need, t) === true);
    if (hit) Object.assign(r, { verdict: 'yes', found: `${r.found} — подходит: ${hit}`, method: 'число со страницы' });
  }
}

// Требование «для каких устройств»: «Применимость», «Совместимость», «Наименование печатающего устройства, в котором
// применяется картридж», «Модель принтера». Характеристика товара — список совместимых устройств.
const COMPAT_REQ = /совмест|применим|применяется|печатающ\S*\s+устройств|для\s+(устройств|принтер|мфу)|модел\S*\s+(принтер|мфу|устройств|аппарат)|подходит\s+(к|для)/i;
const COMPAT_SPEC = /совмест|подходит|применим|для\s+(устройств|принтер|модел)|модели\s+принтер|устройств/i;

/**
 * Совместимость по списку устройств: модели устройств из требования («Pantum M6500W», «MF3010», «P1102/M1132») ищем
 * в характеристике «Совместимые устройства», в названии товара и в его описании. Подтверждаем, только если названы
 * все устройства из требования; часть — остаётся «не подтверждено» с пояснением (список у продавца бывает неполным).
 * Серия покрывает исполнения: «M428» на странице — это и M428dw, и M428fdn, и M428fdw из ТЗ (буквы после номера —
 * исполнение того же аппарата, картридж у них один). Полный список перекрывает и «нет» нейросети: она путается в длинных
 * перечнях («у товара HP LJ M404, LJ M428…» — «не подходит»).
 */
function applyCompat(rows, specs, title, text) {
  const flat = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
  const pool = flat([title, ...(specs || []).filter((s) => COMPAT_SPEC.test(s.name)).map((s) => s.value), text].join(' '));
  for (const r of rows) {
    if (!['unknown', 'no'].includes(r.verdict) || !COMPAT_REQ.test(r.name)) continue;
    // «Совместим с МФУ Canon i-sensys MF 3010» = «Да»: устройство — в названии требования; «MF 3010» — одна модель
    const where = /^\s*(да|есть|требуется|наличие)\s*$/i.test(String(r.need)) ? r.name : String(r.need);
    const src = where.replace(/\b([A-Za-z]{1,4})\s+(\d{3,5}[A-Za-z]{0,4})\b/g, '$1$2');
    const devices = [...new Set((src.match(/[A-Za-zА-Яа-я]*\d[A-Za-zА-Яа-я0-9-]*|[A-Za-z]+-?\d+[A-Za-z0-9-]*/g) || [])
      .map((t) => t.replace(/^-+|-+$/g, '')).filter((t) => /\d/.test(t) && /[a-zа-я]/i.test(t) && flat(t).length >= 4))];
    if (!devices.length) continue;
    // серия: номер без букв исполнения в конце («M428dw» → «M428»), на странице — отдельным обозначением
    const words = String([title, ...(specs || []).filter((s) => COMPAT_SPEC.test(s.name)).map((s) => s.value), text].join(' ')).toLowerCase().replace(/ё/g, 'е');
    const series = (d) => {
      const m = /^(.*\d)([a-z]{1,4})$/i.exec(d);
      if (!m || flat(m[1]).length < 4) return false;
      return new RegExp(`(^|[^a-z0-9])${m[1].toLowerCase().replace(/[^a-z0-9]/g, '[^a-z0-9]?')}(?![0-9])`).test(words);
    };
    const found = devices.filter((d) => pool.includes(flat(d)) || series(d));
    const bySeries = found.filter((d) => !pool.includes(flat(d)));
    if (found.length === devices.length) Object.assign(r, { verdict: 'yes', found: `совместим: ${found.join(', ')}${bySeries.length ? ` (${bySeries.join(', ')} — по серии на странице)` : ''}`, method: 'список совместимых устройств' });
    else if (found.length && r.verdict === 'unknown') r.found = `совместим: ${found.join(', ')}; не подтверждено: ${devices.filter((d) => !found.includes(d)).join(', ')}`;
  }
}

/**
 * Чего из перечня в требовании нет на странице. Смотрим только обозначения латиницей и цифрами («OPUS», «G.729»,
 * «IPv6», «802.1X»): их написание однозначно. Русские формулировки («Отключение микрофона») так не проверить.
 * @returns {string[]} недостающие обозначения
 */
function missingFromList(need, text) {
  const parts = String(need).split(/\s+\/\s+|;\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return [];
  const squash = (x) => String(x).toLowerCase().replace(/[^a-z0-9а-яё]/g, '');
  const page = squash(text);
  const missing = [];
  for (const part of parts) {
    const tokens = (part.match(/[A-Za-z0-9][A-Za-z0-9.+-]*[A-Za-z0-9]/g) || []).filter((t) => /[A-Za-z]/.test(t) || /\d\.\d/.test(t));
    if (!tokens.length) continue;
    const token = tokens.sort((a, b) => b.length - a.length)[0];
    // «G.711A» на странице пишут и как «G.711»: буква-уточнение в конце не обязательна.
    const variants = [squash(token), squash(token.replace(/(?<=\d)[A-Za-z]$/, ''))].filter((v) => v.length >= 2);
    if (!variants.some((v) => page.includes(v))) missing.push(token);
  }
  return missing;
}

// Условия поставки, а не свойства товара: расхождение с ними на странице магазина товар не отклоняет.
const SUPPLY_TERMS = /гарант|упаков|маркиров|документ|сертификат|срок\s+годност|год\s+выпуск|дата\s+(?:выпуск|изготовлен)/i;

/**
 * Требование — перечень обозначений латиницей («Ethernet (RJ-45), USB», «Windows, Linux»), и каждое из них (без
 * уточнений в скобках) на странице есть. Тогда ответ «нет» не доказан: названо что-то сверх перечня.
 */
function listOnPage(need, text) {
  const squash = (x) => String(x).toLowerCase().replace(/[^a-z0-9а-яё]/g, '');
  const tokens = [...new Set((String(need).replace(/\([^)]*\)/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9.+-]*[A-Za-z0-9]/g) || [])
    .filter((t) => /[A-Za-z]/.test(t) || /\d\.\d/.test(t)).map(squash))].filter((t) => t.length >= 2);
  if (tokens.length < 2) return false;
  const page = squash(text);
  return tokens.every((t) => page.includes(t));
}

/**
 * Текст страницы для одной пачки требований. Короткий — целиком. Длинный (страница вместе с паспортом, несколько
 * источников): начало страницы и куски, где встречаются слова требований этой пачки, — в исходном порядке.
 * Иначе требования из конца длинного паспорта не доходят до нейросети.
 */
function packText(text, pack, max = OFFER_TEXT_MAX) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const stems = [...new Set(pack.flatMap((c) => String(c.name || '').toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z]{4,}/g) || []).map((w) => w.slice(0, 6)))];
  const head = 2000;
  const size = 700;
  const chunks = [];
  for (let at = head; at < s.length; at += size) {
    const chunk = s.slice(at, at + size);
    const low = chunk.toLowerCase().replace(/ё/g, 'е');
    // заголовок источника («[Источник: …]») держим вместе с его кусками — по нему видно, откуда значение
    chunks.push({ at, chunk, score: stems.filter((st) => low.includes(st)).length + (/\[источник:/i.test(chunk) ? 0.5 : 0) });
  }
  const picked = chunks.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.at - b.at);
  let left = max - head;
  const keep = [];
  for (const c of picked) { if (left < c.chunk.length) break; keep.push(c); left -= c.chunk.length; }
  return [s.slice(0, head), ...keep.sort((a, b) => a.at - b.at).map((c) => c.chunk)].join('\n…\n');
}

const numbersIn = (s) => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.'));

/**
 * Итог сверки по ответам на каждое требование. Ответам нейросети не верим на слово: и «да», и «нет» засчитываются,
 * только если названное значение действительно есть на странице — дословно либо все его числа (целиком: «200»
 * внутри «3200» не считается). Ответ без значения или пересказ, которого на странице нет, — «не указано».
 * @returns {{rows: Array<{name, need, verdict: 'yes'|'no'|'unknown', found: string}>, confirmed: number, failed: number, unknown: number, total: number}}
 */
function judge(chars, answers, nums, text) {
  const flat = String(text).toLowerCase().replace(/,/g, '.');
  const evidenceText = (v) => String(v).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
  const page = ` ${evidenceText(text)} `;
  // Число на странице — целиком: «200» внутри «3200» или «1200.5» не считается. Точка — часть числа, только когда
  // рядом с ней цифра: после «24.» в конце предложения и «24,» в перечислении число всё равно найдено.
  const hasNumber = (n) => new RegExp(`(?<![0-9])(?<![0-9][.])${n.replace(/[.]/g, '[.]')}(?![0-9])(?![.][0-9])`).test(flat);
  const onPage = (found) => {
    const phrase = evidenceText(found);
    if (phrase.length > 1 && page.includes(` ${phrase} `)) return true;
    // Обозначения вроде G.729 или DDR4 — только целиком, а не по цифрам из них.
    if (/^[a-z][a-z0-9.+-]*$/i.test(String(found).trim())) return false;
    const ns = numbersIn(found);
    return ns.length > 0 && ns.every(hasNumber);
  };
  const okByNumber = new Map(nums.ok.map((note) => [note.split(':')[0], /у товара (.+?) — подходит$/.exec(note)?.[1] || '']));
  const rows = chars.map((ch, i) => {
    const raw = String(answers?.[String(i + 1)] ?? '?').trim();
    // Граница слова — через «дальше не буква»: \b в JavaScript русских букв не понимает.
    const yes = /^да(?![а-яё])[\s:—–-]*(.*)$/i.exec(raw);
    const no = /^нет(?![а-яё])[\s:—–-]*(.*)$/i.exec(raw);
    let verdict = 'unknown';
    let found = '';
    if (okByNumber.has(ch.name)) { verdict = 'yes'; found = okByNumber.get(ch.name); }
    else if (yes && onPage(yes[1])) { verdict = 'yes'; found = yes[1].trim(); }
    else if (no && no[1].trim() && !/не указан|нет данных|отсутству\S* сведен|неизвест/i.test(no[1]) && onPage(no[1])) { verdict = 'no'; found = no[1].trim(); }
    // Нейросеть повторила само требование («≥ 5000», «не менее 300 г/м2») вместо значения со страницы: число где-то на
    // странице есть, но что это значение товара — не доказано.
    if (verdict !== 'unknown' && !okByNumber.has(ch.name) && /^\s*(не менее|не более|менее|более|от|до|≥|≤|>=|<=|>|<)/i.test(found)
      && numbersIn(found).length && numbersIn(found)[0] === numbersIn(ch.value)[0]) {
      verdict = 'unknown'; found = 'значение на странице не названо (нейросеть повторила требование)';
    }
    // Перечень: «да» — только если на странице есть всё перечисленное.
    if (verdict === 'yes' && !okByNumber.has(ch.name)) {
      const missing = missingFromList(ch.value, text);
      if (missing.length) { verdict = 'unknown'; found = `на странице нет: ${missing.join(', ')}`; }
      // нейросеть назвала, что именно есть («D-SUB, DisplayPort, HDMI»), — требуемое обозначение должно быть среди названного:
      // «USB Type-C» в меню сайта не делает его разъёмом монитора
      else if (/[,;]/.test(found)) {
        const notNamed = missingFromList(ch.value, found);
        if (notNamed.length) { verdict = 'unknown'; found = `названо «${found.slice(0, 60)}», нет: ${notNamed.join(', ')}`; }
      }
    }
    // Числа пересчитываем сами: нейросеть путается в единицах («8 Тб» против «не менее 8000 Гбайт» — это подходит).
    if (verdict !== 'unknown' && !okByNumber.has(ch.name) && !/\s\/\s/.test(String(ch.value))) {
      const fit = fitsNumeric(ch.value, found);
      if (fit === true) verdict = 'yes';
      else if (fit === false) verdict = 'no';
      // число без единицы, которое не попадает в границы требования («Диаметр иглы: 0.8» при «0.54–0.66 мм»), —
      // не подтверждение, кто бы ни сказал «да»
      else if (verdict === 'yes' && parseRequirement(ch.value) && numbersIn(found).length === 1) {
        const req = parseRequirement(ch.value);
        const x = Number(numbersIn(found)[0]);
        if (!((req.min == null || (req.minStrict ? x > req.min : x >= req.min)) && (req.max == null || (req.maxStrict ? x < req.max : x <= req.max)))) {
          verdict = 'unknown'; found = `у товара ${found} — с требованием «${ch.value}» не сходится, сверьте единицы`;
        }
      }
      // требование без единицы («≥ 5»), у товара — граммы, миллиметры, литры: нейросети «да» не верим
      else if (verdict === 'yes' && parseRequirement(ch.value) && !numberWithUnit(String(ch.value).replace(/не менее|не более|более|менее|от|до|≥|≤|>=|<=/gi, ' '))?.unit
        && !unitOf(/([a-zа-яё"″']+)\s*$/i.exec(String(ch.value).trim())?.[1])
        && scaleUnit(numberWithUnit(found)?.unit)) {
        verdict = 'unknown'; found = `у товара ${found}, а в требовании единица не указана — сверьте с ТЗ`;
      }
    }
    // Гарантию, упаковку и документы задаёт договор с поставщиком, а не страница магазина: «гарантия 3 мес» на сайте —
    // повод уточнить, а не отклонить товар. Подтверждением это не становится: требование остаётся непроверенным.
    if (verdict === 'no' && SUPPLY_TERMS.test(ch.name)) { verdict = 'unknown'; found = `на странице «${found}» — условие поставки, уточните у поставщика`; }
    // Перечень обозначений («Ethernet (RJ-45), USB»), и все они на странице есть: ответ «нет: Wi-Fi» называет лишнее,
    // а не недостающее — противоречие не доказано.
    if (verdict === 'no' && listOnPage(ch.value, text)) { verdict = 'unknown'; found = `всё перечисленное на странице есть, но нейросеть назвала «${found}» — проверьте по странице`; }
    const method = okByNumber.has(ch.name) ? 'число со страницы' : verdict === 'unknown' ? null : 'нейросеть, проверено по тексту страницы';
    return { name: ch.name, need: String(ch.value), verdict, found: found.slice(0, 120), ...(method ? { method, quote: evidenceQuote(text, found) } : {}) };
  });
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  return { rows, confirmed: count('yes'), failed: count('no'), unknown: count('unknown'), total: rows.length };
}

/** Цитата со страницы вокруг найденного значения: сам текст, если он есть дословно, иначе первое его число. */
function evidenceQuote(text, found) {
  const f = String(found || '').trim();
  if (!f) return null;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = f.length >= 3 ? quoteAround(text, new RegExp(esc(f).replace(/\s+/g, '\\s+'), 'i')) : null;
  if (whole) return whole;
  const n = (f.match(/\d+(?:[.,]\d+)?/) || [])[0];
  return n ? quoteAround(text, new RegExp(`(?<![\\d.,])${esc(n).replace(/[.,]/, '[.,]')}(?![\\d])`)) : null;
}

const short = (list, n) => (list.length > n ? `${list.slice(0, n).join('; ')} (и ещё ${list.length - n})` : list.join('; '));

// С чего начинается название запчасти, расходника к расходнику или услуги — когда в ТЗ сам товар.
const PART_HEAD = /^(чип|заправк|заправочн|ракель|ролик|барабан|фотобарабан|фотовал|фоторецептор|шестерн|термопл[её]нк|лезвие|бункер|ремкомплект|ремонт|восстановлен|прошивк|наклейк|упаковк)/i;

/**
 * Тот же ли это вид товара — по названию, без нейросети. Ловит самое частое у расходников: в ТЗ картридж,
 * а найдены чип, заправка, ракель или тонер в банке для той же модели.
 * @returns {string|null} причина, почему это другой товар, или null
 */
function otherKind(itemName, title, model = null) {
  const need = String(itemName || '').trim();
  const got = String(title || '').trim();
  if (!need || !got) return null;
  if (PART_HEAD.test(got) && !PART_HEAD.test(need)) {
    // Блок фотобарабана — самостоятельный расходник со своей моделью (DK-170, DR-2335); в ТЗ он идёт под общим названием
    // «Картридж для электрографических печатающих устройств». Модель из ТЗ стоит в названии товара до слова «для» —
    // значит, это он сам («Фотобарабан Kyocera DK-170»), а не деталь к нему («Фотобарабан для Kyocera DK-170»).
    const flat = (x) => String(x).toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
    const own = got.split(/\s(?:для|for|к)\s/i)[0];
    const itself = model && /^(фото)?барабан/i.test(got) && flat(model).length >= 4 && flat(own).includes(flat(model));
    if (!itself) return `в ТЗ «${need.split(/\s+/).slice(0, 2).join(' ')}», а это ${got.split(/\s+/)[0].toLowerCase()} к нему`;
  }
  if (/картридж/i.test(need) && !/картридж|cartridge|туба/i.test(got) && /тонер/i.test(got) && /(банк|бутыл|флакон|канистр|пакет|\d+\s*к?г(?![а-яёa-z]))/i.test(got)) {
    return 'в ТЗ картридж, а это тонер для заправки (в банке или бутыли)';
  }
  return null;
}

/**
 * @param item позиция закупки {name, characteristics}
 * @param offer {title, text}
 * @param llm провайдер или null (без LLM — только числа)
 * @returns {Promise<{match, notes: string[], checks?: object}>} checks — сверка по каждому требованию (для таблицы в карточке)
 */
// specComplete === false — ТЗ прочитано не полностью: «соответствует» не ставится (требования могли потеряться).
/** Страница раздела каталога вместо товара: «Мониторы 24 дюйма» при «Монитор …» в ТЗ, без модели, адрес раздела. */
function categoryPage(itemName, title, url) {
  const first = (s) => String(s || '').trim().split(/[\s,]+/)[0].toLowerCase().replace(/ё/g, 'е');
  const a = first(itemName);
  const b = first(title);
  if (a.length < 4 || b.length < 4 || b === a || !/[ыи]$/.test(b) || /[ыи]$/.test(a)) return false;
  if (b.slice(0, Math.max(4, a.length - 1)) !== a.slice(0, Math.max(4, a.length - 1))) return false;
  if (/(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{3,}/.test(String(title))) return false; // есть модель
  return /\/(catalog|category|categories|section|c)\//i.test(String(url || '')) || !/\d/.test(String(title).replace(/\d+\s*(дюйм|"|″)/g, ''));
}

/** Модель товара — вне скобок, модели в скобках — его комплектующие; у предложения только комплектующее → {main, part}. */
function componentOnly(itemName, title) {
  const { modelTokens } = require('./spec');
  const name = String(itemName || '');
  const outside = modelTokens(name.replace(/\([^)]*\)/g, ' '));
  const inside = modelTokens((name.match(/\(([^)]*)\)/g) || []).join(' ')).filter((m) => !outside.includes(m));
  if (!outside.length || !inside.length) return null;
  const t = String(title || '').toUpperCase().replace(/[\s-]/g, '');
  const has = (m) => t.includes(m.toUpperCase().replace(/[\s-]/g, ''));
  const part = inside.find(has);
  return part && !outside.some(has) ? { main: outside[0], part } : null;
}

// Условия поставки, а не свойства товара: на странице товара их не бывает, их выполняет поставщик по договору
// (остаточный срок годности на момент поставки, упаковка производителя, маркировка, доставка, разгрузка, документы при
// поставке). В сверку с товаром они не идут — показываются отдельно: «подтверждает поставщик».
const SUPPLY_TERM = /остаточн\S*\s+срок|срок\S*\s+годност\S*\s+(?:на\s+момент|при|с\s+момента)\s+(?:поставк|передач|получ)|на\s+момент\s+(?:поставки|передачи)|упаковк\S*\s+(?:производител|заводск)|маркировк|доставк|разгрузк|занос|подъ[её]м\s+на\s+этаж|сопроводительн\S*\s+документ|документ\S*\s+при\s+поставк|сертификат\S*\s+при\s+поставк/i;
const isSupplyTerm = (c) => SUPPLY_TERM.test(String(c?.name || '')) || /^\s*не\s+менее\s+\d+\s*%\s+(?:от\s+)?(?:общего\s+)?срок/i.test(String(c?.value || ''));

// Вид товара (kind-model.js). Медицина — решение рабочее: там сверка по размерам чаще всего берёт чужой товар (31.10,
// капельница к комплекту для переливания крови). Остальные ниши только наблюдают: вердикт пишется в проверки и ничего не меняет.
function withKind(item, offer, r, mode) {
  const model = getKindModel();
  if (!model || mode === 'off' || !r || offer?.source === 'contracts') return r;
  const kind = checkKind(model, item, offer);
  const out = { ...r, checks: { ...(r.checks || {}), kind } };
  const code = String(item?.ktru_code || item?.okpd2_code || '');
  if (kind.verdict !== 'other' || mode !== 'on' || !KIND_ON.test(code) || r.match === 'не соответствует') return out;
  return { ...out, match: 'не соответствует', notes: [`другой товар: ${kind.why}`, ...(r.notes || [])] };
}

/**
 * Цена товара вдвое ниже обычной цены прошлых контрактов на эту позицию — почти всегда другой товар или ошибка: прибыль на
 * ней считать нельзя (31.10, капельницы по 15 ₽ при контрактах 20–54 ₽). Меньше трёх контрактов — судить не по чему.
 * @returns {{median:number}|null}
 */
function priceBelowContracts(price, contractPrices) {
  const list = contractPrices.filter((p) => p > 0).sort((a, b) => a - b);
  if (list.length < 3 || !(price > 0)) return null;
  const median = list[Math.floor(list.length / 2)];
  return price < median * 0.5 ? { median } : null;
}

/** Рабочий вердикт вида: почему это другой товар, либо null. Для перепроверки уже найденных предложений. */
function kindMismatch(item, offer, mode = process.env.MATCH_KIND ?? 'on') {
  const model = getKindModel();
  if (!model || mode !== 'on' || !KIND_ON.test(String(item?.ktru_code || item?.okpd2_code || ''))) return null;
  const kind = checkKind(model, item, offer);
  return kind.verdict === 'other' ? kind.why : null;
}

async function matchOffer(item, offer, opts = {}) {
  const { specOf } = require('./spec');
  const supply = (specOf(item).required || []).filter(isSupplyTerm);
  const r = withKind(item, offer, await matchCore(item, offer, opts), opts.kindMode ?? process.env.MATCH_KIND ?? 'on');
  if (!supply.length || !r) return r;
  const names = supply.map((x) => x.name);
  return { ...r, ...(r.checks ? { checks: { ...r.checks, supply: names } } : {}), notes: [...(r.notes || []), `Условия поставки — подтверждает поставщик по договору, на странице товара их не бывает: ${names.slice(0, 4).join('; ')}`] };
}

async function matchCore(item, offer, { llm, system, partShare = PART_SHARE, specComplete = true, offline = false } = {}) {
  const incomplete = specComplete === false ? 'ТЗ прочитано не полностью — соответствие не окончательное: дочитайте документацию' : null;
  // Таблица характеристик (со страницы и из своей базы товаров) — тоже текст товара: правила ищут требования в тексте,
  // и значения таблицы, которых нет в тексте страницы, раньше до сверки не доходили
  const specLines = (offer.specs || []).filter((x) => x?.name && x.value != null).map((x) => `${x.name}: ${x.value}`).filter((l) => !String(offer.text || '').includes(l));
  if (specLines.length) offer = { ...offer, text: `${offer.text || ''}\n${specLines.join('\n')}` };
  const text = `${offer.title || ''}\n${offer.text || ''}`;
  const { specOf, sameProductDet } = require('./spec');
  const spec = specOf(item);
  const wrongKind = otherKind(item.name, offer.title, spec.identity?.model);
  if (wrongKind) return { match: 'не соответствует', notes: [`другой товар: ${wrongKind}`] };
  // раздел каталога, а не товар: «Мониторы 24 дюйма» по адресу …/catalog/monitori-24-dyuima/ (аудит 29.10) — вид товара во
  // множественном числе, модели нет, адрес раздела
  if (categoryPage(item.name, offer.title, offer.url)) return { match: 'не соответствует', notes: ['это раздел каталога, а не страница товара — цена конкретного товара неизвестна'] };
  // комплектующее вместо товара: «Сетевое хранилище (NAS) QNAP TS-133 (4TB WD Red Plus WD40EFZZ)» — модель товара TS-133,
  // в скобках — диск к нему; у предложения только WD40EFZZ — это диск, а не хранилище (аудит 29.10)
  const part = componentOnly(item.name, offer.title);
  if (part) return { match: 'не соответствует', notes: [`это комплектующее «${part.part}» из состава позиции, а не сам товар «${part.main}»`] };
  // Этап 6b: модель, формат и числа с единицами из спецификации ТЗ — детерминированно, до нейросети.
  // Сверяем объединённые требования: всё из ТЗ плюс характеристики извещения, которых в ТЗ нет.
  item = { ...item, characteristics: (spec.required || []).filter((r) => !isSupplyTerm(r)).map((r) => ({ name: r.name, value: r.value })) };
  // Взаимоисключающие признаки (чёрно-белый / цветной): противоречие отклоняет товар сразу, что бы ни совпало ещё.
  const traits = checkTraits(item.name, item.characteristics, { title: offer.title, text: offer.text });
  if (traits.conflicts.length) return { match: 'не соответствует', notes: traits.conflicts.map((c) => `Не подходит: ${conflictNote(c)}`) };
  const nums = checkNumbers(item.characteristics, text);
  if (nums.fail.length) return { match: 'не соответствует', notes: nums.fail };
  const det = sameProductDet(spec, text);
  if (det.verdict === 'different') return { match: 'не соответствует', notes: [det.reason] };
  if (!(spec.required || []).length && !(item.characteristics || []).length) {
    // В ТЗ нет требований: сверить можно только наименование и модель. Совпала модель — тот же товар.
    // Совпало одно наименование («Моноблоки») — подойдёт любой моноблок за любые деньги, это не сверка.
    const { modelTokens } = require('./spec');
    const hasModel = Boolean(spec.identity?.model) || modelTokens(item.name).length > 0;
    // Модель совпала — проверяем, что это сам товар, а не чип, тонер в банке, запчасть или услуга «для» этой модели.
    if (det.verdict === 'same' && hasModel && llm && system) {
      try {
        const { data } = await callJson(llm, {
          system, schema: CheckSchema, task: 'match',
          user: JSON.stringify({ required: { name: item.name, characteristics: [] }, offer: { title: offer.title, text: String(offer.text || '').slice(0, 2500) } }, null, 1),
        });
        if (data.kind === false) return { match: 'не соответствует', notes: ['модель та же, но это другой товар: запчасть, расходник или услуга к ней, а не то, что в ТЗ'] };
      } catch { /* нейросеть не ответила — остаётся сверка по модели */ }
    }
    return det.verdict === 'same' && hasModel
      ? (incomplete ? { match: 'частично', notes: [det.reason, 'в ТЗ нет характеристик — сверена модель', incomplete] } : { match: 'соответствует', notes: [det.reason, 'в ТЗ нет характеристик — сверена модель'] })
      : { match: 'не хватает данных', notes: [det.reason, 'в ТЗ нет характеристик: совпадает только наименование — какой именно товар нужен, смотрите в документации'].filter(Boolean) };
  }
  if (!(item.characteristics || []).length && spec.required.filter((r) => !isSupplyTerm(r)).length) item = { ...item, characteristics: spec.required.filter((r) => !isSupplyTerm(r)).map((r) => ({ name: r.name, value: r.value })) };
  const all = (item.characteristics || []).filter((c) => c && c.name && c.value != null && String(c.value).trim());
  const chars = all;
  let answer = null;
  let failedPacks = 0;
  if (llm && system && chars.length) {
    const packs = [];
    for (let i = 0; i < chars.length; i += PACK_SIZE) packs.push(chars.slice(i, i + PACK_SIZE));
    const checks = {};
    const kinds = [];
    for (const [p, pack] of packs.entries()) {
      try {
        const { data } = await callJson(llm, {
          system,
          user: JSON.stringify({
            required: { name: item.name, characteristics: pack.map((c, i) => ({ n: i + 1, name: c.name, value: c.value })) },
            offer: { title: offer.title, text: packText(offer.text, pack) },
          }, null, 1),
          schema: CheckSchema,
          task: 'match',
        });
        kinds.push(data.kind);
        // номера в ответе — внутри пачки; переводим в общий номер требования
        for (const [n, v] of Object.entries(data.checks || {})) if (Number(n) >= 1 && Number(n) <= pack.length) checks[String(p * PACK_SIZE + Number(n))] = v;
      } catch {
        failedPacks++;
      }
    }
    // «другой вид товара» — только если так ответили по всем пачкам, где был ответ
    if (kinds.length) answer = { kind: kinds.every((k) => k === false) ? false : true, checks };
    // Нейросеть не ответила на часть пачек или ни на одну (нет оплаты, сбой, отказ модерации) — на эти требования
    // отвечают правила (offers/rule-check.js), а не остаются «не проверено»
    if (failedPacks) {
      const byRules = require('./rule-check').ruleAnswers(chars, offer);
      answer = answer || { kind: true, checks: {} };
      for (const [n, v] of Object.entries(byRules)) if (answer.checks[n] == null) answer.checks[n] = v;
      answer.byRules = true;
    }
  }
  // Нейросети нет или она не ответила ни на одну пачку — ответы по требованиям дают правила (offers/rule-check.js):
  // «да: <как на странице>» / «?»; judge() ниже проверяет их по тексту страницы так же, как ответы нейросети.
  if (!answer && chars.length) answer = { kind: true, checks: require('./rule-check').ruleAnswers(chars, offer), byRules: true };
  if (answer) {
    const j = judge(chars, answer.checks, nums, text);
    // Таблица характеристик по словарю синонимов (RAM — оперативная память, Wired — проводная): без нейросети
    applySpecs(j.rows, offer.specs, offer.title, { fitsNumeric }, offer.text);
    // процессор ноутбука/компьютера по справочнику: ядра, потоки, кэш L3, тепловыделение, частоты
    applyCpu(j.rows, offer.title, offer.text, { fitsNumeric });
    fixFalseNo(j.rows);
    // для каких устройств: по списку совместимости (паспорт производителя, таблица продавца) и названию товара
    applyCompat(j.rows, offer.specs, offer.title, offer.text);
    // нейросеть ответила на часть пачек — на остальные «повторите»; не ответила вовсе (нет оплаты) — сверяли правила
    const partly = failedPacks && Object.keys(answer.checks || {}).length > 0 && failedPacks * PACK_SIZE < chars.length;
    if (partly) for (const r of j.rows) if (r.verdict === 'unknown' && !r.found) r.found = 'не проверено: нейросеть не ответила на часть требований — повторите сверку';
    if (answer.byRules) for (const r of j.rows) if (r.verdict === 'unknown' && !r.found) r.found = 'не проверено: на странице товара и в своей базе это не указано — уточните у поставщика';
    // Признак подтверждён синонимом («монохромный» при «Черно-Белая» в ТЗ) — требование о нём засчитано.
    for (const a of traits.agreed) {
      const row = j.rows.find((r) => r.name === a.name);
      if (row && row.verdict !== 'yes') { row.verdict = 'yes'; row.found = a.found; row.method = 'признак со страницы'; }
    }
    // Правила по видам оборудования: «до 64 ГБ», USB-C без видео, комбинированный аудиоразъём, PoE и т. п. —
    // ложное «да» понижается до «не подтверждено», явное «нет» на странице — «не подходит», и то и другое — «противоречие».
    applyRules(j.rows, text, { title: offer.title, itemName: item.name });
    for (const v of ['yes', 'no', 'unknown', 'conflict']) j[{ yes: 'confirmed', no: 'failed', unknown: 'unknown', conflict: 'conflict' }[v]] = j.rows.filter((r) => r.verdict === v).length;
    // «Другой вид товара» принимаем, когда почти ничего не подтвердилось; если подтверждений много, нейросеть так
    // назвала «не подходит» (цветное МФУ вместо чёрно-белого) — тогда причину покажут сами требования.
    if (answer.kind === false && j.confirmed < 3) return { match: 'не соответствует', notes: ['на странице другой вид товара, не тот, что в ТЗ'] };
    const checks = { total: j.total, confirmed: j.confirmed, failed: j.failed, unknown: j.unknown, conflict: j.conflict, of: all.length, rows: j.rows, ...(incomplete ? { spec_incomplete: true } : {}), ...(failedPacks ? { packs_failed: failedPacks } : {}) };
    const conflicts = j.rows.filter((r) => r.verdict === 'conflict');
    const bad = j.rows.filter((r) => r.verdict === 'no');
    const missing = j.rows.filter((r) => r.verdict === 'unknown').map((r) => (r.found ? `${r.name} (${r.found.replace(/^на странице нет: /, 'нет ')})` : r.name));
    const good = j.rows.filter((r) => r.verdict === 'yes').map((r) => (r.found ? `${r.name} — ${r.found}` : r.name));
    const summary = `Сверено с ТЗ: подтверждено ${j.confirmed} из ${j.total} требований, противоречий ${bad.length || 'нет'}${all.length > chars.length ? ` (проверены первые ${chars.length} из ${all.length})` : ''}`;
    if (!bad.length && answer.kind === false) return { match: 'не соответствует', checks, notes: ['на странице другой вид товара, не тот, что в ТЗ', summary] };
    if (bad.length) {
      return { match: 'не соответствует', checks, notes: [...bad.slice(0, 4).map((r) => `Не подходит: ${r.name} — нужно «${r.need}», у товара «${r.found}»`), summary].slice(0, 8) };
    }
    const notes = [summary, incomplete, conflicts.length ? `Противоречие на странице: ${short(conflicts.map((r) => `${r.name} — ${r.found}`), 3)} — уточните у поставщика` : null, missing.length ? `На странице не указано: ${short(missing, 6)} — уточните у поставщика` : null, good.length ? `Подходит: ${short(good, 6)}` : null].filter(Boolean);
    const share = j.total ? j.confirmed / j.total : 0;
    // «Соответствует» — только когда подтверждено каждое требование. Совпавшая модель из ТЗ остальные требования
    // не заменяет, а если требований больше, чем сверяется за раз, непроверенный остаток — тоже не подтверждение.
    if (j.confirmed === all.length && j.unknown === 0 && !conflicts.length && !incomplete) return { match: 'соответствует', checks, notes };
    if (share >= partShare || j.confirmed >= 3) return { match: 'частично', checks, notes };
    return { match: 'не хватает данных', checks, notes };
  }
  if (!chars.length) return { match: 'не хватает данных', notes: ['в ТЗ нет характеристик для сверки'] };
  // Без нейросети подтвердить можно только числа: «соответствует» — лишь когда все требования числовые и все подошли.
  if (nums.ok.length === all.length && !nums.unknown.length) {
    // те же правила и для чисел: «до 64 ГБ» на странице — не установленные 64 ГБ
    const rows = all.map((c) => ({ name: c.name, need: String(c.value), verdict: 'yes', found: /у товара (.+?) — подходит$/.exec(nums.ok.find((n) => n.startsWith(`${c.name}:`)) || '')?.[1] || '' }));
    const changed = applyRules(rows, text, { title: offer.title, itemName: item.name });
    if (!changed.length && !incomplete) return { match: 'соответствует', notes: [det.reason, ...nums.ok].filter(Boolean).slice(0, 8) };
    return { match: rows.some((r) => r.verdict === 'no') ? 'не соответствует' : 'не хватает данных', notes: [incomplete, ...changed.map((c) => `${c.row.name}: ${c.row.found}`), ...nums.ok].filter(Boolean).slice(0, 8) };
  }
  return { match: 'не хватает данных', notes: [...nums.ok, ...nums.unknown.map((n) => `не найдено в описании: ${n}`)].slice(0, 8) };
}

module.exports = {
  kindMismatch,
  priceBelowContracts, categoryPage, componentOnly, matchOffer, fixFalseNo, applyCompat, packText, PACK_SIZE, checkNumbers, parseRequirement, judge, fitsNumeric, missingFromList, otherKind, listOnPage, SUPPLY_TERMS, MATCH_ORDER };
