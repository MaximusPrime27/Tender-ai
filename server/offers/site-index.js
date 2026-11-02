// Каталог страниц оптовых поставщиков — собственный указатель «модель товара → страницы у поставщиков».
//
// Зачем. Поисковик приводит в основном на крупные розничные сети: они лучше всех продвинуты и дороже всех продают.
// Оптовые и оптово-розничные поставщики в выдаче теряются, хотя цены у них ниже. Поэтому их страницы ищем сами:
// раз в неделю читаем карты сайтов (sitemap.xml — список адресов, который магазин сам публикует для роботов)
// и складываем адреса страниц товаров в отдельную базу. Модель товара («ST8000NE0001», «M6607NW») почти всегда
// есть в адресе страницы, поэтому найти её сразу у всех поставщиков — один запрос к своей базе:
// бесплатно, без поисковика и за миллисекунды. Цену и характеристики потом читаем со страницы, как обычно.
//
// База отдельная (<DATA_DIR>/suppliers.db): её можно удалить и собрать заново, рабочие данные она не раздувает.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const UA = 'Mozilla/5.0 (compatible; tender-ai/0.1; supplier search for public procurement)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compact = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-z0-9а-я]/g, '');

// Не товары: картинки, статьи, новости, бренды, отзывы, служебные страницы.
const NOT_PRODUCT = /\.(jpe?g|png|gif|webp|svg|pdf|docx?|xlsx?|zip|mp4)(\?|$)|\/(news|novosti|blog|articles?|stati|press|reviews?|otzyvy|brands?|brendy|tags?|vacanc|vakans|about|contacts?|kontakty|help|faq|actions?|akcii|promo|sale|compare|cart|basket|login|auth|personal|account|stores?|shops?|magaziny|delivery|dostavka|payment|oplata|services?|uslugi|search|poisk|video|gallery|sertifikat|certificates?)(\/|$)/i;
// Карты сайта, в которых товаров нет.
const NOT_PRODUCT_MAP = /image|img|photo|news|novosti|blog|article|stati|brand|review|otzyv|tags?\b|video|static|files|info|pages?\b|posts?\b|store|city|gorod|region|filter|seo|landing|categor|section|razdel/i;
const PRODUCT_MAP = /product|goods|item|tovar|offer|catalog|katalog|element|detail|shop|sku|card/i;

/** Адрес страницы → ключ для поиска: путь без разделителей («/product/zhestkiy-disk-st8000ne0001/» → «productzhestkiydiskst8000ne0001»). */
function keyOf(url) {
  try {
    const u = new URL(url);
    let p = u.pathname;
    try { p = decodeURIComponent(p); } catch { /* битое кодирование — как есть */ }
    return compact(p);
  } catch {
    return '';
  }
}

/** Похожа ли страница на карточку товара: в адресе есть цифра (номер или модель) и нет признаков служебной страницы. */
const SUBPAGE = /\/(description|opisanie|reviews?|otzyvy|opinions?|characteristics?|harakteristiki|specs?|properties|questions?|faq|accessories|aksessuary|photos?|foto|video|instructions?|instrukcii|files|offers?|analogs?|analogi|comments?|delivery|credit|kredit)\/?$/i;

function looksLikeProduct(url) {
  if (NOT_PRODUCT.test(url) || SUBPAGE.test(String(url).split('?')[0])) return false;
  try {
    const u = new URL(url);
    if (u.search && /[?&](page|sort|order|filter|PAGEN_\d|view|limit)=/i.test(u.search)) return false;
    return /\d/.test(u.pathname) && u.pathname.length >= 8;
  } catch {
    return false;
  }
}

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

/**
 * Как название товара выглядит в адресе страницы: «Тонер-картридж» → «toner», «kartr»; «МФУ» → «mfu».
 * Берём начало слова: окончания магазины пишут по-разному («zhestkiy», «zhestkii»).
 * @param {string[]} words слова из наименования позиции
 */
function urlHints(words) {
  const out = new Set();
  for (const w of words || []) {
    const latin = String(w || '').toLowerCase().split('').map((ch) => TRANSLIT[ch] ?? ch).join('').replace(/[^a-z0-9]/g, '');
    if (latin.length >= 3) out.add(latin.slice(0, 5));
  }
  return [...out];
}

/**
 * Что искать в адресах: обозначения модели («ST8000NE0001») и, если обозначение короткое, модель целиком
 * («MagicBook X16» → «magicbookx16»). Слишком короткое (меньше 5 знаков) даёт случайные совпадения — не берём.
 * @param {string[]} models
 * @returns {string[]}
 */
function needlesOf(models) {
  const out = new Set();
  for (const raw of models || []) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const tokens = text.match(/(?=[A-Za-zА-Яа-яЁё0-9-]*\d)(?=[A-Za-zА-Яа-яЁё0-9-]*[A-Za-zА-Яа-яЁё])[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9-]{3,}/g) || [];
    const strong = tokens.map(compact).filter((t) => t.length >= 6 || (t.length === 5 && /\d{3}/.test(t)));
    if (strong.length) strong.forEach((t) => out.add(t));
    else if (compact(text).length >= 7 && /\d/.test(text) && text.split(/\s+/).length <= 5) out.add(compact(text));
  }
  return [...out];
}

function createSiteIndex({ dataDir, fetchImpl = fetch, log = console, clock = () => new Date(), minIntervalMs = 1200, maxFilesPerSite = 120, maxPagesPerSite = 700000, maxBytes = 90 * 1024 * 1024 } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'suppliers.db'));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS sites (domain TEXT PRIMARY KEY, refreshed_at TEXT, pages INTEGER NOT NULL DEFAULT 0, files INTEGER NOT NULL DEFAULT 0, status TEXT, note TEXT, first_row INTEGER, last_row INTEGER);
    CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(key, url UNINDEXED, domain UNINDEXED, tokenize='trigram', detail='none');`);
  // role: null — поставщик (страницы с ценой), 'official' — официальный сайт производителя (характеристики и паспорта,
  // цены там обычно нет): в поиске поставщиков такие страницы не берутся, ночной агент берёт их за характеристиками
  try { db.exec('ALTER TABLE sites ADD COLUMN role TEXT'); } catch { /* уже есть */ }

  let writing = Promise.resolve();

  async function getText(url, timeoutMs = 60000) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,text/plain,*/*' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok) return { status: res.status, text: '' };
    let buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: maxBytes });
    if (buf.length > maxBytes) return { status: 413, text: '' };
    return { status: res.status, text: buf.toString('utf8') };
  }

  const locs = (xml) => [...String(xml || '').matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].trim().replace(/&amp;/g, '&'));

  /**
   * Перечитать карту сайта одного поставщика. Старые страницы заменяются новыми одной операцией:
   * если сайт не ответил, прежний список остаётся.
   * @returns {Promise<{domain, pages, files, status, note}>}
   */
  async function refresh(domain, { maxPages = maxPagesPerSite, role = null } = {}) {
    const host = String(domain).replace(/^www\./, '');
    const sameSite = (u) => { try { const h = new URL(u).hostname.replace(/^www\./, ''); return h === host || h.endsWith(`.${host}`); } catch { return false; } };
    const queue = [];
    let note = '';
    // Сайт может жить и на «www.», и без него: берём тот адрес, где отвечает robots.txt; в нём же — адреса карт сайта.
    for (const origin of [`https://${host}`, `https://www.${host}`]) {
      try {
        const robots = await getText(`${origin}/robots.txt`, 15000);
        if (robots.status !== 200 || /<html/i.test(robots.text.slice(0, 300))) continue;
        for (const m of robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
        if (!queue.length) queue.push(`${origin}/sitemap.xml`);
        note = '';
        break;
      } catch (err) {
        note = `robots.txt: ${err.cause?.code || err.message}`;
      }
    }
    if (!queue.length) queue.push(`https://${host}/sitemap.xml`, `https://www.${host}/sitemap.xml`);
    const urls = new Map(); // url → key
    const seen = new Set();
    let files = 0;
    while (queue.length && files < maxFilesPerSite && urls.size < maxPages) {
      const u = queue.shift();
      if (seen.has(u) || !sameSite(u)) continue;
      seen.add(u);
      files++;
      await sleep(minIntervalMs);
      let got;
      try { got = await getText(u); } catch (err) { note = `${u.split('/').pop()}: ${err.cause?.code || err.message}`; continue; }
      if (got.status !== 200) { note = `${u.split('/').pop()}: HTTP ${got.status}`; continue; }
      const list = locs(got.text);
      if (/<sitemapindex/i.test(got.text)) {
        // Сначала карты с товарами; карты картинок, новостей и статей не читаем вовсе.
        const name = (x) => { try { return new URL(x).pathname.split('/').pop().replace(/sitemap/gi, ''); } catch { return x; } };
        const useful = list.filter((x) => PRODUCT_MAP.test(name(x)) || !NOT_PRODUCT_MAP.test(name(x)));
        queue.unshift(...useful.sort((a, b) => Number(PRODUCT_MAP.test(name(b))) - Number(PRODUCT_MAP.test(name(a)))));
        continue;
      }
      for (const loc of list) {
        if (urls.size >= maxPages) break;
        if (!sameSite(loc) || !looksLikeProduct(loc)) continue;
        const key = keyOf(loc);
        if (key.length >= 8) urls.set(loc, key);
      }
    }
    const at = clock().toISOString();
    if (!urls.size) {
      const prev = db.prepare('SELECT pages FROM sites WHERE domain = ?').get(host);
      db.prepare(`INSERT INTO sites (domain, refreshed_at, pages, files, status, note) VALUES (?, ?, ?, ?, 'empty', ?)
        ON CONFLICT(domain) DO UPDATE SET refreshed_at = excluded.refreshed_at, files = excluded.files, status = 'empty', note = excluded.note`)
        .run(host, at, prev?.pages || 0, files, note || 'в карте сайта нет страниц товаров');
      return { domain: host, pages: prev?.pages || 0, files, status: 'empty', note: note || 'в карте сайта нет страниц товаров' };
    }
    const write = async () => {
      const ins = db.prepare('INSERT INTO pages (key, url, domain) VALUES (?, ?, ?)');
      db.exec('BEGIN');
      try {
        // Страницы сайта лежат подряд (сайты читаются по одному) — старые удаляем по диапазону номеров строк, это быстро.
        const prev = db.prepare('SELECT first_row, last_row FROM sites WHERE domain = ?').get(host);
        if (prev?.first_row != null) db.prepare('DELETE FROM pages WHERE rowid BETWEEN ? AND ?').run(prev.first_row, prev.last_row);
        let n = 0;
        let first = null;
        let last = null;
        for (const [url, key] of urls) {
          last = Number(ins.run(key, url, host).lastInsertRowid);
          if (first == null) first = last;
          // Вставка сотен тысяч строк идёт секунды — отдаём управление, чтобы сайт не «замирал».
          if (++n % 20000 === 0) await new Promise(setImmediate);
        }
        db.prepare(`INSERT INTO sites (domain, refreshed_at, pages, files, status, note, first_row, last_row, role) VALUES (?, ?, ?, ?, 'ok', ?, ?, ?, ?)
          ON CONFLICT(domain) DO UPDATE SET refreshed_at = excluded.refreshed_at, pages = excluded.pages, files = excluded.files, status = 'ok',
            note = excluded.note, first_row = excluded.first_row, last_row = excluded.last_row, role = excluded.role`)
          .run(host, at, urls.size, files, note, first, last, role);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    };
    // Карты разных сайтов читаются одновременно, а в базу пишем по одному сайту: страницы сайта должны лежать подряд.
    const turn = writing.then(write, write);
    writing = turn.catch(() => {});
    await turn;
    return { domain: host, pages: urls.size, files, status: 'ok', note };
  }

  let running = null;
  /**
   * Обновить каталоги поставщиков, которые не читались дольше maxAgeDays.
   * @param {string[]} domains
   * @param {{maxAgeDays?: number, concurrency?: number, onProgress?: Function}} p concurrency — сколько сайтов читать одновременно
   */
  // official — официальные сайты производителей: в каталоге помечены и ограничены officialMaxPages страницами (сайты огромные)
  function refreshAll(domains, { maxAgeDays = 7, concurrency = 2, onProgress = null, official = [], officialMaxPages = 20000 } = {}) {
    const officialSet = new Set(official.map((d) => String(d).replace(/^www\./, '')));
    domains = [...new Set([...domains, ...officialSet])];
    if (running) return running;
    running = (async () => {
      const out = [];
      const fresh = clock().getTime() - maxAgeDays * 86400000;
      // Сайт, который в прошлый раз не ответил или отдал пустую карту, пробуем снова через сутки, а не через неделю.
      const retry = clock().getTime() - Math.min(1, maxAgeDays) * 86400000;
      const due = domains.map((d) => String(d).replace(/^www\./, '')).filter((d) => {
        const row = db.prepare('SELECT refreshed_at, status FROM sites WHERE domain = ?').get(d);
        return !row?.refreshed_at || new Date(row.refreshed_at).getTime() < (row.status === 'ok' ? fresh : retry);
      });
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < due.length) {
          const domain = due[next++];
          try {
            const r = await refresh(domain, officialSet.has(domain) ? { maxPages: officialMaxPages, role: 'official' } : {});
            out.push(r);
            log.log?.(`[suppliers] ${r.domain}: ${r.status === 'ok' ? `страниц товаров ${r.pages}` : r.note} (файлов карты: ${r.files})`);
          } catch (err) {
            out.push({ domain, status: 'error', note: err.message });
            log.warn?.(`[suppliers] ${domain}: ${err.message}`);
          }
          onProgress?.({ domain, current: ++done, total: due.length });
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, due.length)) }, worker));
      // Сайты, которых больше нет в списке поставщиков, из каталога убираем.
      const keep = new Set(domains.map((d) => String(d).replace(/^www\./, '')));
      for (const row of db.prepare('SELECT domain FROM sites').all()) {
        if (keep.has(row.domain)) continue;
        const range = db.prepare('SELECT first_row, last_row FROM sites WHERE domain = ?').get(row.domain);
        if (range?.first_row != null) db.prepare('DELETE FROM pages WHERE rowid BETWEEN ? AND ?').run(range.first_row, range.last_row);
        db.prepare('DELETE FROM sites WHERE domain = ?').run(row.domain);
      }
      return out;
    })().finally(() => { running = null; });
    return running;
  }

  /**
   * Страницы поставщиков, в адресе которых есть модель товара.
   * @param {string[]} models модели и названия с моделью
   * @param {{perDomain?: number, limit?: number, hints?: string[], skip?: (url: string, domain: string, needle: string) => boolean}} p
   *   hints — как название товара пишется в адресах (urlHints): страница с ним — раньше остальных страниц с той же моделью
   * @returns {Array<{url, domain, needle}>} у каждого поставщика — самые короткие адреса (это обычно сама карточка товара)
   */
  // withOfficial — брать и страницы официальных сайтов производителей (по умолчанию нет: цены там нет, это не поставщик)
  function find(models, { perDomain = 1, limit = 10, hints = [], skip = null, withOfficial = false } = {}) {
    const out = [];
    const official = new Set(db.prepare("SELECT domain FROM sites WHERE role = 'official'").all().map((r) => r.domain));
    const taken = new Map();
    const seen = new Set();
    for (const needle of needlesOf(models)) {
      // В ключе разделители убраны («fp502-1kl» → «fp5021kl»), поэтому проверяем по самому адресу: модель должна стоять целым словом.
      const whole = new RegExp(`(^|[^a-z0-9а-я])${needle.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-_.~ ]?')}([^a-z0-9а-я]|$)`, 'i');
      const pathOf = (u) => { try { return decodeURIComponent(new URL(u).pathname).toLowerCase().replace(/ё/g, 'е'); } catch { return String(u).toLowerCase(); } };
      const rows = db.prepare('SELECT url, domain FROM pages WHERE key LIKE ? LIMIT 3000').all(`%${needle}%`).filter((r) => whole.test(pathOf(r.url)) && (withOfficial || !official.has(r.domain)));
      // Сначала сам товар, потом принадлежности к нему («…-dlya-mfu-m6607nw»): у них в адресе та же модель.
      const accessory = (u) => (/[-_/](dlya|for|k)[-_]|zapchast|zapravk|remont|vosstanovl|chehol|sumka|kabel-dlya|kartridzh-dlya|[-_/]chip([-_/.]|$)|rakel|rolik|shestern|termoplen|kreplen/i.test(u) ? 1 : 0);
      const named = (u) => (hints.length && hints.some((h) => u.toLowerCase().includes(h)) ? 0 : 1);
      rows.sort((a, b) => accessory(a.url) - accessory(b.url) || named(a.url) - named(b.url) || a.url.length - b.url.length);
      for (const r of rows) {
        if (out.length >= limit) return out;
        if (seen.has(r.url) || (taken.get(r.domain) || 0) >= perDomain || skip?.(r.url, r.domain, needle)) continue;
        seen.add(r.url);
        taken.set(r.domain, (taken.get(r.domain) || 0) + 1);
        out.push({ url: r.url, domain: r.domain, needle });
      }
    }
    return out;
  }

  /**
   * Страницы поставщиков по словам названия товара, когда модели нет: «Шпатель для языка смотровой» → адреса, где есть
   * и «shpat», и «yazyk» (все основы, транслитом). Бесплатная замена платному поиску для товаров без модели.
   * @param {string[]} words — вид товара первым, дальше отличительные слова; берутся основы из 5 букв
   * @returns {Array<{url, domain}>}
   */
  function findByWords(words, { perDomain = 1, limit = 10, skip = null, need = null } = {}) {
    const stems = urlHints(words);
    if (!stems.length) return [];
    const must = need ?? Math.min(stems.length, 2);
    const official = new Set(db.prepare("SELECT domain FROM sites WHERE role = 'official'").all().map((r) => r.domain));
    const rows = db.prepare('SELECT url, domain FROM pages WHERE key LIKE ? LIMIT 5000').all(`%${stems[0]}%`)
      .filter((r) => !official.has(r.domain) && looksLikeProduct(r.url))
      .map((r) => ({ ...r, hits: stems.filter((s) => r.url.toLowerCase().includes(s)).length }))
      .filter((r) => r.hits >= must)
      .sort((a, b) => b.hits - a.hits || a.url.length - b.url.length);
    const out = [];
    const taken = new Map();
    for (const r of rows) {
      if (out.length >= limit) break;
      if ((taken.get(r.domain) || 0) >= perDomain || skip?.(r.url, r.domain)) continue;
      taken.set(r.domain, (taken.get(r.domain) || 0) + 1);
      out.push({ url: r.url, domain: r.domain });
    }
    return out;
  }

  /**
   * Страницы официальных сайтов производителей, в адресе которых есть одно из слов («kreslo», «stellazh», «стол»): так
   * ночной агент находит товары нужного вида, когда модели в ТЗ нет (мебель). От каждого сайта — не больше perDomain,
   * сайты и страницы — вперемешку (random), чтобы за несколько ночей пройти разные фабрики.
   * @returns {Array<{url, domain}>}
   */
  function sample(words, { limit = 20, perDomain = 3, skip = null, random = Math.random } = {}) {
    const official = new Set(db.prepare("SELECT domain FROM sites WHERE role = 'official'").all().map((r) => r.domain));
    if (!official.size) return [];
    const rows = [];
    const seen = new Set();
    for (const w of words || []) {
      const k = compact(w);
      if (k.length < 3) continue;
      for (const r of db.prepare('SELECT url, domain FROM pages WHERE key LIKE ? LIMIT 3000').all(`%${k}%`)) {
        if (!official.has(r.domain) || seen.has(r.url) || !looksLikeProduct(r.url)) continue;
        seen.add(r.url);
        rows.push(r);
      }
    }
    const shuffled = rows.map((r) => ({ r, k: random() })).sort((a, b) => a.k - b.k).map((x) => x.r);
    const out = [];
    const taken = new Map();
    for (const r of shuffled) {
      if (out.length >= limit) break;
      if ((taken.get(r.domain) || 0) >= perDomain || skip?.(r.url, r.domain)) continue;
      taken.set(r.domain, (taken.get(r.domain) || 0) + 1);
      out.push(r);
    }
    return out;
  }

  /** Что в каталоге: по каждому сайту — сколько страниц и когда обновлялся. */
  function status() {
    const sites = db.prepare('SELECT domain, refreshed_at, pages, files, status, note, role FROM sites ORDER BY pages DESC').all();
    // поставщики и официальные сайты производителей — отдельно: в строке источников поиска — только поставщики
    const shops = sites.filter((s) => s.role !== 'official');
    const official = sites.filter((s) => s.role === 'official' && s.status === 'ok');
    return {
      sites: shops, pages: shops.reduce((n, s) => n + (s.status === 'ok' ? s.pages : 0), 0), ready: shops.filter((s) => s.status === 'ok').length, running: Boolean(running),
      official: { sites: official.length, pages: official.reduce((n, s) => n + s.pages, 0) },
    };
  }

  return { refresh, refreshAll, find, findByWords, sample, status, close: () => db.close(), idle: () => running || Promise.resolve() };
}

module.exports = { createSiteIndex, keyOf, looksLikeProduct, needlesOf, urlHints };
