// Направления — группы товаров, с которыми работает посредник (компьютеры, сеть, видеонаблюдение, оргтехника…).
// У каждого направления свои коды ОКПД2/КТРУ, ключевые слова и слова-исключения. Закупка относится к направлению,
// если код товара начинается с кода направления или в наименовании есть его слово. Направления хранятся в профиле
// (profile.directions): каждое можно включить, выключить и настроить; стандартный набор — config/directions.json.
//
// Если закупка подходит сразу к нескольким направлениям, побеждает более точное совпадение:
//   длинный код («26.20.18» — МФУ) > слово в наименовании > общий код класса («26.20» — компьютеры и периферия).
// Так картридж с кодом 26.20.40.120 попадает в оргтехнику, а не в компьютеры, хотя формально это тот же класс 26.20.

const fs = require('node:fs');
const path = require('node:path');

const STANDARD_FILE = path.join(__dirname, '..', '..', 'config', 'directions.json');
// Столько слов всех включённых направлений вместе уходит в поиск по лентам площадок: на каждое слово — отдельный
// запрос, а ЕИС просит паузу 60 с между запросами.
const SEARCH_WORDS_TOTAL = 15;
const SEARCH_WORDS_MAX = 5;

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
// Основа слова: у длинного слова убираем окончание из гласных — «видеонаблюдение» находит «видеонаблюдения»,
// «клавиатура» — «клавиатуры». Слово на согласную не трогаем: «монитор» и так находит «мониторы», а обрезанный
// «проектор» превращался в «проект» и ловил «разработку проекта». У фразы меняется только конец последнего слова.
const stem = (w) => (w.length > 6 ? w.replace(/[аеиоуыэюяйь]{1,2}$/, '') : w);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LETTER = 'a-zа-я0-9';

/**
 * Слово → проверка наименования. Ищем с начала слова: «провода» не должны находиться в «водопровода», а «скуд» —
 * в «оскудении». Короткие слова (МФУ, ИБП, СКУД, SFP) — только целиком; у длинных конец свободный («монитор» → «мониторы»).
 */
function wordTest(raw) {
  const w = stem(norm(raw).trim());
  if (!w) return null;
  const re = new RegExp(`(^|[^${LETTER}])${escapeRe(w)}${w.length > 4 ? '' : `($|[^${LETTER}])`}`);
  return (text) => re.test(text);
}

let standardCache = null;
/** Стандартные направления из config/directions.json. */
function loadStandard(file = STANDARD_FILE) {
  if (standardCache?.file === file) return standardCache.data;
  let data = [];
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')).directions || [];
  } catch { /* файла нет — стандартных направлений нет */ }
  standardCache = { file, data };
  return data;
}

const compiled = new WeakMap();
/** Направление в виде, удобном для проверки: коды, проверки слов и слов-исключений. */
function compile(d) {
  if (compiled.has(d)) return compiled.get(d);
  const all = (d.keywords || []).map((w) => String(w).trim()).filter(Boolean);
  const c = {
    id: d.id, title: d.title, enabled: d.enabled !== false,
    codes: (d.codes || []).map((x) => String(x).trim()).filter(Boolean),
    words: all.filter((w) => !w.startsWith('-')).map(wordTest).filter(Boolean),
    minus: all.filter((w) => w.startsWith('-')).map((w) => wordTest(w.slice(1))).filter(Boolean),
  };
  compiled.set(d, c);
  return c;
}

const hasDirections = (profile) => Array.isArray(profile?.directions) && profile.directions.length > 0;
const enabledOf = (profile) => (profile?.directions || []).filter((d) => d.enabled !== false);
/**
 * Отбор идёт по направлениям? Да — в режиме перепродажи, когда включено хотя бы одно. Если не включено ни одного,
 * работают поля профиля «Коды» и «Ключевые слова» (пустые — любой товар), как до появления направлений.
 */
const usesDirections = (profile) => profile?.mode !== 'profile' && enabledOf(profile).length > 0;

/**
 * Насколько закупка (или позиция) подходит направлению: 0 — не подходит.
 * Код: 10 за каждую цифру совпавшего начала («26.20» — 40, «26.20.18» — 60, «26.20.40.120» — 90).
 * Слово в наименовании: 50 (+5 за каждое следующее) — точнее общего кода класса, но слабее кода подгруппы.
 * @returns {{score: number, minus: boolean}} minus — подошло бы, но в наименовании слово-исключение
 */
function matchScore(dir, codes, text) {
  const c = compile(dir);
  let codeScore = 0;
  for (const code of codes) {
    for (const p of c.codes) if (code.startsWith(p)) codeScore = Math.max(codeScore, p.replace(/\D/g, '').length * 10);
  }
  const hits = c.words.reduce((n, test) => n + (test(text) ? 1 : 0), 0);
  const score = Math.max(codeScore, hits ? 50 + (hits - 1) * 5 : 0);
  if (score && c.minus.some((test) => test(text))) return { score: 0, minus: true };
  return { score, minus: false };
}

/** Лучшее направление из списка для набора кодов и наименования. @returns {{id, score}|null} */
function pick(dirs, codes, name) {
  const text = norm(name);
  const list = (codes || []).map(String).filter(Boolean);
  let best = null;
  let minus = false;
  for (const d of dirs) {
    const m = matchScore(d, list, text);
    if (m.minus) minus = true;
    if (m.score > (best?.score || 0)) best = { id: d.id, score: m.score };
  }
  return best || (minus ? { id: null, score: 0, minus: true } : null);
}

const itemWeight = (i) => i.sum ?? (i.unit_price != null && i.quantity ? i.unit_price * i.quantity : 1);

/**
 * Состав закупки по направлениям — по позициям, с весом по сумме.
 * @returns {{total: number|null, best: string|null, byDir: Record<string, number>}} total — доля суммы на товары
 *   направлений из списка (0–1; null — позиций или направлений нет), best — направление с наибольшей долей
 */
function itemsShare(items, dirs) {
  if (!items?.length || !dirs.length) return { total: null, best: null, byDir: {} };
  let all = 0;
  const sums = {};
  for (const i of items) {
    const w = itemWeight(i);
    all += w;
    const m = pick(dirs, [i.ktru_code || i.okpd2_code].filter(Boolean), i.name);
    if (m?.id) sums[m.id] = (sums[m.id] || 0) + w;
  }
  if (!all) return { total: null, best: null, byDir: {} };
  const byDir = Object.fromEntries(Object.entries(sums).map(([id, s]) => [id, Math.round((s / all) * 100) / 100]));
  const mine = Object.values(sums).reduce((a, b) => a + b, 0);
  const best = Object.entries(sums).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return { total: Math.round((mine / all) * 100) / 100, best, byDir };
}

/**
 * Направление закупки — метка для ленты, уведомлений и корзины. Если позиции уже загружены — по составу (на что
 * приходится больше денег), иначе по кодам и наименованию закупки. Ищем среди включённых направлений; если не
 * включено ни одно («любой товар») — среди всех, чтобы метка была и в этом режиме.
 * @returns {string|null} id направления
 */
function tenderDirection(tender, profile, items = null) {
  if (!hasDirections(profile)) return null;
  const enabled = enabledOf(profile);
  const dirs = enabled.length ? enabled : profile.directions;
  // 1. Наименование закупки однозначно называет направление («Поставка системы видеонаблюдения») — верим ему:
  //    заказчик сам написал, что покупает, даже если по деньгам в составе больше кабеля и коммутаторов.
  const text = norm(tender.title);
  const byTitle = dirs.filter((d) => matchScore(d, [], text).score > 0);
  if (byTitle.length === 1) return byTitle[0].id;
  // 2. Наименование общее («Поставка товара») или называет сразу несколько направлений — смотрим состав.
  if (items?.length) {
    const byItems = itemsShare(items, dirs).best;
    if (byItems) return byItems;
  }
  // 3. Позиции ещё не загружены — по кодам и наименованию закупки.
  return pick(dirs, [...(tender.okpd2 || []), ...(tender.ktru || [])], tender.title)?.id || null;
}

/** Коды без повторов и без кодов, уже покрытых более коротким: «26.20.18» лишний рядом с «26.20». */
function unionCodes(dirs) {
  const all = [...new Set(dirs.flatMap((d) => (d.codes || []).map((c) => String(c).trim()).filter(Boolean)))];
  return all.filter((c) => !all.some((p) => p !== c && c.startsWith(p)));
}

const unionKeywords = (dirs) => [...new Set(dirs.flatMap((d) => (d.keywords || []).map((w) => String(w).trim()).filter(Boolean)))];

/** Сколько первых слов каждого включённого направления идёт в поиск по лентам площадок. */
function searchWordsPerDirection(profile) {
  const n = enabledOf(profile).length;
  return n ? Math.max(1, Math.min(SEARCH_WORDS_MAX, Math.floor(SEARCH_WORDS_TOTAL / n))) : 0;
}

/** Слова для поиска по лентам: первые слова каждого включённого направления по очереди, без исключений и повторов. */
function searchWords(profile) {
  const k = searchWordsPerDirection(profile);
  const lists = enabledOf(profile).map((d) => (d.keywords || []).map((w) => String(w).trim()).filter((w) => w && !w.startsWith('-')).slice(0, k));
  const out = [];
  for (let i = 0; i < k; i++) for (const l of lists) if (l[i] && !out.includes(l[i])) out.push(l[i]);
  return out;
}

/**
 * Профиль глазами одного направления — для оценки нейросетью: ей показываем коды и слова только того направления,
 * к которому относится закупка. Поэтому включение или выключение соседнего направления не сбрасывает оценки.
 */
function profileForDirection(profile, dirId) {
  if (!usesDirections(profile)) return profile;
  const d = profile.directions.find((x) => x.id === dirId);
  return { ...profile, codes: d?.codes || [], keywords: d?.keywords || [] };
}

/**
 * Направления для профиля, в котором их ещё нет (переход со старой версии, где было одно общее направление в полях
 * «Коды» и «Ключевые слова»). Коды и слова были → включаем все стандартные: прежний общий набор покрывал их все.
 * Свой набор, не похожий на стандартный, сохраняем отдельным направлением. Пусто → «любой товар», всё выключено.
 */
function seedDirections({ codes = [], keywords = [] } = {}, standard = loadStandard()) {
  const had = codes.length > 0 || keywords.length > 0;
  const stdCodes = unionCodes(standard);
  const stdWords = new Set(unionKeywords(standard).map(norm));
  const covered = (c) => stdCodes.some((p) => c.startsWith(p) || p.startsWith(c));
  const ownCodes = codes.filter((c) => !covered(String(c)));
  const ownWords = keywords.filter((w) => !String(w).trim().startsWith('-') && !stdWords.has(norm(w)));
  // «Свой набор» — только если большая часть кодов или слов не из стандартных направлений.
  const custom = had && (ownCodes.length > codes.length / 2 || ownWords.length > Math.max(3, keywords.length / 2));
  const dirs = standard.map((d) => ({ id: d.id, title: d.title, short: d.short || d.title, note: d.note || '', enabled: had && !custom, codes: [...d.codes], keywords: [...d.keywords] }));
  if (custom) dirs.unshift({ id: 'custom-legacy', title: 'Свой набор', short: 'Свой набор', note: 'коды и ключевые слова, которые были в профиле до появления направлений', enabled: true, codes: [...codes], keywords: [...keywords] });
  return dirs;
}

/**
 * Проставить метку направления всем сохранённым закупкам (после изменения направлений в профиле).
 * @returns {number} у скольких закупок метка изменилась
 */
function retagAll(repo, profile) {
  if (!hasDirections(profile)) return 0;
  const withItems = new Set(repo.tenderIdsWithItems());
  let changed = 0;
  for (const t of repo.tendersForTagging()) {
    const dir = tenderDirection(t, profile, withItems.has(t.id) ? repo.getItems(t.id) : null);
    if (dir !== (t.direction ?? null)) { repo.setDirection(t.id, dir); changed++; }
  }
  return changed;
}

/** Переразметить закупки, если направления в профиле изменились с прошлой разметки. Дёшево: без сети и нейросети. */
function ensureTagged(repo, profile, log = console) {
  if (!hasDirections(profile)) return 0;
  const key = JSON.stringify(profile.directions);
  if (repo.getSetting('directions_tagged') === key) return 0;
  const changed = retagAll(repo, profile);
  repo.setSetting('directions_tagged', key);
  if (changed) log.log?.(`[directions] метки направлений обновлены у ${changed} закупок`);
  return changed;
}

module.exports = {
  ensureTagged,
  loadStandard, hasDirections, usesDirections, enabledOf, matchScore, pick, itemsShare, tenderDirection, unionCodes, unionKeywords,
  searchWords, searchWordsPerDirection, profileForDirection, seedDirections, retagAll, STANDARD_FILE,
};
