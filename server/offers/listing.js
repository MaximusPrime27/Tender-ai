// Страница каталога без разметки schema.org: раздел «Ноутбуки 16"», выдача поиска по сайту, список товаров бренда.
// Раньше с такой страницы нейросеть брала первый попавшийся товар с ценой — получалось «предложение» со ссылкой
// на каталог и без характеристик. Теперь каталог распознаётся, а с него берутся ссылки на страницы самих товаров.

const { htmlToText } = require('./fetch-page');
const { searchName } = require('./spec');

const clean = (s) => String(s ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const norm = (w) => w.toLowerCase().replace(/ё/g, 'е');
const stem = (w) => norm(w).slice(0, 5);
const compact = (s) => norm(String(s)).replace(/[\s\-_/.]+/g, '');

// Обозначение модели: буквы и цифры в одном слове («X1605VA», «16ALB», «TK-5240K»).
const MODEL_TOKEN = /(?<![a-zа-яё0-9])(?=[a-zа-яё0-9-]*\d)(?=[a-zа-яё0-9-]*[a-zа-яё])[a-zа-яё0-9][a-zа-яё0-9-]{2,}/i;
// То же, но длиннее — когда в тексте ссылки нет названия типа товара и судить можно только по обозначению.
const LONG_MODEL_TOKEN = /(?<![a-z0-9])(?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z0-9][a-z0-9-]{3,}/i;
// Латинское название и число рядом: «MagicBook 16», «IronWolf Pro 8TB».
const BRAND_AND_NUMBER = /[a-z]{3,}[^а-яё]*\d|\d[^а-яё]*[a-z]{3,}/i;
const NOT_PRODUCT_URL = /\/(cart|basket|compare|login|auth|register|favorites?|wishlist|personal|account|brands?|news|blog|articles?|reviews?|otzyv|help|support|bench\w*|contacts?|delivery|dostavka|oplata|about)(\/|$|\?)|price_list|goods_compare|[?&](section|tag|sort|order|filter|page|PAGEN_\d)=/i;

const looksSpecific = (text) => MODEL_TOKEN.test(text) || BRAND_AND_NUMBER.test(text);

/** Слова, по которым узнаётся тип товара: «ноутбук», «МФУ», «жёсткий диск». */
function kindWords(text) {
  const src = clean(searchName(text));
  return [...(src.match(/[а-яёa-z]{4,}/gi) || []), ...(src.match(/(?<![А-ЯЁA-Zа-яёa-z])[А-ЯЁA-Z]{3}(?![А-ЯЁA-Zа-яёa-z])/g) || [])].map(norm);
}

/** Тип товара из названия, которое дала нейросеть: «Жёсткий диск Seagate Exos» → «жёсткий диск». */
function typeOfCandidate(c) {
  const name = clean(c?.name);
  const at = c?.brand ? norm(name).indexOf(norm(c.brand)) : -1;
  return at > 0 ? name.slice(0, at) : '';
}

/** Заголовок страницы: h1, иначе title. */
function headingOf(html) {
  const src = String(html || '');
  return clean(htmlToText(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(src)?.[1] || '')) || clean(htmlToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1] || ''));
}

/**
 * Ссылки на товары со страницы: текст ссылки похож на название конкретного товара того же типа, что позиция ТЗ.
 * @param {{models?: string[], candidates?: Array<{name, brand, model}>}} p models — модель из ТЗ, candidates — товары,
 *   подобранные под ТЗ (их тип, производитель и модель тоже помогают узнать нужные ссылки)
 * @returns {Array<{title: string, price: number|null, url: string, exact: boolean}>}
 */
function productLinks(html, pageUrl, item, { models = [], candidates = [] } = {}) {
  const src = String(html || '').replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const own = kindWords(item?.name);
  const kinds = new Map(); // основа слова → слово в единственном числе (как в ТЗ)
  for (const w of [...own, ...candidates.flatMap((c) => kindWords(typeOfCandidate(c)))]) if (!kinds.has(stem(w))) kinds.set(stem(w), w);
  const wanted = [...models, ...candidates.map((c) => c.model)].map((m) => compact(m || '')).filter((m) => m.length >= 3);
  const exactModels = models.map((m) => compact(m || '')).filter((m) => m.length >= 3);
  const brands = candidates.map((c) => norm(c.brand || '')).filter((b) => b.length >= 2);
  const headingKind = kindWords(headingOf(html)).some((w) => kinds.has(stem(w)));
  let host;
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return []; }
  const byUrl = new Map();
  for (const m of src.matchAll(/<a\b([^>]*)>([\s\S]{0,800}?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*["']([^"'#]+)["']/i.exec(m[1])?.[1];
    if (!href || /^(javascript|mailto|tel):/i.test(href)) continue;
    let url;
    try { url = new URL(href.trim().replace(/&amp;/g, '&'), pageUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || url.hostname.replace(/^www\./, '') !== host) continue;
    url.hash = '';
    if (url.href === pageUrl || url.pathname.length < 4 || NOT_PRODUCT_URL.test(url.pathname + url.search)) continue;
    let text = clean(htmlToText(m[2])) || clean(/\btitle\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1]) || clean(/\balt\s*=\s*["']([^"']+)["']/i.exec(m[2])?.[1]);
    // Цена внутри ссылки («74 999 ₽ Ноутбук …») — пригодится, чтобы выбрать подешевле.
    const priceM = /(\d[\d\s ]{2,9})\s*(?:₽|руб)/i.exec(text);
    const price = priceM ? Number(priceM[1].replace(/\s/g, '')) : null;
    if (priceM) text = clean(text.replace(/(?:от\s*)?\d[\d\s ]{2,9}\s*(?:₽|руб\.?)/gi, ' '));
    if (text.length < 10 || text.length > 220) continue;
    const lower = norm(text);
    const tokens = lower.match(/[а-яa-z]{3,}/g) || [];
    // Слово типа товара в тексте ссылки и то, как оно написано в ТЗ. Короткие слова («диск», «блок») сравниваем по 4 буквам:
    // иначе «диски» и «диск» — разные основы.
    const kindOf = (w) => kinds.get(stem(w)) || (w.length <= 6 && kinds.get(w.slice(0, 4))?.length === 4 ? kinds.get(w.slice(0, 4)) : undefined);
    const hits = tokens.filter((w) => kindOf(w));
    const hit = hits[0];
    // «Ноутбуки Asus 17"» — раздел, а не товар: слово типа стоит во множественном числе, а в ТЗ — в единственном.
    const plural = hits.some((w) => /[иы]$/.test(w) && !/[иы]$/.test(kindOf(w)) && w !== kindOf(w));
    if (plural) continue;
    const exact = exactModels.some((w) => compact(lower).includes(w));
    const byModel = exact || wanted.some((w) => compact(lower).includes(w));
    const byBrand = brands.some((b) => lower.includes(b)) && looksSpecific(text);
    // Раздел нужного типа («Ноутбуки Tecno»), а в ссылке только обозначение: «TECNO MegaBook T15DA (…)».
    const byHeading = headingKind && text.length >= 20 && LONG_MODEL_TOKEN.test(text.replace(/\d{3,4}\s*[xх×]\s*\d{3,4}/gi, ' ')) && url.pathname.length >= 15;
    if (!byModel && !(hit && looksSpecific(text)) && !byBrand && !byHeading) continue;
    const prev = byUrl.get(url.href);
    if (!prev || text.length > prev.title.length) byUrl.set(url.href, { title: text, price: price ?? prev?.price ?? null, url: url.href, exact });
  }
  return [...byUrl.values()];
}

/**
 * Каталог ли это: в заголовке нет конкретного товара («Ноутбуки 16"», «Ноутбуки Tecno», «Жёсткие диски б/у»),
 * а на странице несколько ссылок на товары такого же типа.
 * @returns {Array<{title, price, url, exact}>|null} товары каталога или null, если это страница одного товара
 */
function listingOf(page, item, { models = [], candidates = [], min = 4 } = {}) {
  const heading = headingOf(page.html).replace(/\b(купить|цена|цены|недорого|интернет-магазин\S*|страница \d+)\b.*$/i, '');
  if (heading && MODEL_TOKEN.test(heading)) return null;
  const links = productLinks(page.html, page.url, item, { models, candidates });
  return links.length >= min ? links : null;
}

module.exports = { listingOf, productLinks, headingOf, looksSpecific, kindWords, typeOfCandidate };
