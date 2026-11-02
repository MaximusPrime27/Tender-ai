// Диагностика поиска поставщиков: что Яндекс находит по запросу и почему страницы не дают цену.
//   node scripts/diag-fetch.js "запрос" ["запрос 2" …]   — 1 платный запрос к Яндексу на каждый запрос
// Для каждой ссылки: открылась ли страница (robots.txt, ответ сайта), есть ли разметка товара и цена.

const config = require('../server/config');
const { loadExtraCaCertificates } = require('../server/certs');
const { createYandexSearch } = require('../server/offers/sources/yandex-search');
const { createPageFetcher } = require('../server/offers/fetch-page');

loadExtraCaCertificates(config.EXTRA_CA_DIR, { log() {} });

(async () => {
  const yandex = createYandexSearch({ apiKey: config.YANDEX_SEARCH_API_KEY, folderId: config.YANDEX_FOLDER_ID, resultsPerQuery: 10 });
  if (!yandex) { console.log('Нет ключа Яндекса'); return; }
  const fetcher = createPageFetcher({ minIntervalMs: 1000 });
  for (const q of process.argv.slice(2)) {
    console.log(`\n=== «${q}»`);
    const results = await yandex.search(q);
    for (const r of results) {
      let line;
      try {
        const page = await fetcher.fetchPage(r.url);
        const prices = page.structured.filter((s) => s.price != null).map((s) => s.price);
        line = `ok  разметка товара: ${page.structured.length}, цены: ${prices.slice(0, 3).join(', ') || '—'}, текст ${page.text.length} симв.`;
      } catch (err) {
        line = `×   ${err.constructor.name}: ${err.message.slice(0, 120)}`;
      }
      console.log(`${r.url.slice(0, 90)}\n    ${line}`);
    }
  }
})();
