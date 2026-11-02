// Запуск сервиса на копии базы — посмотреть изменения до выкладки, не трогая рабочие данные и не тратя платные запросы.
// node scripts/preview-on-copy.js <папка с app.db> [порт] [автообновление, мин — по умолчанию выключено] [провайдер нейросети]
// Платный поиск поставщиков (Яндекс), Telegram выключен, синхронизация по расписанию — только если задан интервал; остальные ключи — из .env.
const path = require('node:path');
const dir = process.argv[2];
if (!dir) { console.error('Укажите папку с копией app.db'); process.exit(1); }
Object.assign(process.env, {
  DATA_DIR: path.resolve(dir), PORT: process.argv[3] || '8851', SYNC_INTERVAL_MIN: process.argv[4] || '0', RESALE_AUTO_SEARCH_PER_SYNC: '0',
  RESALE_AUTO_SEARCH_DAILY_REQUESTS: '0', TELEGRAM_BOT_TOKEN: '', TENDER_SOURCES: 'gosplan,eis-rss,roseltorg',
  // кнопки «Найти поставщиков» и «Найти по модели» на копии платный поиск не запускают (ключ читается под обоими именами)
  YANDEX_SEARCH_API_KEY: '', YANDEX_API_KEY: '',
  // пятый аргумент — провайдер нейросети (например, mock: учебная модель без ключей и расходов)
  ...(process.argv[5] ? { LLM_PROVIDER: process.argv[5] } : {}),
});
require('../server/server').startServer();
