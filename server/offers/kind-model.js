// Виды товара, выученные из самих закупок (этап 1 пакета «автономность», 31.10.2026). Нейросеть не нужна.
// Сырьё — все позиции закупок: название и код КТРУ. Позиции с одним кодом — один вид, разные названия кода — синонимы
// («Комплект для переливания крови» и «Система трансфузионная»). Из этого агент сам знает:
//   • ядро вида — слова, которые есть почти во всех названиях вида;
//   • чужие слова — ядро других видов, которого в этом виде нет.
// Проверка предложения: в названии товара нет ядра вида позиции, зато есть ядро другого вида — это другой товар, сколько
// бы размеров ни совпало («Система инфузионная с иглой 0,8×40» к позиции «Комплект для переливания крови»).
// Объяснение — словами: человек и проверяющий видят, почему. Новые закупки и правки пополняют модель при пересборке.

const STOP = new Set(['для', 'или', 'при', 'под', 'над', 'без', 'из', 'на', 'по', 'от', 'до', 'со', 'не', 'шт', 'мм', 'мл', 'см', 'тип', 'вид',
  'поставка', 'товар', 'изделие', 'изделия', 'медицинский', 'медицинская', 'медицинское', 'медицинские', 'одноразового', 'многоразового', 'использования',
  'применения', 'стерильный', 'стерильная', 'стерильное', 'стерильные', 'нестерильный', 'однократного', 'одноразовый', 'одноразовая', 'купить', 'цена', 'москве', 'россия', 'китай', 'германия']);

// основа слова: окончания русских слов отбрасываются грубо, этого хватает, чтобы сравнивать формы
const stem = (w) => (w.length <= 4 ? w : w.replace(/(ыми|ими|ого|его|ому|ему|ая|яя|ое|ее|ые|ие|ый|ий|ой|ую|юю|ам|ям|ах|ях|ов|ев|ей|ом|ем|ию|ия|ие|ии|а|я|ы|и|у|ю|е|о|ь)$/, '')).slice(0, 8);

/** Смысловые слова: кириллица от 3 букв, без служебных и единиц. */
function tokens(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().replace(/ё/g, 'е').split(/[^а-яa-z]+/)) {
    if (raw.length < 3 || !/[а-я]/.test(raw) || STOP.has(raw)) continue;
    out.add(stem(raw));
  }
  return [...out];
}

/** Назначение: слова после «для» до запятой или скобки («для переливания крови» → переливан, кров). */
function purposeOf(name) {
  const m = /(?:^|[\s(])для\s+([^,;()]+)/i.exec(String(name || ''));
  return m ? tokens(m[1]).slice(0, 3) : [];
}

/** Вид без кода узнаётся по первым трём смысловым словам названия. */
const nameKey = (name) => tokens(name).slice(0, 3).sort().join(' ');
const CORE_SHARE = 0.5; // слово — ядро, если оно есть хотя бы в половине названий вида
const MIN_NAMES = 2;    // вид с одним названием — слишком мало примеров, чтобы судить
const OWN_SHARE = 0.6;  // такая доля слов названия позиции в названии товара — это он, что бы ни думал вид
const FOREIGN_MIN = 3;  // слово — признак другого товара, если оно входит в ядро хотя бы трёх видов

/**
 * @param rows [{name, ktru_code}] — позиции закупок
 * @param examples [{item_name, ktru_code, title, verdict: 'right'|'wrong'}] — чему научили контракты, человек и самопроверка
 */
function buildKindModel(rows, examples = []) {
  const parent = new Map();
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); parent.set(x, r); return r; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a, b) => { add(a); add(b); parent.set(find(a), find(b)); };
  const seen = [];
  for (const r of rows) {
    const key = nameKey(r.name);
    if (!key) continue;
    add(`n:${key}`);
    // код с уточнением (…-00000012) — один вид; синонимы названий склеиваются через код
    const code = String(r.ktru_code || '').trim();
    if (/^\d\d\.\d\d\.\d\d\.\d{3}-\d{5,}/.test(code)) union(`n:${key}`, `k:${code.slice(0, 18)}`);
    seen.push({ key, name: r.name, code: code || null });
  }
  const kinds = new Map();
  for (const s of seen) {
    const id = find(`n:${s.key}`);
    const k = kinds.get(id) || { id, n: 0, words: new Map(), purposes: new Map(), heads: new Map(), names: new Map(), codes: new Set(), label: s.name };
    k.n++;
    k.names.set(s.name, (k.names.get(s.name) || 0) + 1);
    if (s.code) k.codes.add(s.code);
    const head = tokens(s.name)[0];
    if (head) k.heads.set(head, (k.heads.get(head) || 0) + 1);
    for (const t of purposeOf(s.name)) k.purposes.set(t, (k.purposes.get(t) || 0) + 1);
    for (const t of tokens(s.name)) k.words.set(t, (k.words.get(t) || 0) + 1);
    kinds.set(id, k);
  }
  const coreIndex = new Map(); // слово → в ядре скольких видов
  const heads = new Map();     // слово → у скольких видов оно главное
  for (const k of kinds.values()) {
    k.core = [...k.words].filter(([, c]) => c / k.n >= CORE_SHARE).map(([t]) => t);
    k.all = new Set(k.words.keys());
    k.purpose = [...k.purposes].filter(([, c]) => c / k.n >= CORE_SHARE).map(([t]) => t);
    k.headSet = new Set(k.heads.keys());
    if (k.n >= MIN_NAMES) for (const t of k.core) coreIndex.set(t, (coreIndex.get(t) || 0) + 1);
    for (const t of k.headSet) heads.set(t, (heads.get(t) || 0) + 1);
  }
  const byName = new Map();
  for (const s of seen) byName.set(s.key, find(`n:${s.key}`));
  const model = { kinds, byName, coreIndex, heads, find, has: (x) => parent.has(x) };
  learnExamples(model, examples);
  return model;
}

/**
 * Примеры дополняют вид: слова верных названий (встретились дважды — случайная строка контракта не должна открыть дорогу чужому
 * товару) становятся своими, слова отвергнутых названий — признаком ошибки. Свои слова важнее: синоним не станет чужим.
 */
function learnExamples(model, examples) {
  for (const k of model.kinds.values()) { k.right = new Map(); k.wrong = new Set(); }
  const kindOf = (e) => kindOfItem(model, { name: e.item_name, ktru_code: e.ktru_code });
  for (const e of examples.filter((x) => x.verdict === 'right')) {
    const k = kindOf(e);
    if (k) for (const t of tokens(e.title)) k.right.set(t, (k.right.get(t) || 0) + 1);
  }
  for (const k of model.kinds.values()) for (const [t, c] of k.right) if (c >= 2) k.all.add(t);
  for (const e of examples.filter((x) => x.verdict === 'wrong')) {
    const k = kindOf(e);
    if (k) for (const t of tokens(e.title)) if (!k.all.has(t) && !k.right.has(t) && !SAME_HEAD.test(t)) k.wrong.add(t);
  }
}

/** Вид позиции: по коду, по названию, иначе ближайший по словам. */
function kindOfItem(model, item) {
  const code = String(item?.ktru_code || '').trim().slice(0, 18);
  const byCode = code && model.has(`k:${code}`) ? model.kinds.get(model.find(`k:${code}`)) : null;
  if (byCode) return byCode;
  const id = model.byName.get(nameKey(item?.name));
  return id ? model.kinds.get(id) : null;
}

// общие слова: «комплект», «набор», «система» — одно и то же у разных продавцов, по ним вид не различить
const SAME_HEAD = /^(?:комплект|набор|систем|устройств|издели|средств|прибор|инструмент|материал|расходн)/;
// название-обобщение: «Изделия медицинские…», «Инструменты и приспособления…» — вида в нём нет
const GENERIC = /^\s*(?:издели|инструмент|материал|расходн|товар|оборудован|принадлежност|прочие)|в\s+том\s+числе|прочие/i;

/** Главное слово названия товара: первое слово, которое у какого-то вида стоит первым. */
function headOf(model, have) { return have.find((t) => model.heads.has(t)) || null; }

/**
 * Тот ли это товар — как рассуждает человек: что это (главное слово) и для чего (назначение). Итог other — назначения
 * вида нет, зато есть признак другого вида, либо главное слово другое; same — назначение и главное слово на месте;
 * unknown — судить не по чему (вид не выучен, мало примеров).
 * @returns {{verdict:'same'|'other'|'unknown', why:string, kind?:string}}
 */
function checkKind(model, item, offer) {
  const kind = model ? kindOfItem(model, item) : null;
  if (!kind || !kind.core.length) return { verdict: 'unknown', why: 'вид позиции ещё не выучен' };
  if (GENERIC.test(item?.name || '') || GENERIC.test(kind.label)) return { verdict: 'unknown', why: 'название позиции — обобщение, вид из него не понять' };
  const have = tokens(offer?.title || '');
  const set = new Set(have);
  // код КТРУ бывает общим на разные товары: если название самой позиции почти целиком в названии товара, это он
  const own = tokens(item?.name);
  if (own.length && own.filter((t) => set.has(t)).length / own.length >= OWN_SHARE) return { verdict: 'same', why: 'название позиции совпало с названием товара', kind: kind.label };
  const label = kind.label;
  const missing = kind.purpose.filter((t) => !set.has(t));
  // признаки другого вида: слово из ядра других видов, которого в этом виде не бывает
  const foreign = have.filter((t) => (model.coreIndex.get(t) || 0) >= FOREIGN_MIN && !kind.all.has(t));
  if (missing.length && foreign.length) return { verdict: 'other', why: `нужно «${label}»: в названии нет назначения («${missing.join(', ')}»), зато есть признак другого товара («${foreign.slice(0, 3).join(', ')}»)`, kind: label };
  // человек или самопроверка уже отвергали товар с таким словом, а назначение не подтверждено
  const learned = have.filter((t) => kind.wrong?.has(t));
  if (learned.length && (missing.length || !kind.purpose.length)) return { verdict: 'other', why: `нужно «${label}»: товар с признаком «${learned.slice(0, 3).join(', ')}» уже оказывался не тем`, kind: label };
  const head = headOf(model, have);
  const headOk = !head || SAME_HEAD.test(head) || kind.headSet.has(head) || kind.all.has(head);
  if (!headOk && foreign.includes(head)) return { verdict: 'other', why: `нужно «${label}», а в названии товара главное слово другое («${head}»)`, kind: label };
  if (!missing.length && kind.purpose.length) return { verdict: 'same', why: `назначение совпало: ${kind.purpose.join(', ')}`, kind: label };
  return { verdict: 'unknown', why: missing.length ? `в названии нет «${missing.join(', ')}», другой товар не распознан` : 'назначение в названии вида не указано', kind: label };
}

// коды медицинских изделий и лекарств: здесь проверка вида принимает решение, в остальных нишах пока наблюдает
const KIND_ON = /^(?:32\.50|21\.20)/;

/**
 * Запрос к поиску по виду и назначению, без размеров: «Система для переливания крови». Размеры из ТЗ уводят поиск к другому
 * товару того же размера. Только для медицины с известным назначением; самое частое название вида — как его называют чаще.
 */
function kindQuery(model, item) {
  if (!model || !KIND_ON.test(String(item?.ktru_code || item?.okpd2_code || ''))) return null;
  const kind = kindOfItem(model, item);
  if (!kind?.purpose.length || GENERIC.test(kind.label)) return null;
  const [top] = [...kind.names].sort((a, b) => b[1] - a[1])[0];
  return `${String(top).split(/[,;(]/)[0].trim()} купить`;
}

// модель одна на процесс: пересобирается раз в сутки, сверка и проверяющий берут текущую
let current = null;
const setKindModel = (m) => { current = m; };
const getKindModel = () => current;

module.exports = { KIND_ON, kindQuery, setKindModel, getKindModel, buildKindModel, checkKind, kindOfItem, tokens, stem, nameKey };
