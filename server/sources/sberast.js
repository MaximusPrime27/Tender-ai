// Источник закупок: закупки на Сбербанк-АСТ, которых нет в ЕИС, — коммерческие заказчики, Почта России, Транснефть,
// Центробанк, Сбербанк, АФК «Система», Росатом и закупки по 223-ФЗ без извещения в ЕИС (малые закупки компаний).
// Закупки по 44-ФЗ и 223-ФЗ с номером ЕИС берём отдельным проходом (fetchNew, eis: true) под их законом и номером ЕИС —
// так они попадают в ленту в день публикации; документы и позиции к ним по-прежнему дают ГосПлан и ЕИС.
//
// Как находим. Общий реестр процедур площадки (www.sberbank-ast.ru/UnitedPurchaseList.html) открыт без входа; страница
// получает список одним запросом к /api/Processing/main (окно «/EsOpenUnitedPurchaseList») — тот же запрос делаем мы.
// robots.txt www.sberbank-ast.ru ничего не запрещает; на utp.sberbank-ast.ru закрыт раздел /Retail — секцию «Ритейл»
// не берём. В ответе на строку закупки сразу есть всё: название, цена, срок подачи, заказчик с ИНН, регион, перечень
// товаров. Страницы процедур не открываем (их данные подгружаются скриптом после входа).
// Запросы: по 100 закупок, новые сначала, пока не дойдём до опубликованных раньше окна (с прошлого обновления,
// в первый раз — 3 дня: это ~8 запросов, потом 1–2), пауза SBERAST_DELAY_MS, не больше SBERAST_MAX_PAGES.
// Закупка в сервисе: закон «com», номер «SBAST-<номер процедуры на площадке>» (с номером лота: «SBR028-2610230064.1»).

const { regionFromText, REGIONS } = require('../offers/logistics');

const API = 'https://www.sberbank-ast.ru/api/Processing/main';
const LIST_PAGE = 'https://www.sberbank-ast.ru/UnitedPurchaseList.html';
const UA = 'Mozilla/5.0 (compatible; tender-ai/0.1; supplier search for procurement)';

// Торговые секции, где идут закупки вне ЕИС (названия — как в фильтре реестра площадки)
const SECTIONS = [
  'Торги коммерческих заказчиков',
  'Торги коммерческих заказчиков (ранее ТС "Закупки и продажи")',
  'Закупки и продажи',
  'Закупки ПАО Сбербанк',
  'ПАО АФК «Система»',
  'Закупки Центрального банка Российской Федерации',
  'Закупки АО «Почта России»',
  'Закупки ПАО Транснефть и ОСТ',
  'Закупки ГК "Росатом"',
  'Закупки по 223-ФЗ',
  'Закупки в строительной, промышленной и инфраструктурной отраслях по 223-ФЗ и ГК РФ',
];
// Разделы с закупками по 44-ФЗ и 223-ФЗ, у которых есть номер ЕИС: берём их отдельным проходом — на площадке они
// появляются сразу после публикации, а в ГосПлане — через 2–3 дня
const EIS_SECTIONS = [
  'Госзакупки по 44-ФЗ',
  'Закупки по 223-ФЗ',
  'Закупки в строительной, промышленной и инфраструктурной отраслях по 223-ФЗ и ГК РФ',
];
// Не закупка товара: изучение рынка, отборы, продажи
const NOT_PURCHASE = /анализ рынка|запрос информации|обоснования начальн|квалификацион|предквалификац|продаж|аренд|аукцион на повышение/i;
// Этапы, на которых ещё принимают заявки
const OPEN_STAGE = /подача заявок|опубликован/i;

const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;
const str = (v) => { const x = first(v); return x == null ? '' : String(x).trim(); };

/** «23.10.2026 18:40» или «24.11.2026» — время площадки, московское → ISO UTC */
function sbDate(s) {
  const m = /(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(str(s));
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], (m[4] ? +m[4] : 23) - 3, m[5] ? +m[5] : 59)).toISOString() : null;
}

/** Объект → XML фильтра реестра, как его собирает страница площадки: массив — повтор тега. */
function toXml(o) {
  return Object.entries(o).map(([k, v]) => (Array.isArray(v)
    ? v.map((x) => `<${k}>${typeof x === 'object' ? toXml(x) : esc(x)}</${k}>`).join('')
    : v != null && typeof v === 'object' ? `<${k}>${toXml(v)}</${k}>` : `<${k}>${esc(v ?? '')}</${k}>`)).join('');
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Тело запроса реестра: страница `page` по `size` закупок выбранных секций, новые сначала. */
function listRequest({ page = 0, size = 100, sections = SECTIONS, text = '' } = {}) {
  const filter = { fields: { field: ['hasSt14'] }, targetPageCode: 'OTUnitedPurchaseList', searchbyorg: '1', sourceTerm: sections, pagesize: String(size), pagenum: page, sortType: '', sortOrder: 'desc', gridView: 'card' };
  if (text) Object.assign(filter, { searchBarType: 'anyWord', mainInput: text });
  return { windowCode: '/EsOpenUnitedPurchaseList', actionType: 'MONITOR', actionCode: 'default', documentBody: '', parm: 'es', filterBody: `<query>${toXml(filter)}</query>`, options: {} };
}

// «Планируется заключение рамочного договора» и подобные пометки в перечне товаров — не товар
const NOTE = /^(планируется|рамочн|договор|прочее$)/i;
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

/**
 * Строка реестра → закупка сервиса (law: 'com') или {skip: причина}.
 * @param {object} s — `_source` строки ответа
 * @param {{open?: boolean}} opts open=false — не проверять этап и срок (перечень товаров уже сохранённой закупки)
 */
function parseRow(s, now = new Date(), { open = true, eis: takeEis = false } = {}) {
  const code = str(s.purchCode);
  const eis = str(s.IntegratorCode);
  // номер ЕИС: 19 цифр — 44-ФЗ, 11 цифр — 223-ФЗ
  const eis44 = [code.replace(/\.\d+$/, ''), eis].find((x) => /^\d{19}$/.test(x)) || null;
  const eis223 = /^\d{11}$/.test(eis) ? eis : null;
  const inEis = Boolean(eis44 || eis223);
  if (inEis !== takeEis) return { skip: inEis ? 'ЕИС' : 'не ЕИС' };
  if (!(takeEis ? EIS_SECTIONS : SECTIONS).includes(str(s.SourceTerm))) return { skip: 'другая секция' };
  if (NOT_PURCHASE.test(str(s.PurchaseTypeName)) || (str(s.PurchaseWayTerm) && !/закуп/i.test(str(s.PurchaseWayTerm)))) return { skip: 'не закупка' };
  const deadline = sbDate(s.RequestDate) || sbDate(s.RequestAcceptDate);
  if (open && (!OPEN_STAGE.test(str(s.PurchaseStageTerm)) || (deadline && new Date(deadline) <= now))) return { skip: 'закрыта' };
  if (!code) return { skip: 'нет номера' };
  const products = [].concat(s.products || []).map((x) => String(x || '').replace(/\s+/g, ' ').trim()).filter((x) => x && !NOTE.test(x));
  const name = str(s.purchName) || str(s.BidName) || `Закупка ${code} на Сбербанк-АСТ`;
  // «Запрос предложений в электронной форме по выбору…» — товары только в перечне: добавляем их к названию,
  // чтобы закупку было видно в ленте и фильтры направлений находили её по словам
  const head = norm(products[0]).split(/[\s,(]+/).find((w) => w.length >= 4);
  const title = products.length && (!head || !norm(name).includes(head.slice(0, Math.max(4, head.length - 2))))
    ? `${name}: ${products.slice(0, 3).join('; ')}${products.length > 3 ? ` и ещё ${products.length - 3}` : ''}`.slice(0, 500)
    : name;
  const price = Number(str(s.purchAmountRUB) || str(s.purchAmount));
  const regionId = Number(str(s.RegionId));
  const inn = str(s.CustomerInn) || str(s.OrgInn);
  const eisNum = eis44 || eis223;
  return {
    law: takeEis ? (eis44 ? '44' : '223') : 'com',
    number: takeEis ? eisNum : `SBAST-${code}`,
    title,
    price: Number.isFinite(price) && price > 0 ? price : null,
    currency: str(s.purchCurrency) || 'RUB',
    region: regionFromText(str(s.RegionName)) ?? (REGIONS[regionId] ? regionId : null) ?? regionFromText(str(s.orgContacts)),
    okpd2: [],
    ktru: [],
    customer_inn: /^\d{10,12}$/.test(inn) ? inn : null,
    customer_name: str(s.CustomerFullName) || str(s.CustomerNickName) || str(s.OrgFullName) || str(s.OrgName) || null,
    published_at: sbDate(s.PublicDate),
    deadline_at: deadline,
    stage: 1,
    // закупка из ЕИС — сразу её карточка в ЕИС (печатная форма извещения 44-ФЗ открывается для любого способа закупки),
    // а не поиск по номеру: в уведомлениях и отчёте агента ссылка вела на страницу результатов поиска (аудит 29.10)
    eis_url: takeEis ? (eis44 ? `https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=${eisNum}`
      : `https://zakupki.gov.ru/epz/order/notice/notice223/common-info.html?regNumber=${eisNum}`)
      : str(s.objectHrefTerm).replace(/^http:\/\//, 'https://') || LIST_PAGE,
    section: str(s.SourceTerm),
    purchase_type: str(s.PurchaseTypeName) || null,
    items: products.map((p) => ({ name: p, quantity: null, unit: null, okpd2_code: null, ktru_code: null, characteristics: [], source: 'notification' })),
    source_name: 'sberast',
  };
}

function createSberAstSource({ fetchImpl = fetch, delayMs = 3000, maxPages = 10, days = 3, clock = () => new Date(), log = console } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let last = 0;
  async function ask(body) {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetchImpl(API, {
      method: 'POST',
      headers: {
        'User-Agent': UA, accept: 'application/json', 'Content-Type': 'application/json',
        'X-AST-WINDOWCODE': body.windowCode, 'X-AST-ACTIONCODE': body.actionCode, 'X-AST-ACTIONTYPE': body.actionType, 'X-AST-PAGEURL': LIST_PAGE,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Сбербанк-АСТ ответил ${res.status}`);
    const j = JSON.parse(await res.text());
    const d = j.data ? (typeof j.data === 'string' ? JSON.parse(j.data) : j.data) : j;
    return [].concat(d?.PurchaseList || []).map((x) => x?._source).filter(Boolean);
  }

  const cache = new Map();
  let firstRun = true;
  /** Закупки выбранных секций, опубликованные с `since` (в первый раз после запуска сервиса — за `days` дней), на этапе приёма заявок. */
  async function fetchNew({ profile = {}, since = null, onPage = () => {}, onProgress = () => {} } = {}) {
    const now = clock();
    // окно: с прошлого обновления (синхронизация уже взяла его с запасом); в первый раз после запуска сервиса — не меньше
    // `days` дней: прошлое обновление могло идти без этого источника, и накопленное за дни иначе не загрузилось бы
    const back = now.getTime() - days * 86400000;
    const from = since ? (firstRun ? Math.min(new Date(since).getTime(), back) : new Date(since).getTime()) : back;
    firstRun = false;
    const items = [];
    const errors = [];
    const laws = profile.laws?.length ? profile.laws.map(String) : null;
    // два прохода: закупки вне ЕИС и закупки 44/223-ФЗ — они появляются на площадке сразу, раньше, чем в ГосПлане
    async function pass({ eis, sections, label }) {
      const skipped = {};
      let seen = 0;
      let taken = 0;
      for (let page = 0; page < maxPages; page++) {
        onProgress({ done: page, total: maxPages, label: `Сбербанк-АСТ${eis ? ' (44/223-ФЗ)' : ''}: страница ${page + 1}` });
        let rows;
        try { rows = await ask(listRequest({ page, sections })); } catch (err) { errors.push(`Сбербанк-АСТ: ${err.message}`); break; }
        seen += rows.length;
        const fresh = [];
        for (const s of rows) {
          const pub = sbDate(s.PublicDate);
          if (pub && new Date(pub).getTime() < from) continue;
          const t = parseRow(s, now, { eis });
          if (t.skip) { skipped[t.skip] = (skipped[t.skip] || 0) + 1; continue; }
          if (laws && !laws.includes(t.law)) continue;
          if ((profile.price_min != null && t.price != null && t.price < profile.price_min) || (profile.price_max != null && t.price != null && t.price > profile.price_max)) continue;
          if (!eis) {
            cache.set(t.number, t);
            if (cache.size > 2000) cache.delete(cache.keys().next().value);
          }
          const { items: _i, ...tender } = t;
          fresh.push(tender);
        }
        taken += fresh.length;
        items.push(...fresh);
        if (fresh.length) await onPage(fresh);
        const oldest = rows.map((s) => sbDate(s.PublicDate)).filter(Boolean).sort()[0];
        if (rows.length < 100 || (oldest && new Date(oldest).getTime() < from)) break;
        if (page === maxPages - 1) truncated = true;
      }
      log.log?.(`[sberast${label}] просмотрено ${seen}, взято ${taken}${Object.keys(skipped).length ? `, пропущено: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`);
    }
    let truncated = false;
    if (!laws || laws.includes('com')) await pass({ eis: false, sections: SECTIONS, label: '' });
    if (!laws || laws.includes('44') || laws.includes('223')) await pass({ eis: true, sections: EIS_SECTIONS, label: ', 44/223-ФЗ' });
    return { items, truncated, errors };
  }

  const isSb = (t) => t?.law === 'com' && /^SBAST-\S+$/.test(String(t.number || ''));
  return {
    name: 'sberast',
    laws: ['com', '44', '223'],
    fetchNew,
    /** Перечень товаров — из строки реестра; после перезапуска сервера строку находим поиском по номеру процедуры. */
    async getDetailsDoc(tender) {
      if (!isSb(tender)) return null;
      let t = cache.get(tender.number);
      if (!t) {
        const code = String(tender.number).slice('SBAST-'.length);
        const row = (await ask(listRequest({ size: 20, text: code.replace(/\.\d+$/, '') }))).find((s) => str(s.purchCode) === code);
        const p = row ? parseRow(row, clock(), { open: false }) : null;
        if (p && !p.skip) { t = p; cache.set(t.number, t); }
      }
      if (!t) return null;
      return { items: t.items || [], platform: { name: 'Сбербанк-АСТ', url: 'https://www.sberbank-ast.ru' }, conditions: { deadline_at: t.deadline_at ?? tender.deadline_at ?? null, customer_inn: t.customer_inn ?? null, region: t.region ?? null } };
    },
    /**
     * Сколько заявок подано по закупке ЕИС (номер 19 или 11 цифр) — поиском по номеру в реестре площадки.
     * @returns {Promise<{count: number, stage: string|null}|null>} null — на Сбербанк-АСТ такой закупки нет
     */
    async requestCount(number) {
      const num = String(number || '').trim();
      const rows = await ask(listRequest({ size: 20, text: num, sections: EIS_SECTIONS }));
      const row = rows.find((s) => str(s.purchCode).replace(/\.\d+$/, '') === num || str(s.IntegratorCode) === num);
      if (!row) return null;
      return { count: Number(str(row.totalRequestCount) || str(row.requestCount)) || 0, stage: str(row.PurchaseStageTerm) || null };
    },
    // документы закупки открываются только после входа на площадку — их человек скачивает сам
    async getAttachments() { return []; },
  };
}

module.exports = { createSberAstSource, parseRow, listRequest, sbDate, SECTIONS, EIS_SECTIONS };
