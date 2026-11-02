// Модели из реестра для компьютерной техники (ноутбук, системный блок, моноблок, монитор).
//
// Зачем. ТЗ на компьютеры в госзакупках пишут под реестр российской промышленной продукции (ПП 719 / ПП 1875):
// процессор, память, диск, порты — так, что подходят модели нескольких российских производителей. Поиск по
// характеристикам в магазинах находит в основном импортные модели, которые не проходят. Поэтому подбор идёт
// от производителей: их модели сверяются с ТЗ, а подошедшие ищутся у поставщиков по названию.
//
// Откуда модели. Сам реестр (gisp.gov.ru) закрыт для программ, поэтому страницы моделей читаются с сайтов
// производителей (config/registry-makers.json) — по их картам сайта или страницам разделов, раз в две недели.
// Хранятся в той же отдельной базе, что каталог страниц поставщиков (suppliers.db): её можно удалить и собрать заново.
//
// Важно. На странице производителя — модель с вариантами конфигурации (процессор i3/i5/i7, память 8–64 ГБ):
// «подходит» значит «в нужной конфигурации модель подходит», конфигурацию подтверждает поставщик или дилер.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPageFetcher, FetchSkipped } = require('./fetch-page');
const { specsFromPage, productText, titleStart } = require('./product');
const { specOf } = require('./spec');

const MAKERS_FILE = path.join(__dirname, '..', '..', 'config', 'registry-makers.json');
const UA = 'Mozilla/5.0 (compatible; tender-ai/0.1; supplier search for public procurement)';

const KIND_LABEL = { laptop: 'ноутбук', pc: 'системный блок (ПК)', aio: 'моноблок', monitor: 'монитор' };
// Не компьютеры: принадлежности, серверы, планшеты, платы
const OTHER = /мыш[ьи]|клавиатур|материнск|сервер|планшет|смартфон|телефон|накопител|схд|хранени[яе] данных|коммутатор|маршрутизатор|точк[аи] доступа|подставк|сумк|аккумулятор|блок питания|кабел|док-станц|запасн|программ|мфу|принтер|сканер|проектор|бесперебойн|(^|[^а-яё])ибп([^а-яё]|$)|^(реестров|каталог|вс[её]\s)/i;
// Снятые с производства модели не берём: купить их новыми уже не выйдет
const DISCONTINUED = /снят\S*\s+с\s+производства|снят\S*\s+с\s+продаж|архивн\S*\s+модел/i;
// Порядок важен: «Компьютер персональный (моноблок)» — моноблок, а не ПК
const KINDS = [
  ['aio', /моноблок|monoblo|all-in-one|(^|[^a-z])aio(?![a-z])/i],
  ['laptop', /ноутбук|noutbuk|notebook|laptop|aqbook|портативн\S*\s+компьютер|компьютер\S*\s+портативн|mobilnye/i],
  ['monitor', /монитор|monitor/i],
  ['pc', /системн\S*\s+блок|персональн\S*\s+(электронно-)?вычислительн|пэвм|(^|[^а-яё])пк([^а-яё]|$)|компьютер|рабоч\S*\s+станц|автоматизированн\S*\s+рабоч|(^|[^а-яё])арм([^а-яё]|$)|неттоп|desktop|kompyuter|(^|\/)(mini-)?pk(\/|$)|rabochie-stantsii|pevm|blok-sistemnyy|nettop|(^|[^a-z])pc\d/i],
];

const kindByWords = (s) => KINDS.find(([, re]) => re.test(String(s || '')))?.[0] || null;

/**
 * Вид техники на странице модели: по заголовку, потом по адресу, потом по характеристикам
 * (диагональ и аккумулятор — ноутбук, диагональ и процессор — моноблок, только процессор — ПК, только экран — монитор).
 * @returns {'laptop'|'pc'|'aio'|'monitor'|'other'}
 */
function modelKind({ title = '', url = '', text = '', specs = [] }) {
  if (OTHER.test(title)) return 'other';
  const byTitle = kindByWords(title);
  if (byTitle) return byTitle;
  let p = '';
  try { p = decodeURIComponent(new URL(url).pathname); } catch { p = String(url); }
  const byUrl = kindByWords(p);
  if (byUrl) return byUrl;
  const all = `${specs.map((s) => `${s.name} ${s.value}`).join(' ')} ${String(text).slice(0, 8000)}`.toLowerCase();
  const screen = /диагонал|матриц/.test(all);
  const cpu = /процессор/.test(all);
  if (screen && /аккумулятор|батаре/.test(all) && cpu) return 'laptop';
  if (screen && cpu) return 'aio';
  if (/xeon|rdimm|lrdimm|epyc/.test(all)) return 'other'; // сервер
  if (cpu) return 'pc';
  if (screen) return 'monitor';
  return 'other';
}

/**
 * Вид техники позиции закупки — по началу наименования («Поставка …» отбрасывается), иначе по коду КТРУ.
 * @returns {'laptop'|'pc'|'aio'|'monitor'|null} null — не компьютерная техника (мышь, стол под системный блок, планшет)
 */
function itemKind(item) {
  const name = String(item?.name || '').replace(/^\s*поставка\s+/i, '').trim();
  const head = name.split(/\s+/).slice(0, 6).join(' ');
  if (/^(мыш|клавиатур|подставк|стол|тумб|аккумулятор|запасн|кабел|сумк|планшет|систем[аы]\s+(?!блок)|программ|услуг|ремонт|картридж)/i.test(name)) return null;
  const k = kindByWords(head);
  if (k && !(k === 'pc' && /томограф|рентген|инъекц/i.test(name))) return k;
  const code = String(item?.ktru_code || item?.okpd2_code || '');
  if (/^26\.20\.11/.test(code)) return /планшет/i.test(name) ? null : 'laptop';
  if (/^26\.20\.15/.test(code)) return /моноблок/i.test(name) ? 'aio' : 'pc';
  if (/^26\.20\.17/.test(code)) return 'monitor';
  return null;
}

/** Модель без вида техники и кавычек: «Ноутбук «Гравитон» Н15А-Б» → «Гравитон Н15А-Б». */
function modelName(title) {
  return String(title || '').replace(/[«»"“”]/g, ' ')
    .replace(/^\s*(персональн\S*\s+компьютер|компьютер\s+персональн\S*|ноутбук|моноблок|монитор|системный\s+блок|рабочая\s+станция|пэвм|пк|мини-пк|неттоп)\s+/i, '')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Что сказано на странице о реестре: номер реестровой записи или просто упоминание. */
function registryNote(text) {
  const t = String(text || '');
  const num = /(реестр\S*[^.\n]{0,120}?(?:№|номер\S*(?:\s+реестров\S*)?(?:\s+записи)?)\s*\d[\d\\/.-]{3,})/i.exec(t)?.[1];
  if (num) return num.replace(/\s+/g, ' ').replace(/[.-]+$/, '').trim().slice(0, 160);
  return /реестр\S*\s+(российской\s+)?(промышленной\s+продукции|минпромторг|радиоэлектронной)/i.test(t) ? 'на странице сказано о включении в реестр' : null;
}

/**
 * Характеристики из текста страницы, где название и значение стоят на соседних строках, без таблицы
 * («Диагональ экрана (дюйм)» / «23.8″»). Строка-заголовок раздела («Экран»), за которой идёт ещё одно название, — не пара.
 * @returns {Array<{name, value}>}
 */
function linePairs(text, limit = 120) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const strict = (s) => s != null && s.length <= 80 && (/\d/.test(s) || /^(да|нет|есть|отсутству\S*|опционально)$/i.test(s));
  const label = (s) => s != null && s.length >= 3 && s.length <= 70 && /[а-яёa-z]{3}/i.test(s) && !/[.!?:]$/.test(s) && (s.match(/\d/g) || []).length <= 4;
  const out = [];
  for (let i = 0; i < lines.length - 1 && out.length < limit; i++) {
    const [a, b, c] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!label(a) || /^\d/.test(a)) continue;
    if (label(b) && strict(c) && !/^\d/.test(b)) continue; // «Конструкция» / «Поворот на 90°» / «да»: a — заголовок раздела
    const value = strict(b) || (b.length <= 25 && !strict(c) && !(label(b) && strict(c)));
    if (!value) continue;
    out.push({ name: a, value: b.replace(/″|”/g, '"') });
    i++;
  }
  return out;
}

// Объём памяти и накопителей производитель ставит под заказ: в ТЗ «≥ 32 ГБ», на странице — базовая конфигурация.
// Такие требования не отсеивают модель, а остаются «уточнить конфигурацию». Максимум, слоты, кэш — свойства самой модели.
// Операционную систему (или её отсутствие) производитель тоже ставит под заказ.
const CONFIGURABLE = /(объ[её]м|[её]мкост)\S*.{0,40}(оперативн|памят|ssd|hdd|накопител|диск)|(оперативн\S*\s+памят\S*|ssd|hdd|накопител\S*).{0,30}(объ[её]м|[её]мкост)|количество\s+(установленн\S*\s+)?(накопител|модул|ssd|hdd)|операционн\S*\s+систем/i;
const NOT_CONFIGURABLE = /максимальн|допустим|поддерживаем|увеличени|слот|отсек|кэш|видеопамят|графическ/i;
const configurable = (name) => CONFIGURABLE.test(name) && !NOT_CONFIGURABLE.test(name);

const loadMakers = (file = MAKERS_FILE) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).makers || []; } catch { return []; }
};

function createRegistryModels({ dataDir, fetchImpl = fetch, log = console, clock = () => new Date(), makersFile = MAKERS_FILE, minIntervalMs = 1500, maxPerMaker = 250, fetcher = null, retryPauseMs = 30000 } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'suppliers.db'));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS registry_models (url TEXT PRIMARY KEY, maker TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, specs_json TEXT, text TEXT, registry_note TEXT, fetched_at TEXT);
    CREATE INDEX IF NOT EXISTS registry_models_kind ON registry_models (kind);
    CREATE TABLE IF NOT EXISTS registry_makers (maker TEXT PRIMARY KEY, refreshed_at TEXT, models INTEGER NOT NULL DEFAULT 0, status TEXT, note TEXT);`);
  const pages = fetcher || createPageFetcher({ fetchImpl, minIntervalMs });

  async function getText(url) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000), redirect: 'follow' });
    return res.ok ? res.text() : '';
  }
  const locs = (xml) => [...String(xml || '').matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].trim().replace(/&amp;/g, '&'));
  const pathOf = (u) => { try { return decodeURIComponent(new URL(u).pathname); } catch { return ''; } };

  /** Адреса страниц моделей производителя: из карты сайта и со страниц разделов. */
  async function modelUrls(maker) {
    const product = new RegExp(maker.product, 'i');
    const host = String(maker.site).replace(/^www\./, '');
    const sameSite = (u) => { try { const h = new URL(u).hostname.replace(/^www\./, ''); return h === host; } catch { return false; } };
    const found = new Map(); // путь → полный адрес
    // Карта сайта иногда приходит пустой (у Бештау — при чтении подряд за другими сайтами): тогда ещё раз через паузу
    for (let attempt = 0; maker.sitemap && attempt < 2 && !found.size; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, retryPauseMs));
      const queue = [maker.sitemap];
      const seen = new Set();
      while (queue.length && seen.size < 30) {
        const u = queue.shift();
        if (seen.has(u)) continue;
        seen.add(u);
        let xml = '';
        try { xml = await getText(u); } catch { continue; }
        for (const loc of locs(xml)) {
          if (/\.xml(\?|$)/i.test(loc)) queue.push(loc);
          else if (sameSite(loc) && product.test(pathOf(loc))) found.set(pathOf(loc), loc.replace(/^http:/, 'https:'));
        }
      }
    }
    // Разделы: ссылки на модели со страницы раздела; подраздел (его адрес — начало адреса другой модели) читаем тоже
    const listings = [...(maker.listings || [])];
    const read = new Set();
    while (listings.length && read.size < 25) {
      const u = listings.shift();
      if (read.has(u)) continue;
      read.add(u);
      let page;
      try { page = await pages.fetchPage(u); } catch { continue; }
      const links = new Set();
      for (const m of String(page.html || '').matchAll(/href\s*=\s*["']([^"'#?]+)["']/gi)) {
        try { const x = new URL(m[1], u); if (sameSite(x.href) && product.test(decodeURIComponent(x.pathname))) links.add(`${x.origin}${x.pathname}`); } catch { /* битая ссылка */ }
      }
      const list = [...links];
      for (const l of list) {
        const p = pathOf(l);
        if (list.some((o) => o !== l && pathOf(o).startsWith(p))) listings.push(l);
        else found.set(p, l);
      }
    }
    return [...found.values()].slice(0, maxPerMaker);
  }

  /** Перечитать модели одного производителя. Если сайт не ответил — прежние модели остаются. */
  async function refresh(maker) {
    const at = clock().toISOString();
    const urls = await modelUrls(maker);
    const product = new RegExp(maker.product, 'i');
    const rows = [];
    let other = 0;
    let old = 0;
    let failed = 0;
    for (let i = 0; i < urls.length && i < maxPerMaker * 2; i++) {
      const url = urls[i];
      let page;
      try { page = await pages.fetchPage(url); } catch (err) { failed++; if (!(err instanceof FetchSkipped)) log.warn?.(`[registry] ${url}: ${err.message}`); continue; }
      if (page.status && page.status >= 400) { failed++; continue; }
      // Подраздел, а не модель: на странице ссылки на модели «глубже» её адреса — берём их, саму страницу нет
      const own = pathOf(url);
      const children = new Set();
      for (const m of String(page.html || '').matchAll(/href\s*=\s*["']([^"'#?]+)["']/gi)) {
        try { const x = new URL(m[1], url); const p = decodeURIComponent(x.pathname); if (x.hostname === new URL(url).hostname && p !== own && p.startsWith(own) && product.test(p)) children.add(`${x.origin}${x.pathname}`); } catch { /* битая ссылка */ }
      }
      if (children.size) {
        for (const c of children) if (!urls.includes(c)) urls.push(c);
        continue;
      }
      const title = String(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(page.html)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/\s+/g, ' ').trim();
      if (!title) { other++; continue; }
      if (DISCONTINUED.test(title)) { old++; continue; }
      const text = String(page.text || '').slice(titleStart(page.html, page.text || '', title)).slice(0, 30000);
      // Таблицы характеристик нет (вёрстка блоками) — берём пары «название / значение» с соседних строк текста
      let specs = specsFromPage(page.html, 120);
      if (specs.length < 5) specs = [...specs, ...linePairs(text)].slice(0, 150);
      const kind = modelKind({ title, url, text, specs });
      if (kind === 'other') { other++; continue; }
      rows.push({ url, kind, title, specs, text, note: registryNote(page.text) });
    }
    const status = rows.length ? 'ok' : 'empty';
    const note = rows.length ? `моделей ${rows.length}${other ? `, не компьютеры ${other}` : ''}${old ? `, сняты с производства ${old}` : ''}${failed ? `, не открылись ${failed}` : ''}` : (urls.length ? `страницы моделей не прочитались (${failed} из ${urls.length})` : 'не нашлось адресов моделей');
    db.exec('BEGIN');
    try {
      if (rows.length) {
        db.prepare('DELETE FROM registry_models WHERE maker = ?').run(maker.id);
        const ins = db.prepare('INSERT OR REPLACE INTO registry_models (url, maker, kind, title, specs_json, text, registry_note, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const r of rows) ins.run(r.url, maker.id, r.kind, r.title, JSON.stringify(r.specs), r.text, r.note, at);
      }
      db.prepare(`INSERT INTO registry_makers (maker, refreshed_at, models, status, note) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(maker) DO UPDATE SET refreshed_at = excluded.refreshed_at, models = CASE WHEN excluded.status = 'ok' THEN excluded.models ELSE registry_makers.models END, status = excluded.status, note = excluded.note`)
        .run(maker.id, at, rows.length, status, note);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { maker: maker.id, models: rows.length, status, note };
  }

  let running = null;
  /** Обновить производителей, которых не читали дольше maxAgeDays (не ответившего — через сутки). */
  function refreshAll({ maxAgeDays = 14, only = null } = {}) {
    if (running) return running;
    running = (async () => {
      const out = [];
      const now = clock().getTime();
      for (const maker of loadMakers(makersFile)) {
        if (only && !only.includes(maker.id)) continue;
        const row = db.prepare('SELECT refreshed_at, status FROM registry_makers WHERE maker = ?').get(maker.id);
        const age = row?.refreshed_at ? now - new Date(row.refreshed_at).getTime() : Infinity;
        if (!only && age < (row?.status === 'ok' ? maxAgeDays : 1) * 86400000) continue;
        try {
          const r = await refresh(maker);
          out.push(r);
          log.log?.(`[registry] ${maker.name}: ${r.note}`);
        } catch (err) {
          out.push({ maker: maker.id, status: 'error', note: err.message });
          log.warn?.(`[registry] ${maker.name}: ${err.message}`);
        }
      }
      return out;
    })().finally(() => { running = null; });
    return running;
  }

  const makerNames = () => Object.fromEntries(loadMakers(makersFile).map((m) => [m.id, m.name]));

  /** Модели одного вида техники. */
  function list(kind) {
    const names = makerNames();
    return db.prepare('SELECT url, maker, kind, title, specs_json, text, registry_note, fetched_at FROM registry_models WHERE kind = ? ORDER BY maker, title').all(kind)
      .map((r) => ({ url: r.url, maker: r.maker, maker_name: names[r.maker] || r.maker, kind: r.kind, title: r.title, specs: JSON.parse(r.specs_json || '[]'), text: r.text || '', registry_note: r.registry_note, fetched_at: r.fetched_at }));
  }

  /** Что в каталоге: по производителю — сколько моделей и когда читали. */
  function status() {
    const names = makerNames();
    const makers = db.prepare('SELECT maker, refreshed_at, models, status, note FROM registry_makers ORDER BY models DESC').all().map((m) => ({ ...m, name: names[m.maker] || m.maker }));
    const kinds = Object.fromEntries(db.prepare('SELECT kind, COUNT(*) AS n FROM registry_models GROUP BY kind').all().map((r) => [r.kind, r.n]));
    return { makers, kinds, models: Object.values(kinds).reduce((a, b) => a + b, 0), running: Boolean(running) };
  }

  return { refresh, refreshAll, list, status, modelUrls, close: () => db.close(), idle: () => running || Promise.resolve() };
}

/**
 * Подобрать модели под позицию: сначала все модели этого вида сверяются по таблице характеристик и справочникам
 * (без нейросети, бесплатно), не подходящие отсеиваются; лучшие top — сверка нейросетью по тексту страницы.
 * @param matchOffer функция сверки (match.js)
 * @returns {Promise<{kind, considered, rejected, reasons: Array<{reason, n}>, models: object[], others: object[]}>}
 */
async function pickModels(item, models, { matchOffer, llm, system, top = 5, specComplete = true, partShare } = {}) {
  const all = specOf(item).required || [];
  // Объём памяти и дисков (кроме мониторов) — по конфигурации: в сверку не идут, в итоге — «уточнить у поставщика»
  // только у компьютеров: у монитора, картриджа, накопителя объём — свойство самой модели
  const byConfig = ['laptop', 'pc', 'aio'].includes(models[0]?.kind) ? all.filter((r) => configurable(r.name)) : [];
  const skip = new Set(byConfig.map((r) => r.name));
  const keep = (list) => (list || []).filter((c) => !skip.has(c.name));
  const core = byConfig.length ? { ...item, characteristics: keep(item.characteristics), ...(item.spec?.required ? { spec: { ...item.spec, required: keep(item.spec.required) } } : {}) } : item;
  const req = all.filter((r) => !skip.has(r.name));
  // Характеристики строкой «название: значение» в начале текста: так их видят и сверка чисел, и нейросеть
  const textOf = (m, max = 5000) => {
    const head = m.specs.length ? `Характеристики: ${m.specs.map((s) => `${s.name}: ${s.value}`).join('; ')}`.slice(0, Math.round(max / 2)) : '';
    return `${head}\n${productText({ text: m.text, html: '' }, { title: m.title, requirements: req, max: max - head.length })}`.trim();
  };
  const withConfig = (r) => {
    if (!byConfig.length || !r.checks) return r;
    const rows = [...r.checks.rows, ...byConfig.map((x) => ({ name: x.name, need: String(x.value), verdict: 'unknown', found: 'по конфигурации: производитель собирает модель в разных вариантах — уточните у поставщика', config: true }))];
    const match = r.match === 'соответствует' ? 'частично' : r.match;
    return { ...r, match, checks: { ...r.checks, rows, total: r.checks.total + byConfig.length, unknown: r.checks.unknown + byConfig.length, by_config: byConfig.length } };
  };
  const short = (m, r) => ({ maker: m.maker, maker_name: m.maker_name, title: m.title, model: m.model || modelName(m.title), url: m.url, registry_note: m.registry_note, match: r.match, notes: (r.notes || []).slice(0, 4),
    ...(m.id != null ? { product_id: m.id, from_registry: Boolean(m.from_registry), from_kb: Boolean(m.from_kb), from_official: Boolean(m.from_official), price: m.price || null, sources: m.sources || 0 } : {}),
    checks: r.checks ? { total: r.checks.total, confirmed: r.checks.confirmed, failed: r.checks.failed, unknown: r.checks.unknown, conflict: r.checks.conflict, by_config: r.checks.by_config || 0, rows: r.checks.rows } : null });
  const first = [];
  const reasons = new Map();
  for (const m of models) {
    const r = withConfig(await matchOffer(core, { title: m.title, text: textOf(m), specs: m.specs }, { llm: null, offline: true, specComplete, partShare }));
    if (r.match === 'не соответствует') {
      const why = String(r.notes?.[0] || 'не подходит').replace(/^Не подходит:\s*/, '').replace(/,?\s*у товара .*$/, '')
        .replace(/^в ТЗ модель\s+(\S+?)[,.]?(\s.*)?$/i, 'другая модель (в ТЗ — $1)').slice(0, 90);
      reasons.set(why, (reasons.get(why) || 0) + 1);
      continue;
    }
    first.push({ m, r, score: (r.checks?.confirmed || 0) - 2 * (r.checks?.conflict || 0) });
  }
  first.sort((a, b) => b.score - a.score || a.m.title.localeCompare(b.m.title));
  // Нейросетью — сначала лучшая модель каждого производителя, потом остальные по очереди: у одних производителей
  // характеристики в таблице (их таблица подтверждает больше), у других — текстом, и без этого им не досталось бы места
  const seenMaker = new Set();
  const leads = first.filter((x) => { const k = String(x.m.maker || '').toLowerCase(); return !seenMaker.has(k) && seenMaker.add(k); });
  // Модели из реестра и найденные в магазинах — через одну: таблица магазина подтверждает больше, но ТЗ на компьютеры
  // обычно написано под реестр, и без чередования моделям из реестра не досталось бы места
  const reg = leads.filter((x) => x.m.from_registry);
  const other = leads.filter((x) => !x.m.from_registry);
  const lead = reg.length && other.length ? reg.flatMap((x, i) => [x, other[i]]).concat(other.slice(reg.length)).filter(Boolean) : leads;
  const ranked = [...lead, ...first.filter((x) => !lead.includes(x))];
  const out = [];
  for (const { m, r } of ranked.slice(0, top)) {
    let res = r;
    if (llm && system) {
      const ask = (max) => matchOffer(core, { title: m.title, text: textOf(m, max), specs: m.specs }, { llm, system, specComplete, partShare }).then(withConfig).catch(() => null);
      res = await ask(5000);
      // GigaChat на длинном тексте иногда не отвечает (отказ модерации, таймаут) — второй раз короче
      if (!res || res.checks?.packs_failed) res = (await ask(3000)) || res || r;
    }
    out.push(short(m, res));
  }
  const ORDER = { 'соответствует': 0, 'частично': 1, 'не хватает данных': 2, 'не соответствует': 3 };
  out.sort((a, b) => (ORDER[a.match] ?? 3) - (ORDER[b.match] ?? 3) || (b.checks?.confirmed || 0) - (a.checks?.confirmed || 0));
  return {
    considered: models.length,
    rejected: models.length - first.length,
    reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, n]) => ({ reason, n })),
    models: out,
    others: ranked.slice(top, top + 10).map(({ m, r }) => ({ ...short(m, r), checks: r.checks ? { total: r.checks.total, confirmed: r.checks.confirmed } : null })),
  };
}

module.exports = { createRegistryModels, pickModels, modelKind, itemKind, modelName, registryNote, linePairs, configurable, loadMakers, KIND_LABEL };
