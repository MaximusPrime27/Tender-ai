// Добор на сайте: товар почти подошёл (средняя вязкость вместо высокой, однослойные бахилы вместо двухслойных), а
// нужный лежит на этом же сайте рядом — в «похожих товарах», вариантах, том же разделе. Владелец находил его сам
// (25–29.10.2026), сервис — нет: он открывал одну страницу и шёл дальше. Здесь: со страницы почти подошедшего товара
// берём ссылки на товары того же сайта, в названии которых есть то, чего не хватило, — без нейросети и без поисковика.

const { kindWords } = require('./listing');
const { stems, canon } = require('./rule-check');

const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const YES = /^(да|есть|имеется|наличие|соответствие)$/i;

/**
 * Что искать в названиях соседних товаров: основы слов неподтверждённых и не прошедших требований.
 * «Степень вязкости: Высокая» → «высо»; «Двойная резинка: Да» → «двойн», «рези»; числа не берём — их в названиях пишут
 * по-разному, а сверка всё равно проверит найденный товар целиком.
 */
function wantedStems(offer) {
  const out = new Set();
  for (const r of offer?.match_checks?.rows || []) {
    if (r.verdict === 'yes') continue;
    const need = String(r.need || '').trim();
    // «Количество слоев: 2» — в названиях пишут «двухслойные», «2 слоя», «с двойным дном»
    const count = /количеств\S*\s+(\S+)/i.exec(r.name);
    if (count && /^\s*2\s*(шт)?\.?\s*$/i.test(need)) {
      out.add(/^сло/i.test(count[1]) ? /двойн\S*\s*(?:сло|дн)/ : /двойн/);
      continue;
    }
    const from = YES.test(need) ? r.name : /\d/.test(need) ? '' : need;
    for (const s of stems(from)) if (!/^\d/.test(s)) out.add(s);
  }
  return [...out];
}

/**
 * Ссылки на товары того же сайта, в названии которых есть вид товара из ТЗ и хотя бы одна недостающая черта.
 * @returns [{title, url, price, score}] лучшие первыми (больше совпавших черт, потом дешевле)
 */
function sameSiteLinks(html, pageUrl, item, wants, max = 3) {
  if (!wants.length) return [];
  let host;
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return []; }
  const kind = [...kindWords(item?.name || ''), ...String(item?.name || '').split(/\s+/).slice(0, 1)].map((w) => stems(w)[0]).filter(Boolean);
  const src = String(html || '').replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const byUrl = new Map();
  for (const m of src.matchAll(/<a\b([^>]*)>([\s\S]{0,800}?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*["']([^"'#]+)["']/i.exec(m[1])?.[1];
    if (!href || /^(javascript|mailto|tel):/i.test(href)) continue;
    let url;
    try { url = new URL(href.trim().replace(/&amp;/g, '&'), pageUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || url.hostname.replace(/^www\./, '') !== host) continue;
    url.hash = '';
    if (url.href === pageUrl || url.pathname.length < 4) continue;
    let title = strip(m[2]) || strip(/\btitle\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1]);
    const priceM = /(\d[\d\s ]{0,9})\s*(?:₽|руб)/i.exec(title);
    const price = priceM ? Number(priceM[1].replace(/\s/g, '')) : null;
    title = title.replace(/(?:от\s*)?\d[\d\s ]{0,9}\s*(?:₽|руб\.?)/gi, ' ').replace(/\s+/g, ' ').trim();
    if (title.length < 10 || title.length > 220) continue;
    const t = canon(title);
    if (kind.length && !kind.some((k) => t.includes(k))) continue;
    const score = wants.filter((w) => (w instanceof RegExp ? w.test(t) : t.includes(w))).length;
    if (!score) continue;
    const prev = byUrl.get(url.href);
    if (!prev || score > prev.score) byUrl.set(url.href, { title, url: url.href, price, score });
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score || (a.price ?? Infinity) - (b.price ?? Infinity)).slice(0, max);
}

module.exports = { wantedStems, sameSiteLinks };
