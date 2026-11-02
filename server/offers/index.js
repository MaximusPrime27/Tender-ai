// Поиск поставщиков по позициям закупки: источники → загрузка страниц → извлечение цены → сверка с ТЗ →
// доставка → проверка продавца → ранжирование → лучшее предложение в калькулятор выгодности.
// Работает фоновой задачей по одной закупке за раз, с журналом и лимитами расходов.

const fs = require('node:fs');
const path = require('node:path');
const { createPageFetcher, FetchSkipped, foreignDomain } = require('./fetch-page');
const { extractContacts, contactsFromContractSupplier, mergeContacts, hasContacts, ownDomainOf } = require('./contacts');
const { specsFromChars, productQueryOfLine } = require('./product');
const { findInSitemap } = require('./sitemap');
const { extractOffer } = require('./extract');
const { matchOffer, MATCH_ORDER: MATCH_ORDER_RANK, SUPPLY_TERMS } = require('./match');
const { enrichFromDocs, markDocEvidence } = require('./evidence-docs');
const { baseSpecsFor } = require('./base-enrich');
const { createGroupSources } = require('./group-sources');
const { recount, modelOf, brandOf, noNameCompatible, otherVariant, accessoryPage, pageTitle, missingRows, queriesFor: makerQueries, sameModelPage, mergeMakerChecks, ROUTES, triedText } = require('./maker-search');
const readPdf = async (buffer) => {
  const [f] = await require('../extract').extractFile({ name: 'document.pdf', buffer }, 0, { ocr: { pdfReady: async () => false } });
  return (f?.pages || []).map((p) => p.text).join('\n');
};
const { estimateDelivery, regionFromText, regionFromInn, REGIONS } = require('./logistics');
const { lookupEgrul, assessTrust, validInn } = require('./seller-check');
const { rankOffers, compareOffers, outOfStock, isEligible } = require('./rank');
const { withKind, byKind, competitorPrice, competitorsOf } = require('./seller-kind');
const { createYandexSearch, queriesFor, specQueries, plainQuery, siteQuery, b2bSitesFor } = require('./sources/yandex-search');
const { suggestProducts, pickFromListing } = require('./candidates');
const { cartridgesForDevice } = require('./device-cartridges');
const { createFunnel, describeFunnel, pageReason, DROP_REASONS, PAGE_REASONS } = require('./funnel');
const { readStock, normalizeAvailability } = require('./stock');
const { titleStart, specsFromPage } = require('./product');
const { urlHints } = require('./site-index');
const { kindWords, typeOfCandidate } = require('./listing');
const { benchmarkComparable } = require('../tenders/details');
const { lineVerdict, priceLooksSane } = require('../tenders/item-benchmark');
const { specOf, isSearchable, modelTokens, searchName, distinctiveTerms } = require('./spec');
const { convertPrice } = require('./units');
const { createSupplierCatalog, attachProducts, onSite } = require('./supplier-catalog');
const { cargoOf, loadLogistics } = require('./cargo');
const { allocate } = require('./allocate');
const { createRnpChecker } = require('./rnp');
const { eisGate } = require('../sources/eis-gate');
const { confirmedModels, cardsFrom, cardsByDescription, searchLinks, sameModel } = require('./marketplaces');
const { pickModels } = require('./registry-models');
const { kindOf, NICHE_LABEL } = require('./product-base');

const loadPrompt = (name) => fs.readFileSync(path.join(__dirname, '..', 'analyze', 'prompts', `${name}.md`), 'utf8');
const r2 = (x) => Math.round(x * 100) / 100;
const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; } };

class BudgetExceeded extends Error {}

function createOfferService({ repo, details, llmFactory, config, photos = null, source = null, siteIndex = null, registry = null, productBase = null, fetchImpl = fetch, log = console, clock = () => new Date(), rnpChecker = undefined }) {
  // Проверка продавцов по реестру недобросовестных поставщиков — в фоне, через общую очередь запросов к ЕИС.
  const rnp = {
    checker: rnpChecker !== undefined ? rnpChecker : config.RNP_AUTO ? createRnpChecker({ fetchImpl, gate: eisGate(config.EIS_REQUEST_DELAY_MS ?? 60000), clock }) : null,
    queue: [], pending: new Set(), busy: null, stopped: false,
  };
  const supplierCatalog = createSupplierCatalog({ config, repo, clock });
  const sources = new Set(String(config.OFFER_SOURCES || 'contracts,yandex,stores,manual').split(',').map((s) => s.trim()));
  // Один клиент Яндекса и для текстового поиска, и для поиска по фото (источники yandex и photo).
  const yandex = sources.has('yandex') || sources.has('photo')
    ? createYandexSearch({ apiKey: config.YANDEX_SEARCH_API_KEY, folderId: config.YANDEX_FOLDER_ID, fetchImpl, resultsPerQuery: config.SEARCH_RESULTS_PER_QUERY })
    : null;
  const blocklist = String(config.OFFER_DOMAIN_BLOCKLIST || '').split(',').map((d) => d.trim().replace(/^www\./, '')).filter(Boolean);
  const fetcher = createPageFetcher({ fetchImpl, minIntervalMs: config.FETCH_MIN_INTERVAL_MS, ...(config.FETCH_MAX_BYTES ? { maxBytes: config.FETCH_MAX_BYTES } : {}) });
  let queue = Promise.resolve();
  // Чтение ТЗ из документации перед поиском — задаётся сервером (setTzReader): у сервиса поиска нет доступа к разбору документов.
  let readTz = null;

  // Сайты, закрытые для роботов целиком (401/403, «я не робот»), помним 30 дней: не тратим на них место
  // из SEARCH_MAX_PAGES_PER_ITEM в каждом поиске — его займут магазины, которые открываются.
  const CLOSED_DAYS = 30;
  const isClosed = (d) => {
    const at = repo.getSetting(`closed_domain:${d}`);
    return Boolean(at) && clock().getTime() - new Date(at).getTime() < CLOSED_DAYS * 86400000;
  };
  const markClosed = (d) => { if (d) repo.setSetting(`closed_domain:${d}`, clock().toISOString()); };

  const storesFile = () => {
    try {
      return JSON.parse(fs.readFileSync(config.STORES_CONFIG, 'utf8'));
    } catch {
      return {};
    }
  };
  const storesConfig = () => (storesFile().stores || []).filter((s) => s.enabled);
  /** B2B-каталоги: ищем по ним через поисковик (site:…), сами каталоги напрямую не парсим. */
  const b2bSites = () => (storesFile().b2b || []).filter((s) => s.enabled);
  const sameSiteAs = (list) => (d) => Boolean(d) && list.some((s) => d === s || d.endsWith(`.${s}`));
  /** Оптовые и оптово-розничные поставщики с открытыми ценами — их страницы ищем в собственном каталоге (site-index.js). */
  const suppliers = () => (storesFile().suppliers || []).filter((s) => s.enabled !== false);
  const isSupplier = (d) => sameSiteAs(suppliers().map((s) => s.site))(d);
  /** Крупные розничные сети: цены выше оптовых — как поставщики не нужны, их страницы в поиске не открываем. */
  const retailSites = () => (storesFile().retail || []).map((s) => s.site);
  const isRetail = (d) => sameSiteAs(retailSites())(d);
  // Сайты, где платный поиск нашёл подходящий товар, — в свой каталог: раз в сутки их карта сайта читается вместе с
  // поставщиками из списка, и дальше такие товары находятся бесплатно (offers:discovered_suppliers, не больше 400).
  const DISCOVERED = 'offers:discovered_suppliers';
  const discovered = () => { try { return JSON.parse(repo.getSetting(DISCOVERED) || '[]'); } catch { return []; } };
  function noteDiscovered(domain) {
    const d = String(domain || '').replace(/^www\./, '');
    if (!d || isRetail(d) || isClosed(d) || isSupplier(d) || /ozon|wildberries|market\.yandex|avito|aliexpress|megamarket|zakupki\.gov/.test(d)) return false;
    const list = discovered();
    if (list.some((x) => x.site === d)) return false;
    list.push({ site: d, added_at: clock().toISOString() });
    repo.setSetting(DISCOVERED, JSON.stringify(list.slice(-400)));
    return true;
  }
  // Этап 2: источники по группам товаров — по спискам поставщиков и ценам, которые сервис уже получал
  const groupSources = createGroupSources({ repo, catalog: () => supplierCatalog.list(), stores: storesFile, siteStatus: () => (siteIndex ? siteIndex.status() : null), clock });
  /** Вид продавца для карточки: розничная сеть, оптовый поставщик из нашего списка, либо по основному ОКВЭД (46 — опт, 47 — розница). */
  const sellerType = (o) => {
    if (o.source === 'contracts' || o.source === 'manual') return null;
    if (isRetail(o.domain)) return 'retail';
    if (isSupplier(o.domain)) return 'wholesale';
    const okved = String(o.seller_okved || '');
    return /^46\./.test(okved) ? 'wholesale' : /^(2[6-9]|3[0-2])\./.test(okved) ? 'maker' : /^47\./.test(okved) ? 'shop' : null;
  };
  // Заодно наличие прежних находок («PreOrder», «В корзину») приводится к трём словам — как у новых.
  const withSellerType = (o) => { const t = sellerType(o); return { ...o, seller_type: t, retail: t === 'retail', availability: o.source === 'contracts' ? o.availability : normalizeAvailability(o.availability) }; };
  const indexReady = () => Boolean(siteIndex) && config.SUPPLIER_INDEX !== false && siteIndex.status().pages > 0;

  // ---------- товар и цена у компаний с открытыми ценами (блок «Профильные компании») ----------
  // У магазина из config/stores.json цена на сайте открыта, но раньше в блоке стояла только ссылка на сайт: товар
  // и цену человек искал сам, вбивая модель в поиск магазина. Теперь у каждой такой компании показано, что сервис
  // нашёл на её сайте по этой позиции, а если ничего не искалось — страница товара ищется в своём каталоге страниц
  // поставщиков (бесплатно) и читается так же, как при поиске.
  const LOOKUP_DAYS = 3; // столько помним «на сайте такой модели нет», чтобы не искать при каждом открытии карточки
  const lookupKey = (itemId, site) => `cand_lookup:${itemId}:${site}`;
  /** Итог прошлого поиска товара на сайте компании; null — не искали, искали при другом поиске поставщиков или давно. */
  function lookupState(itemId, site, searchId) {
    try {
      const s = JSON.parse(repo.getSetting(lookupKey(itemId, site)) || 'null');
      if (!s || (s.search_id ?? null) !== (searchId ?? null) || clock().getTime() - new Date(s.at).getTime() > LOOKUP_DAYS * 86400000) return null;
      return s;
    } catch { return null; }
  }
  /** Какие модели искать на сайте компании: модель из ТЗ, иначе модели уже найденных подходящих товаров. */
  function modelsToLookFor(item, own) {
    // Название — до слова «для»: в «Картридж CS-CE285A для принтеров HP P1102» модель товара одна, P1102 — это принтер.
    const ownName = (title) => String(title || '').split(/(?:^|[\s(,])(?:для|for|к)(?=\s)/i)[0];
    const fromTz = [specOf(item).identity?.model, ...modelTokens(ownName(item.name))].filter(Boolean);
    if (fromTz.length) return [...new Set(fromTz)].slice(0, 4);
    const fit = own.filter((o) => o.source !== 'contracts' && (o.match === 'соответствует' || o.match === 'частично'));
    // Все модели подошедших товаров, а не первые несколько: под «диск 8 ТБ» подходит десяток моделей, и у другого
    // магазина может быть любая из них. Сначала модели полностью подтверждённых товаров, потом встречающиеся чаще.
    // «6Gbit», «DDR5», «1200x1200» — характеристики из названия, а не модели.
    const NOT_MODEL = /^(\d+x\d+|\d+([.,]\d+)?(gb|tb|mb|kb|gbit|gbps|mbit|mbps|rpm|mah|wh|w|v|hz|khz|mhz|ghz|dpi|ppm|k|p)|ddr\d\w*|sata\S*|usb\S*|hdmi\S*|pci\S*|rj-?\d+|m\.?2|he\d+|[a-z]\d{1,2}|i[3579]-?\d*\w*|win\S*|type-?c|wi-?fi\S*)$/i;
    const score = new Map();
    for (const o of fit) {
      for (const m of new Set(modelTokens(ownName(o.title)).filter((t) => t.length >= 4 && !NOT_MODEL.test(t)))) {
        const s = score.get(m) || { full: 0, n: 0 };
        s.n++;
        if (o.match === 'соответствует') s.full++;
        score.set(m, s);
      }
    }
    return [...score].sort((a, b) => b[1].full - a[1].full || b[1].n - a[1].n).map(([m]) => m).slice(0, 12);
  }
  /** Компании блока вместе с товаром: что найдено на сайте компании по этой позиции и чем кончился поиск на нём. */
  const candidatesView = (item, own, searchId) => attachProducts(supplierCatalog.forItem(item), own, (site) => lookupState(item.id, site, searchId));

  /**
   * Найти товар на сайтах компаний с открытыми ценами, у которых по позиции ещё ничего не найдено: страница товара —
   * из своего каталога страниц поставщиков (по модели в адресе), цена, наличие и сверка с ТЗ — как при поиске.
   * Платных запросов нет. Итог по каждой паре «позиция — сайт» запоминается, чтобы не искать повторно.
   * @param {{limit?: number, inSearch?: boolean}} p limit — сколько пар проверить за вызов; inSearch — вызов из самого поиска
   * @returns {Promise<{checked: number, found: number, left: number, busy?: boolean}>}
   */
  async function lookupCandidates(tenderId, { limit = 6, inSearch = false } = {}) {
    const tender = repo.getTender(tenderId);
    if (!tender) throw Object.assign(new Error('Закупка не найдена'), { status: 404 });
    const search = repo.lastOfferSearch(tenderId);
    // Пока идёт поиск, он сам положит предложения — не мешаем ему и не дублируем страницы.
    if (!inSearch && search && ['queued', 'running'].includes(search.status)) return { checked: 0, found: 0, left: 0, busy: true };
    if (!indexReady()) return { checked: 0, found: 0, left: 0 };
    const searchId = search?.id ?? null;
    const offers = repo.getOffers(tenderId);
    const todo = [];
    for (const item of repo.getItems(tenderId)) {
      const own = offers.filter((o) => o.item_id === item.id);
      const sites = supplierCatalog.forItem(item).filter((c) => c.access_mode === 'public_site').map((c) => c.site)
        // уже есть товар, который можно покупать, — искать нечего; найден только неподходящий — ищем подходящую модель
        .filter((site) => !own.some((o) => o.source !== 'contracts' && o.unit_price != null && o.match !== 'не соответствует' && onSite(o.domain, site)) && !lookupState(item.id, site, searchId));
      if (!sites.length) continue;
      const models = modelsToLookFor(item, own);
      // Один проход по каталогу на позицию: страницы с моделью сразу у всех нужных сайтов, не больше двух с сайта.
      const pages = models.length ? siteIndex.find(models, { perDomain: 2, limit: sites.length * 2, hints: urlHints(kindWords(item.name)), skip: (url, d) => !sites.some((s) => onSite(d, s)) }) : [];
      const have = new Set(own.map((o) => String(o.url || '').replace(/[?#].*$/, '').replace(/\/$/, '')));
      const fresh = pages.filter((p) => !have.has(p.url.replace(/[?#].*$/, '').replace(/\/$/, ''))); // страницу, которая уже разобрана, второй раз не открываем
      for (const site of sites) todo.push({ item, site, models, pages: fresh.filter((p) => onSite(p.domain, site)) });
    }
    // Сначала те, где страница товара уже известна: остальным достаточно записать «не найдено», это мгновенно.
    todo.sort((a, b) => Number(b.pages.length > 0) - Number(a.pages.length > 0));
    let checked = 0;
    let found = 0;
    let left = 0;
    const econ = repo.getEconomics(tender.id);
    const settings = repo.getProfile().economics;
    for (const t of todo) {
      const save = (status, extra = {}) => repo.setSetting(lookupKey(t.item.id, t.site), JSON.stringify({ at: clock().toISOString(), search_id: searchId, status, models: t.models.slice(0, 4), ...extra }));
      if (!t.models.length) { save('no_model'); continue; }
      if (!t.pages.length) { save('none'); continue; }
      if (isClosed(t.site)) { save('closed'); continue; }
      if (checked >= limit) { left++; continue; }
      checked++;
      const bench = repo.getBenchmark(t.item.ktru_code || t.item.okpd2_code || '');
      const ctx = { searchId, settings, llm: llmFactory(), matchPrompt: loadPrompt('match'), deliveryTermDays: econ?.result?.inputs?.delivery_days ?? settings.default_delivery_days, medianByItem: { [t.item.id]: bench?.unit_price?.median ?? null } };
      let got = 0;
      let reason = null;
      for (const p of t.pages) {
        try {
          const page = await fetcher.fetchPage(p.url);
          const raw = await extractOffer(page, t.item, { llm: ctx.llm, system: loadPrompt('offer'), stockAttr: stockAttrOf(p.url), hasModel: true });
          if (!raw || raw.price == null) { reason = 'на странице товара нет цены'; continue; }
          repo.insertOffer(await enrich({ ...raw, source: 'wholesale', contacts: extractContacts(page.html, page.url) }, { item: t.item, tender, ctx }));
          got++;
        } catch (err) {
          if (err instanceof FetchSkipped) { if (err.closed) markClosed(t.site); reason = PAGE_REASONS[pageReason(err)]; }
          else { reason = 'страницу не удалось разобрать'; log.warn?.(`[offers] товар у ${t.site}: ${err.message}`); }
        }
      }
      if (got) found++;
      save(got ? 'found' : 'no_price', got ? {} : { reason });
    }
    if (found && !inSearch) { autoSelect(tenderId); await details.computeEconomics(tenderId, { fetch: false }); }
    return { checked, found, left };
  }

  // Суточный лимит платных запросов к поисковику — на весь сервис, по московской дате.
  const today = () => new Date(clock().getTime() + 3 * 3600000).toISOString().slice(0, 10);
  /** Атрибут страницы, в котором сайт держит остаток (проверено по его страницам): config/stores.json → stock_attr. */
  const stockAttrOf = (url) => {
    const d = domainOf(url);
    return (storesFile().suppliers || []).find((s) => s.stock_attr && d && (d === s.site || d.endsWith(`.${s.site}`)))?.stock_attr || null;
  };
  /** Почему адрес не берётся в работу ещё до открытия страницы; null — берётся. Причины — ключи funnel.js → DROP_REASONS. */
  const urlDropReason = (url) => {
    const d = domainOf(url);
    if (!d) return 'blocklist';
    if (blocklist.some((b) => d === b || d.endsWith(`.${b}`))) return 'blocklist';
    if (isRetail(d)) return 'retail';
    if (isClosed(d)) return 'closed';
    if (foreignDomain(d)) return 'foreign';
    return null;
  };
  /**
   * Куда везти: регион места поставки из разбора документации, а не регион заказчика — у федеральных заказчиков товар
   * едет в филиалы (заказчик в Москве, поставка в Ростов или Железногорск). Не прочитано — регион заказчика.
   */
  function destRegion(tender) {
    try {
      const a = tender?.analysis_id ? repo.getAnalysis(tender.analysis_id) : null;
      const place = (a?.card?.groups || []).flatMap((g) => g.fields || []).find((x) => x.key === 'delivery_place' && x.status === 'found');
      return (place && regionFromText(place.value)) || tender?.region || null;
    } catch { return tender?.region || null; }
  }
  const dailyLeft = () => config.SEARCH_DAILY_MAX_API_REQUESTS - repo.apiUsage('yandex', today());
  // Адресный поиск недостающих характеристик по модели — свой суточный лимит, не из лимита поиска поставщиков
  const makerLeft = () => (config.MAKER_SEARCH_DAILY ?? 50) - repo.apiUsage('yandex_maker', today());

  /**
   * Добор недостающих характеристик предложения по его модели. Пути по порядку — сначала бесплатные:
   *   1) сохранённое досье модели (страницы, найденные раньше для этой же модели — в любой закупке);
   *   2) страницы других продавцов этой модели из нашей базы;
   *   3) каталог страниц оптовых поставщиков (карты сайтов, без поисковика);
   *   4) поиск в интернете через Яндекс — платно, свой суточный лимит; только если paid и бесплатные пути не закрыли пробелы.
   * Страница засчитывается, только если на ней та же модель и тот же бренд. После каждого пути сверяются лишь
   * оставшиеся неподтверждённые требования; уже подтверждённое или отклонённое не меняется. Что и где искали,
   * сохраняется в сверке (maker.trace) — у неподтверждённого требования видно, почему оно ещё открыто.
   * @returns {Promise<{changed, before, after, queries, pages, trace, reason?}>}
   */
  // save=false — для карточки маркетплейса, которой нет в базе предложений: только проверить и вернуть сверку
  async function makerEnrich(offer, { budget = { left: 2 }, paid = true, freePages = { left: 8 }, log: logFn = () => {}, save = true } = {}) {
    const item = repo.getItems(offer.tender_id).find((i) => i.id === offer.item_id);
    const empty = (reason) => ({ changed: 0, before: offer.match, after: offer.match, queries: 0, pages: [], trace: [], reason });
    if (!item || !missingRows(offer.match_checks).length) return empty('недостающих требований нет');
    const model = modelOf(offer.title);
    if (!model) return empty('в названии товара нет модели — искать по ней нельзя');
    // совместимый без своего бренда назван номером оригинала: берём данные только других СОВМЕСТИМЫХ картриджей этой
    // модели — характеристики оригинала к нему не относятся
    const family = noNameCompatible(offer.title);
    const brand = brandOf(offer.title);
    const key = `maker:${String(brand || '').toLowerCase()}:${model.toLowerCase()}`;
    let cache = null;
    try { cache = JSON.parse(repo.getSetting(key) || 'null'); } catch { cache = null; }
    const fresh = cache && Date.now() - Date.parse(cache.at) < (config.MAKER_CACHE_DAYS ?? 30) * 86400e3;
    const dossier = fresh ? (cache.pages || []).map((p) => ({ route: 'memory', ...p, route_was: p.route })) : [];
    const sc = repo.getDetails?.(offer.tender_id)?.spec_coverage;
    const specComplete = !sc || !['partial', 'failed'].includes(sc.status);
    const seen = new Set([offer.url, ...dossier.map((p) => p.url)].filter(Boolean));
    const used = [];   // страницы, по которым сверяли
    const found = [];  // новые страницы — в досье
    const trace = [];
    let current = offer.match_checks;
    let match = offer.match;
    let changed = 0;
    let queries = 0;

    // Сверка оставшихся пробелов по новым страницам; уже подтверждённое не трогаем.
    const check = async (pages) => {
      const left = missingRows(current);
      if (!left.length || !pages.length) return 0;
      const names = new Set(left.map((r) => r.name));
      const required = specOf(item).required.filter((r) => names.has(r.name));
      const sub = await matchOffer({ ...item, characteristics: [], spec: { ...(item.spec || {}), required: required.length ? required : left.map((r) => ({ name: r.name, value: r.need })) } },
        { title: offer.title, text: pages.map((p) => `[Источник: ${p.domain}]\n${p.text}`).join('\n\n'),
          // таблицы характеристик найденных страниц — для сверки по словарю синонимов, с пометкой сайта
          specs: pages.flatMap((p) => (p.specs || []).map((x) => ({ ...x, src: p.domain }))) }, { llm: llmFactory(), system: loadPrompt('match'), partShare: config.MATCH_PART_SHARE });
      const merged = mergeMakerChecks(current, sub, pages, { specComplete });
      used.push(...pages);
      if (merged.changed) { current = merged.checks; match = merged.match; changed += merged.changed; }
      return merged.changed;
    };
    // Открыть страницу и оставить, только если на ней та же модель того же бренда.
    const open = async (url, route) => {
      if (seen.has(url)) return null;
      seen.add(url);
      try {
        const p = await fetcher.fetchPage(url);
        // та же модель того же бренда, не другое исполнение («…/…/…») и не принадлежность к ней («… для модели»)
        if (!sameModelPage(p.text, model, brand) || otherVariant(p.html, model, offer.title) || accessoryPage(p.html, model)) return null;
        if (family && !/совместим|аналог|compatible/i.test(pageTitle(p.html) || '')) return null;
        const page = { url: p.url || url, domain: domainOf(p.url || url), text: String(p.text || '').slice(0, 12000), route, specs: specsFromPage(p.html) };
        found.push(page);
        return page;
      } catch { return null; }
    };
    const step = async (route, pages, note = null) => {
      const closed = await check(pages);
      trace.push({ route, pages: pages.length, closed, note: note || (pages.length ? `стр.: ${pages.length}, подтверждено: ${closed}` : 'страниц этой модели нет') });
      if (closed) logFn('info', `«${offer.title.slice(0, 50)}»: ${ROUTES[route].label} — подтверждено ещё ${closed}`);
    };
    const gaps = () => missingRows(current).length > 0;

    // 1. сохранённое досье модели
    if (dossier.length) await step('memory', dossier);
    // 2. другие продавцы этой модели из нашей базы — их страницы открываем заново (сохранённое — урезано)
    if (gaps()) {
      const peers = repo.offersByTitleLike(model).filter((o) => o.url && o.domain !== offer.domain && modelOf(o.title)?.toLowerCase() === model.toLowerCase()
        && (!brand || String(brandOf(o.title) || '').toLowerCase() === brand.toLowerCase()) && !urlDropReason(o.url));
      const pages = [];
      const domains = new Set();
      for (const o of peers) {
        if (pages.length >= 2 || freePages.left <= 0) break;
        if (domains.has(o.domain)) continue;
        domains.add(o.domain);
        freePages.left--;
        const p = await open(o.url, 'peers');
        if (p) pages.push(p);
      }
      await step('peers', pages, peers.length ? null : 'других продавцов этой модели в базе нет');
    }
    // 3. каталог страниц оптовых поставщиков — по модели в адресах страниц, бесплатно
    if (gaps()) {
      if (!indexReady()) trace.push({ route: 'catalog', pages: 0, closed: 0, note: 'каталог страниц ещё не собран' });
      else {
        const hits = siteIndex.find([model], { perDomain: 1, limit: 4, skip: (url, d) => seen.has(url) || d === offer.domain || isClosed(d) });
        const pages = [];
        for (const h of hits) {
          if (pages.length >= 3 || freePages.left <= 0) break;
          freePages.left--;
          const p = await open(h.url, 'catalog');
          if (p) pages.push(p);
        }
        await step('catalog', pages, hits.length ? null : 'в каталоге поставщиков этой модели нет');
      }
    }
    // 4. поиск в интернете — платно, последним
    if (gaps()) {
      if (!paid) trace.push({ route: 'web', pages: 0, closed: 0, note: 'не запускался: платный поиск — только у самых дешёвых или по кнопке' });
      else if (!yandex) trace.push({ route: 'web', pages: 0, closed: 0, note: 'выключен: нет ключа Яндекса' });
      else if (makerLeft() <= 0) trace.push({ route: 'web', pages: 0, closed: 0, note: `лимит на сегодня исчерпан (${config.MAKER_SEARCH_DAILY ?? 50} запросов)` });
      else {
        const pages = [];
        for (const q of makerQueries(offer.title, missingRows(current))) {
          if (budget.left <= 0 || makerLeft() <= 0) break;
          budget.left--; queries++;
          repo.addApiUsage('yandex_maker', today());
          let results = [];
          try { results = await yandex.search(q); } catch (err) { logFn('warn', `Поиск по модели «${q}»: ${err.message}`); continue; }
          logFn('info', `Поиск по модели «${q}»: ${results.length} результатов`);
          for (const r of results.slice(0, 6)) {
            // розничные сети в закупочную цену не идут, но характеристики модели у них брать можно
            const why = urlDropReason(r.url);
            if (pages.length >= 3 || (why && why !== 'retail')) continue;
            const p = await open(r.url, 'web');
            if (p) pages.push(p);
          }
        }
        await step('web', pages, queries ? null : 'запросов не осталось');
      }
    }

    // досье модели: найденные страницы пригодятся другим продавцам и другим закупкам (повторно не платим)
    if (found.length) {
      const keep = [...found, ...(fresh ? cache.pages || [] : [])].filter((p, i, a) => a.findIndex((x) => x.url === p.url) === i).slice(0, 8)
        .map((p) => ({ url: p.url, domain: p.domain, text: p.text, specs: p.specs || [], route: p.route_was || p.route }));
      repo.setSetting(key, JSON.stringify({ at: new Date().toISOString(), model, brand, pages: keep }));
    }
    // где искали — в сверке; у оставшихся пробелов — подсказка, что пробовали
    const tried = triedText(trace);
    const rows = (current.rows || []).map((r) => (r.verdict === 'unknown' && !SUPPLY_TERMS.test(r.name) ? { ...r, tried } : r));
    const checks = { ...current, rows, maker: { model, brand, family, at: new Date().toISOString(), changed, trace, pages: [...new Map(used.map((p) => [p.url, { url: p.url, domain: p.domain, route: p.route_was || p.route }])).values()] } };
    const notes = changed
      ? [`Добор по модели ${model}: подтверждено ещё ${changed} требований (${[...new Set(used.map((p) => p.domain))].join(', ')})`, ...(offer.match_notes || []).filter((n) => !/^(Поиск|Добор) по модели/.test(n))].slice(0, 8)
      : offer.match_notes;
    if (save) repo.setOfferMatch(offer.id, { match: changed ? match : offer.match, notes, checks });
    const reason = changed ? null : trace.length ? `не нашлось: ${tried}` : 'нечего искать';
    return { changed, before: offer.match, after: changed ? match : offer.match, queries, pages: checks.maker.pages, trace, reason, checks, notes };
  }

  /**
   * Запрос к маркетплейсам для позиции. Есть модель, сверенная с ТЗ, — по ней. Модели нет (картридж «для Kyocera P7240cdn»,
   * пурпурный) — по описанию из ТЗ: вид товара + для какого устройства + цвет; модель берём из названия найденной карточки.
   */
  function marketQuery(item, itemOffers) {
    const models = confirmedModels(item, itemOffers).filter((m) => m.model);
    if (models.length) return { query: models[0].query, model: models[0].model, basis: models[0].basis };
    const spec = specOf(item);
    // вид товара — по своей базе («Тонер — картридж CF226Х» — картридж, а не тонер), иначе первое слово наименования
    const known = kindOf(item.name, { code: item.ktru_code || item.okpd2_code });
    const kind = known ? `${known.label[0].toUpperCase()}${known.label.slice(1)}`.replace(/\s*\(.*?\)/, '')
      : (searchName(item.name).split(/\s+/).filter(Boolean)[0] || String(item.name).split(/\s+/)[0] || '').trim();
    const val = (re) => (spec.required || []).find((r) => re.test(r.name))?.value || (item.characteristics || []).find((c) => re.test(c.name))?.value || null;
    // Устройство — одно, первое из списка: на запрос «Картридж Xerox B225; Xerox B230; Xerox B235 Черный» поиск
    // карточек маркетплейсов не находит; «Картридж Xerox B225 черный» — находит (карточки называют совместимые модели сами)
    const compatAll = spec.identity?.compatible_with || val(/совмест|применим|применяется|печатающ\S*\s+устройств|для\s+устройств|модел\S*\s+(?:принтер|устройств|мфу)/i);
    const compat = compatAll ? String(compatAll).split(/[;,\n]/)[0].split(/\s*\/\s*/)[0].replace(/\s+/g, ' ').trim().slice(0, 60) : null;
    const color = val(/^цвет/i);
    const extra = compat ? [compat, color] : (spec.required || []).slice(0, 3).map((r) => require('./spec').searchValue?.(r)).filter(Boolean).slice(0, 2);
    const query = [kind, spec.identity?.brand, ...extra].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return query.split(' ').length >= 2 ? { query, model: null, basis: compat ? `по ТЗ: ${kind} для ${compat}${color ? `, ${color}` : ''}` : 'по описанию из ТЗ' } : null;
  }

  /**
   * Маркетплейсы (Ozon, Wildberries, Яндекс Маркет, Мегамаркет) для позиций без подходящего товара с ценой.
   * Сами маркетплейсы закрыты для программ: карточки находит официальный поиск Яндекса (1 платный запрос на позицию,
   * общий суточный лимит поиска), каждая карточка сверяется с ТЗ по названию и описанию из поиска, недостающее —
   * бесплатно по модели с других сайтов. Цену человек смотрит по ссылке и вписывает — тогда предложение идёт в расчёт.
   * Результат по позиции хранится 3 дня (повторно не платим).
   */
  async function marketplaceFill(tenderId, { auto = false, itemIds = null, force = false, log: logFn = () => {} } = {}) {
    const out = { items: 0, fit: 0, spent: 0, error: null };
    const limit = auto ? (config.MARKETPLACE_AUTO_ITEMS ?? 5) : 20;
    if (limit <= 0) return out;
    if (!yandex) { out.error = 'Поиск на маркетплейсах идёт через поиск Яндекса, а ключа Яндекса нет'; return out; }
    const offers = repo.getOffers(tenderId);
    const sc = repo.getDetails?.(tenderId)?.spec_coverage;
    const specComplete = !sc || !['partial', 'failed'].includes(sc.status);
    let items = repo.getItems(tenderId);
    items = itemIds ? items.filter((i) => itemIds.includes(i.id))
      // нет ни одного товара «соответствует» с ценой — позиция не закрыта
      : items.filter((i) => !offers.some((o) => o.item_id === i.id && o.source !== 'contracts' && o.match === 'соответствует' && o.unit_price != null));
    for (const item of items.slice(0, limit)) {
      const key = `mpauto:${item.id}`;
      let saved = null;
      try { saved = JSON.parse(repo.getSetting(key) || 'null'); } catch { saved = null; }
      if (!force && saved && clock() - new Date(saved.at) < 3 * 86400000) continue;
      // Карточки той же модели уже находили в другой закупке — показываем их из своей базы, без платного запроса.
      // По кнопке («искать заново») — всегда новый поиск.
      const reused = force ? [] : reusedCards(item);
      if (reused.length) {
        repo.setSetting(key, JSON.stringify({ at: clock().toISOString(), query: reused[0].model, basis: 'из своей базы: карточки, найденные раньше в других закупках, без запроса к поиску', model: reused[0].model, cards: reused, reused: true }));
        out.items++; out.fit += reused.length; out.reused = (out.reused || 0) + 1;
        logFn('info', `Маркетплейсы «${item.name.slice(0, 50)}»: карточки из своей базы (${reused.map((c) => c.market_name).join(', ')}) — без запроса к поиску`);
        continue;
      }
      const q = marketQuery(item, offers.filter((o) => o.item_id === item.id));
      if (!q) continue;
      if (dailyLeft() <= 0) { out.error = `Исчерпан суточный лимит запросов к поисковику (${config.SEARCH_DAILY_MAX_API_REQUESTS}) — продолжите завтра`; break; }
      repo.addApiUsage('yandex', today());
      out.spent++; out.items++;
      let results = [];
      try { results = await yandex.search(`${q.query} (site:ozon.ru | site:wildberries.ru | site:market.yandex.ru | site:megamarket.ru)`); }
      catch (err) { out.error = `Поиск Яндекса не ответил: ${err.message}`; break; }
      const cards = (q.model ? cardsFrom(results, q.model) : cardsByDescription(results)).slice(0, 6);
      const checked = [];
      for (const c of cards) {
        // карточку не открываем (маркетплейс закрыт) — сверяем название и описание из поиска
        // поиск обрезает длинное название («…для Kyocera...»), а в адресе карточки оно целиком: «…-purpurnyy-13000-str-…»
        const slug = (() => { try { return decodeURIComponent(new URL(c.url).pathname).split('/').filter(Boolean).pop().replace(/-\d{6,}$/, '').replace(/-/g, ' ').replace(/(\d)\s+str(?![a-z])/gi, '$1 стр'); } catch { return ''; } })();
        // из адреса карточки — цвет (латиницей: «chernyy») и ресурс («13000-str», «-13k-»): обрезанное название их теряет
        const COLORS = { chernyy: 'черный', chernyj: 'черный', black: 'черный', zheltyy: 'желтый', zheltyj: 'желтый', yellow: 'желтый', purpurnyy: 'пурпурный', purpurnyj: 'пурпурный', magenta: 'пурпурный', goluboy: 'голубой', goluboj: 'голубой', cyan: 'голубой' };
        const slugColor = Object.entries(COLORS).find(([k]) => new RegExp(`(^|\\s)${k}(\\s|$)`).test(slug.replace(/hi\s+black/gi, ' ')))?.[1] || null; // «hi-black» — бренд, не цвет
        const res = /(\d{4,6})\s*стр/.exec(slug)?.[1] || (/(?:^|\s)(\d{1,2})k(?:\s|$)/i.exec(slug)?.[1] ? String(Number(/(?:^|\s)(\d{1,2})k(?:\s|$)/i.exec(slug)[1]) * 1000) : null);
        const slugSpecs = [slugColor ? { name: 'Цвет', value: slugColor, src: 'адрес карточки' } : null, res ? { name: 'Ресурс', value: `${res} стр.`, src: 'адрес карточки' } : null].filter(Boolean);
        const sub = await matchOffer(item, { title: c.title, text: `${c.title}. ${c.snippet || ''}. Адрес карточки: ${slug}${slugColor ? `, цвет ${slugColor}` : ''}${res ? `, ресурс ${res} стр.` : ''}`, specs: slugSpecs },
          { llm: llmFactory(), system: loadPrompt('match'), partShare: config.MATCH_PART_SHARE, specComplete }).catch(() => ({ match: 'не хватает данных', notes: [] }));
        let card = { ...c, model: modelOf(c.title), match: sub.match, notes: (sub.notes || []).slice(0, 4), checks: sub.checks || null };
        // недостающее — по модели карточки со страниц других продавцов и из каталога поставщиков (бесплатно)
        if (card.model && sub.checks && missingRows(sub.checks).length && ['частично', 'не хватает данных'].includes(sub.match)) {
          const r = await makerEnrich({ id: null, tender_id: tenderId, item_id: item.id, title: c.title, url: c.url, domain: c.market, match: sub.match, match_checks: sub.checks, match_notes: sub.notes },
            { paid: false, save: false, freePages: { left: 4 }, log: logFn }).catch(() => null);
          if (r?.checks) card = { ...card, match: r.after, notes: (r.notes || card.notes).slice(0, 4), checks: r.checks };
        }
        checked.push(card);
      }
      checked.sort((a, b) => (MP_ORDER[a.match] ?? 3) - (MP_ORDER[b.match] ?? 3));
      out.fit += checked.filter((c) => c.match === 'соответствует' || c.match === 'частично').length;
      repo.setSetting(key, JSON.stringify({ at: clock().toISOString(), query: q.query, basis: q.basis, model: q.model, cards: checked }));
      rememberCards(item, checked);
      logFn('info', `Маркетплейсы «${q.query}»: карточек ${cards.length}, подходят ${checked.filter((c) => c.match === 'соответствует').length}`);
    }
    return out;
  }
  const MP_ORDER = { 'соответствует': 0, 'частично': 1, 'не хватает данных': 2, 'не соответствует': 3 };

  /**
   * Подошедшие карточки маркетплейсов — в свою базу товаров (у модели появляется источник «маркетплейс»): в следующей
   * закупке на ту же модель ссылка будет сразу, без платного запроса. Значения, подтверждённые сверкой, — тоже.
   */
  function rememberCards(item, cards) {
    if (!productBase) return;
    for (const c of cards) {
      if (c.match !== 'соответствует' && c.match !== 'частично') continue;
      const own = kindOf(c.title);
      const kind = own || baseKind(item);
      const model = c.model || modelOf(c.title);
      if (!kind || !model || (own && baseKind(item) && own.niche !== baseKind(item).niche)) continue;
      const specs = (c.checks?.rows || []).filter((r) => r.verdict === 'yes' && r.found && !/нейросеть|не проверено|на странице нет/i.test(r.found))
        .map((r) => ({ name: r.name, value: String(r.found).slice(0, 200), src: c.url, from: 'карточка маркетплейса' }));
      try {
        productBase.upsert({ kind, brand: brandOf(c.title), model, title: c.title, specs, sources: [{ url: c.url, type: 'marketplace', name: c.market_name, market: c.market, title: c.title, at: clock().toISOString() }] });
      } catch (err) { log.warn?.(`[products] карточка маркетплейса: ${err.message}`); }
    }
  }
  /**
   * Карточки маркетплейсов из своей базы для позиции: у товаров, которые подошли по ТЗ при подборе из базы, и у модели,
   * названной в ТЗ. Сверка — та, что была при подборе из базы; у модели из ТЗ — «частично» (сверьте по ссылке).
   */
  function reusedCards(item) {
    if (!productBase) return [];
    const picks = (savedBase(item.id)?.models || []).filter((m) => m.product_id && (m.match === 'соответствует' || m.match === 'частично'));
    const tzModel = specOf(item).identity?.model;
    const byModel = tzModel ? productBase.findModel(tzModel, baseKind(item)?.niche || null) : null;
    if (byModel && !picks.some((m) => m.product_id === byModel.id)) picks.push({ product_id: byModel.id, match: 'частично', model: byModel.model, checks: null, notes: ['модель из ТЗ — сверьте карточку по ссылке'] });
    const out = [];
    for (const m of picks) {
      const p = productBase.get(m.product_id);
      for (const s of (p?.sources || []).filter((x) => x.type === 'marketplace').slice(-3)) {
        out.push({ market: s.market, market_name: s.name, url: s.url, title: s.title || p.title, model: p.model, match: m.match, checks: m.checks || null,
          notes: [...(m.notes || []).slice(0, 2), `найдено ${String(s.at || '').slice(0, 10)} в другой закупке — без нового запроса к поиску`] });
      }
    }
    return out.slice(0, 6);
  }
  /** Сохранённые карточки маркетплейсов позиции — для списка поставщиков. */
  const marketplaceView = (itemId) => {
    try {
      const s = JSON.parse(repo.getSetting(`mpauto:${itemId}`) || 'null');
      if (!s) return null;
      const fit = s.cards.filter((c) => c.match !== 'не соответствует');
      return { at: s.at, query: s.query, basis: s.basis, cards: fit, rejected: s.cards.length - fit.length, reused: Boolean(s.reused) };
    } catch { return null; }
  };

  // ---------- своя база товаров (product-base.js): подбор по ТЗ сначала из неё ----------
  // Компьютеры, картриджи и расходники, оргтехника, комплектующие. В базе — модели производителей из реестра и товары,
  // найденные при прошлых поисках, с характеристиками и источником каждого значения.
  const BASE_DAYS = 7; // столько хранится подбор по позиции; база пополняется после каждого поиска и раз в сутки
  const baseKey = (itemId) => `pbase:item:${itemId}`;
  const savedBase = (itemId) => { try { return JSON.parse(repo.getSetting(baseKey(itemId)) || 'null'); } catch { return null; } };
  const baseKind = (item) => kindOf(item.name, { code: item.ktru_code || item.okpd2_code });
  /** Подбор из базы по позиции для карточки; null — позиция не из ниш базы. */
  function baseView(item) {
    const kind = baseKind(item);
    if (!kind || !productBase) return null;
    const st = productBase.status();
    const makers = registry && ['laptop', 'pc', 'aio', 'monitor'].includes(kind.id) ? registry.status().makers.filter((m) => m.status === 'ok').map((m) => m.name) : [];
    return { kind: kind.id, kind_label: kind.label, niche: NICHE_LABEL[kind.niche], catalog: st.kinds[kind.id] || 0, makers, ...(savedBase(item.id) || {}) };
  }
  /**
   * Сверить с ТЗ позиции все товары этого вида из базы: по таблице характеристик и справочникам (бесплатно),
   * лучшие PRODUCT_BASE_LLM_TOP — ещё и нейросетью. Итог хранится BASE_DAYS дней.
   */
  async function baseFill(tenderId, item, { force = false, log: logFn = () => {} } = {}) {
    const kind = baseKind(item);
    if (!kind || !productBase) return null;
    const saved = savedBase(item.id);
    if (!force && saved && clock() - new Date(saved.at) < BASE_DAYS * 86400000) return baseView(item);
    const models = productBase.list(kind.id);
    if (!models.length) return baseView(item);
    const sc = repo.getDetails?.(tenderId)?.spec_coverage;
    const specComplete = !sc || !['partial', 'failed'].includes(sc.status);
    const r = await pickModels(item, models, { matchOffer, llm: llmFactory(), system: loadPrompt('match'), top: config.PRODUCT_BASE_LLM_TOP ?? 6, specComplete, partShare: config.MATCH_PART_SHARE });
    repo.setSetting(baseKey(item.id), JSON.stringify({ at: clock().toISOString(), ...r }));
    const fit = r.models.filter((m) => m.match === 'соответствует' || m.match === 'частично');
    logFn('info', `«${item.name.slice(0, 60)}»: своя база товаров — сверено ${r.considered}, не подходят ${r.rejected}${fit.length ? `, лучшие: ${fit.map((m) => `${m.model} (${m.checks?.confirmed ?? '?'} из ${m.checks?.total ?? '?'})`).join('; ')}` : ''}`);
    return baseView(item);
  }
  const KIND_QUERY = { laptop: 'Ноутбук', pc: 'Компьютер', aio: 'Моноблок', monitor: 'Монитор' };
  /** Подошедшие товары из базы — кандидаты для поиска у поставщиков (как подобранные нейросетью товары). */
  const baseCandidates = (view) => (view?.models || []).filter((m) => m.match === 'соответствует' || m.match === 'частично').slice(0, 4)
    .map((m) => {
      const name = m.maker_name && !compactName(m.model).includes(compactName(m.maker_name)) && !m.from_registry ? `${m.maker_name} ${m.model}` : m.model;
      // «системный блок (ПК)» → «Системный блок»
      const kindWord = KIND_QUERY[view.kind] || (view.kind_label[0].toUpperCase() + view.kind_label.slice(1)).replace(/\s*\(.*?\)/, '');
      return { name: m.title, model: m.model, query: `${kindWord} ${name} купить`, base: true };
    });
  const compactName = (x) => String(x || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');

  /**
   * Добор у лидеров позиций при поиске: бесплатными путями — у MAKER_FREE_TOP самых дешёвых не отклонённых предложений
   * с пробелами, платным поиском — только у MAKER_SEARCH_TOP самых дешёвых. Одна модель — один раз.
   */
  async function makerPass(tenderId, { log: logFn = () => {} } = {}) {
    let offers = 0; let changed = 0;
    const freePages = { left: config.MAKER_FREE_PAGES_PER_SEARCH ?? 20 };
    for (const item of repo.getItems(tenderId)) {
      const leaders = repo.getOffers(tenderId).filter((o) => o.item_id === item.id && o.url && o.source !== 'contracts' && o.unit_price != null
        && ['частично', 'не хватает данных'].includes(o.match) && missingRows(o.match_checks).length)
        .sort((a, b) => a.unit_price - b.unit_price).slice(0, Math.max(config.MAKER_FREE_TOP ?? 5, config.MAKER_SEARCH_TOP ?? 2));
      const budget = { left: config.MAKER_SEARCH_PER_ITEM ?? 3 };
      const models = new Set();
      for (const [i, o] of leaders.entries()) {
        const m = modelOf(o.title);
        if (!m || models.has(m.toLowerCase())) continue; // одну модель у двух продавцов ищем один раз
        models.add(m.toLowerCase());
        const paid = i < (config.MAKER_SEARCH_TOP ?? 2) && (config.MAKER_SEARCH_DAILY ?? 50) > 0;
        const r = await makerEnrich(o, { budget, paid, freePages, log: logFn }).catch((err) => { logFn('warn', `Добор по модели: ${err.message}`); return null; });
        offers++;
        if (r?.changed) { changed += r.changed; logFn('info', `«${o.title.slice(0, 50)}»: по модели подтверждено ещё ${r.changed} требований, сверка «${r.after}»`); }
      }
    }
    return { offers, changed };
  }

  /** Состояние источников — для интерфейса («почему не ищет в Яндексе»). */
  function sourcesStatus() {
    return {
      contracts: sources.has('contracts'),
      yandex: yandex && sources.has('yandex') ? 'on' : sources.has('yandex') ? 'no_key' : 'off',
      photo: sources.has('photo') ? (yandex ? 'on' : 'no_key') : 'off',
      stores: sources.has('stores') ? storesConfig().map((s) => s.name) : [],
      b2b: sources.has('b2b') && yandex ? b2bSites().map((s) => s.name) : [],
      // Собственный каталог страниц оптовых поставщиков: сколько сайтов и страниц в нём сейчас.
      products: productBase ? productBase.status().total : null,
      suppliers: siteIndex && config.SUPPLIER_INDEX !== false ? (() => { const st = siteIndex.status(); return { sites: st.ready, pages: st.pages, of: suppliers().length, running: st.running, updated_at: st.sites.map((x) => x.refreshed_at).filter(Boolean).sort().pop() || null }; })() : null,
      retail: (storesFile().retail || []).map((s) => s.name),
      yandex_daily_left: yandex ? Math.max(0, dailyLeft()) : null,
      maker_daily_left: yandex ? Math.max(0, makerLeft()) : null,
      dadata: config.DADATA_API_KEY ? 'on' : 'no_key',
    };
  }

  // ---------- обогащение предложения: цена за единицу, сверка, доставка, продавец ----------
  async function enrich(raw, { item, tender, ctx }) {
    const pack = raw.pack_qty && raw.pack_qty > 1 && !/упак/i.test(item.unit || '') ? raw.pack_qty : 1;
    const unitPrice = raw.price != null ? r2(raw.price / pack) : null;
    const qty = item.quantity || 1;
    const goodsCost = unitPrice != null ? r2(unitPrice * qty) : null;

    let match;
    if (raw.contract_verdict) {
      const v = raw.contract_verdict;
      match = raw.unconverted
        ? { match: 'не хватает данных', notes: ['единица в контракте не пересчитывается в единицу заказчика'] }
        : !priceLooksSane(item, unitPrice)
          ? { match: 'не хватает данных', notes: [`цена по контракту ${unitPrice} ₽ слишком сильно отличается от цены заказчика ${item.unit_price} ₽ — похоже на ошибку в реестре или другую позицию`] }
        : v.verdict === 'same' ? { match: 'соответствует', notes: [`тот же товар по госконтракту: ${v.reason}`] }
          : v.verdict === 'different' ? { match: 'не соответствует', notes: [`по госконтракту поставлялся другой товар: ${v.reason}`] }
            : { match: 'не хватает данных', notes: [`по наименованию в контракте не понять, тот же ли это товар (${v.reason}) — спросите у поставщика`] };
    } else if (raw.source === 'contracts') {
      // Под одним кодом КТРУ/ОКПД2 бывают разные товары (картриджи от 87 до 16 600 ₽) — несопоставимую цену не берём.
      match = benchmarkComparable(item, { unit_price: { p25: raw.price } })
        ? { match: 'не хватает данных', notes: ['цена из госконтракта на товар с тем же кодом — конкретную модель уточните у поставщика'] }
        : { match: 'не соответствует', notes: ['цена госконтракта несопоставима с ценой заказчика: под этим кодом другой товар — поставщика можно спросить о нужной модели'] };
    } else {
      // ТЗ прочитано не полностью (часть страниц или таблиц потеряна) — «соответствует» не ставится: требования могли выпасть
      const sc = repo.getDetails?.(tender.id)?.spec_coverage;
      const specComplete = !sc || !['partial', 'failed'].includes(sc.status);
      const matchOpts = { llm: ctx.llm, system: ctx.matchPrompt, partShare: config.MATCH_PART_SHARE, specComplete };
      match = await matchOffer(item, raw, matchOpts);
      // Добор: остались неподтверждённые требования — дочитываем вкладку «Характеристики» и PDF-паспорт с той же
      // страницы (ссылки с неё самой, платного поиска нет). Лимит документов — на весь поиск.
      if (config.SEARCH_DOC_ENRICH !== false && match.match !== 'не соответствует' && match.checks?.unknown > 0 && raw.doc_links?.length && raw.price != null) {
        ctx.docBudget ||= { left: config.SEARCH_DOCS_PER_SEARCH ?? 12 };
        const r = await enrichFromDocs({ offer: raw, item, links: raw.doc_links, fetcher, matchFn: (it, of) => matchOffer(it, of, matchOpts), maxDocs: config.SEARCH_DOCS_PER_OFFER ?? 2, readPdf, budget: ctx.docBudget })
          .catch((err) => { log.warn?.(`[offers] добор характеристик: ${err.message}`); return null; });
        if (r?.match) match = markDocEvidence(match, r.match, r.docs);
        else if (r?.docs?.length && match.checks) match.checks.docs = r.docs;
      }
      // Добор из своей базы товаров (base-enrich.js): та же модель, собранная разведчиком, — бесплатно. Берём, только
      // если сверка стала лучше: «не соответствует» из-за значения базы предложение не получает (это значение не продавца)
      if (productBase && match.match !== 'не соответствует' && match.match !== 'соответствует' && config.SEARCH_BASE_ENRICH !== false) {
        const b = baseSpecsFor({ productBase, db: repo.db, offer: raw, item });
        if (b) {
          const m2 = await matchOffer(item, { ...raw, specs: b.specs }, matchOpts);
          const rank = { 'соответствует': 3, 'частично': 2, 'не хватает данных': 1, 'не соответствует': 0 };
          if ((rank[m2.match] ?? 0) > (rank[match.match] ?? 0)) {
            match = { ...m2, notes: [...(m2.notes || []), `характеристики дополнены из своей базы товаров (модель ${b.product.model}, ${b.added} знач.) — у продавца на странице их нет`] };
            raw = { ...raw, specs: b.specs, base_product_id: b.product.id };
          }
        }
      }
    }

    const sellerRegion = raw.seller_region ?? regionFromInn(raw.seller_inn);
    // Вес и объём единицы товара — со страницы, иначе оценка по виду товара: по ним считается перевозчик.
    // Победителю прошлого госконтракта доставку не считаем по сетке: это конкурент, а не продавец.
    const logistics = loadLogistics(config.LOGISTICS_CONFIG);
    const cargo = raw.source === 'contracts' ? null : cargoOf({ specs: raw.specs, itemName: item.name, settings: logistics });
    const delivery = estimateDelivery({
      sellerRegion, customerRegion: destRegion(tender), goodsCost: goodsCost || 0,
      sellerDeliveryDays: raw.delivery_days, sellerDeliveryCost: raw.delivery_cost,
      cargo, quantity: qty, logistics,
      deliveryTermDays: ctx.deliveryTermDays, logisticsPct: ctx.settings.logistics_pct,
      settings: {
        km_per_day: ctx.settings.delivery_km_per_day, handling_days: ctx.settings.delivery_handling_days,
        min_cost: ctx.settings.delivery_min_cost, reserve_days: ctx.settings.delivery_reserve_days,
      },
    });

    // Победитель госконтракта — копим репутацию ИНН между поисками.
    if (raw.source === 'contracts' && validInn(raw.seller_inn)) repo.noteSellerContract(raw.seller_inn, raw.seller_name);
    const seller = raw.seller_inn ? await checkSeller(raw.seller_inn, raw.seller_name, ctx) : null;
    const { trust, reasons, verified } = assessTrust({
      inn: raw.seller_inn, egrul: seller?.egrul, price: unitPrice, medianPrice: ctx.medianByItem[item.id],
      hasInnOnSite: raw.seller_inn_on_site, decision: seller?.decision, now: clock(),
      govContracts: seller?.gov_contracts || (raw.source === 'contracts' ? 1 : 0), innFromRegistry: raw.source === 'contracts',
    });

    const contacts = await contactsFor(raw, match.match);

    return {
      contacts, image_url: raw.image_url ?? null, specs: raw.specs || [],
      // Магазин: цена со страницы на момент поиска; госконтракт: дата контракта.
      price_date: raw.price_date || (raw.source === 'contracts' ? null : clock().toISOString()),
      tender_id: tender.id, item_id: item.id, search_id: ctx.searchId ?? null, source: raw.source,
      title: raw.title, url: raw.url, domain: raw.url ? domainOf(raw.url) : null,
      price: raw.price, unit: raw.unit, pack_qty: pack, unit_price: unitPrice, availability: raw.availability, condition: raw.condition || null,
      seller_name: raw.seller_name || seller?.egrul?.name || null, seller_inn: raw.seller_inn, seller_inn_on_site: raw.seller_inn_on_site,
      seller_region: sellerRegion, delivery_days: delivery.delivery_days, delivery_cost: delivery.delivery_cost,
      delivery_note: delivery.note, delivery_estimated: delivery.estimated,
      delivery_carrier: delivery.carrier, delivery_basis: delivery.basis,
      unit_weight_kg: cargo?.weight_kg ?? null, unit_volume_m3: cargo?.volume_m3 ?? null, cargo_estimated: cargo ? cargo.estimated : null,
      stock_qty: raw.stock_qty ?? null, stock_note: raw.stock_note ?? null,
      stock_checked_at: raw.source === 'contracts' || !raw.url ? null : clock().toISOString(),
      total_cost: goodsCost != null ? r2(goodsCost + delivery.delivery_cost) : null, in_time: delivery.in_time,
      match: match.match, match_notes: match.notes, match_checks: match.checks || null, trust, trust_reasons: reasons, verified, extracted_by: raw.extracted_by,
    };
  }

  // ---------- контакты поставщика ----------
  const CONTACTS_CACHE_DAYS = 30;
  const emptyContacts = () => ({ phones: [], emails: [], site: null, contacts_url: null });

  /** Контакты с сайта продавца: страница «Контакты» (или главная → ссылка на неё). Кеш по домену на 30 дней. */
  async function domainContacts(domain, contactsUrl) {
    if (!domain) return emptyContacts();
    // маркетплейсы, доски объявлений и т. п. (OFFER_DOMAIN_BLOCKLIST): сайт закрыт для программ, а продавец — не сам сайт
    if (blocklist.some((b) => domain.replace(/^www\./, '') === b || domain.endsWith(`.${b}`))) return emptyContacts();
    const key = `contacts:${domain}`;
    try {
      const cached = JSON.parse(repo.getSetting(key) || 'null');
      if (cached && clock().getTime() - new Date(cached.at).getTime() < CONTACTS_CACHE_DAYS * 86400000) return cached;
    } catch { /* битый кеш — перечитаем */ }
    let found = emptyContacts();
    try {
      let url = contactsUrl;
      if (!url) {
        const home = await fetcher.fetchPage(`https://${domain}/`);
        found = mergeContacts(extractContacts(home.html, home.url));
        url = found.contacts_url;
      }
      if (url && !found.phones.length) {
        const page = await fetcher.fetchPage(url);
        found = mergeContacts(found, extractContacts(page.html, page.url), { contacts_url: url });
      }
    } catch (err) {
      if (!(err instanceof FetchSkipped)) log.warn?.(`[contacts] ${domain}: ${err.message}`);
    }
    const out = { ...found, site: `https://${domain}`, at: clock().toISOString() };
    repo.setSetting(key, JSON.stringify(out));
    return out;
  }

  /** Контакты для предложения: магазин — с его сайта, поставщик по госконтракту — из реестра (копятся по ИНН). */
  async function contactsFor(raw, match) {
    if (raw.source === 'contracts') {
      const fromRegistry = mergeContacts(raw.contacts);
      const saved = validInn(raw.seller_inn) ? repo.getSeller(raw.seller_inn)?.contacts : null;
      const merged = mergeContacts(fromRegistry, saved);
      if (hasContacts(fromRegistry) && validInn(raw.seller_inn)) repo.saveSellerContacts(raw.seller_inn, raw.seller_name, merged);
      return { ...merged, checked: true };
    }
    const domain = raw.url ? domainOf(raw.url) : null;
    let c = mergeContacts(raw.contacts, { site: domain ? `https://${domain}` : null });
    // На странице товара телефона нет — заглянем на страницу «Контакты», но только ради подходящих предложений.
    if (!c.phones.length && domain && match !== 'не соответствует') c = mergeContacts(c, await domainContacts(domain, c.contacts_url));
    return { ...c, checked: true };
  }

  /**
   * Дозаполняет контакты у уже сохранённых предложений закупки (найденных до появления контактов):
   * магазины — с их сайта, поставщики по госконтрактам — из карточки контракта в ЕИС. Не больше limit за раз.
   */
  async function ensureContacts(tenderId, { limit = 8 } = {}) {
    const selected = new Set(repo.getItems(tenderId).map((i) => i.purchase_offer_id).filter(Boolean));
    const rank = (o) => (selected.has(o.id) ? 0 : o.match === 'соответствует' ? 1 : o.match === 'не соответствует' ? 3 : 2);
    const todo = repo.getOffers(tenderId).filter((o) => !o.contacts?.checked && o.source !== 'manual')
      .sort((a, b) => rank(a) - rank(b) || (a.unit_price ?? Infinity) - (b.unit_price ?? Infinity)).slice(0, limit);
    let updated = 0;
    for (const o of todo) {
      let c = mergeContacts(o.contacts);
      try {
        if (o.source === 'contracts') {
          c = mergeContacts(c, validInn(o.seller_inn) ? repo.getSeller(o.seller_inn)?.contacts : null);
          const regNum = /reestrNumber=(\d+)/.exec(o.url || '')?.[1];
          if (!hasContacts(c) && regNum && source?.getContract) {
            const contract = await source.getContract(regNum);
            const sup = [].concat(...[].concat(contract?.docs || []).map((d) => d?.source?.suppliersInfo?.supplierInfo || []))[0];
            c = mergeContacts(c, contactsFromContractSupplier(sup));
            if (hasContacts(c) && validInn(o.seller_inn)) repo.saveSellerContacts(o.seller_inn, o.seller_name, c);
          }
        } else if (o.domain) {
          c = mergeContacts(c, { site: `https://${o.domain}` });
          if (!c.phones.length) c = mergeContacts(c, await domainContacts(o.domain, c.contacts_url));
        }
      } catch (err) {
        log.warn?.(`[contacts] предложение ${o.id}: ${err.message}`);
      }
      repo.setOfferContacts(o.id, { ...c, checked: true });
      if (hasContacts(c)) updated++;
    }
    return { checked: todo.length, updated };
  }

  /**
   * Тот же товар на сайте поставщика по госконтракту: поиск «site:домен модель» (1 платный запрос), первая страница
   * этого сайта с ценой — прямая ссылка на товар. Без своего сайта (почта на Яндексе/Mail.ru) искать негде.
   * @returns {Promise<{found: boolean, reason?: string, url?, price?, title?}>}
   */
  async function findOnSupplierSite(offerId) {
    const offer = repo.getOffer(offerId);
    if (!offer) throw Object.assign(new Error('Предложение не найдено'), { status: 404 });
    const item = repo.getItems(offer.tender_id).find((i) => i.id === offer.item_id);
    const domain = ownDomainOf(offer.contacts);
    const done = (r) => { if (!r.found) repo.setOfferProduct(offer.id, {}); return r; };
    if (!domain) return done({ found: false, reason: 'у поставщика нет своего сайта — ни в контактах, ни в адресе почты' });
    // Что искать: модель из строки контракта или ТЗ, иначе — товар с производителем из контракта, иначе наименование позиции.
    const title = String(offer.title || '').replace(/ — по(ставлял по)? госконтракту$/i, '');
    const model = modelTokens(title)[0] || item?.spec?.identity?.model || modelTokens(item?.name || '')[0] || null;
    /** Открывает страницы по очереди; первая с ценой (и нужной моделью) — страница товара. */
    const tryPages = async (urls, via) => {
      for (const url of urls.slice(0, 3)) {
        try {
          const page = await fetcher.fetchPage(url);
          const got = await extractOffer(page, item || { name: title, characteristics: [] }, { llm: llmFactory(), system: loadPrompt('offer') });
          if (!got?.price) continue;
          if (model && !String(`${got.title} ${page.text.slice(0, 3000)}`).toLowerCase().includes(model.toLowerCase())) continue; // другая модель
          repo.setOfferProduct(offer.id, { url: got.url || url, price: got.price, title: got.title, image_url: got.image_url, specs: got.specs });
          return { found: true, url: got.url || url, price: got.price, title: got.title, via };
        } catch { /* страница закрыта или без цены — следующая */ }
      }
      return null;
    };

    // Шаг 1, бесплатный: карта сайта поставщика — страница, в адресе которой есть модель товара.
    if (model) {
      // Результат по сайту и модели помним сутки: не скачивать карту сайта при каждом открытии карточки.
      const key = `sitemap:${domain}:${model.toLowerCase()}`;
      let cached = null;
      try { cached = JSON.parse(repo.getSetting(key) || 'null'); } catch { cached = null; }
      const fresh = cached && clock().getTime() - new Date(cached.at).getTime() < 86400000;
      const fromSitemap = fresh ? cached.urls : await findInSitemap(domain, model, { fetchImpl, log }).catch(() => []);
      if (!fresh) repo.setSetting(key, JSON.stringify({ at: clock().toISOString(), urls: fromSitemap }));
      const hit = await tryPages(fromSitemap, 'карта сайта');
      if (hit) return hit;
    }

    // Шаг 2, платный: поиск «site:домен товар» через поисковик (1 запрос).
    if (!yandex) return done({ found: false, reason: 'по карте сайта товар не нашёлся, а поиск в интернете выключен: нет ключа Яндекса' });
    if (dailyLeft() <= 0) {
      // Не помечаем как проверенное: завтра, когда лимит обновится, попробуем ещё раз.
      return { found: false, reason: `по карте сайта товар не нашёлся, а суточный лимит запросов к поисковику исчерпан (${config.SEARCH_DAILY_MAX_API_REQUESTS}) — повторю после полуночи` };
    }
    const what = model ? `${searchName(item?.name || title).split(' ').slice(0, 3).join(' ')} ${model}` : (productQueryOfLine(title) || searchName(item?.name || title));
    repo.addApiUsage('yandex', today());
    let results;
    try {
      results = await yandex.search(`site:${domain} ${what}`);
    } catch (err) {
      return { found: false, reason: `поиск не удался: ${err.message}` };
    }
    const own = results.filter((r) => domainOf(r.url)?.endsWith(domain) && !/^https?:\/\/[^/]+\/?$/.test(r.url));
    const hit = await tryPages(own.map((r) => r.url), 'поиск по сайту');
    if (hit) return hit;
    return done({ found: false, reason: own.length ? 'на сайте поставщика нашлись страницы, но без цены этого товара' : `на сайте ${domain} этот товар не нашёлся` });
  }

  /**
   * Сам находит товар на сайтах лучших поставщиков по госконтрактам закупки: выбранного и самых дешёвых подходящих
   * (у кого есть свой сайт). Один раз на предложение, не больше limit платных запросов за вызов.
   */
  async function findProductsForTender(tenderId, { limit = 3 } = {}) {
    // Только у тех, кто может оказаться настоящим продавцом (производитель, профильная торговля, компания без данных
    // ЕГРЮЛ, но со своим сайтом): у явного посредника каталога с ценами нет, платный запрос уйдёт впустую.
    const items = new Map(repo.getItems(tenderId).map((i) => [i.id, i]));
    const todo = repo.getOffers(tenderId)
      .filter((o) => o.source === 'contracts' && !o.product_checked_at && o.match !== 'не соответствует' && ownDomainOf(o.contacts))
      .map((o) => withKind(o, items.get(o.item_id)))
      .filter((o) => o.seller_kind.kind !== 'reseller')
      .sort((a, b) => byKind(a, b) || Number(b.match === 'соответствует') - Number(a.match === 'соответствует')
        || (a.unit_price ?? Infinity) - (b.unit_price ?? Infinity))
      .slice(0, limit);
    let found = 0;
    for (const o of todo) if ((await findOnSupplierSite(o.id)).found) found++;
    return { checked: todo.length, found };
  }

  /** ЕГРЮЛ с кешем в таблице sellers. */
  async function checkSeller(inn, name, ctx) {
    if (!validInn(inn)) return null;
    const cached = repo.getSeller(inn);
    const fresh = cached?.checked_at && Date.now() - new Date(cached.checked_at).getTime() < config.SELLER_CHECK_CACHE_DAYS * 86400000;
    if (fresh || !config.DADATA_API_KEY) return cached;
    try {
      const egrul = await lookupEgrul(inn, { apiKey: config.DADATA_API_KEY, fetchImpl });
      repo.saveSellerEgrul(inn, egrul?.name || name, egrul);
      return repo.getSeller(inn);
    } catch (err) {
      ctx?.log?.('warn', `ЕГРЮЛ для ИНН ${inn}: ${err.message}`);
      return cached;
    }
  }

  // ---------- источники ----------
  function fromPastContracts(item, bench) {
    // Этап 6b: строки контрактов с настоящим наименованием товара и вердиктом «тот же товар / другой».
    if (bench?.lines?.length) {
      const spec = specOf(item);
      const seen = new Set();
      const out = [];
      for (const l of bench.lines.slice().sort((a, b) => a.unit_price - b.unit_price)) {
        const key = `${l.supplier_inn || l.supplier_name}|${l.name}`;
        if (seen.has(key) || out.length >= 15) continue;
        seen.add(key);
        const v = lineVerdict(item, spec, l);
        const price = item.unit && l.unit ? convertPrice(l.unit_price, l.unit, item.unit, { packQty: spec.pack_qty, name: item.name }) : l.unit_price;
        out.push({
          source: 'contracts', title: l.name || `${item.name} — по госконтракту`, contract_verdict: v,
          url: l.reg_num ? `https://zakupki.gov.ru/epz/contract/contractCard/common-info.html?reestrNumber=${l.reg_num}` : null,
          price, unit: item.unit, pack_qty: 1, availability: null, unconverted: price == null,
          seller_name: l.supplier_name, seller_inn: l.supplier_inn, seller_inn_on_site: false,
          contacts: { phones: [l.supplier_phone], emails: [l.supplier_email] },
          price_date: l.date || null, // дата контракта: цена прошлой поставки, а не сегодняшняя
          specs: specsFromChars(l.chars), // что именно поставляли: характеристики товара из контракта
          seller_region: regionFromText(l.supplier_address) ?? regionFromInn(l.supplier_inn),
          delivery_days: null, delivery_cost: null, extracted_by: 'реестр контрактов ЕИС',
        });
      }
      return out;
    }
    return (bench?.suppliers || []).map((s) => ({
      source: 'contracts',
      title: `${item.name} — поставлял по госконтракту`,
      url: s.reg_num ? `https://zakupki.gov.ru/epz/contract/contractCard/common-info.html?reestrNumber=${s.reg_num}` : null,
      price: s.unit_price, unit: item.unit, pack_qty: 1, availability: null,
      seller_name: s.name, seller_inn: s.inn, seller_inn_on_site: false,
      contacts: { phones: [s.phone], emails: [s.email] },
      price_date: s.date || null,
      seller_region: regionFromText(s.address) ?? regionFromInn(s.inn),
      delivery_days: null, delivery_cost: null, extracted_by: 'реестр контрактов ЕИС',
    }));
  }

  // variant — номер попытки агента поиска поставщиков: у мебели каждая попытка — другие формулировки и магазины
  async function run(searchId, tenderId, { auto = false, variant = 0 } = {}) {
    const logEntries = [];
    const state = { apiRequests: 0, pages: 0, maxPages: config.SEARCH_MAX_PAGES, maxApi: config.SEARCH_MAX_API_REQUESTS };
    const logFn = (level, text) => { logEntries.push({ at: clock().toISOString(), level, text }); repo.updateOfferSearch(searchId, { log: logEntries }); };
    const progress = (stage, current, total) => repo.updateOfferSearch(searchId, { status: 'running', progress: { stage, current, total }, apiRequests: state.apiRequests, pagesFetched: state.pages });

    let tender = repo.getTender(tenderId);
    // Сначала ТЗ. Поиск по кнопке: если документация закупки ещё не прочитана — читаем её и берём требования оттуда,
    // а не только из извещения. Автопоиск документацию читает сам, по своим лимитам (воронка).
    if (readTz && !auto) {
      try {
        progress('docs', 0, 1);
        // Документация читается минуты; если площадка не отдаёт файлы — не ждём бесконечно, ищем по извещению.
        const limitMs = config.SEARCH_TZ_WAIT_MS ?? 8 * 60000;
        let timer;
        const waited = await Promise.race([
          readTz(tender, (text) => logFn('info', text)),
          new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), limitMs); timer.unref?.(); }),
        ]);
        clearTimeout(timer);
        if (waited === 'timeout') logFn('warn', `Документация читается дольше ${Math.round(limitMs / 60000)} минут — ищу по требованиям из извещения; когда ТЗ дочитается, запустите поиск ещё раз`);
        tender = repo.getTender(tenderId);
      } catch (err) {
        logFn('warn', `Документацию прочитать не удалось (${err.message}) — ищу по требованиям из извещения`);
      }
    }
    let items = await details.ensureItems(tender);
    // Этап 6b: строки прошлых контрактов, которые правила не распознали, сверяет облегчённая модель.
    if (details.resolveContractMatches) {
      await details.resolveContractMatches(tender).catch((err) => log.warn?.(`[same_product] ${err.message}`));
      items = repo.getItems(tender.id);
    }
    // Расчёта нет или он сброшен обновлением позиций (result пуст) — считаем заново: из него берётся срок поставки.
    const savedEcon = repo.getEconomics(tender.id);
    const econ = savedEcon?.result ? savedEcon : (await details.computeEconomics(tender.id, { fetch: false })).economics;
    const settings = repo.getProfile().economics;
    const benchmarks = {};
    for (const i of items) {
      const code = i.ktru_code || i.okpd2_code;
      if (code) benchmarks[i.id] = repo.getBenchmark(code);
    }
    const ctx = {
      searchId, settings, log: logFn,
      llm: llmFactory(), matchPrompt: loadPrompt('match'), offerPrompt: loadPrompt('offer'), modelsPrompt: loadPrompt('models'),
      deliveryTermDays: econ?.result?.inputs?.delivery_days ?? settings.default_delivery_days,
      medianByItem: Object.fromEntries(items.map((i) => [i.id, benchmarks[i.id]?.unit_price?.median ?? null])),
      city: REGIONS[tender.region]?.[0] || null, // город заказчика — для запросов «купить в …»
    };
    logFn('info', `Позиций: ${items.length}. Срок поставки для проверки доставки: ${ctx.deliveryTermDays} дн. Источники: ${[...sources].join(', ')}`);
    if (sources.has('yandex') && !yandex) logFn('warn', 'Поиск в интернете (Яндекс Search API) выключен: не заданы YANDEX_SEARCH_API_KEY и YANDEX_FOLDER_ID — см. README');
    if (!config.DADATA_API_KEY) logFn('warn', 'Проверка продавцов по ЕГРЮЛ выключена: не задан DADATA_API_KEY — доверие считается по данным со страницы');

    repo.clearSearchOffers(tender.id);
    const storeFailures = new Map();
    const funnels = [];

    const fetchAndExtract = async (url, item, source, opts = {}) => {
      if (state.pages >= state.maxPages) throw new BudgetExceeded(`достигнут лимит страниц на поиск (${state.maxPages}, SEARCH_MAX_PAGES)`);
      state.pages++;
      const page = await fetcher.fetchPage(url);
      const offer = await extractOffer(page, item, { llm: ctx.llm, system: ctx.offerPrompt, listing: true, stockAttr: stockAttrOf(url), ...opts });
      // Контакты продавца — со страницы товара: телефон, почта, ссылка на страницу «Контакты».
      return offer ? { ...offer, source, contacts: extractContacts(page.html, page.url) } : null;
    };

    let stoppedByBudget = null;
    let dailyExhausted = false;
    // Платные запросы делим поровну между позициями, по которым есть что искать: иначе первые три позиции съедают весь
    // лимит поиска (SEARCH_MAX_API_REQUESTS), а остальные остаются без магазинов. Самый точный запрос — первым.
    const searchableCount = Math.max(1, items.filter(isSearchable).length);
    // Лимит страниц растёт с числом позиций: у закупки на 10 картриджей 90 страниц кончались на пятой позиции,
    // а остальным не доставалось ничего. Не меньше SEARCH_MIN_PAGES_PER_ITEM страниц на позицию.
    state.maxPages = Math.max(config.SEARCH_MAX_PAGES, searchableCount * (config.SEARCH_MIN_PAGES_PER_ITEM ?? 24));
    // Бюджет поиска растёт с числом позиций (SEARCH_API_PER_ITEM на позицию), но не выше SEARCH_MAX_API_REQUESTS_CAP
    state.maxApi = Math.max(config.SEARCH_MAX_API_REQUESTS, Math.min(config.SEARCH_MAX_API_REQUESTS_CAP ?? config.SEARCH_MAX_API_REQUESTS, searchableCount * (config.SEARCH_API_PER_ITEM ?? 0)));
    const perItemLimit = Math.max(1, Math.floor(state.maxApi / searchableCount));
    for (let n = 0; n < items.length; n++) {
      const item = items[n];
      let itemRequests = 0;
      progress('item', n + 1, items.length);
      const raws = [];
      let noPrice = 0;
      const funnel = createFunnel(item);
      funnels.push(funnel.data);

      if (sources.has('contracts')) {
        const fromContracts = fromPastContracts(item, benchmarks[item.id]);
        raws.push(...fromContracts);
        if (fromContracts.length) logFn('info', `«${item.name.slice(0, 60)}»: ${fromContracts.length} поставщиков из прошлых госконтрактов`);
      }

      const urls = [];
      const seen = new Set();
      const perDomain = new Map();
      let domainCapped = 0;
      const capped = new Set();
      const closedSkipped = new Set();
      const retailSkipped = new Set();
      // Страницы открываем «по кругу»: сначала первые результаты каждого запроса, потом вторые и так далее.
      // Иначе все места (SEARCH_MAX_PAGES_PER_ITEM) занимает первый запрос, а остальные оплачены впустую.
      let queryNo = 0;
      const addUrl = (url, source, order = urls.length * 100) => {
        const d = domainOf(url);
        if (!d || seen.has(url)) return;
        const why = urlDropReason(url);
        if (why) {
          funnel.drop(why, d);
          if (why === 'retail') retailSkipped.add(d.split('.').slice(-2).join('.'));
          if (why === 'closed') closedSkipped.add(d);
          return;
        }
        // Не больше N страниц с одного сайта — место для других продавцов, а не десять ссылок одного магазина.
        // Городские зеркала магазина (kaluga.nix.ru, ryazan.nix.ru) — тот же магазин с теми же товарами: считаем вместе.
        const site = d.split('.').slice(-2).join('.');
        if ((perDomain.get(site) || 0) >= config.SEARCH_MAX_PAGES_PER_DOMAIN) {
          // один и тот же адрес приходит в ответах на разные запросы — в счёт идёт один раз
          if (!capped.has(url)) { capped.add(url); domainCapped++; funnel.drop('domain_cap', d); }
          return;
        }
        perDomain.set(site, (perDomain.get(site) || 0) + 1);
        seen.add(url);
        urls.push({ url, source, order });
        funnel.take();
      };

      const asked = new Set(); // тексты уже отправленных запросов — одинаковый дважды не оплачиваем
      // q — текст запроса или {photo, label} для поиска по картинке.
      const searchApi = async (q, source) => {
        if (state.apiRequests >= state.maxApi) { stoppedByBudget = `достигнут лимит запросов к поисковому API на эту закупку (${state.maxApi}: SEARCH_MAX_API_REQUESTS / SEARCH_API_PER_ITEM)`; return false; }
        if (dailyLeft() <= 0) { dailyExhausted = true; return false; }
        if (itemRequests >= perItemLimit) return false; // доля этой позиции израсходована — остальное другим позициям
        itemRequests++;
        state.apiRequests++;
        repo.addApiUsage('yandex', today());
        const label = typeof q === 'string' ? `«${q}»` : `по фото из ТЗ (${q.label})`;
        if (typeof q === 'string') asked.add(q.toLowerCase());
        try {
          const results = typeof q === 'string' ? await yandex.search(q) : await yandex.searchByImage(q.photo);
          const qn = queryNo++;
          const had = urls.length;
          results.forEach((r, i) => addUrl(r.url, source, i * 100 + qn));
          funnel.query(typeof q === 'string' ? q : `по фото из ТЗ (${q.label})`, source, results.length, urls.length - had);
          logFn('info', `Поиск ${label}: ${results.length} результатов`);
        } catch (err) {
          logFn('warn', `Поиск ${label}: ${err.message}`);
        }
        return true;
      };

      // Нет ни модели, ни характеристик — искать в интернете нечего: найденное нельзя сверить с ТЗ, платные запросы уйдут впустую.
      const searchable = isSearchable(item);
      let hasModel = Boolean(specOf(item).identity?.model);
      let candidates = []; // конкретные товары, подобранные под ТЗ без модели
      // Картридж «для МФУ Pantum M6800FDW»: в ТЗ модель аппарата, а не картриджа — ищем модели картриджей к нему из своей
      // базы (по их совместимости), а не «M6800FDW купить» (так находились чужие картриджи и проходили как «частично»).
      const forDevice = productBase && searchable && baseKind(item)?.niche === 'cartridges'
        ? cartridgesForDevice(repo.db, item.name, specOf(item).required).map((c) => ({ name: c.title, model: c.model, query: `Картридж ${c.model} купить`, base: true, device: c.device }))
        : [];
      if (forDevice.length) {
        hasModel = false;
        candidates = forDevice;
        logFn('info', `«${item.name.slice(0, 60)}»: в ТЗ модель аппарата (${forDevice[0].device}) — картриджи к нему из своей базы: ${forDevice.map((c) => c.model).join(', ')}`);
      }
      // Ноутбук, ПК, моноблок, монитор без модели в ТЗ: ТЗ обычно написано под реестр — сначала модели российских
      // производителей, сверенные с ТЗ. Подошедшие идут первыми кандидатами: их ищем в каталоге поставщиков (бесплатно)
      // и поиском — в пределах того же лимита запросов на позицию.
      if (!hasModel && searchable && productBase && baseKind(item)) {
        const view = await baseFill(tenderId, item, { log: logFn }).catch((err) => { logFn('warn', `«${item.name.slice(0, 60)}»: подбор из своей базы товаров не удался: ${err.message}`); return null; });
        candidates = [...candidates, ...baseCandidates(view)];
      }
      // Товары, которые по этой позиции уже поставляли по госконтрактам (с производителем или моделью), ищем в магазинах:
      // так появляется конкретный товар — со ссылкой, ценой, фото и характеристиками.
      const productQueries = [...new Set(raws.filter((r) => r.source === 'contracts' && r.contract_verdict?.verdict !== 'different')
        .map((r) => productQueryOfLine(r.title)).filter(Boolean))].slice(0, config.SEARCH_CONTRACT_PRODUCT_QUERIES ?? 2);
      if (yandex && !searchable) {
        logFn('info', `«${item.name.slice(0, 60)}»: в ТЗ и извещении нет модели и характеристик — ${productQueries.length
          ? 'ищу в магазинах только товары, которые уже поставляли по госконтрактам'
          : 'в интернете не ищу (сначала прочитайте документацию или введите цену вручную)'}`);
      }
      // Сначала бесплатное: свой каталог поставщиков — по модели, а без модели по словам названия («shpat», «bahil» в
      // адресе). Нашлось не меньше SEARCH_FREE_ENOUGH страниц — платный поиск по позиции не запускаем (0 — искать всегда).
      let freeFirst = 0;
      if (indexReady() && searchable && config.SEARCH_FREE_BY_WORDS !== false) {
        const before = urls.length;
        const models = hasModel ? [specOf(item).identity?.model, ...modelTokens(item.name)].filter(Boolean) : [];
        const opts = { perDomain: 1, limit: config.SEARCH_WHOLESALE_PAGES ?? 8, skip: (url, d) => seen.has(url) || isClosed(d) };
        const pages = models.length ? siteIndex.find(models, opts)
          : siteIndex.findByWords([...kindWords(item.name), ...distinctiveTerms(specOf(item), 3).filter((t) => !/\d/.test(t))], opts);
        pages.forEach((f, i) => addUrl(f.url, 'wholesale', -2000 + i));
        freeFirst = urls.length - before;
        if (freeFirst) { funnel.catalog(freeFirst); logFn('info', `«${item.name.slice(0, 60)}»: в своём каталоге поставщиков (бесплатно) найдено страниц: ${freeFirst}`); }
      }
      const freeEnoughAt = config.SEARCH_FREE_ENOUGH ?? 4;
      const freeEnough = freeEnoughAt > 0 && freeFirst >= freeEnoughAt;
      if (freeEnough) logFn('info', `«${item.name.slice(0, 60)}»: бесплатных страниц достаточно — платный поиск по позиции не запускаю`);
      if (yandex && searchable && !stoppedByBudget && !dailyExhausted && !freeEnough) {
        // Как делают люди: фото товара из ТЗ → поиск по картинке → страницы магазинов с этим товаром.
        if (sources.has('photo') && photos && perItemLimit >= 2) {
          const photo = photos.photoForItem(tender, item);
          if (photo) {
            try {
              await searchApi({ photo: fs.readFileSync(photos.photoPath(tender.id, photo)), label: photo.source_file?.split('/').pop() || photo.file }, 'photo');
            } catch (err) {
              logFn('warn', `Фото из ТЗ не прочитано: ${err.message}`);
            }
          }
        }
        if (sources.has('yandex') && hasModel) {
          // Точная модель известна — магазины находятся первым же запросом: двух хватает, остальной лимит — другим позициям.
          for (const q of queriesFor(item, Math.min(2, config.SEARCH_MAX_QUERIES_PER_ITEM), { city: ctx.city, spec: specOf(item), title: tender.title, variant })) {
            if (!(await searchApi(q, 'yandex'))) break;
          }
        }
        if (sources.has('yandex') && !hasModel) {
          // Модели в ТЗ нет — товар описан характеристиками. По общему названию поисковик отдаёт каталоги, поэтому:
          // 1) один-два запроса по названию с отличительными признаками (с каталогов потом берём похожие товары);
          // 2) подбираем конкретные товары под требования и ищем уже их — по названию с производителем и моделью.
          const spec = specOf(item);
          for (const q of specQueries(item, spec, perItemLimit >= 3 ? 2 : 1, { title: tender.title, variant })) {
            if (!(await searchApi(q, 'yandex'))) break;
          }
          if (perItemLimit >= 2 && (config.SEARCH_MODEL_CANDIDATES ?? 4) > 0) {
            try {
              candidates = [...candidates, ...await suggestProducts({
                // Моделей просим с запасом: в своём каталоге поставщиков их проверка ничего не стоит.
                item, spec, llm: ctx.llm, system: ctx.modelsPrompt, repo, clock, max: indexReady() ? Math.max(8, config.SEARCH_MODEL_CANDIDATES ?? 4) : config.SEARCH_MODEL_CANDIDATES ?? 4,
                delivered: raws.filter((r) => r.source === 'contracts' && r.contract_verdict?.verdict !== 'different').map((r) => r.title),
              })];
            } catch (err) {
              logFn('warn', `«${item.name.slice(0, 60)}»: не удалось подобрать модели под ТЗ: ${err.message}`);
            }
            if (candidates.length) logFn('info', `«${item.name.slice(0, 60)}»: под требования ТЗ подобраны товары для поиска: ${candidates.map((c) => c.name).join('; ')}`);
            // Платные запросы — только по первым моделям; остальные ищутся в каталоге поставщиков.
            for (const c of candidates.slice(0, config.SEARCH_MODEL_CANDIDATES ?? 4)) {
              if (!(await searchApi(c.query, 'yandex'))) break;
            }
          }
          // Профильные магазины — с отличительными признаками в запросе (по одному названию там тоже каталог).
          if (sources.has('b2b') && perItemLimit >= 6) {
            const terms = distinctiveTerms(spec, 2);
            for (const site of b2bSitesFor(item, b2bSites().filter((x) => !isClosed(x.site)), Math.min(2, config.SEARCH_B2B_SITES_PER_ITEM ?? 2))) {
              if (stoppedByBudget || dailyExhausted || !(await searchApi(siteQuery(item, site.site, terms), 'b2b'))) break;
            }
          }
        }
      }
      // «Простой» запрос — как ищет человек: наименование и модель или главные характеристики, без добавок. Идёт последним:
      // если лимит запросов на позицию уже израсходован точными запросами, он просто не отправится.
      if (yandex && searchable && sources.has('yandex') && config.SEARCH_PLAIN_QUERY !== false && !stoppedByBudget && !dailyExhausted && !freeEnough) {
        const q = plainQuery(item, specOf(item), { title: tender.title });
        if (q && !asked.has(q.toLowerCase())) await searchApi(q, 'yandex');
      }
      if (closedSkipped.size) logFn('info', `«${item.name.slice(0, 60)}»: пропущены сайты, закрытые для роботов: ${[...closedSkipped].join(', ')}`);
      if (retailSkipped.size) logFn('info', `«${item.name.slice(0, 60)}»: крупные розничные сети не открываю (нужны поставщики, а не розница): ${[...retailSkipped].join(', ')}`);

      // Собственный каталог оптовых поставщиков: модель из ТЗ (или подобранные под ТЗ модели) ищем сразу у всех — бесплатно.
      let wholesaleAdded = 0;
      if (indexReady() && searchable) {
        const models = hasModel ? [specOf(item).identity?.model, ...modelTokens(item.name)] : candidates.map((c) => c.model || c.name);
        const before = urls.length;
        // Как товар называется в адресах страниц: по названию позиции и по типу подобранных товаров («жёсткий диск» при «накопителе» в ТЗ).
        const hints = urlHints([...kindWords(item.name), ...candidates.flatMap((c) => kindWords(typeOfCandidate(c)))]);
        const found = siteIndex.find(models.filter(Boolean), { perDomain: 1, limit: config.SEARCH_WHOLESALE_PAGES ?? 8, hints, skip: (url, d) => seen.has(url) || isClosed(d) });
        found.forEach((f, i) => addUrl(f.url, 'wholesale', -1000 + i));
        wholesaleAdded = urls.length - before;
        funnel.catalog(wholesaleAdded);
        // В журнале — только те поставщики, чьи страницы действительно взяты в работу (часть отсекает лимит страниц с одного сайта).
        if (wholesaleAdded) logFn('info', `«${item.name.slice(0, 60)}»: в каталоге оптовых поставщиков найдено страниц: ${wholesaleAdded} (${[...new Set(urls.slice(before).map((u) => domainOf(u.url)))].join(', ')})`);
        else if (models.filter(Boolean).length) logFn('info', `«${item.name.slice(0, 60)}»: в каталоге оптовых поставщиков таких моделей нет`);
      }
      // Товары, которые по этой позиции продавали по госконтрактам (с производителем), — если нейросеть кандидатов не дала.
      if (yandex && sources.has('yandex') && productQueries.length && !hasModel && !candidates.length && !stoppedByBudget && !dailyExhausted && !freeEnough) {
        for (const q of productQueries) {
          if (!(await searchApi(`${q} купить`, 'yandex'))) break;
        }
      }
      if (domainCapped) logFn('info', `«${item.name.slice(0, 60)}»: пропущено ${domainCapped} лишних ссылок с уже взятых сайтов (не больше ${config.SEARCH_MAX_PAGES_PER_DOMAIN} с одного)`);

      if (sources.has('stores')) {
        for (const store of storesConfig()) {
          if (storeFailures.has(store.name)) continue;
          const url = store.searchUrl.replace('{q}', encodeURIComponent(item.name.slice(0, 80)));
          try {
            if (state.pages >= state.maxPages) break;
            state.pages++;
            const page = await fetcher.fetchPage(url);
            if (page.structured.length) {
              page.structured.slice(0, 5).forEach((s) => addUrl(s.url, 'store'));
            } else if (store.productLinkPattern) {
              const links = [...new Set([...page.html.matchAll(new RegExp(store.productLinkPattern, 'g'))].map((m) => m[0]))].slice(0, 3);
              links.forEach((l) => addUrl(l, 'store'));
              if (!links.length) throw new FetchSkipped('на странице поиска нет товаров (сайт подгружает их скриптом)');
            }
          } catch (err) {
            if (!(err instanceof FetchSkipped)) throw err;
            storeFailures.set(store.name, err.message);
            logFn('skip', `${store.name}: ${err.message}`);
          }
        }
      }

      // Страниц на позицию — поровну из общего лимита страниц на поиск, но не меньше трёх.
      const pagesPerItem = Math.min(config.SEARCH_MAX_PAGES_PER_ITEM, Math.max(3, Math.floor(state.maxPages / searchableCount)));
      // Очередь страниц растёт на ходу: со страницы каталога берём несколько товаров, похожих на позицию ТЗ,
      // и открываем уже их страницы — раньше каталог просто пропускался, и запрос был оплачен впустую.
      // Страницы оптовых поставщиков из своего каталога идут первыми и сверх обычной нормы: они ничего не стоят.
      const sorted = urls.slice().sort((a, b) => a.order - b.order);
      const queue = sorted.slice(0, pagesPerItem + wholesaleAdded + freeFirst);
      for (const u of sorted.slice(queue.length)) funnel.drop('page_limit', domainOf(u.url));
      const listingPicks = config.SEARCH_LISTING_PICKS ?? 3;
      const listingMax = config.SEARCH_LISTING_MAX ?? 6;
      let fromListings = 0;
      // Один и тот же товар в каталогах городских зеркал магазина открываем один раз.
      const pickedTitles = new Set();
      const titleKey = (p) => String(p.title || '').toLowerCase().replace(/[^a-zа-яё0-9]+/g, '');
      const itemSpec = specOf(item);
      for (let qi = 0; qi < queue.length; qi++) {
        const { url, source } = queue[qi];
        try {
          funnel.open();
          const offer = await fetchAndExtract(url, item, source, { candidates, hasModel });
          if (offer && offer.price != null) { raws.push(offer); funnel.price(); } else { noPrice++; funnel.page('no_price', domainOf(url)); }
        } catch (err) {
          if (err instanceof BudgetExceeded) { stoppedByBudget = err.message; break; }
          if (err instanceof FetchSkipped) {
            if (err.closed) markClosed(domainOf(url));
            // В ТЗ названа модель — с каталога нужна только она сама (err.exact); иначе — несколько похожих товаров.
            const room = Math.min(listingPicks, listingMax - fromListings);
            const picks = (!err.listing || room <= 0 ? []
              : hasModel ? (err.exact ? err.listing.slice(0, room) : [])
                : pickFromListing(err.listing.filter((p) => !pickedTitles.has(titleKey(p))), { item, spec: itemSpec, candidates, max: room })).filter((p) => !seen.has(p.url));
            if (picks.length) {
              for (const p of picks) { seen.add(p.url); pickedTitles.add(titleKey(p)); queue.push({ url: p.url, source: 'listing' }); }
              fromListings += picks.length;
              funnel.listing(picks.length);
              logFn('info', `${domainOf(url)}: это страница каталога — открываю с неё ${hasModel ? 'товар с нужной моделью' : 'похожие товары'}: ${picks.map((p) => String(p.title).slice(0, 50)).join('; ')}`);
            } else {
              funnel.page(pageReason(err), domainOf(url));
              logFn('skip', `${domainOf(url)}: ${err.message}`);
            }
          }
          else { funnel.page('error', domainOf(url)); logFn('warn', `${domainOf(url)}: ${err.message}`); }
        }
      }
      if (noPrice) logFn('info', `«${item.name.slice(0, 60)}»: на ${noPrice} страницах цена не найдена`);

      const enriched = [];
      for (const raw of raws) enriched.push(await enrich(raw, { item, tender, ctx }));

      // Второй заход. Модели в ТЗ нет, подобранные товары проверены — и ни один не подошёл. Сообщаем нейросети, что
      // отклонено и на каких требованиях товары «споткнулись», и просим назвать другие. Ищем их в каталоге поставщиков
      // (бесплатно) и, если остался лимит, одним-двумя запросами к поисковику.
      const shopOffers = () => enriched.filter((o) => o.source !== 'contracts');

      // Добор на сайте (offers/same-site.js): полностью подошедшего товара нет — на сайтах, где товар подошёл не во всём,
      // смотрим соседние товары с тем, чего не хватило («высокой вязкости», «двойное дно»). Бесплатно: только страницы.
      const sameSiteMax = config.SEARCH_SAME_SITE_PAGES ?? 6;
      if (sameSiteMax > 0 && !stoppedByBudget && !shopOffers().some((o) => o.match === 'соответствует')) {
        const { wantedStems, sameSiteLinks } = require('./same-site');
        const near = shopOffers().filter((o) => o.url && ['частично', 'не соответствует', 'не хватает данных'].includes(o.match)
          && !/другой (?:товар|вид)/.test((o.match_notes || []).join(' ')) && (o.match_checks?.confirmed || 0) > 0)
          .sort((a, b) => (b.match_checks?.confirmed || 0) - (a.match_checks?.confirmed || 0));
        const domains = new Set();
        let opened = 0;
        for (const o of near) {
          if (opened >= sameSiteMax || domains.size >= 3) break;
          const d = domainOf(o.url);
          if (domains.has(d)) continue;
          const wants = wantedStems(o);
          if (!wants.length) continue;
          domains.add(d);
          // не больше страниц с одного сайта, чем у обычного поиска (SEARCH_MAX_PAGES_PER_DOMAIN): повторное открытие
          // страницы товара тоже считается — нужно место ещё хотя бы на одну
          const room = (config.SEARCH_MAX_PAGES_PER_DOMAIN ?? 2) - Math.max([...seen].filter((u) => domainOf(u) === d).length, enriched.filter((x) => x.url && domainOf(x.url) === d).length) - 1;
          if (room <= 0) continue;
          let page;
          try { page = await fetcher.fetchPage(o.url); } catch { continue; }
          const links = sameSiteLinks(page.html, page.url, item, wants).filter((l) => !seen.has(l.url)).slice(0, Math.max(0, Math.min(2, room)));
          if (!links.length) continue;
          logFn('info', `${d}: «${String(o.title).slice(0, 50)}» подошёл не во всём — смотрю на этом же сайте: ${links.map((l) => String(l.title).slice(0, 50)).join('; ')}`);
          for (const l of links) {
            if (opened >= sameSiteMax) break;
            seen.add(l.url);
            opened++;
            try {
              funnel.open();
              const raw = await fetchAndExtract(l.url, item, 'listing', { candidates, hasModel });
              if (raw && raw.price != null) { enriched.push(await enrich(raw, { item, tender, ctx })); funnel.price(); } else funnel.page('no_price', d);
            } catch (err) {
              if (err instanceof BudgetExceeded) { stoppedByBudget = err.message; break; }
              funnel.page(err instanceof FetchSkipped ? pageReason(err) : 'error', d);
            }
          }
        }
        if (opened) logFn('info', `«${item.name.slice(0, 60)}»: добор на сайтах — открыто ${opened}, подошло полностью: ${shopOffers().filter((o) => o.match === 'соответствует').length}`);
      }
      // сайты, где платный поиск нашёл подходящий товар, — в свой каталог (дальше бесплатно)
      const added = shopOffers().filter((o) => o.url && ['yandex', 'listing', 'b2b'].includes(o.source)
        && (o.match === 'соответствует' || (o.match === 'частично' && (o.match_checks?.confirmed || 0) >= 2)))
        .map((o) => domainOf(o.url)).filter((d, i, a) => a.indexOf(d) === i).filter(noteDiscovered);
      if (added.length) logFn('info', `В свой каталог поставщиков добавлены сайты: ${added.join(', ')} — их товары дальше находятся бесплатно`);
      const refineMax = config.SEARCH_REFINE_PAGES ?? 8;
      if (!hasModel && searchable && candidates.length && refineMax > 0 && !stoppedByBudget && !shopOffers().some((o) => o.match === 'соответствует')) {
        const flat = (s) => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
        // товары из своей базы нейросеть не предлагала — в её список отклонённых их не добавляем
        const rejected = candidates.filter((c) => !c.base).map((c) => {
          const seenAs = shopOffers().filter((o) => flat(o.title).includes(flat(c.model || c.name)));
          const bad = seenAs.find((o) => o.match === 'не соответствует') || seenAs[0];
          return { name: c.name, model: c.model, why: bad ? `${bad.match}: ${(bad.match_notes || [])[0] || ''}` : 'в продаже у поставщиков не найден' };
        });
        const fails = new Map();
        for (const o of shopOffers()) for (const r of o.match_checks?.rows || []) if (r.verdict === 'no') fails.set(r.name, { name: r.name, value: r.need, n: (fails.get(r.name)?.n || 0) + 1 });
        const critical = [...fails.values()].sort((a, b) => b.n - a.n);
        let second = [];
        try {
          second = await suggestProducts({ item, spec: specOf(item), rejected, critical, llm: ctx.llm, system: ctx.modelsPrompt, repo, clock, max: indexReady() ? 8 : config.SEARCH_MODEL_CANDIDATES ?? 4 });
        } catch (err) {
          logFn('warn', `«${item.name.slice(0, 60)}»: повторный подбор моделей не удался: ${err.message}`);
        }
        if (second.length) {
          logFn('info', `«${item.name.slice(0, 60)}»: первые подобранные товары не подошли${critical.length ? ` (чаще всего — ${critical.slice(0, 3).map((c) => c.name).join('; ')})` : ''}. Подобраны другие: ${second.map((c) => c.name).join('; ')}`);
          const more = [];
          if (indexReady()) {
            const hints = urlHints([...kindWords(item.name), ...second.flatMap((c) => kindWords(typeOfCandidate(c)))]);
            for (const f of siteIndex.find(second.map((c) => c.model || c.name), { perDomain: 1, limit: refineMax, hints, skip: (url, d) => seen.has(url) || isClosed(d) || isRetail(d) })) more.push({ url: f.url, source: 'wholesale' });
          }
          // Платные запросы — только если каталог поставщиков не дал и половины нужного и у позиции остался лимит.
          if (yandex && sources.has('yandex') && more.length < refineMax / 2) {
            for (const c of second.slice(0, 2)) {
              const before = urls.length;
              if (!(await searchApi(c.query, 'yandex'))) break;
              for (const u of urls.slice(before).slice(0, 2)) more.push({ url: u.url, source: u.source });
            }
          }
          let added = 0;
          for (const m of more.slice(0, refineMax)) {
            seen.add(m.url);
            try {
              funnel.open();
              const raw = await fetchAndExtract(m.url, item, m.source, { candidates: second, hasModel });
              if (raw && raw.price != null) { enriched.push(await enrich(raw, { item, tender, ctx })); added++; funnel.price(); } else funnel.page('no_price', domainOf(m.url));
            } catch (err) {
              if (err instanceof BudgetExceeded) { stoppedByBudget = err.message; break; }
              if (!(err instanceof BudgetExceeded)) funnel.page(err instanceof FetchSkipped ? pageReason(err) : 'error', domainOf(m.url));
              if (err instanceof FetchSkipped) { if (err.closed) markClosed(domainOf(m.url)); logFn('skip', `${domainOf(m.url)}: ${err.message}`); } else logFn('warn', `${domainOf(m.url)}: ${err.message}`);
            }
          }
          logFn('info', `«${item.name.slice(0, 60)}»: по новым моделям открыто страниц: ${more.slice(0, refineMax).length}, с ценой: ${added}, подошло: ${shopOffers().filter((o) => o.match === 'соответствует').length}`);
          candidates = [...candidates, ...second];
        }
      }

      // Товар подошёл под ТЗ — ищем ту же модель у остальных оптовых поставщиков: нужен не первый попавшийся, а самый дешёвый.
      const sweepMax = config.SEARCH_SWEEP_PAGES ?? 6;
      if (indexReady() && sweepMax > 0 && !stoppedByBudget) {
        const fit = enriched.filter((o) => o.source !== 'contracts' && o.unit_price != null && (o.match === 'соответствует' || o.match === 'частично'))
          .sort((a, b) => Number(b.match === 'соответствует') - Number(a.match === 'соответствует') || a.unit_price - b.unit_price);
        const ownName = (title) => String(title || '').split(/(?:^|[\s(,])(?:для|for|к)(?=\s)/i)[0];
        const models = [...new Set(fit.flatMap((o) => modelTokens(ownName(o.title))))].slice(0, 6);
        const flat = (s) => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
        const have = enriched.filter((o) => o.domain).map((o) => ({ site: o.domain.split('.').slice(-2).join('.'), title: flat(o.title) }));
        const more = models.length ? siteIndex.find(models, {
          perDomain: 1, limit: sweepMax, hints: urlHints([...kindWords(item.name), ...candidates.flatMap((c) => kindWords(typeOfCandidate(c)))]),
          // у этого поставщика эта модель уже найдена — второй раз не открываем
          skip: (url, d, needle) => seen.has(url) || isClosed(d) || have.some((h) => h.site === d.split('.').slice(-2).join('.') && h.title.includes(needle)),
        }) : [];
        let added = 0;
        for (const f of more) {
          seen.add(f.url);
          try {
            funnel.open();
            const raw = await fetchAndExtract(f.url, item, 'wholesale', { candidates, hasModel });
            if (raw && raw.price != null) { enriched.push(await enrich(raw, { item, tender, ctx })); added++; funnel.price(); } else funnel.page('no_price', domainOf(f.url));
          } catch (err) {
            if (err instanceof BudgetExceeded) { stoppedByBudget = err.message; break; }
            if (!(err instanceof BudgetExceeded)) funnel.page(err instanceof FetchSkipped ? pageReason(err) : 'error', domainOf(f.url));
            if (err instanceof FetchSkipped) { if (err.closed) markClosed(domainOf(f.url)); logFn('skip', `${domainOf(f.url)}: ${err.message}`); } else logFn('warn', `${domainOf(f.url)}: ${err.message}`);
          }
        }
        if (more.length) logFn('info', `«${item.name.slice(0, 60)}»: подошедшие модели (${models.slice(0, 4).join(', ')}) проверены ещё у ${more.length} оптовых поставщиков — цен добавлено: ${added}`);
      }
      for (const offer of enriched) repo.insertOffer(offer);
      for (const o of enriched) if (o.source !== 'contracts') funnel.offer(o.match);
      repo.updateOfferSearch(searchId, { funnel: funnels });
      progress('item', n + 1, items.length);
      if (stoppedByBudget) break;
    }
    if (stoppedByBudget) logFn('warn', `Поиск остановлен: ${stoppedByBudget}. Увеличьте лимит в .env или ищите по одной позиции вручную.`);
    if (dailyExhausted) logFn('warn', `Исчерпан суточный лимит платных запросов к поисковику (${config.SEARCH_DAILY_MAX_API_REQUESTS}, SEARCH_DAILY_MAX_API_REQUESTS) — остальное искали только по бесплатным источникам`);

    // Компании с открытыми ценами из блока «Профильные компании», у которых поиск ничего не нашёл: ищем товар на их
    // сайтах по моделям, которые уже подошли. Бесплатно; остальное дочитается, когда откроют карточку закупки.
    const lookups = config.SEARCH_CANDIDATE_LOOKUPS ?? 12;
    if (lookups > 0 && !stoppedByBudget) {
      try {
        progress('candidates', 0, 1);
        const lk = await lookupCandidates(tender.id, { limit: lookups, inSearch: true });
        if (lk.checked) logFn('info', `У компаний с открытыми ценами дополнительно открыто страниц товара: ${lk.checked}, с ценой: ${lk.found}${lk.left ? `; ещё ${lk.left} — при открытии карточки закупки` : ''}`);
      } catch (err) {
        logFn('warn', `Товар у компаний с открытыми ценами проверить не удалось: ${err.message}`);
      }
    }

    // Адресный поиск недостающих характеристик у лидеров — до выбора товара: подтверждённое по модели влияет на выбор
    if (!stoppedByBudget) {
      try { const mk = await makerPass(tender.id, { log: logFn }); if (mk.offers) logFn('info', `Поиск по модели: проверено предложений ${mk.offers}, подтверждено требований ${mk.changed}`); }
      catch (err) { logFn('warn', `Поиск по модели: ${err.message}`); }
      // Позиции, где подходящего товара с ценой не нашлось, — та же модель или товар по ТЗ на маркетплейсах (Ozon, WB…)
      try { const mp = await marketplaceFill(tender.id, { auto: true, log: logFn }); if (mp.items) logFn('info', `Маркетплейсы: проверено позиций ${mp.items}, подходящих карточек ${mp.fit}, запросов к поиску ${mp.spent}${mp.reused ? `, из своей базы без запроса: ${mp.reused}` : ''}`); }
      catch (err) { logFn('warn', `Маркетплейсы: ${err.message}`); }
    }

    mergeCart(tender.id);
    const picked = autoSelect(tender.id);
    logFn('info', `Готово: предложений ${repo.getOffers(tender.id).length}, лучшее выбрано для ${picked} из ${items.length} позиций`);
    await details.computeEconomics(tender.id, { fetch: false });
    repo.updateOfferSearch(searchId, { status: 'done', progress: null, apiRequests: state.apiRequests, pagesFetched: state.pages, finished: true, error: stoppedByBudget });
    // Продавцов найденных предложений проверяем по реестру недобросовестных поставщиков — в фоне, поиск не ждёт.
    checkRnp({ tenderId: tender.id });
    // Найденные страницы товаров с характеристиками — в свою базу товаров: в следующей закупке искать заново не придётся.
    if (productBase) productBase.refresh().catch((err) => log.warn?.(`[products] ${err.message}`));
  }

  /**
   * Корзина после нового поиска. Отложенные предложения поиск не удаляет; если то же предложение (та же страница
   * товара по той же позиции) найдено снова — корзина переходит на свежую запись с сегодняшней ценой, старая удаляется.
   */
  function mergeCart(tenderId) {
    const offers = repo.getOffers(tenderId);
    const items = repo.getItems(tenderId);
    let merged = 0;
    for (const old of offers.filter((o) => o.in_cart && o.url && o.source !== 'manual')) {
      const fresh = offers.find((o) => o.id > old.id && !o.in_cart && o.item_id === old.item_id && o.source === old.source && o.url === old.url);
      if (!fresh) continue;
      repo.setOfferCart(fresh.id, old.cart_at);
      const item = items.find((i) => i.purchase_offer_id === old.id);
      const parts = repo.getAllocations(tenderId).filter((a) => item && a.item_id === item.id);
      // один продавец на всё количество — как раньше; набор из нескольких — в наборе меняется только эта запись
      if (item && parts.length <= 1) repo.setItemOffer(item.id, fresh, item.purchase_selected_by);
      else repo.replaceAllocationOffer(old.id, fresh.id);
      repo.deleteOffer(old.id);
      merged++;
    }
    return merged;
  }

  /** Корзина для вкладки «Корзина»: закупка → позиция → отложенные предложения (лучшие сверху). */
  function cart() {
    const byTender = new Map();
    for (const o of repo.cartOffers()) {
      if (!byTender.has(o.tender_id)) byTender.set(o.tender_id, []);
      byTender.get(o.tender_id).push(o);
    }
    const tenders = [];
    let count = 0;
    for (const [tenderId, list] of byTender) {
      const t = repo.getTender(tenderId);
      if (!t) continue;
      const all = repo.getItems(tenderId);
      // Что уже сделано по закупке — чтобы из корзины продолжить путь: расчёт, итог, заявка. Позиция закрыта, если
      // цена вписана вручную или партия набрана полностью (так же считает карточка закупки на шаге «Поставщики»).
      const allOffers = repo.getOffers(tenderId);
      const allocations = repo.getAllocations(tenderId);
      const closed = all.filter((i) => {
        if (i.purchase_price_manual != null) return true;
        const v = allocationView(i, allOffers.filter((o) => o.item_id === i.id), allocations);
        return v.allocations.length > 0 && !v.missing;
      });
      const inCart = new Set(list.map((o) => o.item_id));
      const progress = {
        items_total: all.length, items_closed: closed.length,
        // позиции без выбранного товара, по которым в корзине ничего нет: их выбирают в карточке закупки
        items_elsewhere: all.filter((i) => !closed.includes(i) && !inCart.has(i.id)).length,
        docs: t.analysis_status === 'done', calc: Boolean(t.econ_confirmed),
        verdict: t.econ_verdict ?? null, profit: t.econ_profit ?? null, margin_pct: t.econ_margin ?? null,
        bid: null, // состояние заявки добавляет сервер (server.js): корзина о заявках не знает
      };
      const items = all.map((item) => {
        const own = list.filter((o) => o.item_id === item.id && o.seller_decision !== 'blocked').sort(compareOffers).map((o) => withKind(o, item));
        if (!own.length) return null;
        const priced = own.filter((o) => o.total_cost != null && o.source !== 'contracts'); // «дешевле всех» — среди тех, у кого можно купить
        return {
          item_id: item.id, name: item.name, quantity: item.quantity, unit: item.unit, unit_price: item.unit_price ?? null,
          selected_offer_id: item.purchase_offer_id,
          // «дешевле всех» имеет смысл, только когда есть с чем сравнивать
          cheapest_id: priced.length > 1 ? priced.reduce((a, b) => (b.total_cost < a.total_cost ? b : a)).id : null,
          offers: own,
        };
      }).filter(Boolean);
      if (!items.length) continue;
      count += items.reduce((n, i) => n + i.offers.length, 0);
      tenders.push({ id: t.id, title: t.title, number: t.number, law: t.law, price: t.price, deadline_at: t.deadline_at, status: t.status, direction: t.direction ?? null, items, progress });
    }
    return { count, tenders };
  }

  /**
   * Доставка части партии от продавца. Вся партия — как посчитано при поиске. Часть: цена доставки, названная
   * продавцом, от количества не зависит; у перевозчика — пересчёт по весу этой части; иначе — пропорционально.
   */
  function portionDelivery(offer, item, qty, tender) {
    const need = item.quantity || 1;
    if (offer.delivery_cost == null || qty >= need) return offer.delivery_cost ?? null;
    if (offer.delivery_carrier === 'продавец') return offer.delivery_cost;
    if (offer.unit_weight_kg > 0 && offer.seller_region && tender?.region) {
      const s = repo.getProfile().economics;
      const d = estimateDelivery({
        sellerRegion: offer.seller_region, customerRegion: destRegion(tender), goodsCost: (offer.unit_price || 0) * qty, logisticsPct: s.logistics_pct,
        cargo: { weight_kg: offer.unit_weight_kg, volume_m3: offer.unit_volume_m3, estimated: Boolean(offer.cargo_estimated) }, quantity: qty,
        logistics: loadLogistics(config.LOGISTICS_CONFIG),
        settings: { km_per_day: s.delivery_km_per_day, handling_days: s.delivery_handling_days, min_cost: s.delivery_min_cost, reserve_days: s.delivery_reserve_days },
      });
      if (d.carrier) return d.delivery_cost;
    }
    return r2(offer.delivery_cost * (qty / need));
  }

  /**
   * Записать набор партии позиции: rows — [{offer, qty, note}]. Партия набрана полностью — в расчёт идёт средняя
   * цена за единицу; не полностью — цены нет (остаток не закрыт), набор при этом сохраняется и виден.
   */
  function applyAllocation(item, tender, rows, by) {
    const need = item.quantity || 1;
    const parts = rows.map((r) => ({ offer_id: r.offer.id, qty: r.qty, delivery_cost: portionDelivery(r.offer, item, r.qty, tender), note: r.note ?? null, offer: r.offer }));
    const covered = parts.reduce((n, p) => n + p.qty, 0);
    const goods = parts.reduce((n, p) => n + (p.offer.unit_price || 0) * p.qty, 0);
    const full = covered >= need - 1e-9 && parts.every((p) => p.offer.unit_price != null);
    const first = parts[0].offer;
    const sellers = [...new Set(parts.map((p) => p.offer.seller_name || p.offer.domain || p.offer.title).filter(Boolean))];
    repo.setItemPurchase(item.id, {
      by, offer_id: first.id,
      // одна строка на всё количество — цена этого предложения, как и раньше; набор — средняя по набору
      unit_price: !full ? null : parts.length === 1 ? first.unit_price : r2(goods / need),
      delivery: parts.some((p) => p.delivery_cost != null) ? r2(parts.reduce((n, p) => n + (p.delivery_cost || 0), 0)) : null,
      label: parts.length === 1 ? [first.seller_name, first.domain].filter(Boolean).join(', ') || first.title : `набор у ${sellers.length} продавцов: ${sellers.slice(0, 3).join(', ')}`,
      rows: parts.map(({ offer, ...p }) => p),
    });
    return { covered, full };
  }

  /** Набор партии позиции для карточки: сколько нужно, чем закрыто, сколько осталось добрать. */
  function allocationView(item, itemOffers, allocations) {
    const need = item.quantity || 1;
    const rows = allocations.filter((x) => x.item_id === item.id).map((x) => {
      const o = itemOffers.find((y) => y.id === x.offer_id);
      return o ? {
        offer_id: o.id, qty: x.qty, delivery_cost: x.delivery_cost, note: x.note,
        seller: o.seller_name || o.domain || o.title, url: o.url, unit_price: o.unit_price, goods_cost: o.unit_price != null ? r2(o.unit_price * x.qty) : null,
        stock_qty: o.stock_qty, stock_note: o.stock_note, delivery_carrier: o.delivery_carrier,
      } : null;
    }).filter(Boolean);
    const covered = r2(rows.reduce((n, x) => n + x.qty, 0));
    return { needed: need, allocations: rows, covered, missing: Math.max(0, r2(need - covered)) };
  }

  /** Подставить лучшие предложения в каждую позицию (набор партии), если пользователь не выбрал своё. */
  function autoSelect(tenderId) {
    const offers = repo.getOffers(tenderId);
    const tender = repo.getTender(tenderId);
    const allocations = repo.getAllocations(tenderId);
    const usable = (o) => o && o.seller_decision !== 'blocked' && o.source !== 'contracts';
    let picked = 0;
    for (const item of repo.getItems(tenderId)) {
      if (item.purchase_selected_by === 'user') {
        // Выбор пользователя остаётся, пока все его предложения на месте и продавцы не заблокированы.
        const mine = allocations.filter((a) => a.item_id === item.id).map((a) => a.offer_id);
        const ids = mine.length ? mine : [item.purchase_offer_id];
        if (ids.every((id) => usable(offers.find((o) => o.id === id)))) { picked++; continue; }
      }
      // Подходящие предложения по порядку предпочтения: лучшее берём на сколько есть, остаток — у следующих.
      const { ranked } = rankOffers(offers.filter((o) => o.item_id === item.id).map(withSellerType));
      // Сам не выбираем товар в полтора раза дороже цены заказчика за единицу: оригинальный картридж HP за 29 700 ₽
      // при 1 100 ₽ в закупке «подходит» по ТЗ, но покупать его — убыток; такую позицию человек решает сам.
      const affordable = (o) => !(item.unit_price > 0) || !((o.unit_price ?? o.price) > item.unit_price * 1.5);
      const plan = allocate(ranked.filter(isEligible).filter(affordable), item.quantity || 1);
      if (!plan.allocations.length) { repo.setItemOffer(item.id, null, 'auto'); continue; }
      applyAllocation(item, tender, plan.allocations.map((a) => ({ offer: ranked.find((o) => o.id === a.offer_id), qty: a.qty, note: a.check })), 'auto');
      picked++;
    }
    return picked;
  }

  // ---------- реестр недобросовестных поставщиков: фоновая проверка ----------
  /**
   * Записать результат автоматической проверки. Отметка пользователя важнее: его «в реестре» проверка не снимает;
   * его «в реестре нет» уступает найденной действующей записи — это безопаснее.
   */
  async function applyRnp(inn, result) {
    const seller = repo.getSeller(inn);
    const was = seller?.rnp_status || null;
    const manual = seller?.rnp_source === 'manual' ? was : null;
    const note = { records: result.records, excluded: result.excluded, total: result.total };
    if (manual === 'listed' && result.status !== 'listed') return; // решение пользователя остаётся
    if (manual === 'clean' && result.status !== 'listed') return;
    const name = repo.db.prepare('SELECT seller_name FROM offers WHERE seller_inn = ? AND seller_name IS NOT NULL LIMIT 1').get(inn)?.seller_name;
    repo.setSellerRnp(inn, result.status, name, { source: 'auto', note, checked: true });
    if (was === result.status || (was !== 'listed' && result.status !== 'listed')) return;
    // продавец попал в реестр или вышел из него — автоматический выбор и расчёт пересматриваются
    log.log?.(`[rnp] продавец ИНН ${inn}: ${result.status === 'listed' ? 'найден в реестре недобросовестных поставщиков' : 'действующих записей в реестре больше нет'}`);
    for (const { tender_id: tenderId } of repo.db.prepare('SELECT DISTINCT tender_id FROM offers WHERE seller_inn = ?').all(inn)) {
      try { autoSelect(tenderId); await details.computeEconomics(tenderId, { fetch: false }); }
      catch (err) { log.warn?.(`[rnp] пересчёт закупки ${tenderId}: ${err.message}`); }
    }
  }

  function drainRnp() {
    if (rnp.busy || !rnp.checker) return rnp.busy;
    rnp.busy = (async () => {
      let failed = 0;
      while (rnp.queue.length && !rnp.stopped) {
        const inn = rnp.queue.shift();
        try {
          const result = await rnp.checker.check(inn);
          if (rnp.stopped) break;
          await applyRnp(inn, result);
          failed = 0;
        } catch (err) {
          log.warn?.(`[rnp] продавец ИНН ${inn}: ${err.message}`);
          // Реестр не отвечает или страница не та — не перебираем всю очередь впустую, попробуем в следующий раз.
          if (++failed >= 3) { for (const x of rnp.queue) rnp.pending.delete(x); rnp.queue.length = 0; }
        } finally {
          rnp.pending.delete(inn);
        }
      }
    })().finally(() => { rnp.busy = null; });
    return rnp.busy;
  }

  function enqueueRnp(inns, { front = false } = {}) {
    for (const inn of front ? inns.slice().reverse() : inns) {
      const at = rnp.queue.indexOf(inn);
      if (at >= 0 && !front) continue;
      if (at >= 0) rnp.queue.splice(at, 1);
      if (front) rnp.queue.unshift(inn); else rnp.queue.push(inn);
      rnp.pending.add(inn);
    }
    drainRnp();
  }

  function checkRnp({ limit = config.RNP_CHECK_PER_SYNC ?? 10, tenderId = null } = {}) {
    if (!rnp.checker || rnp.stopped || !(limit > 0)) return 0;
    const list = repo.rnpCandidates({ limit, recheckDays: config.RNP_RECHECK_DAYS ?? 14, nowIso: clock().toISOString(), tenderId }).map((r) => r.inn);
    enqueueRnp(list);
    return list.length;
  }

  return {
    sourcesStatus,
    /** Запустить поиск (в очереди). @returns searchId */
    setTzReader(fn) { readTz = fn; },
    /** Сайты оптовых поставщиков для собственного каталога страниц. */
    supplierDomains: () => [...suppliers().map((s) => s.site), ...discovered().map((x) => x.site)],
    start(tenderId, opts = {}) {
      const searchId = repo.createOfferSearch(tenderId);
      queue = queue.then(() => run(searchId, tenderId, opts).catch((err) => {
        log.error?.(`[offers] закупка ${tenderId}: ${err.message}`);
        repo.updateOfferSearch(searchId, { status: 'error', error: err.message, finished: true });
      }));
      return searchId;
    },
    idle: () => queue,

    // Профильные компании для запроса цены: кандидаты по направлению позиции. Предложением (offer) кандидат
    // не становится и закупочной цены не имеет — см. supplier-catalog.js.
    supplierCatalog: (direction = null) => supplierCatalog.list(direction),
    /** Этап 2: таблица «Источники по группам» (без платных запросов). */
    groupSources: (opts) => groupSources.get(opts),
    updateSupplierCandidate: (site, input) => supplierCatalog.update(site, input),
    /** Черновик запроса КП по позиции закупки — только текст, ничего не отправляется. */
    supplierDraft(tenderId, itemId, site) {
      const tender = repo.getTender(tenderId);
      const item = repo.getItems(tenderId).find(i => i.id === itemId);
      if (!tender || !item) throw new Error('Закупка или позиция не найдена');
      return supplierCatalog.draft(tender, item, site);
    },

    /**
     * Предложения закупки по позициям. ranked — где купить (магазины, ручные): лучшие сверху. competitors — кто
     * продавал такой товар заказчикам по прошлым госконтрактам: это конкуренты, их цена — ориентир для нашей.
     */
    listForTender(tenderId) {
      const offers = repo.getOffers(tenderId);
      const allocations = repo.getAllocations(tenderId);
      const searchId = repo.lastOfferSearch(tenderId)?.id ?? null;
      return repo.getItems(tenderId).map((item) => {
        const own = offers.filter((o) => o.item_id === item.id).map(withSellerType)
          .map((o) => (o.seller_inn && rnp.pending.has(o.seller_inn) ? { ...o, seller_rnp_pending: true } : o));
        const r = rankOffers(own.filter((o) => o.source !== 'contracts'));
        const competitors = competitorsOf(own, item);
        return {
          item_id: item.id, selected_offer_id: item.purchase_offer_id, selected_by: item.purchase_selected_by, ...r,
          competitors, competitor_price: competitorPrice(competitors), candidates: candidatesView(item, [...r.ranked, ...r.rejected.map((x) => x.offer)], searchId),
          ...allocationView(item, own, allocations),
          marketplace: marketplaceView(item.id),
          // ссылки на поиск маркетплейсов по запросу из ТЗ — открывает человек в своём браузере, бесплатно
          market_links: (() => {
            const q = marketQuery(item, own)?.query || (searchName(item.name).split(/\s+/).length >= 2 ? searchName(item.name) : null);
            return q ? { query: q, links: searchLinks(q) } : null;
          })(),
          base: baseView(item),
        };
      });
    },

    /** Товар и цена на сайтах компаний с открытыми ценами, у которых по позиции ещё ничего не найдено (бесплатно). */
    lookupCandidates,

    /**
     * Раньше цена победителя прошлого контракта могла стоять в расчёте как закупочная. Снимаем такой выбор и
     * пересчитываем прибыль: без найденного магазина расчёт идёт по ориентиру (ценам тех же контрактов), как оценка.
     * @returns {Promise<{items: number, tenders: number}>}
     */
    /**
     * Раньше в расчёт могло автоматически попасть самое дешёвое предложение с пометкой «нет в наличии».
     * Выбираем заново (ручной выбор не трогаем) и пересчитываем прибыль.
     * @returns {Promise<{items: number, tenders: number}>}
     */
    /**
     * Крупные розничные сети больше не считаются поставщиками: автоматически выбранные предложения из них заменяем
     * лучшим из остальных (ручной выбор не трогаем) и пересчитываем прибыль.
     * @returns {Promise<{items: number, tenders: number}>}
     */
    /**
     * Пересмотреть автоматический выбор во всех закупках по действующим правилам: в расчёт идёт самое дешёвое
     * подходящее предложение поставщика — не розничная сеть, не уценка, не «нет в наличии», не цена вдвое ниже обычной.
     * Выбор, сделанный вручную, не трогается. Прибыль пересчитывается только там, где выбор изменился.
     * @returns {Promise<{tenders: number, changed: number}>}
     */
    async reselectAuto() {
      const ids = repo.db.prepare("SELECT DISTINCT tender_id AS id FROM offers WHERE source NOT IN ('contracts', 'manual')").all().map((r) => r.id);
      let changed = 0;
      for (let i = 0; i < ids.length; i++) {
        const snapshot = () => repo.getItems(ids[i]).map((it) => `${it.id}:${it.purchase_offer_id ?? ''}`).join(',');
        try {
          const before = snapshot();
          autoSelect(ids[i]);
          if (snapshot() !== before) { changed++; await details.computeEconomics(ids[i], { fetch: false }); }
        } catch (err) { log.warn?.(`[offers] пересмотр выбора, закупка ${ids[i]}: ${err.message}`); }
        if (i % 20 === 19) await new Promise(setImmediate);
      }
      return { tenders: ids.length, changed };
    },

    async dropRetailSelections() {
      const rows = repo.db.prepare(`SELECT i.id AS item_id, i.tender_id, o.domain FROM tender_items i JOIN offers o ON o.id = i.purchase_offer_id
        WHERE i.purchase_selected_by = 'auto' AND o.domain IS NOT NULL`).all().filter((r) => isRetail(r.domain));
      const tenders = [...new Set(rows.map((r) => r.tender_id))];
      for (const tenderId of tenders) {
        try {
          autoSelect(tenderId);
          await details.computeEconomics(tenderId, { fetch: false });
        } catch (err) { log.warn?.(`[offers] пересчёт закупки ${tenderId}: ${err.message}`); }
      }
      return { items: rows.length, tenders: tenders.length };
    },

    async dropOutOfStockSelections() {
      const rows = repo.db.prepare(`SELECT i.id AS item_id, i.tender_id, o.availability FROM tender_items i JOIN offers o ON o.id = i.purchase_offer_id
        WHERE i.purchase_selected_by = 'auto' AND o.availability IS NOT NULL`).all().filter((r) => outOfStock(r));
      const tenders = [...new Set(rows.map((r) => r.tender_id))];
      for (const tenderId of tenders) {
        try {
          autoSelect(tenderId);
          await details.computeEconomics(tenderId, { fetch: false });
        } catch (err) { log.warn?.(`[offers] пересчёт закупки ${tenderId}: ${err.message}`); }
      }
      return { items: rows.length, tenders: tenders.length };
    },

    async dropCompetitorSelections() {
      const rows = repo.db.prepare(`SELECT i.id AS item_id, i.tender_id FROM tender_items i JOIN offers o ON o.id = i.purchase_offer_id WHERE o.source = 'contracts'`).all();
      const tenders = [...new Set(rows.map((r) => r.tender_id))];
      for (const r of rows) repo.setItemOffer(r.item_id, null, null);
      for (const tenderId of tenders) {
        try {
          autoSelect(tenderId);
          await details.computeEconomics(tenderId, { fetch: false });
        } catch (err) { log.warn?.(`[offers] пересчёт закупки ${tenderId}: ${err.message}`); }
      }
      return { items: rows.length, tenders: tenders.length };
    },

    /**
     * Дочитать остатки у предложений, найденных раньше, чем сервис научился их читать: страницы товаров открываются
     * заново (бесплатно, без поисковика и нейросети), остаток и наличие обновляются. Сначала выбранные и подходящие,
     * страницы разных сайтов — вперемежку, чтобы не ходить на один сайт подряд. Не больше limit страниц за вызов.
     * @returns {Promise<{checked: number, updated: number, left: number}>}
     */
    /**
     * Модель, сверенная с ТЗ, — на маркетплейсах. search=false — только сохранённое (бесплатно); search=true — найти
     * карточки через поиск Яндекса (1 платный запрос на модель, в суточный лимит), результат сохраняется на 3 дня.
     */
    async marketplaces(tenderId, itemId, { search = false } = {}) {
      const item = repo.getItems(tenderId).find((i) => i.id === itemId);
      if (!item) throw Object.assign(new Error('Позиция не найдена'), { status: 404 });
      const models = confirmedModels(item, repo.getOffers(tenderId).filter((o) => o.item_id === itemId));
      const key = `marketplaces:${itemId}`;
      let saved = {};
      try { saved = JSON.parse(repo.getSetting(key) || '{}'); } catch { saved = {}; }
      const fresh = (m) => saved[m.model] && clock() - new Date(saved[m.model].at) < 3 * 86400000;
      let spent = 0;
      let error = null;
      if (search) {
        if (!models.some((x) => x.model)) error = models.length ? 'У товара, сверенного с ТЗ, нет модели в названии — карточки не отличить от похожих товаров. Посмотрите по ссылкам «Поиск по названию».' : 'Нет модели, сверенной с ТЗ: в ТЗ модель не указана, а у найденных товаров подтверждены не все требования. Найдите поставщиков и выберите подходящий товар — тогда его модель можно будет искать на маркетплейсах.';
        else if (!yandex) error = 'Поиск на маркетплейсах идёт через поиск Яндекса, а ключа Яндекса нет — впишите его в .env';
        for (const m of error ? [] : models.filter((x) => x.model && !fresh(x))) {
          if (dailyLeft() <= 0) { error = `Исчерпан суточный лимит платных запросов к поисковику (${config.SEARCH_DAILY_MAX_API_REQUESTS}) — продолжите завтра`; break; }
          repo.addApiUsage('yandex', today());
          spent++;
          try {
            const results = await yandex.search(`${m.query} (site:ozon.ru | site:wildberries.ru | site:market.yandex.ru | site:megamarket.ru)`);
            saved[m.model] = { at: clock().toISOString(), cards: cardsFrom(results, m.model) };
          } catch (err) { error = `Поиск Яндекса не ответил: ${err.message}`; break; }
        }
        repo.setSetting(key, JSON.stringify(saved));
      }
      return {
        item_id: itemId, spent, error, available: Boolean(yandex),
        models: models.map((m) => ({ ...m, links: searchLinks(m.query), searched_at: saved[m.model]?.at || null, cards: m.model ? saved[m.model]?.cards || null : null })),
      };
    },

    // selectedOnly — «Подтвердить наличие»: заново открыть страницы выбранных товаров (не чаще раза в 30 минут на товар)
    async refreshStock(tenderId, { limit = 8, selectedOnly = false } = {}) {
      const selected = new Set(repo.getItems(tenderId).map((i) => i.purchase_offer_id).filter(Boolean));
      const rank = (o) => (selected.has(o.id) ? 0 : o.match === 'соответствует' ? 1 : o.match === 'частично' ? 2 : o.match === 'не соответствует' ? 4 : 3);
      const todo = repo.getOffers(tenderId)
        .filter((o) => o.url && o.source !== 'contracts' && o.source !== 'manual' && !isRetail(o.domain)
          && (selectedOnly ? selected.has(o.id) && (!o.stock_checked_at || clock() - new Date(o.stock_checked_at) > 30 * 60000) : !o.stock_checked_at))
        .sort((a, b) => rank(a) - rank(b) || (a.unit_price ?? Infinity) - (b.unit_price ?? Infinity));
      // по кругу по сайтам: первый с каждого сайта, потом второй…
      const bySite = new Map();
      for (const o of todo) bySite.set(o.domain, [...(bySite.get(o.domain) || []), o]);
      const order = [];
      for (let i = 0; order.length < todo.length; i++) for (const list of bySite.values()) if (list[i]) order.push(list[i]);
      let updated = 0;
      const batch = order.slice(0, limit);
      for (const o of batch) {
        try {
          const page = await fetcher.fetchPage(o.url);
          const from = titleStart(page.html, page.text, o.title);
          const level = (page.structured || []).find((s) => s.stock != null)?.stock ?? null;
          const said = (page.structured || []).length === 1 ? page.structured[0].availability : null;
          const st = readStock({ text: page.text.slice(from, from + 3500), html: page.html, level, availability: said, attr: stockAttrOf(o.url) });
          repo.setOfferStock(o.id, { qty: st.qty, note: st.note, availability: st.availability });
          if (st.qty != null || st.availability) updated++;
        } catch (err) {
          // Страница не открылась — помечаем проверенной, чтобы не ходить на неё при каждом открытии карточки.
          repo.setOfferStock(o.id, { qty: null, note: null, availability: null });
          if (err instanceof FetchSkipped) { if (err.closed) markClosed(o.domain); } else log.warn?.(`[stock] предложение ${o.id}: ${err.message}`);
        }
      }
      if (updated) { autoSelect(tenderId); await details.computeEconomics(tenderId, { fetch: false }); }
      // итог по выбранным товарам — для короткого ответа «что с наличием»
      const sel = repo.getOffers(tenderId).filter((o) => selected.has(o.id));
      const inStock = sel.filter((o) => o.stock_qty > 0 || /в наличии|in_stock|instock/i.test(o.availability || '')).length;
      const out = sel.filter((o) => o.stock_qty === 0 || /нет в наличии|под заказ|out_of_stock|outofstock/i.test(o.availability || '')).length;
      return { checked: batch.length, updated, left: order.length - batch.length, selected: { total: sel.length, in_stock: inStock, out_of_stock: out, unknown: sel.length - inStock - out } };
    },

    /**
     * «Проверить ссылку»: что стало бы в поиске с товаром, который человек нашёл сам. Проходит те же шаги, что и поиск
     * (отбор сайта → открытие страницы → цена → сверка с ТЗ), и на каждом говорит, прошла ли ссылка и почему.
     * Платных запросов к поисковику не делает и ничего не сохраняет: добавить товар в список — отдельное действие.
     * Сайт, исключённый из поиска, всё равно пробуем открыть: человек назвал страницу сам, ему нужен ответ по ней.
     * @returns {Promise<{url, domain, steps: Array<{key, ok, title, text}>, in_search: boolean, can_add: boolean, known: boolean, offer?: object}>}
     */
    /**
     * «Дочитать характеристики»: открыть страницу предложения заново, дочитать вкладку «Характеристики» и PDF-паспорт,
     * сверить с ТЗ и обновить сверку у этого же предложения. Выбор товара не меняется — если сверка стала хуже,
     * пользователь видит предупреждение.
     */
    /** «Найти по модели»: адресный поиск недостающих характеристик у одного предложения (платно, свой лимит). */
    /**
     * Ручное подтверждение требования: пользователь сам нашёл значение (ссылка, паспорт, ответ поставщика).
     * Сохраняется с датой, основанием и прежним значением — видно, что это сделано вручную, и можно отменить.
     * verdict: yes | no | reset (вернуть как было).
     */
    confirmRow(offerId, { name, verdict, source = '', note = '' }) {
      const o = repo.getOffer(offerId);
      if (!o) throw Object.assign(new Error('Предложение не найдено'), { status: 404 });
      const checks = o.match_checks;
      const row = (checks?.rows || []).find((r) => r.name === name);
      if (!row) throw Object.assign(new Error('Такого требования в сверке нет'), { status: 404 });
      let rows;
      if (verdict === 'reset') {
        if (!row.manual) throw Object.assign(new Error('Это требование вручную не подтверждали'), { status: 409 });
        rows = checks.rows.map((r) => (r === row ? { ...r.manual.before } : r));
      } else {
        if (!String(source).trim() && !String(note).trim()) throw Object.assign(new Error('Укажите, где нашли: ссылку или комментарий'), { status: 400 });
        const before = row.manual ? row.manual.before : Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'manual'));
        const url = /^https?:\/\//i.test(String(source).trim()) ? String(source).trim() : null;
        rows = checks.rows.map((r) => (r === row ? {
          name: r.name, need: r.need, verdict, found: String(note || (url ? 'по ссылке' : source)).slice(0, 200),
          method: 'подтверждено вручную', source: url, quote: null,
          manual: { at: clock().toISOString(), source: String(source).slice(0, 500), note: String(note).slice(0, 500), before },
        } : r));
      }
      const sc = repo.getDetails?.(o.tender_id)?.spec_coverage;
      const { checks: next, match } = recount({ ...checks, rows }, { specComplete: !sc || !['partial', 'failed'].includes(sc.status) });
      const manual = next.rows.filter((r) => r.manual).length;
      const notes = [manual ? `Вручную подтверждено требований: ${manual}` : null, ...(o.match_notes || []).filter((n) => !/^Вручную подтверждено/.test(n))].filter(Boolean).slice(0, 8);
      repo.setOfferMatch(o.id, { match, notes, checks: next });
      return { before: o.match, after: match };
    },

    async findByModel(offerId, { paid = true, log = () => {} } = {}) {
      const o = repo.getOffer(offerId);
      if (!o) throw Object.assign(new Error('Предложение не найдено'), { status: 404 });
      const r = await makerEnrich(o, { budget: { left: 2 }, paid, log });
      // выбранный товар не меняется (как у «Дочитать характеристики»): решение остаётся за пользователем
      return { ...r, daily_left: yandex ? Math.max(0, makerLeft()) : null };
    },

    async recheck(offerId) {
      const o = repo.getOffer(offerId);
      if (!o) throw Object.assign(new Error('Предложение не найдено'), { status: 404 });
      if (!o.url) throw Object.assign(new Error('У предложения нет ссылки на страницу — дочитывать нечего'), { status: 409 });
      const tender = repo.getTender(o.tender_id);
      const item = repo.getItems(o.tender_id).find((i) => i.id === o.item_id);
      if (!tender || !item) throw Object.assign(new Error('Позиция не найдена'), { status: 404 });
      let page;
      try { page = await fetcher.fetchPage(o.url); }
      catch (err) { if (err instanceof FetchSkipped) return { ok: false, reason: PAGE_REASONS[pageReason(err)] || err.message }; throw err; }
      const raw = await extractOffer(page, item, { llm: llmFactory(), system: loadPrompt('offer'), stockAttr: stockAttrOf(o.url) }).catch(() => null);
      if (!raw) return { ok: false, reason: 'страница открылась, но товар на ней не распознан' };
      const econ = repo.getEconomics(tender.id);
      const settings = repo.getProfile().economics;
      const ctx = { settings, llm: llmFactory(), matchPrompt: loadPrompt('match'), deliveryTermDays: econ?.result?.inputs?.delivery_days ?? settings.default_delivery_days, medianByItem: {}, docBudget: { left: config.SEARCH_DOCS_PER_OFFER ?? 2 } };
      const fresh = await enrich({ ...raw, price: raw.price ?? o.price, source: o.source }, { item, tender, ctx });
      repo.setOfferMatch(o.id, { match: fresh.match, notes: fresh.match_notes, checks: fresh.match_checks, specs: fresh.specs });
      const worse = MATCH_ORDER_RANK[fresh.match] < MATCH_ORDER_RANK[o.match];
      const selected = item.purchase_offer_id === o.id;
      return { ok: true, before: o.match, after: fresh.match, docs: fresh.match_checks?.docs || [],
        warning: worse && selected ? 'Сверка стала хуже, а этот товар выбран для расчёта — выбор оставлен как есть, проверьте его' : null };
    },

    async checkUrl(tenderId, { item_id, url }) {
      const tender = repo.getTender(tenderId);
      const item = repo.getItems(tenderId).find((i) => i.id === Number(item_id));
      if (!tender || !item) throw Object.assign(new Error('Позиция не найдена'), { status: 404 });
      const domain = domainOf(url);
      if (!domain) throw Object.assign(new Error('Это не адрес страницы — нужна ссылка вида https://сайт/товар'), { status: 400 });
      const steps = [];
      const out = { url, domain, steps, in_search: false, can_add: false, known: repo.getOffers(tenderId).some((o) => o.item_id === item.id && o.url === url) };

      // Шаг 1. Берёт ли поиск этот сайт вообще.
      const why = urlDropReason(url);
      const closedAt = why === 'closed' ? repo.getSetting(`closed_domain:${domain}`) : null;
      steps.push(why
        ? { key: 'site', ok: false, reason: why, reason_label: DROP_REASONS[why], title: 'Сайт в поиск не берётся', text: `Причина: ${DROP_REASONS[why]}${closedAt ? ` (отмечен ${closedAt.slice(0, 10)}, повторная попытка — через ${CLOSED_DAYS} дней)` : ''}. Поэтому поиск эту страницу не открывал — но проверить её саму можно.` }
        : { key: 'site', ok: true, title: 'Сайт в поиск берётся', text: 'Сайт не входит в списки исключённых.' });

      // Шаг 2. Открывается ли страница для программы.
      let page;
      try {
        page = await fetcher.fetchPage(url);
        steps.push({ key: 'page', ok: true, title: 'Страница открылась', text: 'Сайт отдал страницу программе.' });
      } catch (err) {
        if (!(err instanceof FetchSkipped)) throw err;
        steps.push({ key: 'page', ok: false, reason: pageReason(err), reason_label: PAGE_REASONS[pageReason(err)], title: 'Страница не открылась', text: `${PAGE_REASONS[pageReason(err)]}. Человек в браузере её видит, программа — нет; обходить такую защиту сервис не будет. Цену можно ввести вручную.` });
        return out;
      }

      // Шаг 3. Есть ли на странице цена товара.
      let raw = null;
      try {
        raw = await extractOffer(page, item, { llm: llmFactory(), system: loadPrompt('offer'), listing: true, stockAttr: stockAttrOf(url) });
      } catch (err) {
        if (!(err instanceof FetchSkipped)) throw err;
        steps.push({ key: 'price', ok: false, reason: pageReason(err), reason_label: PAGE_REASONS[pageReason(err)], title: 'Цена не найдена', text: `${PAGE_REASONS[pageReason(err)]}. ${err.listing?.length ? 'Откройте страницу самого товара и проверьте её ссылку.' : ''}`.trim() });
        return out;
      }
      if (!raw || raw.price == null) {
        steps.push({ key: 'price', ok: false, reason: 'no_price', reason_label: PAGE_REASONS.no_price, title: 'Цена не найдена', text: 'На странице нет цены, которую можно прочитать: её показывают после входа, по запросу или подгружают отдельно. Цену можно ввести вручную.' });
        return out;
      }
      steps.push({ key: 'price', ok: true, title: 'Цена найдена', text: `${raw.title} — ${raw.price} ₽${raw.availability ? `, ${raw.availability}` : ''}.` });

      // Шаг 4. Сверка с ТЗ — та же, что в поиске.
      const econ = repo.getEconomics(tender.id);
      const settings = repo.getProfile().economics;
      const bench = repo.getBenchmark(item.ktru_code || item.okpd2_code || '');
      const offer = await enrich({ ...raw, source: 'manual' }, {
        item, tender,
        ctx: { settings, llm: llmFactory(), matchPrompt: loadPrompt('match'), deliveryTermDays: econ?.result?.inputs?.delivery_days ?? settings.default_delivery_days, medianByItem: { [item.id]: bench?.unit_price?.median ?? null } },
      });
      const fits = offer.match === 'соответствует' || offer.match === 'частично';
      steps.push({ key: 'match', ok: offer.match !== 'не соответствует', title: `Сверка с ТЗ: ${offer.match}`, text: (offer.match_notes || []).slice(0, 3).join(' ') || 'Требований для сверки в ТЗ нет.' });
      out.offer = offer;
      out.can_add = true;
      out.in_search = !why && fits;
      return out;
    },

    /** Ручное предложение: по ссылке (страница открывается и разбирается) или введённое руками. */
    /** «Подобрать из базы» по позиции: сверка товаров своей базы с ТЗ заново (нейросеть — у лучших). */
    async baseCheck(tenderId, itemId) {
      const item = repo.getItems(tenderId).find((i) => i.id === Number(itemId));
      if (!item) throw Object.assign(new Error('Позиция не найдена'), { status: 404 });
      if (!productBase) throw Object.assign(new Error('Своя база товаров выключена (PRODUCT_BASE=0)'), { status: 400 });
      if (!baseKind(item)) throw Object.assign(new Error('Своя база товаров пока охватывает компьютеры, картриджи и расходники, оргтехнику, комплектующие и мебель'), { status: 400 });
      return { base: await baseFill(tenderId, item, { force: true }) };
    },
    baseStatus: () => (productBase ? productBase.status() : null),
    registryStatus: () => (registry ? registry.status() : null),

    /** Маркетплейсы по позициям закупки без подходящего товара с ценой (то же, что после поиска поставщиков). */
    marketplaceFill,
    /** «Найти на маркетплейсах» по позиции: поиск Яндекса (1 платный запрос) и сверка карточек с ТЗ. */
    async marketplaceCheck(tenderId, itemId) {
      const r = await marketplaceFill(tenderId, { itemIds: [Number(itemId)], force: true });
      return { ...r, marketplace: marketplaceView(Number(itemId)) };
    },

    async addManual(tenderId, { item_id, url, price, seller_name, seller_inn, seller_city, delivery_days, delivery_cost, title, same_model, mp_card }) {
      const tender = repo.getTender(tenderId);
      const item = repo.getItems(tenderId).find((i) => i.id === Number(item_id));
      if (!tender || !item) throw Object.assign(new Error('Позиция не найдена'), { status: 404 });
      let raw;
      if (url && price == null) {
        const page = await fetcher.fetchPage(url);
        raw = await extractOffer(page, item, { llm: llmFactory(), system: loadPrompt('offer'), stockAttr: stockAttrOf(url) });
        if (!raw || raw.price == null) throw Object.assign(new Error('На странице не удалось найти цену — введите её вручную'), { status: 400 });
      } else {
        raw = { title: title || item.name, url: url || null, price: Number(price), unit: item.unit, pack_qty: 1, seller_name: seller_name || null,
          seller_inn: seller_inn || null, seller_inn_on_site: false, seller_region: regionFromText(seller_city || '') ?? regionFromInn(seller_inn),
          delivery_days: delivery_days ?? null, delivery_cost: delivery_cost ?? null, extracted_by: 'ручной ввод' };
      }
      const econ = repo.getEconomics(tender.id);
      const settings = repo.getProfile().economics;
      const bench = repo.getBenchmark(item.ktru_code || item.okpd2_code || '');
      const offer = await enrich({ ...raw, source: 'manual' }, {
        item, tender,
        ctx: { settings, llm: llmFactory(), matchPrompt: loadPrompt('match'), deliveryTermDays: econ?.result?.inputs?.delivery_days ?? settings.default_delivery_days, medianByItem: { [item.id]: bench?.unit_price?.median ?? null } },
      });
      // Карточка маркетплейса той же модели, что уже сверена с ТЗ (проверяется здесь, а не со слов страницы): характеристики
      // модели подтверждены по странице другого продавца — товар соответствует. Сама страница маркетплейса не читалась.
      if (same_model) {
        const m = confirmedModels(item, repo.getOffers(tenderId).filter((o) => o.item_id === item.id)).find((x) => x.model === same_model);
        if (m && sameModel(offer.title, m.model)) {
          offer.match = 'соответствует';
          offer.match_notes = [`та же модель ${m.model}, что и у товара, сверенного с ТЗ (${m.basis}); страницу маркетплейса сервис не читает — наличие и комплектацию проверьте по ссылке`];
        }
      }
      // Карточка маркетплейса, уже сверенная с ТЗ (по названию, описанию и данным модели с других сайтов), — переносим сверку
      if (mp_card && url) {
        let saved = null;
        try { saved = JSON.parse(repo.getSetting(`mpauto:${item.id}`) || 'null'); } catch { saved = null; }
        const card = saved?.cards?.find((c) => c.url === url);
        if (card?.checks) {
          offer.match = card.match;
          offer.match_checks = card.checks;
          offer.match_notes = [`${card.market_name}: сверено с ТЗ по названию и описанию карточки${card.checks?.maker?.changed ? ' и по данным модели с других сайтов' : ''}; страницу маркетплейса сервис не читает — комплектацию и продавца проверьте по ссылке`, ...(card.notes || [])].slice(0, 6);
        }
      }
      const id = repo.insertOffer(offer);
      autoSelect(tenderId);
      await details.computeEconomics(tenderId, { fetch: false });
      return repo.getOffer(id);
    },

    async select(offerId, { clear = false } = {}) {
      const offer = repo.getOffer(offerId);
      if (!offer) throw Object.assign(new Error('Предложение не найдено'), { status: 404 });
      if (!clear && offer.source === 'contracts') {
        throw Object.assign(new Error('Это конкурент: он сам продавал такой товар заказчику, и в его цене уже есть наценка. Его цена — ориентир для вашей. Чтобы взять её в расчёт как закупочную, введите цену вручную в таблице позиций.'), { status: 400 });
      }
      repo.setItemOffer(offer.item_id, clear ? null : offer, clear ? null : 'user');
      // Явный выбор предложения — последнее решение человека: ручная цена позиции больше не перекрывает его.
      if (!clear) repo.setItemManualPrice(offer.tender_id, offer.item_id, null);
      if (clear) autoSelect(offer.tender_id);
      await details.computeEconomics(offer.tender_id, { fetch: false });
      return offer;
    },

    /**
     * Набор партии вручную: list — [{offer_id, qty}]. Предложения должны относиться к этой позиции; набрать можно
     * меньше нужного (остаток будет виден), но не больше. Пустой список — вернуть автоматический набор.
     */
    async setAllocations(tenderId, itemId, list) {
      const tender = repo.getTender(tenderId);
      const item = tender && repo.getItems(tenderId).find((i) => i.id === itemId);
      if (!item) throw Object.assign(new Error('Закупка или позиция не найдена'), { status: 404 });
      const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
      if (!Array.isArray(list)) throw bad('Нужен список: предложение и количество');
      if (!list.length) {
        repo.setItemOffer(item.id, null, null);
        autoSelect(tenderId);
      } else {
        const offers = repo.getOffers(tenderId).filter((o) => o.item_id === item.id);
        const seen = new Set();
        const rows = list.map((x) => {
          const offer = offers.find((o) => o.id === Number(x.offer_id));
          const qty = Number(x.qty);
          if (!offer) throw bad('Предложение не относится к этой позиции');
          if (offer.source === 'contracts') throw bad('Это конкурент: его цена — ориентир, а не закупочная. В набор его добавить нельзя');
          if (!(qty > 0)) throw bad('Количество должно быть больше нуля');
          if (seen.has(offer.id)) throw bad('Одно предложение указано дважды');
          seen.add(offer.id);
          return { offer, qty, note: offer.stock_qty != null && !/^более/.test(offer.stock_note || '') && qty > offer.stock_qty ? `на странице в наличии ${offer.stock_qty} шт — уточните остальное` : null };
        });
        const need = item.quantity || 1;
        const total = rows.reduce((n, r) => n + r.qty, 0);
        if (total > need + 1e-9) throw bad(`Набрано ${total}, а нужно ${need} — уменьшите количество`);
        applyAllocation(item, tender, rows, 'user');
        // Явный набор — последнее решение человека: ручная цена позиции больше не перекрывает его.
        repo.setItemManualPrice(tenderId, item.id, null);
      }
      await details.computeEconomics(tenderId, { fetch: false });
      return { ok: true };
    },

    /** Решение по продавцу — действует во всех закупках. */
    async sellerDecision(inn, decision) {
      const d = decision === 'none' ? null : decision;
      const offersWithInn = repo.db.prepare('SELECT DISTINCT tender_id FROM offers WHERE seller_inn = ?').all(inn).map((r) => r.tender_id);
      const name = repo.db.prepare('SELECT seller_name FROM offers WHERE seller_inn = ? AND seller_name IS NOT NULL LIMIT 1').get(inn)?.seller_name;
      repo.setSellerDecision(inn, d, name);
      for (const tenderId of offersWithInn) {
        for (const o of repo.getOffers(tenderId).filter((x) => x.seller_inn === inn)) {
          const seller = repo.getSeller(inn);
          const { trust, reasons, verified } = assessTrust({
            inn, egrul: seller?.egrul, price: o.unit_price, medianPrice: null, hasInnOnSite: o.seller_inn_on_site, decision: d, now: clock(),
            govContracts: seller?.gov_contracts || 0, innFromRegistry: o.source === 'contracts',
          });
          repo.updateOfferTrust(o.id, trust, reasons, verified);
        }
        // Заблокированный продавец не может оставаться выбранным.
        for (const item of repo.getItems(tenderId)) {
          const sel = item.purchase_offer_id && repo.getOffer(item.purchase_offer_id);
          if (sel && sel.seller_inn === inn && d === 'blocked') repo.setItemOffer(item.id, null, null);
        }
        autoSelect(tenderId);
        await details.computeEconomics(tenderId, { fetch: false });
      }
      return { inn, decision: d, affected_tenders: offersWithInn.length };
    },
    /**
     * Отметка продавца по реестру недобросовестных поставщиков: 'clean' | 'listed' | 'none' (снять).
     * Действует во всех закупках. «В реестре» — автоматический выбор такого продавца снимается; выбранное
     * пользователем вручную остаётся (интерфейс показывает предупреждение).
     */
    async sellerRnp(inn, status) {
      const s = status === 'none' ? null : status;
      const tenders = repo.db.prepare('SELECT DISTINCT tender_id FROM offers WHERE seller_inn = ?').all(inn).map((r) => r.tender_id);
      const name = repo.db.prepare('SELECT seller_name FROM offers WHERE seller_inn = ? AND seller_name IS NOT NULL LIMIT 1').get(inn)?.seller_name;
      repo.setSellerRnp(inn, s, name, { source: 'manual' });
      for (const tenderId of tenders) {
        autoSelect(tenderId);
        await details.computeEconomics(tenderId, { fetch: false });
      }
      return { inn, rnp: s, affected_tenders: tenders.length };
    },
    /** Проверить по реестру продавцов, которых пора проверить (в фоне). @returns {number} сколько поставлено в очередь */
    checkRnp,
    /** Проверить продавца вне очереди — по кнопке. @returns {{queued: boolean, reason?: string}} */
    checkRnpNow(inn) {
      if (!rnp.checker) return { queued: false, reason: 'Автоматическая проверка по реестру выключена (RNP_AUTO=0)' };
      if (!/^(\d{10}|\d{12})$/.test(String(inn))) return { queued: false, reason: 'ИНН — 10 или 12 цифр' };
      enqueueRnp([String(inn)], { front: true });
      return { queued: true, ahead: rnp.queue.indexOf(String(inn)) };
    },
    /** Дождаться окончания идущих проверок (для тестов и остановки). */
    rnpIdle: () => rnp.busy || Promise.resolve(),
    /** Остановить фоновые проверки (при остановке сервиса). */
    stop() { rnp.stopped = true; rnp.queue.length = 0; },
    ensureContacts,
    cart,
    mergeCart,
    /** Отложить предложение в корзину или убрать из неё. */
    setCart(offerId, on) {
      const offer = repo.getOffer(offerId);
      if (!offer) throw Object.assign(new Error('Предложение не найдено'), { status: 404 });
      repo.setOfferCart(offerId, on ? clock().toISOString() : null);
      return offer;
    },
    findOnSupplierSite,
    findProductsForTender,
    /** Заново выбрать лучшие предложения по уже найденному (без платного поиска) и пересчитать прибыль. */
    async reselect(tenderId) {
      const picked = autoSelect(tenderId);
      await details.computeEconomics(tenderId, { fetch: false });
      return { picked };
    },
  };
}

module.exports = { createOfferService };
