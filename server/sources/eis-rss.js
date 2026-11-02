// Источник закупок: официальная RSS-лента поиска ЕИС (zakupki.gov.ru) — бесплатно и без ключа.
// robots.txt ЕИС разрешает роботам /*search* и /*rss* с паузой 60 секунд (Crawl-delay) — её и соблюдаем.
// Лента даёт: закон, номер, наименование, заказчика, НМЦК, дату размещения и этап. Регион, срок подачи
// и коды ОКПД2/КТРУ в ленте не приходят — их подтягивает источник с извещением (ГосПлан) через multi.js.
// Срока подачи в ленте нет, поэтому запрашиваются закупки с окончанием подачи не раньше чем через N дней
// (applSubmissionCloseDateFrom; N — «дней до подачи» из профиля). У закупок на этапе «Подача заявок» так известна
// нижняя граница срока — deadline_from: окончание подачи не раньше этого дня. Отбор по этапу (af=on) не ставится
// намеренно: в выдаче остаются и отменённые закупки со сроком в будущем — по ним сервис убирает из ленты то, что
// заказчик отменил уже после того, как закупка попала к нам (onClosed).

const { createGate } = require('./eis-gate');

const RSS_URL = 'https://zakupki.gov.ru/epz/order/extendedsearch/rss.html';

const unescapeXml = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');
const tag = (xml, name) => unescapeXml(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? '').trim();
// ЕИС подсвечивает найденное слово тегом внутри слова: «<span class='highlightColor'>бумаг</span>и» — такие теги
// убираем без пробела, иначе получается «бумаг и».
const stripTags = (s) => String(s || '')
  .replace(/<\/?(span|b|strong|em|i|u)\b[^>]*>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Поле из описания: «<strong>Наименование Заказчика: </strong>ООО …<br/>». */
function field(description, label) {
  const re = new RegExp(`<strong>\\s*${label}\\s*:?\\s*</strong>\\s*([\\s\\S]*?)(?:<strong>|<br\\s*/?>|$)`, 'i');
  const v = re.exec(description)?.[1];
  return v ? stripTags(v) : null;
}

const ruDate = (s) => {
  const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(String(s || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}T00:00:00Z` : null;
};

/** Разбор ленты. @returns {Array<{law, number, title, price, currency, published_at, stage_text, customer_name, eis_url}>} */
function parseRss(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const link = tag(item, 'link');
    const number = /regNumber=(\d+)/.exec(link)?.[1] || /№\s*(\d{11,})/.exec(tag(item, 'title'))?.[1];
    if (!number) continue;
    const d = unescapeXml(tag(item, 'description'));
    const law = /Размещение выполняется по:\s*<\/strong>\s*223/.test(d) || link.includes('/223/') ? '223' : '44';
    const price = Number(String(field(d, 'Начальная цена контракта') || '').replace(/\s/g, '').replace(',', '.'));
    out.push({
      law,
      number,
      title: field(d, 'Наименование объекта закупки') || stripTags(tag(item, 'title')),
      price: Number.isFinite(price) && price > 0 ? price : null,
      currency: field(d, 'Валюта') === 'Российский рубль' ? 'RUB' : field(d, 'Валюта'),
      region: null,
      okpd2: [],
      ktru: [],
      customer_inn: null,
      customer_name: field(d, 'Наименование Заказчика') || tag(item, 'author') || null,
      published_at: ruDate(field(d, 'Размещено')) || (tag(item, 'pubDate') ? new Date(tag(item, 'pubDate')).toISOString() : null),
      deadline_at: null,
      stage: null,
      stage_text: field(d, 'Этап размещения'),
      eis_url: link,
      source_name: 'eis-rss',
    });
  }
  return out;
}

/**
 * @param {{fetchImpl?, delayMs?, maxPages?, log?}} opts delayMs — пауза между запросами (robots ЕИС: 60 с)
 */
/** Начало дня по Москве через days дней от now: {iso, ru} — ISO-время и дата «дд.мм.гггг» для запроса ЕИС. */
function moscowDayFrom(now, days) {
  const msk = new Date(now.getTime() + 3 * 3600000);
  const d = new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() + days) - 3 * 3600000);
  const m = new Date(d.getTime() + 3 * 3600000);
  const two = (n) => String(n).padStart(2, '0');
  return { iso: d.toISOString(), ru: `${two(m.getUTCDate())}.${two(m.getUTCMonth() + 1)}.${m.getUTCFullYear()}` };
}

// Этап, на котором заявки ещё принимаются. Остальные («Работа комиссии», «Определение поставщика завершено»,
// «Закупка отменена») — поздно: подать заявку уже нельзя.
const OPEN_STAGE = /^подача заявок$/i;

function createEisRssSource({ fetchImpl = fetch, delayMs = 60000, maxPages = 3, timeoutMs = 60000, log = console, gate = null, clock = () => new Date() } = {}) {
  // gate — общая очередь запросов к ЕИС (её же берёт проверка по реестру недобросовестных поставщиков)
  const queue = gate || createGate(delayMs);

  async function page(params) {
    await queue.wait();
    const url = new URL(RSS_URL);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tender-ai/0.1; supplier search for public procurement)', Accept: 'application/rss+xml,text/xml,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`ЕИС ответил ${res.status} на RSS поиска`);
    return parseRss(await res.text());
  }

  /** Новые закупки: одна лента на каждое ключевое слово профиля (пусто — все свежие закупки). */
  async function fetchNew({ profile = {}, since, onPage = () => {}, onClosed = () => {}, onProgress = () => {}, laws: allLaws = ['44', '223'] } = {}) {
    // только виды закупок, включённые в профиле
    const laws = profile.laws?.length ? allLaws.filter((l) => profile.laws.map(String).includes(l)) : allLaws;
    if (!laws.length) return { items: [], truncated: false, errors: [] };
    // Лента ЕИС — по ключевым словам (в режиме перепродажи — по словам направления); не больше 5 слов: пауза 60 с на запрос.
    const kw = profile.focus_keywords?.length ? profile.focus_keywords : profile.keywords;
    // focus_keywords уже отобраны синхронизацией (первые слова каждого направления, не больше 15); свои слова профиля — первые 5.
    const words = kw?.length ? kw.slice(0, profile.focus_keywords?.length ? 15 : 5) : [''];
    const items = [];
    const errors = [];
    let truncated = false;
    // окончание подачи — не раньше чем через столько дней (как «дней до подачи» в профиле; по умолчанию 2)
    const minDays = Math.max(0, Math.min(60, Number(profile.min_days_to_deadline ?? 2) || 0));
    const from = moscowDayFrom(clock(), minDays);
    let closed = 0;
    for (const [wi, word] of words.entries()) {
      for (let p = 1; p <= maxPages; p++) {
        onProgress({ done: wi + (p - 1) / maxPages, total: words.length, label: `ЕИС${word ? `, «${word}»` : ''} (${wi + 1} из ${words.length})` });
        let chunk;
        try {
          chunk = await page({
            searchString: word,
            fz44: laws.includes('44') ? 'on' : undefined,
            fz223: laws.includes('223') ? 'on' : undefined,
            pageNumber: p,
            sortBy: 'UPDATE_DATE',
            applSubmissionCloseDateFrom: from.ru,
            priceFromGeneral: profile.price_min ?? undefined,
            priceToGeneral: profile.price_max ?? undefined,
            publishDateFrom: since ? new Date(since).toLocaleDateString('ru-RU') : undefined,
          });
        } catch (err) {
          errors.push(`ЕИС (RSS): ${err.message}`);
          break;
        }
        if (!chunk.length) break;
        // закупки, где приём заявок закончился или закупку отменили, в ленту не берём — только сообщаем о них
        const open = chunk.filter((t) => !t.stage_text || OPEN_STAGE.test(t.stage_text.trim()));
        const shut = chunk.filter((t) => !open.includes(t));
        closed += shut.length;
        if (shut.length) onClosed(shut.map((t) => ({ law: t.law, number: t.number, stage_text: t.stage_text })));
        for (const t of open) { t.deadline_from = from.iso; t.open_confirmed = Boolean(t.stage_text); }
        items.push(...open);
        onPage(open);
        if (chunk.length < 200) break; // страница неполная — дальше пусто
        if (p === maxPages) truncated = true;
      }
    }
    if (closed) log.log?.(`[ЕИС] закупок, где приём заявок закрыт (отменены, завершены): ${closed}`);
    const seen = new Set();
    return { items: items.filter((t) => !seen.has(`${t.law}|${t.number}`) && seen.add(`${t.law}|${t.number}`)), truncated, errors };
  }

  /**
   * Этап одной закупки по её номеру — той же официальной лентой поиска (через общую очередь запросов к ЕИС).
   * @returns {Promise<string|null>} «Подача заявок», «Определение поставщика отменено»…; null — закупка в ЕИС не найдена
   */
  async function getStage(tender) {
    if (!['44', '223'].includes(String(tender.law))) return null;
    const list = await page({ searchString: tender.number, [String(tender.law) === '223' ? 'fz223' : 'fz44']: 'on' });
    return list.find((t) => t.number === String(tender.number))?.stage_text || null;
  }

  return { name: 'eis-rss', laws: ['44', '223'], fetchNew, parseRss, getStage, isOpenStage: (s) => OPEN_STAGE.test(String(s || '').trim()) };
}

module.exports = { createEisRssSource, parseRss, moscowDayFrom, OPEN_STAGE };
