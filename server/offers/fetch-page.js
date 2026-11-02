// Вежливая загрузка страниц продавцов: robots.txt, пауза между запросами к одному сайту, таймаут,
// лимит размера, кодировка (utf-8 / windows-1251), HTML → текст, структурированные данные schema.org.

// Только ASCII: заголовки HTTP не допускают кириллицу.
const UA = 'Mozilla/5.0 (compatible; tender-ai/0.1; supplier search for public procurement)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Страница пропущена. closed — сайт целиком закрыт для роботов (401/403, «я не робот»): его можно не пробовать какое-то время. */
// Сайты соседних стран: цены в другой валюте, поставка в Россию под вопросом.
const FOREIGN_TLD = /\.(uz|kz|by|ua|kg|am|az|md|tj|tm|ge)$/i;
const foreignDomain = (d) => FOREIGN_TLD.test(String(d || ''));

class FetchSkipped extends Error {
  // kind — причина одним словом для воронки поиска (funnel.js → PAGE_REASONS)
  constructor(message, { closed = false, kind = null } = {}) { super(message); this.closed = closed; this.kind = kind; }
}

// ---------- защита от обращений к внутренним адресам (SSRF) ----------
// Ссылки приходят из поисковой выдачи и со страниц продавцов — это недоверенные данные. Страницы магазинов не бывают
// на локальных, служебных и внутренних адресах: такие адреса (и переадресации на них) не открываем.
const net = require('node:net');
function privateAddress(ip) {
  const a = String(ip).replace(/^::ffff:/i, '');
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
      || (x === 100 && y >= 64 && y <= 127) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
  }
  const v6 = a.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}
async function assertPublicUrl(u, lookup) {
  if (!/^https?:$/.test(u.protocol)) throw new FetchSkipped('адрес не http/https — не открываем', { kind: 'unsafe' });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.+\.localhost|.+\.local|.+\.internal|.+\.intranet|metadata(\..+)?)$/i.test(host)) throw new FetchSkipped('внутренний адрес — не открываем', { kind: 'unsafe' });
  if (net.isIP(host)) { if (privateAddress(host)) throw new FetchSkipped('внутренний адрес — не открываем', { kind: 'unsafe' }); return; }
  if (!lookup) return;
  let addrs = [];
  try { addrs = await lookup(host, { all: true }); } catch { throw new FetchSkipped('сайт не найден (DNS)', { kind: 'no_response' }); }
  if (addrs.some((x) => privateAddress(x.address))) throw new FetchSkipped('адрес сайта указывает во внутреннюю сеть — не открываем', { kind: 'unsafe' });
}

function createPageFetcher({ fetchImpl = fetch, minIntervalMs = 2000, timeoutMs = 20000, maxBytes = 3 * 1024 * 1024, clock = () => Date.now(), lookup = undefined } = {}) {
  // настоящая сеть — проверяем, куда ведёт имя сайта; в тестах (подменённый fetch) DNS не трогаем
  const resolve = lookup !== undefined ? lookup : fetchImpl === fetch ? require('node:dns').promises.lookup : null;
  const robotsCache = new Map(); // origin → rules | null
  const lastHit = new Map();     // host → время последнего запроса

  async function politeWait(host) {
    const wait = (lastHit.get(host) || 0) + minIntervalMs - clock();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, clock());
  }

  async function rawFetch(url, { limit = maxBytes } = {}) {
    let u = new URL(url);
    let res;
    // переадресации проходим сами: каждую цель проверяем, не внутренний ли это адрес (не больше пяти переходов)
    for (let hop = 0; ; hop++) {
      await assertPublicUrl(u, resolve);
      await politeWait(u.host);
      try {
        res = await fetchImpl(u, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'ru' }, signal: AbortSignal.timeout(timeoutMs), redirect: resolve ? 'manual' : 'follow' });
      } catch (err) {
        throw new FetchSkipped(`сайт не ответил (${err.cause?.code || err.cause?.message || err.message})`, { kind: 'no_response' });
      }
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc || !resolve) break;
      if (hop >= 5) throw new FetchSkipped('слишком много переадресаций', { kind: 'http' });
      u = new URL(loc, u);
    }
    if (resolve && !res.url) Object.defineProperty(res, 'url', { value: u.href });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new FetchSkipped('страница слишком большая', { kind: 'too_big' });
    return { res, buf };
  }

  async function robotsFor(url) {
    const { origin } = new URL(url);
    if (robotsCache.has(origin)) return robotsCache.get(origin);
    let rules = null;
    try {
      const { res, buf } = await rawFetch(`${origin}/robots.txt`);
      if (res.ok) rules = parseRobots(decode(buf, res.headers.get('content-type')));
    } catch {
      rules = null; // нет robots.txt — ограничений нет
    }
    robotsCache.set(origin, rules);
    return rules;
  }

  /**
   * @returns {Promise<{url, status, html, text, structured}>}
   * @throws FetchSkipped — страница запрещена robots.txt, капча/блокировка, ошибка сети
   */
  async function fetchPage(url) {
    const rules = await robotsFor(url);
    const u = new URL(url);
    if (rules && !isAllowed(rules, u.pathname + u.search)) throw new FetchSkipped('сайт запрещает автоматический доступ к этой странице (robots.txt)', { kind: 'robots' });
    const { res, buf } = await rawFetch(url);
    if (res.status === 401 || res.status === 403 || res.status === 429) throw new FetchSkipped(`сайт закрыт от автоматического доступа (HTTP ${res.status})`, { closed: res.status !== 429, kind: 'denied' });
    if (res.status === 498) throw new FetchSkipped('сайт закрыт от автоматического доступа (HTTP 498)', { closed: true, kind: 'denied' });
    if (!res.ok) throw new FetchSkipped(`сайт ответил ${res.status}`, { kind: 'http' });
    const html = decode(buf, res.headers.get('content-type'));
    if (looksLikeChallenge(html)) throw new FetchSkipped('на сайте проверка «я не робот» — пропускаем', { closed: true, kind: 'captcha' });
    return { url: res.url || url, status: res.status, html, text: htmlToText(html), structured: extractStructured(html, res.url || url) };
  }

  /**
   * Файл со страницы продавца (PDF-паспорт): те же robots.txt, защита адресов и пауза, свой лимит размера.
   * @returns {Promise<{url, buf, type}>}
   */
  async function fetchFile(url, { maxBytes: limit = 8 * 1024 * 1024 } = {}) {
    const rules = await robotsFor(url);
    const u = new URL(url);
    if (rules && !isAllowed(rules, u.pathname + u.search)) throw new FetchSkipped('сайт запрещает автоматический доступ к этому файлу (robots.txt)', { kind: 'robots' });
    const { res, buf } = await rawFetch(url, { limit });
    if (!res.ok) throw new FetchSkipped(`сайт ответил ${res.status}`, { kind: 'http' });
    return { url: res.url || url, buf, type: res.headers.get('content-type') || '' };
  }

  return { fetchPage, fetchFile, robotsFor };
}

// ---------- robots.txt ----------
function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      if (val) cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a.includes('tender-ai')));
  return (mine || groups.find((g) => g.agents.includes('*')) || { rules: [] }).rules;
}

function ruleToRegex(p) {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body.startsWith('.*') || body.startsWith('/') ? '' : '/'}${body}${anchored ? '$' : ''}`);
}

/** Самое длинное совпавшее правило побеждает; при равной длине — Allow. */
function isAllowed(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!ruleToRegex(r.path).test(path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

// ---------- HTML ----------
function decode(buf, contentType) {
  let charset = /charset=([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1];
  charset = (charset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset === 'cp1251' ? 'windows-1251' : charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', ndash: '–', mdash: '—', rub: '₽' };

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|section|article|td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function looksLikeChallenge(html) {
  const head = html.slice(0, 20000).toLowerCase();
  return /(captcha|ddos-guard|qrator|cf-challenge|проверка браузера|вы не робот|showcaptcha)/.test(head) && html.length < 60000;
}

/** Товары из JSON-LD (schema.org Product / Offer / OfferCatalog) и микроразметки itemprop. */
function extractStructured(html, pageUrl) {
  const out = [];
  const push = (o, fallbackName) => {
    const offer = [].concat(o.offers || o).find((x) => x && (x.price != null || x.lowPrice != null)) || null;
    if (!offer) return;
    const price = Number(String(offer.price ?? offer.lowPrice).replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(price) || price <= 0) return;
    out.push({
      title: String(o.name || fallbackName || '').trim(),
      price,
      currency: offer.priceCurrency || 'RUB',
      url: o.url || offer.url || pageUrl,
      availability: offer.availability ? String(offer.availability).split('/').pop() : null,
      // сколько единиц на складе, если магазин указал это в разметке (schema.org inventoryLevel)
      stock: offer.inventoryLevel ?? null,
      seller_name: offer.seller?.name || null,
      // Карточка товара: фото и характеристики из разметки — чтобы показать сам товар, а не только цену.
      image: [].concat(o.image || [])[0]?.url || [].concat(o.image || [])[0]?.contentUrl || (typeof [].concat(o.image || [])[0] === 'string' ? [].concat(o.image)[0] : null),
      props: [].concat(o.additionalProperty || []).filter((x) => x && x.name && x.value != null)
        .map((x) => ({ name: String(x.name).trim(), value: String(x.value).trim() })).filter((x) => x.name.length <= 70 && x.value.length <= 140).slice(0, 15),
      brand: (typeof o.brand === 'string' ? o.brand : o.brand?.name) || null,
      model: o.model?.name || (typeof o.model === 'string' ? o.model : null) || o.mpn || null,
      // «от … до …» по разделу каталога (AggregateOffer с большим разбросом) — это не цена товара
      range: offer.price == null && Number(offer.highPrice) > price * 1.5,
    });
  };
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const type = [].concat(node['@type'] || []).join(',');
      if (/Product/.test(type)) push(node);
      else if (/^Offer$/.test(type) && (node.name || node.itemOffered)) push({ name: node.name || node.itemOffered?.name, url: node.url, offers: node });
      if (node['@graph']) walk(node['@graph']);
      if (node.itemListElement) walk(node.itemListElement);
      if (node.item) walk(node.item);
    };
    walk(data);
  }
  if (!out.length) {
    const pm = /itemprop=["']price["'][^>]*content=["']([\d\s.,]+)["']/i.exec(html);
    const price = pm?.[1];
    const name = /itemprop=["']name["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
    // У самого товара цена «по запросу», а первая цена в разметке — у сопутствующего товара ниже по странице
    // (printer-plotter.ru: МФУ «Запросить цену», следом бумага за 640 ₽). Такая цена — не цена товара.
    const h1At = html.search(/<h1[\s>]/i);
    const before = pm && h1At >= 0 && pm.index > h1At ? htmlToText(html.slice(h1At, pm.index)) : '';
    const onRequest = /запросить\s+цену|цена\s+по\s+запросу|цену\s+уточняйте|уточнит[ье]\s+цену|узнать\s+цену/i.test(before);
    if (price && !onRequest) push({ name: name ? htmlToText(name) : '', offers: { price } });
  }
  return out;
}

module.exports = { foreignDomain, createPageFetcher, parseRobots, isAllowed, htmlToText, extractStructured, decode, FetchSkipped, looksLikeChallenge, privateAddress, assertPublicUrl };
