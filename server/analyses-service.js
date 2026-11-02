// Очередь и выполнение разборов документации (этап 1). Используется загрузкой файлов и кнопкой
// «Разобрать документацию» у закупки.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { noticeFacts } = require('./tenders/notice-facts');
const { extractFile, readStoredFile } = require('./extract');
const { markRenditions } = require('./extract/renditions');
const { createLlm } = require('./llm');
const { analyzeDocs, redecide } = require('./analyze');
const { unreadableCoverage } = require('./analyze/coverage');
const { legalReview } = require('./analyze/legal');
const { downloadAttachments } = require('./tenders/attachments');
const { storedFiles, isManual } = require('./tenders/manual');

function createAnalysisService({ repo, uploadsDir, maxChars, maxDownloadBytes, llmFactory = createLlm, log = console, fetchImpl, maxChunks = Infinity, extractOpts = {}, reader = 'llm', learner = null }) {
  // Разборы выполняются по одному, чтобы не упираться в лимиты провайдера.
  let queue = Promise.resolve();
  const enqueue = (job) => { queue = queue.then(job, job); return queue; };
  const listeners = new Set();

  function notify(id) {
    const a = repo.getAnalysis(id);
    for (const fn of listeners) {
      try { fn(a); } catch (err) { log.error?.(`[analysis ${id}] обработчик завершения: ${err.message}`); }
    }
  }

  /**
   * @param uploaded [{originalname, path}] файлы на диске
   * @param failedFiles [{name, message}] файлы, которые не удалось получить (попадут в карточку со статусом error)
   */
  async function processAnalysis(id, uploaded, { failedFiles = [], started = Date.now(), tender = null, notice = undefined } = {}) {
    try {
      repo.setProgress(id, { stage: 'extract_text', current: 0, total: uploaded.length });
      const extracted = [];
      for (let i = 0; i < uploaded.length; i++) {
        const f = uploaded[i];
        repo.setProgress(id, { stage: 'extract_text', current: i + 1, total: uploaded.length });
        // note — что делается внутри долгого файла (распознавание скана по страницам, распаковка архива)
        const results = await extractFile({ name: f.originalname, buffer: fs.readFileSync(f.path) }, 0, {
          ...extractOpts,
          onNote: (note) => repo.setProgress(id, { stage: 'extract_text', current: i + 1, total: uploaded.length, note }),
        });
        for (const r of results) extracted.push({ ...r, path: f.path });
      }
      // печатные копии («ТЗ.docx.pdf» рядом с «ТЗ.docx») второй раз не читаем
      for (const r of markRenditions(extracted)) repo.addFile(id, r);
      for (const f of failedFiles) {
        const r = { name: f.name, status: 'error', message: f.message, pages: [], coverage: unreadableCoverage(true, 'download') };
        repo.addFile(id, r);
      }
      await analyzeStored(id, { started, tender, notice });
    } catch (err) {
      log.error?.(`[analysis ${id}] ошибка: ${err.message}`);
      repo.failAnalysis(id, err.message);
    }
    notify(id);
  }

  /**
   * Разбор по тексту файлов, сохранённому в базе. Принятые раньше фрагменты не отправляются заново: результат
   * берётся по ключу «задача + версия промпта + текст фрагмента» — из этого же разбора или из любого прежнего.
   */
  async function analyzeStored(id, { started = Date.now(), tender = null, confirmedGaps = [], notice = undefined } = {}) {
    // факты извещения ЕИС: переданы при первом разборе или сохранены в карточке прежнего
    if (notice === undefined) notice = repo.getAnalysis(id)?.card?.meta?.eis_notice || null;
    // прежний разбор упал и фактов извещения не сохранил — номер, закон, НМЦК, срок подачи и заказчик есть у самой закупки
    if (!notice && tender) {
      notice = noticeFacts(tender, null);
      const c = repo.getDetails?.(tender.id)?.conditions?.customer;
      if (c?.org) notice.facts.customer = `${c.org}${tender.customer_inn ? `, ИНН ${tender.customer_inn}` : ''}`;
      if (c?.delivery_place) notice.facts.delivery_place = c.delivery_place;
    }
    const docs = repo.getFilesFull(id);
    const previous = new Map(repo.listChunks(id, 'extract').filter((c) => c.status === 'ok' && c.result).map((c) => [c.cache_key, { result: c.result, model: c.model }]));
    // читатель: rules — только правила (нейросеть не создаётся), hybrid — правила + дочит нейросетью, llm — нейросеть
    // с переходом на правила при отказе по оплате (ANALYSIS_READER)
    let llm = null;
    if (reader !== 'rules') { try { llm = llmFactory(); } catch (err) { log.warn?.(`[analysis ${id}] нейросеть не настроена: ${err.message} — читаю правилами`); } }
    const { card, usage, chunks } = await analyzeDocs(docs, llm, {
      maxChars, tender, maxChunks, confirmedGaps, notice, mode: llm ? reader : 'rules', learned: learner?.active() || [],
      chunkStore: { get: (key) => previous.get(key) || repo.cachedChunk(key) },
      onProgress: (p) => repo.setProgress(id, p),
    });
    if (chunks) {
      repo.clearChunks(id, 'extract');
      for (const c of chunks) repo.saveChunk(id, 'extract', c);
    }
    const byRules = card.meta?.reader === 'rules';
    repo.finishAnalysis(id, {
      card, provider: byRules ? 'rules' : llm.provider, model: byRules ? 'правила' : card.meta?.reader === 'rules+llm' ? `правила + ${llm.model}` : llm.model,
      durationMs: Date.now() - started,
      tokensIn: usage.in || null, tokensOut: usage.out || null,
    });
    // обучение читателя: сверка с извещением ЕИС, опоры (agents/reader.js)
    try { learner?.record(card.meta?.reader_check, { platform: tender?.platform || '', tenderId: tender?.id ?? null }); } catch (err) { log.warn?.(`[analysis ${id}] обучение читателя: ${err.message}`); }
    log.log?.(`[analysis ${id}] готово за ${((Date.now() - started) / 1000).toFixed(1)} с`);
  }

  /** Дочитать непрочитанные страницы файла (сканы, до которых не дошла очередь или где распознавание упало). */
  async function rereadFile(id, f, onNote) {
    if (!f.path || !fs.existsSync(f.path)) return false;
    const buffer = await readStoredFile(f.path, f.name);
    if (!buffer) return false;
    // уже распознанные страницы не распознаём повторно
    const known = new Map([[f.name, new Map(f.pages.filter((pg) => pg.text && pg.text.trim()).map((pg) => [pg.page, pg.text]))]]);
    const [r] = await extractFile({ name: f.name, buffer }, 0, { ...extractOpts, known, onNote });
    if (!r) return false;
    const before = JSON.stringify(f.pages);
    repo.updateFile(f.id, r);
    return JSON.stringify(r.pages) !== before || r.status !== f.status;
  }

  return {
    newId: () => crypto.randomUUID(),
    /**
     * Правовой вывод по готовому разбору — заново (для разборов, сделанных до появления проверки, и по кнопке).
     * tender — закупка, к которой относится разбор: по ней определяется закон.
     */
    async reviewLegal(id, { tender = null } = {}) {
      const a = repo.getAnalysis(id);
      if (!a) throw Object.assign(new Error('Разбор не найден'), { status: 404 });
      if (!a.card) throw Object.assign(new Error('Разбор ещё не готов'), { status: 409 });
      const legal = await legalReview({ card: a.card, tender, llm: llmFactory() });
      repo.updateAnalysisCard(id, { ...a.card, legal });
      return legal;
    },
    onFinished(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /**
     * «Повторить непрочитанные части»: дочитать страницы, которые не распознались, и заново отправить нейросети
     * только те фрагменты, которые не были приняты (или изменились). Успешные результаты сохраняются.
     * @returns {boolean} false — разбор не найден или ещё идёт
     */
    retryUnread(id, { tender = null } = {}) {
      const a = repo.getAnalysis(id);
      if (!a || ['queued', 'processing'].includes(a.status)) return false;
      const confirmedGaps = a.card?.meta?.confirmed_gaps || [];
      repo.setProgress(id, { stage: 'extract_text', current: 0, total: 0 });
      enqueue(async () => {
        const started = Date.now();
        try {
          const files = repo.getFilesFull(id).filter((f) => (f.coverage?.unread || []).some((u) => ['ocr_budget', 'ocr_failed', 'no_ocr', 'unknown_tail'].includes(u.reason)));
          for (const [i, f] of files.entries()) {
            repo.setProgress(id, { stage: 'extract_text', current: i + 1, total: files.length });
            await rereadFile(id, f, (note) => repo.setProgress(id, { stage: 'extract_text', current: i + 1, total: files.length, note }))
              .catch((err) => log.warn?.(`[analysis ${id}] повторное чтение «${f.name}»: ${err.message}`));
          }
          await analyzeStored(id, { started, tender, confirmedGaps });
        } catch (err) {
          log.error?.(`[analysis ${id}] ошибка: ${err.message}`);
          // прежняя карточка остаётся: неудачный повтор не должен стирать готовый разбор
          if (a.card) repo.finishAnalysis(id, { card: { ...a.card, meta: { ...a.card.meta, warnings: [...(a.card.meta?.warnings || []), `Повторить непрочитанные части не удалось: ${err.message}`] } }, provider: a.provider, model: a.model, durationMs: a.duration_ms, tokensIn: a.tokens_in, tokensOut: a.tokens_out });
          else repo.failAnalysis(id, err.message);
        }
        notify(id);
      });
      return true;
    },

    /**
     * Человек проверил пробел сам (например, открыл страницу, которую сервис не распознал): пробел больше не
     * блокирует решение. Решение пересчитывается правилами, без обращения к нейросети.
     */
    confirmGap(id, key, { confirmed = true, note = '' } = {}) {
      const a = repo.getAnalysis(id);
      if (!a?.card?.decision) throw Object.assign(new Error('У этого разбора нет отчёта о полноте — разберите документацию заново'), { status: 409 });
      if (!a.card.decision.gaps.some((g) => g.key === key)) throw Object.assign(new Error('Такого пробела в разборе нет'), { status: 404 });
      const cur = (a.card.meta.confirmed_gaps || []).filter((g) => g.key !== key);
      const next = confirmed ? [...cur, { key, note: String(note || '').slice(0, 300), at: new Date().toISOString() }] : cur;
      const card = redecide(a.card, next);
      repo.updateAnalysisCard(id, card);
      return card;
    },

    /** Разбор загруженных пользователем файлов (POST /api/analyses). */
    startFromUploads({ id, title, files }) {
      repo.createAnalysis({ id, title });
      enqueue(() => processAnalysis(id, files));
      return id;
    },

    /** Разбор по вложениям закупки: скачать файлы из ЕИС и запустить тот же конвейер. */
    startFromTender({ tender, source }) {
      const id = crypto.randomUUID();
      repo.createAnalysis({ id, title: `${tender.title.slice(0, 110)} (№ ${tender.number})` });
      // Закупка добавлена вручную: документы уже лежат у нас — читаем их, к источникам не обращаемся.
      if (isManual(tender)) {
        enqueue(async () => {
          const files = storedFiles({ repo, uploadsDir, tender });
          if (!files.length) {
            repo.failAnalysis(id, 'У закупки нет загруженных файлов. Откройте карточку закупки и нажмите «Добавить файлы».');
            return notify(id);
          }
          await processAnalysis(id, files, { tender });
        });
        return id;
      }
      enqueue(async () => {
        const started = Date.now();
        try {
          repo.setProgress(id, { stage: 'download', current: 0, total: 0 });
          const attachments = await source.getAttachments(tender);
          if (!attachments.length) {
            throw new Error(`В данных закупки нет ссылок на файлы документации. Скачайте документы на странице закупки в ЕИС и загрузите их в «Разбор документации»: ${tender.eis_url}`);
          }
          const dir = path.join(uploadsDir, id);
          const { downloaded, failed } = await downloadAttachments(attachments, dir, {
            maxBytes: maxDownloadBytes,
            fetchImpl,
            onProgress: (current, total) => repo.setProgress(id, { stage: 'download', current, total }),
          });
          if (!downloaded.length) {
            const reason = (failed[0]?.message || 'неизвестная ошибка').replace(/^Не скачан: /, '');
            throw new Error(`Не удалось скачать документацию из ЕИС (${failed.length} файл.): ${reason}. Откройте закупку в ЕИС, скачайте файлы вручную и загрузите их в «Разбор документации»: ${tender.eis_url}`);
          }
          // извещение ЕИС — официальные сведения закупки для карточки (номер, сроки, обеспечение, нацрежим)
          const doc = source.getDetailsDoc ? await source.getDetailsDoc(tender).catch(() => null) : null;
          await processAnalysis(id, downloaded, { failedFiles: failed, started, tender, notice: noticeFacts(tender, doc) });
        } catch (err) {
          log.error?.(`[analysis ${id}] ошибка: ${err.message}`);
          repo.failAnalysis(id, err.message);
          notify(id);
        }
      });
      return id;
    },

    /** Дождаться окончания очереди (для тестов). */
    idle: () => queue,
  };
}

module.exports = { createAnalysisService };
