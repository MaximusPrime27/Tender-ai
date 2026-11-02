// Источник закупок: коммерческие закупки на Росэлторге (раздел «Коммерческие закупки», секция Росэлторг.Бизнес и др.).
// Это закупки компаний вне 44-ФЗ и 223-ФЗ — в ЕИС их нет. Тем же поиском — госзакупки 44/223-ФЗ (разделы 44fz, 223fz,
// ROSELTORG_EIS_PAGES страниц на слово): номер процедуры у них — номер ЕИС, в ленту они приходят раньше, чем из ГосПлана;
// позиции и документы к ним дают ГосПлан и ЕИС.
//
// Список берём со страницы поиска процедур (её отдаёт сам сайт, без скриптов); robots.txt Росэлторга страницу
// /procedures/search не запрещает. Пауза между запросами — ROSELTORG_DELAY_MS (по умолчанию 5 с), страниц на слово —
// ROSELTORG_MAX_PAGES. Позиции (наименование, ОКПД2, количество) — со страницы процедуры, документы — оттуда же.
// Закупка в сервисе: закон «com», номер «B0210261252594/1» (процедура/лот).

const BASE = 'https://www.roseltorg.ru';
const UA = 'Mozilla/5.0 (compatible; tender-ai/0.1; supplier search for procurement)';

const decode = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const between = (s, re) => re.exec(s)?.[1] ?? null;

/** «85 970<sub>,00</sub> ₽» → 85970 */
function money(html) {
  const t = text(String(html || '').replace(/<sub>/gi, '').replace(/<\/sub>/gi, ''));
  const m = /(\d[\d\s]*)(?:[,.](\d{1,2}))?/.exec(t.replace(/ /g, ' '));
  if (!m) return null;
  const v = Number(`${m[1].replace(/\s/g, '')}.${m[2] || '0'}`);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** «08.10.2026 в 07:59» (московское время) → ISO UTC */
function moscowDate(s) {
  const m = /(\d{2})\.(\d{2})\.(\d{4})(?:\s*(?:в\s*)?(\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], (m[4] ? +m[4] : 23) - 3, m[5] ? +m[5] : 59)).toISOString();
}

/**
 * Разбор страницы поиска процедур.
 * @returns {Array<object>} закупки в формате сервиса (law: 'com')
 */
/**
 * Карточки поиска процедур.
 * @param {string} law 'com' — коммерческий раздел; '44' / '223' — госзакупки: номер процедуры на Росэлторге и есть
 *   номер ЕИС (19 или 11 цифр), закупка получает его — так она склеится с той же закупкой из ГосПлана и ЕИС
 */
function parseSearch(html, law = 'com') {
  const out = [];
  const seen = new Set();
  const blocks = String(html).split(/<div class="search-results__item\b/).slice(1);
  for (const b of blocks) {
    const proc = between(b, /data-feature-favorite-lots-procedure-number="([^"]+)"/);
    const lot = between(b, /data-feature-favorite-lots-lot-number="(\d+)"/) || '1';
    if (!proc) continue;
    const type = text(between(b, /class="search-results__type">([\s\S]*?)<\/p>/));
    // В коммерческом разделе есть и продажа имущества, аренда — это не закупки.
    if (/продаж|аренд|реализац/i.test(type)) continue;
    const title = text(between(b, /search-results__link--description[^>]*>([\s\S]*?)<\/a>/));
    const regionText = text(between(b, /title="Регион заказчика">([\s\S]*?)<\/p>/));
    const customer = /href="\/companies\/resolve\/(\d{10,12})\/[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    const deadline = between(text(between(b, /search-results__timing">([\s\S]*?)<\/div>\s*<\/div>/) || ''), /Окончание при[её]ма заявок\s*([\d.]+\s*(?:в\s*)?[\d:]*)/i);
    // у госзакупки лоты — одна закупка ЕИС; номер без номера ЕИС не склеить — такую карточку не берём
    if (law !== 'com' && (!(law === '44' ? /^\d{19}$/ : /^\d{11}$/).test(proc) || seen.has(proc))) continue;
    seen.add(proc);
    out.push({
      law,
      number: law === 'com' ? `${proc}/${lot}` : proc,
      title: title || `Коммерческая закупка ${proc}`,
      price: money(between(b, /<p class="desktop">([\s\S]*?)<\/p>/)),
      currency: 'RUB',
      region: Number(/^(\d{1,3})\./.exec(regionText)?.[1]) || null,
      okpd2: [],
      ktru: [],
      customer_inn: customer?.[1] || null,
      customer_name: customer ? text(customer[2]) : null,
      published_at: null,
      deadline_at: moscowDate(deadline),
      stage: 1,
      eis_url: `${BASE}/procedure/${proc}/${lot}`,
      section: text(between(b, /title="Торговая секция">([\s\S]*?)<\/p>/)) || null,
      tags: [...new Set([...b.matchAll(/class="chip">([^<]+)<\/a>/g)].map((m) => text(m[1])))].slice(0, 8),
      source_name: 'roseltorg',
    });
  }
  return out;
}

/** Позиции и документы со страницы процедуры. */
function parseProcedure(html, pageUrl = BASE) {
  const s = String(html);
  const items = String(s).split(/<div class="lot-units__item">/).slice(1).map((b) => {
    const okpd = text(between(b, /class="lot-unit__okpd-name"\s*>([\s\S]*?)<\/div>/));
    const qty = Number(String(text(between(b, /class="lot-unit__quantity">([\s\S]*?)<\/div>/))).replace(/\s/g, '').replace(',', '.'));
    const priceCol = between(b, /lot-unit__col--3">([\s\S]*?)<\/div>\s*<\/div>/) || '';
    const unitPrice = /не указано/i.test(priceCol) ? null : money(priceCol);
    return {
      name: text(between(b, /class="lot-unit__name"\s*>([\s\S]*?)<\/div>/)),
      ktru_code: null,
      okpd2_code: /^(\d{2}(?:\.\d{1,3}){0,3})/.exec(okpd)?.[1] || null,
      characteristics: [],
      quantity: Number.isFinite(qty) && qty > 0 ? qty : null,
      unit: text(between(b, /class="lot-unit__okei"\s*>([\s\S]*?)<\/div>/)) || null,
      unit_price: unitPrice,
      sum: unitPrice != null && Number.isFinite(qty) ? Math.round(unitPrice * qty * 100) / 100 : null,
      source: 'notification',
    };
  }).filter((i) => i.name);
  const docsBlock = between(s, /class="lot-docs__list">([\s\S]*?)<\/ul>/) || '';
  const attachments = [...docsBlock.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => {
    let url;
    try { url = new URL(decode(m[1]), pageUrl).href; } catch { return null; }
    return { fileName: text(m[2]) || url.split('/').pop(), url, description: 'документ процедуры на Росэлторге' };
  }).filter(Boolean);
  // На странице — первые позиции; остальные сайт догружает кнопкой «Показать ещё» (/ajax/lot-units/…).
  const more = /js-lot-units-show-more"[\s\S]*?data-procedure-number="([^"]+)"[\s\S]*?data-lot-number="(\d+)"[\s\S]*?data-current-page="(\d+)"[\s\S]*?data-total-count="(\d+)"[\s\S]*?data-items-per-page="(\d+)"/.exec(s);
  const showMore = more ? { procedure: more[1], lot: more[2], nextPage: Number(more[3]), total: Number(more[4]), perPage: Number(more[5]) } : null;
  return { items, attachments, showMore };
}

/** Позиции из ответа «Показать ещё»: {"html": "<div class=\"lot-units__item\">…"} */
function parseUnitsChunk(json) {
  let html = '';
  try { html = JSON.parse(json).html || ''; } catch { html = String(json || ''); }
  return parseProcedure(`<div class="lot-units">${html}</div>`).items;
}

/** Росэлторг ли это закупка (номер «B…/лот»). */
const isRoseltorg = (t) => t?.law === 'com' && /^[A-ZА-Я]?\d+\/\d+$/.test(String(t.number || ''));

function createRoseltorgSource({ fetchImpl = fetch, delayMs = 5000, maxPages = 2, eisPages = 1, timeoutMs = 45000, log = console } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastRequest = 0;

  async function get(url) {
    const wait = lastRequest + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Росэлторг ответил ${res.status}`);
    return res.text();
  }

  /** Коммерческие закупки на этапе приёма заявок — по каждому ключевому слову (в перепродаже — словам направления). */
  async function fetchNew({ profile = {}, onPage = () => {}, onProgress = () => {} } = {}) {
    const kw = profile.focus_keywords?.length ? profile.focus_keywords : profile.keywords;
    // focus_keywords уже отобраны синхронизацией (первые слова каждого направления, не больше 15); свои слова профиля — первые 5.
    const words = kw?.length ? kw.slice(0, profile.focus_keywords?.length ? 15 : 5) : [''];
    const items = [];
    const errors = [];
    // разделы поиска: коммерческие закупки и госзакупки 44/223-ФЗ — они здесь видны в день публикации, раньше ГосПлана
    const wanted = profile.laws?.length ? profile.laws.map(String) : null;
    const places = [['com', 'com', maxPages], ['44', '44fz', eisPages], ['223', '223fz', eisPages]].filter(([law, , n]) => n > 0 && (!wanted || wanted.includes(law)));
    const steps = words.length * places.length;
    for (const [pi, [law, place, pages]] of places.entries()) for (const [wi, word] of words.entries()) {
      for (let p = 1; p <= pages; p++) {
        const step = pi * words.length + wi;
        onProgress({ done: step + (p - 1) / pages, total: steps, label: `Росэлторг${law === 'com' ? '' : `, ${law}-ФЗ`}${word ? `, «${word}»` : ''} (${step + 1} из ${steps})` });
        const url = new URL('/procedures/search', BASE);
        if (word) url.searchParams.set('query_field', word);
        url.searchParams.set('place', place);
        if (law === 'com') {
          url.searchParams.append('source[]', '24');
          url.searchParams.append('source[]', '20');
        }
        url.searchParams.append('status[]', '0'); // приём заявок
        url.searchParams.set('currency', 'all');
        if (p > 1) url.searchParams.set('page', String(p));
        let chunk;
        try {
          chunk = parseSearch(await get(url), law);
        } catch (err) {
          errors.push(`Росэлторг: ${err.message}`);
          break;
        }
        const fresh = chunk.filter((t) => (profile.price_min == null || t.price == null || t.price >= profile.price_min)
          && (profile.price_max == null || t.price == null || t.price <= profile.price_max));
        items.push(...fresh);
        await onPage(fresh);
        if (chunk.length < 10) break; // на странице 10 процедур: меньше — дальше пусто
      }
    }
    const seen = new Set();
    // truncated не поднимаем: окно загрузки по дате здесь не работает — свежие закупки всегда на первых страницах.
    return { items: items.filter((t) => !seen.has(t.number) && seen.add(t.number)), truncated: false, errors };
  }

  const procedureCache = new Map();
  /** Страница процедуры + догрузка остальных позиций (не больше 20 страниц по 5 — 100 позиций). */
  async function loadProcedure(number) {
    const p = parseProcedure(await get(`${BASE}/procedure/${number}`), `${BASE}/procedure/${number}`);
    const m = p.showMore;
    if (m && m.total > p.items.length) {
      const pages = Math.min(Math.ceil(m.total / m.perPage), 20);
      for (let page = m.nextPage; page <= pages; page++) {
        try {
          p.items.push(...parseUnitsChunk(await get(`${BASE}/ajax/lot-units/${encodeURIComponent(m.procedure)}/${m.lot}/${page}`)));
        } catch (err) {
          log.warn?.(`[roseltorg] позиции ${number}, стр. ${page}: ${err.message}`);
          break;
        }
      }
    }
    return p;
  }
  async function procedure(tender) {
    if (!procedureCache.has(tender.number)) {
      procedureCache.set(tender.number, loadProcedure(tender.number).catch((err) => { procedureCache.delete(tender.number); throw err; }));
      if (procedureCache.size > 200) procedureCache.delete(procedureCache.keys().next().value);
    }
    return procedureCache.get(tender.number);
  }

  return {
    name: 'roseltorg',
    laws: ['com', '44', '223'],
    fetchNew,
    /** Позиции закупки — в формате, который понимает details.ensureItems ({items}). */
    async getDetailsDoc(tender) {
      if (!isRoseltorg(tender)) return null;
      const p = await procedure(tender);
      return { items: p.items, conditions: { deadline_at: tender.deadline_at ?? null, customer_inn: tender.customer_inn ?? null, region: tender.region ?? null } };
    },
    async getAttachments(tender) {
      if (!isRoseltorg(tender)) return [];
      return (await procedure(tender)).attachments;
    },
  };
}

module.exports = { createRoseltorgSource, parseSearch, parseProcedure, parseUnitsChunk, moscowDate };
