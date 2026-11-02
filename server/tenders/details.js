// Карточка закупки для этапа 3: позиции, условия, рыночный ориентир и расчёт выгодности.
// Собирает входы калькулятора из разных мест и помечает, откуда взята каждая цифра.

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { itemsFrom44Notification, itemsFrom223Purchase } = require('./items');
const { fetchBenchmark } = require('./benchmark');
const { calculate, priceVariants } = require('./economics');
const { callJson } = require('../analyze/json');
const { buildChunkQueue, sha } = require('../analyze/chunk');
const { runQueue } = require('../analyze/queue');
const { analysisCoverage, describe } = require('../analyze/coverage');
const { DAY_MS, focusShare } = require('./filters');
const directions = require('./directions');
const { platformFromDoc } = require('./platforms');
const { customerFromDoc } = require('./customer');
const { hubDelivery, confidenceOf, opportunityRank } = require('./opportunity');
const { itemBenchmark, unresolvedLines, lineText, acceptLlmVerdict, priceLooksSane } = require('./item-benchmark');
const { quoteInText } = require('../analyze/verify');
const { specOf, nameStems, comparatorOf, unitOfValue } = require('../offers/spec');
const { regionFromInn } = require('../offers/logistics');
const { isManual } = require('./manual');
const { itemsFromTables, pickItems } = require('./rule-items');
const { withTabTables, singleProduct } = require('./plain-items');
// Снижение цены на торгах по прошлым контрактам выше этого — не верим (рамочные контракты, цена за единицу)
const MAX_TRUSTED_DECLINE = 0.5;

const SRC = {
  notification: 'извещение',
  card: 'разбор документации',
  contracts: 'контракты ЕИС',
  manual: 'ручной ввод',
  offer: 'поиск поставщиков',
  profile: 'по умолчанию из профиля',
};

// ---------- разбор чисел из текста карточки этапа 1 ----------
const pctFrom = (text) => {
  const m = String(text || '').match(/(\d+(?:[.,]\d+)?)\s*%/);
  return m ? Number(m[1].replace(',', '.')) : null;
};

/** «в течение 10 календарных дней» → 10; «30 (тридцати) рабочих дней» → 42 календарных. */
function daysFrom(text) {
  const m = String(text || '').match(/(\d{1,3})\s*(?:\([^)]{0,40}\)\s*)?(календарн\S*|рабоч\S*)?\s*(?:дн|день|дня)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return /рабоч/i.test(m[2] || '') ? Math.ceil((n * 7) / 5) : n;
}

const cardField = (card, key) => card?.groups?.flatMap((g) => g.fields).find((f) => f.key === key && f.status === 'found')?.value ?? null;

/** Обеспечения из извещения 44-ФЗ. Нет блока — обеспечение не требуется (0). */
function conditionsFrom44(notification) {
  const src = notification?.source || {};
  const req = [].concat(src.notificationInfo?.customerRequirementsInfo?.customerRequirementInfo || [])[0];
  // Срок подачи и заказчик нужны и сами по себе: источник (лента ЕИС) их не отдаёт.
  const endDt = src.notificationInfo?.procedureInfo?.collectingInfo?.endDT || null;
  const customerInn = req?.customer?.INN || src.purchaseResponsibleInfo?.responsibleOrgInfo?.INN || null;
  const base = {
    ...(endDt ? { deadline_at: new Date(endDt).toISOString() } : {}),
    ...(customerInn ? { customer_inn: String(customerInn) } : {}),
    // версия извещения: 1 — документация не менялась, больше — заказчик вносил изменения
    ...(src.versionNumber != null ? { notice_version: Number(src.versionNumber) } : {}),
    ...(src.commonInfo?.publishDTInEIS ? { notice_published_at: String(src.commonInfo.publishDTInEIS) } : {}),
  };
  if (!req) return base;
  return {
    ...base,
    bid_security_pct: req.applicationGuarantee?.part != null ? Number(req.applicationGuarantee.part) : 0,
    contract_security_pct: req.contractGuarantee?.part != null ? Number(req.contractGuarantee.part) : 0,
  };
}

/**
 * Можно ли брать цену прошлых контрактов как цену закупки позиции.
 * Код ОКПД2 — это группа разных товаров, а «условная единица» — вся партия одной строкой; в таких случаях
 * цены контрактов за штуку несопоставимы. Требуем, чтобы ориентир был в разумных пределах от цены заказчика.
 */
function benchmarkComparable(item, bench) {
  const p = bench?.unit_price?.p25;
  if (p == null) return false;
  if (/условн/i.test(item.unit || '')) return false;
  if (item.unit_price == null) return Boolean(item.ktru_code);
  const ratio = p / item.unit_price;
  return ratio >= 0.25 && ratio <= 4;
}

/** Цена «того же товара» не отличается от цены заказчика больше чем в 5 раз — иначе, скорее всего, ошибка единиц. */
// Расходники (картридж, тонер, фотобарабан, чернила): совместимый дешевле оригинала в 5–15 раз — это нормальная цена,
// а не ошибка единиц (у заказчика TL-5120X за 10 762 ₽, совместимый — 903 ₽).
const CONSUMABLE = /картридж|тонер|фотобарабан|драм|чернил/i;
function saneRatio(item, price) {
  if (item.unit_price == null || !price) return true;
  const r = price / item.unit_price;
  return r >= (CONSUMABLE.test(String(item.name || '')) ? 0.05 : 0.2) && r <= 5;
}

const SpecSchema = z.object({
  items: z.array(z.object({
    idx: z.coerce.number().int().nullable().catch(null),
    name: z.coerce.string(),
    quantity: z.coerce.number().nullable().catch(null),
    unit: z.coerce.string().nullable().catch(null),
    pack_qty: z.coerce.number().nullable().catch(null),
    equivalent_allowed: z.boolean().nullable().catch(null),
    identity: z.object({
      model: z.coerce.string().nullable().catch(null), brand: z.coerce.string().nullable().catch(null),
      compatible_with: z.coerce.string().nullable().catch(null), standard: z.coerce.string().nullable().catch(null),
    }).catch({ model: null, brand: null, compatible_with: null, standard: null }),
    required: z.array(z.object({
      name: z.coerce.string(), value: z.coerce.string(), unit: z.coerce.string().nullable().catch(null),
      comparator: z.enum(['=', '>=', '<=', 'range', 'one_of']).catch('='),
      quote: z.coerce.string().nullable().catch(null), file: z.coerce.string().nullable().catch(null), page: z.coerce.number().nullable().catch(null),
    })).default([]),
  })).default([]),
});

const SameSchema = z.object({
  results: z.array(z.object({ i: z.coerce.number().int(), same: z.boolean().nullable().catch(null), reason: z.coerce.string().catch('') })).default([]),
});

const ItemsSchema = z.object({
  items: z.array(z.object({
    name: z.coerce.string(),
    quantity: z.coerce.number().nullable().catch(null),
    unit: z.coerce.string().nullable().catch(null),
    characteristics: z.array(z.object({ name: z.coerce.string(), value: z.coerce.string() })).default([]),
  })).default([]),
});

/**
 * Позиции, прочитанные из документов заново (закупка добавлена вручную, дозагружены файлы): если это та же позиция,
 * что уже была, — то же количество и почти то же название, — оставляем прежнюю запись. Нейросеть называет один товар
 * чуть по-разному («Картридж X» и «Картридж X, ресурс не менее 3000 страниц»), а с записью связаны цены и поставщики.
 */
function keepKnown(fresh, saved) {
  const words = (s) => new Set(String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 1));
  const used = new Set();
  return fresh.map((it) => {
    const w = words(it.name);
    let best = null;
    let bestScore = 0;
    for (const old of saved) {
      if (used.has(old.id) || (old.quantity ?? null) !== (it.quantity ?? null)) continue;
      const ow = words(old.name);
      // доля слов более короткого названия, которые есть в другом
      const score = [...w].filter((x) => ow.has(x)).length / Math.max(1, Math.min(w.size, ow.size));
      if (score > bestScore) { best = old; bestScore = score; }
    }
    if (!best || bestScore < 0.8) return it;
    used.add(best.id);
    // характеристики, дописанные чтением ТЗ, в сохранённой позиции считаются пустыми (см. saveItems)
    const fromTz = best.spec?.required?.length
      && JSON.stringify(best.spec.required.map((r) => ({ name: r.name, value: r.value }))) === JSON.stringify(best.characteristics || []);
    return { ...it, name: best.name, ktru_code: best.ktru_code ?? null, okpd2_code: best.okpd2_code ?? null, unit: best.unit ?? null, characteristics: fromTz ? [] : best.characteristics || [] };
  });
}

function createTenderDetails({ repo, source, llmFactory, config, log = console, clock = () => new Date() }) {
  const settingsOf = () => repo.getProfile().economics;

  /** Позиции закупки: из кеша, иначе из извещения/закупки, иначе — из текста разбора документации через LLM. */
  async function ensureItems(tender, { force = false, doc: given = null } = {}) {
    if (!force && repo.getDetails(tender.id)) return repo.getItems(tender.id);
    let items = [];
    let conditions = {};
    let error = null;
    let itemsSource = 'notification';
    // Закупка добавлена вручную: извещения нет, к источникам не обращаемся — позиции берём из её документов,
    // а условия (заказчик, место поставки), вписанные владельцем или взятые из документов, сохраняем.
    const manual = isManual(tender);
    if (manual) conditions = repo.getDetails(tender.id)?.conditions || {};
    try {
      const doc = given || (!manual && source.getDetailsDoc ? await source.getDetailsDoc(tender) : null);
      if (doc) {
        // Площадки коммерческих закупок отдают позиции сразу в нашем формате ({items, conditions}).
        items = Array.isArray(doc.items) ? doc.items : tender.law === '44' ? itemsFrom44Notification(doc) : itemsFrom223Purchase(doc);
        if (doc.conditions) conditions = doc.conditions;
        else if (tender.law === '44') conditions = conditionsFrom44(doc);
        // Заказчик: организация, контактное лицо, место поставки — для письма заказчику и итоговой страницы.
        const customer = customerFromDoc(tender, doc);
        if (Object.keys(customer).length) conditions = { ...conditions, customer };
        // Площадка, где идёт закупка, названа в этом же документе — запоминаем заодно.
        if (!tender.platform) repo.setPlatform(tender.id, platformFromDoc(tender, doc));
      }
    } catch (err) {
      error = `Не удалось загрузить извещение: ${err.message}`;
    }
    // Источник не ответил, а позиции из извещения уже сохранены — оставляем их: у них есть коды КТРУ,
    // цены заказчика и характеристики, а из текста документации получится хуже.
    const saved = repo.getItems(tender.id);
    if (error && saved.length && repo.getDetails(tender.id)?.items_source === 'notification') {
      log.warn?.(`[items] закупка ${tender.number}: ${error} — оставляю позиции из извещения`);
      return saved;
    }
    if (!items.length) {
      const fromLlm = await itemsFromAnalysis(tender).catch((err) => {
        error = error || `Не удалось извлечь позиции из документации: ${err.message}`;
        return [];
      });
      if (fromLlm.length) { items = fromLlm; itemsSource = itemsOrigin.get(tender.id) === 'rules' ? 'rules' : 'llm'; }
      itemsOrigin.delete(tender.id);
    }
    // Из документов позиции прочитать не удалось, а они уже есть — оставляем: заглушка стёрла бы цены и поставщиков.
    if (manual && !items.length && saved.length && repo.getDetails(tender.id)?.items_source !== 'fallback') return saved;
    // Те же позиции, названные нейросетью чуть иначе, остаются прежними записями — с ценами и поставщиками.
    if (manual && items.length && saved.length) items = keepKnown(items, saved);
    if (!items.length) {
      // Совсем нет данных — одна позиция «предмет закупки», чтобы можно было посчитать вручную.
      items = [{ name: tender.title, ktru_code: tender.ktru?.[0] || null, okpd2_code: tender.okpd2?.[0] || null, characteristics: [],
        quantity: null, unit: null, unit_price: null, sum: tender.price, source: 'notification' }];
      itemsSource = 'fallback';
    }
    repo.saveItems(tender.id, items, { conditions, source: itemsSource, error });
    // Позиции из извещения — структурированные данные источника; из документов — со своим отчётом о полноте чтения;
    // «заглушка» (одна строка на всю закупку) помечается явно: это не список товаров.
    repo.setDetailsCoverage(tender.id, 'items', itemsSource === 'notification' ? null
      : { ...(itemsCoverage.get(tender.id) || { status: 'unknown' }), ...(itemsSource === 'fallback' ? { stub: true } : {}) });
    itemsCoverage.delete(tender.id);
    // Направление перепродажи — по составу: если товары направления меньше половины суммы, закупка не наша
    // (например, «канцтовары» с парой картриджей среди сорока позиций).
    const profile = repo.getProfile();
    if (directions.hasDirections(profile) && itemsSource !== 'fallback') {
      const dir = directions.tenderDirection(tender, profile, repo.getItems(tender.id));
      if (dir !== (tender.direction ?? null)) repo.setDirection(tender.id, dir);
    }
    if (profile.mode === 'resale' && itemsSource !== 'fallback') {
      const share = focusShare(repo.getItems(tender.id), profile);
      if (share != null && share < 0.5 && tender.status !== 'dismissed' && !manual) {
        repo.setFiltered(tender.id, `не из выбранного направления: товары направления — ${Math.round(share * 100)}% суммы закупки`, profile.version);
      }
    }
    // Источник мог не дать срок подачи, регион и коды (например, лента ЕИС) — берём их из извещения.
    if (!tender.deadline_at || tender.region == null || !tender.okpd2?.length) {
      repo.updateTenderBasics(tender.id, {
        deadline_at: conditions.deadline_at ?? null,
        customer_inn: conditions.customer_inn ?? null,
        region: conditions.region ?? regionFromInn(conditions.customer_inn),
        okpd2: [...new Set(items.map((i) => i.okpd2_code).filter(Boolean))],
        ktru: [...new Set(items.map((i) => i.ktru_code).filter(Boolean))],
      });
    }
    return repo.getItems(tender.id);
  }

  /**
   * Одна задача по всей документации закупки: фрагменты всех страниц всех прочитанных файлов — без отбора «первых
   * страниц» и без обрезки по длине. Принятые раньше результаты фрагментов не запрашиваются заново; что не поместилось
   * в бюджет прохода, остаётся в отчёте как «не отправлено» и дочитывается следующим проходом.
   * @returns {Promise<{records, coverage, usage, docs}>}
   */
  async function runDocTask(analysis, { task, system, schema, requiredKeys, wrap = (text) => text, salt = '', budget = Infinity, prioritize = false }) {
    const files = repo.getFilesFull(analysis.id);
    const docs = files.filter((f) => f.status === 'ok' && f.pages.length);
    let chunks = buildChunkQueue(docs, config.LLM_MAX_CHARS_PER_CHUNK);
    // Порядок — по важности для спецификации (ТЗ раньше проекта контракта): при нехватке бюджета первыми читаются
    // самые содержательные страницы. Это очерёдность, а не отбор: остальные фрагменты остаются в очереди.
    if (prioritize) {
      const score = (c) => Math.max(...c.ranges.map((r) => pageScore(r.file, docs.find((d) => d.id === r.fileId)?.pages.find((p) => p.page === r.page)?.text || '')));
      chunks = chunks.map((c, i) => ({ c, i, s: score(c) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.c);
    }
    const llm = llmFactory();
    const usage = { in: 0, out: 0 };
    const previous = new Map(repo.listChunks(analysis.id, task).filter((c) => c.status === 'ok' && c.result).map((c) => [c.cache_key, { result: c.result, model: c.model }]));
    const records = await runQueue({
      chunks, docs, task, budget,
      version: `${sha(system + salt).slice(0, 16)}:${llm.provider}/${llm.modelFor?.(task) || llm.model}`,
      cache: (key) => previous.get(key) || repo.cachedChunk(key),
      onUsage: (u) => { if (u) { usage.in += u.in || 0; usage.out += u.out || 0; } },
      callOne: (text) => callJson(llm, { system, user: wrap(text), schema, task, requiredKeys }),
    });
    repo.clearChunks(analysis.id, task);
    for (const c of records) repo.saveChunk(analysis.id, task, c);
    const pageLengths = new Map(docs.flatMap((d) => d.pages.filter((p) => p.text.trim()).map((p) => [`${d.id}:${p.page}`, p.text.length])));
    const full = analysisCoverage({ files, chunks: records, pageLengths });
    // компактный отчёт задачи: что отправлено и принято именно по ней + что не прочитано в самих файлах
    const coverage = {
      status: full.status, source_status: full.extract.status, summary: describe(full),
      chunks_built: full.send.chunks_built, chunks_accepted: full.accept.chunks_accepted, chunks_failed: full.accept.chunks_failed, chunks_skipped: full.send.chunks_skipped,
      blocking: full.blocking.slice(0, 40),
    };
    return { records, coverage, usage, docs };
  }

  const sameWords = (a, b) => {
    const words = (s) => new Set(String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 1));
    const x = words(a);
    const y = words(b);
    return [...x].filter((w) => y.has(w)).length / Math.max(1, Math.min(x.size, y.size));
  };

  // Отчёт о полноте извлечения позиций: строка условий закупки появляется позже (saveItems), отчёт ждёт её здесь.
  const itemsCoverage = new Map();
  const itemsOrigin = new Map(); // закупка → 'rules', если позиции прочитаны из таблиц по правилам

  /**
   * Позиции из таблиц документации — по правилам, без нейросети. Полнота — по полноте чтения самих файлов:
   * правила видят все строки таблиц, но только в прочитанных страницах.
   * @returns {{items: Array, coverage: object}}
   */
  function ruleItems(analysis) {
    const files = repo.getFilesFull(analysis.id);
    const docs = files.filter((f) => f.status === 'ok' && f.pages.length).map(withTabTables);
    const raw = itemsFromTables(docs);
    const picked = pickItems(raw.items);
    // таблицы позиций нет: один товар в листе характеристик или на карточке площадки — нейросеть не нужна
    if (!picked.items.length) picked.items = singleProduct(docs);
    const full = analysisCoverage({ files, chunks: [], pageLengths: new Map() });
    const sourceOk = full.download.status === 'complete' && full.extract.status === 'complete';
    // в другом файле список другой длины — состав стоит сверить глазами
    const mismatch = picked.alternatives.filter((x) => x.count !== picked.items.length);
    return {
      items: picked.items,
      coverage: {
        status: sourceOk ? 'complete' : full.extract.status === 'unknown' ? 'unknown' : 'partial', source_status: full.extract.status, method: 'rules',
        file: picked.file, tables: raw.tables, item_tables: raw.itemTables, alternatives: mismatch,
        blocking: [...full.blocking.filter((b) => b.kind !== 'chunk_failed' && b.kind !== 'budget').slice(0, 40)],
      },
    };
  }

  async function itemsFromAnalysis(tender) {
    if (!tender.analysis_id) return [];
    const a = repo.getAnalysis(tender.analysis_id);
    if (!a || a.status !== 'done') return [];
    // Сначала — читатель по правилам: таблица «наименование — количество» читается без нейросети, точно и бесплатно.
    const ruled = ruleItems(a);
    if (ruled.items.length) {
      itemsCoverage.set(tender.id, ruled.coverage);
      itemsOrigin.set(tender.id, 'rules');
      return ruled.items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit, characteristics: i.characteristics.slice(0, 40).map(({ name, value }) => ({ name, value })), ktru_code: null, okpd2_code: null, unit_price: null, sum: null, source: 'rules' }));
    }
    // Таблицы с позициями в документах нет (или она нестандартная) — читает нейросеть, по всей документации.
    const system = fs.readFileSync(path.join(__dirname, '..', 'analyze', 'prompts', 'items.md'), 'utf8');
    const { records, coverage } = await runDocTask(a, { task: 'items', system, schema: ItemsSchema, requiredKeys: ['items'], budget: config.ITEMS_MAX_CHUNKS });
    itemsCoverage.set(tender.id, coverage);
    const ok = records.filter((r) => r.status === 'ok');
    if (!ok.length && records.length) throw new Error(records.find((r) => r.error)?.error || 'нейросеть не ответила');
    // Одна и та же позиция встречается в нескольких фрагментах (извещение и ТЗ, перекрытие частей страницы):
    // совпали количество и название (или почти совпало название) — это она же; характеристики объединяются.
    const out = [];
    for (const r of ok) {
      for (const it of r.result.items || []) {
        const same = out.find((o) => (o.quantity ?? null) === (it.quantity ?? null) && sameWords(o.name, it.name) >= 0.8);
        if (!same) { out.push({ ...it, characteristics: [...(it.characteristics || [])] }); continue; }
        if (it.name.length > same.name.length && sameWords(same.name, it.name) === 1) same.name = it.name;
        if (!same.unit && it.unit) same.unit = it.unit;
        for (const c of it.characteristics || []) if (!same.characteristics.some((x) => x.name === c.name)) same.characteristics.push(c);
      }
    }
    return out.map((i) => ({ ...i, ktru_code: null, okpd2_code: null, unit_price: null, sum: null, source: 'llm' }));
  }

  /** Рыночный ориентир по коду (с кешем). */
  async function ensureBenchmark(code, { force = false } = {}) {
    if (!code) return null;
    if (!force) {
      const cached = repo.getBenchmark(code, config.BENCHMARK_CACHE_DAYS);
      if (cached) return cached;
    }
    try {
      const b = await fetchBenchmark(source, code, { maxContracts: config.BENCHMARK_MAX_CONTRACTS, declineSamples: config.BENCHMARK_DECLINE_SAMPLES });
      repo.saveBenchmark(code, b);
      return b;
    } catch (err) {
      log.warn?.(`[benchmark] ${code}: ${err.message}`);
      return { code, contracts: 0, unit_price: null, decline: null, suppliers: [], error: err.message };
    }
  }

  const itemCode = (i) => i.ktru_code || i.okpd2_code || null;

  /** Входы калькулятора с указанием источника каждого значения. */
  function buildInput(tender, items, benchmarks, overrides = {}) {
    const settings = settingsOf();
    const details = repo.getDetails(tender.id) || { conditions: {} };
    const card = tender.analysis_id ? repo.getAnalysis(tender.analysis_id)?.card : null;
    const sources = {};
    const pick = (key, candidates) => {
      for (const [value, src] of candidates) {
        if (value != null && Number.isFinite(Number(value))) { sources[key] = src; return Number(value); }
      }
      return undefined;
    };

    const inputItems = items.map((i) => {
      const bench = benchmarks[itemCode(i)];
      let price = null;
      let src = null;
      let warning = null;
      if (i.purchase_price_manual != null) { price = i.purchase_price_manual; src = SRC.manual; }
      else if (i.purchase_price_offer != null) {
        // Защита от ошибок в данных: цена предложения в разы меньше или больше цены заказчика — сервис сам её не берёт.
        // Но если предложение выбрали вы (проверили цену на сайте продавца), оно идёт в расчёт — с пометкой.
        const sane = priceLooksSane(i, i.purchase_price_offer);
        if (sane || i.purchase_selected_by === 'user') {
          price = i.purchase_price_offer;
          if (!sane) {
            const k = Math.round((i.unit_price / i.purchase_price_offer) * 10) / 10;
            warning = k >= 1
              ? `цена выбранного вами предложения в ${String(k).replace('.', ',')} раза ниже цены заказчика — гораздо ниже рыночной, проверьте её на сайте продавца`
              : 'цена выбранного вами предложения в разы выше цены заказчика — проверьте её на сайте продавца';
          }
          // Цена из прошлого госконтракта — ориентир, а не сегодняшнее предложение: в расчёт идёт, но прибыль
          // «подтверждённой» не делает. Подтверждение — предложение поставщика на тот же товар или ручная цена.
          const fromContract = i.purchase_offer_id != null && repo.getOffer(i.purchase_offer_id)?.source === 'contracts';
          src = fromContract
            ? `${SRC.contracts}: ${i.purchase_offer_label || 'поставщик'} продавал этот товар по госконтракту — уточните сегодняшнюю цену`
            : SRC.offer;
        }
        else src = `цена найденного предложения (${i.purchase_price_offer} ₽) слишком отличается от цены заказчика — проверьте предложение или введите цену вручную`;
      }
      else {
        // Этап 6b: из контрактов с тем же кодом — только строки с тем же товаром, что в ТЗ, в единице заказчика.
        const ib = itemBenchmark(i, bench);
        if (ib) {
          const p = ib.unit_price?.p25;
          if (p != null && saneRatio(i, p)) {
            price = p;
            src = `оценка — ${SRC.contracts}: по такой цене этот товар продавали заказчикам конкуренты (дешёвая четверть цен, ${ib.same} из ${ib.total} строк); ваша закупочная цена обычно ниже`;
          } else if (p != null) {
            src = 'цена того же товара в контрактах сильно отличается от цены заказчика — проверьте единицы или введите цену вручную';
          } else if (ib.same) {
            src = 'единицы в контрактах не пересчитываются в единицу заказчика — введите цену вручную';
          } else {
            src = `в прошлых контрактах под этим кодом другой товар (${ib.different} из ${ib.total}${ib.unknown ? `, не ясно: ${ib.unknown}` : ''}) — нужен поиск поставщиков по ТЗ`;
          }
        } else if (bench?.unit_price?.p25 != null) {
          if (benchmarkComparable(i, bench)) {
            price = bench.unit_price.p25;
            src = `${SRC.contracts} (25-й перцентиль из ${bench.contracts})`;
          } else {
            src = 'цены контрактов не сопоставимы с позицией (другие товары или единицы) — введите цену вручную';
          }
        }
      }
      return { id: i.id, name: i.name, quantity: i.quantity, unit_price: i.unit_price, purchase_price: price, purchase_source: src, ...(warning ? { purchase_warning: warning } : {}) };
    });
    // Закупка по цене единицы (ч. 24 ст. 22 44-ФЗ): количества нет, НМЦК — наибольшая сумма договора, товар берут по
    // заявкам. Для расчёта количество оцениваем: сколько раз набор позиций по ценам заказчика укладывается в НМЦК.
    const noQty = inputItems.filter((i) => !(i.quantity > 0));
    if (noQty.length && noQty.length === inputItems.length && inputItems.every((i) => i.unit_price > 0) && tender.price > 0) {
      const k = Math.max(1, Math.floor(tender.price / inputItems.reduce((s, i) => s + i.unit_price, 0) + 1e-6));
      for (const i of inputItems) {
        i.quantity = k;
        i.quantity_estimated = true;
        i.purchase_source = `${i.purchase_source ? `${i.purchase_source}; ` : ''}количество не указано (закупка по цене единицы) — в расчёте ≈${k} шт. по НМЦК`;
      }
    }

    // Меньше трёх торгов — слишком мало, чтобы судить о снижении: берём значение из профиля.
    // Снижение больше 50% — почти всегда рамочные контракты («по заявкам», цена за единицу), а не торги: не верим.
    const rawDecline = Object.values(benchmarks).find((b) => b?.decline?.samples >= 3)?.decline;
    // Коммерческая закупка (не 44/223-ФЗ): статистика снижения цены на госаукционах к ней не относится — берём профиль.
    const commercial = String(tender.law) === 'com';
    const benchDecline = !commercial && rawDecline && rawDecline.median <= MAX_TRUSTED_DECLINE ? rawDecline : null;
    const declineNote = commercial
      ? 'коммерческая закупка — статистика госаукционов к ней не применяется; уточните, как заказчик выбирает победителя'
      : rawDecline && !benchDecline
        ? `по контрактам выходит снижение ${Math.round(rawDecline.median * 100)}% (${rawDecline.samples} закупки) — похоже на рамочные контракты, взято значение из профиля`
        : null;
    const days = tender.deadline_at ? (new Date(tender.deadline_at) - clock()) / DAY_MS : null;
    const input = {
      nmck: tender.price,
      items: inputItems,
      decline_pct: pick('decline_pct', [
        [overrides.decline_pct, SRC.manual],
        [benchDecline ? Math.round(benchDecline.median * 1000) / 10 : null, `${SRC.contracts} (медиана по ${benchDecline?.samples} закупкам)`],
        [settings.expected_decline_pct, declineNote ? `${SRC.profile}: ${declineNote}` : SRC.profile],
      ]),
      logistics: overrides.logistics != null ? Number(overrides.logistics) : null,
      bid_security_pct: pick('bid_security_pct', [
        [overrides.bid_security_pct, SRC.manual], [pctFrom(cardField(card, 'bid_security')), SRC.card],
        [details.conditions.bid_security_pct, SRC.notification], [0, SRC.profile],
      ]),
      contract_security_pct: pick('contract_security_pct', [
        [overrides.contract_security_pct, SRC.manual], [pctFrom(cardField(card, 'contract_security')), SRC.card],
        [details.conditions.contract_security_pct, SRC.notification], [0, SRC.profile],
      ]),
      warranty_security_pct: pick('warranty_security_pct', [
        [overrides.warranty_security_pct, SRC.manual], [pctFrom(cardField(card, 'warranty_security')), SRC.card], [0, SRC.profile],
      ]),
      advance_pct: pick('advance_pct', [
        [overrides.advance_pct, SRC.manual],
        [/не\s+(предусмотр|установл)/i.test(cardField(card, 'advance') || '') ? 0 : pctFrom(cardField(card, 'advance')), SRC.card],
        [0, SRC.profile],
      ]),
      delivery_days: pick('delivery_days', [
        [overrides.delivery_days, SRC.manual], [daysFrom(cardField(card, 'delivery_term')), SRC.card], [settings.default_delivery_days, SRC.profile],
      ]),
      payment_days: pick('payment_days', [
        [overrides.payment_days, SRC.manual], [daysFrom(cardField(card, 'payment_terms')), SRC.card], [settings.default_payment_days, SRC.profile],
      ]),
      days_to_deadline: days == null ? null : Math.floor(days * 10) / 10,
      settings,
      sources,
    };
    // Заказчик не назвал цену (запрос цен) — считаем от цены, которую предложим сами. Её назначаем мы, снижения на торгах нет.
    if (!tender.price && Number(overrides.price) > 0) {
      input.nmck = Number(overrides.price);
      input.own_price = true;
      sources.price = 'ваша цена предложения — заказчик свою не назвал';
      if (overrides.decline_pct == null) { input.decline_pct = 0; sources.decline_pct = 'цену назначаете вы — снижения на торгах нет'; }
    }
    // Заказчик цену назвал, но мы решили, за сколько подадим предложение сами: выручка — наша цена. Это то же самое,
    // что снижение на торгах, только записанное рублями, поэтому расчёт дальше идёт прежним путём — через снижение.
    // Цена выше цены заказчика невозможна (маршрут её не принимает); на случай старых данных — не учитываем.
    if (tender.price > 0 && Number(overrides.price) > 0 && Number(overrides.price) <= tender.price) {
      input.decline_pct = (1 - Number(overrides.price) / tender.price) * 100;
      input.own_bid = true;
      sources.price = 'ваша цена предложения';
      sources.decline_pct = 'из вашей цены предложения';
    }
    if (input.logistics != null) sources.logistics = SRC.manual;
    else if (items.some((i) => i.purchase_offer_delivery != null && i.purchase_price_manual == null)) {
      // Доставка из выбранных предложений + доля по умолчанию для позиций без них. Несколько позиций от одного
      // продавца — одна отправка: берём самую дорогую доставку среди его позиций, а не сумму (иначе 15 картриджей
      // из одного магазина «едут» пятнадцатью посылками по минимальному тарифу).
      // Позиция может быть набрана у нескольких продавцов (набор партии) — тогда отправка от каждого из них.
      let total = 0;
      const bySeller = new Map();
      const allocations = repo.getAllocations ? repo.getAllocations(tender.id) : [];
      const sellerOf = (offerId) => { const o = repo.getOffer(offerId); return o ? [o.seller_name, o.domain].filter(Boolean).join(', ') || `offer-${offerId}` : `offer-${offerId}`; };
      for (const i of items) {
        const ii = inputItems.find((x) => x.id === i.id);
        const parts = allocations.filter((a) => a.item_id === i.id && a.delivery_cost != null);
        if (i.purchase_offer_delivery != null && i.purchase_price_manual == null && parts.length > 1) {
          for (const a of parts) { const seller = sellerOf(a.offer_id); bySeller.set(seller, Math.max(bySeller.get(seller) || 0, a.delivery_cost)); }
        } else if (i.purchase_offer_delivery != null && i.purchase_price_manual == null) {
          const seller = i.purchase_offer_label || `offer-${i.purchase_offer_id}`;
          bySeller.set(seller, Math.max(bySeller.get(seller) || 0, i.purchase_offer_delivery));
        } else if (ii?.purchase_price != null && i.quantity) total += ii.purchase_price * i.quantity * (settings.logistics_pct / 100);
      }
      for (const cost of bySeller.values()) total += cost;
      input.logistics = Math.round(total * 100) / 100;
      sources.logistics = `${SRC.offer}: доставка выбранных предложений${bySeller.size ? ` (отправок от продавцов: ${bySeller.size})` : ''}`;
    } else {
      // Перепродажа: пока поставщик не найден, доставку оцениваем от ближайшего крупного узла поставок.
      const goodsCost = inputItems.reduce((sum, i) => sum + (i.purchase_price != null && i.quantity ? i.purchase_price * i.quantity : 0), 0);
      const hub = repo.getProfile().mode === 'resale' && goodsCost > 0
        ? hubDelivery({ region: tender.region, goodsCost, settings, hubs: config.RESALE_HUBS, deliveryTermDays: input.delivery_days })
        : null;
      if (hub) {
        input.logistics = hub.cost;
        sources.logistics = `оценка: доставка от узла ${hub.hub}${hub.km ? ` (≈${hub.km} км)` : ' (тот же регион)'} — поставщик ещё не найден`;
      } else sources.logistics = `${settings.logistics_pct}% от закупки — ${SRC.profile}`;
    }
    return input;
  }

  /** Считает и сохраняет выгодность. overrides — ручные значения калькулятора (сохраняются). */
  async function computeEconomics(tenderId, { overrides, fetch = true } = {}) {
    const tender = repo.getTender(tenderId);
    if (!tender) throw new Error('Закупка не найдена');
    const items = fetch ? await ensureItems(tender) : repo.getItems(tender.id);
    const benchmarks = {};
    for (const code of [...new Set(items.map(itemCode).filter(Boolean))]) {
      benchmarks[code] = fetch ? await ensureBenchmark(code) : repo.getBenchmark(code);
    }
    const saved = repo.getEconomics(tender.id)?.overrides || {};
    const ov = overrides ? { ...saved, ...overrides } : saved;
    for (const k of Object.keys(ov)) if (ov[k] === '' || ov[k] == null) delete ov[k];
    const input = buildInput(tender, items, benchmarks, ov);
    const result = calculate(input);
    const gaps = specGaps(tender.id, items);
    if (gaps.length) { result.preliminary = true; result.spec_gaps = gaps; }
    const rank = opportunityOf(tender, items, benchmarks, input, result);
    // неполная спецификация — расчёт не «подтверждён», даже если цены всех известных позиций найдены
    repo.saveEconomics(tender.id, { overrides: ov, result, ...rank, confirmed: rank.confirmed && !gaps.length });
    return { tender, items, benchmarks, economics: { ...repo.getEconomics(tender.id), price_variants: priceVariants(input, result) } };
  }

  /**
   * Чего не хватает спецификации, чтобы расчёт был расчётом всей закупки, а не её известной части.
   * @returns {string[]} пусто — пробелов нет (или закупка разобрана прежней версией и отчёта о полноте нет)
   */
  function specGaps(tenderId, items) {
    const d = repo.getDetails(tenderId);
    if (!d) return [];
    const out = [];
    if (d.items_source === 'fallback') out.push('список товаров не установлен: вся закупка считается одной общей строкой');
    else if (d.items_coverage && d.items_coverage.status !== 'complete') out.push('список товаров прочитан из документов не полностью — позиций может быть больше');
    const sc = d.spec_coverage;
    if (sc && sc.status === 'unknown') out.push('полнота чтения документов неизвестна: они разобраны прежней версией сервиса');
    else if (sc && sc.status !== 'complete') out.push('требования ТЗ прочитаны не полностью');
    if (sc?.reconcile && !sc.reconcile.ok) {
      const r = sc.reconcile;
      if (r.unmatched_items.length) out.push(`в ТЗ не найдены позиции закупки: ${r.unmatched_items.length} из ${r.items}`);
      if (r.unmatched_tz.length) out.push(`в ТЗ есть позиции, которых нет в закупке: ${r.unmatched_tz.length}`);
      if (r.quantity_conflicts.length) out.push(`количество в извещении и ТЗ расходится: позиций — ${r.quantity_conflicts.length}`);
    }
    const noQty = items.filter((i) => i.quantity == null).length;
    if (noQty && d.items_source !== 'fallback') out.push(`не установлено количество: позиций — ${noQty} из ${items.length}`);
    return out;
  }

  /** Сохранённый расчёт вместе с вариантами «при другой цене» — для карточки закупки. Сам расчёт не пересчитывается. */
  function withVariants(tender, items, benchmarks, econ) {
    if (!econ?.result) return econ;
    try {
      return { ...econ, price_variants: priceVariants(buildInput(tender, items, benchmarks, econ.overrides || {}), econ.result) };
    } catch (err) {
      log.warn?.(`[economics] варианты цены, закупка ${tender.id}: ${err.message}`);
      return econ;
    }
  }

  /** Ранг возможности и «подтверждено ли поставщиками» — для сортировки ленты и автопоиска. */
  function opportunityOf(tender, items, benchmarks, input, result) {
    const confirmed = input.items.length > 0 && input.items.every((i) => i.purchase_source === SRC.offer || i.purchase_source === SRC.manual);
    const parts = items.map((i) => {
      const ii = input.items.find((x) => x.id === i.id);
      const weight = i.sum ?? (i.unit_price != null && i.quantity ? i.unit_price * i.quantity : 1);
      const fromContracts = String(ii?.purchase_source || '').includes(SRC.contracts);
      // Уверенность — по числу контрактов именно с тем же товаром, а не со всем кодом.
      const ib = fromContracts ? itemBenchmark(i, benchmarks[itemCode(i)]) : null;
      return { weight, contracts: fromContracts ? (ib ? ib.contracts : benchmarks[itemCode(i)]?.contracts || 0) : 0 };
    });
    const confidence = confirmed ? 1 : confidenceOf(parts);
    const opportunity = opportunityRank({ marginPct: result.result?.margin_pct ?? null, confidence, score: tender.score, confirmed });
    return { opportunity, confirmed };
  }

  // Цены прошлых контрактов грузятся долго (десятки запросов к API с лимитами), поэтому — в фоне,
  // по одной закупке за раз. Карточка открывается сразу, а после загрузки расчёт обновляется.
  const pendingBenchmarks = new Map(); // tenderId → Promise
  let benchmarkQueue = Promise.resolve();

  function loadBenchmarksInBackground(tender, codes) {
    if (pendingBenchmarks.has(tender.id)) return pendingBenchmarks.get(tender.id);
    const job = benchmarkQueue.then(async () => {
      for (const code of codes) await ensureBenchmark(code);
      await computeEconomics(tender.id, { fetch: false });
    }).catch((err) => log.warn?.(`[benchmark] закупка ${tender.number}: ${err.message}`))
      .finally(() => pendingBenchmarks.delete(tender.id));
    benchmarkQueue = job;
    pendingBenchmarks.set(tender.id, job);
    return job;
  }

  /**
   * За сколько такую закупку целиком продавали заказчикам конкуренты: по прошлым контрактам с тем же товаром,
   * что в ТЗ. low — по дешёвой четверти цен, mid — по середине. Считается, только если цены есть по всем позициям.
   * Это ориентир для своей цены предложения, а не закупочная цена: в ней уже сидит наценка победителя.
   */
  function competitorTotal(items, itemBenchmarks) {
    let low = 0;
    let mid = 0;
    let contracts = 0;
    let covered = 0;
    for (const i of items) {
      const u = itemBenchmarks[i.id]?.unit_price;
      if (!u || !(i.quantity > 0)) continue;
      covered++;
      low += u.p25 * i.quantity;
      mid += u.median * i.quantity;
      contracts += itemBenchmarks[i.id].contracts || 0;
    }
    if (!covered) return null;
    const r = (x) => Math.round(x * 100) / 100;
    return { covered, of: items.length, complete: covered === items.length, low: r(low), mid: r(mid), contracts };
  }

  /** Всё для карточки закупки: позиции загружаются сразу (один запрос), цены контрактов — в фоне. */
  // «Документ не найден»: закупка из ленты ЕИС свежее, чем данные ГосПлана, — извещение появится там позже
  const NOTICE_MISSING = /\b404\b|не найден/i;

  /**
   * Извещение раньше не нашлось в источнике — спросить снова (не чаще NOTICE_RETRY_MINUTES). Нашлось: если по закупке
   * ещё ничего не выбрано — позиции из извещения (с кодами, ценами и характеристиками) вместо прочитанных из ТЗ; если
   * уже есть предложения или свои цены — позиции не трогаем, берём только условия: срок подачи, обеспечения, заказчика.
   * @returns {Promise<boolean>} извещение получено
   */
  async function retryNotice(tender, { force = false } = {}) {
    if (!tender || isManual(tender) || !source.getDetailsDoc) return false;
    const d = repo.getDetails(tender.id);
    if (!d || !NOTICE_MISSING.test(d.error || '')) return false;
    if (!force && clock() - new Date(d.fetched_at) < (config.NOTICE_RETRY_MINUTES ?? 60) * 60000) return false;
    let doc = null;
    try { doc = await source.getDetailsDoc(tender); }
    catch (err) { repo.touchDetails(tender.id, `Не удалось загрузить извещение: ${err.message}`); return false; }
    if (!doc) { repo.touchDetails(tender.id, d.error); return false; }
    const busy = repo.getOffers(tender.id).length > 0 || repo.getItems(tender.id).some((i) => i.purchase_price_manual != null || i.purchase_offer_id);
    if (!busy) {
      await ensureItems(tender, { force: true, doc });
      log.log?.(`[items] закупка ${tender.number}: извещение появилось в источнике — позиции и условия из него`);
      return true;
    }
    let conditions = doc.conditions || (tender.law === '44' ? conditionsFrom44(doc) : {});
    const customer = customerFromDoc(tender, doc);
    if (Object.keys(customer).length) conditions = { ...conditions, customer };
    repo.mergeConditions(tender.id, conditions);
    repo.touchDetails(tender.id, null);
    if (!tender.platform) repo.setPlatform(tender.id, platformFromDoc(tender, doc));
    repo.updateTenderBasics(tender.id, { deadline_at: conditions.deadline_at ?? null, customer_inn: conditions.customer_inn ?? null,
      region: conditions.region ?? regionFromInn(conditions.customer_inn), okpd2: [], ktru: [] });
    log.log?.(`[items] закупка ${tender.number}: извещение появилось в источнике — условия из него, позиции с предложениями не тронуты`);
    return true;
  }

  const pendingNotices = new Set();
  async function getCard(tenderId) {
    let tender = repo.getTender(tenderId);
    if (!tender) return null;
    // открыли закупку, у которой раньше не нашлось извещения, — спрашиваем снова в фоне (тестовый ГосПлан отвечает
    // до полуминуты): карточка открывается сразу, а когда извещение придёт, страница обновится сама (notice_pending)
    if (!pendingNotices.has(tenderId)) {
      pendingNotices.add(tenderId);
      retryNotice(tender).then((ok) => (ok ? computeEconomics(tenderId, { fetch: false }) : null)).catch(() => null).finally(() => pendingNotices.delete(tenderId));
    }
    const items = await ensureItems(tender);
    const codes = [...new Set(items.map(itemCode).filter(Boolean))];
    const benchmarks = {};
    const missing = [];
    for (const code of codes) {
      const b = repo.getBenchmark(code, config.BENCHMARK_CACHE_DAYS);
      if (b) benchmarks[code] = b; else missing.push(code);
    }
    if (missing.length) loadBenchmarksInBackground(tender, missing);
    // Расчёта ещё нет или он в старом виде (без расходов и подсказки цены предложения) — считаем заново, это быстро.
    const saved = repo.getEconomics(tender.id);
    if (!saved || !saved.result || !('costs' in saved.result)) await computeEconomics(tender.id, { fetch: false });
    // Позиции с объединёнными требованиями (ТЗ + характеристики извещения) — их и показывает карточка.
    const current = repo.getItems(tender.id).map((i) => ({ ...i, spec: i.spec ? { ...specOf(i), from: i.spec.from || 'tz' } : null }));
    // По каждой позиции: сколько строк прошлых контрактов — тот же товар, что в ТЗ, а сколько — другой.
    const itemBenchmarks = {};
    for (const i of current) {
      const ib = itemBenchmark(i, benchmarks[itemCode(i)]);
      if (ib) itemBenchmarks[i.id] = { total: ib.total, same: ib.same, different: ib.different, unknown: ib.unknown, contracts: ib.contracts, unit_price: ib.unit_price };
    }
    return {
      tender, items: current, benchmarks, item_benchmarks: itemBenchmarks, economics: withVariants(tender, current, benchmarks, repo.getEconomics(tender.id)), details: repo.getDetails(tender.id),
      competitor_price: competitorTotal(current, itemBenchmarks),
      notice_pending: pendingNotices.has(tender.id), benchmark_pending: pendingBenchmarks.has(tender.id), benchmark_missing: missing,
    };
  }

  /** Фоновый расчёт для лучших закупок после синхронизации (по одной, чтобы не упираться в лимиты API). */
  async function precompute({ limit }) {
    const profile = repo.getProfile();
    const list = repo.tendersWithoutEconomics({ threshold: profile.score_threshold, limit, nowIso: clock().toISOString() });
    let done = 0;
    for (const t of list) {
      // Через ту же очередь, что и карточки: запросы к API не идут параллельно.
      const job = benchmarkQueue.then(() => computeEconomics(t.id)).then(() => { done++; }, (err) => {
        log.warn?.(`[economics] закупка ${t.number}: ${err.message}`);
      });
      benchmarkQueue = job;
      await job;
    }
    if (list.length) log.log?.(`[economics] посчитана выгодность: ${done} из ${list.length}`);
    return done;
  }

  // ---------- этап 6b: спецификация из ТЗ ----------
  // Файлы ТЗ в ЕИС: «Техническое задание», «Описание объекта закупки» / «описание ОЗ», «Спецификация».
  const TZ_FILE = /(^|[^а-яё])(тз|т\.з\.)([^а-яё]|$)|техническ\S*\s+задан|описани\S*\s+(объекта|оз)|спецификац/i;
  const NOT_TZ_FILE = /обосновани|нмцк|требовани\S*\s+к\s+(заявк|содержани|участник)|инструкци|проект\S*\s+контракт|запрос|разъяснени/i;
  const TZ_PAGE = /техническое задание|описание объекта закупки|спецификаци|наименование товара|характеристик/i;

  /**
   * Текст для спецификации: страницы, где скорее всего ТЗ (по имени файла и тексту страницы), — в пределах лимита символов.
   * В большом «Извещении и документации» на 70 страниц ТЗ обычно в середине — берём именно эти страницы.
   */
  /**
   * К какой позиции извещения относится позиция из ТЗ: модель (с кириллическими двойниками «СЕ743А» = «CE743A») решает,
   * дальше — количество, номер и наименование. Разные модели — точно разные позиции.
   */
  /**
   * Насколько позиция ТЗ похожа на позицию извещения. Когда у всех позиций одно название («Картридж для
   * электрографических печатающих устройств»), решают характеристики: цвет, ресурс, совместимость. Совпадение
   * значения — плюс, расхождение («черный» против «голубой», 25000 против 13000) — сильный минус.
   */
  function specItemScore(s, i) {
    const { normLook } = require('../offers/spec');
    const { modelOf } = require('../offers/sources/yandex-search');
    const key = (m) => (m && !/^(undefined|null)$/i.test(String(m)) ? normLook(m).replace(/[\s\-_./]+/g, '') : null);
    const sm = key(s.identity?.model);
    const stems = new Set(nameStems(s.name));
    const im = key(i.characteristics?.find((c) => /модел|артикул/i.test(c.name))?.value || modelOf(i));
    let score = 0;
    if (sm && im) score += sm === im ? 100 : -100;
    // модель из ТЗ названа в характеристике извещения («Совместимость с устройствами: Kyocera Ecosys PA5500x»)
    else if (sm && (i.characteristics || []).some((c) => key(c.value)?.includes(sm))) score += 40;
    if (s.quantity != null && i.quantity != null && Number(s.quantity) === Number(i.quantity)) score += 20;
    if (s.idx != null && s.idx === i.idx) score += 10;
    if (nameStems(i.name).some((x) => stems.has(x))) score += 5;
    const norm = (v) => String(v ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
    const num = (v) => { const m = /(\d[\d\s]*(?:[.,]\d+)?)/.exec(String(v ?? '')); return m ? Number(m[1].replace(/\s/g, '').replace(',', '.')) : null; };
    for (const r of s.required || []) {
      const c = (i.characteristics || []).find((x) => norm(x.name) === norm(r.name));
      if (!c) continue;
      const a = num(r.value); const b = num(c.value);
      const agree = a != null && b != null ? a === b : norm(r.value).includes(norm(c.value)) || norm(c.value).includes(norm(r.value));
      score += agree ? 15 : -40;
    }
    return score;
  }

  function matchSpecToItem(s, items, used) {
    let best = null;
    for (const i of items) {
      if (used.has(i.id)) continue;
      const score = specItemScore(s, i);
      if (score > 0 && (!best || score > best.score)) best = { item: i, score };
    }
    return best?.item || null;
  }

  /**
   * Узнать площадку закупки, если она ещё не известна. Подробности не загружены — загружаем их целиком (площадка
   * запишется по пути); загружены раньше, чем площадка стала храниться, — запрашиваем документ только ради неё.
   * @returns {Promise<boolean>} удалось ли узнать
   */
  /**
   * Сведения о заказчике (организация, контактное лицо, место поставки). У закупок, чьи условия сохранены раньше,
   * их нет — тогда один раз спрашиваем источник и дописываем в условия, не трогая позиции и расчёт.
   * @returns {Promise<object>} пусто — узнать не удалось
   */
  async function ensureCustomer(tender) {
    const d = repo.getDetails(tender.id);
    if (d?.conditions?.customer) return d.conditions.customer;
    if (!d || !source.getDetailsDoc || isManual(tender)) return {};
    let customer = {};
    try {
      customer = customerFromDoc(tender, await source.getDetailsDoc(tender));
    } catch (err) {
      log.warn?.(`[customer] закупка ${tender.number}: ${err.message}`);
      return {};
    }
    // Пустой ответ тоже запоминаем: источник сведений не дал, спрашивать его при каждом открытии незачем.
    repo.mergeConditions(tender.id, { customer });
    return customer;
  }

  async function ensurePlatform(tender) {
    if (tender.platform) return true;
    if (!repo.getDetails(tender.id)) {
      await ensureItems(tender);
      return Boolean(repo.getTender(tender.id)?.platform);
    }
    if (!source.getDetailsDoc || isManual(tender)) return false;
    let doc = null;
    try {
      doc = await source.getDetailsDoc(tender);
    } catch (err) {
      // «Не найдено» — не сбой источника: этой закупки в нём (пока) нет. Откладываем её и идём к следующим,
      // иначе несколько таких закупок в начале очереди не дают узнать площадки у всех остальных.
      if (err.status !== 404) throw err;
    }
    if (!doc) { repo.markPlatformChecked(tender.id); return false; }
    const platform = doc ? platformFromDoc(tender, doc) : null;
    if (platform) repo.setPlatform(tender.id, platform);
    return Boolean(platform);
  }

  /**
   * Прочитать ТЗ из готового разбора документации и сохранить спецификацию к позициям.
   * @returns {Promise<{status, matched, total, usage}|null>} null — разбора нет или он не готов
   */
  const specInFlight = new Map(); // tenderId → Promise: одно ТЗ не читаем дважды одновременно
  function ensureSpec(tender, opts = {}) {
    if (specInFlight.has(tender.id)) return specInFlight.get(tender.id);
    const p = readSpec(tender, opts).finally(() => specInFlight.delete(tender.id));
    specInFlight.set(tender.id, p);
    return p;
  }

  /**
   * Требования ТЗ по правилам: позиции из таблицы документов сопоставляются с позициями закупки (то же количество,
   * похожее название или тот же порядок). Годится, только когда КАЖДОЙ позиции закупки нашлась строка таблицы с
   * характеристиками; иначе null — и ТЗ читает нейросеть.
   * @returns {{records, coverage, usage, docs, rules: true}|null}
   */
  function ruleSpecs(analysis, items, { stub = false } = {}) {
    const ruled = ruleItems(analysis);
    const table = ruled.items.filter((x) => x.characteristics.length);
    const docsOf = () => repo.getFilesFull(analysis.id).filter((f) => f.status === 'ok' && f.pages.length);
    const result = (list) => ({ rules: true, usage: { in: 0, out: 0 }, docs: docsOf(), coverage: { ...ruled.coverage, chunks_built: 0, chunks_accepted: 0, chunks_failed: 0, chunks_skipped: 0 }, records: [{ status: 'ok', result: { items: list } }] });
    // У закупки вместо позиций — заглушка (одна строка на всю закупку): сопоставлять не с чем, берём список из таблицы
    // целиком — но только если характеристики есть у каждой её строки, иначе часть товаров осталась бы без требований.
    if (stub) return table.length && table.length === ruled.items.length ? result(table.map((x) => ({ idx: null, ...specFromRule(x) }))) : null;
    if (!table.length || table.length < items.length) return null;
    const used = new Set();
    const out = [];
    for (const it of items) {
      const same = table.map((x, i) => ({ x, i })).filter(({ x, i }) => !used.has(i) && (it.quantity == null || Number(x.quantity) === Number(it.quantity)));
      const best = same.sort((p, q) => sameWords(q.x.name, it.name) - sameWords(p.x.name, it.name) || p.i - q.i)[0];
      // одно количество у нескольких строк и названия не похожи — правила не гадают, кто есть кто
      if (!best || (same.length > 1 && sameWords(best.x.name, it.name) < 0.5 && !sameOrder(items, table))) return null;
      used.add(best.i);
      out.push({ idx: it.idx, ...specFromRule(best.x) });
    }
    return result(out);
  }
  /** Позиции закупки и строки таблицы идут в одном порядке с теми же количествами — сопоставление по порядку надёжно. */
  const sameOrder = (items, table) => items.length === table.length && items.every((it, i) => it.quantity == null || Number(table[i].quantity) === Number(it.quantity));
  /** Строка таблицы → позиция спецификации: характеристики с условием и единицей, признаки товара, источник. */
  function specFromRule(x) {
    const pick = (re) => x.characteristics.find((c) => re.test(c.name))?.value || null;
    const text = `${x.name} ${x.characteristics.map((c) => `${c.name} ${c.value}`).join(' ')}`;
    const pack = x.characteristics.find((c) => /в (упаковке|пачке|коробке)/i.test(c.name) && /\d/.test(c.value));
    const SERVICE = /^(модель|артикул|парт\S*\s*номер|производитель|товарный знак|бренд|марка|страна происхождения)$/i;
    return {
      name: x.name, quantity: x.quantity, unit: x.unit, pack_qty: pack ? Number((pack.value.match(/\d+/) || [])[0]) || null : null,
      equivalent_allowed: /эквивалент/i.test(text) ? true : null,
      identity: { model: pick(/^(модель|артикул|парт\S*\s*номер)/i), brand: pick(/^(производитель|товарный знак|бренд|марка)/i), compatible_with: pick(/совместим/i), standard: pick(/^(гост|ту)(?![а-яё])/i) },
      required: x.characteristics.filter((c) => !SERVICE.test(c.name.trim())).slice(0, 40).map((c) => ({
        // «> 65 и ≤ 70» — две границы сразу: это диапазон, а не только верхний предел
        name: c.name, value: c.value, unit: null, comparator: /(>|≥|не менее|от\s*\d)/i.test(c.value) && /(<|≤|не более|до\s*\d)/i.test(c.value) ? 'range' : comparatorOf(c.value), quote: c.quote || `${c.name} ${c.value}`, file: x.source.file, page: c.page ?? x.source.page,
      })),
    };
  }

  /** Насколько страница похожа на техническое задание — для очерёдности чтения (не для отбора). */
  function pageScore(fname, text) {
    const fileScore = (TZ_FILE.test(fname) ? 5 : 0) - (NOT_TZ_FILE.test(fname) ? 4 : 0);
    const numbersWithUnits = (text.match(/\d\s*(шт|г\/м|мм|см|кг|л\b|мл|гб|мгц|ггц|вт|%)/gi) || []).length;
    return fileScore + (TZ_PAGE.test(text) ? 3 : 0) + Math.min(3, Math.floor(numbersWithUnits / 5));
  }

  /** Позиции ТЗ из разных фрагментов сводятся в одну: по номеру из извещения, по модели или по названию с количеством. */
  function mergeSpecs(list) {
    const { normLook } = require('../offers/spec');
    const modelKey = (s) => (s.identity?.model ? normLook(s.identity.model).replace(/[\s\-_./]+/g, '') : null);
    const out = [];
    for (const s of list) {
      // разные модели — точно разные позиции, даже если нейросеть приписала им один номер из извещения
      // одинаковое название, но у одной характеристики разные значения («Цвет печати: черный» и «голубой») — тоже разные
      // позиции: раньше три картриджа разного цвета склеивались в один с тремя цветами сразу
      const valueKey = (v) => String(v ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
      // «не менее 25000» и «≥ 25000» — одно значение: числа сравниваем как числа
      const nums = (v) => (String(v ?? '').replace(/(\d)\s(?=\d{3}(?!\d))/g, '$1').match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', '.')).join('|');
      const differs = (a, b) => (nums(a) || nums(b) ? nums(a) !== nums(b) : valueKey(a) !== valueKey(b));
      const clash = (o) => s.required.some((r) => o.required.some((x) => valueKey(x.name) === valueKey(r.name) && differs(x.value, r.value)));
      const differ = (o) => (modelKey(s) && modelKey(o) && modelKey(o) !== modelKey(s)) || clash(o);
      const same = out.find((o) => !differ(o) && ((modelKey(s) && modelKey(o) === modelKey(s))
        || (s.idx != null && o.idx === s.idx && sameWords(o.name, s.name) >= 0.8)
        || (s.idx == null && o.idx == null && (o.quantity ?? null) === (s.quantity ?? null) && sameWords(o.name, s.name) >= 0.8)));
      if (!same) { out.push({ ...s, identity: { ...s.identity }, required: [...s.required] }); continue; }
      // количество в двух местах разное — не выбираем молча меньшее или первое: запоминаем расхождение
      if (s.quantity != null && same.quantity != null && Number(s.quantity) !== Number(same.quantity)) same.quantity_conflict = [...new Set([...(same.quantity_conflict || [same.quantity]), s.quantity])];
      if (same.quantity == null) same.quantity = s.quantity;
      if (!same.unit) same.unit = s.unit;
      if (same.pack_qty == null) same.pack_qty = s.pack_qty;
      if (same.equivalent_allowed == null) same.equivalent_allowed = s.equivalent_allowed;
      for (const k of ['model', 'brand', 'compatible_with', 'standard']) if (!same.identity[k] && s.identity?.[k]) same.identity[k] = s.identity[k];
      for (const r of s.required) if (!same.required.some((x) => x.name === r.name && x.value === r.value)) same.required.push(r);
    }
    return out;
  }

  async function readSpec(tender, { force = false } = {}) {
    const d = repo.getDetails(tender.id);
    if (!force && d?.spec_status === 'done') return { status: 'done', cached: true };
    const a = tender.analysis_id ? repo.getAnalysis(tender.analysis_id) : null;
    if (!a || a.status !== 'done') return null;
    const items = await ensureItems(tender);
    const system = fs.readFileSync(path.join(__dirname, '..', 'analyze', 'prompts', 'spec.md'), 'utf8');
    const positions = items.map((i) => ({ idx: i.idx, name: i.name, quantity: i.quantity, unit: i.unit }));
    // Читатель по правилам: в таблице документов у каждой позиции закупки есть свои характеристики — берём их оттуда.
    const byRules = ruleSpecs(a, items, { stub: d?.items_source === 'fallback' });
    // ТЗ само отсылает к извещению («характеристики … содержатся в извещении, сформированном в структурированном
    // виде») — тогда ТЗ и есть характеристики извещения: при их наличии чтение полное, нейросеть не нужна
    // (обучение 30.10: 69 из 109 «непрочитанных» ТЗ были такими)
    if (!byRules && items.some((i) => (i.characteristics || []).length)) {
      const text = repo.getFilesFull(a.id).filter((f) => f.status === 'ok').map((f) => f.pages.map((p) => p.text).join(' ')).join(' ');
      if (/(?:содерж|указан)\S*[^.]{0,200}(?:в извещении|структурированн\S* вид|с использованием единой информационной системы)/i.test(text)) {
        repo.setDetailsCoverage(tender.id, 'spec', { status: 'complete', source: 'notice', note: 'ТЗ отсылает к извещению — характеристики взяты из структурированного извещения ЕИС' });
        repo.setSpecStatus(tender.id, 'done', 'характеристики — в извещении ЕИС (ТЗ ссылается на него)');
        return { status: 'done', notice: true };
      }
    }
    let run;
    try {
      if (byRules) run = byRules; else
      run = await runDocTask(a, {
        task: 'spec', system, schema: SpecSchema, requiredKeys: ['items'], budget: config.SPEC_MAX_CHUNKS, prioritize: true,
        salt: JSON.stringify(positions), // позиции изменились — прежние ответы не годятся
        wrap: (text) => JSON.stringify({ positions, documents: text }),
      });
    } catch (err) {
      repo.setSpecStatus(tender.id, 'error', err.message.slice(0, 300));
      return { status: 'error', error: err.message };
    }
    const { records, coverage, usage, docs } = run;
    if (!records.length) { repo.setSpecStatus(tender.id, 'no_docs', 'в документации нет текста'); return { status: 'no_docs' }; }
    const accepted = records.filter((r) => r.status === 'ok');
    if (!accepted.length) {
      const why = records.find((r) => r.error)?.error || 'нейросеть не ответила';
      // Нейросеть не прочитала ТЗ ни по одному фрагменту (нет оплаты, сбой), а у позиций есть характеристики из извещения
      // (для 44-ФЗ — официальные, по каталогу КТРУ): сверка идёт по ним. Отметка «прочитано 0 из 7» блокировала любое
      // «соответствует» (аудит 29.10, шпатели 6 из 6 — «частично»); теперь это отдельный статус, а не «неполное чтение».
      const noticeChars = items.some((i) => (i.characteristics || []).length);
      repo.setDetailsCoverage(tender.id, 'spec', noticeChars
        ? { ...coverage, status: 'notice_only', note: `ТЗ не прочитано (${why.slice(0, 80)}) — товар сверяется по характеристикам извещения` }
        : coverage);
      repo.setSpecStatus(tender.id, 'error', why.slice(0, 300));
      return { status: 'error', error: why };
    }
    // цитата требования проверяется в названном файле; найдена только в другом — источник не подтверждён
    const pagesOf = (file) => {
      const doc = docs.find((x) => x.name === file) || docs.find((x) => x.name.endsWith(String(file || '\u0000')));
      return doc ? doc.pages.map((p) => ({ file: doc.name, page: p.page, text: p.text })) : [];
    };
    const specs = mergeSpecs(accepted.flatMap((r) => r.result.items || []).map((s) => ({
      ...s,
      required: s.required.map((r) => {
        const own = pagesOf(r.file);
        const pg = r.quote ? own.find((p) => p.page === Number(r.page) && quoteInText(r.quote, p.text)) || own.find((p) => quoteInText(r.quote, p.text)) : null;
        return {
          name: r.name, value: r.value, unit: r.unit || unitOfValue(r.value), comparator: r.comparator || comparatorOf(r.value),
          source: r.quote ? { file: pg?.file ?? r.file, page: pg?.page ?? r.page, quote: r.quote, verified: Boolean(pg) } : null,
        };
      }),
      from: 'tz',
    })));

    // Позиции без характеристик в извещении или «заглушка» — заменяем позициями из ТЗ целиком.
    // Так же с 223-ФЗ, где вся закупка — одна позиция «1 условная единица» на всю сумму, а товары — в документации.
    const before = repo.getItems(tender.id);
    const aggregate = before.length === 1 && /условн/i.test(before[0].unit || '') && specs.length > 1;
    if ((d?.items_source === 'fallback' && specs.length) || aggregate) {
      repo.saveItems(tender.id, specs.map((s) => ({
        name: s.name, ktru_code: tender.ktru?.[0] || null, okpd2_code: tender.okpd2?.[0] || null,
        characteristics: s.required.map((r) => ({ name: r.name, value: r.value })), quantity: s.quantity, unit: s.unit,
        unit_price: null, sum: specs.length === 1 ? tender.price : null, source: 'tz',
      })), { conditions: d.conditions, source: 'tz', error: d.error });
    }
    const current = repo.getItems(tender.id);
    let matched = 0;
    const used = new Set();
    const unmatchedTz = [];
    const quantityConflicts = [];
    const assigned = new Map(); // позиция закупки → позиция ТЗ
    const hasReq = (s) => (s.required || []).length > 0;
    // Сначала позиции ТЗ с требованиями (их характеристики сверяются с извещением), потом с моделью, потом остальные.
    const order = specs.slice().sort((a, b) => Number(hasReq(b)) - Number(hasReq(a)) || Number(Boolean(b.identity?.model)) - Number(Boolean(a.identity?.model)));
    for (const s of order) {
      const item = matchSpecToItem(s, current, used) || (current.length === 1 && specs.length === 1 ? current[0] : null);
      if (!item) {
        // ТЗ разбило одну позицию на две записи (модель отдельно, требования отдельно) — дополняем уже найденную
        const near = current.filter((i) => assigned.has(i.id)).map((i) => ({ i, score: specItemScore(s, i) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)[0];
        const prev = near && assigned.get(near.i.id);
        if (prev && (!hasReq(prev) || !hasReq(s))) {
          const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v != null && !/^(undefined|null)$/i.test(String(v))));
          assigned.set(near.i.id, { ...prev, identity: { ...clean(s.identity), ...clean(prev.identity) }, required: [...(prev.required || []), ...(s.required || [])] });
          continue;
        }
        unmatchedTz.push(s.name);
        continue;
      }
      used.add(item.id);
      matched++;
      assigned.set(item.id, s);
      // количество в ТЗ и в извещении расходится (или в самом ТЗ названо по-разному) — не выбираем молча
      const q = [...new Set([item.quantity, s.quantity, ...(s.quantity_conflict || [])].filter((x) => x != null).map(Number))];
      if (q.length > 1) quantityConflicts.push({ name: item.name, values: q });
    }
    for (const [itemId, s] of assigned) {
      const item = current.find((i) => i.id === itemId);
      // Характеристики из ТЗ дополняют пустое извещение; непустые характеристики извещения не затираем.
      const chars = item.characteristics?.length ? null : s.required.map((r) => ({ name: r.name, value: r.value }));
      repo.setItemSpec(item.id, { ...s, name: s.name || item.name }, chars);
    }
    const tokens = run.rules ? 'прочитано по правилам из таблицы документа, без нейросети' : `токенов: ${usage.in || 0} + ${usage.out || 0}`;
    // Ничего не сопоставилось — в документации нет требований к товарам (бывает: спецификация — пустой шаблон,
    // её заполняет победитель). Это не «ТЗ прочитано»: сверка идёт по характеристикам извещения.
    const status = matched ? 'done' : 'empty';
    // Состав сверен, когда каждой позиции закупки нашлась позиция ТЗ и наоборот, а количества совпали.
    const unmatchedItems = specs.length ? current.filter((i) => !used.has(i.id)).map((i) => i.name) : [];
    const reconcile = { items: current.length, tz: specs.length, matched, unmatched_tz: unmatchedTz.slice(0, 30), unmatched_items: unmatchedItems.slice(0, 30), quantity_conflicts: quantityConflicts.slice(0, 30) };
    reconcile.ok = !unmatchedTz.length && !unmatchedItems.length && !quantityConflicts.length;
    repo.setDetailsCoverage(tender.id, 'spec', { ...coverage, reconcile });
    const partial = coverage.status === 'complete' ? ''
      : coverage.status === 'unknown' ? '; полнота чтения документов неизвестна (разобраны прежней версией сервиса) — разберите документацию заново'
        : '; документация прочитана не полностью — требований может быть больше';
    const note = matched
      ? `позиций с требованиями из ТЗ: ${matched} из ${current.length}${partial}; ${tokens}`
      : `в прочитанной части документации не нашлось требований к товарам — сверка по характеристикам извещения${partial}; ${tokens}`;
    repo.setSpecStatus(tender.id, status, note);
    log.log?.(`[spec] закупка ${tender.number}: ${note}`);
    return { status, matched, total: current.length, usage };
  }

  /** Строки прошлых контрактов, которые правила не распознали, — сверить облегчённой моделью (task same_product). */
  async function resolveContractMatches(tender) {
    const system = fs.readFileSync(path.join(__dirname, '..', 'analyze', 'prompts', 'same-product.md'), 'utf8');
    let asked = 0;
    for (const item of repo.getItems(tender.id)) {
      const bench = repo.getBenchmark(itemCode(item) || '');
      const names = unresolvedLines(item, bench);
      const textOf = new Map((bench?.lines || []).map((l) => [l.name, lineText(l)]));
      if (!names.length) continue;
      const s = specOf(item);
      try {
        const { data } = await callJson(llmFactory(), {
          system, schema: SameSchema, task: 'same_product',
          user: JSON.stringify({ spec: { name: s.name, identity: s.identity, equivalent_allowed: s.equivalent_allowed, required: (s.required || []).map((r) => ({ name: r.name, value: r.value })) },
            candidates: names.map((name, i) => ({ i, name: textOf.get(name) || name })) }),
        });
        const map = { ...(item.contract_match || {}) };
        for (const r of data.results) {
          const name = names[r.i];
          if (name == null) continue;
          map[name] = acceptLlmVerdict(item, s, textOf.get(name) || name, r.same, r.reason || '');
        }
        repo.setItemContractMatch(item.id, map);
        asked++;
      } catch (err) {
        log.warn?.(`[same_product] позиция ${item.id}: ${err.message}`);
      }
    }
    return asked;
  }

  return {
    ensureItems, retryNotice, ensureBenchmark, computeEconomics, getCard, precompute, buildInput, ensureSpec, resolveContractMatches, ensurePlatform, ensureCustomer,
    idle: () => benchmarkQueue,
  };
}

module.exports = { createTenderDetails, daysFrom, pctFrom, conditionsFrom44, benchmarkComparable, keepKnown, SRC };
