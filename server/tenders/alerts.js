// Уведомления о закупках, которыми стоит заняться: как только по всем позициям подтвердилась цена товара (найдена
// у поставщиков или введена вручную), закупка попадает в список на сайте и уходит сообщением в Telegram.
// Три вида (см. alert-kind.js): «выгодно», «на грани» и «товар найден, цена заказчика не указана».
// По каждой закупке — одно уведомление; второе — только если она стала лучше (например, «на грани» → «выгодно»).

const { formatMoney, daysLeftText, DAY_MS, lawLabel } = require('./filters');
const { escapeHtml } = require('./digest');
const { REGIONS } = require('../offers/logistics');
const { alertKind, KIND_RANK } = require('./alert-kind');

const money = (n) => (n == null ? '—' : formatMoney(n));

/** Откуда цена закупки позиции — простыми словами. */
function sourceText(item, offer) {
  if (item.purchase_price_manual != null) return 'цена введена вручную';
  if (!offer) return 'поиск поставщиков';
  const who = [offer.seller_name, offer.domain].filter(Boolean).join(', ');
  return offer.source === 'contracts'
    ? `по такой цене${who ? ` ${who}` : ' конкурент'} продавал этот товар заказчику по госконтракту — это ориентир, а не закупочная цена`
    : `предложение${who ? ` ${who}` : ''}`;
}

/** Контакты поставщика и ссылка на товар одной строкой (HTML для Telegram). */
function contactLine(offer) {
  if (!offer) return '';
  const c = offer.contacts || {};
  const parts = [];
  if (c.phones?.length) parts.push(`☎ ${escapeHtml(c.phones.slice(0, 2).join(', '))}`);
  if (c.emails?.length) parts.push(`✉ ${escapeHtml(c.emails[0])}`);
  if (c.site) parts.push(`<a href="${escapeHtml(c.site)}">${escapeHtml(c.site.replace(/^https?:\/\//, ''))}</a>`);
  if (offer.url) parts.push(`<a href="${escapeHtml(offer.url)}">${offer.source === 'contracts' ? 'контракт в ЕИС' : 'товар у продавца'}</a>`);
  return parts.join(' · ');
}

const KIND_TITLE = {
  profit: '🟢 <b>Выгодная закупка</b>',
  edge: '🟡 <b>Закупка на грани выгоды</b>',
  found: '🔵 <b>Товар найден — цена заказчика не указана</b>',
};

/** Во сколько обойдётся товар по всем позициям (без доставки и налогов) — по найденным или введённым вручную ценам. */
function purchaseTotal(items) {
  let sum = 0;
  for (const i of items) {
    const price = i.purchase_price_manual ?? i.purchase_price_offer;
    if (price == null) return null;
    sum += price * (i.quantity || 1);
  }
  return items.length ? sum : null;
}

/** Текст уведомления для Telegram (parse_mode HTML). */
function formatAlert(t, { econ, items, offers, baseUrl, tz = 'Europe/Moscow', now = new Date(), kind = 'profit' }) {
  const r = econ?.result?.result || {};
  const money3 = kind === 'found'
    ? [`📦 Товар обойдётся ≈ <b>${money(purchaseTotal(items))}</b> (без доставки и налога)`,
      '💬 Заказчик не назвал свою цену — предложите свою: выше этой суммы, с запасом на доставку, налог и вашу прибыль']
    : [`💰 Прибыль ≈ <b>${money(r.profit)}</b> · маржа ${r.margin_pct != null ? `${Math.round(r.margin_pct)}%` : '—'}${kind === 'edge' ? ' — ниже порога из профиля' : ''}`,
      `📦 Цена заказчика ${money(t.price)} · закупка товара ≈ ${money(r.purchase)}`];
  const title = t.title.length > 300 ? `${t.title.slice(0, 300)}…` : t.title;
  const deadline = t.deadline_at ? new Date(t.deadline_at) : null;
  const lines = [
    KIND_TITLE[kind] || KIND_TITLE.profit,
    `<b>${escapeHtml(title)}</b>`,
    ...money3,
    deadline
      ? `⏰ Подача до ${deadline.toLocaleString('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} (осталось ${daysLeftText((deadline - now) / DAY_MS)})`
      : '⏰ Срок подачи не указан',
    `📍 ${lawLabel(t.law)} · ${t.region == null ? 'регион не указан' : REGIONS[t.region] ? `${REGIONS[t.region][0]} (${t.region})` : `регион ${t.region}`}`,
    '',
    kind === 'found' ? '<b>Где купить товар:</b>' : '<b>На чём основан расчёт:</b>',
  ];
  const shown = items.slice(0, 3);
  for (const i of shown) {
    const offer = offers.find((o) => o.id === i.purchase_offer_id) || null;
    const price = i.purchase_price_manual ?? i.purchase_price_offer;
    lines.push(`• ${escapeHtml(String(i.name).slice(0, 70))}: ${money(price)}${i.unit_price ? ` при цене заказчика ${money(i.unit_price)}` : ''} — ${escapeHtml(sourceText(i, offer))}`);
    const contact = contactLine(offer);
    if (contact) lines.push(`   ${contact}`);
  }
  if (items.length > shown.length) lines.push(`• …и ещё позиций: ${items.length - shown.length}`);
  // Цены — со страниц продавцов: это расчёт, а не подтверждённое поставщиком предложение.
  lines.push('', 'Это расчёт по найденным ценам. Перед подачей заявки подтвердите у поставщика цену на всю партию и наличие и проверьте требования ТЗ.');
  const links = [`<a href="${escapeHtml(`${baseUrl}/#tender/${t.id}`)}">Открыть расчёт</a>`];
  if (t.eis_url) links.push(`<a href="${escapeHtml(t.eis_url)}">${t.law === 'com' ? 'Закупка на площадке' : 'Закупка в ЕИС'}</a>`);
  lines.push(links.join(' · '));
  return lines.join('\n');
}

/**
 * @param {(t) => boolean} [telegramOk] уходит ли закупка в Telegram (по умолчанию — все). Сервис передаёт условия задания
 *   агента заявок: маржа и прибыль не ниже заданных. Не прошедшие остаются в ленте на сайте, в Telegram — нет.
 */
function createAlertService({ repo, getBot, config, telegramOk = null, log = console, clock = () => new Date() }) {
  let busy = false;

  /** Состояние канала — для интерфейса: приходят ли сообщения в Telegram. */
  function telegramStatus() {
    const bot = getBot();
    if (!bot) return 'no_token';
    return bot.allowedChatIds.length ? 'on' : 'no_chat';
  }

  async function sendOne(bot, t) {
    const text = formatAlert(t, {
      kind: t.alert_kind || 'profit',
      econ: repo.getEconomics(t.id), items: repo.getItems(t.id), offers: repo.getOffers(t.id),
      baseUrl: config.PUBLIC_BASE_URL, tz: config.DIGEST_TZ, now: clock(),
    });
    const reply_markup = { inline_keyboard: [[{ text: '✕ Не интересно', callback_data: `dm:${t.id}` }]] };
    for (const chatId of bot.allowedChatIds) await bot.sendMessage(chatId, text, { reply_markup });
  }

  return {
    telegramStatus,
    /**
     * Находит закупки, о которых пора сообщить (или которые стали лучше, чем в прошлом уведомлении), отмечает их
     * (список на сайте) и шлёт в Telegram те, о которых ещё не писали.
     * Вызывается по расписанию раз в минуту — запрос к базе дешёвый.
     * @returns {Promise<{fresh: number, sent: number}>}
     */
    async check() {
      if (busy) return { fresh: 0, sent: 0 };
      busy = true;
      try {
        const nowIso = clock().toISOString();
        const fresh = [];
        // только площадки, где есть регистрация (площадка ещё не известна — не скрываем)
        const mine = repo.getProfile().my_platforms || [];
        for (const t of repo.alertTenders('1 = 1', nowIso, 1000).filter((x) => !mine.length || !x.platform || mine.includes(x.platform))) {
          const kind = alertKind(t, nowIso);
          if (t.alerted_at && KIND_RANK[kind] <= KIND_RANK[t.alert_kind || 'profit']) continue; // уже сообщали, лучше не стало
          // уведомление агента заявок (прибыль при снижении, замена товара) подробнее «на грани» — его не перезаписываем
          if (t.alert_kind === 'agent' && kind !== 'profit') continue;
          repo.markAlerted(t.id, nowIso, kind, kind === 'found' ? purchaseTotal(repo.getItems(t.id)) : null);
          fresh.push(`${t.number} (${kind})`);
        }
        if (fresh.length) log.log?.(`[alerts] новые уведомления: ${fresh.join(', ')}`);
        let sent = 0;
        const bot = getBot();
        if (bot?.allowedChatIds.length) {
          // Не больше 5 сообщений за проход: если закупок сразу много, остальные уйдут в следующую минуту.
          for (const t of repo.alertTenders('e.alerted_at IS NOT NULL AND e.alert_tg_at IS NULL', nowIso, 50)) {
            if (sent >= 5) break;
            // не по заданию (маржа или прибыль ниже) — только в ленте; отметка, чтобы не перебирать её каждую минуту
            // (станет лучше — markAlerted снимет отметку, и закупка проверится снова)
            if (telegramOk && !telegramOk(t)) { repo.markAlertSent(t.id, 'не отправлено: не по заданию'); continue; }
            try {
              await sendOne(bot, t);
              repo.markAlertSent(t.id, clock().toISOString());
              sent++;
            } catch (err) {
              log.error?.(`[alerts] ${t.number}: ${err.message}`);
              break; // Telegram недоступен — повторим в следующий проход
            }
          }
        }
        return { fresh: fresh.length, sent };
      } finally {
        busy = false;
      }
    },
    /** Проверочное сообщение — убедиться, что Telegram настроен. */
    async sendTest() {
      const bot = getBot();
      if (!bot) throw new Error('Telegram не настроен: заполните TELEGRAM_BOT_TOKEN в .env');
      if (!bot.allowedChatIds.length) throw new Error('Не задан TELEGRAM_ALLOWED_CHAT_IDS — напишите боту /start, он пришлёт ваш chat id');
      for (const chatId of bot.allowedChatIds) {
        await bot.sendMessage(chatId, '✅ Уведомления tender-ai подключены. Сюда будут приходить закупки, по которым найден товар и прибыль посчитана по найденным ценам.');
      }
      return { chats: bot.allowedChatIds.length };
    },
  };
}

module.exports = { createAlertService, formatAlert, purchaseTotal };
