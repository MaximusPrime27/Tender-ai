// Проверка подключений: нейросеть, Яндекс Search API, DaData. Запуск: npm run check
// Каждый сервис получает один маленький запрос; ключи в вывод не попадают.

const config = require('../server/config');
const { loadExtraCaCertificates } = require('../server/certs');
const { createLlm } = require('../server/llm');
const { createYandexSearch } = require('../server/offers/sources/yandex-search');
const { lookupEgrul } = require('../server/offers/seller-check');

loadExtraCaCertificates(config.EXTRA_CA_DIR);

const ok = (name, text) => console.log(`✅ ${name}: ${text}`);
const off = (name, text) => console.log(`⚪ ${name}: ${text}`);
const bad = (name, err) => console.log(`❌ ${name}: ${err.message || err}`);

async function checkLlm() {
  const name = `Нейросеть (${config.LLM_PROVIDER})`;
  if (config.LLM_PROVIDER === 'mock') return off(name, 'не подключена — работает упрощённый режим без нейросети. Укажите LLM_PROVIDER в .env');
  try {
    const llm = createLlm();
    const r = await llm.complete({ system: 'Отвечай кратко.', messages: [{ role: 'user', content: 'Сколько будет 2+2? Ответь одним числом.' }], task: 'check' });
    ok(name, `отвечает («${String(r.text).trim().slice(0, 40)}»)`);
  } catch (err) { bad(name, err); }
}

async function checkYandex() {
  const name = 'Яндекс Search API';
  const s = createYandexSearch({ apiKey: config.YANDEX_SEARCH_API_KEY, folderId: config.YANDEX_FOLDER_ID, resultsPerQuery: 5 });
  if (!s) return off(name, 'не подключён — заполните YANDEX_API_KEY (или YANDEX_SEARCH_API_KEY) и YANDEX_FOLDER_ID');
  try {
    const res = await s.search('картридж Kyocera TK-5240K купить');
    ok(name, `работает, найдено ссылок: ${res.length}${res[0] ? ` (первая: ${res[0].domain})` : ''}`);
  } catch (err) { bad(name, err); }
}

async function checkDadata() {
  const name = 'DaData (ЕГРЮЛ)';
  if (!config.DADATA_API_KEY) return off(name, 'не подключена — заполните DADATA_API_KEY');
  try {
    const r = await lookupEgrul('7707083893', { apiKey: config.DADATA_API_KEY });
    ok(name, `работает (проверочный ИНН → ${r?.name || 'не найдено'})`);
  } catch (err) { bad(name, err); }
}

(async () => {
  await checkLlm();
  await checkYandex();
  await checkDadata();
})();
