// Спецификация товара из ТЗ и проверка «тот же ли это товар».
// Спецификация: {name, quantity, unit, pack_qty, equivalent_allowed, identity: {model, brand, compatible_with, standard},
//   required: [{name, value, unit, comparator, source?: {file, page, quote, verified}}]}.
// Нет разобранного ТЗ — спецификация строится из характеристик извещения (КТРУ).

const { parseRequirement, checkNumbers, SUPPLY_TERMS } = require('./match');
const { modelOf } = require('./sources/yandex-search');

// Латинские буквы-двойники → кириллица: «A4» и «А4», «C» и «С» сравниваются одинаково.
const LOOKALIKE = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в', y: 'у' };
const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');
const normLook = (s) => norm(s).replace(/[aeopcxkmthby]/g, (ch) => LOOKALIKE[ch]);
const compact = (s) => norm(s).replace(/[\s\-_./]+/g, '');
const num = (s) => Number(String(s).replace(',', '.'));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Слова, которые есть почти в любом наименовании и не отличают один товар от другого.
const GENERIC = new Set(['поставка', 'товар', 'товары', 'для', 'нужд', 'изделие', 'изделия', 'прочие', 'прочий', 'прочая', 'прочее',
  'расходный', 'расходные', 'материал', 'материалы', 'принадлежности', 'средство', 'средства', 'набор', 'комплект']);

/** Спецификация позиции: из ТЗ, если разобрано, иначе из характеристик извещения. */
function specOf(item) {
  const fromNotice = (item.characteristics || []).map((c) => ({ name: c.name, value: cleanTail(c.value), unit: unitOfValue(c.value), comparator: comparatorOf(c.value) }));
  if (item.spec?.required) {
    // ТЗ дополняет извещение: характеристики КТРУ из извещения, которых нет в ТЗ, тоже обязательны.
    const have = new Set(item.spec.required.map((r) => normLook(r.name)));
    // Таблица ТЗ со столбцом условия («Скорость записи | не менее | 400») читается как голое «400» — точное значение,
    // и товар с 450 «не подходит». В извещении у той же характеристики условие есть («не менее 400 Мбайт/с»):
    // голое число ТЗ берёт его, если число то же и название то же или с общим словом («Ресурс на запись DWPD»).
    const used = new Set();
    const withOperator = (r) => {
      const v = cleanTail(r.value);
      if (!/^\s*\d+(?:[.,]\d+)?\s*[a-zа-яё/%]*\s*$/i.test(v)) return null;
      const n = num(v.match(/\d+(?:[.,]\d+)?/)[0]);
      // условие прочитано, но хранится отдельно от числа («400», «>=»): без него число сверяется как точное
      const word = { '>=': 'не менее', '>': 'более', '<=': 'не более', '<': 'менее' }[r.comparator];
      const words = (s) => new Set(normLook(s).split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 4));
      const mine = words(r.name);
      const hit = fromNotice.find((c, i) => !used.has(i) && c.comparator && c.comparator !== '='
        && (parseRequirement(c.value)?.min === n || parseRequirement(c.value)?.max === n)
        && (normLook(c.name) === normLook(r.name) || [...words(c.name)].some((w) => mine.has(w))) && used.add(i));
      if (hit) return { ...r, value: hit.value, comparator: hit.comparator, unit: r.unit || hit.unit };
      // Ресурс, срок службы и гарантии голым числом — всегда нижняя граница: «Ресурс: 10000» — картридж на 10 400 страниц
      // подходит, а не «не соответствует» (так отклонялись все картриджи повышенной ёмкости)
      const atLeast = !word && (!r.comparator || r.comparator === '=') && /ресурс|срок\S*\s+служб|гарант/i.test(r.name) ? 'не менее' : null;
      const op = word || atLeast;
      return op ? { ...r, value: `${op} ${v.trim()}`, unit: /^[хx×–—-]$/i.test(String(r.unit || '').trim()) ? null : r.unit } : null;
    };
    const tz = item.spec.required.map((r) => withOperator(r) || { ...r, value: cleanTail(r.value), unit: /^[хx×–—-]$/i.test(String(r.unit || '').trim()) ? null : r.unit });
    const id = cleanIdentity(item.spec.identity);
    return {
      ...item.spec,
      code: item.ktru_code || item.okpd2_code || null,
      identity: deviceNotModel(item, { ...id, compatible_with: cleanTail(id.compatible_with) || null, model: cleanValue(item.spec.identity?.model) || modelOf(item) || null }),
      required: [...tz, ...fromNotice.filter((r, i) => !used.has(i) && !have.has(normLook(r.name)) && !/модел|артикул/i.test(r.name))],
    };
  }
  const required = fromNotice;
  const model = modelOf(item);
  return {
    name: item.name, quantity: item.quantity, unit: item.unit, pack_qty: null, equivalent_allowed: null, code: item.ktru_code || item.okpd2_code || null,
    identity: deviceNotModel(item, { model: model || null, brand: null, compatible_with: null, standard: null }), required, from: 'notification',
  };
}

// Пометка из соседнего столбца таблицы ТЗ, прилипшая к значению: «Лазерная х», «≥ 5900 х», «Canon MF752Cdw х».
// Из-за неё сверка не находила совпадений, а запросы к поиску были «… Cdw х 5900 х Лазерная х купить».
const cleanTail = (v) => (v == null ? v : String(v).replace(/(?:\s+[хx×–—-])+\s*$/i, '').trim());
// Нейросеть иногда пишет в пустое поле строку «undefined» или «null» — по ней искали товар «UNDEFINED».
const cleanValue = (v) => (v == null || /^\s*(undefined|null|none|нет|не указан\S*|-)?\s*$/i.test(String(v)) ? null : v);
const cleanIdentity = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, cleanValue(v)]));

/**
 * У расходника (картридж, тонер, фотобарабан) в ТЗ часто стоит модель принтера, для которого он нужен:
 * «Картридж … совместимость: Катюша М240». Это не модель самого картриджа — её переносим в «совместимость»,
 * иначе картридж TK240A отклонялся как «другая модель».
 */
function deviceNotModel(item, identity) {
  const model = identity.model;
  if (!model || !CONSUMABLE.test(item.name || '')) return identity;
  const squash = (s) => normLook(String(s || '')).replace(/[\s\-_./]+/g, '');
  const compat = (item.characteristics || []).find((c) => /совмест|для\s+устройств|модел\S*\s+(принтер|устройств|мфу)/i.test(c.name) && squash(c.value).includes(squash(model)));
  if (!compat) return identity;
  return { ...identity, model: null, compatible_with: identity.compatible_with || compat.value };
}
const CONSUMABLE = /картридж|тонер|фотобарабан|драм|чернил|барабан|девелопер|фотопроводник/i;

/**
 * Известно ли, что именно искать: модель или хотя бы одна характеристика (из ТЗ или извещения).
 * Одно наименование («Моноблоки», название раздела ОКПД2) — мало: найденный товар нельзя сверить с ТЗ,
 * платные запросы к поисковику уйдут впустую. Сначала нужна документация.
 */
function isSearchable(item) {
  const spec = specOf(item);
  return Boolean(spec.identity?.model) || (spec.required || []).length > 0;
}

/** Единица в конце значения: «не менее 80 г/м2» → «г/м2», «500 шт» → «шт». */
function unitOfValue(v) {
  const m = String(v || '').match(/\d[\d.,\s]*\s*([a-zа-яё%"″°]+\.?(?:\s*\/\s*[a-zа-яё]+)?[23²³]?)\s*$/i);
  return m ? m[1].trim() : null;
}

function comparatorOf(v) {
  const s = norm(v);
  const lo = /не менее|не ниже|(?<![а-яё])от\s*\d|≥|>=|(?<!не )более/.test(s);
  const hi = /не более|не выше|(?<![а-яё])до\s*\d|≤|<=|(?<!не )менее/.test(s);
  if (lo && hi) return 'range';
  if (lo) return '>=';
  if (hi) return '<=';
  if (/;|(?<![а-яё])или(?![а-яё])/.test(s)) return 'one_of';
  return '=';
}

/** Основные слова наименования (без «поставка», «для нужд» …) — основы по 5 букв. */
function nameStems(name) {
  // Короткие слова режем до 4 букв: «ручки» и «ручка» — одно слово.
  return (norm(name).match(/[а-яa-z]{3,}/g) || []).filter((w) => !GENERIC.has(w)).map((w) => w.slice(0, w.length <= 5 ? 4 : 5));
}

/**
 * Значение требования — в слова для поиска: «не менее 80 и не более 90 г/м2» → «80 г/м2», «≥ 50000» без единицы → null
 * (голое число поисковику ничего не говорит), «белая» → «белая».
 */
// Характеристики, у которых словесное значение описывает сам товар («лазерная», «А4», «чёрный»), а не подробность
// вроде «Блок питания: встроенный». Только такие словесные значения идут в поисковый запрос.
const TYPE_NAME = /формат|цвет|технолог|интерфейс|стандарт|разъ[её]м|форм-?фактор|^\s*тип\s*$|тип (накопител|печат|матриц|устройств|подключ|памят|экран|диск|носител|корпус|процессор|бумаг|картридж|кабел|ламп|товар|издели)|^\s*вид\b|материал|назначени|совместим|производител|бренд|марка|серия|класс/i;
// Счётные единицы: «1 шт», «50 лист» без названия характеристики поисковику ничего не говорят.
const COUNT_UNIT = /^(шт|штук|ед|единиц|лист|компл|упак|пар[аы]?$|рулон|экз)/i;

/** Объём — как его пишут магазины: «8000 Гбайт» → «8 ТБ», «256 Мбайт» → «256 МБ», «1024 Мб» → «1 ГБ». */
function shopUnits(number, unit) {
  const n = Number(String(number).replace(',', '.'));
  const u = String(unit).toLowerCase();
  const steps = ['МБ', 'ГБ', 'ТБ'];
  let at = /^(мбайт|мегабайт|мб|mb)\.?$/.test(u) ? 0 : /^(гбайт|гигабайт|гб|gb)\.?$/.test(u) ? 1 : /^(тбайт|терабайт|тб|tb)\.?$/.test(u) ? 2 : -1;
  if (at < 0 || !Number.isFinite(n)) return `${number} ${unit}`;
  let v = n;
  while (at < 2 && v >= 1000 && (v % 1000 === 0 || v % 1024 === 0)) { v = v % 1024 === 0 ? v / 1024 : v / 1000; at++; }
  return `${String(v).replace('.', ',')} ${steps[at]}`;
}

function searchValue(r) {
  // Пояснения в скобках — «А4 (210х297 мм)» — в запросе только мешают.
  const raw = String(r.value || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  // Требование записано названием: «Гель высокой вязкости: соответствие», «Двойная резинка: Да» — признак товара в
  // самом названии требования, его и ищем (25.10: без «высокой вязкости» поиск принёс гель средней вязкости и троксерутин).
  // «Наличие …», «Количество …», «Тип …» — не признак, а заголовок; длинные формулировки — тоже нет.
  if (/^(да|соответствие|наличие|есть|имеется)$/i.test(raw)) {
    const name = String(r.name || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const words = name.split(' ');
    if (words.length >= 2 && words.length <= 4 && !/\d/.test(name) && !/^(наличие|количество|возможность|тип|вид|способ|функция|поддержка|соответствие)/i.test(name)) return name.toLowerCase();
    return null;
  }
  if (!raw || /^(нет|отсутствие|не требуется|не предусмотрен[оа]?|отсутствует)$/i.test(raw)) return null;
  const cleaned = raw.replace(/или эквивалент\S*/gi, '').replace(/(не менее|не более|не ниже|не выше|более|менее|≥|≤|>=|<=|±|\+\/-)/gi, ' ').replace(/\s+/g, ' ').trim();
  // Диагональ задана диапазоном («не менее 85 и менее 90 дюйм») — ищем ходовой размер из него: «86 дюймов».
  if (/диагонал/i.test(r.name || '')) {
    const req = parseRequirement(raw);
    const size = req && COMMON_DIAGONALS.find((d) => (req.min == null || (req.minStrict ? d > req.min : d >= req.min)) && (req.max == null || (req.maxStrict ? d < req.max : d <= req.max)));
    if (size) return `${String(size).replace('.', ',')} дюймов`;
  }
  // Короткий текст с цифрами без чисел-требований («А4», «DDR4») — как есть.
  if (/^[a-zа-яё]+\d+[a-zа-яё]*$/i.test(cleaned)) return cleaned;
  const first = cleaned.match(/(?<![\d.,])\d+(?:[.,]\d+)?/);
  if (first) {
    // Число — первое (нижняя граница), единица — в конце значения: «80 и 90 г/м2» → «80 г/м2».
    const tail = cleaned.replace(/[\d.,\s\-–]+(и|до|от)?\s*/gi, ' ').trim();
    const unit = unitOfValue(cleaned) || (r.unit && !/^шт/i.test(r.unit) ? r.unit : null);
    // Время (прогрев, выход первой страницы, гарантия) товар в поиске не отличает — пропускаем.
    if (/^(мс|ms|сек|секунд|мин|минут|час|сут|дн|день|дней|мес|месяц|год|лет)/i.test(unit || '')) return null;
    // Разрешение в пикселях, яркость, контрастность — в магазинах по ним товар не ищут, запрос они только сбивают.
    if (/^(пиксел|пикс|px|кд|нит|nit|cd)/i.test(unit || '')) return null;
    // Количество в штуках: понятно только вместе с тем, чего именно («24 порта», «6 ядер», «500 листов»); остальное — в запрос не идёт.
    if (COUNT_UNIT.test(unit || '')) {
      const what = /порт/i.test(r.name || '') ? 'портов' : /яд(ер|ра)/i.test(r.name || '') ? 'ядер' : /лист/i.test(r.name || '') ? 'листов' : null;
      return what ? `${first[0]} ${what}` : null;
    }
    if (unit && !/^(и|до|от|или)$/i.test(unit)) return shopUnits(first[0], unit);
    return tail && tail.length <= 20 && /[a-zа-яё]{2,}/i.test(tail) ? `${first[0]} ${tail}` : null; // голое число поисковику не поможет
  }
  if (cleaned.length > 25) return null;
  // Латиница и обозначения («SATA III», «HDD», «Wi-Fi») — всегда признак товара; русское слово — только если
  // характеристика называет тип товара, а не подробность его устройства.
  if (/[a-z]/i.test(cleaned)) return cleaned;
  return TYPE_NAME.test(r.name || '') ? cleaned : null;
}

/** Отличительные требования для поиска: числа с единицей и короткие значения, от более редких к общим. */
const KEY_SPEC = /диагонал|объ[её]м|[её]мкост|мощност|типоразмер|количество портов|число портов|кол-во портов/i;
// Ходовые диагонали экранов, дюймы: по «86 дюймов» магазины находятся, по «85 дюймов» — нет.
const COMMON_DIAGONALS = [10.1, 11.6, 13.3, 14, 15.6, 16, 17.3, 18.5, 19.5, 21.5, 23.8, 24, 27, 31.5, 32, 34, 43, 50, 55, 65, 75, 86, 98, 100, 110];


function distinctiveTerms(spec, max = 3) {
  const out = [];
  const seen = new Set();
  for (const r of spec.required || []) {
    const v = searchValue(r);
    // «A4» латиницей и «А4» кириллицей — одно и то же значение.
    const key = v ? normLook(v).replace(/\s+/g, '') : '';
    if (!v || seen.has(key)) continue;
    seen.add(key);
    // Главные признаки товара (диагональ, объём, мощность, формат…) — вперёд: по ним магазины и раскладывают товары.
    // Иначе в запрос попадает «2100 пиксель 500 кд/м2», а панель нужного размера не находится.
    const score = (/\d/.test(v) ? 2 : 0) + (/\d\s*\S/.test(v) && /[a-zа-яё%]/i.test(v) ? 1 : 0) + (/[a-z]/i.test(v) ? 1 : 0)
      + (KEY_SPEC.test(r.name || '') ? 4 : 0);
    out.push({ v, score, key: KEY_SPEC.test(r.name || '') });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, max).map((x) => x.v);
}

/** Наименование для поиска: без номера позиции в начале, «или эквивалент», скобок с пояснениями и кавычек. */
function searchName(name) {
  return String(name || '')
    .replace(/^\s*(№\s*)?\d{1,3}(?:[.)]|["″]|'')?\s+(?=[A-Za-zА-ЯЁа-яё])/, '') // «27 Ноутбук», «18" Ноутбук»
    .replace(/или эквивалент\S*/gi, '')
    // «Накопитель данных внутренний КТРУ 26.20.21.110-00000003 код ОКПД2 26.20.21.110» — коды поисковику не нужны
    .replace(/[,;(]?\s*(?:код\s+)?(?:по\s+)?(?:КТРУ|ОКПД\s*-?\s*2?|ОКПД2)\s*[:№-]?\s*\d{2}(?:\.\d{1,3}){1,3}(?:-\d{3,8})?\)?/gi, ' ')
    .replace(/(?<![\d.])\d{2}\.\d{2}\.\d{2}\.\d{3}(?:-\d{3,8})?(?![\d.])/g, ' ')
    .replace(/[«»"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Безликое наименование позиции («Позиция номер 1», «Товар 2», «Лот №3») — искать по нему бесполезно,
 * берём предмет закупки: «Поставка накопителей SSD для модернизации рабочих мест» → «накопителей SSD».
 */
function isGenericName(name) {
  const s = String(name || '');
  if (/^\s*(позиция|товар|лот|наименование|предмет)\s*(номер|№|n)?\s*\d*\s*$/i.test(s)) return true;
  // Название раздела ОКПД2 вместо товара: «Аппаратура коммуникационная, …; телевизионные камеры», «Оборудование офисное и его части».
  return /;|:\s|не включенн|и (его|их) части|прочи[ея] \S+$/i.test(s) || (s.match(/,/g) || []).length >= 3;
}
function subjectOfTitle(title) {
  return searchName(String(title || '')
    .replace(/^[\s\dА-ЯA-Z№.\-/()]*?(?=[А-ЯЁ][а-яё])/, '') // номер закупки в начале: «260490 Поставка…», «ЭА-№-16644/26 «Поставка…»
    .replace(/^.*?(поставк[аиу]|приобретени[ея]|закупк[аи])\s+(\(поставк[аи]\)\s*)?(с доставкой\s+)?/i, '')
    .replace(/\s*\((лот|позиция)[^)]*\)/gi, '')
    .replace(/\s+(для\s+(нужд|обеспечения|модернизации|оснащения|организации)|в целях|на нужды|нужд|в рамках|в количестве)(\s.*)?$/i, ''));
}
/** Что подставлять в поисковый запрос вместо наименования позиции. */
function itemSearchName(name, title) {
  const own = isGenericName(name) && title ? subjectOfTitle(title) || searchName(name) : searchName(name);
  // «Многофункциональное устройство (МФУ)», «Источник бесперебойного питания (ИБП)» — в магазинах пишут сокращение.
  const abbr = /^[^()]{10,}\(\s*([А-ЯЁA-Z]{2,5})\s*\)\s*$/.exec(own)?.[1];
  return abbr || own;
}

/**
 * Конкретный вид товара из характеристик, когда наименование КТРУ общее: «Рыба трескообразная мороженая» +
 * «Вид рыбы: Минтай» → «минтай мороженая». Без этого поиск по 25.10 приносил треску, и сверка с ТЗ (минтай)
 * отсеивала все предложения. Вид — одно-три слова без цифр; «не ниже…», «любой», «иной» — не вид.
 * @param {string} name наименование для поиска
 * @param {Array<{name, value}>} chars характеристики позиции и требования спецификации
 */
function withSpecies(name, chars = []) {
  const c = chars.find((x) => /^\s*(вид|порода)\s+(рыб|мяс|птиц|овощ|фрукт|ягод|круп|мук|сыр|колбас|хлеб|молочн|кофе|ча[яй]|древесин)/i.test(String(x?.name || ''))
    && /^[а-яё][а-яё -]{2,39}$/i.test(String(x.value || '').trim()) && String(x.value).trim().split(/\s+/).length <= 3
    && !/^(не |без|любо|ино|друг|по )/i.test(String(x.value).trim()));
  if (!c) return name;
  const sp = String(c.value).trim().toLowerCase();
  if (normLook(name).includes(normLook(sp))) return name;
  // общее слово вида («рыба», «мясо») и «…образная» из названия — убираем: их заменяет конкретный вид
  const rest = String(name || '').replace(/^\s*[а-яё]+\s+(?:[а-яё]*образн[а-яё]*\s+)?/i, '');
  return `${sp} ${rest}`.replace(/\s+/g, ' ').trim();
}

// Кириллические буквы, неотличимые от латинских: в моделях их набирают вперемешку («М348», «СЕ743А»).
const CYR_TO_LAT = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y' };

/**
 * Модель, набранная русскими буквами-двойниками, → латиницей: «МФУ Катюша М348» → «…M348», «СЕ743А» → «CE743A».
 * Трогаем только «слова» из заглавных букв-двойников и цифр (обычные русские слова остаются как есть).
 */
function latinizeModels(text) {
  return String(text || '').replace(/(?<![A-Za-zА-Яа-яЁё0-9-])(?=[A-ZАВЕКМНОРСТХУ0-9-]*\d)(?=[A-ZАВЕКМНОРСТХУ0-9-]*[АВЕКМНОРСТХУ])[A-ZАВЕКМНОРСТХУ0-9][A-ZАВЕКМНОРСТХУ0-9-]{2,}(?![A-Za-zА-Яа-яЁё0-9-])/g,
    (tok) => tok.replace(/[АВЕКМНОРСТХУ]/g, (ch) => CYR_TO_LAT[ch]));
}

/** Модели-артикулы в тексте (латиница с цифрами): TK-5240K, CE285A, SC-4830. */
function modelTokens(text) {
  return [...latinizeModels(text).matchAll(/(?<![A-Za-z0-9-])(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]{2,}(?![A-Za-z0-9-])/g)]
    .map((m) => m[0]).filter((t) => !/^[A-Za-z]\d$/.test(t) && !/^\d+[a-z]{1,3}$/i.test(t));
}

/** Числовые требования с единицей: «плотность не менее 80 г/м2» → ищем «NN г/м2» в описании товара. */
function checkUnits(required, text) {
  const out = { ok: [], fail: [] };
  for (const r of required || []) {
    const req = parseRequirement(r.value);
    const unit = r.unit || unitOfValue(r.value);
    if (!req || !unit || unit.length > 12) continue;
    // Гарантия и другие условия поставки: «10 месяцев» на странице магазина — это и рассрочка, и срок доставки, и
    // «нет в наличии более 6 месяцев»; к требованию «гарантия не менее 12 месяцев» такое число не привязать.
    if (SUPPLY_TERMS.test(r.name)) continue;
    // Штуки на странице — это и количество в корзине, и «1 шт. в упаковке»: к требованию «не менее 20000 шт.» их не привязать.
    if (/^(шт|штук|ед|единиц|компл|упак|пар|экз|раз)[а-яё]*\.?$/i.test(unit)) continue;
    // «Максимальная/базовая частота» — чисел на странице несколько, какое к чему — решает checkNumbers.
    if (/максим|турбо|базов|минимал/i.test(r.name)) continue;
    // Дюймы на страницах магазинов пишут по-разному: «86 дюймов», «86"», «86″», «86 inch».
    const inches = /^дюйм/i.test(unit);
    const unitRe = inches ? '(?:дюйм[а-яё]*|"|″|\'\'|inch(?:es)?)' : unit.split('/').map((p) => esc(p.trim())).join('\\s*\\/\\s*');
    const re = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${unitRe}${inches ? '' : '(?![a-zа-яё])'}`, 'gi');
    const values = [...String(text).matchAll(re)].map((m) => num(m[1])).filter((x) => Number.isFinite(x));
    // Габариты тройкой: «600×600×900 мм», «1000х600х900мм» — единица стоит только после последнего числа, и раньше
    // сверка видела одно 900, а глубину 600 «не находила»
    if (!inches) {
      const dims = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*[xх×*]\\s*(\\d+(?:[.,]\\d+)?)(?:\\s*[xх×*]\\s*(\\d+(?:[.,]\\d+)?))?\\s*${unitRe}(?![a-zа-яё])`, 'gi');
      for (const m of String(text).matchAll(dims)) values.push(...[m[1], m[2], m[3]].filter(Boolean).map(num));
    }
    if (!values.length) continue;
    const fits = (x) => (req.min == null || (req.minStrict ? x > req.min : x >= req.min)) && (req.max == null || (req.maxStrict ? x < req.max : x <= req.max));
    if (values.some(fits)) out.ok.push(`${r.name}: ${r.value}`);
    else out.fail.push(`${r.name}: нужно ${r.value}, у товара ${values[0]} ${unit}`);
  }
  return out;
}

/**
 * Детерминированно: тот же товар, что в ТЗ?
 * @param spec спецификация позиции (specOf)
 * @param candidate текст кандидата: наименование товара из контракта или заголовок + описание со страницы
 * @returns {{verdict: 'same'|'different'|'unknown', reason: string, confirmed: string[]}}
 */
/**
 * Варианты записи одной и той же модели. Коды картриджей HP заказчики часто сокращают: «CF83A» вместо «CF283A»,
 * «CE85A» вместо «CE285A» (в магазинах — полный код и «№83A»). Сравниваем в обе стороны.
 */
function modelAliases(model) {
  const m = compact(model);
  const out = [m];
  const short = /^(c[a-z])(\d{2})([a-z]{1,2})$/.exec(m);
  if (short) out.push(`${short[1]}2${short[2]}${short[3]}`);
  const full = /^(c[a-z])2(\d{2})([a-z]{1,2})$/.exec(m);
  if (full) out.push(`${full[1]}${full[2]}${full[3]}`);
  return out;
}

// Разделы ОКПД2/КТРУ с техникой: 26 — компьютеры и электроника, 27 — электрооборудование, 28 — машины, 29–30 — транспорт.
const TECH_CODE = /^(26|27|28|29|30)\./;

// Расходники: заказчик пишет «оригинал» или «не оригинал / совместимый» — это разные товары с разницей в цене в 5–10 раз.
const WANTS_ORIGINAL = (s) => /(^|[^а-яё])оригинал/i.test(s) && !/не\s*оригинал|неоригинал|совместим|аналог|эквивалент/i.test(s);
// Признаки совместимого картриджа в названии товара: слова и марки производителей совместимых расходников.
const COMPATIBLE = /совместим|неоригинал|не\s+оригинал|аналог|compatible|булат|sakura|cactus|nv\s?print|netproduct|galaprint|superfine|easyprint|hi-?black|profiline|blossom|uniton|colortek|sonnen|static\s?control|katun|(^|[^a-zа-яё0-9])(atm|атм|7q|oem|g&g|gg|sp|elp|mak)([^a-zа-яё0-9]|$)/i;

function sameProductDet(spec, candidate) {
  const text = String(candidate || '');
  const wantsOriginal = WANTS_ORIGINAL(`${spec.name || ''} ${(spec.required || []).map((r) => `${r.name} ${r.value}`).join(' ')}`);
  if (wantsOriginal && COMPATIBLE.test(text.slice(0, 300))) {
    return { verdict: 'different', reason: 'в закупке нужен оригинал, а это совместимый (не оригинальный) товар', confirmed: [] };
  }
  const t = compact(text);
  const model = spec.identity?.model;
  const aliases = model ? modelAliases(model) : [];
  // Сравниваем без различия двойников: «M348» в ТЗ и «М348» на странице магазина — одна модель.
  const tLook = normLook(t);
  if (model && aliases.some((a) => tLook.includes(normLook(a)))) return { verdict: 'same', reason: `совпадает модель ${model}`, confirmed: [`модель ${model}`] };
  if (model) {
    const others = modelTokens(text).filter((m) => !aliases.includes(compact(m)));
    if (others.length && !spec.equivalent_allowed) return { verdict: 'different', reason: `в ТЗ модель ${model}, у товара ${others[0]}`, confirmed: [] };
    // В ТЗ нужна конкретная модель, а в наименовании товара её нет — подтвердить нельзя, «тем же» не считаем.
    return { verdict: 'unknown', reason: `в ТЗ модель ${model}, а в наименовании товара модель не указана`, confirmed: [] };
  }
  // В контрактах ЕИС товар назван по каталогу + «Товарный знак: …» — сверяем производителя, если ТЗ его требует.
  const tm = text.match(/товарный знак\s*:\s*([^.;,(]+)/i)?.[1]?.trim();
  if (spec.identity?.brand && tm && !/отсутств|без товарного/i.test(tm) && !spec.equivalent_allowed
    && !normLook(tm).includes(normLook(spec.identity.brand)) && !normLook(spec.identity.brand).includes(normLook(tm))) {
    return { verdict: 'different', reason: `в ТЗ производитель ${spec.identity.brand}, в контракте — ${tm}`, confirmed: [] };
  }
  const nums = checkNumbers((spec.required || []).map((r) => ({ name: r.name, value: r.value })), text);
  const units = checkUnits(spec.required, text);
  const fails = [...nums.fail, ...units.fail];
  if (fails.length) return { verdict: 'different', reason: fails[0], confirmed: [] };

  const tn = normLook(text);
  // Короткие точные значения: «А4», «чёрный»; формат бумаги другого номера — явно другой товар.
  const exact = (spec.required || []).filter((r) => r.comparator === '=' && !parseRequirement(r.value) && String(r.value).length <= 20
    && !/^(да|нет|наличие|соответствие)$/i.test(r.value));
  for (const r of exact) {
    const f = normLook(r.value).match(/^[ав]\d$/);
    const other = f && tn.match(/(?<![а-яa-z0-9])[ав]\d(?![0-9])/g)?.find((x) => x !== f[0]);
    if (other && !tn.includes(f[0])) return { verdict: 'different', reason: `${r.name}: нужно ${r.value}, у товара ${other.toUpperCase()}`, confirmed: [] };
  }
  const exactHit = exact.filter((r) => tn.includes(normLook(r.value))).map((r) => `${r.name}: ${r.value}`);
  const confirmed = [...nums.ok.map((x) => x.split(':')[0]), ...units.ok, ...exactHit];

  const stems = nameStems(spec.name);
  const main = stems[0] && normLook(stems[0]);
  if (main && !tn.includes(main)) return { verdict: 'unknown', reason: `в названии нет слова «${String(spec.name).split(/\s+/)[0]}»`, confirmed };
  const need = (spec.required || []).length;
  if (need && confirmed.length >= Math.min(need, 2)) return { verdict: 'same', reason: `подтверждено требований ТЗ: ${confirmed.length} из ${need}`, confirmed };
  if (!need && stems.length && stems.every((x) => tn.includes(normLook(x)))) {
    // Техника (компьютеры, электроника, оборудование): под одним словом «Сервер» или «Моноблоки» — товары с разницей в цене
    // в разы, наименования мало. Простые товары (ручки, топливо) наименованием описаны достаточно.
    return TECH_CODE.test(String(spec.code || ''))
      ? { verdict: 'unknown', reason: 'совпадает только наименование — для техники нужны модель или характеристики из ТЗ', confirmed }
      : { verdict: 'same', reason: 'совпадает наименование (в ТЗ нет характеристик)', confirmed };
  }
  return { verdict: 'unknown', reason: need ? `подтверждено требований ТЗ: ${confirmed.length} из ${need}` : 'в ТЗ нет характеристик для сверки', confirmed };
}


// Мебель: в ТЗ наименование по каталогу КТРУ («Стеллаж лабораторный»), а настоящий вид — в характеристике «тип/вид»
// («Стеллаж лабораторный (тумба медицинская)») и в размерах. Поиск по названию КТРУ приносил двухметровые стеллажи
// вместо тумбы 1000×600×900 — все честно отсеивались по высоте.
const FURNITURE = /стол|стул|шкаф|тумб|стеллаж|кресл|кроват|скам|верстак|витрин|диван|кушет|полк|банкетк|гардероб|комод|пенал|парт|мебел/i;
function furnitureSearch(spec, name) {
  const req = spec?.required || [];
  const typeReq = req.find((r) => /^(тип|вид|назначение|наименование товара)(?![а-яё])/i.test(String(r.name || '').trim()));
  const typeVal = typeReq ? cleanTail(String(typeReq.value)) : '';
  if (!FURNITURE.test(`${name} ${typeVal}`)) return null;
  // «Стеллаж лабораторный (тумба медицинская)» → «тумба медицинская»; иначе сам «тип», если это короткое название
  const inner = /\(([^()]{3,60})\)/.exec(typeVal)?.[1];
  const real = (inner && FURNITURE.test(inner) ? inner : (typeVal && typeVal.length <= 60 && FURNITURE.test(typeVal) && !/\d{3}/.test(typeVal) ? typeVal : null));
  const dim = (re) => { const r = req.find((x) => re.test(String(x.name || ''))); const p = r ? parseRequirement(String(r.value).replace(/[()]/g, ' ')) : null; return p ? Math.round(p.min ?? p.max) : null; };
  const w = dim(/^(ширина|длина)(?![а-яё])/i); const d = dim(/^глубина(?![а-яё])/i); const h = dim(/^высота(?![а-яё])/i);
  const dims = [w, d, h].filter((x) => x && x >= 100 && x <= 5000);
  return { real: real ? real.replace(/\s+/g, ' ').trim().toLowerCase() : null, dims: dims.length >= 2 ? dims.join('x') : null };
}

module.exports = { latinizeModels, withSpecies, furnitureSearch, modelAliases, isSearchable, specOf, sameProductDet, distinctiveTerms, searchValue, searchName, itemSearchName, isGenericName, nameStems, modelTokens, checkUnits, comparatorOf, unitOfValue, normLook };
