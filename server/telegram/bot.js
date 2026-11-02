// Минимальный клиент Telegram Bot API без зависимостей: long polling getUpdates, отправка сообщений.

const { splitText, TG_LIMIT } = require('../tenders/digest');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createBot({ token, allowedChatIds = [], fetchImpl = fetch, log = console, onCommand, onCallback, getOffset, setOffset }) {
  const api = `https://api.telegram.org/bot${token}`;
  const allowed = new Set(allowedChatIds.map(String));
  let stopped = false;

  async function call(method, body, timeoutMs = 30_000) {
    let res;
    try {
      res = await fetchImpl(`${api}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Токен входит в URL — в тексте ошибки его не показываем.
      throw new Error(`Telegram ${method}: нет связи (${err.cause?.code || err.name})`);
    }
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
    return data.result;
  }

  async function sendMessage(chatId, text, extra = {}) {
    const parts = text.length > TG_LIMIT ? splitText(text, TG_LIMIT) : [text];
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      await call('sendMessage', {
        chat_id: chatId,
        text: parts[i],
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(last ? extra : {}),
      });
    }
  }

  async function handleUpdate(u) {
    if (u.message?.text) {
      const chatId = String(u.message.chat.id);
      const [cmd] = u.message.text.trim().split(/\s+/);
      const command = cmd.replace(/@.*$/, '').toLowerCase();
      if (command === '/start' && !allowed.has(chatId)) {
        await sendMessage(chatId, `Ваш chat id: <code>${chatId}</code>\nДобавьте его в TELEGRAM_ALLOWED_CHAT_IDS в файле .env и перезапустите сервер.`);
        return;
      }
      if (!allowed.has(chatId)) return;
      await onCommand?.(command, chatId);
      return;
    }
    if (u.callback_query) {
      const q = u.callback_query;
      const chatId = String(q.message?.chat?.id ?? q.from?.id);
      if (!allowed.has(chatId)) {
        await call('answerCallbackQuery', { callback_query_id: q.id, text: 'Нет доступа' }).catch(() => {});
        return;
      }
      const answer = await onCallback?.(q.data || '', chatId);
      await call('answerCallbackQuery', { callback_query_id: q.id, text: answer || '' }).catch(() => {});
    }
  }

  async function pollOnce() {
    const offset = Number(getOffset?.() || 0);
    const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40_000);
    for (const u of updates) {
      setOffset?.(u.update_id + 1);
      try {
        await handleUpdate(u);
      } catch (err) {
        log.error?.(`[telegram] обработка обновления: ${err.message}`);
      }
    }
    return updates.length;
  }

  async function loop() {
    let backoff = 1000;
    while (!stopped) {
      try {
        await pollOnce();
        backoff = 1000;
      } catch (err) {
        if (stopped) break;
        log.error?.(`[telegram] ${err.message}; повтор через ${backoff / 1000} с`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  return {
    start() {
      stopped = false;
      call('getMe').then((me) => log.log?.(`[telegram] бот @${me.username} запущен`)).catch((err) => log.error?.(`[telegram] ${err.message}`));
      loop();
    },
    stop() { stopped = true; },
    sendMessage,
    pollOnce,
    handleUpdate,
    allowedChatIds: [...allowed],
  };
}

module.exports = { createBot };
