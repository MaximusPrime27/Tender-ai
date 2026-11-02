// Повторное чтение документации без участия человека.
// Два случая, когда готовый результат нельзя оставлять как есть:
//   old_version — разбор сделан прежней версией сервиса: отчёта о полноте чтения в нём нет, таблицы и сканы
//                 читались по-старому, поэтому «прочитано всё» про него сказать нельзя;
//   failed      — разбор упал по временной причине (ЕИС не отдал файлы, у нейросети кончился запас, обрыв связи).
// Раньше оба случая ждали кнопки «Разобрать заново». Теперь сервис перечитывает сам: когда человек открывает
// карточку закупки (сразу, в пределах суточного лимита) и понемногу в фоне после обновления ленты.
// Токены тратятся только на закупки с непрошедшим сроком подачи.

const { isManual } = require('./manual');

// Ошибки, после которых повтор имеет смысл. «Ни один файл не прочитан» или «нет ссылок на файлы» повтором не лечатся.
const TRANSIENT = [
  /^Не удалось скачать документацию/i,
  /ответил (402|408|429|5\d\d)/i,
  /UND_ERR|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timeout|тайм-аут|недоступен/i,
];

/** Почему разбор надо перечитать: 'old_version' | 'failed' | null. */
function rereadReason(analysis) {
  if (!analysis) return null;
  if (analysis.status === 'done') return analysis.card && !analysis.card.decision ? 'old_version' : null;
  if (analysis.status === 'error') return TRANSIENT.some((re) => re.test(analysis.error || '')) ? 'failed' : null;
  return null;
}

function createReread({ repo, analyses, source, manual = null, config = {}, log = console, clock = () => new Date() }) {
  const today = () => new Date(clock().getTime() + 3 * 3600000).toISOString().slice(0, 10);
  const perDay = () => config.REREAD_ON_OPEN_PER_DAY ?? 15;
  const retryMs = () => (config.REREAD_RETRY_HOURS ?? 6) * 3600000;
  const live = (t) => !t.deadline_at || new Date(t.deadline_at).getTime() > clock().getTime();

  /** Нужно ли перечитывать сейчас: причина или null (срок прошёл, разбор свежий, недавно уже пробовали). */
  function due(tender) {
    if (!tender?.analysis_id || !live(tender) || !source?.getAttachments) return null;
    const reason = rereadReason(repo.getAnalysis(tender.analysis_id));
    if (!reason) return null;
    const last = repo.getSetting(`reread:tender:${tender.id}`);
    if (last && clock().getTime() - new Date(last).getTime() < retryMs()) return null;
    return reason;
  }

  function start(tender, reason, by) {
    const prev = repo.getAnalysis(tender.analysis_id);
    // требования ТЗ после нового разбора читаются заново — как по кнопке «Разобрать заново»
    repo.clearSpec(tender.id);
    const id = analyses.startFromTender({ tender, source });
    repo.setTenderAnalysis(tender.id, id);
    if (manual && isManual(tender)) manual.track(tender.id, id);
    repo.setSetting(`reread:tender:${tender.id}`, clock().toISOString());
    // прежний готовый разбор запоминаем: если новый не удастся, закупка не должна остаться без разбора
    repo.setSetting(`reread:analysis:${id}`, JSON.stringify({ tender_id: tender.id, prev: prev?.status === 'done' ? prev.id : null, reason, by }));
    log.log?.(`[reread] закупка ${tender.number}: читаю документацию заново (${reason === 'old_version' ? 'разбор прежней версии' : 'прошлый разбор не удался'}, ${by === 'open' ? 'открыта карточка' : 'в фоне'})`);
    return id;
  }

  // Новый разбор не удался, а прежний был готов — возвращаем прежний: устаревший разбор лучше, чем никакого.
  analyses.onFinished((a) => {
    if (!a?.id) return;
    const raw = repo.getSetting(`reread:analysis:${a.id}`);
    if (!raw) return;
    let mark = null;
    try { mark = JSON.parse(raw); } catch { return; }
    if (a.status !== 'error' || !mark.prev) return;
    const tender = repo.getTender(mark.tender_id);
    if (!tender || tender.analysis_id !== a.id || !repo.getAnalysis(mark.prev)) return;
    repo.setTenderAnalysis(tender.id, mark.prev);
    log.warn?.(`[reread] закупка ${tender.number}: перечитать не удалось (${String(a.error).slice(0, 120)}) — оставлен прежний разбор`);
  });

  return {
    due,
    /**
     * Человек открыл карточку закупки. Разбор устарел или упал — запускаем чтение заново.
     * @returns {{started: true, reason, analysisId}|{skipped: 'limit', reason}|null}
     */
    onOpen(tender) {
      if (perDay() <= 0) return null;
      const reason = due(tender);
      if (!reason) return null;
      if (repo.apiUsage('reread', today()) >= perDay()) return { skipped: 'limit', reason };
      repo.addApiUsage('reread', today());
      return { started: true, reason, analysisId: start(tender, reason, 'open') };
    },
    /**
     * В фоне после обновления ленты: до limit закупок. inWork — только те, с которыми человек уже работает
     * (предложения в корзине): им перечитывание нужнее, чем новым закупкам из ленты.
     * @returns {number} сколько разборов запущено
     */
    background({ limit, inWork = false }) {
      if (!(limit > 0) || perDay() <= 0) return 0; // REREAD_ON_OPEN_PER_DAY=0 выключает перечитывание целиком
      let started = 0;
      for (const t of repo.rereadCandidates({ limit: limit * 6, inWork, nowIso: clock().toISOString() })) {
        const reason = due(t);
        if (!reason) continue;
        start(t, reason, 'background');
        if (++started >= limit) break;
      }
      return started;
    },
  };
}

module.exports = { createReread, rereadReason };
