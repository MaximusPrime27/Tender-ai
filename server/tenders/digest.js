// Дайджест лучших закупок: отбор, форматирование для Telegram (parse_mode HTML), деление на сообщения.

const { formatMoney, daysLeftText, DAY_MS, lawLabel } = require('./filters');

const TG_LIMIT = 4096;

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatDeadline(iso, tz, now = new Date()) {
  if (!iso) return 'не указано';
  const d = new Date(iso);
  const text = d.toLocaleString('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const left = (d - now) / DAY_MS;
  return left > 0 ? `${text} (осталось ${daysLeftText(left)})` : `${text} (истёк)`;
}

/** Текст одной закупки. Длинные поля обрезаются, чтобы один пункт гарантированно помещался в сообщение. */
function formatTender(t, n, { tz = 'Europe/Moscow', now = new Date() } = {}) {
  const title = t.title.length > 400 ? `${t.title.slice(0, 400)}…` : t.title;
  const lines = [
    `<b>${n}. ${escapeHtml(title)}</b>`,
    `💰 ${t.price != null ? formatMoney(t.price) : 'НМЦК не указана'} · ${lawLabel(t.law)} · регион ${t.region ?? '—'}`,
    `⏰ Подача до ${formatDeadline(t.deadline_at, tz, now)}`,
    `⭐ Оценка ${t.score} — ${escapeHtml(t.verdict || '')}`,
  ];
  for (const r of (t.reasons || []).slice(0, 2)) lines.push(`• ${escapeHtml(r.slice(0, 200))}`);
  lines.push(`<a href="${escapeHtml(t.eis_url)}">Открыть в ЕИС</a> · № ${escapeHtml(t.number)}`);
  return lines.join('\n');
}

/**
 * Собирает сообщения дайджеста: пункты группируются в сообщения ≤ 4096 символов,
 * у каждого сообщения — кнопки для его пунктов.
 * @returns {Array<{text: string, reply_markup?: object}>}
 */
function buildDigestMessages(tenders, { tz, now = new Date(), limit = TG_LIMIT } = {}) {
  if (!tenders.length) {
    return [{ text: 'Новых подходящих закупок с прошлого дайджеста нет.' }];
  }
  const header = `<b>Дайджест закупок</b> — ${tenders.length} шт., лучшие сверху`;
  const messages = [];
  let text = header;
  let keyboard = [];

  const flush = () => {
    messages.push({ text, reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined });
    text = '';
    keyboard = [];
  };

  tenders.forEach((t, i) => {
    const item = formatTender(t, i + 1, { tz, now });
    if (text && text.length + 2 + item.length > limit) flush();
    text += (text ? '\n\n' : '') + item;
    keyboard.push([
      { text: `🔍 Разобрать №${i + 1}`, callback_data: `an:${t.id}` },
      { text: `✕ Не интересно №${i + 1}`, callback_data: `dm:${t.id}` },
    ]);
  });
  flush();
  return messages;
}

/** Делит произвольный текст на части ≤ limit по границам строк. */
function splitText(text, limit = TG_LIMIT) {
  const parts = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    const pieces = line.length > limit ? line.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'g')) : [line];
    for (const piece of pieces) {
      if (cur && cur.length + 1 + piece.length > limit) {
        parts.push(cur);
        cur = '';
      }
      cur += (cur ? '\n' : '') + piece;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Сообщение о готовом разборе документации. */
function formatAnalysisResult(analysis, baseUrl) {
  const link = `${baseUrl}/#${analysis.id}`;
  if (analysis.status !== 'done') {
    return `❌ <b>Разбор не выполнен</b>\n${escapeHtml(analysis.title)}\n\n${escapeHtml(analysis.error || 'неизвестная ошибка')}`;
  }
  const c = analysis.card;
  const rec = c.summary?.recommendation?.value;
  const lines = [
    `📄 <b>Разбор готов</b>: ${escapeHtml(analysis.title)}`,
    rec ? `Рекомендация: <b>${escapeHtml(rec)}</b>` : 'Рекомендацию составить не удалось',
  ];
  const risks = c.risks.slice(0, 3);
  if (risks.length) {
    lines.push('', 'Главные риски:');
    for (const r of risks) lines.push(`• [${r.level}] ${escapeHtml(r.explanation.slice(0, 300))}`);
  }
  lines.push('', `<a href="${escapeHtml(link)}">Открыть карточку</a>`);
  return lines.join('\n');
}

module.exports = { buildDigestMessages, formatTender, splitText, formatAnalysisResult, escapeHtml, TG_LIMIT };
