// Ночной агент базы товаров (этап 2): каждую ночь сам ищет то, чего базе не хватило, и утром присылает отчёт.
//
// Что делает за ночь (всё бесплатно: свой каталог страниц поставщиков, сайты производителей, паспорта в PDF):
//   1. Задачи из ленты закупок за последние дни (компьютеры, картриджи и расходники, оргтехника, комплектующие):
//      — в ТЗ названа модель, а в базе её нет → найти её страницы у поставщиков (свой каталог страниц);
//      — какие характеристики чаще всего спрашивают в ТЗ по каждому виду товара → у каких карточек их нет.
//   2. Дополняет карточки: другие страницы той же модели у поставщиков; у моделей из реестра — паспорт или
//      спецификация в PDF со страницы производителя.
//   2а. Сбор (мебель): в ТЗ на мебель модели обычно нет — по видам, которые спрашивают в свежих закупках (стол, кресло,
//      шкаф…), агент открывает страницы официальных сайтов фабрик и заводит карточки (AGENT_HARVEST_PAGES страниц за ночь).
//   3. Новое значение, которое расходится со старым (числа не совпадают), не заменяет старое, а попадает
//      в «требует вашего решения» — человек выбирает, какое верно.
//   4. Отчёт: на странице «Уведомления» и в Telegram.
// Лимиты на ночь (страниц, файлов PDF, задач) — в config. Одну и ту же задачу повторно берёт не раньше чем через
// AGENT_RETRY_DAYS дней. Платного поиска и нейросети агент не использует.

const { createPageFetcher, FetchSkipped } = require('./fetch-page');
const { specsFromPage } = require('./product');
const { specOf, modelTokens } = require('./spec');
const { modelOf, brandOf } = require('./maker-search');
const { kindOf, isAccessory, compact, decodeTitle, modelFromTitle, KIND, NICHE_LABEL, BRANDED, brandGuess } = require('./product-base');

// Сбор карточек по виду товара (без модели в ТЗ): слова в адресах страниц фабрик — транслитом и по-русски
const HARVEST_WORDS = {
  office_chair: ['kreslo', 'kresla', 'kresel', 'кресл'], chair: ['stul', 'taburet', 'стул', 'табурет'],
  desk: ['stol', 'parta', 'party', 'стол', 'парт'], cabinet: ['shkaf', 'garderob', 'шкаф'], shelving: ['stellazh', 'stellaj', 'stelazh', 'стеллаж'],
  pedestal: ['tumb', 'тумб'], bed: ['krovat', 'kojk', 'koik', 'кроват'], mattress: ['matras', 'матрас'], sofa: ['divan', 'kushetk', 'banketk', 'диван', 'кушетк'],
  bench: ['skam', 'скам'], workbench: ['verstak', 'verstaki', 'верстак'], safe: ['seyf', 'sejf', 'сейф'],
  // медицинские расходники и аккумуляторы (30.10.2026) — с сайтов из своего каталога (оптовики, производители)
  gloves: ['perchatk', 'перчат'], syringe: ['shpric', 'shprits', 'шприц'], needle: ['igla', 'igly', 'игл'], med_mask: ['maska', 'maski', 'маск'],
  catheter: ['kateter', 'катетер'], dressing: ['bint', 'povyazk', 'plastyr', 'бинт', 'повязк', 'пластыр'], wipes: ['salfetk', 'marl', 'салфетк', 'марл'],
  urine_bag: ['mochepriemnik', 'mocheprijomnik', 'мочеприемник'], shoe_covers: ['bakhil', 'bahil', 'бахил'], infusion: ['sistema-dlya-infuz', 'infuzi', 'инфуз'],
  diapers: ['podguzn', 'pelenk', 'подгузн', 'пеленк'], tube: ['probirk', 'konteyner-dlya', 'пробирк'],
  car_battery: ['akkumulyator', 'akb', 'аккумулятор'], cell_battery: ['batareyk', 'batarejk', 'elementy-pitaniya', 'батарейк'],
};
// величина, а не модель: под «моделью» 60Ah сошлись бы все аккумуляторы на 60 А·ч
const UNIT_ONLY = /^\s*\d+([.,]\d+)?\s*(ah|а\s*ч|ач|a|а|мл|ml|мм|mm|г|g|см|cm|м|m|шт|pcs|v|в|mah|мач|%)?\s*$/i;
// артикул на странице — модель, когда в названии мебели её нет («Кровать двухъярусная металлическая»)
const ARTICLE = /^(артикул|арт\.?|модель)$/i;
/** Артикул или модель со страницы — у мебели надёжнее названия («Шкаф (Бук Бавария U9501)»: U9501 — цвет, не модель). */
const articleOf = (specs) => {
  const v = String(specs.find((s) => ARTICLE.test(String(s.name).replace(/[:\s]+$/, '').trim()))?.value || '').trim();
  return v && v.length <= 40 && /\d/.test(v) && !/\s{2,}|<|:/.test(v) ? v : null;
};
const { linePairs } = require('./registry-models');
const { attrsOf } = require('./attributes');
const { extractFile } = require('../extract');

const normName = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/[:.]+$/, '').trim();
// условия поставки и упаковки агенту искать не нужно — их в характеристиках товара нет
const NOT_SPEC = /гаранти|срок|поставк|упаковк|маркировк|сертификат|декларац|страна|происхожд|нов(ый|ым)|не бывш|не восстановл|документац|инструкц|комплект поставки/i;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Заголовок страницы товара: h1, иначе <title>. */
const pageTitle = (html) => decodeTitle(String(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

/**
 * Как ещё может называться модель из ТЗ: без приставки совместимого бренда («HB-CRG-728» → «CRG-728»), с нулём вместо
 * буквы O между цифрами («TK-523OK» → «TK-5230K»), у картриджей HP — с приставкой серии («283A» → «CF283A», «CE283A»).
 */
function modelVariants(model, kindId = null) {
  const m = String(model || '').trim();
  const out = [m];
  const noBrand = m.replace(/^(hb|nv|gg|g&g|cs|bion|sakura|t2|ep|pl)[-_ ]/i, '');
  if (noBrand !== m && compact(noBrand).length >= 4) out.push(noBrand);
  const zero = m.replace(/(\d)[OoОо](?=[\dA-Za-zА-Яа-я]|$)/g, '$10');
  if (zero !== m) out.push(zero);
  if (['cartridge', 'toner', 'drum'].includes(kindId) && /^\d{2,3}[AXaxАХах]$/.test(m)) out.push(`CF${m}`, `CE${m}`);
  return [...new Set(out.map((x) => x.replace(/[АХах]$/, (c) => ({ А: 'A', Х: 'X', а: 'a', х: 'x' }[c]))))];
}

/** Пары «название: значение» из текста паспорта (строки с двоеточием, табуляцией или соседние строки). */
function passportPairs(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([А-ЯЁA-Z][^:\t]{2,60}?)\s*(?::|\t|\s{3,})\s*(.{1,120})$/.exec(line.trim());
    if (m && /[а-яёa-z]{3}/i.test(m[1]) && !/^\d/.test(m[1])) out.push({ name: m[1].trim(), value: m[2].trim() });
  }
  return [...out, ...linePairs(text)].slice(0, 150);
}

function createProductAgent({ db, productBase, siteIndex = null, merlion = null, config = {}, fetchImpl = fetch, fetcher = null, notify = null, clock = () => new Date(), log = console, extract = extractFile, official = [] }) {
  // официальные сайты производителей (база знаний): их характеристики — данные производителя, важнее продавца
  const officialSet = new Set(official.map((d) => String(d).replace(/^www\./, '')));
  const isOfficial = (domain) => [...officialSet].some((d) => domain === d || domain.endsWith(`.${d}`));
  db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, reason TEXT,
      stats_json TEXT, read_at TEXT, tg_at TEXT);
    CREATE TABLE IF NOT EXISTS agent_tried (key TEXT PRIMARY KEY, at TEXT NOT NULL, result TEXT);
    CREATE TABLE IF NOT EXISTS agent_sources (domain TEXT PRIMARY KEY, opened INTEGER NOT NULL DEFAULT 0, useful INTEGER NOT NULL DEFAULT 0,
      specs INTEGER NOT NULL DEFAULT 0, prices INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, last_useful_at TEXT, last_at TEXT);
    CREATE TABLE IF NOT EXISTS product_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, name TEXT NOT NULL, old_value TEXT, old_src TEXT,
      new_value TEXT, new_src TEXT, created_at TEXT NOT NULL, run_id INTEGER, status TEXT NOT NULL DEFAULT 'open', resolved_at TEXT);
    CREATE TABLE IF NOT EXISTS merlion_categories (url TEXT PRIMARY KEY, listed_at TEXT, items INTEGER);
    CREATE TABLE IF NOT EXISTS merlion_items (id INTEGER PRIMARY KEY, category TEXT, title TEXT, second TEXT, listed_at TEXT, read_at TEXT, status TEXT);`);
  const pages = fetcher || createPageFetcher({ fetchImpl, minIntervalMs: config.FETCH_MIN_INTERVAL_MS ?? 1500 });
  const limits = () => ({
    pages: config.AGENT_PAGES_PER_NIGHT ?? 150, pdfs: config.AGENT_PDF_PER_NIGHT ?? 20, tasks: config.AGENT_TASKS_PER_NIGHT ?? 60, harvest: config.AGENT_HARVEST_PAGES ?? 40,
    retryDays: config.AGENT_RETRY_DAYS ?? 14, feedDays: config.AGENT_FEED_DAYS ?? 3, minutes: config.AGENT_MAX_MINUTES ?? 120,
    merlionCards: config.MERLION_CARDS_PER_NIGHT ?? 300, merlionLists: config.MERLION_LISTS_PER_NIGHT ?? 15,
  });

  const triedRecently = (key, days) => {
    const r = db.prepare('SELECT at FROM agent_tried WHERE key = ?').get(key);
    return Boolean(r) && clock().getTime() - new Date(r.at).getTime() < days * 86400000;
  };
  const markTried = (key, result) => db.prepare('INSERT INTO agent_tried (key, at, result) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, result = excluded.result').run(key, clock().toISOString(), result);

  /** Позиции свежих закупок из ниш базы: модели из ТЗ и названия требований. */
  function demand() {
    const { feedDays } = limits();
    const now = clock();
    const since = new Date(now.getTime() - feedDays * 86400000).toISOString();
    const rows = db.prepare(`SELECT i.id, i.name, i.ktru_code, i.okpd2_code, i.characteristics_json, i.spec_json, i.quantity, i.unit, t.id AS tender_id
      FROM tender_items i JOIN tenders t ON t.id = i.tender_id
      WHERE COALESCE(t.published_at, t.first_seen_at, '') >= ? AND (t.deadline_at IS NULL OR t.deadline_at > ?)`).all(since, now.toISOString());
    const items = [];
    const names = new Map(); // вид → Map(требование → сколько раз спрашивали)
    const hot = hotTenders();
    for (const r of rows) {
      const kind = kindOf(r.name, { code: r.ktru_code || r.okpd2_code });
      if (!kind) continue;
      let item;
      try { item = { ...r, characteristics: JSON.parse(r.characteristics_json || '[]'), spec: JSON.parse(r.spec_json || 'null') }; } catch { continue; }
      const spec = specOf(item);
      const own = String(item.name).split(/(?:^|[\s(,])(?:для|for|к)(?=\s)/i)[0];
      // «Аналог CF259X», «Оригинал TK-1170» — модель без пометки
      const models = [...new Set([spec.identity?.model, ...modelTokens(own)].filter(Boolean)
        .map((m) => String(m).replace(/^\s*(аналог|совместим\S*|оригинал\S*|эквивалент|или\s+эквивалент)\s+/i, '').trim())
        // модель — с цифрой или латиницей: в позициях, где вместо названия текст ТЗ, «Наличие» моделью не считаем
        .filter((m) => compact(m).length >= 4 && !/\s/.test(m) && /[0-9a-z]/i.test(m)))];
      items.push({ ...r, kind, models, priority: hot.has(r.tender_id) });
      const m = names.get(kind.id) || new Map();
      for (const req of spec.required || []) if (!NOT_SPEC.test(req.name)) m.set(req.name, (m.get(req.name) || 0) + 1);
      names.set(kind.id, m);
    }
    return { items, names };
  }

  /**
   * Закупки, с которыми за последние 2 дня работал агент заявок (их товары реально нужны в заявке): ночью их модели и
   * карточки — первыми. Нет таблицы агента заявок (он выключен) — пусто.
   */
  function hotTenders() {
    try {
      const since = new Date(clock().getTime() - 2 * 86400000).toISOString();
      return new Set(db.prepare('SELECT DISTINCT tender_id FROM bid_agent_items WHERE created_at >= ?').all(since).map((r) => r.tender_id));
    } catch { return new Set(); }
  }

  /** Есть ли у карточки значение требования: то же название или то же свойство словаря. */
  function hasValue(product, reqName) {
    const k = normName(reqName);
    if (product.specs.some((s) => normName(s.name) === k)) return true;
    const ids = new Set(attrsOf(reqName).map((a) => a.id));
    return ids.size > 0 && product.specs.some((s) => attrsOf(s.name).some((a) => ids.has(a.id)));
  }

  /** План на ночь: сначала модели из ТЗ, которых нет в базе, потом карточки с пробелами по частым требованиям. */
  function plan() {
    const lim = limits();
    const { items, names } = demand();
    const tasks = [];
    const seen = new Set();
    // закупки агента заявок — первыми
    items.sort((a, b) => Number(b.priority) - Number(a.priority));
    const hotModels = new Set(items.filter((i) => i.priority).flatMap((i) => i.models.map((m) => compact(m))));
    for (const it of items) {
      for (const model of it.models) {
        const key = `model:${compact(model)}`;
        if (seen.has(key) || modelVariants(model, it.kind.id).some((v) => productBase.findModel(v, it.kind.niche)) || triedRecently(key, lim.retryDays)) continue;
        seen.add(key);
        tasks.push({ type: 'model', key, model, kind: it.kind, tender_id: it.tender_id, item: it.name });
      }
    }
    // моделям из ТЗ — до 60% задач ночи, остальное — дополнению карточек (иначе до него не доходит очередь)
    tasks.splice(Math.ceil(lim.tasks * 0.6));
    // частые требования по виду: спросили хотя бы в двух позициях
    for (const [kindId, m] of names) {
      const asked = [...m].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name]) => name);
      if (!asked.length) continue;
      const gaps = [];
      for (const p of productBase.list(kindId)) {
        const key = `enrich:${p.id}`;
        if (triedRecently(key, lim.retryDays)) continue;
        const missing = asked.filter((name) => !hasValue(p, name));
        // карточка модели из закупки агента заявок — в начало очереди дополнения
        const hot = [...hotModels].some((m) => m.length >= 4 && compact(p.key || p.title || '').includes(m));
        if (missing.length) gaps.push({ type: 'enrich', key, product: p, kind: KIND[kindId], missing, score: missing.length + (p.from_registry ? 2 : 0) + (hot ? 100 : 0) });
      }
      gaps.sort((a, b) => b.score - a.score);
      tasks.push(...gaps.slice(0, Math.ceil(lim.tasks / 2)));
    }
    // сбор: виды без моделей в ТЗ (мебель), которые спрашивают в свежих закупках, — страниц пропорционально спросу
    const wanted = new Map();
    for (const it of items) if (HARVEST_WORDS[it.kind.id]) wanted.set(it.kind.id, (wanted.get(it.kind.id) || 0) + 1);
    const total = [...wanted.values()].reduce((a, b) => a + b, 0);
    const harvest = lim.harvest > 0 && siteIndex?.sample ? [...wanted].sort((a, b) => b[1] - a[1])
      .map(([kindId, n]) => ({ type: 'harvest', key: `harvest:${kindId}`, kind: KIND[kindId], demand: n, pages: Math.max(3, Math.round((lim.harvest * n) / total)) })) : [];
    // модели из ТЗ — в первую очередь: их ждут в открытых закупках; сбор — в конце, но место ему оставлено
    return [...tasks.slice(0, Math.max(0, lim.tasks - harvest.length)), ...harvest];
  }

  // ---------- опыт по источникам: какие сайты дают характеристики и цены, а какие — пустые страницы ----------
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
  function learn(domain, { opened = 0, failed = 0, specs = 0, prices = 0 } = {}) {
    if (!domain) return;
    const useful = specs > 0 || prices > 0 ? 1 : 0;
    db.prepare(`INSERT INTO agent_sources (domain, opened, failed, useful, specs, prices, last_useful_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET opened = opened + excluded.opened, failed = failed + excluded.failed, useful = useful + excluded.useful,
        specs = specs + excluded.specs, prices = prices + excluded.prices, last_useful_at = COALESCE(excluded.last_useful_at, last_useful_at), last_at = excluded.last_at`)
      .run(domain, opened, failed, useful, specs, prices, useful ? clock().toISOString() : null, clock().toISOString());
  }
  /** Оценка сайта по опыту: доля полезных страниц (у нового сайта — средняя); официальный сайт — выше. */
  function score(domain) {
    const r = db.prepare('SELECT opened, useful FROM agent_sources WHERE domain = ?').get(domain) || { opened: 0, useful: 0 };
    return (r.useful + 1) / (r.opened + 2) + (isOfficial(domain) ? 0.25 : 0);
  }
  /** Сайт, который открывали 8 раз и ни разу не получили ничего полезного, агент больше не открывает. */
  const useless = (domain) => { const r = db.prepare('SELECT opened, useful FROM agent_sources WHERE domain = ?').get(domain); return Boolean(r) && r.opened >= 8 && r.useful === 0; };

  /** Открыть страницу (с учётом лимита ночи): заголовок, характеристики, цена; null — не открылась. */
  async function readPage(url, budget) {
    if (budget.pages <= 0) return null;
    budget.pages--;
    const domain = hostOf(url);
    let page;
    try { page = await pages.fetchPage(url); } catch (err) { if (err instanceof FetchSkipped && err.closed) budget.closed.add(new URL(url).hostname); learn(domain, { opened: 1, failed: 1 }); return null; }
    learn(domain, { opened: 1 });
    const title = pageTitle(page.html);
    if (!title) return null;
    const st = (page.structured || []).find((s) => !s.range) || null;
    const official = isOfficial(domain);
    const specs = [...specsFromPage(page.html, 120), ...(st?.props || [])].map((s) => ({ name: s.name, value: s.value, src: url, ...(official ? { from: 'сайт производителя' } : {}) }));
    return { title, specs, price: official ? null : st?.price ?? null, domain, official };
  }

  /** Прочитать страницу поставщика или производителя: модель в заголовке, характеристики, цена. */
  async function readSupplierPage(url, model, budget) {
    const r = await readPage(url, budget);
    // страница другого товара или раздел каталога
    return r && compact(r.title).includes(compact(model)) ? r : null;
  }

  /**
   * Страницы модели в своём каталоге (бесплатно): у поставщиков и на официальных сайтах производителей, кроме уже
   * известных адресов. Сначала сайты, которые по опыту дают характеристики; бесполезные по опыту — пропускаются.
   */
  function supplierPages(model, known, limit = 3) {
    if (!siteIndex) return [];
    let found = [];
    try { found = siteIndex.find([model], { perDomain: 1, limit: limit * 4, withOfficial: true, skip: (url) => known.has(url) || useless(hostOf(url)) }); } catch { return []; }
    return found.map((x) => ({ url: x.url, s: score(hostOf(x.url)) })).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.url);
  }

  /** Источник карточки: официальный сайт производителя или поставщик (с ценой на дату). */
  const sourceOf = (url, r) => (r.official ? { url, type: 'official', name: r.domain, at: clock().toISOString() } : { url, type: 'supplier', name: r.domain, price: r.price, price_at: clock().toISOString() });

  async function doModel(task, budget, stats, conflicts) {
    let added = false;
    let urls = [];
    for (const variant of modelVariants(task.model, task.kind.id)) {
      urls = supplierPages(variant, new Set(), 3);
      for (const url of urls) {
        const r = await readSupplierPage(url, variant, budget);
        if (r && save(task, r, url, variant, stats, conflicts) !== false) added = true;
      }
      if (added) break;
    }
    if (!added) stats.not_found.push({ model: task.model, kind: task.kind.label, item: task.item, tender_id: task.tender_id });
    markTried(task.key, added ? 'found' : urls.length ? 'pages_other' : 'no_pages');
  }

  /** Новая или дополненная карточка из страницы поставщика. */
  function save(task, r, url, variant, stats, conflicts) {
    // По номеру модели находятся и чужие товары: принтер к картриджу, запчасть к нему. Берём только тот же вид
    // (или ниша та же: тонер к картриджу) и страницы, где вид в названии не назван («Canon CRG 728 (3500B010)»).
    const own = kindOf(r.title);
    if ((own && own.niche !== task.kind.niche) || (!own && isAccessory(r.title))) return false;
    const kind = own || task.kind;
    const res = productBase.upsert({
      kind, brand: brandOf(r.title), model: modelFromTitle(r.title, kind) || variant, title: r.title, specs: r.specs, conflicts, prefer: r.official,
      sources: [sourceOf(url, r)],
    });
    learn(r.domain, { specs: res.added, prices: r.price != null ? 1 : 0 });
    if (res.status === 'new') { stats.products_new++; stats.new_list.push({ id: res.id, title: r.title, kind: kind.label }); }
    stats.specs_added += res.added;
    if (r.price != null) stats.prices++;
    for (const c of conflicts.splice(0)) stats.conflict_rows.push({ ...c, product_id: res.id, title: r.title });
  }

  async function doEnrich(task, budget, stats, conflicts) {
    const p = task.product;
    const full = productBase.get(p.id);
    const known = new Set(full.sources.map((s) => s.url));
    let added = 0;
    const take = (res, title) => {
      added += res.added;
      for (const c of conflicts.splice(0)) stats.conflict_rows.push({ ...c, product_id: p.id, title });
    };
    // модель из реестра: паспорт или спецификация в PDF со страницы производителя
    const maker = full.sources.find((s) => s.type === 'maker');
    if (maker && budget.pdfs > 0 && budget.pages > 0) {
      budget.pages--;
      let page = null;
      try { page = await pages.fetchPage(maker.url); } catch { page = null; }
      const host = (() => { try { return new URL(maker.url).hostname; } catch { return ''; } })();
      const pdfs = page ? [...new Set([...String(page.html).matchAll(/href\s*=\s*["']([^"'#]+\.pdf)(?:\?[^"']*)?["']/gi)].map((m) => { try { return new URL(m[1], maker.url).href; } catch { return null; } })
        .filter((u) => u && new URL(u).hostname === host && !known.has(u)))].slice(0, 2) : [];
      for (const url of pdfs) {
        if (budget.pdfs <= 0) break;
        budget.pdfs--;
        try {
          const file = await pages.fetchFile(url, { maxBytes: 15 * 1024 * 1024 });
          const parts = await extract({ name: 'passport.pdf', buffer: file.buf }, 0, { ocr: { pdfReady: async () => false } });
          const text = parts.flatMap((x) => x.pages || []).map((x) => x.text).join('\n');
          const specs = passportPairs(text).map((s) => ({ ...s, src: url, from: 'паспорт' }));
          if (!specs.length) continue;
          stats.pdf_read++;
          take(productBase.upsert({ kind: task.kind, brand: p.brand, model: p.model, title: p.title, specs, conflicts, sources: [{ url, type: 'pdf', name: maker.name }] }), p.title);
        } catch (err) {
          log.warn?.(`[agent] паспорт ${url}: ${err.message}`);
        }
      }
    }
    // другие страницы той же модели у поставщиков
    for (const url of supplierPages(p.model, known, 2)) {
      const r = await readSupplierPage(url, p.model, budget);
      if (!r) continue;
      if (r.price != null) stats.prices++;
      const res = productBase.upsert({ kind: task.kind, brand: p.brand, model: p.model, title: p.title, specs: r.specs, conflicts, prefer: r.official, sources: [sourceOf(url, r)] });
      learn(r.domain, { specs: res.added, prices: r.price != null ? 1 : 0 });
      take(res, p.title);
    }
    if (added) { stats.products_enriched++; stats.specs_added += added; stats.enriched_list.push({ id: p.id, title: p.title, added }); }
    markTried(task.key, added ? `+${added}` : 'nothing');
  }

  /**
   * Сбор: страницы официальных сайтов фабрик по виду товара (в адресе — «kreslo», «стол»…). Карточка заводится, если
   * в заголовке страницы — товар той же ниши (кресло, стол…), есть модель (в названии или артикул) и хотя бы
   * 3 характеристики. Открытые страницы помечаются: следующей ночью берутся другие.
   */
  async function doHarvest(task, budget, stats, conflicts) {
    const urls = siteIndex.sample(HARVEST_WORDS[task.kind.id] || [], { limit: task.pages * 2, perDomain: 3, skip: (url, domain) => useless(domain) || triedRecently(`page:${url}`, 90) });
    let opened = 0;
    let added = 0;
    for (const { url } of urls) {
      if (opened >= task.pages || budget.pages <= 0) break;
      opened++;
      stats.harvest_pages = (stats.harvest_pages || 0) + 1;
      const r = await readPage(url, budget);
      markTried(`page:${url}`, r ? 'read' : 'failed');
      if (!r) continue;
      const own = kindOf(r.title);
      if (!own || own.niche !== task.kind.niche || r.specs.length < 3) continue;
      // у мебели название без номера («Стол руководителя JERA…», «Верстак Premium») — серия: модель — артикул страницы
      const fromTitle = modelFromTitle(r.title, own);
      // у медицинских расходников и аккумуляторов — так же; «60Ah», «5 мл» в названии — величина, а не модель
      const titleModel = fromTitle && !UNIT_ONLY.test(fromTitle) ? fromTitle : null;
      const model = (['furniture', 'medical', 'batteries'].includes(own.niche) && (!titleModel || !/\d/.test(titleModel)) && articleOf(r.specs)) || titleModel || articleOf(r.specs);
      if (!model || compact(model).length < 2) continue;
      const res = productBase.upsert({ kind: own, brand: BRANDED.has(own.niche) ? brandGuess(r.title, r.specs, model) : brandOf(r.title), model: String(model).slice(0, 80), title: r.title, specs: r.specs, conflicts, prefer: r.official, sources: [sourceOf(url, r)] });
      learn(r.domain, { specs: res.added, prices: r.price != null ? 1 : 0 });
      if (res.status === 'new') { stats.products_new++; added++; stats.new_list.push({ id: res.id, title: r.title, kind: own.label }); }
      stats.specs_added += res.added;
      for (const c of conflicts.splice(0)) stats.conflict_rows.push({ ...c, product_id: res.id, title: r.title });
    }
    markTried(task.key, `+${added} из ${opened}`);
  }

  // ---------- Мерлион: каталог дистрибьютора с полными характеристиками (цен нет — источник характеристик) ----------
  // разделы наших ниш (по адресу раздела): оргтехника и расходники, компьютеры и комплектующие, сеть, ИБП, мебель, батарейки, ТВ
  const MERLION_RELEVANT = /mfu|printer|kopir|skaner|plotter|kartridzh|toner|fotobaraban|drum|raskhodn|monitor|noutbuk|kompyuter|monoblok|server|kommutator|marshrutizator|setev|wi-fi|ibp|bespereboyn|stabilizator|klaviatur|mysh|manipulyator|proektor|televizor|panel|mebel|kresl|stol|shkaf|tumb|stul|stellazh|batare|akkumulyator|elementy-pitaniya|videonablyud|kamer|naushnik|garnitur|kolonk|ssd|nakopitel|operativn|zhestk|protsessor|materinsk|videokart|bloki-pitaniya|korpus/;
  /**
   * Ночью: списки товаров по разделам наших ниш (самые давние — первыми), потом карточки — сначала моделей из ТЗ свежих
   * закупок (закупки агента заявок — первыми), затем ещё не прочитанные карточки видов, которые спрашивают в ТЗ.
   */
  async function doMerlion(stats, conflicts, wanted) {
    if (!merlion) return;
    const lim = limits();
    const m = stats.merlion = { lists: 0, listed: 0, cards: 0, products_new: 0, specs_added: 0, by_model: 0, errors: 0 };
    try {
      // разделы — из карты сайта раз в 30 дней
      const known = db.prepare('SELECT COUNT(*) n FROM merlion_categories').get().n;
      const monthAgo = new Date(clock().getTime() - 30 * 86400000).toISOString();
      const lastAdded = db.prepare("SELECT value FROM settings WHERE key = 'merlion:categories_at'").get()?.value;
      if (!known || !lastAdded || lastAdded < monthAgo) {
        for (const url of (await merlion.categories()).filter((u) => MERLION_RELEVANT.test(u))) db.prepare('INSERT OR IGNORE INTO merlion_categories (url) VALUES (?)').run(url);
        db.prepare("INSERT INTO settings (key, value) VALUES ('merlion:categories_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(clock().toISOString());
      }
      // списки товаров: разделы, не обновлявшиеся 14 дней, — самые давние первыми
      const since = new Date(clock().getTime() - 14 * 86400000).toISOString();
      const up = db.prepare(`INSERT INTO merlion_items (id, category, title, second, listed_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET category = excluded.category, title = excluded.title, second = excluded.second, listed_at = excluded.listed_at`);
      for (const { url } of db.prepare("SELECT url FROM merlion_categories WHERE listed_at IS NULL OR listed_at < ? ORDER BY COALESCE(listed_at, '') LIMIT ?").all(since, lim.merlionLists)) {
        try {
          const { items } = await merlion.listCategory(url, { maxPages: 20 });
          for (const it of items) up.run(it.id, url, it.title, it.second, clock().toISOString());
          db.prepare('UPDATE merlion_categories SET listed_at = ?, items = ? WHERE url = ?').run(clock().toISOString(), items.length, url);
          m.lists++; m.listed += items.length;
        } catch (err) { m.errors++; log.warn?.(`[agent] Мерлион, раздел ${url}: ${err.message}`); }
      }
      // карточки: модели из ТЗ (закупки агента заявок — первыми), потом непрочитанные карточки нужных видов
      const rows = db.prepare('SELECT id, title, second FROM merlion_items WHERE read_at IS NULL OR read_at < ?').all(monthAgo);
      const queue = [];
      const seen = new Set();
      const flatOf = (r) => compact(`${r.title} ${r.second || ''}`);
      for (const model of wanted.models) {
        const k = compact(model);
        if (k.length < 4) continue;
        for (const r of rows) if (!seen.has(r.id) && flatOf(r).includes(k)) { seen.add(r.id); queue.push({ ...r, by_model: true }); }
      }
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        const kind = kindOf(r.title);
        if (kind && wanted.kinds.has(kind.id)) { seen.add(r.id); queue.push(r); }
      }
      const mark = db.prepare('UPDATE merlion_items SET read_at = ?, status = ? WHERE id = ?');
      for (const r of queue.slice(0, lim.merlionCards)) {
        let card;
        try { card = await merlion.card(r.id); } catch (err) { m.errors++; mark.run(clock().toISOString(), 'error', r.id); continue; }
        m.cards++;
        const title = card.title || r.title;
        const kind = kindOf(title);
        let model = kind ? (modelFromTitle(title, kind) || card.article) : null;
        // поколение после модели — другая модель («MF465DW II» пришла на замену «MF465dw»): не сливаем их в одну карточку
        const gen = model && new RegExp(`${String(model).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(II|III|IV|V|VI)(?![A-Za-z])`, 'i').exec(title);
        if (gen) model = `${model} ${gen[1].toUpperCase()}`;
        if (!kind || !model || card.specs.length < 3) { mark.run(clock().toISOString(), 'skip', r.id); continue; }
        const specs = [...card.specs, ...(card.article ? [{ name: 'Артикул производителя', value: card.article }] : []), ...(card.ean ? [{ name: 'EAN', value: card.ean }] : [])]
          .map((x) => ({ ...x, src: card.url }));
        const res = productBase.upsert({
          kind, brand: brandOf(title), model: String(model).slice(0, 80), title: `${title}${card.second ? ` ${card.second}` : ''}`, specs, conflicts,
          sources: [{ url: card.url, type: 'supplier', name: 'merlion.com', price: null, price_at: clock().toISOString() }],
        });
        learn('merlion.com', { opened: 1, specs: res.added });
        mark.run(clock().toISOString(), res.status, r.id);
        if (res.status === 'new') { m.products_new++; stats.products_new++; stats.new_list.push({ id: res.id, title, kind: kind.label }); } else if (res.added > 0) stats.products_enriched++;
        if (r.by_model) m.by_model++;
        m.specs_added += res.added;
        stats.specs_added += res.added;
        // расхождение карточки Мерлиона с другой карточкой Мерлиона той же модели — это вариант товара (размер, цвет,
        // комплектация: мышь M650 и M650 L), а не спор источников: человеку на решение не отправляем
        for (const c of conflicts.splice(0)) if (!(/merlion\.com/.test(String(c.old_src)) && /merlion\.com/.test(String(c.new_src)))) stats.conflict_rows.push({ ...c, product_id: res.id, title });
      }
    } catch (err) { m.errors++; log.warn?.(`[agent] Мерлион: ${err.message}`); }
  }

  let running = null;
  /**
   * Ночной проход. reason — 'night' (по расписанию) или 'manual' (кнопка на странице).
   * @returns {Promise<object>} статистика прохода (она же — отчёт)
   */
  function run({ reason = 'night' } = {}) {
    if (running) return running;
    running = (async () => {
      const startedAt = clock().toISOString();
      const runId = Number(db.prepare("INSERT INTO agent_runs (started_at, status, reason) VALUES (?, 'running', ?)").run(startedAt, reason).lastInsertRowid);
      const lim = limits();
      const budget = { pages: lim.pages, pdfs: lim.pdfs, closed: new Set() };
      const stats = {
        before: 0, after: 0, tasks: 0, done: 0, products_new: 0, products_enriched: 0, specs_added: 0, prices: 0, pdf_read: 0,
        conflicts: 0, pages: 0, queue_left: 0, new_list: [], enriched_list: [], not_found: [], conflict_rows: [], closed: [], niches: [],
      };
      try {
        await productBase.refresh();
        stats.before = productBase.status().total;
        const tasks = plan();
        stats.tasks = tasks.length;
        // Мерлион — до задач по поставщикам: у него свои лимиты (MERLION_*), страницы поставщиков он не тратит
        if (merlion) {
          const { items } = demand();
          const hot = items.filter((i) => i.priority).concat(items.filter((i) => !i.priority));
          await doMerlion(stats, [], { models: [...new Set(hot.flatMap((i) => i.models))], kinds: new Set(items.map((i) => i.kind.id)) });
        }
        const deadline = Date.now() + lim.minutes * 60000;
        const conflicts = [];
        for (const t of tasks) {
          if (budget.pages <= 0 || Date.now() > deadline) break;
          try {
            if (t.type === 'model') await doModel(t, budget, stats, conflicts);
            else if (t.type === 'harvest') await doHarvest(t, budget, stats, conflicts);
            else await doEnrich(t, budget, stats, conflicts);
            stats.done++;
          } catch (err) {
            log.warn?.(`[agent] ${t.key}: ${err.message}`);
          }
        }
        stats.queue_left = tasks.length - stats.done;
        stats.pages = lim.pages - budget.pages;
        stats.closed = [...budget.closed];
        const ins = db.prepare('INSERT INTO product_conflicts (product_id, name, old_value, old_src, new_value, new_src, created_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const c of stats.conflict_rows) {
          const dup = db.prepare("SELECT 1 FROM product_conflicts WHERE product_id = ? AND name = ? AND new_value = ? AND status = 'open'").get(c.product_id, c.name, c.new_value);
          if (!dup) { ins.run(c.product_id, c.name, c.old_value, c.old_src, c.new_value, c.new_src, clock().toISOString(), runId); stats.conflicts++; }
        }
        delete stats.conflict_rows;
        const st = productBase.status();
        stats.after = st.total;
        stats.niches = st.niches;
        db.prepare("UPDATE agent_runs SET finished_at = ?, status = 'done', stats_json = ? WHERE id = ?").run(clock().toISOString(), JSON.stringify(stats), runId);
        log.log?.(`[agent] готово: задач ${stats.done} из ${stats.tasks}, новых товаров ${stats.products_new}, дополнено ${stats.products_enriched}, характеристик +${stats.specs_added}, расхождений ${stats.conflicts}`);
      } catch (err) {
        db.prepare("UPDATE agent_runs SET finished_at = ?, status = 'error', stats_json = ? WHERE id = ?").run(clock().toISOString(), JSON.stringify({ ...stats, error: err.message }), runId);
        log.warn?.(`[agent] ошибка: ${err.message}`);
      }
      await sendReport(runId).catch((err) => log.warn?.(`[agent] Telegram: ${err.message}`));
      return { id: runId, ...report(runId) };
    })().finally(() => { running = null; });
    return running;
  }

  /** Открытые расхождения с названием товара. */
  function openConflicts(limit = 50) {
    return db.prepare(`SELECT c.*, p.title, p.model FROM product_conflicts c JOIN products p ON p.id = c.product_id
      WHERE c.status = 'open' ORDER BY c.id DESC LIMIT ?`).all(limit);
  }

  function report(runId) {
    const r = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId);
    if (!r) return null;
    let stats = {};
    try { stats = JSON.parse(r.stats_json || '{}'); } catch { stats = {}; }
    return { id: r.id, started_at: r.started_at, finished_at: r.finished_at, status: r.status, reason: r.reason, read: Boolean(r.read_at), stats };
  }

  /** Текст отчёта для Telegram (HTML). */
  function reportText(rep) {
    const s = rep.stats || {};
    const base = config.PUBLIC_BASE_URL || '';
    if (rep.status === 'error') return `🤖 <b>Агент базы товаров</b>: ночной проход прервался — ${esc(s.error)}. Подробнее: ${esc(base)}/#alerts`;
    const open = openConflicts(1000).length;
    const lines = [
      '🤖 <b>Агент базы товаров — отчёт за ночь</b>',
      `В базе ${s.after} товаров${s.after > s.before ? ` (+${s.after - s.before})` : ''}: ${(s.niches || []).map((n) => `${esc(n.label)} ${n.n}`).join(', ')}`,
      `Сделано задач: ${s.done} из ${s.tasks} · открыто страниц: ${s.pages}${s.pdf_read ? ` · прочитано паспортов: ${s.pdf_read}` : ''}`,
      `Новых товаров: ${s.products_new} · дополнено карточек: ${s.products_enriched} (+${s.specs_added} характеристик) · цен: ${s.prices}`,
    ];
    if (s.harvest_pages) lines.push(`Сбор карточек с сайтов фабрик (мебель): открыто страниц ${s.harvest_pages}`);
    if (s.merlion) lines.push(`Мерлион: разделов ${s.merlion.lists} (товаров в списках ${s.merlion.listed}), прочитано карточек ${s.merlion.cards}${s.merlion.by_model ? ` (по моделям из ТЗ ${s.merlion.by_model})` : ''} · новых товаров ${s.merlion.products_new} · характеристик +${s.merlion.specs_added}${s.merlion.errors ? ` · ошибок ${s.merlion.errors}` : ''}`);
    if (s.not_found?.length) lines.push(`Не нашлось у поставщиков из каталога: ${s.not_found.slice(0, 8).map((x) => esc(x.model)).join(', ')}${s.not_found.length > 8 ? ` и ещё ${s.not_found.length - 8}` : ''}`);
    if (open) lines.push(`⚠ <b>Требует вашего решения</b>: расхождений в характеристиках — ${open}${s.conflicts ? ` (новых за ночь ${s.conflicts})` : ''}`);
    if (s.queue_left > 0) lines.push(`Не успел сегодня (лимит на ночь): ${s.queue_left} — продолжу следующей ночью`);
    lines.push(`<a href="${esc(base)}/#alerts">Открыть отчёт</a>`);
    return lines.join('\n');
  }

  async function sendReport(runId) {
    if (!notify) return false;
    const rep = report(runId);
    if (!rep) return false;
    const sent = await notify(reportText(rep));
    if (sent) db.prepare('UPDATE agent_runs SET tg_at = ? WHERE id = ?').run(clock().toISOString(), runId);
    return sent;
  }

  /** Для страницы «Уведомления»: последние отчёты, расхождения, состояние. */
  function view() {
    const runs = db.prepare('SELECT id FROM agent_runs ORDER BY id DESC LIMIT 7').all().map((r) => report(r.id));
    // прогон в рабочем процессе (отдельная служба) — по незаконченной записи в базе, не старше 6 часов
    const elsewhere = Boolean(db.prepare("SELECT 1 FROM agent_runs WHERE status = 'running' AND started_at > ?").get(new Date(clock().getTime() - 6 * 3600000).toISOString()));
    return {
      running: Boolean(running) || elsewhere, runs, unread: runs.filter((r) => r.status !== 'running' && !r.read).length,
      conflicts: openConflicts(50), base: productBase.status(),
      sources: db.prepare('SELECT domain, opened, useful, specs, prices FROM agent_sources ORDER BY specs + prices * 3 DESC, useful DESC LIMIT 12').all().map((x) => ({ ...x, official: isOfficial(x.domain) })),
      useless: db.prepare('SELECT domain FROM agent_sources WHERE opened >= 8 AND useful = 0 ORDER BY opened DESC LIMIT 20').all().map((x) => x.domain),
      limits: limits(), hour: config.AGENT_HOUR ?? 3, enabled: config.AGENT_ENABLED !== false,
    };
  }

  /** Решение по расхождению: keep — оставить старое значение, take — взять новое. */
  function resolve(conflictId, decision) {
    const c = db.prepare('SELECT * FROM product_conflicts WHERE id = ?').get(Number(conflictId));
    if (!c) throw Object.assign(new Error('Расхождение не найдено'), { status: 404 });
    if (!['keep', 'take'].includes(decision)) throw Object.assign(new Error('Решение: keep или take'), { status: 400 });
    if (decision === 'take') productBase.setSpec(c.product_id, c.name, c.new_value, c.new_src);
    db.prepare("UPDATE product_conflicts SET status = ?, resolved_at = ? WHERE id = ?").run(decision === 'take' ? 'taken' : 'kept', clock().toISOString(), c.id);
    return { ok: true };
  }

  const markRead = () => db.prepare('UPDATE agent_runs SET read_at = ? WHERE read_at IS NULL AND status != ?').run(clock().toISOString(), 'running').changes;

  /** Пора ли ночной проход: наступил час AGENT_HOUR (по часовому поясу сервиса), а сегодня прохода ещё не было. */
  function due(tz = config.DIGEST_TZ || 'Europe/Moscow') {
    if (config.AGENT_ENABLED === false) return false;
    const now = clock();
    const part = (o) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...o }).format(now);
    const hour = Number(part({ hour: '2-digit', hourCycle: 'h23' }));
    if (hour !== (config.AGENT_HOUR ?? 3)) return false;
    const today = part({ year: 'numeric', month: '2-digit', day: '2-digit' });
    const last = db.prepare("SELECT started_at FROM agent_runs WHERE reason = 'night' ORDER BY id DESC LIMIT 1").get();
    return !last || new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(last.started_at)) !== today;
  }

  return { run, plan, view, resolve, markRead, due, report, reportText, idle: () => running || Promise.resolve() };
}

module.exports = { createProductAgent, passportPairs, modelVariants, NICHE_LABEL };
