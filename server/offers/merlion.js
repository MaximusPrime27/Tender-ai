// Мерлион (merlion.com) — каталог дистрибьютора с полными характеристиками товаров: источник для своей базы товаров.
// Цен на публичном сайте нет (они в B2B для партнёров), поэтому это источник характеристик, а не предложений.
//
// Как устроен сайт (проверено 24.10.2026; robots.txt закрывает только поиск, адреса с параметрами и PDF):
//   • карта сайта static.merlion.ru/sitemap.xml — разделы каталога (/catalog/<раздел>/<подраздел>/), карточек в ней нет;
//   • страница раздела выдаёт сессию и номер группы (data-active-tg); список товаров — POST /catalog/getproductlist
//     (filter=(), id=<группа>, view=plate, brand=[], page=N), по 24 товара: номер, название, подпись с артикулом;
//   • карточка /catalog/product/<номер>/ отдаётся сервером целиком: пары «характеристика — значение», EAN, артикул.
// Ходим вежливо: пауза между запросами (MERLION_DELAY_MS), лимиты страниц на ночь — у ночного агента.

const BASE = 'https://merlion.com';
const SITEMAP = 'https://static.merlion.ru/sitemap.xml';
const UA = 'Mozilla/5.0 (compatible; tender-ai; +https://tender-app.213-171-12-208.sslip.io)';

const decode = (s) => String(s ?? '')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Разделы каталога из карты сайта: только подразделы (там списки товаров). */
function parseSitemap(xml) {
  return [...new Set([...String(xml).matchAll(/<loc>\s*(https:\/\/merlion\.com\/catalog\/[^<\s]+)\s*<\/loc>/g)].map((m) => m[1]))]
    .filter((u) => /^https:\/\/merlion\.com\/catalog\/[^/?#]+\/[^/?#]+\/?$/.test(u) && !/\/product\//.test(u))
    .map((u) => (u.endsWith('/') ? u : `${u}/`));
}

/** Страница списка: товары (номер, название, подпись с артикулом) и число страниц раздела. */
function parseList(html) {
  const items = [...String(html).matchAll(/href="\/catalog\/product\/(\d+)\/"[\s\S]*?class="firstname">([\s\S]*?)<\/span>(?:[\s\S]*?class="secondname">([\s\S]*?)<\/span>)?/g)]
    .map((m) => ({ id: Number(m[1]), title: decode(m[2]), second: decode(m[3]) }));
  const pages = Math.max(1, ...[...String(html).matchAll(/data-page="(\d+)"/g)].map((m) => Number(m[1])));
  return { items, pages };
}

/** Карточка товара: название, подпись, артикул (в скобках в начале подписи), EAN, характеристики. */
function parseCard(html) {
  const h = String(html);
  const title = decode(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(h)?.[1]);
  const second = decode(/<p class="h3[^"]*">([\s\S]*?)<\/p>/.exec(h)?.[1]);
  // строки бывают с пометкой чередования: class="property odd" — а «property-wrapper» — обёртка, не строка
  const specs = [...h.matchAll(/class="property(?:\s[^"]*)?">([\s\S]*?)<\/div>\s*<div\s+class="value(?:\s[^"]*)?">([\s\S]*?)<\/div>/g)]
    .map((m) => ({ name: decode(m[1]), value: decode(m[2]) }))
    .filter((s) => s.name && s.value && s.name.length <= 120 && s.value.length <= 400);
  const ean = specs.find((s) => /^EAN/i.test(s.name))?.value || null;
  const article = /^\(([^)]{2,60})\)/.exec(second)?.[1]?.split('/')[0].trim() || null;
  return { title, second, article, ean, specs: specs.filter((s) => !/^EAN|^Вендор$/i.test(s.name)) };
}

function createMerlion({ fetchImpl = fetch, delayMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console } = {}) {
  let last = 0;
  const pause = async () => { const wait = last + delayMs - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); };
  async function get(url, headers = {}) {
    await pause();
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow' });
    if (!r.ok) throw new Error(`${url}: ответ ${r.status}`);
    return { html: await r.text(), cookies: (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ') };
  }
  return {
    /** Разделы каталога (подразделы) из карты сайта. */
    async categories() { return parseSitemap((await get(SITEMAP)).html); },
    /**
     * Все товары раздела: страница раздела даёт сессию и номер группы, дальше — список по страницам.
     * @returns {Promise<{items: Array<{id, title, second}>, pages: number}>}
     */
    async listCategory(url, { maxPages = 40 } = {}) {
      const { html, cookies } = await get(url);
      const tg = /data-active-tg="(\d+)"/.exec(html)?.[1];
      if (!tg) return { items: [], pages: 0 };
      const items = [];
      let pages = 1;
      for (let p = 1; p <= Math.min(pages, maxPages); p++) {
        await pause();
        const fd = new FormData();
        fd.append('filter', '()'); fd.append('id', tg); fd.append('view', 'plate'); fd.append('brand', '[]'); fd.append('page', String(p));
        const r = await fetchImpl(`${BASE}/catalog/getproductlist`, { method: 'POST', body: fd, headers: { 'User-Agent': UA, Cookie: cookies, Referer: url } });
        if (!r.ok) { log.warn?.(`[merlion] список ${url} стр. ${p}: ответ ${r.status}`); break; }
        const res = parseList(await r.text());
        if (!res.items.length) break;
        items.push(...res.items);
        pages = res.pages;
      }
      return { items, pages };
    },
    /** Карточка товара с характеристиками. */
    async card(id) {
      const url = `${BASE}/catalog/product/${id}/`;
      return { url, ...parseCard((await get(url)).html) };
    },
  };
}

module.exports = { createMerlion, parseSitemap, parseList, parseCard };
