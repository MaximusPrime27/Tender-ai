// Источник закупок: коммерческие закупки на ЭТП ГПБ (etpgpb.ru) — секции корпоративных заказчиков, «Торговый
// портал», «ЭТП Клик», «Закупки.Бизнес». Закупки по 44-ФЗ и 223-ФЗ с номером ЕИС, попавшиеся среди открытых страниц,
// берём под их законом и номером ЕИС — в ленту они приходят раньше, чем из ГосПлана; позиции к ним дают ГосПлан и ЕИС.
//
// Как находим. robots.txt площадки закрывает для роботов адреса с «?» и листание списка (/procedures/page…),
// но открывает карту сайта и страницы самих процедур. В карте сайта площадка публикует все процедуры, и в адресе
// каждой — её название латиницей («…/1027969-postavka-kartridzhey-sharp…»). Поэтому: читаем свежую часть карты
// сайта, отбираем процедуры по словам направлений (в адресе), открываем только их — с паузой ETPGPB_DELAY_MS
// и не больше ETPGPB_MAX_PAGES страниц за обновление. Со страницы — номер, название, цена, срок, заказчик, адрес
// поставки, перечень товаров. Документы лежат в /uploads/ — robots.txt их закрывает, поэтому документов нет:
// их человек скачивает с площадки сам.
// Закупка в сервисе: закон «com», номер «GPB-1027969».

const { htmlToText } = require('../offers/fetch-page');
const { regionFromText } = require('../offers/logistics');

const BASE = 'https://etpgpb.ru';
const UA = 'Mozilla/5.0 (compatible; tender-ai/0.1; supplier search for procurement)';
const SITEMAP = `${BASE}/sitemap/procedures.xml`;

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
/**
 * Как слово выглядит в адресе процедуры: «картридж» → «kartri» (основа: окончания разные). У длинных слов основа
 * длиннее — 70% слова: «маршрутизатор» → «marshrutiz», иначе совпадёт с «маршруту».
 */
const slugStem = (word) => {
  const latin = String(word || '').toLowerCase().split('').map((c) => TRANSLIT[c] ?? c).join('').replace(/[^a-z0-9]/g, '');
  return latin.slice(0, Math.max(6, Math.ceil(latin.length * 0.7)));
};

// не закупки: продажа и аренда имущества, недра, углеводороды
const NOT_PURCHASE = /prodazh|arend|realizats|nedr|uglevodorod|imuschestv/;

/** «21.10.2026 13:41 Z» (время площадки — UTC) или без «Z» — московское → ISO UTC */
function gpbDate(s) {
  const m = /(\d{2})\.(\d{2})\.(\d{4}),?\s*(\d{2}):(\d{2})\s*(Z)?/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] - (m[6] ? 0 : 3), +m[5])).toISOString();
}

const money = (s) => {
  const m = /(\d[\d\s ]*)(?:[,.](\d{1,2}))?/.exec(String(s || ''));
  if (!m) return null;
  const v = Number(`${m[1].replace(/[\s ]/g, '')}.${m[2] || '0'}`);
  return Number.isFinite(v) && v > 0 ? v : null;
};

/**
 * Адреса процедур из части карты сайта: [{url, id, slug, kind, lastmod}].
 * kind — вид процедуры из адреса: etp, price_request, etp_click и т. п.
 */
function parseSitemapPart(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g)) {
    const p = /\/procedures\/([a-z_]+)\/(\d+)-([a-z0-9-]+)\/?$/.exec(m[1]);
    if (p) out.push({ url: m[1], kind: p[1], id: p[2], slug: p[3], lastmod: m[2] || null });
  }
  return out;
}

/** Текст страницы процедуры → поле по подписи: «Номер закупки 1027969 Наименование закупки …». */
const after = (text, label, stop) => {
  const re = new RegExp(`${label}\\s*:?\\s*([\\s\\S]*?)\\s*(?:${stop})`, 'i');
  return re.exec(text)?.[1]?.replace(/\s+/g, ' ').trim() || null;
};

const STOP = 'Номер извещения|Цена договора|Номер закупки|Наименование закупки|Российское производство|Производитель|Ограничения|Способ закупки|Начальная цена|Валюта процедуры|Дата публикации|Документация|Сведения об|Секция ЭТП|Текущий статус|Условия|Тип стоимости|Адрес поставки|Предполагаемая|Заказчики|Список лотов|Этапы|Перечень товаров|ИНН|КПП|Место поставки|Скрыть';

/**
 * Разбор страницы процедуры.
 * @returns {object|null} закупка в формате сервиса (law: 'com'), null — не наша (44/223-ФЗ из ЕИС, продажа, закрыта)
 */
function parseProcedure(html, url, { eis: takeEis = false } = {}) {
  const text = htmlToText(html).replace(/\s+/g, ' ');
  // основная часть — от «Основные сведения»; меню и подвал сайта не нужны
  const at = text.indexOf('Основные сведения');
  const main = at >= 0 ? text.slice(Math.max(0, at - 400), at + 12000) : text;
  const section = after(main, 'Секция ЭТП', STOP);
  // 44-ФЗ и 223-ФЗ — в ЕИС: такие закупки сервис получает оттуда
  // «Номер извещения 32616494459» (11 цифр) — номер закупки 223-ФЗ в ЕИС
  const notice = /Номер извещения\s*:?\s*(\S+)/.exec(main)?.[1] || '';
  const inEis = /44-ФЗ|223-ФЗ|615-ПП|государственн\S* заказчик/i.test(section || '') || /^\d{11}$/.test(notice) || /Номер извещения в ЕИС|zakupki\.gov\.ru/i.test(main);
  // eis: true — закупку ЕИС берём под её законом и номером (11 цифр — 223-ФЗ, 19 цифр — 44-ФЗ); без номера не берём:
  // её не склеить с той же закупкой из ГосПлана и ЕИС
  const eisNum = inEis ? [notice, /Номер извещения в ЕИС\s*:?\s*(\d{11}|\d{19})\b/.exec(main)?.[1], /regNumber=(\d{11}|\d{19})\b/.exec(html)?.[1]].find((x) => /^(\d{11}|\d{19})$/.test(x || '')) || null : null;
  if (inEis && !(takeEis && eisNum)) return { skip: 'ЕИС' };
  if (/продаж|аренд|недр|углеводород/i.test(section || '')) return { skip: 'не закупка' };
  const status = after(main, 'Текущий статус', STOP);
  if (status && /заверш|отмен|подведен|архив|не состоял/i.test(status)) return { skip: 'закрыта' };
  // номер в сервисе — из адреса страницы: «Номер закупки» в разных секциях повторяется
  const id = /\/(\d+)-[^/]*\/?$/.exec(url)?.[1] || after(main, 'Номер закупки', STOP);
  const title = after(main, 'Наименование закупки', STOP);
  const priceText = after(main, 'Начальная цена(?: с НДС)?', STOP);
  const published = gpbDate(after(main, 'Дата публикации', STOP));
  // срок подачи: «Дата и время окончания 22.10.2026, 13:28 Z» (над сведениями) или «Дата продления …»
  const deadline = gpbDate(after(text, 'Дата и время окончания', 'Основные сведения|Заказчики|Участвовать') || after(main, 'Дата продления', STOP) || after(main, 'Окончание (?:при[её]ма|подачи)[^0-9]{0,30}', STOP));
  const customer = /Наименование организации\s+([\s\S]{3,300}?)\s+ИНН\s+(\d{10,12})/.exec(main);
  const address = after(main, 'Адрес поставки', STOP) || after(main, 'Место поставки товаров/выполнения работ/оказания услуг', STOP);
  return {
    law: eisNum ? (eisNum.length === 19 ? '44' : '223') : 'com',
    number: eisNum || `GPB-${id}`,
    title: title || `Закупка ЭТП ГПБ ${id}`,
    price: /не указан/i.test(priceText || '') ? null : money(priceText),
    currency: 'RUB',
    region: regionFromText(address || '') || null,
    okpd2: [],
    ktru: [],
    customer_inn: customer?.[2] || null,
    customer_name: customer?.[1]?.trim() || null,
    published_at: published,
    deadline_at: deadline,
    stage: 1,
    eis_url: url,
    section: section || null,
    status_text: status || null,
    delivery_address: address || null,
    items: parseItems(text),
    source_name: 'etpgpb',
  };
}

/** «Перечень товаров № п/п Наименование позиции Количество Единица измерения 1 Пакет бумажный 10 УПАК 2 …» */
function parseItems(text) {
  const at = text.indexOf('Перечень товаров');
  if (at < 0) return [];
  const block = text.slice(at, at + 20000).replace(/^Перечень товаров\s*№ п\/п\s*Наименование позиции\s*Количество\s*Единица измерения\s*/i, '');
  const out = [];
  const re = /(?:^|\s)(\d{1,4})\s+(.+?)\s+(\d+(?:[.,]\d+)?)\s+([A-ZА-ЯЁa-zа-яё.\s²³]{1,15}?)(?=\s+\d{1,4}\s+\S|\s*$|\s+(?:Электронная торговая|Скрыть|Заказчики|Документация))/g;
  let m;
  let expect = 1;
  while ((m = re.exec(block)) && out.length < 300) {
    if (Number(m[1]) !== expect) break; // нумерация сбилась — дальше уже не таблица
    expect++;
    out.push({ name: m[2].trim(), quantity: Number(m[3].replace(',', '.')), unit: m[4].trim(), okpd2_code: null, ktru_code: null, characteristics: [], source: 'notification' });
  }
  return out;
}

function createEtpGpbSource({ fetchImpl = fetch, fetcher = null, delayMs = 3000, maxPages = 40, days = 3, log = console, clock = () => new Date() } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let last = 0;
  async function get(url) {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    if (fetcher) { const p = await fetcher.fetchPage(url); return p.html; }
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`ЭТП ГПБ ответила ${res.status}`);
    return res.text();
  }

  /** Свежие процедуры из карты сайта: части, обновлённые за `days` дней. */
  async function recent() {
    const index = await get(SITEMAP);
    const since = clock().getTime() - days * 86400000;
    const parts = [...String(index).matchAll(/<loc>([^<]+procedures\d+\.xml)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)]
      .filter((m) => new Date(m[2]).getTime() >= since).map((m) => m[1]).slice(-2);
    const out = [];
    for (const p of parts) out.push(...parseSitemapPart(await get(p)).filter((x) => !x.lastmod || new Date(x.lastmod).getTime() >= since));
    return out;
  }

  const cache = new Map();
  async function fetchNew({ profile = {}, onPage = () => {}, onProgress = () => {} } = {}) {
    const errors = [];
    const kw = profile.focus_keywords?.length ? profile.focus_keywords : profile.keywords || [];
    // слово направления → основы его слов: у «системный блок» в адресе должны быть и «sistem», и «blok»
    const stems = [...new Set(kw.map((w) => String(w).split(/\s+/).map(slugStem).filter((x) => x.length >= 3).join(' ')).filter(Boolean))].map((x) => x.split(' '));
    if (!stems.length) return { items: [], truncated: false, errors: ['ЭТП ГПБ: нет слов направлений — нечего отбирать в карте сайта'] };
    let list = [];
    try { list = await recent(); } catch (err) { return { items: [], truncated: false, errors: [`ЭТП ГПБ: карта сайта — ${err.message}`] }; }
    // короткая основа («mfu») — только отдельным словом адреса, иначе найдётся внутри чужих слов
    const has = (slug, p) => (p.length >= 4 ? slug.includes(p) : slug.split('-').includes(p));
    const wanted = list.filter((x) => !NOT_PURCHASE.test(x.slug) && stems.some((parts) => parts.every((p) => has(x.slug, p))))
      .sort((a, b) => Number(b.id) - Number(a.id));
    const items = [];
    const skipped = {};
    for (const [i, x] of wanted.slice(0, maxPages).entries()) {
      onProgress({ done: i, total: Math.min(maxPages, wanted.length), label: `ЭТП ГПБ: ${i + 1} из ${Math.min(maxPages, wanted.length)}` });
      try {
        const t = parseProcedure(await get(x.url), x.url, { eis: true });
        if (t.skip) { skipped[t.skip] = (skipped[t.skip] || 0) + 1; continue; }
        if (profile.laws?.length && !profile.laws.map(String).includes(t.law)) continue;
        if ((profile.price_min != null && t.price != null && t.price < profile.price_min) || (profile.price_max != null && t.price != null && t.price > profile.price_max)) continue;
        cache.set(t.number, t);
        if (cache.size > 500) cache.delete(cache.keys().next().value);
        const { items: _items, ...tender } = t;
        items.push(tender);
        await onPage([tender]);
      } catch (err) {
        errors.push(`ЭТП ГПБ ${x.id}: ${err.message}`);
        if (errors.length > 5) break;
      }
    }
    if (Object.keys(skipped).length) log.log?.(`[etpgpb] пропущено: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(', ')}; подходящих по словам ${wanted.length}, открыто ${Math.min(maxPages, wanted.length)}`);
    return { items, truncated: wanted.length > maxPages, errors };
  }

  const isGpb = (t) => t?.law === 'com' && /^GPB-\d+$/.test(String(t.number || ''));
  return {
    name: 'etpgpb',
    laws: ['com', '44', '223'],
    fetchNew,
    /** Позиции закупки — со страницы процедуры (перечень товаров). */
    async getDetailsDoc(tender) {
      if (!isGpb(tender)) return null;
      let t = cache.get(tender.number);
      if (!t && tender.eis_url) { t = parseProcedure(await get(tender.eis_url), tender.eis_url); if (!t.skip) cache.set(tender.number, t); }
      if (!t || t.skip) return null;
      return { items: t.items || [], platform: { name: 'ЭТП ГПБ', url: BASE }, conditions: { deadline_at: t.deadline_at ?? tender.deadline_at ?? null, customer_inn: t.customer_inn ?? null, region: t.region ?? null } };
    },
    // документы лежат в /uploads/ — robots.txt площадки их закрывает
    async getAttachments() { return []; },
  };
}

module.exports = { createEtpGpbSource, parseSitemapPart, parseProcedure, parseItems, slugStem, gpbDate };
