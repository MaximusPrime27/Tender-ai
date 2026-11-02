// Адресный поиск недостающих характеристик по модели (Этап 1, добор из интернета). Платный: запросы к Яндексу,
// отдельный суточный лимит MAKER_SEARCH_DAILY (по умолчанию 50 ≈ 25 ₽ в день), не из лимита поиска поставщиков.
// Ищем только у лидеров: товар не отклонён, входит в самые дешёвые по позиции и у него остались неподтверждённые
// требования. Запрос — модель и 1–2 недостающих свойства. Открываем найденные страницы, оставляем только те, где
// названа та же модель, и сверяем с ТЗ лишь недостающие требования. Найденное запоминаем по модели: та же модель
// у другого продавца или в другой закупке повторно не ищется.

const { SUPPLY_TERMS } = require('./match');

const squash = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');

/**
 * Модель товара из названия предложения: самые «артикульные» обозначения (буквы и цифры вместе: GK-196L, TK-5450K,
 * CE505X, 006R04404). Без модели адресный поиск бессмыслен — найдётся что угодно.
 */
function modelOf(title) {
  // «… для Xerox B225, 006R04404» — после «для» перечислены чужие модели и номер оригинала: по ним найдутся страницы
  // другого товара, поэтому модель берём только из начала названия
  const head = headOf(title);
  // если в начале обозначения нет — артикул продавца в скобках в конце: «Картридж CACTUS для HP (CS-CF226X)»
  const tail = /\(([^()]+)\)\s*$/.exec(String(title || ''))?.[1] || '';
  return pick(head) || pick(tail);
}
// латиница и кириллица («КЛ104РУ»); бренд с цифрой («A4Tech») и обозначения интерфейсов моделью не считаются
function pick(text) {
  // точка — часть обозначения только между цифрами («Э-32.2»), иначе «Э-32.1» сошлась бы с «Э-32.2»
  const tokens = (text.match(/[A-Za-zА-Яа-яЁё0-9](?:[A-Za-zА-Яа-яЁё0-9-]|\.(?=\d)){2,}[A-Za-zА-Яа-яЁё0-9]/g) || [])
    .filter((t) => /\d/.test(t) && /[A-Za-zА-Яа-яЁё]/.test(t) && !BRANDS.test(` ${t} `)
      && !/^(usb\d*|hdmi\d*|ddr\d*|wi-?fi\d*|ip\d+|rj-?45|\d+(gb|tb|mb|mhz|ghz|w|v|dpi|mm|cm|kg|гб|тб|мб|вт|мм|см|кг|шт|стр)|\d+[a-zа-я]?)$/i.test(t)
      // числительные («2-ой», «2-местный», «3-х») и размеры («1000х700х750») — не модель: по ним найдётся чужой товар
      && !/^\d+-?[а-яё]+$/i.test(t) && !/^\d+([хx×*]\d+)+$/i.test(t)
      // процессор («i5-1235U», «N4020») стоит в сотнях разных ноутбуков — это не модель товара
      && !/^(i[3579]|r[3579]|ryzen|n|celeron|pentium|core)-?\d{3,5}[a-z]{0,3}$/i.test(t));
  if (!tokens.length) return null;
  return tokens.sort((a, b) => b.length - a.length)[0];
}
const BRANDS = /\b(defender|a4tech|bloody|logitech|genius|oklick|sven|exegate|gembird|dialog|perfeo|xerox|kyocera|canon|hp|hewlett|brother|ricoh|samsung|pantum|lexmark|epson|sharp|konica|minolta|oki|katusha|lenovo|asus|acer|dell|msi|huawei|honor|apple|tp-?link|d-?link|mikrotik|zyxel|keenetic|cisco|eltex|aquarius|iru|kraftway|depo|f\+|aoc|philips|benq|viewsonic|iiyama|lg|nv\s?print|cactus|sakura|hi-?black|easyprint|t2|bion|g&g|elp|uniton)\b/i;
// начало названия — до «для», «совместимый», «аналог»: дальше перечислены чужие бренды и модели
function headOf(title) { return String(title || '').split(/\s(?:для|к|под|совместим\S*|аналог\S*)\s/i)[0]; }
// бренд самого товара — из начала названия (у «TK-5290K совместимый для Kyocera» бренд не Kyocera) или из артикула в скобках
const brandOf = (title) => BRANDS.exec(headOf(title))?.[1] || BRANDS.exec(/\(([^()]+)\)\s*$/.exec(String(title || ''))?.[1] || '')?.[1] || null;
/** Совместимый расходник без своего бренда назван номером оригинала: характеристики оригинала к нему не относятся. */
const noNameCompatible = (title) => /совместим|аналог/i.test(String(title || '')) && !brandOf(title);

/** Недостающие требования, которые есть смысл искать (условия поставки — гарантия, упаковка — у продавца, не в интернете). */
const missingRows = (checks) => (checks?.rows || []).filter((r) => r.verdict === 'unknown' && !SUPPLY_TERMS.test(r.name));

/** 1–2 запроса: модель + до двух недостающих свойств в каждом. */
function queriesFor(title, rows, { max = 2 } = {}) {
  const model = modelOf(title);
  if (!model) return [];
  const brand = brandOf(title);
  const head = [brand && !squash(model).includes(squash(brand)) ? brand : null, model].filter(Boolean).join(' ');
  const out = [];
  for (let i = 0; i < rows.length && out.length < max; i += 2) {
    // короткое название свойства («Тип») само по себе ничего не ищет — добавляем нужное значение («Тип полноразмерная»)
    const names = rows.slice(i, i + 2).map((r) => { const n = String(r.name).replace(/\(.*?\)/g, '').split(/[,;]/)[0].trim().slice(0, 50); return n.length < 8 && r.need && !/\d/.test(r.need) ? `${n} ${String(r.need).slice(0, 30)}` : n; });
    out.push(`${head} ${names.join(' ')} характеристики`);
  }
  return out;
}

/**
 * Страница про ту же модель: обозначение модели есть в тексте целиком (без разделителей и регистра), и бренд тоже,
 * если он известен: совместимый «NV Print CF226X» назван номером оригинала — страница HP CF226X про другой товар.
 */
const sameModelPage = (text, model, brand = null) => Boolean(model) && squash(text).includes(squash(model)) && (!brand || squash(text).includes(squash(brand)));

/**
 * Влить результаты адресного поиска в сверку предложения: только строки, которые были «не подтверждено».
 * @param checks прежняя сверка (match_checks)
 * @param sub результат сверки только недостающих требований по найденным страницам
 * @param pages [{url, domain}] найденные страницы (источник — первая, где нашлось)
 * @returns {{checks, match, changed: number}}
 */
/** Словесная категория («обычная», «повышенная»): русские слова без чисел и обозначений, не «да/нет/есть/отсутствует». */
const wordCategory = (v) => { const s = String(v || '').trim().toLowerCase(); return Boolean(s) && !/[\da-z]/.test(s) && !/^(да|нет|есть|отсутству\S*|имеется|не\s|без\s)/.test(s); };

function mergeMakerChecks(checks, sub, pages, { specComplete = true } = {}) {
  const byName = new Map((sub?.checks?.rows || []).map((r) => [r.name, r]));
  let changed = 0;
  const rows = (checks.rows || []).map((r) => {
    if (r.verdict !== 'unknown') return r;
    const s = byName.get(r.name);
    if (!s || s.verdict === 'unknown') return r;
    changed++;
    const src = pages.find((p) => s.quote && p.text && squash(p.text).includes(squash(s.quote.replace(/^…|…$/g, '')).slice(0, 40))) || pages[0];
    // «не подходит» с чужого сайта — только для проверяемых фактов: числа («390 мм»), есть/нет («DisplayPort: нет»).
    // Словесную категорию («ёмкость: обычная» против «повышенная») магазины ставят каждый по-своему — это противоречие
    // для проверки у продавца, а не отказ.
    const verdict = s.verdict === 'no' && wordCategory(r.need) && wordCategory(s.found) ? 'conflict' : s.verdict;
    return { ...r, verdict, found: s.found, quote: s.quote || null, method: `найдено по модели — ${ROUTES[src?.route]?.found || 'в интернете'}: ${src?.domain || 'другой сайт'}`, source: src?.url || null, route: src?.route || 'web',
      ...(verdict === 'conflict' ? { reason: `на другом сайте «${s.found}» — категорию сайты называют по-разному, проверьте у продавца` } : s.rule ? { rule: s.rule, reason: s.reason } : {}) };
  });
  const { checks: next, match } = recount({ ...checks, rows, maker: { pages: pages.map((p) => ({ url: p.url, domain: p.domain })), changed } }, { specComplete });
  return { checks: next, match, changed };
}

/** Пересчитать счётчики и итог сверки по строкам (после добора или ручного подтверждения). */
function recount(checks, { specComplete = true } = {}) {
  const rows = checks.rows || [];
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const next = { ...checks, confirmed: count('yes'), failed: count('no'), unknown: count('unknown'), conflict: count('conflict') };
  const all = next.of ?? rows.length;
  const match = next.failed ? 'не соответствует'
    : next.confirmed === all && !next.unknown && !next.conflict && rows.length === all && specComplete ? 'соответствует'
      : next.confirmed >= 3 || (rows.length && next.confirmed / rows.length >= 0.3) ? 'частично' : 'не хватает данных';
  return { checks: next, match };
}

/** Заголовок страницы товара: <h1>, иначе <title>. */
function pageTitle(html) {
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return strip(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html || ''))?.[1]) || strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''))?.[1]);
}

/**
 * Страница про принадлежность к модели, а не про неё саму: «Опция расширения UG-36 для TASKalfa 3554ci»,
 * «Тонер для Kyocera TK-5290K». Модель в заголовке стоит только после «для», «к», «совместим…».
 * Заголовка нет — судить нельзя (false).
 */
function accessoryPage(html, model) {
  const title = pageTitle(html);
  if (!title) return false;
  // в заголовке модели нет вовсе — страница про другой товар, где модель лишь упомянута («Принтер HP…» с картриджем в тексте)
  return !squash(headOf(title)).includes(squash(model));
}

/**
 * Страница про другое исполнение с той же моделью в названии: универсальный артикул «HB-CE505X/CF280X/CRG-719»
 * вместо «HB-CE505X». Смотрим заголовок страницы до «для»: если модель там стоит в одной связке через «/» с другими
 * обозначениями, которых нет в названии нашего товара, — это другой товар, его характеристики не переносим.
 */
function otherVariant(html, model, offerTitle) {
  const title = pageTitle(html);
  if (!title) return false;
  const word = headOf(title).split(/\s+/).find((w) => squash(w).includes(squash(model)));
  if (!word || !word.includes('/')) return false;
  const mine = squash(offerTitle);
  return word.split('/').map((p) => p.replace(/[()[\],.;]/g, '')).filter((p) => /\d/.test(p) && /[a-zа-я]/i.test(p) && p.length >= 3).some((p) => !mine.includes(squash(p)));
}

/**
 * Пути добора по порядку: сначала бесплатные, платный поиск — последним и только если бесплатные не закрыли пробелы.
 * label — как путь назван в «где искали», found — откуда значение в строке сверки.
 */
const ROUTES = {
  memory: { label: 'сохранённое досье модели', found: 'из сохранённого досье', free: true },
  peers: { label: 'страницы других продавцов этой модели', found: 'у другого продавца', free: true },
  catalog: { label: 'каталог страниц оптовых поставщиков', found: 'в каталоге поставщиков', free: true },
  web: { label: 'поиск в интернете (Яндекс, платно)', found: 'в интернете', free: false },
};

/** Короткая строка «где искали» для неподтверждённого требования. */
function triedText(trace) {
  return (trace || []).map((t) => `${ROUTES[t.route]?.label || t.route} — ${t.note || (t.pages ? `стр.: ${t.pages}` : 'ничего не нашлось')}`).join('; ');
}

/**
 * Модель мебели из названия: у мебели номер редко похож на модель техники — «CHAIRMAN 523», «111РВ», «ШР-22 L500»,
 * «Optima 90x200». Берём подряд идущие слова с цифрой, латиницей или заглавными («ИЗО»), начиная с первого такого;
 * обычные русские слова («регулируемый», «черный») модель заканчивают. Бренд в начале модели («ФЕРРОПЛАСТ СММП-08»)
 * отбрасывается, если без него остаётся номер с буквами и цифрами; «CHAIRMAN 523» остаётся целиком — «523» мало.
 */
function furnitureModel(title, brand = null) {
  // в скобках — цвет, декор, размер («(Бук Бавария Светлый U9501)»), а не модель
  const words = String(title || '').replace(/\([^)]*\)/g, ' ').replace(/[«»"“”()]/g, ' ').split(/\s+/).filter(Boolean);
  // «2-местная», «3-х», «4-ярусная» — описание, а не модель
  const modelish = (w) => !/^\d+-?(х|[а-яё]{2,})$/.test(w) && (/\d/.test(w) || /[A-Za-z]/.test(w) || /^[А-ЯЁ][А-ЯЁ.-]{1,}$/.test(w));
  const start = words.findIndex((w, i) => i > 0 && modelish(w));
  if (start < 0) return null;
  const out = [];
  for (const w of words.slice(start)) { if (!modelish(w)) break; out.push(w.replace(/[,;]+$/, '')); }
  const low = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  if (out.length > 1 && (low(out[0]) === low(brand) || /^[А-ЯЁ]{4,}$/.test(out[0]))) {
    const rest = out.slice(1).join(' ');
    if (/\d/.test(rest) && /[A-Za-zА-Яа-яЁё]/.test(rest)) out.shift();
  }
  const m = out.join(' ').trim();
  return m.replace(/[^a-z0-9а-яё]/gi, '').length >= 2 ? m : null;
}

module.exports = { recount, modelOf, furnitureModel, brandOf, noNameCompatible, otherVariant, accessoryPage, pageTitle, missingRows, queriesFor, sameModelPage, mergeMakerChecks, ROUTES, triedText };
