// Разбор потерь поиска поставщиков: что показывает сервис и что находится «ручным» запросом в Яндекс.
// Работает на КОПИИ базы (app.db и suppliers.db в отдельной папке), рабочие данные не трогает.
//
//   node scripts/search-losses.js --data <папка> --label before --tenders 12,34,56 [--max-requests 60]
//   node scripts/search-losses.js --data <папка> --label after --tenders 12,34,56 --manual-from before
//                                             — после правок: те же адреса ручной выдачи, что в прогоне «before»
//   node scripts/search-losses.js --data <папка> --report before [after]     — таблицы в формате Markdown
//
// По каждой закупке (первая позиция, по которой есть что искать):
//   1) «ручной» запрос — наименование из ТЗ и модель, а если модели нет — главные характеристики: первые 10 адресов;
//   2) обычный поиск сервиса — с воронкой (offers/funnel.js);
//   3) каждый адрес из п. 1: показал ли его сервис, а если нет — на каком шаге он теряется (та же проверка,
//      что и «Проверить ссылку» в карточке закупки; платных запросов не тратит).
// Ответы Яндекса запоминаются в <папка>/yandex-cache.json: повторный прогон с теми же запросами бесплатен.
// --max-requests — потолок настоящих (платных) запросов за все прогоны с этой папкой; сверх него поисковик «молчит».

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
const arg = (name, def = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const DATA = arg('--data');
if (!DATA) { console.error('Укажите --data <папка с копией app.db>'); process.exit(1); }
const dataDir = path.resolve(DATA);

const MATCH = ['соответствует', 'частично', 'не хватает данных', 'не соответствует'];
const file = (label) => path.join(dataDir, `losses-${label}.json`);

// ---------- отчёт ----------
if (args.includes('--report')) {
  const labels = args.slice(args.indexOf('--report') + 1).filter((a) => !a.startsWith('--'));
  const runs = labels.map((l) => JSON.parse(fs.readFileSync(file(l), 'utf8')));
  const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '—');
  const out = [];
  for (const run of runs) {
    const manual = run.tenders.flatMap((t) => t.manual);
    const by = new Map();
    for (const m of manual) by.set(m.status, (by.get(m.status) || 0) + 1);
    out.push(`### Прогон «${run.label}» (${run.at.slice(0, 10)}): ${run.tenders.length} позиций, ручных адресов ${manual.length}, платных запросов ${run.requests.real}`, '');
    out.push('| Что стало с адресом из ручной выдачи | Адресов | Доля |', '|---|---:|---:|');
    for (const [status, n] of [...by].sort((a, b) => b[1] - a[1])) out.push(`| ${status} | ${n} | ${pct(n, manual.length)} |`);
    out.push('', '| Позиция | Запросов | Адресов в ответах | Отсеяно до открытия | Открыто | С ценой | Соответствует | Частично | Не хватает данных | Не соответствует |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const t of run.tenders) {
      const f = t.service.funnel || {};
      const o = Object.fromEntries((f.offers || []).map((x) => [x.match, x.n]));
      out.push(`| ${t.item.slice(0, 60)} (закупка ${t.tender_id}) | ${t.service.api_requests} | ${f.found ?? 0} | ${(f.dropped || []).reduce((s, r) => s + r.n, 0)} | ${f.opened ?? 0} | ${f.with_price ?? 0} | ${MATCH.map((m) => o[m] || 0).join(' | ')} |`);
    }
    const drops = new Map();
    for (const t of run.tenders) for (const group of ['dropped', 'pages']) for (const r of t.service.funnel?.[group] || []) drops.set(r.label, (drops.get(r.label) || 0) + r.n);
    out.push('', '| Причина потери в поиске сервиса | Адресов |', '|---|---:|');
    for (const [label, n] of [...drops].sort((a, b) => b[1] - a[1])) out.push(`| ${label} | ${n} |`);
    out.push('');
  }
  console.log(out.join('\n'));
  process.exit(0);
}

// ---------- прогон ----------
const LABEL = arg('--label', 'run');
const TENDERS = String(arg('--tenders', '')).split(',').map(Number).filter(Boolean);
const MAX_REAL = Number(arg('--max-requests', 60));
const MANUAL_FROM = arg('--manual-from') ? JSON.parse(fs.readFileSync(file(arg('--manual-from')), 'utf8')) : null;
if (!TENDERS.length) { console.error('Укажите --tenders <id через запятую>'); process.exit(1); }

// Копия базы живёт своей жизнью: без расписания, автопоиска, Telegram и обращений к ЕИС.
Object.assign(process.env, {
  DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', SYNC_INTERVAL_MIN: '0', RESALE_AUTO_SEARCH_PER_SYNC: '0', RESALE_AUTO_SEARCH_DAILY_REQUESTS: '0',
  TELEGRAM_BOT_TOKEN: '', RNP_AUTO: '0', SEARCH_DAILY_MAX_API_REQUESTS: '100000',
});
const config = require('../server/config');
const { startServer } = require('../server/server');
const { describeFunnel } = require('../server/offers/funnel');
const { specOf, isSearchable } = require('../server/offers/spec');
const { createYandexSearch, plainQuery } = require('../server/offers/sources/yandex-search');

const cacheFile = path.join(dataDir, 'yandex-cache.json');
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : { real: 0, answers: {} };
const counters = { real: 0, cached: 0, refused: 0 };
/** Запросы к Яндексу — через память: одинаковый запрос второй раз не оплачивается; сверх потолка — отказ. */
async function fetchImpl(url, opts = {}) {
  const u = String(url);
  if (!u.startsWith('https://searchapi.api.cloud.yandex.net')) return fetch(url, opts);
  const key = crypto.createHash('sha1').update(u + String(opts.body || '')).digest('hex');
  if (cache.answers[key]) { counters.cached++; return new Response(cache.answers[key], { status: 200, headers: { 'content-type': 'application/json' } }); }
  if (cache.real >= MAX_REAL) { counters.refused++; return new Response('{"error":"потолок платных запросов разбора исчерпан"}', { status: 429 }); }
  const res = await fetch(url, opts);
  const text = await res.text();
  cache.real++;
  counters.real++;
  if (res.ok) cache.answers[key] = text;
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
}

const site = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const flatUrl = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();

(async () => {
  const quiet = { log() {}, warn() {}, error() {} };
  const s = startServer(config, { scheduler: false, log: quiet, fetchImpl });
  const yandex = createYandexSearch({ apiKey: config.YANDEX_SEARCH_API_KEY, folderId: config.YANDEX_FOLDER_ID, fetchImpl, resultsPerQuery: 10 });
  if (!yandex) { console.error('Нет ключа Яндекса (YANDEX_SEARCH_API_KEY, YANDEX_FOLDER_ID)'); process.exit(1); }
  const run = { label: LABEL, at: new Date().toISOString(), tenders: [], requests: counters };
  try {
    for (const tenderId of TENDERS) {
      const tender = s.repo.getTender(tenderId);
      const item = tender && s.repo.getItems(tenderId).find(isSearchable);
      if (!item) { console.log(`закупка ${tenderId}: нет позиции, по которой можно искать — пропуск`); continue; }
      const spec = specOf(item);
      // Как ищет человек: название и модель; модели нет — название и две-три главные характеристики из ТЗ.
      const manualQuery = plainQuery(item, spec, { title: tender.title });
      console.log(`закупка ${tenderId}: «${manualQuery}»`);

      // Прогон «после правок» сверяется с теми же адресами ручной выдачи, что и прогон «до»: --manual-from <метка>.
      const prev = MANUAL_FROM?.tenders.find((t) => t.tender_id === tenderId);
      let manualUrls = prev ? prev.manual.map((m) => m.url) : [];
      if (!prev) try { manualUrls = (await yandex.search(manualQuery)).slice(0, 10).map((r) => r.url); } catch (err) { console.log(`  ручной запрос не удался: ${err.message}`); }

      const searchId = s.offers.start(tenderId, { auto: true });
      await s.offers.idle();
      const search = s.repo.getOfferSearch(searchId);
      const offers = s.repo.getOffers(tenderId).filter((o) => o.item_id === item.id && o.source !== 'contracts' && o.source !== 'manual');
      const funnel = describeFunnel((search.funnel || []).find((f) => f.item_id === item.id));

      const manual = [];
      for (const url of manualUrls) {
        const same = offers.find((o) => flatUrl(o.url) === flatUrl(url));
        const sameSite = same || offers.find((o) => site(o.url) === site(url));
        let status;
        let detail = '';
        if (sameSite) {
          const fits = sameSite.match === 'соответствует' || sameSite.match === 'частично';
          status = fits ? 'сервис показал этот сайт с подходящим товаром' : `сервис открыл этот сайт, товар отклонён сверкой («${sameSite.match}»)`;
          detail = sameSite.title;
        } else {
          try {
            const r = await s.offers.checkUrl(tenderId, { item_id: item.id, url });
            const failed = r.steps.find((x) => !x.ok);
            if (failed?.key === 'site') status = `сайт в поиск не берётся: ${failed.reason_label}`;
            else if (failed?.key === 'page') status = `страница не открывается программе: ${failed.reason_label}`;
            else if (failed?.key === 'price') status = `на странице нет цены товара: ${failed.reason_label}`;
            else if (failed?.key === 'match') status = 'товар отклонён сверкой («не соответствует»)';
            else if (r.offer && (r.offer.match === 'соответствует' || r.offer.match === 'частично')) status = 'подходящий товар, сервис до него не дошёл (нет в ответах на запросы сервиса или не хватило лимита страниц)';
            else status = `товар без противоречий, но сверка неполная («${r.offer?.match}») — сервис до него не дошёл`;
            detail = r.offer?.title || failed?.text?.slice(0, 120) || '';
            // Сайт исключён, но страница при этом открывается и товар подходит — отдельной пометкой: это цена решения «не открывать розницу».
            if (failed?.key === 'site' && r.offer) detail = `страница открывается, сверка: ${r.offer.match}; ${r.offer.unit_price} ₽ — ${r.offer.title}`;
          } catch (err) {
            status = 'проверка ссылки не удалась';
            detail = err.message.slice(0, 120);
          }
        }
        manual.push({ url, domain: site(url), status, detail: String(detail).slice(0, 200) });
        console.log(`  ${site(url)} — ${status}`);
      }
      const count = Object.fromEntries(MATCH.map((m) => [m, offers.filter((o) => o.match === m).length]));
      run.tenders.push({
        tender_id: tenderId, number: tender.number, item: item.name, manual_query: manualQuery, manual,
        service: { api_requests: search.api_requests, pages: search.pages_fetched, funnel, offers: count, error: search.error || null, with_stock: offers.filter((o) => o.stock_qty != null || o.stock_note).length, total: offers.length },
      });
      fs.writeFileSync(file(LABEL), JSON.stringify(run, null, 1));
      console.log(`  сервис: запросов ${search.api_requests}, страниц ${search.pages_fetched}, предложений ${offers.length} (${MATCH.map((m) => `${m}: ${count[m]}`).join(', ')}); платных запросов всего: ${cache.real} из ${MAX_REAL}`);
    }
  } finally {
    fs.writeFileSync(file(LABEL), JSON.stringify(run, null, 1));
    await s.close();
  }
  console.log(`готово: ${file(LABEL)}; запросов к Яндексу — настоящих ${counters.real}, из памяти ${counters.cached}, отказано ${counters.refused}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
