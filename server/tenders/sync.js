// Синхронизация: забрать новые закупки → сохранить без дублей → жёсткие фильтры → ИИ-скоринг.

const { filterReason, focusShare, positiveKeywords, closedReason, DAY_MS } = require('./filters');
const { scoreTenders, scoreBasis } = require('./scoring');
const directions = require('./directions');

// Перекрытие окна синхронизации: закупки, опубликованные во время прошлого запуска, не теряются.
const OVERLAP_MS = 30 * 60 * 1000;

class SyncBusyError extends Error {}

// Доля загрузки с площадок в общем ходе обновления; остальное — проверка фильтров и оценка нейросетью.
const FETCH_SHARE = 60;
// Доля проверки по фильтрам в этапе «проверка и оценка»: после загрузки фильтры быстрые, основное время — оценка
// нейросетью; при пересчёте после смены профиля проверяются тысячи закупок, а оценивать часто нечего.
const FILTER_SHARE_AFTER_FETCH = 0.15;
const FILTER_SHARE_RESCORE = 0.6;

function createSyncService({ repo, source, llmFactory, batchSize = 10, firstDays = 3, log = console, clock = () => new Date(), onFinished = () => {} }) {
  let running = null;
  // Ход текущего обновления для строки состояния на сайте: {pct: 0–100, text: что сейчас делается}.
  let progress = null;
  const setProgress = (pct, text) => { progress = { pct: Math.max(progress?.pct || 0, Math.min(99, Math.round(pct))), text }; };

  /** Фильтрует и оценивает закупки, ещё не проверенные под текущую версию профиля. base — с какого процента начинается этот этап. */
  async function review(profile, base = 0) {
    const span = 100 - base;
    const FILTER_SHARE = base > 0 ? FILTER_SHARE_AFTER_FETCH : FILTER_SHARE_RESCORE;
    const now = clock();
    // Направления в профиле изменились — переразмечаем все сохранённые закупки (дёшево: без сети и нейросети).
    directions.ensureTagged(repo, profile, log);
    const pending = repo.tendersNeedingReview(profile.version, now.toISOString());
    const toScore = new Map(); // направление → закупки: нейросеть видит коды и слова только этого направления
    let filtered = 0;
    let restored = 0;
    const views = new Map();
    const viewOf = (dir) => {
      if (!views.has(dir)) {
        const p = directions.profileForDirection(profile, dir);
        views.set(dir, { profile: p, basis: scoreBasis(p) });
      }
      return views.get(dir);
    };
    setProgress(base, `проверка закупок по фильтрам профиля: ${pending.length}`);
    let checked = 0;
    for (const t of pending) {
      if (++checked % 200 === 0) {
        setProgress(base + span * FILTER_SHARE * (checked / pending.length), `проверка закупок по фильтрам профиля: ${checked} из ${pending.length}`);
        // Проверка тысяч закупок — чистый счёт без ожиданий; раз в 200 штук отдаём управление, чтобы сервер
        // в это время отвечал на запросы (иначе после смены профиля сайт «замирал» на десятки секунд).
        await new Promise((resolve) => setImmediate(resolve));
      }
      let reason = filterReason(t, profile, now);
      const items = profile.mode === 'resale' ? repo.getItems(t.id) : [];
      // Позиции уже загружены — направление проверяем и по составу (при пересчёте после смены профиля).
      if (!reason && profile.mode === 'resale') {
        const share = focusShare(items, profile);
        if (share != null && share < 0.5) reason = `не из выбранного направления: товары направления — ${Math.round(share * 100)}% суммы закупки`;
      }
      const dir = directions.tenderDirection(t, profile, items);
      if (directions.hasDirections(profile) && dir !== (t.direction ?? null)) repo.setDirection(t.id, dir);
      const { basis } = viewOf(dir);
      if (reason) {
        repo.setFiltered(t.id, reason, profile.version);
        filtered++;
      } else if (t.score != null && t.score_basis === basis) {
        // Оценка сделана при том же описании профиля (менялись только фильтры) — возвращаем без нейросети.
        repo.restoreScore(t.id, profile.version);
        restored++;
      } else {
        if (!toScore.has(dir)) toScore.set(dir, []);
        toScore.get(dir).push(t);
      }
    }
    let scored = 0;
    let failed = 0;
    const llm = toScore.size ? llmFactory() : null;
    const toScoreTotal = [...toScore.values()].reduce((n, l) => n + l.length, 0);
    let scoredSoFar = 0;
    const scoreProgress = () => setProgress(base + span * (FILTER_SHARE + (1 - FILTER_SHARE) * (scoredSoFar / toScoreTotal)), `оценка закупок нейросетью: ${scoredSoFar} из ${toScoreTotal}`);
    if (toScoreTotal) scoreProgress();
    else setProgress(99, 'проверка по фильтрам закончена, новых закупок для оценки нет');
    for (const [dir, list] of toScore) {
      const { profile: view, basis } = viewOf(dir);
      const r = await scoreTenders({
        tenders: list, profile: view, llm, batchSize, now,
        onResult: (t, res) => {
          if (res.ok) repo.setScore(t.id, res, profile.version, basis);
          else repo.setScoreFailed(t.id, res.error, profile.version);
          scoredSoFar++;
          scoreProgress();
        },
      });
      scored += r.scored;
      failed += r.failed;
    }
    if (restored) log.log?.(`[sync] оценки восстановлены без нейросети: ${restored}`);
    return { filtered, scored: scored + restored, failed };
  }

  async function doRun({ fetch = true, sinceDays = null }) {
    const runId = repo.startSyncRun(fetch ? source.name : 'rescore');
    const stats = { fetched: 0, newCount: 0, filtered: 0, scored: 0 };
    progress = null;
    setProgress(0, fetch ? 'подключение к площадкам' : 'проверка сохранённых закупок');
    try {
      const profile = repo.getProfile();
      let truncated = false;
      let sourceErrors = [];
      if (fetch) {
        const last = repo.lastSuccessfulSyncRun();
        // sinceDays — разовая дозагрузка за прошлые дни (например, после расширения регионов в профиле).
        const since = sinceDays ? new Date(clock().getTime() - sinceDays * DAY_MS) : last
          ? new Date(new Date(last.started_at).getTime() - OVERLAP_MS)
          : new Date(clock().getTime() - firstDays * DAY_MS);
        // Страницы сохраняются сразу — прогресс виден, а сбой позднего запроса не теряет загруженное.
        const res = await source.fetchNew({
          // Перепродажа: товар любой — коды и ключевые слова профиля не сужают загрузку.
          // Перепродажа: коды направления сужают загрузку в ГосПлане (классификатор), а ключевые слова направления —
          // поиск в ленте ЕИС (focus_keywords). По словам в ГосПлане не ищем: слово И код в одном запросе сузили бы слишком.
          // Направления: в ленты уходят первые слова каждого включённого направления по очереди (searchWords).
          profile: profile.mode === 'resale'
            ? { ...profile, keywords: [], focus_keywords: directions.usesDirections(profile) ? directions.searchWords(profile) : positiveKeywords(profile.keywords).slice(0, 5) }
            : profile,
          since,
          // источник сообщает, какой по счёту запрос выполняет: done из total (может быть дробным — страницы внутри запроса)
          onProgress: ({ done = 0, total = 1, label = '' } = {}) => setProgress(FETCH_SHARE * (total ? done / total : 0), `загрузка с площадок${label ? `: ${label}` : ''}`),
          onPage: (tenders) => {
            for (const t of tenders) {
              stats.fetched++;
              if (repo.upsertTender(t).isNew) stats.newCount++;
            }
            repo.updateSyncRun(runId, stats);
          },
          // закупка, которая уже есть у нас, в ЕИС отменена или приём заявок по ней закрыт — убираем её из ленты
          onClosed: (list) => {
            for (const c of list) {
              const id = repo.markClosed(c.law, c.number, c.stage_text);
              if (id) { repo.setFiltered(id, closedReason(c.stage_text), profile.version); stats.filtered++; }
            }
          },
        });
        truncated = res.truncated;
        sourceErrors = res.errors || [];
      }
      const r = await review(profile, fetch ? FETCH_SHARE : 0);
      stats.filtered = r.filtered;
      stats.scored = r.scored;
      const warn = [
        sourceErrors.length ? `часть запросов не выполнена — ${sourceErrors.join('; ')}` : null,
        r.failed ? `не удалось оценить ${r.failed} закупок` : null,
        truncated ? 'достигнут лимит страниц GOSPLAN_MAX_PAGES — часть закупок не загружена' : null,
      ].filter(Boolean).join('; ') || null;
      // partial: окно следующей синхронизации отсчитывается от последней полностью успешной.
      const status = sourceErrors.length ? 'partial' : 'done';
      repo.finishSyncRun(runId, { status, ...stats, error: warn });
      log.log?.(`[sync] ${fetch ? source.name : 'rescore'}: получено ${stats.fetched}, новых ${stats.newCount}, отсеяно ${stats.filtered}, оценено ${stats.scored}${warn ? ` (${warn})` : ''}`);
      return { runId, status, ...stats, warning: warn };
    } catch (err) {
      log.error?.(`[sync] ошибка: ${err.message}`);
      repo.finishSyncRun(runId, { status: 'error', ...stats, error: err.message });
      return { runId, status: 'error', ...stats, error: err.message };
    }
  }

  return {
    /** @param {{fetch?: boolean, sinceDays?: number}} opts fetch=false — только перепроверить сохранённые закупки (после смены профиля); sinceDays — загрузить заново за столько дней */
    run(opts = {}) {
      if (running) throw new SyncBusyError('Синхронизация уже идёт');
      running = doRun(opts).then((r) => {
        running = null;
        onFinished(r, { fetched: opts.fetch !== false });
        return r;
      }, (err) => { running = null; throw err; });
      return running;
    },
    isRunning: () => Boolean(running),
    /** Ход текущего обновления: {pct, text}; null — обновление не идёт. */
    progress: () => (running ? progress : null),
    current: () => running,
  };
}

module.exports = { createSyncService, SyncBusyError };
