// Собирает демо-версию для показа по ссылке (Artifact на claude.ai): один HTML-файл без сервера.
// Интерфейс — тот же public/index.html + help.js; данные — снимок из data/app.db;
// обращения к /api/* обслуживает встроенный заменитель fetch.
// Запуск: node demo/build-demo.js  →  demo/tender-ai-demo.html

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ECONOMICS_DEFAULTS, priceVariants } = require('../server/tenders/economics');
const os = require('node:os');
const { createRepo, openDb } = require('../server/db');
const { rankOffers } = require('../server/offers/rank');
const { competitorsOf, competitorPrice } = require('../server/offers/seller-kind');
const { createSupplierCatalog, attachProducts } = require('../server/offers/supplier-catalog');
const config = require('../server/config');
const directions = require('../server/tenders/directions');
const productGroups = require('../server/tenders/product-groups');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'tender-ai-demo.html');
// Разборы, которые попадут в демо: эталонный комплект и реальная закупка из ЕИС.
const ANALYSES = ['90b29568-76ff-453f-97a2-623bb3b7e5d6', 'c8bdbf63-669b-4cae-9da5-863ae96a47c3'];

// Снимок строим с копии базы: копию можно привести к текущей схеме (новые колонки и таблицы появляются при открытии),
// а рабочая база остаётся нетронутой. VACUUM INTO даёт целую копию даже при включённом WAL.
const SNAP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-demo-'));
{
  const src = new DatabaseSync(path.join(ROOT, 'data', 'app.db'), { readOnly: true });
  src.exec(`VACUUM INTO '${path.join(SNAP_DIR, 'app.db').replace(/'/g, "''")}'`);
  src.close();
}
const db = openDb(SNAP_DIR, { recoverInterrupted: false }).db;
process.on('exit', () => { try { db.close(); } catch { /* уже закрыта */ } fs.rmSync(SNAP_DIR, { recursive: true, force: true }); });
const J = (v, d) => (v == null ? d : JSON.parse(v));

// ---------- снимок данных ----------
const p = db.prepare('SELECT * FROM profile WHERE id = 1').get();
const profile = {
  mode: p.mode === 'profile' ? 'profile' : 'resale',
  description: p.description, regions: J(p.regions_json, []), price_min: p.price_min, price_max: p.price_max,
  codes: J(p.codes_json, []), keywords: J(p.keywords_json, []), stop_words: J(p.stop_words_json, []),
  min_days_to_deadline: p.min_days_to_deadline, laws: J(p.laws_json, []), score_threshold: p.score_threshold,
  digest_size: p.digest_size, version: p.version, updated_at: p.updated_at,
  economics: { ...ECONOMICS_DEFAULTS, ...J(p.economics_json, {}) },
  feed_min_margin_pct: 20, // порог маржи для ленты — как в рабочей версии по умолчанию
};
// Направления: из профиля; в демо, если ни одно не включено, для показа включаем все стандартные.
profile.directions = J(p.directions_json, null) || directions.seedDirections({ codes: profile.codes, keywords: profile.keywords });
if (!profile.directions.some((d) => d.enabled)) profile.directions = profile.directions.map((d) => ({ ...d, enabled: true }));

const analyses = ANALYSES.map((id) => {
  const a = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id);
  if (!a) throw new Error(`Нет разбора ${id} в data/app.db`);
  const files = db.prepare('SELECT id, original_name, mime, status, message, pages_count, text_json FROM files WHERE analysis_id = ? ORDER BY id').all(id);
  const { card_json, progress, ...rest } = a;
  return {
    ...rest,
    progress: null,
    card: J(card_json, null),
    // В именах файлов подписи ЕИС стоит ФИО подписанта — в демо его убираем.
    files: files.map(({ text_json, ...f }) => ({ ...f, original_name: f.original_name.replace(/_[^/_]+\.sig$/i, '_подпись.sig'), pages: J(text_json, []) })),
  };
});
const analysisIds = new Set(ANALYSES);

const COLS = `(SELECT verdict FROM tender_economics e WHERE e.tender_id = tenders.id) AS econ_verdict,
  (SELECT profit FROM tender_economics e WHERE e.tender_id = tenders.id) AS econ_profit,
  (SELECT margin_pct FROM tender_economics e WHERE e.tender_id = tenders.id) AS econ_margin,
  (SELECT opportunity FROM tender_economics e WHERE e.tender_id = tenders.id) AS econ_opportunity,
  (SELECT confirmed FROM tender_economics e WHERE e.tender_id = tenders.id) AS econ_confirmed,
  (SELECT SUM(COALESCE(i.purchase_price_manual, i.purchase_price_offer) * COALESCE(i.quantity, 1)) FROM tender_items i WHERE i.tender_id = tenders.id) AS econ_purchase, id, law, number, title, price, currency, region, okpd2_json, ktru_json, customer_inn, published_at, deadline_at,
  stage, eis_url, status, filter_reason, score, verdict, reasons_json, concerns_json, score_error, analysis_id, first_seen_at`
  + (db.prepare('PRAGMA table_info(tenders)').all().some((c) => c.name === 'platform') ? ', platform, platform_url' : ', NULL AS platform, NULL AS platform_url');
const pick = (sql, ...args) => db.prepare(`SELECT ${COLS} FROM tenders ${sql}`).all(...args);
const rows = [
  ...pick('WHERE id IN (SELECT tender_id FROM tender_economics WHERE opportunity IS NOT NULL) ORDER BY (SELECT opportunity FROM tender_economics e WHERE e.tender_id = tenders.id) DESC LIMIT 40'),
  ...pick('WHERE id IN (SELECT tender_id FROM tender_economics) ORDER BY id LIMIT 40'),
  ...pick("WHERE status = 'scored' ORDER BY score DESC, deadline_at LIMIT 90"),
  ...pick("WHERE status = 'scored' AND score < 70 ORDER BY id LIMIT 60"),
  ...pick("WHERE status = 'filtered' ORDER BY id LIMIT 25"),
  ...pick("WHERE status = 'dismissed' ORDER BY id LIMIT 5"),
  ...pick('WHERE analysis_id IN (?, ?)', ...ANALYSES),
];
const seen = new Set();
const tenders = rows.filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => {
  const { okpd2_json, ktru_json, reasons_json, concerns_json, ...t } = r;
  const linked = t.analysis_id && analysisIds.has(t.analysis_id) ? analyses.find((a) => a.id === t.analysis_id) : null;
  return {
    ...t,
    okpd2: J(okpd2_json, []), ktru: J(ktru_json, []), reasons: J(reasons_json, []), concerns: J(concerns_json, []),
    analysis_id: linked ? linked.id : null,
    analysis_status: linked ? linked.status : null,
    analysis_recommendation: linked?.card?.summary?.recommendation?.value ?? null,
  };
});
const lastSync = db.prepare("SELECT * FROM sync_runs WHERE source != 'rescore' ORDER BY id DESC LIMIT 1").get() || null;
const snapshotAt = lastSync?.finished_at || new Date().toISOString();

// Карточки закупок с посчитанной выгодностью: позиции, ориентир, расчёт.
const cards = {};
for (const t of tenders.filter((x) => x.econ_verdict)) {
  const items = db.prepare('SELECT * FROM tender_items WHERE tender_id = ? ORDER BY idx').all(t.id)
    .map(({ characteristics_json, ...i }) => ({ ...i, characteristics: J(characteristics_json, []) }));
  const benchmarks = {};
  for (const code of [...new Set(items.map((i) => i.ktru_code || i.okpd2_code).filter(Boolean))]) {
    const b = db.prepare('SELECT data_json FROM benchmarks WHERE code = ?').get(code);
    if (b) benchmarks[code] = J(b.data_json, null);
  }
  const e = db.prepare('SELECT * FROM tender_economics WHERE tender_id = ?').get(t.id);
  const d = db.prepare('SELECT * FROM tender_details WHERE tender_id = ?').get(t.id);
  const economics = { overrides: J(e.overrides_json, {}), result: J(e.result_json, null), verdict: e.verdict, profit: e.profit, margin_pct: e.margin_pct, computed_at: e.computed_at,
    opportunity: e.opportunity, confirmed: e.confirmed == null ? null : Boolean(e.confirmed) };
  if (economics.result?.result && t.price > 0) {
    const inp = economics.result.inputs || {};
    try { economics.price_variants = priceVariants({ ...inp, nmck: t.price, settings: profile.economics, logistics: economics.overrides.logistics ?? null }, economics.result); } catch { /* без таблицы вариантов */ }
  }
  cards[t.id] = {
    items, benchmarks, economics,
    details: d ? { items_source: d.items_source, error: d.error, conditions: J(d.conditions_json, {}) } : null,
    auto: economics.result?.inputs || null, // входы без ручных значений — основа для пересчёта в браузере
  };
}

// Поиск поставщиков: сохранённые результаты — как их отдаёт /api/tenders/:id/offers.
const repo = createRepo(db);
for (const t of tenders) t.direction = directions.tenderDirection(t, profile, repo.getItems(t.id));
// Группы товаров: к каким группам каталога относится каждая закупка снимка.
const groupRows = new Map(repo.tendersForGroups(true).map((r) => [r.id, { text: r.title.toLowerCase().replace(/ё/g, 'е'), codes: r.codes, itemCodes: r.itemCodes }]));
for (const t of tenders) t.groups = groupRows.has(t.id) ? productGroups.loadGroups().filter((g) => productGroups.inGroup(g, groupRows.get(t.id))).map((g) => g.id) : [];
const catalog = productGroups.loadGroups().map((g) => ({ id: g.id, title: g.title, section: g.section, aliases: g.aliases, covered: productGroups.isCovered(g, profile) }));
const offerSources = { contracts: true, yandex: config.YANDEX_SEARCH_API_KEY ? 'on' : 'no_key', stores: [], dadata: config.DADATA_API_KEY ? 'on' : 'no_key' };
try { offerSources.stores = JSON.parse(fs.readFileSync(config.STORES_CONFIG, 'utf8')).stores.filter((x) => x.enabled).map((x) => x.name); } catch { /* нет списка магазинов */ }
// Профильные компании для запроса цены (кандидаты) и готовый текст запроса КП по каждой позиции.
const supplierCatalog = createSupplierCatalog({ config, repo });
const rfq = {};
const offers = {};
for (const t of tenders.filter((x) => cards[x.id])) {
  const all = repo.getOffers(t.id);
  if (!all.length) continue;
  const allocations = repo.getAllocations(t.id);
  offers[t.id] = {
    groups: repo.getItems(t.id).map((item) => ({
      item_id: item.id, selected_offer_id: item.purchase_offer_id, selected_by: item.purchase_selected_by,
      // набор партии позиции — как его отдаёт сервер (в демо набор не меняется)
      ...(() => {
        const need = item.quantity || 1;
        const rows = allocations.filter((a) => a.item_id === item.id).map((a) => {
          const o = all.find((x) => x.id === a.offer_id);
          return o ? { offer_id: o.id, qty: a.qty, delivery_cost: a.delivery_cost, note: a.note, seller: o.seller_name || o.domain || o.title, url: o.url,
            unit_price: o.unit_price, goods_cost: o.unit_price != null ? Math.round(o.unit_price * a.qty * 100) / 100 : null,
            stock_qty: o.stock_qty, stock_note: o.stock_note, delivery_carrier: o.delivery_carrier } : null;
        }).filter(Boolean);
        const covered = Math.round(rows.reduce((n, x) => n + x.qty, 0) * 100) / 100;
        return { needed: need, allocations: rows, covered, missing: Math.max(0, Math.round((need - covered) * 100) / 100) };
      })(),
      // где купить — магазины и ручные предложения; победители прошлых контрактов — отдельным списком «конкуренты»
      ...rankOffers(all.filter((o) => o.item_id === item.id && o.source !== 'contracts'), { trustThreshold: config.SELLER_TRUST_THRESHOLD }),
      ...(() => { const competitors = competitorsOf(all.filter((o) => o.item_id === item.id), item); return { competitors, competitor_price: competitorPrice(competitors) }; })(),
      ...(() => {
        const candidates = supplierCatalog.forItem(item);
        // текст запроса от компании не зависит — храним один на позицию
        if (candidates.length) { const d = supplierCatalog.draft(t, item, candidates[0].site); rfq[item.id] = { subject: d.subject, body: d.body }; }
        // товар и цена у компаний с открытыми ценами — из тех же сохранённых предложений
        return { candidates: attachProducts(candidates, all.filter((o) => o.item_id === item.id)) };
      })(),
    })),
    search: ((s) => (s ? { ...s, funnel: (s.funnel || []).map(require('../server/offers/funnel').describeFunnel) } : s))(repo.lastOfferSearch(t.id)),
    sources: offerSources,
  };
}

const DATA = { profile, analyses, tenders, cards, offers, rfq, deals: {}, rnpSearchUrl: config.RNP_SEARCH_URL, lastSync, snapshotAt, standardDirections: directions.loadStandard(), catalog,
  regions: Object.fromEntries(Object.entries(require('../server/offers/logistics').REGIONS).map(([code, [city]]) => [code, city])) };

// ---------- заменитель сервера ----------
const SHIM = `
<script>
(function () {
  const D = JSON.parse(document.getElementById('demo-data').textContent);
  window.__NOW = new Date(D.snapshotAt).getTime(); // сроки подачи считаются от даты снимка
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const no = (msg) => json({ error: msg }, 400);
  const listItem = (a) => ({ id: a.id, title: a.title, status: a.status, created_at: a.created_at, recommendation: a.card?.summary?.recommendation?.value ?? null });
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, opts);
    const method = (opts.method || 'GET').toUpperCase();
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // без "api"
    const q = url.searchParams;

    if (parts[0] === 'health') return json({ ok: true, provider: 'mock', tenderSource: 'демо-снимок', telegram: false, feedMinMarginPct: D.profile.feed_min_margin_pct || 0, rnpSearchUrl: D.rnpSearchUrl });

    if (parts[0] === 'analyses') {
      if (method === 'POST') return no('В демо-версии загрузка файлов отключена. В рабочей версии сервис прочитает документы и соберёт карточку за пару минут.');
      if (!parts[1]) return json(D.analyses.map(listItem));
      const a = D.analyses.find((x) => x.id === parts[1]);
      if (!a) return json({ error: 'Разбор не найден' }, 404);
      if (method === 'DELETE') { D.analyses = D.analyses.filter((x) => x !== a); return json({ ok: true }); }
      if (parts[2] === 'legal') return no('В демо-версии проверка не запускается. В рабочей версии сервис сверяет условия закупки с законом и готовит письмо заказчику.');
      if (parts[2] === 'letter' || parts[2] === 'letter.md') {
        return a.letter ? json(a.letter) : json({ error: 'Письмо не требуется: спорных условий нет либо правовая проверка для этого разбора не выполнялась' }, 404);
      }
      if (parts[2] === 'files') {
        const f = a.files.find((x) => x.id === Number(parts[3]));
        const pg = f?.pages.find((x) => x.page === Number(parts[5]));
        return pg ? json({ file: f.original_name, page: pg.page, pagesCount: f.pages.length, text: pg.text }) : json({ error: 'Страница не найдена' }, 404);
      }
      return json({ ...a, files: a.files.map(({ pages, ...f }) => f) });
    }

    // анкета участника и его документы: в демо не ведутся — раздел «Профиля» показывает это одной строкой
    if (parts[0] === 'dossier') return no('В демо-версии анкета участника не ведётся. В рабочей версии вы один раз заполняете сведения о себе и загружаете документы — сервис подбирает их к каждой закупке и следит за сроками.');
    if (parts[0] === 'profile' && parts[1] === 'feed') {
      D.profile.feed_min_margin_pct = Math.max(0, Math.min(Number(JSON.parse(opts.body || '{}').min_margin_pct) || 0, 100));
      return json({ feed_min_margin_pct: D.profile.feed_min_margin_pct });
    }
    if (parts[0] === 'profile') {
      if (method === 'PUT') {
        const b = JSON.parse(opts.body || '{}');
        const nums = (arr) => (arr || []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 100);
        if (!b.laws || !b.laws.length) return no('Профиль: laws — выберите хотя бы один закон');
        D.profile = { ...D.profile, ...b, economics: { ...D.profile.economics, ...Object.fromEntries(Object.entries(b.economics || {}).map(([k, v]) => [k, k === 'tax_mode' ? v : Number(v)])) }, regions: nums(b.regions), price_min: b.price_min === '' ? null : Number(b.price_min), price_max: b.price_max === '' ? null : Number(b.price_max),
          min_days_to_deadline: Number(b.min_days_to_deadline), score_threshold: Number(b.score_threshold), digest_size: Number(b.digest_size),
          version: D.profile.version + 1, updated_at: new Date().toISOString() };
        return json(D.profile);
      }
      return json(D.profile);
    }

    if (parts[0] === 'regions') return json(D.regions || {});

    if (parts[0] === 'product-groups') {
      if (method === 'POST') return no('В демо-версии направления не меняются. В рабочей версии кнопка добавит группу в направления, и сервис начнёт загружать такие закупки.');
      const shown = D.tenders.filter((x) => x.status !== 'filtered' && x.status !== 'dismissed');
      return json({ can_add: true, groups: D.catalog.map((g) => ({ ...g, count: shown.filter((x) => (x.groups || []).includes(g.id)).length })) });
    }

    if (parts[0] === 'directions' && method === 'POST') return no('В демо-версии направления не меняются. В рабочей версии крестик убирает направление с главного экрана, а строка «Убрано» возвращает его.');
    if (parts[0] === 'directions') {
      const shown = D.tenders.filter((x) => x.status !== 'filtered' && x.status !== 'dismissed');
      const on = (D.profile.directions || []).filter((d) => d.enabled).length;
      return json({
        items: (D.profile.directions || []).map((d) => ({ ...d, count: shown.filter((x) => x.direction === d.id).length })),
        none: shown.filter((x) => !x.direction).length, total: shown.length, active: D.profile.mode !== 'profile' && on > 0,
        search_words_each: on ? Math.max(1, Math.min(5, Math.floor(15 / on))) : 0, standard: D.standardDirections,
      });
    }

    if (parts[0] === 'platforms') {
      if (method === 'POST') return json({ started: false, pending: 0 }, 202);
      const dir = q.get('direction');
      const live = D.tenders.filter((x) => x.status !== 'filtered' && x.status !== 'dismissed' && (!x.deadline_at || new Date(x.deadline_at).getTime() > window.__NOW)
        && (!dir || (dir === 'none' ? !x.direction : x.direction === dir)));
      const pubOf = (x) => (x.law === 'com' ? 'com' : 'eis');
      const pubSel = (q.get('published') || '').split(',').filter(Boolean);
      const platSel = (q.get('platforms') || '').split('|').filter(Boolean);
      // счётчики одного вопроса — в пределах отмеченного в другом
      const byPlat = new Map();
      for (const x of live.filter((y) => !pubSel.length || pubSel.includes(pubOf(y)))) {
        const r = byPlat.get(x.platform || '') || { name: x.platform || null, url: x.platform_url || null, count: 0 };
        r.count++;
        byPlat.set(x.platform || '', r);
      }
      const rows = [...byPlat.values()].sort((a, b) => b.count - a.count);
      const onPlat = live.filter((x) => !platSel.length || platSel.includes(x.platform || '?'));
      return json({
        published: [
          { id: 'eis', name: 'ЕИС — госзакупки по 44-ФЗ и 223-ФЗ', url: 'https://zakupki.gov.ru', count: onPlat.filter((x) => pubOf(x) === 'eis').length },
          { id: 'com', name: 'Вне ЕИС — коммерческие закупки', url: null, count: onPlat.filter((x) => pubOf(x) === 'com').length },
        ],
        items: rows.filter((r) => r.name), unknown: (rows.find((r) => !r.name) || { count: 0 }).count, total: live.length, filling: false,
      });
    }

    if (parts[0] === 'tenders') {
      // закупки из своих документов: в демо файлы не принимаются, своих закупок нет
      if (parts[1] === 'manual') return no('В демо-версии добавление закупок выключено. В рабочей версии сервис прочитает ваши документы и откроет карточку закупки с позициями, поставщиками и расчётом.');
      if (!parts[1] && q.get('manual') === '1') return json({ total: 0, items: [], hidden_by_margin: 0, manual_total: 0 });
      // расчёт сделки: снимок, собранный при сборке демо; правки не сохраняются
      if (parts[2] === 'deal') {
        if (method === 'GET' && !parts[3]) return D.deals[parts[1]] ? json(D.deals[parts[1]]) : no('Для этой закупки в демо нет расчёта сделки.');
        return no('В демо-версии расчёт сделки показан снимком: поправки, подтверждение цен, проверки и утверждение не сохраняются. В рабочей версии всё пересчитывается сразу.');
      }
      // шаг «Заявка»: в демо дел нет и они не собираются
      if (parts[2] === 'bids') return method === 'GET' ? json({ none: true }) : no('В демо-версии заявка не собирается. В рабочей версии сервис определит вид закупки, составит перечень требований к заявке и покажет, чего не хватает.');
      const t = parts[1] && D.tenders.find((x) => x.id === Number(parts[1]));
      if (parts[1] && !t) return json({ error: 'Закупка не найдена' }, 404);
      if (parts[2] === 'dismiss') { t.status = 'dismissed'; return json({ ok: true }); }
      if (parts[1] && !parts[2] && method === 'GET') {
        const c = D.cards[t.id];
        if (!c) return no('В демо-версии расчёт выгодности есть только у закупок с цветной меткой «выгодно / на грани / невыгодно». Отфильтруйте ленту галочкой «только выгодные» или сортировкой «Сначала выгодные».');
        return json({ tender: t, ...c });
      }
      if (parts[2] === 'customer') return json({ customer: (D.cards[t.id] && D.cards[t.id].details && D.cards[t.id].details.conditions && D.cards[t.id].details.conditions.customer) || {} });
      if (parts[2] === 'items' && parts[4] === 'marketplaces') return json({ item_id: Number(parts[3]), models: [], spent: 0, available: false,
        error: 'В демо-версии поиск модели на маркетплейсах выключен. В рабочей версии сервис находит на Ozon, Wildberries, Яндекс Маркете и Мегамаркете карточки той же модели, что сверена с ТЗ.' });
      if (parts[2] === 'items') return no('В демо-версии набор партии не меняется. В рабочей версии можно набрать нужное количество у нескольких продавцов.');
      if (parts[2] === 'supplier-candidates' && parts[3] === 'lookup') return json({ checked: 0, found: 0, left: 0, groups: D.offers[t.id] ? D.offers[t.id].groups : [] });
      if (parts[2] === 'supplier-candidates') {
        const draft = D.rfq[Number(q.get('item_id'))];
        return draft ? json({ site: decodeURIComponent(parts[3] || ''), subject: draft.subject, body: draft.body, sent: false }) : json({ error: 'Нет подходящего кандидата для позиции' }, 404);
      }
      if (parts[2] === 'offers') {
        const o = D.offers[t.id];
        if (parts[3] === 'search') return no(o
          ? 'В демо-версии поиск не запускается — ниже сохранённые результаты настоящего поиска на ' + new Date(o.search?.finished_at || D.snapshotAt).toLocaleDateString('ru-RU') + '. Кнопки «Выбрать» работают: расчёт пересчитается.'
          : 'В демо-версии поиск поставщиков сохранён только для закупки «' + (D.tenders.find((x) => D.offers[x.id])?.title || '') + '» № ' + (D.tenders.find((x) => D.offers[x.id])?.number || '') + '. В рабочей версии поиск идёт по любой закупке за несколько минут.');
        if (parts[3] === 'check-url') return no('В демо-версии проверка ссылки отключена. В рабочей версии сервис откроет страницу товара и по шагам покажет, что с ней стало бы в поиске: берётся ли сайт, открылась ли страница, нашлась ли цена, прошёл ли товар сверку с ТЗ.');
        if (parts[3] === 'stock') return json({ checked: 0, updated: 0, left: 0, groups: o ? o.groups : [] });
        if (method === 'POST') return no('В демо-версии добавить своё предложение нельзя. В рабочей версии достаточно вставить ссылку на товар — сервис откроет страницу и найдёт цену.');
        return o ? json(o) : json({ groups: [], search: null, sources: D.offers[Object.keys(D.offers)[0]]?.sources || { contracts: true } });
      }
      if (parts[2] === 'refresh') return no('В демо-версии данные не обновляются: это снимок на ' + new Date(D.snapshotAt).toLocaleDateString('ru-RU') + '.');
      if (parts[2] === 'economics') {
        const c = D.cards[t.id];
        if (!c || !c.auto) return no('Для этой закупки в демо нет расчёта.');
        const b = JSON.parse(opts.body || '{}');
        const ov = {};
        const sources = { ...c.auto.sources };
        const input = { nmck: t.price, settings: D.profile.economics, sources, days_to_deadline: c.auto.days_to_deadline };
        // заказчик цену не назвал — считаем от цены предложения, которую ввёл пользователь
        if (!t.price && Number(b.price) > 0) { input.nmck = Number(b.price); input.own_price = true; ov.price = Number(b.price); sources.price = 'ваша цена предложения — заказчик свою не назвал'; }
        const bid = t.price > 0 && b.lead !== 'decline' && Number(b.price) > 0 ? Number(b.price) : null;
        if (bid != null && bid > t.price) return json({ error: 'Ваша цена ' + bid.toLocaleString('ru-RU') + ' ₽ выше цены заказчика ' + Number(t.price).toLocaleString('ru-RU') + ' ₽ — заказчик не заплатит больше своей цены. Введите цену не выше неё.' }, 400);
        for (const k of ['decline_pct', 'logistics', 'delivery_days', 'payment_days', 'bid_security_pct', 'contract_security_pct', 'warranty_security_pct', 'advance_pct']) {
          const v = k === 'decline_pct' && bid != null ? '' : b[k]; // цена и процент — одно число: действует цена
          if (v !== '' && v != null && Number.isFinite(Number(v))) { input[k] = Number(v); ov[k] = Number(v); sources[k] = 'ручной ввод'; }
          else input[k] = k === 'logistics' && !String(c.auto.sources?.logistics || '').startsWith('поиск') ? null : c.auto[k];
        }
        const manual = new Map((b.items || []).map((x) => [Number(x.id), x.purchase_price]));
        input.items = c.auto.items.map((i) => {
          const v = manual.get(i.id);
          const item = c.items.find((x) => x.id === i.id);
          if (item) item.purchase_price_manual = v !== '' && v != null ? Number(v) : null;
          return v !== '' && v != null ? { ...i, purchase_price: Number(v), purchase_source: 'ручной ввод' } : i;
        });
        if (bid != null) { input.decline_pct = (1 - bid / t.price) * 100; input.own_bid = true; ov.price = bid; sources.price = 'ваша цена предложения'; sources.decline_pct = 'из вашей цены предложения'; }
        const result = window.__econ.calculate(input);
        c.economics = { overrides: ov, result, verdict: result.verdict, profit: result.result?.profit ?? null, margin_pct: result.result?.margin_pct ?? null, price_variants: window.__econ.priceVariants(input, result) };
        t.econ_verdict = result.verdict; t.econ_profit = c.economics.profit; t.econ_margin = c.economics.margin_pct;
        return json({ tender: t, ...c });
      }
      if (parts[2] === 'analyze') {
        if (t.analysis_id) return json({ analysisId: t.analysis_id }, 202);
        const demo = D.tenders.find((x) => x.analysis_id);
        return no('В демо-версии документы из ЕИС не скачиваются. Готовый разбор реальной закупки есть у «' + (demo ? demo.title : '') + '» — найдите её поиском по номеру ' + (demo ? demo.number : '') + ' или откройте вкладку «Разбор документации».');
      }
      let items = D.tenders.slice();
      const status = q.get('status');
      if (status) items = items.filter((x) => x.status === status);
      else if (q.get('show_hidden') !== '1') items = items.filter((x) => x.status !== 'filtered' && x.status !== 'dismissed' && (!x.deadline_at || new Date(x.deadline_at).getTime() > window.__NOW));
      if (q.get('min_score')) items = items.filter((x) => x.score != null && x.score >= Number(q.get('min_score')));
      if (q.get('law')) items = items.filter((x) => x.law === q.get('law'));
      if (q.get('groups')) { const gs = q.get('groups').split(','); items = items.filter((x) => (x.groups || []).some((g) => gs.includes(g))); }
      if (q.get('direction')) items = items.filter((x) => (q.get('direction') === 'none' ? !x.direction : x.direction === q.get('direction')));
      if (q.get('published')) { const ps = q.get('published').split(','); items = items.filter((x) => ps.includes(x.law === 'com' ? 'com' : 'eis')); }
      if (q.get('platforms')) { const ps = q.get('platforms').split('|'); items = items.filter((x) => ps.includes(x.platform || '?')); }
      if (q.get('profitable') === '1') items = items.filter((x) => x.econ_verdict === 'выгодно');
      // отбор по марже: с посчитанной маржой ниже порога — скрыть, без расчёта — оставить
      const minMargin = Number(q.get('min_margin')) || 0;
      const lowMargin = (x) => minMargin > 0 && x.econ_margin != null && x.econ_margin < minMargin;
      if (q.get('q')) { const s = q.get('q').toLowerCase(); items = items.filter((x) => x.title.toLowerCase().includes(s) || x.number.includes(s)); }
      const sort = q.get('sort') || 'opportunity';
      const tier = (x) => (x.econ_verdict === 'выгодно' && x.econ_confirmed ? 7 : x.econ_verdict === 'на грани' && x.econ_confirmed ? 6 : x.econ_verdict === 'выгодно' ? 5
        : x.econ_verdict === 'нет данных' && x.econ_confirmed && !x.price ? 4 : x.econ_verdict === 'на грани' ? 3 : x.econ_verdict === 'невыгодно' ? 1 : 2);
      const within = (x) => ([7, 6, 1].includes(tier(x)) ? x.econ_profit : tier(x) === 4 ? x.econ_purchase : tier(x) === 2 ? x.score : x.econ_opportunity) ?? -1e15;
      const cmp = {
        score: (a, b) => (a.score == null) - (b.score == null) || (b.score ?? 0) - (a.score ?? 0) || String(a.deadline_at).localeCompare(String(b.deadline_at)),
        deadline: (a, b) => (a.deadline_at == null) - (b.deadline_at == null) || String(a.deadline_at).localeCompare(String(b.deadline_at)),
        published: (a, b) => String(b.published_at).localeCompare(String(a.published_at)),
        profit: (a, b) => (a.econ_profit == null) - (b.econ_profit == null) || (b.econ_profit ?? 0) - (a.econ_profit ?? 0),
        // от самых выгодных к менее интересным — те же ступени, что на сервере (db.js, INTEREST_TIER)
        opportunity: (a, b) => tier(b) - tier(a) || within(b) - within(a) || (a.score == null) - (b.score == null) || (b.score ?? 0) - (a.score ?? 0),
      }[sort] || (() => 0);
      items.sort(cmp);
      const limit = Number(q.get('limit') || 30), offset = Number(q.get('offset') || 0);
      const hiddenByMargin = items.filter(lowMargin).length;
      items = items.filter((x) => !lowMargin(x));
      return json({ total: items.length, items: items.slice(offset, offset + limit), hidden_by_margin: hiddenByMargin });
    }

    const cartPayload = () => {
      const tenders = [];
      let count = 0;
      for (const [tid, o] of Object.entries(D.offers)) {
        const t = D.tenders.find((x) => x.id === Number(tid));
        const items = [];
        for (const g of o.groups) {
          const own = g.ranked.filter((r) => r.in_cart);
          if (!own.length) continue;
          count += own.length;
          const item = (D.cards[tid]?.items || []).find((i) => i.id === g.item_id) || {};
          const priced = own.filter((r) => r.total_cost != null);
          items.push({ item_id: g.item_id, name: item.name, quantity: item.quantity, unit: item.unit, unit_price: item.unit_price ?? null, selected_offer_id: g.selected_offer_id,
            cheapest_id: priced.length > 1 ? priced.reduce((a, b) => (b.total_cost < a.total_cost ? b : a)).id : null, offers: own });
        }
        if (items.length && t) {
          // «Что дальше» в корзине: сколько позиций закрыто и готов ли расчёт — как считает рабочий сервер
          const all = D.cards[tid]?.items || [];
          const isClosed = (i) => { const g = o.groups.find((x) => x.item_id === i.id); return i.purchase_price_manual != null || Boolean(g && (g.allocations || []).length > 0 && !g.missing); };
          const inCart = new Set(items.map((x) => x.item_id));
          const e = D.cards[tid]?.economics || {};
          const progress = { items_total: all.length, items_closed: all.filter(isClosed).length, items_elsewhere: all.filter((i) => !isClosed(i) && !inCart.has(i.id)).length,
            docs: t.analysis_status === 'done', calc: Boolean(e.confirmed), verdict: e.verdict ?? null, profit: e.profit ?? null, margin_pct: e.margin_pct ?? null, bid: null };
          tenders.push({ id: t.id, title: t.title, number: t.number, law: t.law, price: t.price, deadline_at: t.deadline_at, status: t.status, direction: t.direction ?? null, items, progress });
        }
      }
      return { count, tenders };
    };
    if (parts[0] === 'cart') {
      if (parts[1] === 'clear') {
        const b = JSON.parse(opts.body || '{}');
        for (const [tid, o] of Object.entries(D.offers)) if (b.all || Number(tid) === Number(b.tender_id)) for (const g of o.groups) for (const r of g.ranked) r.in_cart = false;
      }
      return json(cartPayload());
    }
    if (parts[0] === 'offers' && parts[2] === 'cart') {
      const id = Number(parts[1]);
      const on = JSON.parse(opts.body || '{}').in === true;
      for (const o of Object.values(D.offers)) {
        const r = o.groups.flatMap((g) => g.ranked).find((x) => x.id === id);
        if (!r) continue;
        r.in_cart = on;
        return json({ in: on, count: cartPayload().count, ...o });
      }
      return json({ error: 'Предложение не найдено' }, 404);
    }
    if (parts[0] === 'offers' && parts[2] === 'product') return no('В демо-версии поиск товара на сайте поставщика не запускается.');

    if (parts[0] === 'offers' && parts[2] === 'select') {
      const id = Number(parts[1]);
      for (const [tid, o] of Object.entries(D.offers)) {
        const g = o.groups.find((x) => x.ranked.some((r) => r.id === id));
        if (!g) continue;
        const offer = g.ranked.find((r) => r.id === id);
        g.selected_offer_id = id; g.selected_by = 'user';
        const c = D.cards[tid];
        const t = D.tenders.find((x) => x.id === Number(tid));
        const ai = c.auto?.items?.find((i) => i.id === g.item_id);
        if (ai) Object.assign(ai, { purchase_price: offer.unit_price, purchase_source: 'поиск поставщиков: ' + (offer.seller_name || offer.domain || '') });
        const item = c.items.find((i) => i.id === g.item_id);
        if (item) item.purchase_price_manual = null;
        // Доставка — сумма по выбранным предложениям, как на сервере.
        const sel = o.groups.map((x) => x.ranked.find((r) => r.id === x.selected_offer_id)).filter(Boolean);
        if (c.auto && sel.length === o.groups.length) { c.auto.logistics = Math.round(sel.reduce((s, r) => s + (r.delivery_cost || 0), 0) * 100) / 100; c.auto.sources = { ...c.auto.sources, logistics: 'поиск поставщиков: доставка выбранных предложений' }; }
        const input = { nmck: t.price, settings: D.profile.economics, sources: { ...c.auto.sources }, days_to_deadline: c.auto.days_to_deadline, items: c.auto.items };
        for (const k of ['decline_pct', 'logistics', 'delivery_days', 'payment_days', 'bid_security_pct', 'contract_security_pct', 'warranty_security_pct', 'advance_pct']) input[k] = c.economics.overrides?.[k] ?? c.auto[k];
        const result = window.__econ.calculate(input);
        c.economics = { ...c.economics, result, verdict: result.verdict, profit: result.result?.profit ?? null, margin_pct: result.result?.margin_pct ?? null };
        t.econ_verdict = result.verdict; t.econ_profit = c.economics.profit; t.econ_margin = c.economics.margin_pct;
        return json(o);
      }
      return json({ error: 'Предложение не найдено' }, 404);
    }
    if (parts[0] === 'supplier-candidates') {
      if (method !== 'PUT') return json({ candidates: [] });
      const b = JSON.parse(opts.body || '{}');
      const site = decodeURIComponent(parts[1] || '');
      let found = null;
      // отметка относится к компании целиком — меняем её во всех закупках снимка (до перезагрузки страницы)
      for (const o of Object.values(D.offers)) for (const g of o.groups) for (const c of (g.candidates || [])) if (c.site === site) { c.status = b.status; found = c; }
      return found ? json({ candidate: found }) : json({ error: 'Поставщик не найден' }, 404);
    }
    if (parts[0] === 'sellers') return no('В демо-версии решения по продавцам не сохраняются. В рабочей версии «Проверен» поднимает продавца во всех поисках, «Не работаем» — скрывает его.');
    if (parts[0] === 'offer-searches') { const o = Object.values(D.offers).find((x) => x.search?.id === Number(parts[1])); return o ? json(o.search) : json({ error: 'Нет в демо-версии' }, 404); }
    if (parts[0] === 'sync') {
      if (method === 'POST') return no('В демо-версии данные не обновляются: это снимок закупок на ' + new Date(D.snapshotAt).toLocaleDateString('ru-RU') + '. В рабочей версии новые закупки загружаются каждый час.');
      return json({ running: false, last: D.lastSync, source: 'демо-снимок' });
    }
    if (parts[0] === 'digest') return no('Telegram-дайджест в демо-версии не подключён.');
    return json({ error: 'Нет в демо-версии' }, 404);
  };
})();
</script>`;

const BANNER = `
<div class="demo-banner" role="note">
  <strong>Демо-версия</strong> · реальные закупки с тестового сервера ГосПлан на ${new Date(snapshotAt).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })} ·
  режим «Перепродажа» · оценки и расчёты — снимок работы сервиса (нейросеть GigaChat) · загрузка файлов и обновление ленты отключены
</div>`;

const DEMO_CSS = `
  .demo-banner { background: #fff3df; color: #6e4700; border-bottom: 1px solid #f0d3a3; padding: 8px 20px; font-size: 13px; line-height: 1.45; }
  .ta-topbar { top: env(safe-area-inset-top, 0px); }
  a[href$="export.md"] { display: none !important; }
  @media (max-width: 760px) { .demo-banner { padding: 8px 16px; } }
`;

// ---------- сборка ----------
let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
// Значок вкладки: демо — один файл без сервера, поэтому картинку встраиваем в страницу.
const iconUri = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'public', 'favicon-32.png')).toString('base64')}`;
html = html.replace('href="favicon-32.png?v=2"', `href="${iconUri}"`)
  .replace(/<link rel="icon" type="image\/png" sizes="192x192"[^>]*>\n?/, '')
  .replace(/<link rel="apple-touch-icon"[^>]*>\n?/, '');
const helpJs = fs.readFileSync(path.join(ROOT, 'public', 'help.js'), 'utf8');
// Дизайн «Медь»: стили встраиваются (демо — один файл), подложки — файлы рядом со страницей (assets/), без base64.
const copperCss = fs.readFileSync(path.join(ROOT, 'public', 'copper.css'), 'utf8');
// Картинки товаров: модуль подбора и каталог — встраиваются; сами картинки — файлы assets/tender-products/ рядом.
const pimgCss = fs.readFileSync(path.join(ROOT, 'public', 'product-images.css'), 'utf8');
const pimgJs = ['product-catalog.js', 'product-images.js'].map((n) => fs.readFileSync(path.join(ROOT, 'public', n), 'utf8')).join('\n');
// Калькулятор выгодности (чистые функции) — тот же код, что на сервере.
const econJs = `window.__econ = (function () { const module = { exports: {} };\n${fs.readFileSync(path.join(ROOT, 'server', 'tenders', 'economics.js'), 'utf8')}\nreturn module.exports; })();`;

// расчёт сделки (шаг «Расчёт»): тот же сервис, что на сервере, — по копии базы; в демо показывается снимком
(async () => {
const deal = require('../server/deal').createDealService({ repo, clock: () => new Date(snapshotAt) });
for (const id of Object.keys(cards)) { try { DATA.deals[id] = await deal.view(Number(id)); } catch { /* без расчёта сделки */ } }

html = html
  .replace(/<!doctype html>\s*/i, '')
  // тема «Медь» задаётся атрибутом <html>; демо-файл без своего <html> — атрибут ставит скрипт
  .replace(/<html[^>]*>\s*/i, () => '<script>document.documentElement.setAttribute(\'data-ui-theme\', \'copper\');</script>\n')
  .replace(/<head>\s*/i, '')
  .replace(/<meta[^>]*>\s*/gi, '')
  .replace(/<title>[^<]*<\/title>/i, '<title>tender-ai</title>')
  .replace(/<\/head>\s*/i, '')
  .replace(/<body>\s*/i, '')
  .replace(/<\/body>\s*<\/html>\s*$/i, '')
  .replace('</style>', `${DEMO_CSS}</style>`)
  .replace('<link rel="stylesheet" href="copper.css">', () => `<style>\n${copperCss}\n</style>`)
  .replace('<link rel="stylesheet" href="product-images.css">', () => `<style>\n${pimgCss}\n</style>`)
  .replace('<script src="product-catalog.js"></script>\n<script src="product-images.js"></script>', () => `<script>\n${pimgJs}\n</script>`)
  .replace('<div class="ta-content">', `<div class="ta-content">${BANNER}`)
  .replace('<script src="help.js"></script>', () =>
    `<script type="application/json" id="demo-data">${JSON.stringify(DATA).replace(/</g, '\\u003c').replace(/_[^"\/_]+\.sig/gi, '_подпись.sig')}</script>${SHIM}\n<script>\n${econJs}\n${helpJs}\n</script>`)
  // сроки подачи — от даты снимка, чтобы «осталось N дн.» не устаревало
  .replace('const days = (d - Date.now()) / 86400000;', 'const days = (d - (window.__NOW || Date.now())) / 86400000;');

// ФИО подписанта в именах файлов подписи заменено в данных (выше). По всей странице не заменять: замена задевает код.
// Встроенные скрипты должны разбираться — иначе демо открывается пустым.
{
  const vm = require('node:vm');
  const re = /<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g;
  let m; let n = 0;
  while ((m = re.exec(html))) { n++; new vm.Script(m[1], { filename: `демо-скрипт-${n}` }); }
}

if (!html.includes('id="demo-data"') || !html.includes('window.__NOW ||') || !html.includes('class="demo-banner"') || html.includes('href="copper.css"') || html.includes('src="product-images.js"') || !html.includes('TenderProductImages')) throw new Error('Не удалось встроить данные — проверьте разметку public/index.html');
fs.writeFileSync(OUT, html);
// Отдельная полная страница для раздачи с обычного сервера (ссылка через туннель, телефон).
const STANDALONE = path.join(__dirname, 'standalone', 'index.html');
fs.mkdirSync(path.dirname(STANDALONE), { recursive: true });
fs.writeFileSync(STANDALONE, `<!doctype html>\n<html lang="ru" data-ui-theme="copper">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${html}\n</html>\n`);
console.log(`Готово: ${OUT} (${(Buffer.byteLength(html) / 1024).toFixed(0)} КБ, закупок: ${tenders.length}, разборов: ${analyses.length}, расчётов сделки: ${Object.keys(DATA.deals).length})`);
})().catch((err) => { console.error(err); process.exit(1); });
