// Рабочий процесс агентов — отдельная служба (tender-ai-worker): ночной агент базы товаров и агент заявок работают
// здесь, а не в сервисе. Ночной агент часами читает свой каталог страниц поставщиков (9 млн страниц) и Мерлион, агент
// заявок читает документацию и ищет поставщиков: в одном процессе с сайтом это замирало весь сервис (25.10 — с 03:35
// до 06:29 по Москве, и утренний прогон агента заявок не состоялся).
//
// Как устроено:
//   • здесь поднимается тот же сервис (база общая, доступ — WAL), но на случайном порту только для localhost, без
//     расписания синхронизации ленты и без бота-слушателя: сообщения в Telegram рабочий процесс шлёт сам;
//   • раз в минуту: пора ли ночному агенту (AGENT_HOUR) и агенту заявок (start_hour, с догоном до +8 часов), и нет ли
//     заявок от кнопок «Запустить» на сайте (сервис при AGENT_WORKER=1 оставляет их в настройках worker:*).
// Запуск: node server/worker.js (на сервере — systemd-служба deploy/tender-ai-worker.service).

const config0 = require('./config');
const { startServer } = require('./server');
const { createBot } = require('./telegram/bot');

const log = console;
const tg = config0.TELEGRAM_BOT_TOKEN ? createBot({ token: config0.TELEGRAM_BOT_TOKEN, allowedChatIds: config0.TELEGRAM_ALLOWED_CHAT_IDS, log }) : null;
const notify = async (html) => {
  if (!tg?.allowedChatIds.length) return false;
  for (const chatId of tg.allowedChatIds) await tg.sendMessage(chatId, html);
  return true;
};

// бот без токена не запускается — слушает только сервис; порт любой свободный, только для localhost
const config = { ...config0, PORT: 0, HOST: '127.0.0.1', TELEGRAM_BOT_TOKEN: '' };
const app = startServer(config, { scheduler: false, notify, log });
const { repo, agent, bidAgent, scout, bidCounts, manager, fixer, kindAgent, sourcesAgent, outcomesAgent } = app;
// прогон агента заявок, прерванный прошлым перезапуском (выкладка), иначе так и висел бы «идёт»
if (bidAgent) {
  const r = bidAgent.recoverInterrupted();
  if (r.runs || r.items) log.log(`[worker] агент заявок: закрыт прерванный прогон (${r.runs}), закупок вернулось в очередь: ${r.items}`);
}

/** Заявка от кнопки на сайте: значение настройки, которое ещё не обработано. */
function takeRequest(key) {
  const v = repo.getSetting(key);
  if (!v || repo.getSetting(`${key}:done`) === v) return null;
  repo.setSetting(`${key}:done`, v);
  return v;
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (agent) {
      if (takeRequest('worker:agent_run')) { log.log('[worker] ночной агент — запуск с сайта'); await agent.run({ reason: 'manual' }); }
      else if (agent.due()) { log.log('[worker] ночной агент — по расписанию'); await agent.run({ reason: 'night' }); }
    }
    if (bidAgent) {
      const req = takeRequest('worker:bid_run');
      if (req) {
        let p = {};
        try { p = JSON.parse(req); } catch { p = {}; }
        log.log('[worker] агент заявок — запуск с сайта');
        const r = await bidAgent.run({ reason: 'manual', tenderIds: p.tender_ids || null, freshSearch: p.fresh_search === true });
        log.log(`[worker] агент заявок закончил: ${JSON.stringify(r?.stats || {})}`);
      } else if (bidAgent.due()) {
        log.log('[worker] агент заявок — утренний прогон начат');
        const r = await bidAgent.run({ reason: 'morning' });
        log.log(`[worker] утренний прогон закончен: ${JSON.stringify(r?.stats || {})}`);
      }
    }
    // сколько заявок подано по закупкам из корзины и отчёта агента — раз в 15 минут, только устаревшие
    if (bidCounts) await bidCounts.tick();
    // агент поиска поставщиков — когда агентам больше нечего делать: одна попытка по одной закупке за раз
    if (scout) await scout.tick();
    // наладчик: повтор того, что сорвалось по известной причине (ЕИС, нет ссылок, лимит поиска) — раз в 10 минут
    if (fixer) { const r = await fixer.tick(); if (r) log.log(`[worker] наладчик: ${JSON.stringify(r)}`); }
    // знаток товара: после каждого прогона учится и проверяет заявки
    if (kindAgent) { const r = kindAgent.tick(); if (r) log.log(`[worker] знаток товара: ${JSON.stringify(r)}`); }
    // управляющий: дневной отчёт по всем агентам в Telegram (MANAGER_REPORT_HOUR)
    if (manager) await manager.tick();
    // разведчик поставщиков: раз в сутки учится по итогам сверки — хорошие сайты в каталог, слабые ниши агенту поиска
    if (sourcesAgent) { const r = sourcesAgent.tick(); if (r) log.log(`[worker] разведчик поставщиков: ${JSON.stringify(r)}`); }
  } catch (err) {
    log.warn(`[worker] ${err.message}`);
  } finally {
    busy = false;
  }
}

log.log(`[worker] рабочий процесс агентов запущен: ночной агент ${agent ? 'есть' : 'выключен'}, агент заявок ${bidAgent ? 'есть' : 'выключен'}, поиск поставщиков ${scout ? `есть (ниши: ${config.SCOUT_NICHES.join(', ')}, до ${config.SCOUT_DAILY_REQUESTS} запросов в сутки)` : 'выключен'}`);
setInterval(tick, 60 * 1000);
// итоги торгов — своим таймером: в общей очереди они ждали поиска поставщиков, который занимает её надолго
let outcomesBusy = false;
setInterval(async () => {
  if (!outcomesAgent || outcomesBusy) return;
  outcomesBusy = true;
  try { await outcomesAgent.tick(); } catch (err) { log.warn(`[worker] итоги торгов: ${err.message}`); } finally { outcomesBusy = false; }
}, 30 * 1000);
setTimeout(tick, 15 * 1000);

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log.log('[worker] остановка'); app.close().finally(() => process.exit(0)); });
