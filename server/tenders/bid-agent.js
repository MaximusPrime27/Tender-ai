// Агент заявок: каждое утро сам готовит заявки по своим настройкам — отбирает закупки, читает документацию, ищет
// поставщиков, выбирает товар, считает прибыль и точку «не ниже», заполняет характеристики и собирает пакет.
// Подтверждения, подпись и подача — за человеком: агент ничего не подаёт, не подписывает и не пишет поставщикам.
//
// Учится он на трёх вещах:
//   1) свои ошибки — после каждой закупки перепроверяет себя (товар дороже цены заказчика, чужой картридж, «100 Мбит»
//      при «10/100/1000», пустые и «на проход» значения заявки…) и на поправках человека (сменил товар — ошибка выбора);
//   2) итоги торгов — по каждой подготовленной и отсеянной закупке после аукциона смотрит контракт: за сколько выиграли,
//      какое было снижение и заработали бы мы при своей себестоимости. Снижение по нише дальше берётся из этих итогов;
//   3) решения человека «беру / не беру» — вместе с итогами: упущенная выгода и неудачные решения видны обоим.
//
// Настройки — свои, отдельно от ленты и профиля: ниши, цена, сложность, площадки, регионы, запас дней, маржа, число
// закупок за утро. Задание можно написать текстом — агент переводит его в настройки и показывает, как понял.

const { cartridgesForDevice } = require('../offers/device-cartridges');
const { brandOf } = require('../offers/maker-search');
const { REGIONS, regionFromText } = require('../offers/logistics');
const { parseContract } = require('./benchmark');
const { checkNumbers, fitsNumeric, kindMismatch, priceBelowContracts } = require('../offers/match');
const { calculate } = require('./economics');
const { specOf } = require('../offers/spec');

// Российские марки (товар с записью в реестре российской промышленной продукции у них обычен): по ним товар
// без указанной страны считается российским. Остальное без страны — «не известно».
const RU_BRANDS = /(?<![a-zа-я])(aquarius|аквариус|катюша|katusha|бештау|beshtau|iru|graviton|гравитон|kraftway|крафтвей|depo|yadro|ядро|rikor|рикор|eltex|элтекс|f\+\s*imaging|sitronics|ситроникс|норбит|delta\s+computers|irbis|ирбис|baikal|байкал)(?![a-zа-я])/i;
/** Запрет допуска иностранных товаров (ПП № 1875): импорт не допускают вовсе, в отличие от ограничения. */
const natBan = (text) => /запрет\S*\s+допуска/i.test(String(text || ''));
/** Происхождение товара: 'ru', 'foreign' или null — по стране в характеристиках или российской марке в названии. */
function originOf(offer) {
  const country = (offer?.specs || []).find((x) => /страна/i.test(String(x.name)))?.value || '';
  if (/росси|russia/i.test(country)) return 'ru';
  if (country && !/не\s+указ|—/i.test(country)) return 'foreign';
  if (RU_BRANDS.test(String(offer?.title || ''))) return 'ru';
  return null;
}

const DAY = 86400000;
const DEFAULTS = {
  enabled: true, task: '', niches: ['office', 'computers'], price_min: null, price_max: 150000,
  difficulty: ['simple', 'medium'], laws: ['44'], platforms: 'mine', regions: [], min_days: 3, per_run: 5, start_hour: 5,
  margin_min: 5, margin_max: null, profit_min: 1000, foreign_when_restricted: true, max_minutes: 150, max_delivery_days: null,
};
const DIFF_ORDER = { simple: 0, medium: 1, complex: 2, '': 3 };
const DIFF_LABEL = { simple: 'простые', medium: 'средние', complex: 'сложные' };

/** Настройки с проверкой: только известные поля, числа — числами. */
function cleanSettings(raw = {}, base = DEFAULTS) {
  const s = { ...base };
  const num = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled;
  if (typeof raw.task === 'string') s.task = raw.task.slice(0, 2000);
  if (Array.isArray(raw.niches)) s.niches = [...new Set(raw.niches.map(String).filter((x) => /^[a-z0-9-]{1,40}$/.test(x)))];
  for (const k of ['price_min', 'price_max', 'margin_min', 'margin_max', 'profit_min', 'max_delivery_days']) if (k in raw) s[k] = num(raw[k]);
  for (const k of ['min_days', 'per_run', 'start_hour', 'max_minutes']) if (k in raw && num(raw[k]) != null) s[k] = Math.max(0, Math.round(num(raw[k])));
  s.per_run = Math.min(20, Math.max(1, s.per_run));
  s.start_hour = Math.min(23, s.start_hour);
  if (Array.isArray(raw.difficulty)) s.difficulty = raw.difficulty.filter((d) => d in DIFF_ORDER && d);
  if (!s.difficulty.length) s.difficulty = ['simple', 'medium'];
  if (Array.isArray(raw.laws)) s.laws = raw.laws.filter((l) => ['44', '223', 'com'].includes(String(l))).map(String);
  if (!s.laws.length) s.laws = ['44'];
  if (raw.platforms === 'mine' || raw.platforms === 'all') s.platforms = raw.platforms;
  if (Array.isArray(raw.regions)) s.regions = raw.regions.map(Number).filter((r) => r >= 1 && r <= 99);
  if (typeof raw.foreign_when_restricted === 'boolean') s.foreign_when_restricted = raw.foreign_when_restricted;
  return s;
}

/**
 * Задание текстом → настройки. «Картриджи и оргтехника, Москва и область, до 150 тыс., простые, маржа от 8%,
 * 5 закупок» — понятое перечисляется в ответе; непонятое остаётся прежним.
 * @param niches [{id, title, keywords}] — направления и ниши, из которых выбирать
 */
function parseTask(text, current = DEFAULTS, niches = []) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  const s = { ...current, task: String(text || '') };
  const said = [];
  const money = (n, unit) => Math.round(Number(String(n).replace(/\s/g, '').replace(',', '.')) * (/млн/.test(unit || '') ? 1e6 : /тыс|т\.?\s*р|к\b|k\b/.test(unit || '') ? 1000 : 1));
  const max = /(?:до|не дороже|не более|дешевле|меньше)\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(млн|тыс\S*|т\.?\s*р|к|k)?(?!\s*%)/.exec(t);
  if (max && !/\d\s*(дн|день|дня|закуп|%)/.test(t.slice(max.index, max.index + max[0].length + 6))) { s.price_max = money(max[1], max[2]); said.push(`цена закупки до ${s.price_max.toLocaleString('ru-RU')} ₽`); }
  const min = /(?:от|дороже|не дешевле)\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(млн|тыс\S*|т\.?\s*р|к|k)(?!\s*%)/.exec(t);
  if (min) { s.price_min = money(min[1], min[2]); said.push(`цена закупки от ${s.price_min.toLocaleString('ru-RU')} ₽`); }
  const mMin = /марж\S*\s*(?:от|не менее|не ниже|минимум)?\s*(\d+(?:[.,]\d+)?)\s*%/.exec(t);
  if (mMin) { s.margin_min = Number(mMin[1].replace(',', '.')); said.push(`маржа не меньше ${s.margin_min}%`); }
  const mMax = /марж\S*[^.;]*?до\s*(\d+(?:[.,]\d+)?)\s*%/.exec(t);
  if (mMax) { s.margin_max = Number(mMax[1].replace(',', '.')); said.push(`маржа не больше ${s.margin_max}% (выше — подозрительно)`); }
  const diff = [];
  if (/прост/.test(t)) diff.push('simple');
  if (/средн/.test(t)) diff.push('medium');
  if (/сложн/.test(t) && !/несложн/.test(t)) diff.push('complex');
  if (/несложн/.test(t)) diff.push('simple', 'medium');
  if (/любой сложност|любые/.test(t)) diff.push('simple', 'medium', 'complex');
  if (diff.length) { s.difficulty = ['simple', 'medium', 'complex'].filter((d) => diff.includes(d)); said.push(`сложность: ${s.difficulty.map((d) => DIFF_LABEL[d]).join(', ')}`); }
  // «10 закупок», «10 выгодных закупок», «3 выгодные заявки» — до двух слов между числом и словом; «150 тыс.» — не число закупок
  const count = /(?<![\d.,])(\d{1,2})\s*(?:[а-яё-]+\s+){0,2}(?:закуп|заявк|штук)/.exec(t);
  if (count) { s.per_run = Math.min(20, Number(count[1])); said.push(`закупок за утро: ${s.per_run}`); }
  const days = /(?:не менее|минимум|запас\S*|за)\s*(\d{1,2})\s*(?:дн|день|дня)/.exec(t);
  if (days && !/достав/.test(t.slice(Math.max(0, days.index - 25), days.index))) { s.min_days = Number(days[1]); said.push(`до подачи не меньше ${s.min_days} дн.`); }
  // «доставка не более 2-3 дней», «доставка до 3 дн.» — берётся верхняя граница
  const deliv = /достав\S*[^.;\d]{0,25}?(?:\d{1,2}\s*[-–]\s*)?(\d{1,2})\s*(?:дн|день|дня|сут)/.exec(t);
  if (deliv) { s.max_delivery_days = Number(deliv[1]); said.push(`доставка не дольше ${s.max_delivery_days} дн.`); }
  const laws = [];
  if (/44/.test(t)) laws.push('44');
  if (/223/.test(t)) laws.push('223');
  if (/коммерч/.test(t)) laws.push('com');
  if (laws.length) { s.laws = laws; said.push(`закупки: ${laws.map((l) => (l === 'com' ? 'коммерческие' : `${l}-ФЗ`)).join(', ')}`); }
  if (/вся россия|по всей россии|любой регион|все регионы/.test(t)) { s.regions = []; said.push('регионы: вся Россия'); } else {
    const regs = [];
    if (/москв/.test(t)) regs.push(77);
    if (/(москв\S* и область|подмосков|московск\S* обл)/.test(t)) regs.push(50);
    if (/петербург|спб|питер/.test(t)) regs.push(78);
    if (/(ленинградск|петербург\S* и область)/.test(t)) regs.push(47);
    for (const [code, [city]] of Object.entries(REGIONS)) if (![77, 78].includes(Number(code)) && city && city.length > 4 && t.includes(city.toLowerCase().slice(0, -1))) regs.push(Number(code));
    if (regs.length) { s.regions = [...new Set(regs)]; said.push(`регионы: ${s.regions.join(', ')}`); }
  }
  if (/все площадк|любые площадк/.test(t)) { s.platforms = 'all'; said.push('площадки: все'); } else if (/мои площадк|где есть регистрац/.test(t)) { s.platforms = 'mine'; said.push('площадки: мои'); }
  if (/только российск|без иностран/.test(t)) { s.foreign_when_restricted = false; said.push('при нацрежиме — только российский товар'); }
  const found = niches.filter((n) => {
    const words = [n.title, ...(n.keywords || [])].map((w) => String(w).toLowerCase().replace(/ё/g, 'е')).filter((w) => w.length >= 4);
    return words.some((w) => t.includes(w.length > 6 ? w.slice(0, -2) : w));
  }).map((n) => n.id);
  if (found.length) { s.niches = [...new Set(found)]; said.push(`ниши: ${found.map((id) => niches.find((n) => n.id === id)?.title || id).join(', ')}`); }
  return { settings: cleanSettings(s, current), understood: said };
}

/**
 * Цена, ниже которой на аукционе опускаться нельзя: при себестоимости cost — безубыточность и цена с маржой margin.
 * Налог: УСН 6% — с выручки, УСН 15% и ОСН — с прибыли.
 */
function floorPrice(cost, marginPct, taxMode = 'usn15') {
  const m = Math.max(0, Number(marginPct) || 0) / 100;
  if (!(cost > 0)) return { break_even: null, with_margin: null };
  if (taxMode === 'usn6') return { break_even: Math.ceil(cost / 0.94), with_margin: m < 0.94 ? Math.ceil(cost / (0.94 - m)) : null };
  const k = taxMode === 'osn' ? 0.8 : 0.85;
  return { break_even: Math.ceil(cost), with_margin: m < k ? Math.ceil((k * cost) / (k - m)) : null };
}
/** Прибыль после налога при выручке revenue и себестоимости cost. */
function profitAt(revenue, cost, taxMode = 'usn15') {
  if (taxMode === 'usn6') return Math.round(revenue * 0.94 - cost);
  const k = taxMode === 'osn' ? 0.8 : 0.85;
  return Math.round(revenue > cost ? k * (revenue - cost) : revenue - cost);
}

/**
 * Итог торгов по закупке: цена контракта против нашей себестоимости.
 * @returns {{status, contract_price, decline_pct, profit, margin_pct}} status: would_profit — выиграли бы с прибылью
 *   не меньше минимума, thin — с прибылью меньше минимума, below_cost — победитель ушёл ниже нашей себестоимости
 */
function judgeOutcome({ nmck, contractPrice, cost, taxMode = 'usn15', marginMin = 0 }) {
  if (!(contractPrice > 0) || !(nmck > 0)) return null;
  const decline = Math.round((1 - contractPrice / nmck) * 1000) / 10;
  if (!(cost > 0)) return { status: 'no_cost', contract_price: contractPrice, decline_pct: decline, profit: null, margin_pct: null };
  const profit = profitAt(contractPrice, cost, taxMode);
  const margin = Math.round((profit / contractPrice) * 1000) / 10;
  return { status: profit <= 0 ? 'below_cost' : margin >= marginMin ? 'would_profit' : 'thin', contract_price: contractPrice, decline_pct: decline, profit, margin_pct: margin };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

function createBidAgent({ repo, analyses = null, source = null, offers = null, details = null, bids = null, bidCounts = null, charService = null, checker = null, journal = null, application = null, packager = null, outcomes = null, config = {}, notify = null, clock = () => new Date(), log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 10000 }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS bid_agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, reason TEXT,
      settings_json TEXT, stats_json TEXT, read_at TEXT);
    CREATE TABLE IF NOT EXISTS bid_agent_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, tender_id INTEGER NOT NULL, status TEXT NOT NULL, step TEXT,
      reason TEXT, summary_json TEXT, findings_json TEXT, decision TEXT, decision_note TEXT, decided_at TEXT,
      outcome_json TEXT, outcome_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS bid_agent_items_tender ON bid_agent_items(tender_id);
    CREATE TABLE IF NOT EXISTS bid_agent_lessons (
      code TEXT PRIMARY KEY, title TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, fixed INTEGER NOT NULL DEFAULT 0,
      last_at TEXT, example_tender INTEGER, example_text TEXT);`);
  const now = () => clock().toISOString();
  const KEY = 'bid_agent:settings';
  const settings = () => { try { return cleanSettings(JSON.parse(repo.getSetting(KEY) || '{}')); } catch { return cleanSettings({}); } };
  const saveSettings = (raw) => { const s = cleanSettings(raw, settings()); repo.setSetting(KEY, JSON.stringify(s)); return s; };

  /** Ниши, из которых выбирать: направления профиля (включённые и нет). */
  function niches() {
    const p = repo.getProfile();
    return (p.directions || []).map((d) => ({ id: d.id, title: d.title, short: d.short, enabled: d.enabled !== false, keywords: (d.keywords || []).filter((w) => !String(w).startsWith('-')).slice(0, 12) }));
  }

  // ---------- обучение: снижение цены по нише из итогов торгов ----------
  function learnedDecline(direction) {
    const rows = db.prepare(`SELECT i.outcome_json FROM bid_agent_items i JOIN tenders t ON t.id = i.tender_id
      WHERE i.outcome_json IS NOT NULL AND t.direction = ?`).all(direction);
    const d = rows.map((r) => { try { return JSON.parse(r.outcome_json).decline_pct; } catch { return null; } }).filter((x) => x != null && x >= 0 && x < 80);
    return d.length >= 3 ? { pct: Math.round(median(d) * 10) / 10, samples: d.length } : null;
  }
  /** Ошибка агента: счётчик по коду, пример — последняя закупка. */
  function lesson(code, title, tenderId, text) {
    db.prepare(`INSERT INTO bid_agent_lessons (code, title, count, last_at, example_tender, example_text) VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET count = count + 1, title = excluded.title, last_at = excluded.last_at, example_tender = excluded.example_tender, example_text = excluded.example_text`)
      .run(code, title, now(), tenderId, String(text || '').slice(0, 300));
    journal?.lesson('bid', code, title, { tenderId, text, source: 'self' });
  }

  // ---------- отбор ----------
  /** Закупки по настройкам: ниши, цена, сложность, площадки, регионы, запас дней; ещё не готовившиеся агентом. */
  function candidates(s = settings(), limit = 60) {
    const nowIso = now();
    const mine = s.platforms === 'mine' ? (repo.getProfile().my_platforms || []) : [];
    const platforms = mine.length ? [...mine, ''] : undefined;
    // не получилось (лимит поиска, документы не скачались) — берём снова; разобранные — нет
    const seen = new Set(db.prepare("SELECT DISTINCT tender_id FROM bid_agent_items WHERE created_at >= ? AND status != 'error'").all(new Date(clock().getTime() - 30 * DAY).toISOString()).map((r) => r.tender_id));
    const out = [];
    for (const direction of s.niches.length ? s.niches : [undefined]) {
      for (const law of s.laws) {
        const r = repo.listTenders({ direction, law, platforms, priceMin: s.price_min ?? undefined, priceMax: s.price_max ?? undefined, difficulty: s.difficulty, sort: 'score', limit: 200, nowIso });
        for (const t of r.items || r) {
          const deadline = t.deadline_at || t.deadline_from;
          if (!deadline || new Date(deadline).getTime() - clock().getTime() < s.min_days * DAY) continue;
          if (s.regions.length && t.region != null && !s.regions.includes(Number(t.region))) continue;
          if (seen.has(t.id) || out.some((x) => x.id === t.id)) continue;
          out.push(t);
        }
      }
    }
    // простые — первыми, затем по оценке и дешевле
    out.sort((a, b) => (DIFF_ORDER[a.difficulty || ''] ?? 3) - (DIFF_ORDER[b.difficulty || ''] ?? 3) || (b.score ?? 0) - (a.score ?? 0) || (a.price ?? 0) - (b.price ?? 0));
    return out.slice(0, limit);
  }

  // ---------- шаги прогона ----------
  async function waitFor(check, minutes) {
    const until = Date.now() + minutes * 60000;
    for (;;) {
      const r = await check();
      if (r) return r;
      if (Date.now() > until) return null;
      await sleep(pollMs);
    }
  }
  async function ensureAnalysis(tender) {
    let a = tender.analysis_id ? repo.getAnalysis(tender.analysis_id) : null;
    if (!a || a.status === 'error') {
      const id = analyses.startFromTender({ tender, source });
      repo.setTenderAnalysis(tender.id, id);
      a = { id, status: 'queued' };
    }
    if (a.status === 'done') return a;
    // Ждём разбор: 25 минут с начала чтения (скан на 50 страниц распознаётся около 20 минут), а пока разбор стоит
    // в очереди за чужим — время не идёт; всего не дольше 50 минут. Раньше 15 минут считались от постановки в очередь,
    // и закупка за долгим сканом другой закупки уходила в ошибку, не начав читаться.
    const hardUntil = Date.now() + 50 * 60000;
    let until = null;
    for (;;) {
      const x = repo.getAnalysis(a.id);
      if (x && ['done', 'error'].includes(x.status)) return x;
      if (x && x.status !== 'queued' && until == null) until = Date.now() + 25 * 60000;
      if (Date.now() > Math.min(until ?? Infinity, hardUntil)) return null;
      await sleep(pollMs);
    }
  }
  async function ensureSearch(tender, fresh = false) {
    const last = repo.lastOfferSearch(tender.id);
    // поиск, урезанный суточным лимитом (только бесплатные источники), не переиспользуем — ищем заново
    const limited = (last?.log || []).some((l) => /суточный лимит/i.test(String(l.text)));
    if (!fresh && last && last.status === 'done' && !limited && clock().getTime() - new Date(last.finished_at || last.started_at).getTime() < 3 * DAY) return last;
    const id = last && ['queued', 'running'].includes(last.status) ? last.id : offers.start(tender.id);
    return waitFor(() => { const x = repo.getOfferSearch(id); return x && ['done', 'error'].includes(x.status) ? x : null; }, 25);
  }
  /**
   * Товар позиции: выбранный поиском («соответствует» по всем требованиям) или самый дешёвый «частично» без «нет»
   * не дороже цены заказчика и в наличии — с пометкой, что часть требований не подтверждена.
   */
  // Предел доставки строгий, только когда срок назвал продавец. Срок по тарифной сетке перевозчика — грубая оценка
  // (Москва → Петербург по ней 4 дня, на деле 1–3): такой товар не отбрасываем, а предупреждаем.
  const tooLong = (o, s) => s?.max_delivery_days != null && Number(o?.delivery_days) > s.max_delivery_days;
  const slow = (o, s) => tooLong(o, s) && !o.delivery_estimated;
  function pickOffers(tender, s, exclude = new Set()) {
    const picked = [];
    const items = repo.getItems(tender.id);
    // В закупке из нескольких позиций одну можно продать дешевле её закупки, если прибыльна закупка в целом: дороже цены
    // заказчика (до 1,5 раза) берём, когда дешевле нет, — решает прибыль всей закупки. В одной позиции — только не дороже.
    const cap = (item) => (item.unit_price > 0 ? item.unit_price * (items.length > 1 ? 1.5 : 1) : Infinity);
    const over = (item, o) => item.unit_price > 0 && (o.unit_price ?? o.price) > item.unit_price;
    // сколько требований ТЗ у товара не подтверждено страницей продавца
    const unconfirmed = (o) => (o.match_checks?.rows || []).filter((r) => r.verdict !== 'yes').length;
    for (const item of items) {
      const models = deviceModels(item);
      const cur = item.purchase_offer_id ? repo.getOffer(item.purchase_offer_id) : null;
      // выбор человека не трогаем (замечания покажут, если с ним что-то не так); выбор поиска — если прошёл перепроверку
      // частично подходящий выбор поиска не держим: среди найденных может быть подтверждённый лучше (25.10, бахилы)
      if (cur && (item.purchase_selected_by === 'user' || (!exclude.has(cur.id) && cur.match !== 'частично' && suitable(item, cur, models) && !slow(cur, s)))) { picked.push({ item, offer: cur, how: item.purchase_selected_by === 'user' ? 'человек' : 'поиск' }); continue; }
      const cands = repo.getOffers(tender.id).filter((o) => o.item_id === item.id && o.source !== 'contracts' && ['соответствует', 'частично'].includes(o.match) && o.price > 0
        && !(o.match_checks?.rows || []).some((r) => r.verdict === 'no') && !/нет в наличии/i.test(String(o.availability || ''))
        && !exclude.has(o.id) && (o.unit_price ?? o.price) <= cap(item) && !slow(o, s) && suitable(item, o, models))
        // среди частично подходящих — сначала тот, у кого подтверждено больше требований, потом дешевле (25.10: взяты
        // бахилы за 0,98 ₽ с 2 подтверждёнными из 5, хотя рядом были «с двойным дном» за 1,31 ₽ с 3 из 5)
        .sort((a, b) => Number(over(item, a)) - Number(over(item, b)) || (a.match === 'соответствует' ? 0 : 1) - (b.match === 'соответствует' ? 0 : 1)
          || unconfirmed(a) - unconfirmed(b) || (a.unit_price ?? a.price) - (b.unit_price ?? b.price));
      const best = cands[0];
      if (best) { repo.setItemOffer(item.id, best, 'agent'); picked.push({ item, offer: best, how: `${best.match === 'соответствует' ? 'агент' : 'агент (частично)'}${over(item, best) ? ', дороже цены заказчика' : ''}` }); } else { if (cur && exclude.has(cur.id) && item.purchase_selected_by !== 'user') repo.setItemOffer(item.id, null, 'agent'); picked.push({ item, offer: null, how: null }); }
    }
    return picked;
  }
  /**
   * Старая сверка («соответствует» до исправления чисел) перепроверяется по подписанным характеристикам товара: не
   * проходит — помечается «не соответствует» и в таблице поставщиков (24-дюймовый монитор при «не менее 27»).
   */
  function recheckOffers(tender) {
    const items = repo.getItems(tender.id);
    for (const o of repo.getOffers(tender.id)) {
      if (!['соответствует', 'частично'].includes(o.match)) continue;
      const item = items.find((i) => i.id === o.item_id);
      // вид товара перепроверяется и у старых предложений, отобранных до появления этой проверки (31.10.2026)
      const kind = item && o.source !== 'contracts' ? kindMismatch(item, o) : null;
      if (kind) { repo.setOfferMatch(o.id, { match: 'не соответствует', notes: [`другой товар: ${kind}`, ...(o.match_notes || [])], checks: o.match_checks || null }); continue; }
      if (!o.specs?.length) continue;
      const fail = item && numbersFail(item, o);
      if (fail) repo.setOfferMatch(o.id, { match: 'не соответствует', notes: [`по характеристикам товара: ${fail}`, ...(o.match_notes || [])], checks: o.match_checks || null });
    }
  }
  /**
   * Числовые требования ТЗ (ресурс, диагональ, объём…) у товара подтверждены — условие для замены и вариантов: по
   * названию TL-420E того же семейства, что TL-420H и TL-420X, но ресурс у него вдвое-вчетверо меньше.
   */
  const numbersConfirmed = (o) => !(o.match_checks?.rows || []).some((r) => /\d/.test(String(r.need ?? '')) && r.verdict !== 'yes');
  /** Почему у позиции нет товара — одной фразой: подходящий дороже цены заказчика или подходящего не нашлось вовсе. */
  function whyMissing(tender, item, s) {
    const n = (item.idx ?? 0) + 1;
    const price = (o) => o.unit_price ?? o.price;
    const all = repo.getOffers(tender.id).filter((o) => o.item_id === item.id && o.source !== 'contracts' && o.price > 0);
    const fit = all.filter((o) => ['соответствует', 'частично'].includes(o.match) && !(o.match_checks?.rows || []).some((r) => r.verdict === 'no') && suitable(item, o))
      .sort((x, y) => price(x) - price(y));
    const money = (v) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
    if (!fit.length) return `позиция ${n} — из ${all.length} найденных предложений ни одно не подходит под ТЗ`;
    const limit = item.unit_price > 0 ? item.unit_price * (repo.getItems(tender.id).length > 1 ? 1.5 : 1) : Infinity;
    const cheap = fit.filter((o) => price(o) <= limit);
    if (!cheap.length) return `позиция ${n} — подходящий дороже цены заказчика: от ${money(price(fit[0]))} при ${money(item.unit_price)}`;
    const inStock = cheap.filter((o) => !/нет в наличии/i.test(String(o.availability || '')));
    if (!inStock.length) return `позиция ${n} — подходящий по цене есть только «нет в наличии» (от ${money(price(cheap[0]))})`;
    const fast = inStock.filter((o) => !slow(o, s));
    if (!fast.length) return `позиция ${n} — подходящий в наличии есть, но продавец указал доставку ${inStock[0].delivery_days} дн. — дольше ваших ${s.max_delivery_days} дн.`;
    return `позиция ${n} — подходящий по цене есть, но у него не подтверждены числовые требования ТЗ`;
  }
  /**
   * Обратная перепроверка: предложение отклонено только по числам («Ресурс: нужно 10000, у товара 10400»), а по нынешним
   * правилам сверки эти числа проходят — открываем страницу товара заново и сверяем (без платного поиска). До 5 самых
   * дешёвых на закупку.
   */
  /**
   * Бесплатный добор по модели (решение владельца 31.10.2026): у двух самых дешёвых предложений каждой позиции, где
   * часть требований не подтверждена, — та же модель у других продавцов из своей базы и в каталоге страниц оптовых
   * поставщиков (offers.findByModel без платного поиска). Раньше — только по кнопке «Найти по модели».
   */
  async function enrichByModel(tender, perItem = 2, limit = 8) {
    if (!offers?.findByModel || config.BID_MODEL_ENRICH === false) return 0;
    const byItem = new Map();
    for (const o of repo.getOffers(tender.id)) {
      if (!['частично', 'не хватает данных'].includes(o.match) || !o.url || o.source === 'contracts' || !(o.price > 0)) continue;
      const list = byItem.get(o.item_id) || [];
      list.push(o); byItem.set(o.item_id, list);
    }
    const cands = [...byItem.values()].flatMap((l) => l.sort((a, b) => (a.unit_price ?? a.price) - (b.unit_price ?? b.price)).slice(0, perItem)).slice(0, limit);
    let n = 0;
    for (const o of cands) {
      try { const r = await offers.findByModel(o.id, { paid: false }); if (r?.changed) n++; } catch (err) { log.warn?.(`[bid-agent] добор по модели ${o.id}: ${err.message}`); }
    }
    if (n) journal?.metric('bid', 'model_enriched', n);
    return n;
  }

  async function revisitRejected(tender, limit = 5) {
    if (!offers?.recheck) return 0;
    const items = repo.getItems(tender.id);
    // «Ресурс: нужно 10000, у товара 10400» (числа) и «Не подходит: Ресурс — нужно «10000», у товара «10400 стр.»» (нейросеть)
    const NOTE = /^(.+?)(?::| —) нужно «?(.+?)»?, у товара «?(.+?)»?(?: — подходит)?$/;
    const cands = repo.getOffers(tender.id).filter((o) => o.match === 'не соответствует' && o.url && o.source !== 'contracts').filter((o) => {
      const item = items.find((i) => i.id === o.item_id);
      const notes = (o.match_notes || []).map((n) => NOTE.exec(String(n).replace(/^Не подходит:\s*/, ''))).filter(Boolean);
      if (!item || !notes.length || notes.length !== (o.match_notes || []).filter((n) => /нужно .+, у товара/.test(String(n))).length) return false;
      const req = specOf(item).required || [];
      return notes.every(([, name, , found]) => { const r = req.find((x) => x.name === name.trim()); return r && fitsNumeric(r.value, found) === true; });
    }).sort((a, b) => (a.unit_price ?? a.price) - (b.unit_price ?? b.price)).slice(0, limit);
    let n = 0;
    for (const o of cands) { try { const r = await offers.recheck(o.id); if (r?.ok) n++; } catch (err) { log.warn?.(`[bid-agent] перепроверка ${o.id}: ${err.message}`); } }
    return n;
  }
  /** Модели картриджей к аппарату из своей базы (пусто — позиция не «картридж для аппарата»). */
  const deviceModels = (item) => cartridgesForDevice(db, item.name, item.spec?.required || item.characteristics || []);
  // Семейство картриджа: буквы в конце — ресурс или исполнение (TL-420H, TL-420X, TL-420E — один аппарат, Q2612A/X — тоже)
  const family = (m) => String(m || '').toLowerCase().replace(/[^a-z0-9а-я]/g, '').replace(/[a-zа-я]+$/, '');
  const fitsDevice = (models, offer) => {
    if (!models.length) return true;
    const tl = String(offer?.title || '').toLowerCase().replace(/[^a-z0-9а-я]/g, '');
    return models.some((c) => { const f = family(c.model); return f.length >= 3 && tl.includes(f); });
  };
  /**
   * Числа из ТЗ против подписанных характеристик товара. «Соответствует» прошлой сверки тоже перепроверяем: раньше
   * число брали с любого места страницы — 24-дюймовый монитор проходил как 27-дюймовый по блоку «Похожие товары».
   */
  function numbersFail(item, offer) {
    const req = (specOf(item).required || []).map((r) => ({ name: r.name, value: r.value }));
    if (!req.length || !offer) return null;
    const text = [offer.title || '', ...(offer.specs || []).map((x) => `${x.name}: ${x.value}`)].join('\n');
    return checkNumbers(req, text).fail[0] || null;
  }
  // В 5 раз дешевле цены заказчика — почти наверняка не тот товар (домашний струйный Canon за 6 400 ₽ вместо лазерного
  // МФУ за 48 700): та же граница, что у расчёта сделки, который такую цену не берёт
  // Расходники (картридж, тонер, фотобарабан) — до 20 раз: совместимый дешевле оригинала в 5–15 раз
  const tooCheap = (item, offer) => item.unit_price > 0 && (offer?.unit_price ?? offer?.price) > 0
    && (offer.unit_price ?? offer.price) < item.unit_price * (/картридж|тонер|фотобарабан|драм|чернил/i.test(`${item.name} ${offer.title || ''}`) ? 0.05 : 0.2);
  // частично подходящий — только если подтверждено не меньше 60% требований и хотя бы два: «выгодно» по товару,
  // сверенному на 2 из 5 (бахилы), 4 из 8 (HDMI-разветвитель вместо матричного коммутатора), — ложная находка (аудит 29.10)
  const enoughConfirmed = (offer) => {
    if (offer.match === 'соответствует') return true;
    if (offer.match !== 'частично') return false; // «не хватает данных», «не соответствует» — не подходит, кто бы ни выбрал
    const c = offer.match_checks;
    // «Количество каналов / слоёв / портов» определяет сам товар: не подтверждено — это может быть другой товар
    // (8-канальный регистратор при 32 каналах в ТЗ прошёл как «7 из 10», аудит 29.10)
    if ((c?.rows || []).some((r) => /^\s*количеств/i.test(r.name) && /\d/.test(String(r.need)) && r.verdict !== 'yes')) return false;
    // «Оригинальный» не подтверждён — скорее всего совместимый (GalaPrint вместо оригинала, утро 30.10); названная в ТЗ
    // модель устройства («адаптер DBScar VII») не подтверждена — скорее всего другой товар (терминал сбора данных вместо автосканера)
    const STD = /\b(USB|HDMI|DVI|VGA|D-Sub|DisplayPort|Windows|Linux|Android|DDR\d?|SATA|PCIe|Wi-?Fi|LAN|RJ-?\d+|IP\d*|Bluetooth|LTE|GSM|NFC|SSD|HDD|LED|IPS|VA|TN|Full|HD|UHD|ГОСТ|ISO|IEEE|Type|PoE)\b/gi;
    const named = (v) => /(?=[A-Za-z]*[A-Z])[A-Za-z]{3,}[\s-]?(?:[IVX]{1,4}|\d[\w-]*)(?![a-z])/.test(String(v).replace(STD, ' '));
    if ((c?.rows || []).some((r) => r.verdict !== 'yes' && (/^\s*оригинальн/i.test(String(r.need)) || named(r.need)))) return false;
    return Boolean(c?.total) && c.confirmed >= 2 && c.confirmed / c.total >= 0.6;
  };
  const suitable = (item, offer, models = deviceModels(item)) => !tooCheap(item, offer) && fitsDevice(models, offer) && !numbersFail(item, offer) && enoughConfirmed(offer);

  // ---------- самопроверка и замечания со ссылками ----------
  const href = (tid, step) => `#tender/${tid}/${step}`;
  /**
   * Замечания по закупке. У каждого — ссылка на место: шаг закупки и элемент страницы (CSS-селектор), куда перейти и
   * подсветить. code — для журнала ошибок агента (повторяющиеся — урок).
   */
  function review(tender, { analysis, picked, econ, chars, bid, s }) {
    const out = [];
    const add = (level, code, text, step, sel = null, own = false) => out.push({ level, code, text, href: href(tender.id, step), sel, own });
    const nr = (analysis?.card?.groups || []).flatMap((g) => g.fields || []).find((f) => f.key === 'national_regime' && f.status === 'found');
    const restricted = nr && /ограничен|запрет/i.test(String(nr.value));
    // расхождения в документах — одним замечанием: их бывает 4–6 на закупку, и они заслоняют важное
    const conflicts = (analysis?.card?.groups || []).flatMap((g) => g.fields || []).filter((x) => x.conflict);
    if (conflicts.length === 1) add('warn', 'doc_conflict', `В документах расходятся сведения: «${conflicts[0].label}» — проверьте, какое верное`, 'docs', `tr[data-field="${conflicts[0].key}"]`);
    else if (conflicts.length) out.push({ level: 'warn', code: 'doc_conflict', text: `В документах расходятся сведения (${conflicts.length}): ${conflicts.map((c) => `«${c.label}»`).join(', ')} — проверьте, какое верное`, href: href(tender.id, 'docs'), sel: `tr[data-field="${conflicts[0].key}"]`, own: false, items: conflicts.map((c) => ({ text: c.label, sel: `tr[data-field="${c.key}"]` })) });
    const sc = repo.getDetails(tender.id)?.spec_coverage;
    if (sc && sc.status !== 'complete') add('warn', 'docs_incomplete', `Документация прочитана не полностью: ${sc.summary || sc.status}`, 'docs');
    for (const { item, offer, how } of picked) {
      const n = (item.idx ?? 0) + 1;
      if (!offer) { add('block', 'no_offer', `Позиция ${n} «${item.name.slice(0, 60)}»: ${whyMissing(tender, item, s).replace(/^позиция \d+ — /, '')} — найдите поставщика или запросите цену`, 'suppliers'); continue; }
      const sel = `[data-offer-cart="${offer.id}"]`;
      const price = offer.unit_price ?? offer.price;
      if (item.unit_price > 0 && price > item.unit_price * 1.5) add('block', 'price_over', `Позиция ${n}: товар за ${price} ₽ при цене заказчика ${item.unit_price} ₽ — выбор неверный`, 'suppliers', sel, true);
      if (String(how).endsWith('дороже цены заказчика')) add('info', 'item_over', `Позиция ${n}: дешевле цены заказчика (${item.unit_price} ₽) товара нет — взят за ${price} ₽; закупку окупают другие позиции`, 'suppliers', sel);
      // товар подтверждён не по всем требованиям — «готово» нельзя, кто бы его ни выбрал (25.10: троксерутин, выбранный
      // поиском, при «Гель высокой вязкости» дал закупке «готово»); выбор человека — его решение, только предупреждаем
      if (offer.match === 'частично' || String(how).startsWith('агент (частично)')) {
        const unk = (offer.match_checks?.rows || []).filter((r) => r.verdict !== 'yes').map((r) => r.name);
        if (!unk.length) add('warn', 'partial', `Позиция ${n}: товар подтверждён по всем требованиям, но ТЗ прочитано не полностью — требований может быть больше, сверьте с ТЗ`, 'suppliers', sel);
        else add(how === 'человек' ? 'warn' : 'block', 'partial', `Позиция ${n}: у товара не подтверждено ${unk.length} требований (${unk.slice(0, 3).join('; ')}${unk.length > 3 ? '…' : ''}) — сверьте товар с ТЗ на странице продавца`, 'suppliers', sel);
      }
      // в ТЗ гигабит, у товара 100 Мбит («24x100 Мбит/с», «10/100», «Fast Ethernet»)
      const req = (item.spec?.required || item.characteristics || []).map((r) => `${r.name} ${r.value}`).join(' ');
      if (/10\/100\/1000|1000\s*мбит|гигабит|gigabit/i.test(`${item.name} ${req}`) && /(\d+\s*[x×]\s*100\s*мбит|10\/100(?!\/1000)|fast\s*ethernet)/i.test(offer.title || '')) {
        add('block', 'speed_mismatch', `Позиция ${n}: в ТЗ порты 10/100/1000 (гигабит), у товара — 100 Мбит («${String(offer.title).slice(0, 60)}»)`, 'suppliers', sel, true);
      }
      // картридж «для аппарата»: модели картриджей к нему из своей базы — выбранный должен быть среди них
      const forDevice = deviceModels(item);
      if (!fitsDevice(forDevice, offer)) {
        add('warn', 'device_mismatch', `Позиция ${n}: к ${forDevice[0].device} по своей базе подходят ${forDevice.map((c) => c.model).join(', ')} — выбран другой (${String(offer.title).slice(0, 40)}); проверьте совместимость`, 'suppliers', sel, true);
      }
      const numFail = numbersFail(item, offer);
      if (numFail) add('block', 'number_mismatch', `Позиция ${n}: по характеристикам товара не проходит — ${numFail}`, 'suppliers', sel, how !== 'человек');
      if (slow(offer, s)) add('warn', 'delivery_slow', `Позиция ${n}: доставка ${offer.delivery_days} дн. — дольше ваших ${s.max_delivery_days} дн.`, 'suppliers', sel);
      else if (tooLong(offer, s)) add('warn', 'delivery_estimate', `Позиция ${n}: доставка по оценке перевозчика ${offer.delivery_days} дн. (у вас — не дольше ${s.max_delivery_days}); оценка по тарифной сетке грубая — уточните срок у продавца`, 'suppliers', sel);
      if (/азиатск|asia/i.test(offer.title || '')) add('warn', 'asia', `Позиция ${n}: азиатская версия товара — проверьте гарантию, картриджи и русификацию`, 'suppliers', sel);
      if (item.quantity == null) add('info', 'unit_price', `Закупка по цене единицы: количества нет, товар — по заявкам заказчика до суммы договора`, 'docs');
    }
    for (const t of chars?.tables || []) {
      const n = t.idx + 1;
      if (!t.country) add('block', 'no_country', `Позиция ${n}: не указана страна происхождения — без неё заявку не примут`, 'bid', `input[data-char-country="${t.item_id}"]`);
      if (restricted && t.country && !/росси/i.test(t.country)) {
        if (natBan(nr.value)) add('block', 'foreign', `Позиция ${n}: запрет допуска иностранных товаров, а товар — «${t.country}»: такую заявку не допустят`, 'docs', 'tr[data-field="national_regime"]');
        else add(s.foreign_when_restricted ? 'warn' : 'block', 'foreign', `Позиция ${n}: нацрежим (${String(nr.value).slice(0, 80)}), а товар — «${t.country}»: если кто-то предложит российский, заявку отклонят`, 'docs', 'tr[data-field="national_regime"]');
      }
      for (const r of t.rows || []) {
        const sel = `input.charval[data-char-item="${t.item_id}"][data-char-name="${String(r.name).replace(/["\\]/g, '\\$&')}"]`;
        if (r.status === 'conflict') add('block', 'char_conflict', `Позиция ${n}: «${r.name}» не проходит по ТЗ (нужно ${r.tz}, у товара ${r.product || '—'})`, 'bid', sel, true);
        else if (r.status === 'empty') add('block', 'char_empty', `Позиция ${n}: не заполнено «${r.name}»`, 'bid', sel);
        else if (r.status === 'pass') add('warn', 'char_pass', `Позиция ${n}: «${r.name}» — граница из ТЗ (${r.value}), у товара не подтверждено`, 'bid', sel);
      }
    }
    if (econ) {
      if (econ.floor?.with_margin && econ.nmck && econ.floor.with_margin > econ.nmck) add('block', 'no_margin', `Даже по начальной цене маржа ниже ${s.margin_min}%: себестоимость ${econ.cost.toLocaleString('ru-RU')} ₽`, 'calc', 'dealCard');
      else if (econ.expected && econ.expected.profit < 0) add('warn', 'loss_expected', `При ожидаемом снижении ${econ.decline_pct}% — убыток ${Math.abs(econ.expected.profit).toLocaleString('ru-RU')} ₽; на аукционе не ниже ${econ.floor.with_margin?.toLocaleString('ru-RU') ?? econ.floor.break_even.toLocaleString('ru-RU')} ₽`, 'calc', 'dealCard');
      // очень высокая маржа при неподтверждённых требованиях — почти всегда не тот товар (витрина под заказ за 12 800 при 53 500)
      if (s.margin_max == null && econ.at_nmck?.margin_pct > 50 && picked.some((p) => /частично/.test(String(p.how)) || p.offer?.match === 'частично')) add('warn', 'margin_suspicious', `Маржа по начальной цене ${econ.at_nmck.margin_pct}% при неподтверждённых требованиях — вероятно, товар не тот (дешевле, проще, не под заказ): сверьте с ТЗ`, 'suppliers', null, true);
      if (s.margin_max != null && econ.at_nmck?.margin_pct > s.margin_max) add('warn', 'margin_high', `Маржа по начальной цене ${econ.at_nmck.margin_pct}% — выше вашего потолка ${s.margin_max}%: проверьте, тот ли товар выбран`, 'suppliers');
    }
    for (const b of bid?.readiness?.blockers || []) add('warn', 'bid_blocker', b.text || String(b), 'bid');
    return out;
  }

  /** Деньги по закупке: себестоимость, прибыль по НМЦК и при ожидаемом снижении (из итогов торгов по нише), «не ниже». */
  function money(tender, ecoRes, s) {
    const r = ecoRes?.result;
    if (!r || r.purchase == null) return null;
    const taxMode = ecoRes.settings?.tax_mode || 'usn15';
    const cost = Math.round((r.purchase || 0) + (r.logistics || 0) + (r.guarantee_cost || 0) + (r.etp_fee || 0) + (r.bid_security_cost || 0) + (r.warranty_cost || 0) + (r.money_cost || 0));
    const nmck = Number(tender.price) || ecoRes.inputs?.nmck || 0;
    // снижение на торгах: агент итогов (agents/outcomes.js) — по заказчику, иначе по нише; иначе свои итоги агента заявок
    const learned = outcomes?.decline(tender.direction, tender.customer_inn) || learnedDecline(tender.direction);
    const decline = learned?.pct ?? ecoRes.inputs?.decline_pct ?? 10;
    const expectedRevenue = Math.round(nmck * (1 - decline / 100));
    const at = (rev) => { const p = profitAt(rev, cost, taxMode); return { revenue: rev, profit: p, margin_pct: rev ? Math.round((p / rev) * 1000) / 10 : null }; };
    return { cost, purchase: Math.round(r.purchase || 0), logistics: Math.round(r.logistics || 0), nmck, tax_mode: taxMode, decline_pct: decline, decline_source: learned ? `итоги торгов ${learned.by === 'customer' ? 'у этого заказчика' : 'по нише'} (${learned.samples})` : 'расчёт сделки', at_nmck: at(nmck), expected: at(expectedRevenue), floor: floorPrice(cost, s.margin_min, taxMode) };
  }

  /** Та же закупка с другой суммой закупки товара (другой вариант товара): себестоимость, прибыль, «не ниже». */
  function withPurchase(econ, oldPurchase, newPurchase, s) {
    const cost = Math.round(econ.cost - oldPurchase + newPurchase);
    const rev = Math.round(econ.nmck * (1 - econ.decline_pct / 100));
    const at = (r) => { const p = profitAt(r, cost, econ.tax_mode); return { revenue: r, profit: p, margin_pct: r ? Math.round((p / r) * 1000) / 10 : null }; };
    return { ...econ, cost, at_nmck: at(econ.nmck), expected: at(rev), floor: floorPrice(cost, s.margin_min, econ.tax_mode) };
  }
  /**
   * Варианты товара при нацрежиме: самый дешёвый российский по каждой позиции и самый дешёвый вообще (подходящие:
   * «соответствует» или «частично» без «нет», не дороже 1,5 цены заказчика, не «нет в наличии»).
   */
  function variants(tender, qty, s) {
    const plan = { ru: [], any: [], alt: [] };
    const price = (o) => o.unit_price ?? o.price;
    for (const item of repo.getItems(tender.id)) {
      const models = deviceModels(item);
      const ok = repo.getOffers(tender.id).filter((o) => o.item_id === item.id && o.source !== 'contracts' && o.price > 0 && ['соответствует', 'частично'].includes(o.match)
        && !(o.match_checks?.rows || []).some((r) => r.verdict === 'no') && !/нет в наличии/i.test(String(o.availability || ''))
        && !(item.unit_price > 0 && price(o) > item.unit_price * 1.5) && !slow(o, s) && suitable(item, o, models) && numbersConfirmed(o));
      const cheapest = [...ok].sort((a, b) => price(a) - price(b))[0] || null;
      const ru = ok.filter((o) => originOf(o) === 'ru').sort((a, b) => price(a) - price(b))[0] || null;
      // выбор человека агент не меняет: в обоих вариантах он остаётся; самый дешёвый без него — отдельно, как предложение
      const fixed = item.purchase_selected_by === 'user' && item.purchase_offer_id ? repo.getOffer(item.purchase_offer_id) : null;
      const q = qty[item.id] || item.quantity || 1;
      plan.any.push({ item, offer: fixed || cheapest, q, fixed: Boolean(fixed) });
      plan.ru.push({ item, offer: fixed || ru, q, fixed: Boolean(fixed) });
      plan.alt.push({ item, offer: cheapest, q, instead: fixed && cheapest && cheapest.id !== fixed.id ? fixed : null });
    }
    const sum = (p) => (p.every((x) => x.offer) ? p.reduce((t, x) => t + price(x.offer) * x.q, 0) : null);
    return { ...plan, ru_purchase: sum(plan.ru), any_purchase: sum(plan.any), alt_purchase: plan.alt.some((x) => x.instead) ? sum(plan.alt) : null };
  }
  /**
   * Как часто при таком товаре побеждает импорт: по ориентирам прошлых контрактов на коды позиций. Ориентир, посчитанный
   * до появления страны в строках контракта, пересчитывается (ГосПлан, бесплатно).
   */
  async function foreignShare(tender) {
    let contracts = 0; let foreign = 0;
    const codes = [...new Set(repo.getItems(tender.id).map((i) => i.ktru_code || i.okpd2_code).filter(Boolean))];
    for (const code of codes) {
      let b = repo.getBenchmark?.(code);
      if (b && !b.origin && details.ensureBenchmark) b = await details.ensureBenchmark(code, { force: true }).catch(() => b);
      if (b?.origin) { contracts += b.origin.contracts; foreign += b.origin.foreign; }
    }
    return contracts ? { contracts, foreign, share: Math.round((foreign / contracts) * 100) / 100 } : null;
  }

  /** Товарный знак и страна для заявки, если на странице товара их нет: знак — из названия, страна — из своей базы. */
  async function fillMarks(tender, chars, picked) {
    let changed = false;
    for (const t of chars?.tables || []) {
      const p = picked.find((x) => x.item.id === t.item_id);
      if (!p?.offer) continue;
      const patch = { item_id: t.item_id };
      if (!t.trademark) { const b = brandOf(p.offer.title) || (/(?:^|\s)([A-Z][A-Za-z&]{1,15})(?:\s|$)/.exec(p.offer.title || '') || [])[1]; if (b) patch.trademark = b; }
      if (Object.keys(patch).length > 1) { await charService.save(tender.id, patch); changed = true; }
    }
    return changed ? charService.view(tender.id) : chars;
  }

  const saveItem = (row) => {
    const at = now();
    if (row.id) {
      db.prepare('UPDATE bid_agent_items SET status = ?, step = ?, reason = ?, summary_json = ?, findings_json = ?, updated_at = ? WHERE id = ?')
        .run(row.status, row.step || null, row.reason || null, JSON.stringify(row.summary || null), JSON.stringify(row.findings || []), at, row.id);
      return row.id;
    }
    return Number(db.prepare('INSERT INTO bid_agent_items (run_id, tender_id, status, step, reason, summary_json, findings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.run_id, row.tender_id, row.status, row.step || null, row.reason || null, JSON.stringify(row.summary || null), JSON.stringify(row.findings || []), at, at).lastInsertRowid);
  };

  /** Одна закупка от начала до пакета заявки. */
  async function prepare(runId, tender, s, { freshSearch = false } = {}) {
    const id = saveItem({ run_id: runId, tender_id: tender.id, status: 'running', step: 'docs' });
    const row = { id, run_id: runId, tender_id: tender.id, status: 'running' };
    const summary = { number: tender.number, title: tender.title, nmck: tender.price, deadline: tender.deadline_at || tender.deadline_from, platform: tender.platform, region: tender.region, law: tender.law, difficulty: tender.difficulty };
    try {
      const analysis = await ensureAnalysis(tender);
      if (!analysis || analysis.status !== 'done') return saveItem({ ...row, status: 'error', step: 'docs', reason: analysis?.error || 'документация не прочиталась за 25 минут — закупку возьмёт следующий прогон', summary });
      // куда везти: место поставки из документации, а не регион заказчика (у федеральных заказчиков — филиалы по стране).
      // Вне ваших регионов — отсеиваем до платного поиска поставщиков.
      const place = (analysis.card?.groups || []).flatMap((g) => g.fields || []).find((x) => x.key === 'delivery_place' && x.status === 'found');
      const placeRegion = place ? regionFromText(place.value) : null;
      summary.delivery = place ? { text: String(place.value).slice(0, 200), region: placeRegion } : null;
      if (placeRegion && s.regions.length && !s.regions.includes(placeRegion) && !(s.regions.includes(77) && placeRegion === 50) && !(s.regions.includes(50) && placeRegion === 77) && !(s.regions.includes(78) && placeRegion === 47) && !(s.regions.includes(47) && placeRegion === 78)) {
        return saveItem({ ...row, status: 'rejected', step: 'docs', reason: `место поставки «${String(place.value).slice(0, 80)}» — регион ${placeRegion} (центр — ${REGIONS[placeRegion]?.[0] || '?'}), вне ваших регионов`, summary });
      }
      saveItem({ ...row, step: 'suppliers', summary });
      const search = await ensureSearch(repo.getTender(tender.id), freshSearch);
      if (!search || search.status !== 'done') return saveItem({ ...row, status: 'error', step: 'suppliers', reason: search?.error || 'поиск поставщиков не закончился за 25 минут', summary });
      recheckOffers(tender);
      await revisitRejected(tender);
      await enrichByModel(tender);
      // Характеристика выбранного агентом товара противоречит ТЗ по таблице заявки (мышь 2 400 dpi при «не менее 10 000») —
      // это не тот товар: исключаем его и берём следующий подходящий, пересчитывая деньги и таблицу (до двух раз)
      const excluded = new Set();
      let picked; let eco; let econ; let chars;
      for (let attempt = 0; ; attempt++) {
      picked = pickOffers(tender, s, excluded);
      // платный поиск упёрся в суточный лимит — «нет товара» тут не вывод о закупке: повторим в следующий прогон
      if (picked.some((p) => !p.offer) && (search.log || []).some((l) => /суточный лимит/i.test(String(l.text)))) {
        return saveItem({ ...row, status: 'error', step: 'suppliers', reason: 'суточный лимит платного поиска исчерпан — товар искали только по бесплатным источникам; повторю в следующий прогон', summary });
      }
      delete summary.assumed;
      eco = await details.computeEconomics(tender.id, { fetch: false });
      econ = money(repo.getTender(tender.id), eco?.economics?.result || eco?.economics, s);
      // Позиция без найденного товара не губит всю закупку: считаем её по цене заказчика (ни прибыли, ни убытка на ней),
      // остальное — по найденным товарам. Не найденное дороже половины суммы закупки — такой расчёт не годится.
      const notFound = picked.filter((p) => !p.offer).map((p) => p.item);
      if (!econ && notFound.length && details.buildInput) {
        const input = details.buildInput(repo.getTender(tender.id), eco?.items || repo.getItems(tender.id), eco?.benchmarks || {}, eco?.economics?.overrides || {});
        const sumOf = (list) => list.reduce((t, i) => t + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0);
        const miss = input.items.filter((i) => notFound.some((m) => m.id === i.id));
        const total = sumOf(input.items);
        if (miss.every((i) => i.unit_price > 0 && i.quantity > 0) && total > 0 && sumOf(miss) / total <= 0.5) {
          for (const i of miss) { i.purchase_price = i.unit_price; i.purchase_source = 'по цене заказчика — поставщик не найден'; }
          econ = money(repo.getTender(tender.id), calculate(input), s);
          if (econ) summary.assumed = { positions: notFound.map((i) => (i.idx ?? 0) + 1), share_pct: Math.round((sumOf(miss) / total) * 100) };
        }
      } else if (econ && notFound.length) {
        // расчёт сделки сам оценил цену не найденных позиций (по прошлым контрактам) — та же оговорка, без отсева
        const sum = (list) => list.reduce((t, i) => t + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0);
        const total = sum(repo.getItems(tender.id));
        const share = total ? sum(notFound) / total : 1;
        // не найдено больше половины суммы закупки — оценке по чужим контрактам не верим: это не расчёт, а догадка
        if (share <= 0.5) summary.assumed = { positions: notFound.map((i) => (i.idx ?? 0) + 1), share_pct: Math.round(share * 100), by: 'оценка расчёта сделки' };
        else econ = null;
      }
      summary.items = picked.map(({ item, offer, how }) => ({ id: item.id, name: item.name, quantity: item.quantity, unit_price: item.unit_price, offer: offer ? { id: offer.id, title: offer.title, price: offer.unit_price ?? offer.price, url: offer.url, domain: offer.domain, availability: offer.availability } : null, how }));
      summary.econ = econ;
      chars = charService ? await charService.view(tender.id) : null;
      if (chars) chars = await fillMarks(tender, chars, picked);
      const bad = attempt < 2 && chars ? (chars.tables || []).filter((t) => (t.rows || []).some((r) => r.status === 'conflict'))
        .map((t) => picked.find((p) => p.item.id === t.item_id)).filter((p) => p?.offer && p.how !== 'человек') : [];
      if (!bad.length) break;
      for (const p of bad) {
        excluded.add(p.offer.id);
        lesson('char_conflict_pick', 'выбран товар, характеристика которого не проходит по ТЗ — взят следующий', tender.id, `позиция ${(p.item.idx ?? 0) + 1}: ${String(p.offer.title).slice(0, 80)}`);
      }
      }
      let bid = null;
      const missing = picked.filter((p) => !p.offer);
      if (!missing.length && bids) {
        try {
          // агент подготовки заявки: знак и страна из памяти ваших прежних правок — до сборки файлов
          try { application?.prefill(tender.id); } catch (err) { log.warn?.(`[bid-agent] память заявки: ${err.message}`); }
          const opened = await bids.open(tender.id);
          const caseId = opened.view?.id ?? opened.id;
          bid = await bids.draft(caseId).catch((err) => ({ error: err.message, ...(opened.view || {}) }));
          summary.bid = { id: caseId, status: bid?.status || null, files: (bid?.package?.built?.files || []).map((f) => ({ path: f.path, todo: f.todo || 0 })), mandatory: bid?.readiness?.counters?.mandatory ?? null, confirmed: bid?.readiness?.counters?.mandatory_pass ?? null };
          // что в заявке не готово — уроками агенту подготовки заявки по площадке и закону
          if (application) { const rv = application.review(bids.view(caseId), { platform: tender.platform || '', law: tender.law || '', tenderId: tender.id }); summary.bid.review = { ready: rv.ready, problems: rv.problems.slice(0, 8) }; }
          // агент итогового пакета: пересборка при сбое, ваш прежний выбор документов, ошибки файлов — уроками
          if (packager) {
            const pk = await packager.afterDraft(caseId, { platform: tender.platform || '', law: tender.law || '', tenderId: tender.id }).catch((err) => { log.warn?.(`[bid-agent] пакет: ${err.message}`); return null; });
            if (pk) {
              summary.bid.package = pk;
              const bad = checker?.checkPackage ? checker.checkPackage({ tender_id: tender.id, platform: tender.platform || '' }, pk, bids.view(caseId)) : [];
              if (bad.length) { pk.final_ok = false; pk.checker = bad; }
            }
          }
        } catch (err) { summary.bid = { error: err.message }; }
      }
      // нацрежим (ограничение допуска): российский товар безопасен, но дороже; импорт выгоднее, но заявку отклонят,
      // если хоть один участник предложит российский. Считаем оба варианта и смотрим, как часто импорт побеждал.
      const nrField = (analysis?.card?.groups || []).flatMap((g) => g.fields || []).find((x) => x.key === 'national_regime' && x.status === 'found');
      const restricted = Boolean(nrField && /ограничен|запрет/i.test(String(nrField.value)));
      const ban = Boolean(nrField && natBan(nrField.value));
      summary.nat = { restricted, text: nrField ? String(nrField.value).slice(0, 200) : null };
      const good = (e) => e && e.expected.profit >= Math.max(0, s.profit_min ?? 0) && e.expected.margin_pct >= (s.margin_min ?? 0);
      let strategy = null;
      let alt = null;
      let fs2 = null;
      if (econ) {
        const ecoRes = eco?.economics?.result || eco?.economics;
        const qty = Object.fromEntries((ecoRes?.inputs?.items || []).map((i) => [i.id, i.quantity]));
        const v = variants(repo.getTender(tender.id), qty, s);
        const base = econ.cost - (ecoRes?.result?.purchase ?? 0);
        const plan = (sum) => (sum != null ? withPurchase({ ...econ, cost: base + sum }, sum, sum, s) : null);
        const foreignIn = (p) => p.some((x) => x.offer && originOf(x.offer) !== 'ru');
        // выбор человека (fixed) агент не меняет
        const apply = (p) => { for (const x of p) if (x.offer && !x.fixed && repo.getItems(tender.id).find((i) => i.id === x.item.id)?.purchase_offer_id !== x.offer.id) repo.setItemOffer(x.item.id, x.offer, 'agent'); };
        const rareForeign = () => fs2 && fs2.contracts >= 5 && fs2.share < 0.15;
        if (restricted) {
          const ruE = plan(v.ru_purchase);
          const anyE = plan(v.any_purchase);
          fs2 = await foreignShare(tender);
          summary.variants = { ru: ruE ? { profit: ruE.expected.profit, margin_pct: ruE.expected.margin_pct, cost: ruE.cost, foreign: foreignIn(v.ru) } : null, any: anyE ? { profit: anyE.expected.profit, margin_pct: anyE.expected.margin_pct, cost: anyE.cost, foreign: foreignIn(v.any) } : null, foreign_share: fs2 };
          // в «российском» варианте может остаться импорт, выбранный человеком, — тогда это импорт со всеми рисками
          const foreignPlan = (e) => (!s.foreign_when_restricted || ban ? 'no_foreign' : rareForeign() ? 'foreign_rare' : (econ = e, 'foreign'));
          if (good(ruE) && !foreignIn(v.ru)) { strategy = 'ru'; apply(v.ru); econ = ruE; }
          else if (good(ruE)) { apply(v.ru); strategy = foreignPlan(ruE); }
          else if (good(anyE) && foreignIn(v.any)) {
            if (!s.foreign_when_restricted || ban) strategy = 'no_foreign';
            else if (rareForeign()) strategy = 'foreign_rare';
            else { strategy = 'foreign'; apply(v.any); econ = anyE; }
          } else if (good(anyE)) { strategy = 'ru'; apply(v.any); econ = anyE; }
          summary.strategy = strategy;
        }
        // выбор человека не даёт прибыли, а другой подходящий товар даёт — не меняем, а предлагаем со ссылкой на строку
        const altE = plan(v.alt_purchase);
        const altForeign = restricted && foreignIn(v.alt);
        if (!good(econ) && good(altE) && !(altForeign && (!s.foreign_when_restricted || ban || rareForeign()))) {
          alt = { econ: altE, items: v.alt.filter((x) => x.instead), foreign: altForeign };
          summary.alt = { profit: altE.expected.profit, margin_pct: altE.expected.margin_pct, cost: altE.cost, floor: altE.floor, foreign: altForeign, items: alt.items.map((x) => ({ item_id: x.item.id, instead: x.instead.title, offer: { id: x.offer.id, title: x.offer.title, price: x.offer.unit_price ?? x.offer.price, url: x.offer.url, origin: originOf(x.offer) } })) };
        }
        summary.econ = econ;
        summary.items = repo.getItems(tender.id).map((item) => { const o = item.purchase_offer_id ? repo.getOffer(item.purchase_offer_id) : null; const was = summary.items.find((x) => x.id === item.id); return { ...was, offer: o ? { id: o.id, title: o.title, price: o.unit_price ?? o.price, url: o.url, domain: o.domain, availability: o.availability, origin: originOf(o) } : null }; });
      }
      let findings = review(tender, { analysis, picked, econ, chars, bid, s });
      // снижение по прошлым торгам на эти коды товара заметно больше, чем в расчёте: показываем, что будет при нём.
      // По 3+ контрактам и в минус — блокирует «готово»: при «не ниже» убытка не будет, но и выиграть вряд ли выйдет.
      const hist = [...new Set(repo.getItems(tender.id).map((i) => i.ktru_code || i.okpd2_code).filter(Boolean))]
        .map((code) => repo.getBenchmark?.(code)?.decline).filter((d) => d?.median != null && d.samples >= 2)
        .sort((a, b) => b.median - a.median)[0];
      if (econ && hist && hist.median * 100 > econ.decline_pct + 10) {
        const pct = Math.round(hist.median * 100);
        const rev = Math.round(econ.nmck * (1 - hist.median));
        const p = profitAt(rev, econ.cost, econ.tax_mode);
        summary.decline_history = { pct, samples: hist.samples, profit: p };
        findings.unshift({ level: p < 0 && hist.samples >= 3 ? 'block' : 'warn', code: 'decline_history', text: `По прошлым контрактам на этот товар цена на торгах падала на ${pct}% (${hist.samples} контр.), а в расчёте — ${econ.decline_pct}%: при таком падении выручка ${rev.toLocaleString('ru-RU')} ₽, прибыль ${p.toLocaleString('ru-RU')} ₽. Ниже ${(econ.floor.with_margin ?? econ.floor.break_even).toLocaleString('ru-RU')} ₽ не опускайтесь — тогда в худшем случае просто не выиграете`, href: href(tender.id, 'calc'), sel: 'dealCard', own: false });
      }
      // сколько заявок уже подано (44-ФЗ, реестр Сбербанк-АСТ). Три и больше — торг будет плотнее обычного: считаем
      // прибыль при снижении на 10 пунктов больше ожидаемого (оценка, не статистика) и предупреждаем, если там минус
      let comp = null;
      try { comp = bidCounts ? await bidCounts.refresh(tender) : null; } catch (err) { log.warn?.(`[агент заявок] заявки на площадке ${tender.number}: ${err.message}`); }
      if (comp?.found) {
        summary.competition = { count: comp.count, at: comp.checked_at, platform: comp.platform };
        if (econ && comp.count >= 3) {
          const pct = Math.min(60, econ.decline_pct + 10);
          const rev = Math.round(econ.nmck * (1 - pct / 100));
          const p = profitAt(rev, econ.cost, econ.tax_mode);
          summary.competition.stress = { pct, profit: p };
          findings.unshift({ level: p < 0 ? 'warn' : 'info', code: 'competition', text: `На ${comp.platform} уже подано заявок: ${comp.count}. Торг, скорее всего, будет плотнее обычного: при снижении ${pct}% (на 10 пунктов больше ожидаемого) выручка ${rev.toLocaleString('ru-RU')} ₽, прибыль ${p.toLocaleString('ru-RU')} ₽${p < 0 ? ` — в минус. Ниже ${(econ.floor.with_margin ?? econ.floor.break_even).toLocaleString('ru-RU')} ₽ не опускайтесь` : ''}`, href: href(tender.id, 'calc'), sel: 'dealCard', own: false });
        }
      }
      // Товар «со специальной проверкой» (СП, спецпроверка на отсутствие закладок): обычный товар из магазина требованию
      // не отвечает, его цена в разы ниже — «выгодно» ложное (аудит 29.10: совместимый картридж за 365 ₽ при 4 661 ₽)
      const specialCheck = /специальн\S*\s+проверк|спецпроверк|со\s+СП(?![А-Яа-яЁё])/i;
      const subject = (analysis?.card?.groups || []).flatMap((g) => g.fields || []).find((f) => f.key === 'subject')?.value || '';
      if (specialCheck.test(`${tender.title || ''} ${subject}`)) {
        const plain = (picked || []).filter(({ offer }) => offer && !specialCheck.test(`${offer.title || ''} ${(offer.match_notes || []).join(' ')}`));
        if (plain.length) findings.unshift({ level: 'block', code: 'special_check', text: `Закупка товара со специальной проверкой (СП): найденный товар («${String(plain[0].offer.title).slice(0, 60)}») её не проходил — нужен поставщик, который поставляет товар со спецпроверкой; цена такого товара заметно выше`, href: href(tender.id, 'suppliers'), sel: null, own: false });
      }
      // доставка у предложений считается до места поставки; если товар найден до этого правила — до региона заказчика
      const pr = summary.delivery?.region;
      const sameArea = (a, b) => a === b || [a, b].every((r) => [50, 77].includes(r)) || [a, b].every((r) => [47, 78].includes(r));
      if (pr && tender.region != null && !sameArea(pr, Number(tender.region))) {
        summary.delivery.far = true;
        findings.unshift({ level: 'info', code: 'delivery_place', text: `Товар везти в ${REGIONS[pr]?.[0] || pr} (место поставки), а не по адресу заказчика (${REGIONS[tender.region]?.[0] || tender.region}): доставка посчитана до места поставки — сверьте срок и стоимость`, href: href(tender.id, 'docs'), sel: 'tr[data-field="delivery_place"]', own: false });
      }
      // перевозчик не успевает к сроку поставки по контракту
      for (const { item, offer } of picked) if (offer && offer.in_time === false) findings.push({ level: 'warn', code: 'late', text: `Позиция ${(item.idx ?? 0) + 1}: доставка ${offer.delivery_days} дн. — может не успеть к сроку поставки по контракту`, href: href(tender.id, 'suppliers'), sel: `[data-offer-cart="${offer.id}"]`, own: false });
      const shareText = (x) => (x ? `по прошлым контрактам импорт побеждал в ${Math.round(x.share * 100)}% (${x.foreign} из ${x.contracts})${x.contracts < 5 ? ", контрактов мало — вывод ненадёжный" : ""}` : 'как часто импорт побеждает, по контрактам пока не известно');
      // нацрежим по позициям — одним замечанием, а при выбранном импорте — одним предупреждением о риске
      const foreignF = findings.filter((x) => x.code === 'foreign');
      findings = findings.filter((x) => x.code !== 'foreign');
      if (strategy === 'foreign') {
        const ru = summary.variants.ru;
        findings.unshift({ level: 'warn', code: 'nat_risk', text: `Нацрежим: ${ru?.foreign ? 'выбранный вами товар — импорт' : ru ? `российский товар при снижении даёт ${ru.profit.toLocaleString('ru-RU')} ₽, поэтому выбран импорт` : 'российского товара среди найденных нет, поэтому выбран импорт'} (${econ.expected.profit.toLocaleString('ru-RU')} ₽ при снижении ${econ.decline_pct}%). Риск: если кто-то предложит российский, заявку отклонят — ${shareText(fs2)}`, href: href(tender.id, 'docs'), sel: 'tr[data-field="national_regime"]', own: false });
      } else if (foreignF.length) {
        const nums = foreignF.map((x) => /Позиция (\d+)/.exec(x.text)?.[1]).filter(Boolean);
        findings.unshift({ ...foreignF[0], text: `Нацрежим (${String(nrField?.value || '').slice(0, 80)}), а товар иностранный${nums.length ? ` — позиции ${nums.join(', ')}` : ''}: если кто-то предложит российский, заявку отклонят; ${shareText(fs2)}` });
      }
      if (alt) {
        const x = alt.items[0];
        const more = alt.items.length > 1 ? ` (и ещё ${alt.items.length - 1} поз.)` : '';
        findings.unshift({ level: 'block', code: 'alt_better', text: `Ваш выбор «${String(x.instead.title).slice(0, 50)}» при снижении ${econ.decline_pct}% даёт ${econ.expected.profit.toLocaleString('ru-RU')} ₽. Подходит и «${String(x.offer.title).slice(0, 50)}» за ${(x.offer.unit_price ?? x.offer.price).toLocaleString('ru-RU')} ₽${more}: прибыль ${alt.econ.expected.profit.toLocaleString('ru-RU')} ₽ (${alt.econ.expected.margin_pct}%)${alt.foreign ? `; это импорт при нацрежиме — ${shareText(fs2)}` : ''}. Агент ваш выбор не меняет — замените товар на шаге «Поставщики», если согласны`, href: href(tender.id, 'suppliers'), sel: `[data-offer-cart="${x.offer.id}"]`, own: false });
      }
      for (const f of findings.filter((x) => x.own)) lesson(f.code, f.text.replace(/Позиция \d+:?\s*/, '').slice(0, 120), tender.id, f.text);
      for (const p of picked) {
        if (!p.offer || p.how === 'человек') continue;
        const past = repo.getOffers(tender.id).filter((o) => o.item_id === p.item.id && o.source === 'contracts' && o.match === 'соответствует').map((o) => Number(o.unit_price ?? o.price));
        const low = priceBelowContracts(Number(p.offer.unit_price ?? p.offer.price), past);
        if (low) findings.unshift({ level: 'block', code: 'price_suspicious', text: `Цена подозрительно низкая: «${String(p.offer.title).slice(0, 50)}» за ${p.offer.unit_price ?? p.offer.price} ₽, в прошлых контрактах обычно ${low.median} ₽. Похоже на другой товар, прибыль не подтверждена.` });
        if (low) lesson('price_suspicious', 'Цена товара вдвое ниже прошлых контрактов', tender.id, String(p.offer.title).slice(0, 120));
      }
      // решение: нет товара или нет маржи даже по НМЦК — отсеять; иначе готово (блокирующие замечания — «доработать»)
      let status = 'ready';
      let reason = null;
      if (missing.length && !summary.assumed) { status = 'rejected'; reason = `нет подходящего товара: ${missing.map((p) => whyMissing(tender, p.item, s)).join('; ')}`; }
      else if (!econ) { status = 'rejected'; reason = 'не посчитать прибыль — нет цен закупки'; }
      else if (alt && !good(econ)) { status = 'needs_work'; reason = `ваш выбор товара при ожидаемом снижении даёт ${econ.expected.profit.toLocaleString('ru-RU')} ₽ — есть выгодная замена: ${alt.econ.expected.profit.toLocaleString('ru-RU')} ₽ (${alt.econ.expected.margin_pct}%)`; }
      else if (strategy === 'foreign_rare') { status = 'rejected'; reason = `нацрежим: российский товар в минус, а импорт по этому товару почти не побеждает — ${Math.round(summary.variants.foreign_share.share * 100)}% контрактов (${summary.variants.foreign_share.foreign} из ${summary.variants.foreign_share.contracts})`; }
      else if (strategy === 'no_foreign') { status = 'rejected'; reason = ban ? 'нацрежим: запрет допуска иностранных товаров, а российский товар не даёт прибыли' : 'нацрежим: российский товар не даёт прибыли, а иностранный вы в настройках не берёте'; }
      // минусовые и ниже вашей маржи — не предлагаем: решаем по цене после ожидаемого снижения на аукционе
      // доставка в расчёте дороже половины закупки — почти всегда ошибка оценки веса (батарейка «весом 3 кг»): не отсеиваем,
      // а показываем прибыль без неё — человек проверит
      else if (!good(econ) && econ.logistics > Math.max(5000, (econ.purchase || 0) * 0.5) && good(withPurchase({ ...econ, cost: econ.cost - econ.logistics + Math.round((econ.purchase || 0) * 0.05) }, 0, 0, s))) {
        const fixed = withPurchase({ ...econ, cost: econ.cost - econ.logistics + Math.round((econ.purchase || 0) * 0.05) }, 0, 0, s);
        status = 'needs_work'; reason = `доставка в расчёте подозрительно дорогая: ${econ.logistics.toLocaleString('ru-RU')} ₽ при закупке ${econ.purchase.toLocaleString('ru-RU')} ₽ — проверьте вес; с доставкой 5% от закупки прибыль при снижении ${fixed.expected.profit.toLocaleString('ru-RU')} ₽ (${fixed.expected.margin_pct}%)`;
        findings.unshift({ level: 'block', code: 'logistics_suspicious', text: `Доставка в расчёте ${econ.logistics.toLocaleString('ru-RU')} ₽ при закупке ${econ.purchase.toLocaleString('ru-RU')} ₽ — вероятно, ошибка оценки веса товара; проверьте вес и стоимость доставки`, href: href(tender.id, 'calc'), sel: 'dealCard', own: true });
      }
      else if (!good(econ)) { status = 'rejected'; reason = `невыгодно: при ожидаемом снижении ${econ.decline_pct}% прибыль ${econ.expected.profit.toLocaleString('ru-RU')} ₽ (${econ.expected.margin_pct}%) — ниже ваших ${s.margin_min ?? 0}% / ${(s.profit_min ?? 0).toLocaleString('ru-RU')} ₽; по начальной цене было бы ${econ.at_nmck.profit.toLocaleString('ru-RU')} ₽${summary.nat?.restricted && summary.variants?.any ? `; самый дешёвый товар при снижении — ${summary.variants.any.profit.toLocaleString('ru-RU')} ₽` : ''}`; }
      else if (findings.some((f) => f.level === 'block')) status = 'needs_work';
      // проверяющий: «готово» при критичных замечаниях по заявке — не готово
      if (status === 'ready' && checker && summary.bid?.review) {
        const crit = checker.checkApplication({ tender_id: tender.id, summary }, summary.bid.review);
        if (crit.length) { status = 'needs_work'; findings.push({ level: 'warn', code: 'bid_not_ready', text: `Заявка не готова: ${crit.map((p) => p.text).join('; ').slice(0, 300)}`, href: `#tender/${tender.id}/bid`, sel: null, own: false }); }
      }
      // Выгодна ли закупка — отдельно от статуса: «доработать» бывает и у выгодной (замена товара, поставщик для части
      // позиций, страна в заявке). Прогон считает выгодные, а не просто подготовленные.
      const positions = summary.assumed ? `позиций ${summary.assumed.positions.join(', ')}` : '';
      // товар не проходит ТЗ (и заменить нечем) — выгодной закупку не считаем, какие бы ни были деньги
      // и по прошлым торгам (3+ контракта) при обычном для этого товара снижении — минус: выгодной тоже не считаем
      const misfit = findings.some((f) => ['char_conflict', 'number_mismatch', 'speed_mismatch', 'price_over', 'special_check'].includes(f.code) || (f.code === 'decline_history' && f.level === 'block'));
      summary.verdict = status === 'rejected' || status === 'error' || misfit ? null
        : alt && good(alt.econ) && !good(econ) ? 'выгодно после замены товара'
          : good(econ) && summary.assumed ? `выгодно, если найти поставщика для ${positions}`
            : good(econ) ? (status === 'ready' ? 'выгодно' : 'выгодно, есть что доработать') : null;
      if (summary.assumed && status === 'needs_work' && !reason) reason = `поставщик не найден для ${positions} (${summary.assumed.share_pct}% суммы закупки): в расчёте они ${summary.assumed.by ? 'по оценке из прошлых контрактов' : 'по цене заказчика — без прибыли на них'}`;
      return saveItem({ ...row, status, step: 'done', reason, summary, findings });
    } catch (err) {
      log.warn?.(`[bid-agent] закупка ${tender.id}: ${err.message}`);
      return saveItem({ ...row, status: 'error', reason: err.message, summary });
    }
  }

  // ---------- итоги торгов (обучение без риска) ----------
  async function checkOutcomes({ limit = 30 } = {}) {
    if (!source?.contractsByPurchase) return 0;
    const due = new Date(clock().getTime() - 2 * DAY).toISOString();
    const rows = db.prepare(`SELECT i.id, i.summary_json, t.number, t.price, t.law, t.deadline_at FROM bid_agent_items i JOIN tenders t ON t.id = i.tender_id
      WHERE i.outcome_json IS NULL AND i.status IN ('ready', 'needs_work', 'rejected') AND t.law = '44' AND COALESCE(t.deadline_at, '9999') < ?
        AND (i.outcome_at IS NULL OR i.outcome_at < ?) ORDER BY t.deadline_at LIMIT ?`).all(due, new Date(clock().getTime() - DAY).toISOString(), limit);
    let done = 0;
    const s = settings();
    for (const r of rows) {
      let list = [];
      try { list = await source.contractsByPurchase(r.number); } catch (err) { log.warn?.(`[bid-agent] итог ${r.number}: ${err.message}`); break; }
      db.prepare('UPDATE bid_agent_items SET outcome_at = ? WHERE id = ?').run(now(), r.id);
      const price = list.reduce((sum, c) => sum + (Number(c.price) || 0), 0);
      if (!price) continue;
      let summary = {};
      try { summary = JSON.parse(r.summary_json || '{}'); } catch { summary = {}; }
      const o = judgeOutcome({ nmck: Number(r.price), contractPrice: price, cost: summary.econ?.cost, taxMode: summary.econ?.tax_mode, marginMin: s.margin_min });
      if (!o) continue;
      o.supplier_inn = list[0]?.supplier_inn || (Array.isArray(list[0]?.suppliers) ? list[0].suppliers[0]?.inn || list[0].suppliers[0] : null) || null;
      // чей товар победил: страна в строках контракта (643 — Россия) — статистика для нацрежима
      try {
        const full = list[0]?.reg_num && source.getContract ? await source.getContract(list[0].reg_num) : null;
        const lines = full ? (parseContract(full, '*').lines || []) : [];
        const origins = [...new Set(lines.map((l) => l.origin).filter(Boolean))];
        o.origin = origins.length ? (origins.every((c) => c === '643') ? 'ru' : 'foreign') : null;
      } catch { o.origin = null; }
      o.nat_restricted = Boolean(summary.nat?.restricted);
      db.prepare('UPDATE bid_agent_items SET outcome_json = ? WHERE id = ?').run(JSON.stringify(o), r.id);
      done++;
    }
    return done;
  }

  /**
   * Выгодная закупка — сразу в ленту уведомлений (вид «агент заявок») и отдельным сообщением в Telegram, не дожидаясь
   * конца прогона. Повторно о той же закупке — не раньше чем через 7 дней.
   */
  async function announce(x) {
    const s = x?.summary;
    if (!s?.verdict || !repo.markAlerted) return false;
    const e = db.prepare('SELECT alert_kind, alerted_at FROM tender_economics WHERE tender_id = ?').get(x.tender_id);
    if (!e) return false;
    if (e.alert_kind === 'agent' && e.alerted_at && clock().getTime() - new Date(e.alerted_at).getTime() < 7 * DAY) return false;
    const money2 = (v) => `${Math.round(Number(v) || 0).toLocaleString('ru-RU')} ₽`;
    const p = s.alt && /замен/.test(s.verdict) ? { profit: s.alt.profit, margin: s.alt.margin_pct } : { profit: s.econ?.expected?.profit, margin: s.econ?.expected?.margin_pct };
    repo.markAlerted(x.tender_id, now(), 'agent', s.econ?.purchase ?? null);
    db.prepare('UPDATE tender_economics SET alert_profit = ?, alert_margin = ? WHERE tender_id = ?').run(p.profit ?? null, p.margin ?? null, x.tender_id);
    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const base = config.PUBLIC_BASE_URL || '';
    const html = [`🧾 <b>Агент заявок: ${esc(s.verdict)}</b>`, esc(String(s.title || '').slice(0, 150)),
      `Начальная цена ${money2(s.nmck)} · прибыль при снижении ${s.econ?.decline_pct ?? '?'}% ≈ <b>${money2(p.profit)}</b> (${p.margin ?? '—'}%)`,
      // при замене товара граница «не ниже» — для нового товара, а не для прежнего выбора
      (() => { const fl = (s.alt && /замен/.test(s.verdict) ? s.alt.floor : null) || s.econ?.floor; return fl ? `На аукционе не ниже ${money2(fl.with_margin || fl.break_even)}${s.alt && /замен/.test(s.verdict) ? ' (с заменой товара)' : ''}` : null; })(),
      x.reason ? `Доработать: ${esc(String(x.reason).slice(0, 200))}` : null,
      base ? `${base}/#tender/${x.tender_id} · ${base}/#bidagent` : null].filter(Boolean).join('\n');
    if (s.check?.verdict === 'hold') return true; // проверяющий просит человека посмотреть — только в ленте
    if (notify && await notify(html).catch(() => false)) repo.markAlertSent?.(x.tender_id, now());
    return true;
  }

  /**
   * Проверяющий находки (server/agents/checker.js) перепроверяет «выгодно» перед уведомлением: reject — не выгодно
   * (статус «доработать», замечание с причиной), hold — в ленту, но не в Telegram. @returns {boolean} считать выгодной
   */
  async function verify(itemId) {
    if (!checker) return true;
    const x = item(itemId);
    let res;
    try { res = await checker.check(x); } catch (err) { log.warn?.(`[bid-agent] проверяющий: ${err.message}`); return true; }
    const summary = { ...x.summary, check: { verdict: res.verdict, problems: res.problems, at: now() } };
    if (res.verdict === 'reject') {
      summary.verdict = null;
      const findings = [...res.problems.map((p) => ({ level: 'block', code: `check_${p.code}`, text: `Проверяющий: ${p.title}${p.item ? ` — «${String(p.item).slice(0, 60)}»` : ''}${p.text ? ` (${p.text})` : ''}`, href: `#tender/${x.tender_id}/suppliers`, sel: null, own: false })), ...(x.findings || [])];
      db.prepare("UPDATE bid_agent_items SET status = 'needs_work', reason = ?, summary_json = ?, findings_json = ?, updated_at = ? WHERE id = ?")
        .run(`Проверяющий отклонил: ${res.problems.map((p) => p.title).join('; ').slice(0, 300)}`, JSON.stringify(summary), JSON.stringify(findings), now(), itemId);
      return false;
    }
    db.prepare('UPDATE bid_agent_items SET summary_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(summary), now(), itemId);
    return true;
  }

  // ---------- прогон ----------
  let running = null;
  // freshSearch — искать поставщиков заново, даже если свежий поиск есть (после правок поиска)
  function run({ reason = 'morning', tenderIds = null, freshSearch = false } = {}) {
    if (running) return running;
    running = (async () => {
      const s = settings();
      const runId = Number(db.prepare("INSERT INTO bid_agent_runs (started_at, status, reason, settings_json) VALUES (?, 'running', ?, ?)").run(now(), reason, JSON.stringify(s)).lastInsertRowid);
      const stats = { candidates: 0, ready: 0, needs_work: 0, rejected: 0, errors: 0, outcomes: 0 };
      const deadline = Date.now() + (s.max_minutes || 150) * 60000;
      try {
        stats.outcomes = await checkOutcomes().catch(() => 0);
        const list = tenderIds ? tenderIds.map((id) => repo.getTender(id)).filter(Boolean) : candidates(s);
        stats.candidates = list.length;
        for (const t of list) {
          if ((stats.profitable || 0) >= s.per_run || Date.now() > deadline) break;
          const itemId = await prepare(runId, t, s, { freshSearch: Array.isArray(freshSearch) ? freshSearch.includes(t.id) : freshSearch });
          const st = db.prepare('SELECT status FROM bid_agent_items WHERE id = ?').get(itemId)?.status;
          if (st === 'ready') stats.ready++; else if (st === 'needs_work') stats.needs_work++; else if (st === 'rejected') stats.rejected++; else stats.errors++;
          if (item(itemId)?.summary?.verdict && await verify(itemId)) { stats.profitable = (stats.profitable || 0) + 1; journal?.metric('bid', 'profitable', 1); await announce(item(itemId)).catch((err) => log.warn?.(`[bid-agent] уведомление: ${err.message}`)); }
          // лимит поиска исчерпан — дальше закупки только зря читать: остальные — в следующий прогон
          if (st === 'error' && /суточный лимит/.test(db.prepare('SELECT reason FROM bid_agent_items WHERE id = ?').get(itemId)?.reason || '')) { stats.stopped = 'лимит поиска'; break; }
          // ЕИС ответил «слишком часто» (429) — дальше документацию не качаем: остальные закупки — в следующий прогон
          if (st === 'error' && /ЕИС ответил 4(29|34)/.test(db.prepare('SELECT reason FROM bid_agent_items WHERE id = ?').get(itemId)?.reason || '')) { stats.stopped = 'ЕИС: слишком часто'; break; }
        }
        db.prepare("UPDATE bid_agent_runs SET finished_at = ?, status = 'done', stats_json = ? WHERE id = ?").run(now(), JSON.stringify(stats), runId);
      } catch (err) {
        db.prepare("UPDATE bid_agent_runs SET finished_at = ?, status = 'error', stats_json = ? WHERE id = ?").run(now(), JSON.stringify({ ...stats, error: err.message }), runId);
      }
      await sendReport(runId).catch((err) => log.warn?.(`[bid-agent] Telegram: ${err.message}`));
      return { id: runId, stats };
    })().finally(() => { running = null; });
    return running;
  }

  // ---------- решения человека и поправки ----------
  function decide(itemId, decision, note = '') {
    if (!['take', 'skip', null].includes(decision)) throw Object.assign(new Error('Решение: take, skip или null'), { status: 400 });
    const r = db.prepare('SELECT * FROM bid_agent_items WHERE id = ?').get(Number(itemId));
    if (!r) throw Object.assign(new Error('Закупка агента не найдена'), { status: 404 });
    db.prepare('UPDATE bid_agent_items SET decision = ?, decision_note = ?, decided_at = ? WHERE id = ?').run(decision, String(note || '').slice(0, 500), decision ? now() : null, r.id);
    // человек отказался от закупки, которую проверяющий пропустил как верную, — урок проверяющему
    const x = item(r.id);
    if (decision === 'skip' && r.decision !== 'skip' && x?.summary?.check?.verdict === 'ok') checker?.humanSkipped(x, note);
    return x;
  }
  /**
   * Поправки человека после агента — его ошибки: сменил выбранный товар, отметил замечание неверным.
   * Проверяется при каждом показе страницы (дёшево: только готовые закупки последних 30 дней).
   */
  function noticeCorrections() {
    const since = new Date(clock().getTime() - 30 * DAY).toISOString();
    for (const r of db.prepare("SELECT id, tender_id, summary_json, findings_json FROM bid_agent_items WHERE status IN ('ready', 'needs_work') AND created_at >= ?").all(since)) {
      let summary = {};
      try { summary = JSON.parse(r.summary_json || '{}'); } catch { continue; }
      let changed = false;
      for (const it of summary.items || []) {
        if (!it.offer || it.corrected) continue;
        const now2 = repo.getItems(r.tender_id).find((x) => x.id === it.id);
        if (now2?.purchase_offer_id && now2.purchase_offer_id !== it.offer.id && now2.purchase_selected_by === 'user') {
          it.corrected = { offer_id: now2.purchase_offer_id, at: now() };
          lesson('user_changed_offer', 'Человек сменил выбранный агентом товар', r.tender_id, `«${it.name.slice(0, 50)}»: агент выбрал «${String(it.offer.title).slice(0, 50)}»`);
          changed = true;
        }
      }
      if (changed) db.prepare('UPDATE bid_agent_items SET summary_json = ? WHERE id = ?').run(JSON.stringify(summary), r.id);
    }
  }
  /** Человек отметил замечание неверным — урок для агента (ложная тревога). */
  function dismissFinding(itemId, index) {
    const r = db.prepare('SELECT * FROM bid_agent_items WHERE id = ?').get(Number(itemId));
    if (!r) throw Object.assign(new Error('Закупка агента не найдена'), { status: 404 });
    const findings = JSON.parse(r.findings_json || '[]');
    const f = findings[Number(index)];
    if (!f) throw Object.assign(new Error('Замечание не найдено'), { status: 404 });
    f.dismissed = now();
    db.prepare('UPDATE bid_agent_items SET findings_json = ? WHERE id = ?').run(JSON.stringify(findings), r.id);
    lesson(`false_${f.code}`, `Ложная тревога: ${f.code}`, r.tender_id, f.text);
    return item(r.id);
  }

  // ---------- что показывать ----------
  const parse = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };
  function item(id) {
    const r = db.prepare('SELECT * FROM bid_agent_items WHERE id = ?').get(id);
    return r ? { ...r, summary: parse(r.summary_json, null), findings: parse(r.findings_json, []), outcome: parse(r.outcome_json, null), summary_json: undefined, findings_json: undefined, outcome_json: undefined } : null;
  }
  /** Уроки: ошибки агента и ложные тревоги; итоги торгов — удачные, упущенные, ниже себестоимости; решения против итогов. */
  function learning() {
    const outcomes = db.prepare('SELECT id FROM bid_agent_items WHERE outcome_json IS NOT NULL ORDER BY outcome_at DESC LIMIT 200').all().map((r) => item(r.id));
    const byNiche = {};
    for (const o of outcomes) {
      const t = repo.getTender(o.tender_id);
      const k = t?.direction || '—';
      (byNiche[k] = byNiche[k] || []).push(o.outcome.decline_pct);
    }
    // нацрежим: в закупках с ограничением — чей товар победил (страна в строках контракта)
    const natRows = outcomes.filter((o) => o.outcome.nat_restricted && o.outcome.origin);
    const nat = { total: natRows.length, foreign: natRows.filter((o) => o.outcome.origin === 'foreign').length };
    const missed = outcomes.filter((o) => o.outcome.status === 'would_profit' && (o.status === 'rejected' || o.decision === 'skip'));
    const wrongTake = outcomes.filter((o) => o.decision === 'take' && o.outcome.status === 'below_cost');
    return {
      lessons: db.prepare('SELECT * FROM bid_agent_lessons ORDER BY count DESC, last_at DESC LIMIT 30').all(),
      outcomes: { total: outcomes.length, would_profit: outcomes.filter((o) => o.outcome.status === 'would_profit').length, below_cost: outcomes.filter((o) => o.outcome.status === 'below_cost').length, recent: outcomes.slice(0, 20) },
      decline_by_niche: Object.fromEntries(Object.entries(byNiche).map(([k, v]) => [k, { median: Math.round(median(v) * 10) / 10, samples: v.length }])),
      missed: missed.slice(0, 10), wrong_take: wrongTake.slice(0, 10), nat,
    };
  }
  function view({ limit = 60 } = {}) {
    noticeCorrections();
    const runs = db.prepare('SELECT * FROM bid_agent_runs ORDER BY id DESC LIMIT 7').all().map((r) => ({ ...r, stats: parse(r.stats_json, {}), settings_json: undefined, stats_json: undefined }));
    // по закупке — только последняя подготовка (повторный прогон заменяет прежнюю)
    const items = db.prepare("SELECT id FROM bid_agent_items i WHERE created_at >= ? AND id = (SELECT MAX(id) FROM bid_agent_items j WHERE j.tender_id = i.tender_id) ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'needs_work' THEN 1 WHEN 'running' THEN 2 WHEN 'error' THEN 3 ELSE 4 END, id DESC LIMIT ?")
      .all(new Date(clock().getTime() - 14 * DAY).toISOString(), limit).map((r) => item(r.id));
    const s = settings();
    const all = niches();
    const sixHours = new Date(clock().getTime() - 6 * 3600000).toISOString();
    const elsewhere = Boolean(db.prepare('SELECT 1 FROM bid_agent_runs WHERE finished_at IS NULL AND started_at > ?').get(sixHours));
    return {
      running: Boolean(running) || elsewhere, settings: s, niches: all, runs, items, learning: learning(),
      warnings: s.niches.filter((id) => all.some((n) => n.id === id && !n.enabled)).map((id) => `Ниша «${all.find((n) => n.id === id).title}» выключена в профиле — лента её не загружает, агенту не из чего выбирать`),
      unread: runs.filter((r) => r.status === 'done' && !r.read_at).length,
    };
  }
  const markRead = () => db.prepare("UPDATE bid_agent_runs SET read_at = ? WHERE read_at IS NULL AND status = 'done'").run(now()).changes;

  function reportText(runId) {
    const r = db.prepare('SELECT * FROM bid_agent_runs WHERE id = ?').get(runId);
    const st = parse(r?.stats_json, {});
    const base = config.PUBLIC_BASE_URL || '';
    const ready = db.prepare("SELECT id FROM bid_agent_items WHERE run_id = ? AND status IN ('ready', 'needs_work')").all(runId).map((x) => item(x.id));
    const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = [`🧾 <b>Агент заявок — утро</b>`, `Выгодных: ${st.profitable || 0} · подготовлено: ${st.ready || 0} · доработать: ${st.needs_work || 0} · отсеяно: ${st.rejected || 0}${st.errors ? ` · не получилось: ${st.errors}` : ''}`];
    for (const x of ready.slice(0, 6)) {
      const e = x.summary?.econ;
      lines.push(`• ${esc(String(x.summary?.title || '').slice(0, 60))} — ${Number(x.summary?.nmck || 0).toLocaleString('ru-RU')} ₽${e ? `, прибыль по НМЦК ${e.at_nmck.profit.toLocaleString('ru-RU')} ₽ (${e.at_nmck.margin_pct}%), не ниже ${(e.floor.with_margin || e.floor.break_even).toLocaleString('ru-RU')} ₽` : ''}${x.status === 'needs_work' ? ' — есть что доработать' : ''}`);
    }
    if (st.outcomes) lines.push(`Итогов торгов разобрано: ${st.outcomes}`);
    lines.push(`<a href="${esc(base)}/#bidagent">Открыть готовые заявки</a>`);
    return lines.join('\n');
  }
  async function sendReport(runId) {
    if (!notify) return false;
    return notify(reportText(runId));
  }

  /** Пора ли утренний прогон: наступил час start_hour (часовой пояс сервиса), а сегодня прогона ещё не было. */
  function due(tz = config.DIGEST_TZ || 'Europe/Moscow') {
    const s = settings();
    if (!s.enabled) return false;
    const t = clock();
    const part = (o) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...o }).format(t);
    // не только в сам час: если сервер в этот час был занят (ночной агент держал его до 06:29), прогон догоняет позже
    // в тот же день — до 8 часов после start_hour
    const hour = Number(part({ hour: '2-digit', hourCycle: 'h23' }));
    if (hour < s.start_hour || hour >= s.start_hour + 8) return false;
    const today = part({ year: 'numeric', month: '2-digit', day: '2-digit' });
    const last = db.prepare("SELECT started_at FROM bid_agent_runs WHERE reason = 'morning' ORDER BY id DESC LIMIT 1").get();
    return !last || new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(last.started_at)) !== today;
  }

  /**
   * Прогон, прерванный перезапуском рабочего процесса (выкладка, сбой): в базе он остался «идёт» навсегда, а закупка,
   * на которой он стоял, — «в работе». Закрываем их как прерванные. Вызывает только рабочий процесс при запуске —
   * сервис этого делать не должен: прогон в это время может идти в рабочем процессе.
   */
  function recoverInterrupted() {
    const at = now();
    const runs = db.prepare("UPDATE bid_agent_runs SET status = 'error', finished_at = ?, stats_json = json_set(COALESCE(stats_json, '{}'), '$.error', 'прогон прерван перезапуском') WHERE finished_at IS NULL").run(at).changes;
    const items = db.prepare("UPDATE bid_agent_items SET status = 'error', reason = 'прогон прерван перезапуском — закупку возьмёт следующий прогон', updated_at = ? WHERE status = 'running'").run(at).changes;
    return { runs, items };
  }

  return {
    recoverInterrupted,
    settings, saveSettings, parseTask: (text) => parseTask(text, settings(), niches()), niches, candidates, run, view, item, decide,
    dismissFinding, checkOutcomes, markRead, due, reportText, idle: () => running || Promise.resolve(), isRunning: () => Boolean(running),
  };
}

module.exports = { createBidAgent, parseTask, cleanSettings, floorPrice, profitAt, judgeOutcome, DEFAULTS };
