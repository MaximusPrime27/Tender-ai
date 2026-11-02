// Конвейер анализа: очередь фрагментов → извлечение (map) → проверка цитат → сведение (reduce) → резюме → решение.
// Обрабатывается всё прочитанное содержимое; что не удалось прочитать или разобрать, остаётся в отчёте о полноте
// (card.meta.coverage) и делает решение предварительным (card.decision) — см. coverage.js и decision.js.

const fs = require('node:fs');
const path = require('node:path');
const { RISK_TYPES, fieldsForPrompt } = require('./fields');
const { buildChunkQueue, sha } = require('./chunk');
const { ExtractSchema, ResolveSchema, SummarySchema, callJson, ExtractionFailed } = require('./json');
const { verifySource } = require('./verify');
const merge = require('./merge');
const { legalReview } = require('./legal');
const { runQueue } = require('./queue');
const { analysisCoverage, describe } = require('./coverage');
const { decide, reviewField } = require('./decision');
const { planTargeted } = require('./targeted');
const { FIELD_KEYS } = require('./fields');
const { grade, anchorsFrom, applyAnchors } = require('./learn');
const { readByRules } = require('./rules');

// Поля, где извещение ЕИС главнее документов: официальные сведения закупки (номер, закон, способ, сроки, обеспечение
// заявки, меры нацрежима по позициям). Остальное из извещения — только если в документах не нашлось.
const EIS_FIRST = new Set(['notice_number', 'law', 'procurement_method', 'bid_deadline', 'results_date', 'bid_security', 'national_regime']);

// Промпты читаются при каждом запуске — их можно править без перезапуска сервера.
const loadPrompt = (name) => fs.readFileSync(path.join(__dirname, 'prompts', `${name}.md`), 'utf8');

// Версия схемы ответа задачи «извлечение»: меняется — принятые раньше результаты фрагментов не переиспользуются.
const EXTRACT_SCHEMA_VERSION = 2;
const EXTRACT_KEYS = ['fields', 'risks', 'questions'];

/**
 * @param {Array<{id, name, status, message?, pages, coverage?, sha256?}>} docs извлечённые файлы (и не скачанные — со статусом error)
 * @param llm провайдер из server/llm
 * @param {{maxChars: number, onProgress?: Function, tender?: object, chunkStore?: {get: Function}, maxChunks?: number, confirmedGaps?: Array}} opts
 *   chunkStore.get(key) — принятый раньше результат фрагмента (повторный проход отправляет только несостоявшееся);
 *   maxChunks — сколько фрагментов можно отправить за этот проход (остальные остаются «не отправлено»).
 * @returns {Promise<{card, usage: {in, out}, chunks: Array}>} chunks — записи о фрагментах для сохранения
 */
/** Нейросеть отказала по оплате или лимиту — разбор переходит на правила, а не падает. */
const PAYMENT_ERROR = /402|payment required|оплаченный пакет|закончил[а-яё]* (?:оплаченный )?пакет|quota|лимит[а-яё]* (?:запросов|токенов)/i;

/**
 * @param opts.mode 'rules' — только правила (без нейросети, по умолчанию с 29.10.2026); 'hybrid' — правила, а поля,
 *   которых правила не нашли, нейросеть дочитывает по выдержкам (её сбой разбор не срывает); 'llm' — нейросеть, при
 *   отказе по оплате — правила.
 */
async function analyzeDocs(docs, llm, { maxChars, onProgress = () => {}, tender = null, chunkStore = null, maxChunks = Infinity, confirmedGaps = [], notice = null, mode = 'llm', learned = [] }) {
  if (mode === 'rules' || mode === 'hybrid' || !llm) return analyzeDocsByRules(docs, llm, { maxChars, onProgress, tender, confirmedGaps, notice, learned, hybrid: mode === 'hybrid' && Boolean(llm) });
  try {
    return await analyzeDocsLlm(docs, llm, { maxChars, onProgress, tender, chunkStore, maxChunks, confirmedGaps, notice });
  } catch (err) {
    if (!PAYMENT_ERROR.test(err.message)) throw err;
    const r = await analyzeDocsByRules(docs, null, { maxChars, onProgress, tender, confirmedGaps, notice, learned });
    r.card.meta.warnings.unshift(`Нейросеть недоступна (${err.message.slice(0, 120)}) — документация прочитана правилами`);
    return r;
  }
}

/**
 * Разбор без нейросети: всё прочитанное проходит через правила (analyze/rules.js), официальные поля — из извещения ЕИС,
 * решение — теми же правилами, что и после нейросети. hybrid — поля, которых правила не нашли, нейросеть дочитывает
 * по выдержкам вокруг ключевых слов; её отказ разбор не срывает.
 */
async function analyzeDocsByRules(docs, llm, { maxChars, onProgress = () => {}, tender = null, confirmedGaps = [], notice = null, hybrid = false, learned = [] }) {
  const usage = { in: 0, out: 0 };
  const warnings = [];
  const readable = docs.filter((d) => d.status === 'ok' && d.pages.length);
  const queue = buildChunkQueue(readable, maxChars);
  if (!queue.length) throw new Error('Ни один файл не удалось прочитать — нечего анализировать. Проверьте форматы файлов.');
  onProgress({ stage: 'extract', current: 1, total: 1 });
  // правила читают все страницы целиком: каждый фрагмент — «принят»
  const records = queue.map((c) => ({ id: c.id, status: 'ok', ranges: c.ranges }));
  const byRules = readByRules(readable);
  // обучение (analyze/learn.js): опоры, выученные на прошлых закупках, — для полей, которых правила не нашли;
  // сверка с извещением ЕИС — что прочитано верно, и новые опоры там, где правила ошиблись
  const byAnchors = learned.length ? applyAnchors(readable, learned, new Set(byRules.fields.map((x) => x.key))) : [];
  byRules.fields.push(...byAnchors);
  const grades = notice?.facts ? grade(byRules.fields, notice.facts, readable) : [];
  const anchorCandidates = grades.filter((g) => g.result !== 'agree').flatMap((g) => anchorsFrom(readable, g.key, g.eis).map((anchor) => ({ key: g.key, anchor })));
  const chunkResults = [{
    fields: byRules.fields.map((x) => ({ ...x, source: verifySource(x.source, readable) })),
    risks: byRules.risks.map((r) => ({ ...r, source: r.source ? verifySource(r.source, readable) : null })),
    questions: [],
  }];

  if (hybrid) {
    const found = new Set(byRules.fields.map((f) => f.key));
    const skipEis = new Set(Object.keys(notice?.facts || {}));
    const plan = planTargeted(FIELD_KEYS.filter((k) => !found.has(k) && !skipEis.has(k)), readable);
    for (const [i, call] of plan.entries()) {
      onProgress({ stage: 'targeted', current: i + 1, total: plan.length });
      const system = loadPrompt('extract').replace('{{FIELDS}}', fieldsForPrompt(call.keys)).replace('{{RISK_TYPES}}', RISK_TYPES.join(', '));
      try {
        const { data, usage: u } = await callJson(llm, { system, task: 'targeted', schema: ExtractSchema, requiredKeys: EXTRACT_KEYS,
          user: `Ниже — не весь документ, а выдержки вокруг мест, где упоминаются нужные поля. Найди значения только этих полей: ${call.keys.join(', ')}.\n\n${call.text}` });
        if (u) { usage.in += u.in || 0; usage.out += u.out || 0; }
        chunkResults.push({ fields: (data.fields || []).filter((f) => call.keys.includes(f.key)).map((x) => ({ ...x, source: verifySource(x, readable) })), risks: [], questions: [] });
      } catch (err) {
        warnings.push(`Нейросеть не дочитала поля (${call.keys.join(', ')}): ${String(err.message).slice(0, 120)}`);
        if (PAYMENT_ERROR.test(err.message)) break;
      }
    }
  }

  const pageLengths = new Map(readable.flatMap((d) => d.pages.filter((p) => p.text.trim()).map((p) => [`${d.id ?? null}:${p.page}`, p.text.length])));
  const coverage = analysisCoverage({ files: docs, chunks: records, pageLengths });
  coverage.text = describe(coverage);
  const complete = coverage.status === 'complete';
  onProgress({ stage: 'merge', current: 1, total: 1 });
  const candidates = merge.collectFields(chunkResults);
  const { groups, contradictionRisks } = merge.buildFieldGroups(candidates, new Map(), !complete);
  for (const g of groups) for (const f of g.fields) {
    const v = notice?.facts?.[f.key];
    if (!v) continue;
    // у правил извещение ЕИС главнее для всех своих полей: это официальные сведения, а правила могли взять не ту строку
    if (f.status === 'found' && String(f.value).trim() !== String(v).trim()) f.doc_value = f.value;
    Object.assign(f, { status: 'found', value: v, origin: 'eis', conflict: false });
  }
  for (const g of groups) for (const f of g.fields) f.review = reviewField(f, complete);
  const risks = merge.dedupeRisks([...contradictionRisks, ...chunkResults.flatMap((r) => r.risks.map(({ type, level, explanation, source }) => ({ type, level, explanation, sources: source ? [source] : [] })))]);
  const fields = groups.flatMap((g) => g.fields);
  const foundN = fields.filter((f) => f.status === 'found').length;
  // резюме — по найденному, без пересказа: что за закупка, ключевые условия
  const val = (k) => fields.find((f) => f.key === k && f.status === 'found')?.value;
  const lines = [
    val('subject') || tender?.title, val('nmck') && `НМЦК: ${val('nmck')}`, val('delivery_term') && `поставка: ${val('delivery_term')}`,
    val('payment_terms') && `оплата: ${val('payment_terms')}`, val('contract_security') && `обеспечение контракта: ${val('contract_security')}`,
    val('national_regime') && `нацрежим: ${String(val('national_regime')).slice(0, 120)}`,
  ].filter(Boolean);
  const summary = { status: 'found', text: `Прочитано правилами, без нейросети: найдено ${foundN} из ${fields.length} полей. ${lines.join('; ')}.`, by: 'rules' };
  // кандидат правил — «с оговорками»: решение (decision.js) снимет оговорки, если рисков и пробелов нет
  const decision = decide({ coverage, groups, risks, legal: null, candidate: 'участвовать с оговорками', confirmedGaps });
  summary.recommendation = { value: decision.participation_recommendation, candidate: 'участвовать с оговорками', reasons: [] };
  return {
    card: { groups, risks, questions: [], summary, legal: null, decision,
      meta: { reader: hybrid ? 'rules+llm' : 'rules', chunks: records.length, failedChunks: 0, skippedChunks: 0, warnings, coverage, confirmed_gaps: confirmedGaps, ...(notice ? { eis_notice: notice } : {}),
        reader_check: { grades, candidates: anchorCandidates, used: byAnchors.map((x) => ({ key: x.key, anchor: x.learned })) },
        files: docs.map((d) => ({ id: d.id, name: d.name, status: d.status, message: d.message || null, pages: d.pages.length, sha256: d.sha256 || null, coverage: d.coverage || null })) } },
    usage,
    // фрагменты нейросети правила не отправляли: прежние принятые ответы нейросети не затираем
    chunks: null,
  };
}

async function analyzeDocsLlm(docs, llm, { maxChars, onProgress = () => {}, tender = null, chunkStore = null, maxChunks = Infinity, confirmedGaps = [], notice = null }) {
  const usage = { in: 0, out: 0 };
  const addUsage = (u) => { if (u) { usage.in += u.in || 0; usage.out += u.out || 0; } };
  const warnings = [];

  const readable = docs.filter((d) => d.status === 'ok' && d.pages.length);
  const queue = buildChunkQueue(readable, maxChars);
  if (!queue.length) {
    throw new Error('Ни один файл не удалось прочитать — нечего анализировать. Проверьте форматы файлов.');
  }

  // map: извлечение по фрагментам — все страницы всех файлов, от первой до последней
  const extractSystem = loadPrompt('extract')
    .replace('{{FIELDS}}', fieldsForPrompt())
    .replace('{{RISK_TYPES}}', RISK_TYPES.join(', '));
  const records = await runQueue({
    chunks: queue, docs: readable, task: 'extract', // в версии — и модель: результат другой модели (или учебной) за свой не принимаем
    version: `${EXTRACT_SCHEMA_VERSION}:${sha(extractSystem).slice(0, 16)}:${llm.provider}/${llm.modelFor?.('extract') || llm.model}`,
    cache: (key) => chunkStore?.get(key) || null,
    budget: maxChunks,
    onProgress: (p) => onProgress({ stage: 'extract', ...p }),
    onUsage: addUsage,
    callOne: (text) => callJson(llm, { system: extractSystem, user: text, schema: ExtractSchema, task: 'extract', requiredKeys: EXTRACT_KEYS, emptyNeedsConfirm: EXTRACT_KEYS }),
  });
  const accepted = records.filter((r) => r.status === 'ok');
  const failed = records.filter((r) => r.status === 'failed');
  failed.forEach((r) => warnings.push(`Фрагмент не разобран (${pagesText(r)}): ${r.error}`));
  const skipped = records.filter((r) => r.status === 'skipped').length;
  if (skipped) warnings.push(`Не отправлено нейросети фрагментов: ${skipped} — исчерпан лимит одного прохода; нажмите «Повторить непрочитанные части»`);
  if (!accepted.length) {
    throw new Error(`Модель не вернула корректный ответ ни по одному фрагменту. ${failed[0]?.error || ''}`);
  }
  const withSrc = (x) => ({ ...x, source: verifySource(x, readable) });
  const chunkResults = accepted.map((r) => ({
    fields: (r.result.fields || []).map(withSrc),
    risks: (r.result.risks || []).map(withSrc),
    questions: (r.result.questions || []).map(withSrc),
  }));

  // прицельный дочит: поля, которых нет ни в одном ответе, — ещё раз, по выдержкам вокруг ключевых слов
  const found = new Set(chunkResults.flatMap((r) => r.fields.filter((f) => f.value).map((f) => f.key)));
  const skipEis = new Set(Object.keys(notice?.facts || {}).filter((k) => EIS_FIRST.has(k)));
  const plan = planTargeted(FIELD_KEYS.filter((k) => !found.has(k) && !skipEis.has(k)), readable);
  for (const [i, call] of plan.entries()) {
    onProgress({ stage: 'targeted', current: i + 1, total: plan.length });
    const system = loadPrompt('extract').replace('{{FIELDS}}', fieldsForPrompt(call.keys)).replace('{{RISK_TYPES}}', RISK_TYPES.join(', '));
    try {
      const { data, usage: u } = await callJson(llm, {
        system, task: 'targeted', schema: ExtractSchema, requiredKeys: EXTRACT_KEYS,
        user: `Ниже — не весь документ, а выдержки вокруг мест, где упоминаются нужные поля. Найди значения только этих полей: ${call.keys.join(', ')}.\n\n${call.text}`,
      });
      addUsage(u);
      chunkResults.push({
        fields: (data.fields || []).filter((f) => call.keys.includes(f.key)).map(withSrc),
        risks: (data.risks || []).map(withSrc),
        questions: (data.questions || []).map(withSrc),
      });
    } catch (err) {
      addUsage(err.usage);
      if (!(err instanceof ExtractionFailed)) throw err;
      warnings.push(`Не удалось дочитать поля (${call.keys.join(', ')}): ${err.message}`);
    }
  }

  // полнота: загрузка → извлечение текста → отправка → принятые ответы
  const pageLengths = new Map(readable.flatMap((d) => d.pages.filter((p) => p.text.trim()).map((p) => [`${d.id ?? null}:${p.page}`, p.text.length])));
  const coverage = analysisCoverage({ files: docs, chunks: records, pageLengths });
  coverage.text = describe(coverage);
  const complete = coverage.status === 'complete';

  // reduce: сведение полей и разрешение конфликтов
  onProgress({ stage: 'merge', current: 1, total: 1 });
  const candidates = merge.collectFields(chunkResults);
  const conflicts = merge.conflictsToResolve(candidates);
  const resolutions = new Map();
  if (conflicts.length) {
    try {
      const { data, usage: u } = await callJson(llm, {
        system: loadPrompt('resolve'),
        user: JSON.stringify({ conflicts }, null, 1),
        schema: ResolveSchema,
        task: 'resolve',
        requiredKeys: ['results'],
      });
      addUsage(u);
      for (const r of data.results) resolutions.set(r.key, r);
    } catch (err) {
      addUsage(err.usage);
      if (!(err instanceof ExtractionFailed)) throw err;
      warnings.push(`Не удалось сверить разные значения полей, все расхождения показаны как противоречия: ${err.message}`);
    }
  }
  const { groups, contradictionRisks } = merge.buildFieldGroups(candidates, resolutions, !complete);
  // сведения из извещения ЕИС: официальные поля — из извещения (что сказано в документах, остаётся рядом), прочие —
  // если в документах не нашлось
  for (const g of groups) for (const f of g.fields) {
    const v = notice?.facts?.[f.key];
    if (!v) continue;
    if (f.status === 'found' && !EIS_FIRST.has(f.key)) continue;
    if (f.status === 'found' && String(f.value).trim() !== String(v).trim()) f.doc_value = f.value;
    Object.assign(f, { status: 'found', value: v, origin: 'eis', conflict: false });
  }
  for (const g of groups) for (const f of g.fields) f.review = reviewField(f, complete);

  const risks = merge.dedupeRisks([
    ...contradictionRisks,
    ...chunkResults.flatMap((r) => r.risks.map(({ type, level, explanation, source }) => ({ type, level, explanation, sources: [source] }))),
  ]);
  const questions = merge.dedupeQuestions(
    chunkResults.flatMap((r) => r.questions.map(({ text, reference, source }) => ({ text, reference, sources: [source] })))
  );

  // резюме и кандидат рекомендации: модель видит не только найденное, но и качество разбора — что не прочитано,
  // какие значения не подтверждены и где «не найдено» означает «не дочитали»
  onProgress({ stage: 'summary', current: 1, total: 1 });
  let summary;
  try {
    const brief = {
      fields: Object.fromEntries(groups.flatMap((g) => g.fields.map((f) => [f.label, { value: f.value ?? null, status: f.review }]))),
      risks: risks.map((r) => ({ type: r.type, level: r.level, explanation: r.explanation })),
      reading: {
        complete,
        summary: describe(coverage),
        not_read: coverage.blocking.map((b) => b.text),
        unreadable_files: docs.filter((d) => d.status !== 'ok' && d.coverage?.blocking !== false).map((d) => `${d.name}: ${d.message}`),
        failed_fragments: failed.length,
      },
    };
    const { data, usage: u } = await callJson(llm, {
      system: loadPrompt('summary'), user: JSON.stringify(brief, null, 1), schema: SummarySchema, task: 'summary', requiredKeys: ['summary', 'recommendation'],
    });
    addUsage(u);
    summary = { status: 'found', text: data.summary, recommendation: { value: data.recommendation, reasons: data.reasons } };
  } catch (err) {
    addUsage(err.usage);
    if (!(err instanceof ExtractionFailed)) throw err;
    summary = { status: 'extraction_failed', text: null, recommendation: { value: null, reasons: [] } };
    warnings.push(`Не удалось составить резюме: ${err.message}`);
  }

  // правовой вывод: есть ли спорные условия и что с ними делать (сбой здесь разбор не срывает)
  onProgress({ stage: 'legal', current: 1, total: 1 });
  let legal = null;
  try {
    legal = await legalReview({ card: { groups, risks }, tender, llm, onUsage: addUsage });
  } catch (err) {
    warnings.push(`Проверка соответствия закону не выполнена: ${err.message}`);
  }

  // решение об участии — правилами в коде: нейросеть дала кандидата, окончательность определяет полнота и качество
  const decision = decide({ coverage, groups, risks, legal, candidate: summary.recommendation.value, confirmedGaps });
  summary.recommendation = { ...summary.recommendation, candidate: summary.recommendation.value, value: decision.participation_recommendation };

  return {
    card: {
      groups,
      risks,
      questions,
      summary,
      legal,
      decision,
      meta: {
        chunks: records.length,
        failedChunks: failed.length,
        skippedChunks: skipped,
        warnings,
        coverage,
        confirmed_gaps: confirmedGaps,
        ...(notice ? { eis_notice: notice } : {}),
        files: docs.map((d) => ({ id: d.id, name: d.name, status: d.status, message: d.message || null, pages: d.pages.length, sha256: d.sha256 || null, coverage: d.coverage || null })),
      },
    },
    usage,
    chunks: records,
  };
}

const pagesText = (rec) => {
  const by = new Map();
  for (const r of rec.ranges || []) { if (!by.has(r.file)) by.set(r.file, new Set()); by.get(r.file).add(r.page); }
  return [...by].map(([file, pages]) => `«${file}», стр. ${[...pages].sort((a, b) => a - b).join(', ')}`).join('; ');
};

/** Пересчитать решение по готовой карточке (человек отметил пробел проверенным вручную) — без обращения к нейросети. */
/**
 * Готовая карточка новой версии: убрать противоречия со «значениями» без источника и пересчитать решение правилами.
 * @returns изменённая карточка или null, если менять нечего
 */
function cleanConflicts(card) {
  if (!card?.decision) return null; // разборы прежней версии не трогаем: решения по правилам у них нет
  const r = merge.dropUnsourced(card);
  return r.changed ? redecide(r.card, card.meta?.confirmed_gaps || []) : null;
}

function redecide(card, confirmedGaps) {
  // Все пробелы проверены человеком — «не найдено» снова означает «в документации этого нет», а не «не дочитали».
  const confirmed = new Set(confirmedGaps.map((g) => g.key));
  const allChecked = (card.decision?.gaps || []).every((g) => confirmed.has(g.key));
  const groups = card.groups.map((g) => ({ ...g, fields: g.fields.map((f) => ({ ...f, review: reviewField(f, allChecked) })) }));
  card = { ...card, groups };
  const decision = decide({
    coverage: card.meta?.coverage, groups: card.groups, risks: card.risks, legal: card.legal,
    candidate: card.summary?.recommendation?.candidate ?? card.summary?.recommendation?.value ?? null, confirmedGaps,
  });
  return {
    ...card, decision,
    summary: { ...card.summary, recommendation: { ...card.summary.recommendation, value: decision.participation_recommendation } },
    meta: { ...card.meta, confirmed_gaps: confirmedGaps },
  };
}

module.exports = { analyzeDocs, redecide, cleanConflicts };
