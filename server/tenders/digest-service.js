// Отправка дайджеста и расписание (синхронизация по интервалу, дайджест раз в день в DIGEST_TIME).

const { buildDigestMessages } = require('./digest');

/** Дата и время в часовом поясе: {date: 'YYYY-MM-DD', time: 'HH:MM'}. */
function localParts(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Пора ли слать дайджест: наступило время DIGEST_TIME и сегодня (в поясе tz) ещё не отправляли. */
function isDigestDue({ now, tz, digestTime, lastDigestDate }) {
  const { date, time } = localParts(now, tz);
  return time >= digestTime.padStart(5, '0') && lastDigestDate !== date;
}

function createDigestService({ repo, getBot, tz, clock = () => new Date(), log = console }) {
  return {
    /** Отбирает закупки и шлёт во все разрешённые чаты. Время отправки сохраняется в БД. */
    async send() {
      const bot = getBot();
      if (!bot) throw new Error('Telegram не настроен: заполните TELEGRAM_BOT_TOKEN и TELEGRAM_ALLOWED_CHAT_IDS в .env');
      if (!bot.allowedChatIds.length) throw new Error('Не заданы TELEGRAM_ALLOWED_CHAT_IDS — некому отправлять дайджест');
      const now = clock();
      const profile = repo.getProfile();
      const tenders = repo.digestCandidates({
        since: repo.getSetting('last_digest_at'),
        threshold: profile.score_threshold,
        limit: profile.digest_size,
        nowIso: now.toISOString(),
      });
      const messages = buildDigestMessages(tenders, { tz, now });
      for (const chatId of bot.allowedChatIds) {
        for (const m of messages) {
          await bot.sendMessage(chatId, m.text, m.reply_markup ? { reply_markup: m.reply_markup } : {});
        }
      }
      repo.setSetting('last_digest_at', now.toISOString());
      repo.setSetting('last_digest_date', localParts(now, tz).date);
      log.log?.(`[digest] отправлено закупок: ${tenders.length}, сообщений: ${messages.length * bot.allowedChatIds.length}`);
      return { tenders: tenders.length, messages: messages.length };
    },
  };
}

function startScheduler({ repo, sync, digest, alerts = null, hasBot, syncIntervalMin, digestTime, tz, clock = () => new Date(), log = console, tickMs = 60_000, schedule = {} }) {
  let lastSyncAt = 0;
  let digestInProgress = false;

  async function tick() {
    const now = clock();
    if (syncIntervalMin > 0 && now.getTime() - lastSyncAt >= syncIntervalMin * 60_000 && !sync.isRunning()) {
      lastSyncAt = now.getTime();
      // для строки состояния на сайте: когда сервис сам начнёт следующее обновление
      schedule.nextAt = new Date(lastSyncAt + syncIntervalMin * 60_000).toISOString();
      sync.run().catch((err) => log.error?.(`[scheduler] синхронизация: ${err.message}`));
    }
    // Выгодные закупки — сразу, не дожидаясь дайджеста: проверка раз в минуту, по каждой закупке одно уведомление.
    alerts?.check().catch((err) => log.error?.(`[scheduler] уведомления: ${err.message}`));
    if (hasBot() && !digestInProgress && isDigestDue({ now, tz, digestTime, lastDigestDate: repo.getSetting('last_digest_date') })) {
      digestInProgress = true;
      try {
        // Перед дайджестом дождаться текущей синхронизации, чтобы в него попали свежие закупки.
        await sync.current?.();
        await digest.send();
      } catch (err) {
        log.error?.(`[scheduler] дайджест: ${err.message}`);
        // Не повторять ошибочную отправку каждую минуту — следующая попытка завтра.
        repo.setSetting('last_digest_date', localParts(now, tz).date);
      } finally {
        digestInProgress = false;
      }
    }
  }

  tick();
  const timer = setInterval(tick, tickMs);
  return { stop: () => clearInterval(timer), tick };
}

module.exports = { createDigestService, startScheduler, isDigestDue, localParts };
