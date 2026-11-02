// Страна происхождения и товарный знак для заявки — без участия человека (часть агента итогового пакета).
// Откуда, по очереди:
//   1) характеристики предложения, уже собранные со страницы товара («Страна производства», «Место изготовления»,
//      «Бренд», «Торговая марка», «Производитель / Бренд»);
//   2) страница товара у поставщика — открывается заново, если характеристик нет (не чаще одного раза в сутки);
//   3) своя база товаров (products) — по модели из названия;
//   4) та же модель у других поставщиков.
// Спорное (3 и 4 — не страница вашего поставщика) в заявку само не ставится: только подсказка, решаете вы
// (marks_suggest). Автоматизацию спорного — позже, когда по урокам будет видно, насколько такие подсказки верны.
// Чему учится: что нашёл и где — в marks_auto; вы потом поставили другое значение — урок «ошибся» по сайту, где нашёл
// (agents/application.learnFromUser видит вашу правку); сайты, где страна не находится никогда, видны в уроках.
// Регистрационное удостоверение ФСЗ (иностранное изделие) — подсказка «не Россия»: страну не ставит, но «Россия»
// с таким удостоверением не принимается.

const { specsFromPage } = require('../offers/product');
const { modelFromTitle } = require('../offers/product-base');

const COUNTRIES = ['Россия', 'Китай', 'Беларусь', 'Казахстан', 'Германия', 'Италия', 'Франция', 'Испания', 'Польша', 'Чехия', 'Венгрия',
  'Турция', 'Индия', 'Пакистан', 'Вьетнам', 'Таиланд', 'Малайзия', 'Индонезия', 'Тайвань', 'Корея', 'Япония', 'США', 'Канада', 'Мексика',
  'Великобритания', 'Швеция', 'Финляндия', 'Дания', 'Нидерланды', 'Бельгия', 'Австрия', 'Швейцария', 'Израиль', 'Узбекистан', 'Армения',
  'Сербия', 'Словения', 'Словакия', 'Литва', 'Латвия', 'Эстония', 'Украина', 'Египет', 'Бразилия', 'Филиппины', 'Сингапур', 'Португалия', 'Румыния', 'Болгария', 'Греция', 'Ирландия'];
const ALIAS = [[/росси|russia|\bрф\b/i, 'Россия'], [/кнр|china|китай/i, 'Китай'], [/белорус|беларус|belarus/i, 'Беларусь'], [/южн\w* коре|корея|korea/i, 'Корея'],
  [/германи|germany/i, 'Германия'], [/\bсша\b|usa|соединенн/i, 'США'], [/тайван|taiwan/i, 'Тайвань'], [/япони|japan/i, 'Япония'], [/турци|turkey/i, 'Турция'], [/инди[яи]\b|india/i, 'Индия']];
const COUNTRY_KEY = /страна\s*(производ|изготов|происх|сборк)|место\s+(изготов|производ)|^страна\b|made\s+in|country/i;
const BRAND_KEY = /бренд|торгов\w*\s+марк|товарн\w*\s+знак|^марка$|brand/i;
const MAKER_KEY = /^производитель/i;

const clean = (v) => String(v || '').replace(/[?*]+/g, ' ').replace(/\s+/g, ' ').trim();
function countryOf(v) {
  const s = clean(v);
  if (!s || /не\s+указ|^—$|^-$/i.test(s)) return null;
  for (const [re, name] of ALIAS) if (re.test(s)) return name;
  const hit = COUNTRIES.find((c) => s.toLowerCase().includes(c.toLowerCase().slice(0, Math.max(4, c.length - 1))));
  return hit || null;
}
function brandOf(v) {
  const s = clean(v).replace(/^(ооо|зао|оао|ао|пао|ип)\s+/i, '').replace(/["«»]/g, '');
  if (!s || s.length > 40 || countryOf(s) === s) return null;
  // «Пакистан, Surgiwell» — производитель со страной: знак — без страны
  return s.split(/\s*,\s*/).find((x) => !countryOf(x)) || null;
}

/** Из пар «название: значение». @returns {{country, trademark, how}} */
function fromSpecs(specs = []) {
  let country = null; let trademark = null; let maker = null;
  for (const x of specs) {
    const n = clean(x.name).replace(/\s*—$/, '');
    if (!country && COUNTRY_KEY.test(n)) country = countryOf(x.value);
    if (!trademark && BRAND_KEY.test(n)) trademark = brandOf(x.value);
    if (MAKER_KEY.test(n)) { maker = maker || brandOf(x.value); if (!country) country = /,/.test(String(x.value)) ? countryOf(x.value) : null; }
  }
  const fsz = specs.some((x) => /ФСЗ\s*\d/i.test(String(x.value)));
  if (fsz && country === 'Россия') country = null; // иностранное удостоверение — «Россия» не верим
  return { country, trademark: trademark || maker, fsz };
}

/** Из текста страницы: «Страна производства: Китай», «Производитель: X». */
function fromText(text = '') {
  const t = String(text).slice(0, 20000);
  const c = /(?:страна\s*(?:производства|изготовления|происхождения|производитель)|место\s+изготовления|сделано\s+в)\s*[:\-—]?\s*([А-ЯЁA-Z][^\n,.;]{2,30})/i.exec(t);
  const b = /(?:бренд|торговая\s+марка|товарный\s+знак)\s*[:\-—]\s*([^\n,.;]{2,30})/i.exec(t);
  return { country: c ? countryOf(c[1]) : null, trademark: b ? brandOf(b[1]) : null };
}

function createMarksFinder({ repo, journal, fetchPage = null, clock = () => new Date(), log = console }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS marks_auto (
    item_id INTEGER PRIMARY KEY, offer_id INTEGER, domain TEXT, trademark TEXT, country TEXT, how TEXT, at TEXT, judged INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS marks_suggest (item_id INTEGER PRIMARY KEY, tender_id INTEGER, trademark TEXT, country TEXT, how TEXT, at TEXT);
  CREATE TABLE IF NOT EXISTS marks_verdicts (item_id INTEGER PRIMARY KEY, kind TEXT, agree INTEGER, suggested TEXT, chosen TEXT, at TEXT)`);
  // когда спорное можно ставить без человека: по виду источника не меньше READY_MIN ваших решений и совпало ≥ READY_SHARE
  const READY_MIN = 20;
  const READY_SHARE = 0.9;
  const kindOf = (how) => (/своя база/.test(how || '') ? 'своя база товаров' : 'та же модель у других поставщиков');
  const now = () => clock().toISOString();
  const today = () => now().slice(0, 10);

  /** @returns {Promise<{country, trademark, how: string[]}>} */
  async function find(offer, { need = { country: true, trademark: true } } = {}) {
    const out = { country: null, trademark: null, how: [], suggest: { country: null, trademark: null, how: [] } };
    // спорный источник — только в подсказку
    const hint = (got, how) => {
      const s = out.suggest;
      let used = false;
      if (need.country && !out.country && !s.country && got.country) { s.country = got.country; used = true; }
      if (need.trademark && !out.trademark && !s.trademark && got.trademark) { s.trademark = got.trademark; used = true; }
      if (used) s.how.push(how);
    };
    const hinted = () => (!need.country || out.country || out.suggest.country) && (!need.trademark || out.trademark || out.suggest.trademark);
    const take = (got, how) => {
      let used = false;
      if (need.country && !out.country && got.country) { out.country = got.country; used = true; }
      if (need.trademark && !out.trademark && got.trademark) { out.trademark = got.trademark; used = true; }
      if (used) out.how.push(how);
    };
    const done = () => (!need.country || out.country) && (!need.trademark || out.trademark);
    const s = fromSpecs(offer.specs || []);
    take(s, 'характеристики');
    // страница товара — заново, не чаще раза в сутки на предложение
    const url = offer.product_url || offer.url;
    const key = `marks:page:${offer.id}`;
    if (!done() && url && fetchPage && repo.getSetting(key) !== today()) {
      repo.setSetting(key, today());
      try {
        const page = await fetchPage(url);
        const ps = fromSpecs(specsFromPage(page.html || ''));
        if (s.fsz || ps.fsz) { if (ps.country === 'Россия') ps.country = null; }
        take(ps, 'страница товара');
        if (!done()) { const ft = fromText(page.text || ''); if ((s.fsz || ps.fsz) && ft.country === 'Россия') ft.country = null; take(ft, 'текст страницы'); }
      } catch (err) { log.warn?.(`[страна и знак] ${offer.domain}: ${err.message}`); }
    }
    // своя база товаров — по модели (спорное)
    if (!hinted()) {
      const model = modelFromTitle(String(offer.title || ''));
      if (model && model.replace(/[^a-zа-я0-9]/gi, '').length >= 4) {
        let p = null;
        try { p = db.prepare('SELECT brand, specs_json FROM products WHERE model = ? COLLATE NOCASE LIMIT 1').get(model); } catch { p = null; } // базы товаров нет
        if (p) {
          let specs = [];
          try { specs = JSON.parse(p.specs_json || '[]'); } catch { specs = []; }
          const b = fromSpecs(Array.isArray(specs) ? specs : []);
          hint({ country: b.country, trademark: b.trademark || brandOf(p.brand) }, 'своя база товаров');
        }
      }
    }
    // та же модель у других поставщиков — у кого-то страна указана (магазины часто её не пишут); спорное
    if (!hinted()) {
      const model = modelFromTitle(String(offer.title || ''));
      if (model && model.replace(/[^a-zа-я0-9]/gi, '').length >= 5) {
        const rows = db.prepare("SELECT title, specs_json, domain FROM offers WHERE id != ? AND title LIKE ? AND specs_json LIKE '%трана%' LIMIT 30").all(offer.id, `%${model}%`);
        for (const r of rows) {
          let specs = [];
          try { specs = JSON.parse(r.specs_json || '[]'); } catch { continue; }
          const got = fromSpecs(specs);
          if (got.fsz && got.country === 'Россия') continue;
          hint({ country: got.country, trademark: got.trademark }, `та же модель на ${r.domain}`);
          if (hinted()) break;
        }
      }
    }
    return out;
  }

  /**
   * Позиции заявки без страны или знака: найти и записать через charService.
   * @param chars — charService.view(tenderId); offerOf(itemId) → предложение
   * @returns {Promise<number>} сколько позиций дописано
   */
  async function fill(tenderId, chars, offerOf, charService) {
    let n = 0;
    for (const t of chars?.tables || []) {
      if (t.trademark && t.country) continue;
      const offer = offerOf(t.item_id);
      if (!offer) continue;
      const got = await find(offer, { need: { country: !t.country, trademark: !t.trademark } });
      const patch = { item_id: t.item_id, ...(got.country ? { country: got.country } : {}), ...(got.trademark ? { trademark: got.trademark } : {}) };
      if (Object.keys(patch).length > 1) {
        await charService.save(tenderId, patch);
        db.prepare('INSERT OR REPLACE INTO marks_auto (item_id, offer_id, domain, trademark, country, how, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(t.item_id, offer.id, offer.domain || '', got.trademark || null, got.country || null, got.how.join(', '), now());
        n++;
      }
      const s = got.suggest;
      if (s.country || s.trademark) {
        db.prepare('INSERT OR REPLACE INTO marks_suggest (item_id, tender_id, trademark, country, how, at) VALUES (?, ?, ?, ?, ?, ?)').run(t.item_id, tenderId, s.trademark || null, s.country || null, s.how.join(', '), now());
        journal.metric('package', 'marks_suggested', 1);
      }
      if (!t.country && !got.country) journal.lesson('package', 'country_not_found', 'Страна происхождения не нашлась у поставщика', { scope: offer.domain || '', tenderId, text: String(offer.title || '').slice(0, 120), source: 'self' });
      journal.metric('package', got.country || got.trademark ? 'marks_found' : 'marks_missed', 1);
    }
    return n;
  }

  /** Ваша правка против найденного агентом: другое значение — урок «ошибся» по сайту. Раз на позицию. */
  function judge() {
    judgeSuggestions();
    let wrong = 0;
    for (const a of db.prepare('SELECT * FROM marks_auto WHERE judged = 0').all()) {
      let v = {};
      try { v = JSON.parse(repo.getSetting(`bidchars:${a.item_id}`) || '{}'); } catch { continue; }
      const by = v.by || v.source || null;
      if (by === 'agent') continue;
      const diff = (a.country && v.country && v.country !== a.country) || (a.trademark && v.trademark && v.trademark.toLowerCase() !== a.trademark.toLowerCase());
      if (!diff) continue;
      db.prepare('UPDATE marks_auto SET judged = 1 WHERE item_id = ?').run(a.item_id);
      journal.lesson('package', 'marks_wrong', 'Страна или знак найдены неверно — вы исправили', { scope: a.domain, text: `было ${a.country || '—'} / ${a.trademark || '—'}, стало ${v.country || '—'} / ${v.trademark || '—'} (${a.how})`, source: 'human' });
      wrong++;
    }
    return wrong;
  }

  /** Подсказки по закупке — для показа человеку. */
  // вписали сами — подсказка больше не нужна
  const suggestions = (tenderId) => db.prepare('SELECT * FROM marks_suggest WHERE tender_id = ?').all(tenderId).filter((s) => {
    let v = {};
    try { v = JSON.parse(repo.getSetting(`bidchars:${s.item_id}`) || '{}'); } catch { v = {}; }
    return (s.country && !v.country) || (s.trademark && !v.trademark);
  });

  /** Вы вписали значение по подсказке — совпало ли с подсказкой. Раз на позицию. */
  function judgeSuggestions() {
    let n = 0;
    for (const s of db.prepare('SELECT * FROM marks_suggest WHERE item_id NOT IN (SELECT item_id FROM marks_verdicts)').all()) {
      let v = {};
      try { v = JSON.parse(repo.getSetting(`bidchars:${s.item_id}`) || '{}'); } catch { continue; }
      const field = s.country ? 'country' : 'trademark';
      if (!v[field]) continue;
      const agree = String(v[field]).toLowerCase().replace(/ё/g, 'е') === String(s[field]).toLowerCase().replace(/ё/g, 'е');
      db.prepare('INSERT INTO marks_verdicts (item_id, kind, agree, suggested, chosen, at) VALUES (?, ?, ?, ?, ?, ?)').run(s.item_id, kindOf(s.how), agree ? 1 : 0, s[field], v[field], now());
      if (!agree) journal.lesson('package', 'suggest_wrong', 'Подсказка страны или знака не совпала с вашим решением', { scope: kindOf(s.how), text: `подсказано ${s[field]}, вы вписали ${v[field]} (${s.how})`, source: 'human' });
      n++;
    }
    return n;
  }

  /** Готовность спорных источников к работе без человека — для управляющего. */
  function readiness() {
    return db.prepare('SELECT kind, COUNT(*) n, SUM(agree) agree FROM marks_verdicts GROUP BY kind').all()
      .map((r) => ({ kind: r.kind, n: r.n, agree: r.agree || 0, share: r.n ? Math.round(((r.agree || 0) / r.n) * 100) : 0, ready: r.n >= READY_MIN && (r.agree || 0) / r.n >= READY_SHARE, need: READY_MIN }));
  }

  return { find, fill, judge, judgeSuggestions, suggestions, readiness };
}

module.exports = { createMarksFinder, fromSpecs, fromText, countryOf };
