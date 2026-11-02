// Команды и кнопки бота: /start, /digest, /sync, /help; «Разобрать документацию», «Не интересно».

const { createBot } = require('./bot');
const { formatAnalysisResult, escapeHtml } = require('../tenders/digest');
const { SyncBusyError } = require('../tenders/sync');

const HELP = [
  '<b>Команды</b>',
  '/digest — прислать дайджест сейчас',
  '/sync — загрузить новые закупки сейчас',
  '/help — эта справка',
  '',
  'Под каждой закупкой в дайджесте: «Разобрать» запускает разбор документации, «Не интересно» скрывает закупку.',
].join('\n');

function setupTelegram({ config, repo, sync, digest, analyses, source, log = console, fetchImpl }) {
  if (!config.TELEGRAM_BOT_TOKEN) {
    log.log?.('[telegram] TELEGRAM_BOT_TOKEN не задан — бот не запущен');
    return null;
  }
  // Кто запросил разбор — туда и отправим результат. Хранится в памяти: после перезапуска не присылается.
  const waiting = new Map(); // analysisId → Set(chatId)

  const bot = createBot({
    token: config.TELEGRAM_BOT_TOKEN,
    allowedChatIds: config.TELEGRAM_ALLOWED_CHAT_IDS,
    fetchImpl,
    log,
    getOffset: () => repo.getSetting('telegram_offset'),
    setOffset: (v) => repo.setSetting('telegram_offset', v),

    async onCommand(command, chatId) {
      switch (command) {
        case '/start':
        case '/help':
          return bot.sendMessage(chatId, HELP);
        case '/digest':
          try {
            await digest.send();
          } catch (err) {
            await bot.sendMessage(chatId, `Не удалось отправить дайджест: ${escapeHtml(err.message)}`);
          }
          return;
        case '/sync': {
          let run;
          try {
            run = sync.run();
          } catch (err) {
            if (err instanceof SyncBusyError) return bot.sendMessage(chatId, 'Синхронизация уже идёт, подождите.');
            throw err;
          }
          await bot.sendMessage(chatId, 'Загружаю новые закупки…');
          const r = await run;
          return bot.sendMessage(chatId, r.status === 'done'
            ? `Готово: получено ${r.fetched}, новых ${r.newCount}, отсеяно ${r.filtered}, оценено ${r.scored}.${r.warning ? `\n⚠ ${escapeHtml(r.warning)}` : ''}`
            : `Ошибка синхронизации: ${escapeHtml(r.error)}`);
        }
        default:
          return bot.sendMessage(chatId, HELP);
      }
    },

    async onCallback(data, chatId) {
      const [action, rawId] = data.split(':');
      const tender = repo.getTender(Number(rawId));
      if (!tender) return 'Закупка не найдена';
      if (action === 'dm') {
        repo.dismissTender(tender.id);
        return 'Скрыто';
      }
      if (action === 'an') {
        const analysisId = analyses.startFromTender({ tender, source });
        repo.setTenderAnalysis(tender.id, analysisId);
        if (!waiting.has(analysisId)) waiting.set(analysisId, new Set());
        waiting.get(analysisId).add(chatId);
        await bot.sendMessage(chatId, `🔍 Запустил разбор документации: ${escapeHtml(tender.title.slice(0, 200))}\nПришлю результат, когда будет готово.`);
        return 'Запустил разбор';
      }
      return '';
    },
  });

  analyses.onFinished((a) => {
    const chats = a && waiting.get(a.id);
    if (!chats) return;
    waiting.delete(a.id);
    const text = formatAnalysisResult(a, config.PUBLIC_BASE_URL);
    for (const chatId of chats) {
      bot.sendMessage(chatId, text).catch((err) => log.error?.(`[telegram] результат разбора: ${err.message}`));
    }
  });

  return bot;
}

module.exports = { setupTelegram };
