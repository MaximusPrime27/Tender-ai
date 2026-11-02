// Бесплатный поиск товара на сайте поставщика — по карте сайта (sitemap.xml).
// Карту сайта магазины публикуют для роботов: это список адресов всех страниц. Если в адресе страницы есть модель
// товара («…/kartridzh-hp-cf259x/»), это, скорее всего, страница этого товара. Платный запрос к поисковику не нужен.

const UA = 'Mozilla/5.0 (compatible; tender-ai/0.1; supplier search for procurement)';
const MAX_BYTES = 6 * 1024 * 1024; // одна карта — не больше 6 МБ
const MAX_FILES = 6;               // карт на один сайт
const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9а-яё]/g, '');

async function getText(url, { fetchImpl, timeoutMs = 15000 }) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,*/*' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) return null;
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES || (buf[0] === 0x1f && buf[1] === 0x8b)) return null; // слишком большая или сжатая .gz — пропускаем
  return buf.toString('utf8');
}

const locs = (xml) => [...String(xml || '').matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].trim().replace(/&amp;/g, '&'));

/**
 * Страницы сайта, в адресе которых есть модель товара.
 * @param {string} domain сайт поставщика
 * @param {string} model модель или артикул («CF259X», «TK-5240K»)
 * @returns {Promise<string[]>} адреса страниц (не больше limit), самые короткие — первыми: это обычно сама карточка товара
 */
async function findInSitemap(domain, model, { fetchImpl = fetch, limit = 3, log = console } = {}) {
  const needle = compact(model);
  if (!domain || needle.length < 4) return [];
  const queue = [];
  try {
    const robots = await getText(`https://${domain}/robots.txt`, { fetchImpl, timeoutMs: 8000 });
    for (const m of String(robots || '').matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  } catch { /* robots.txt недоступен — попробуем стандартный адрес */ }
  if (!queue.length) queue.push(`https://${domain}/sitemap.xml`);

  const found = [];
  const seen = new Set();
  let files = 0;
  while (queue.length && files < MAX_FILES && found.length < limit * 3) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    files++;
    let xml;
    try { xml = await getText(url, { fetchImpl }); } catch (err) { log.warn?.(`[sitemap] ${domain}: ${err.message}`); continue; }
    if (!xml) continue;
    const list = locs(xml);
    if (/<sitemapindex/i.test(xml)) {
      // Индекс карт: сначала те, что похожи на каталог товаров.
      // Смотрим только путь: в самом домене слово «shop» встречается часто и ничего не значит.
      // И без самого слова «sitemap»: в нём есть «item».
      const pathOf = (u) => { try { return new URL(u).pathname.replace(/sitemap/gi, ''); } catch { return u; } };
      const rank = (u) => (/product|catalog|goods|item|shop|tovar|katalog/i.test(pathOf(u)) ? 0 : 1);
      queue.unshift(...list.filter((u) => !/\.gz$/i.test(u)).sort((a, b) => rank(a) - rank(b)));
      continue;
    }
    for (const u of list) if (compact(u).includes(needle)) found.push(u);
  }
  return [...new Set(found)].sort((a, b) => a.length - b.length).slice(0, limit);
}

module.exports = { findInSitemap };
