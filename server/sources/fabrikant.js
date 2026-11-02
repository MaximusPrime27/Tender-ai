// Источник закупок: коммерческие процедуры на Фабриканте (fabrikant.ru, секция «Коммерческие процедуры»).
// Закупки по 44-ФЗ и 223-ФЗ с Фабриканта сервис получает из ЕИС — здесь их пропускаем. «Фабрикант.Маркет»
// (market.fabrikant.ru) — приложение, которое показывает закупки только скриптом в браузере: его не читаем.
//
// Как находим. Поиск закупок по слову (/procedure/search/purchases?query=…) robots.txt Фабриканта не запрещает
// (закрыты только служебные адреса с ?action=…). Страница поиска отдаёт карточки в данных страницы: адрес, название
// и секция — по ним берём только коммерческие процедуры и открываем их страницы (с паузой FABRIKANT_DELAY_MS,
// не больше FABRIKANT_MAX_PAGES за обновление). Со страницы — заказчик с ИНН, срок подачи, цена, регион, лоты с ОКПД2.
// Документы открываются только после входа на площадку — их человек скачивает сам.
// Закупка в сервисе: закон «com», номер «FAB-<код процедуры из адреса>».

const { htmlToText } = require('../offers/fetch-page');
const { regionFromText } = require('../offers/logistics');

const BASE = 'https://www.fabrikant.ru';
const UA = 'Mozilla/5.0 (compatible; tender-ai/0.1; supplier search for procurement)';

/** «23.10.2026 17:31» — время площадки, московское → ISO UTC */
function fabDate(s) {
  const m = /(\d{2})\.(\d{2})\.(\d{4})\s*(\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] - 3, +m[5])).toISOString() : null;
}
const money = (s) => {
  const m = /(\d[\d\s ]*)(?:[,.](\d{1,2}))?/.exec(String(s || ''));
  if (!m) return null;
  const v = Number(`${m[1].replace(/[\s ]/g, '')}.${m[2] || '0'}`);
  return Number.isFinite(v) && v > 0 ? v : null;
};

/**
 * Карточки со страницы поиска: [{url, name, section}]. Данные лежат в странице как экранированный JSON
 * («"url":"https://fabrikant.ru/v2/trades/procedure/view/…","name":"…",…,"sectionEnum":"commercial"»).
 */
function parseSearch(html) {
  const s = String(html).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const out = [];
  const seen = new Set();
  for (const m of s.matchAll(/"url":"(https?:\/\/[^"]+)","name":"((?:[^"\\]|\\.)*)"[^{}]*?"sectionEnum":"([^"]*)"/g)) {
    const url = m[1].replace(/^https?:\/\/fabrikant\.ru/, BASE);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, name: m[2].replace(/\\u0026/g, '&').trim(), section: m[3] });
  }
  return out;
}

const after = (text, label, stop) => new RegExp(`${label}\\s*:?\\s*([\\s\\S]*?)\\s*(?:${stop})`, 'i').exec(text)?.[1]?.replace(/\s+/g, ' ').trim() || null;
const STOP = 'Информация о|Почтовый адрес|ИНН|КПП|Контактное лицо|Дата публикации|Действия|Лот №|Предмет договора|Номер закупки|Начальная|Разрешить|Цена за единицу|Валюта|Способ|Товары и услуги|Количество|Дополнительные|Место поставки|Код региона|Субъект РФ|Дата и время|Обеспечение|Возможность|Форма, размер|Условия|Сведения|Требование|Секция|Тип процедуры|Общее наименование|Название процедуры';

/**
 * Разбор страницы процедуры.
 * @returns {object} закупка (law: 'com') или {skip: причина}
 */
function parseProcedure(html, url) {
  const text = htmlToText(html).replace(/\s+/g, ' ');
  const section = after(text, 'Секция на торговой площадке', STOP);
  if (!/коммерческ/i.test(section || '')) return { skip: 'не коммерческая' };
  if (/Номер закупки в ЕИС\s*\d{11}/.test(text)) return { skip: 'ЕИС' };
  const id = /\/view\/([A-Za-z0-9_-]+)/.exec(url)?.[1];
  const title = after(text, 'Общее наименование закупки', STOP) || after(text, 'Предмет договора', STOP);
  const customer = /Информация о заказчике[\s\S]{0,80}?Организация\s+([\s\S]{3,300}?)\s+Почтовый адрес\s+([\s\S]{3,400}?)\s+ИНН\s+(\d{10,12})/.exec(text)
    || /Информация об организаторе\s+([\s\S]{3,300}?)\s+Почтовый адрес\s+([\s\S]{3,400}?)\s+ИНН\s+(\d{10,12})/.exec(text);
  const price = after(text, 'Начальная (?:\\(максимальная\\) )?цена(?: договора)?(?:\\s*Цена (?:с|без) НДС)?', 'Российский рубль|RUB|Разрешить|Цена без НДС|НДС');
  const region = after(text, 'Субъект РФ\\\\Регион', 'Место поставки|Код региона|Обеспечение|Дата и время');
  const deadline = fabDate(after(text, 'Дата и время окончания приема заявок', STOP));
  const lots = [...text.matchAll(/Лот №(\d+)\.\s*([\s\S]{3,400}?)\s+-\s+(Прием заявок|Приём заявок|[А-ЯЁ][а-яё ]{3,30})\s+Предмет договора/g)];
  if (lots.length && lots.every((l) => !/при[её]м заявок/i.test(l[3]))) return { skip: 'закрыта' };
  const okpd = [...new Set([...text.matchAll(/ОКПД2\s+(\d{2}(?:\.\d{1,3}){0,3})/g)].map((m) => m[1]))];
  return {
    law: 'com',
    number: `FAB-${id}`,
    title: title || `Коммерческая процедура Фабриканта ${id}`,
    price: money(price),
    currency: 'RUB',
    region: regionFromText(region || customer?.[2] || '') || null,
    okpd2: okpd,
    ktru: [],
    customer_inn: customer?.[3] || null,
    customer_name: customer?.[1]?.replace(/\s+/g, ' ').trim() || null,
    published_at: fabDate(after(text, 'Дата публикации', STOP)),
    deadline_at: deadline,
    stage: 1,
    eis_url: url,
    section: section || null,
    items: (lots.length ? lots : []).map((l) => ({ name: l[2].replace(/\s+/g, ' ').trim(), quantity: null, unit: null, okpd2_code: okpd[0] || null, ktru_code: null, characteristics: [], source: 'notification' })),
    source_name: 'fabrikant',
  };
}

function createFabrikantSource({ fetchImpl = fetch, delayMs = 5000, maxPages = 20, log = console } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let last = 0;
  async function get(url) {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Фабрикант ответил ${res.status}`);
    return res.text();
  }

  const cache = new Map();
  async function fetchNew({ profile = {}, onPage = () => {}, onProgress = () => {} } = {}) {
    const kw = profile.focus_keywords?.length ? profile.focus_keywords : profile.keywords || [];
    const words = kw.slice(0, profile.focus_keywords?.length ? 15 : 5);
    if (!words.length) return { items: [], truncated: false, errors: ['Фабрикант: нет слов направлений для поиска'] };
    const errors = [];
    const found = new Map();
    for (const [i, w] of words.entries()) {
      onProgress({ done: i, total: words.length * 2, label: `Фабрикант, «${w}» (${i + 1} из ${words.length})` });
      try {
        for (const c of parseSearch(await get(`${BASE}/procedure/search/purchases?query=${encodeURIComponent(w)}`))) {
          if (c.section === 'commercial' && /\/v2\/trades\/procedure\/view\//.test(c.url)) found.set(c.url, c);
        }
      } catch (err) { errors.push(`Фабрикант «${w}»: ${err.message}`); if (errors.length > 3) break; }
    }
    const items = [];
    const skipped = {};
    const list = [...found.values()];
    for (const [i, c] of list.slice(0, maxPages).entries()) {
      onProgress({ done: words.length + (i / Math.max(1, Math.min(maxPages, list.length))) * words.length, total: words.length * 2, label: `Фабрикант: процедура ${i + 1} из ${Math.min(maxPages, list.length)}` });
      try {
        const t = parseProcedure(await get(c.url), c.url);
        if (t.skip) { skipped[t.skip] = (skipped[t.skip] || 0) + 1; continue; }
        if ((profile.price_min != null && t.price != null && t.price < profile.price_min) || (profile.price_max != null && t.price != null && t.price > profile.price_max)) continue;
        cache.set(t.number, t);
        if (cache.size > 300) cache.delete(cache.keys().next().value);
        const { items: _i, ...tender } = t;
        items.push(tender);
        await onPage([tender]);
      } catch (err) { errors.push(`Фабрикант ${c.url}: ${err.message}`); if (errors.length > 5) break; }
    }
    log.log?.(`[fabrikant] коммерческих в поиске ${list.length}, открыто ${Math.min(maxPages, list.length)}, взято ${items.length}${Object.keys(skipped).length ? `, пропущено: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`);
    return { items, truncated: list.length > maxPages, errors };
  }

  const isFab = (t) => t?.law === 'com' && /^FAB-[A-Za-z0-9_-]+$/.test(String(t.number || ''));
  return {
    name: 'fabrikant',
    laws: ['com'],
    fetchNew,
    async getDetailsDoc(tender) {
      if (!isFab(tender)) return null;
      let t = cache.get(tender.number);
      if (!t && tender.eis_url) { t = parseProcedure(await get(tender.eis_url), tender.eis_url); if (!t.skip) cache.set(tender.number, t); }
      if (!t || t.skip) return null;
      return { items: t.items || [], platform: { name: 'Фабрикант', url: BASE }, conditions: { deadline_at: t.deadline_at ?? tender.deadline_at ?? null, customer_inn: t.customer_inn ?? null, region: t.region ?? null } };
    },
    // документы — после входа на площадку
    async getAttachments() { return []; },
  };
}

module.exports = { createFabrikantSource, parseSearch, parseProcedure, fabDate };
