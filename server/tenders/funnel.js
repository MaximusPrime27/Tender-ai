// Воронка перепродажи после синхронизации (этапы 5 и 6b):
// фильтры и оценка потенциала уже прошли в sync → ожидаемая маржа для лучших по оценке →
// автоматическое чтение ТЗ у самых перспективных (спецификация, «тот же товар» в контрактах, пересчёт маржи) →
// автопоиск поставщиков для лучших по марже. Всё в фоне, через очереди analyses, details и offers.

const { isSearchable } = require('../offers/spec');
const { SOURCE_PLATFORM } = require('./platforms');
const { closedReason } = require('./filters');

function createFunnel({ repo, details, offers, analyses, source, config, reread = null, log = console, clock = () => new Date() }) {
  let running = null;
  const today = () => new Date(clock().getTime() + 3 * 3600000).toISOString().slice(0, 10);

  /** Скачать и прочитать ТЗ: разбор документации (Max) → спецификация → сверка контрактов (Lite) → пересчёт маржи. */
  async function readDocs() {
    const out = { started: 0, specs: 0 };
    if (!analyses || !source?.getAttachments) return out;
    const left = Math.max(0, (config.RESALE_DOCS_PER_DAY ?? 20) - repo.apiUsage('docs', today()));
    const limit = Math.min(config.RESALE_DOCS_PER_SYNC ?? 10, left);
    if (limit > 0) {
      // Сначала перечитываем устаревшие и упавшие разборы у закупок, с которыми человек уже работает (корзина):
      // они нужнее новых. Остаток лимита — новым закупкам, затем остальным устаревшим и упавшим.
      const again = (n, inWork) => {
        const k = reread ? reread.background({ limit: n, inWork }) : 0;
        for (let i = 0; i < k; i++) repo.addApiUsage('docs', today());
        out.started += k;
      };
      again(limit, true);
      for (const t of repo.docsCandidates({ minMargin: config.RESALE_MIN_MARGIN_PCT, limit: Math.max(0, limit - out.started), nowIso: clock().toISOString() })) {
        repo.setTenderAnalysis(t.id, analyses.startFromTender({ tender: t, source }));
        repo.addApiUsage('docs', today());
        out.started++;
      }
      again(limit - out.started, false);
      if (out.started) {
        log.log?.(`[funnel] читаю документацию: ${out.started} закупок (осталось на сегодня ${left - out.started})`);
        await analyses.idle();
      }
    }
    for (const t of repo.specCandidates({ nowIso: clock().toISOString() })) {
      const r = await details.ensureSpec(t).catch((err) => ({ status: 'error', error: err.message }));
      if (r?.status !== 'done') continue;
      out.specs++;
      await details.computeEconomics(t.id).catch(() => {});
      await details.resolveContractMatches(t).catch(() => {});
      await details.computeEconomics(t.id, { fetch: false }).catch(() => {});
    }
    return out;
  }

  /**
   * Площадки закупок. В списках с ЕИС площадки нет — она в подробностях закупки, поэтому узнаём её в фоне:
   * понемногу за обновление, сначала у лучших по оценке. Источник не ответил — попробуем в следующий раз.
   */
  let fillingPlatforms = null;
  function fillPlatforms(opts = {}) {
    // Одновременно — один проход: второй вызов ждёт идущий.
    if (!fillingPlatforms) fillingPlatforms = fillPlatformsOnce(opts).finally(() => { fillingPlatforms = null; });
    return fillingPlatforms;
  }

  async function fillPlatformsOnce({ limit = config.PLATFORM_FETCH_PER_SYNC ?? 30 } = {}) {
    let known = repo.fillSourcePlatforms(SOURCE_PLATFORM);
    if (limit <= 0 || !details.ensurePlatform) return known;
    let failed = 0;
    for (const t of repo.platformCandidates({ limit, nowIso: clock().toISOString() })) {
      try {
        if (await details.ensurePlatform(t)) known++;
      } catch (err) {
        // Источник недоступен — не перебираем всю очередь впустую.
        if (++failed >= 3) { log.warn?.(`[funnel] площадки: источник не отвечает (${err.message}) — продолжу при следующем обновлении`); break; }
      }
    }
    return known;
  }

  /**
   * Сверить этап закупок из ленты с ЕИС по номеру: срок подачи у них ещё не прошёл, но заказчик мог закупку отменить
   * (или приём заявок закрыли досрочно) — в ленте такие не нужны. Понемногу за проход: ЕИС разрешает один запрос
   * в минуту, очередь общая с загрузкой ленты. Не ответил ЕИС — прекращаем до следующего прохода.
   */
  async function checkStages() {
    const limit = config.STAGE_CHECK_PER_SYNC ?? 10;
    if (!(limit > 0) || !source?.getStage) return { checked: 0, closed: 0 };
    const out = { checked: 0, closed: 0 };
    const profile = repo.getProfile();
    const olderThan = new Date(clock().getTime() - (config.STAGE_CHECK_HOURS ?? 24) * 3600000).toISOString();
    for (const t of repo.stageCheckCandidates({ limit, olderThanIso: olderThan, nowIso: clock().toISOString() })) {
      let stage;
      try { stage = await source.getStage(t); }
      catch (err) { log.warn?.(`[funnel] этап закупки ${t.number}: ${err.message}`); break; }
      repo.setStageChecked(t.id, clock().toISOString());
      out.checked++;
      if (stage && !/^подача заявок$/i.test(String(stage).trim())) {
        repo.markClosed(t.law, t.number, stage);
        repo.setFiltered(t.id, closedReason(stage), profile.version);
        out.closed++;
        log.log?.(`[funnel] закупка ${t.number}: в ЕИС «${stage}» — убрана из ленты`);
      }
    }
    return out;
  }

  /** Закупки, у которых раньше не нашлось извещения (источник ещё не загрузил свежую закупку), — спросить снова. */
  async function retryNotices() {
    const limit = config.NOTICE_RETRY_PER_SYNC ?? 15;
    if (!(limit > 0) || !details.retryNotice) return 0;
    const olderThan = new Date(clock().getTime() - (config.NOTICE_RETRY_MINUTES ?? 60) * 60000).toISOString();
    let found = 0;
    for (const t of repo.noticeRetryCandidates({ limit, olderThanIso: olderThan, nowIso: clock().toISOString() })) {
      if (await details.retryNotice(t, { force: true }).catch(() => false)) found++;
    }
    if (found) log.log?.(`[funnel] извещения: появились в источнике у ${found} закупок`);
    return found;
  }

  async function run() {
    // сначала — убрать отменённые закупки: на них не тратятся ни расчёт, ни чтение документации, ни поиск
    const stages = await checkStages().catch((err) => { log.warn?.(`[funnel] этапы: ${err.message}`); return { checked: 0, closed: 0 }; });
    await retryNotices().catch((err) => log.warn?.(`[funnel] извещения: ${err.message}`));
    const profile = repo.getProfile();
    const resale = profile.mode === 'resale';
    const limit = resale ? config.RESALE_ECONOMICS_PER_SYNC : config.ECONOMICS_MAX_PER_SYNC;
    const computed = limit > 0 ? await details.precompute({ limit }) : 0;
    const docs = resale ? await readDocs() : { started: 0, specs: 0 };
    const started = [];
    // Автопоиск платный: только закупки с хорошей ожидаемой маржой, где известно, что искать (модель или характеристики),
    // и пока не израсходована его доля суточного лимита запросов — остальное остаётся на ручные кнопки.
    const autoBudgetLeft = (config.RESALE_AUTO_SEARCH_DAILY_REQUESTS ?? Infinity) - repo.apiUsage('yandex', today());
    if (resale && config.RESALE_AUTO_SEARCH_PER_SYNC > 0 && autoBudgetLeft > 0) {
      const list = repo.autoSearchCandidates({ minMargin: config.RESALE_AUTO_SEARCH_MIN_MARGIN_PCT ?? config.RESALE_MIN_MARGIN_PCT, limit: config.RESALE_AUTO_SEARCH_PER_SYNC * 6, nowIso: clock().toISOString() })
        // платный автопоиск — только на площадках, где есть регистрация (площадка ещё не известна — можно)
        .filter((t) => { const mine = repo.getProfile().my_platforms || []; return !mine.length || !t.platform || mine.includes(t.platform); })
        .filter((t) => repo.getItems(t.id).some(isSearchable)).slice(0, config.RESALE_AUTO_SEARCH_PER_SYNC);
      for (const t of list) started.push({ tenderId: t.id, searchId: offers.start(t.id, { auto: true }) });
      if (list.length) log.log?.(`[funnel] автопоиск поставщиков: ${list.map((t) => t.number).join(', ')}`);
    }
    const platforms = await fillPlatforms().catch((err) => { log.warn?.(`[funnel] площадки: ${err.message}`); return 0; });
    // Продавцы из предложений — проверка по реестру недобросовестных поставщиков (в фоне, по одному запросу в минуту).
    const rnp = offers.checkRnp ? offers.checkRnp() : 0;
    return { computed, docs, started, platforms, rnp, stages };
  }

  return {
    /** Запускает воронку; повторный вызов во время работы ждёт текущий прогон. */
    run() {
      if (!running) running = run().finally(() => { running = null; });
      return running;
    },
    checkStages,
    retryNotices,
    /** Узнать площадки у закупок из ленты: limit — у скольких за этот проход. */
    fillPlatforms,
    platformsBusy: () => Boolean(fillingPlatforms),
    idle: () => running || Promise.resolve(),
  };
}

module.exports = { createFunnel };
