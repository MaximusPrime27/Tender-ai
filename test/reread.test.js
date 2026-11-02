// Перечитывание документации без кнопки: разбор прежней версии или упавший по временной причине
// запускается заново, когда человек открывает карточку закупки, и понемногу в фоне после обновления ленты.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createLlm } = require('../server/llm');
const { createFixtureSource } = require('../server/sources/fixture');
const { rereadReason } = require('../server/tenders/reread');
const { analysisCoverage } = require('../server/analyze/coverage');
const { runQueue } = require('../server/analyze/queue');
const { buildChunkQueue } = require('../server/analyze/chunk');
const { ExtractionFailed } = require('../server/analyze/json');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const NOW = '2026-09-17T09:00:00Z';

function start(extra = {}) {
  let now = new Date(NOW);
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-reread-')), PORT: 0, LLM_PROVIDER: 'mock', TENDER_SOURCE: 'fixture',
    TELEGRAM_BOT_TOKEN: '', SUPPLIER_INDEX: false, OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, RESALE_DOCS_PER_SYNC: 0, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
    REREAD_ON_OPEN_PER_DAY: 15, REREAD_RETRY_HOURS: 6, ...extra,
  };
  // сеть в тестах выключена: скачать вложения не удаётся — новый разбор заканчивается ошибкой «не удалось скачать»
  const source = createFixtureSource({ dir: FIX });
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => now, sourceOverride: source, llmFactory: () => createLlm('mock'), fetchImpl: async () => { throw new Error('сеть в тестах выключена'); } });
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, opts);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { s, api, source, tick: (hours) => { now = new Date(now.getTime() + hours * 3600000); } };
}

/** Закупка из ленты с готовым разбором: card — карточка разбора (без decision — «прежняя версия»). */
function withAnalysis(s, tenderId, { card = { groups: [] }, error = null, aId = `a-${tenderId}-${Math.random().toString(36).slice(2, 8)}` } = {}) {
  s.repo.createAnalysis({ id: aId, title: 'тест' });
  if (error) s.repo.failAnalysis(aId, error);
  else s.repo.finishAnalysis(aId, { card, provider: 'mock', model: 'old', durationMs: 0 });
  s.repo.setTenderAnalysis(tenderId, aId);
  return aId;
}
const liveTender = (s) => s.repo.db.prepare("SELECT id FROM tenders WHERE status = 'scored' AND (deadline_at IS NULL OR deadline_at > ?) ORDER BY id LIMIT 1").get(NOW).id;

test('причина перечитывания: прежняя версия, временный сбой; постоянная ошибка и свежий разбор — нет', () => {
  assert.equal(rereadReason({ status: 'done', card: { groups: [] } }), 'old_version');
  assert.equal(rereadReason({ status: 'done', card: { groups: [], decision: { analysis_status: 'complete' } } }), null);
  assert.equal(rereadReason({ status: 'error', error: 'Не удалось скачать документацию из ЕИС (5 файл.): ЕИС ответил 503.' }), 'failed');
  assert.equal(rereadReason({ status: 'error', error: 'gigachat.devices.sberbank.ru ответил 402: {"status":402,"message":"Payment Required"}' }), 'failed');
  assert.equal(rereadReason({ status: 'error', error: 'ГосПлан недоступен (v2test.gosplan.info): UND_ERR_CONNECT_TIMEOUT' }), 'failed');
  assert.equal(rereadReason({ status: 'error', error: 'Ни один файл не удалось прочитать — нечего анализировать.' }), null, 'повтор не поможет');
  assert.equal(rereadReason({ status: 'error', error: 'В данных закупки нет ссылок на файлы документации.' }), null);
  assert.equal(rereadReason({ status: 'processing' }), null);
  assert.equal(rereadReason(null), null);
});

test('открыли карточку с разбором прежней версии — документы читаются заново; не удалось — остаётся прежний разбор', async () => {
  const { s, api, tick } = start();
  try {
    await s.sync.run();
    await s.funnel.idle?.();
    const id = liveTender(s);
    const old = withAnalysis(s, id);
    let r = await api(`/api/tenders/${id}`);
    assert.equal(r.body.reread.started, true);
    assert.equal(r.body.reread.reason, 'old_version');
    assert.notEqual(r.body.tender.analysis_id, old, 'карточка уже показывает новый разбор');
    assert.ok(['queued', 'processing', 'error'].includes(r.body.tender.analysis_status));
    await s.analyses.idle();
    // скачать документы не удалось — новый разбор упал; прежний готовый разбор возвращён
    assert.equal(s.repo.getTender(id).analysis_id, old, 'закупка не осталась без разбора');
    // повторно сразу не запускаем: один заход в REREAD_RETRY_HOURS
    r = await api(`/api/tenders/${id}`);
    assert.equal(r.body.reread, undefined);
    assert.equal(s.repo.getTender(id).analysis_id, old);
    tick(7);
    r = await api(`/api/tenders/${id}`);
    assert.equal(r.body.reread?.started, true, 'через 7 часов — новая попытка');
    await s.analyses.idle();
  } finally { await s.close(); }
});

test('суточный лимит, прошедший срок подачи и выключатель: сам сервис не перечитывает', async () => {
  const { s, api } = start({ REREAD_ON_OPEN_PER_DAY: 1 });
  try {
    await s.sync.run();
    const ids = s.repo.db.prepare("SELECT id FROM tenders WHERE status = 'scored' AND (deadline_at IS NULL OR deadline_at > ?) ORDER BY id LIMIT 2").all(NOW).map((x) => x.id);
    assert.equal(ids.length, 2, 'в фикстурах есть две живые закупки');
    for (const id of ids) withAnalysis(s, id);
    assert.equal((await api(`/api/tenders/${ids[0]}`)).body.reread.started, true);
    const second = (await api(`/api/tenders/${ids[1]}`)).body;
    assert.deepEqual(second.reread, { skipped: 'limit', reason: 'old_version' }, 'лимит на сутки исчерпан — остаётся кнопка');
    assert.equal(second.tender.analysis_status, 'done');
    await s.analyses.idle();
    // срок подачи прошёл — токены не тратим
    const past = s.repo.db.prepare('SELECT id FROM tenders WHERE id NOT IN (?, ?) ORDER BY id LIMIT 1').get(ids[0], ids[1]).id;
    s.repo.db.prepare('UPDATE tenders SET deadline_at = ? WHERE id = ?').run('2026-09-01T00:00:00Z', past);
    withAnalysis(s, past);
    assert.equal((await api(`/api/tenders/${past}`)).body.reread, undefined);
  } finally { await s.close(); }
  const off = start({ REREAD_ON_OPEN_PER_DAY: 0 });
  try {
    await off.s.sync.run();
    const id = liveTender(off.s);
    const old = withAnalysis(off.s, id);
    assert.equal((await off.api(`/api/tenders/${id}`)).body.reread, undefined);
    assert.equal(off.s.repo.getTender(id).analysis_id, old);
  } finally { await off.s.close(); }
});

test('упавший по временной причине разбор повторяется при открытии; очередь фона: сначала закупки с корзиной', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    const ids = s.repo.db.prepare("SELECT id FROM tenders WHERE status = 'scored' AND (deadline_at IS NULL OR deadline_at > ?) ORDER BY id LIMIT 2").all(NOW).map((x) => x.id);
    withAnalysis(s, ids[0], { error: 'Не удалось скачать документацию из ЕИС (4 файл.): ЕИС ответил 503.' });
    withAnalysis(s, ids[1]);
    // предложение второй закупки отложено в корзину — она в очереди первая, хотя упавшие обычно идут раньше
    const item = s.repo.getItems(ids[1])[0] || (await s.details.ensureItems(s.repo.getTender(ids[1])))[0];
    const offer = s.repo.insertOffer({ tender_id: ids[1], item_id: item.id, source: 'manual', title: 'Товар', price: 100, unit_price: 100, pack_qty: 1, total_cost: 100, seller_name: 'ООО А' });
    s.repo.setOfferCart(offer, NOW);
    assert.deepEqual(s.repo.rereadCandidates({ limit: 10, nowIso: NOW }).map((t) => t.id).slice(0, 2), [ids[1], ids[0]]);
    assert.deepEqual(s.repo.rereadCandidates({ limit: 10, inWork: true, nowIso: NOW }).map((t) => t.id), [ids[1]]);
    const r = await api(`/api/tenders/${ids[0]}`);
    assert.deepEqual([r.body.reread.started, r.body.reread.reason], [true, 'failed']);
    await s.analyses.idle();
  } finally { await s.close(); }
});

test('файлы подписи у разборов прежней версии не считаются непрочитанными', () => {
  const page = { page: 1, text: 'Описание объекта закупки' };
  const files = [
    { id: 1, name: 'ТЗ.docx', status: 'ok', pages: [page], coverage: { unit: 'block', expected: 1, processed: 1, empty: [], unread: [], ocr: [], status: 'complete' } },
    { id: 2, name: 'ТЗ.docx.zip/ТЗ.docx_Иванов Иван.sig', status: 'unsupported', message: 'Файл электронной подписи — пропущен', pages: [], coverage: null },
    { id: 3, name: 'сертификат.cer', status: 'unsupported', message: 'Формат «.cer» не поддерживается', pages: [], coverage: null },
  ];
  const chunks = [{ id: 'c1', status: 'ok', ranges: [{ fileId: 1, file: 'ТЗ.docx', page: 1, from: 0, to: page.text.length }] }];
  const cov = analysisCoverage({ files, chunks, pageLengths: new Map([['1:1', page.text.length]]) });
  assert.equal(cov.extract.files_unreadable.length, 0);
  assert.equal(cov.extract.files_skipped.length, 2);
  assert.equal(cov.status, 'complete');
  // а архив без пометки по-прежнему пробел: в нём могли быть условия закупки
  const withRar = analysisCoverage({ files: [...files, { id: 4, name: 'документы.rar', status: 'unsupported', message: 'Архив RAR не распакован', pages: [], coverage: null }], chunks, pageLengths: new Map([['1:1', page.text.length]]) });
  assert.equal(withRar.extract.files_unreadable.length, 1);
  assert.notEqual(withRar.status, 'complete');
});

test('нейросеть отказалась отвечать на фрагмент — он делится, непрочитанным остаётся только малая часть', async () => {
  const para = (i) => `Пункт ${i}. ${'Условия поставки товара и порядок расчётов. '.repeat(40)}`;
  const texts = Array.from({ length: 8 }, (_, i) => (i === 5 ? `${para(i)} ЗАПРЕТНОЕ СЛОВО` : para(i)));
  const docs = [{ id: 1, name: 'Контракт.docx', status: 'ok', pages: texts.map((text, i) => ({ page: i + 1, text })) }];
  const chunks = buildChunkQueue(docs, 100000);
  assert.equal(chunks.length, 1, 'весь документ — один фрагмент');
  let calls = 0;
  const records = await runQueue({
    chunks, docs, task: 'extract', version: 'v1',
    callOne: async (text) => {
      calls++;
      if (text.includes('ЗАПРЕТНОЕ СЛОВО')) throw new ExtractionFailed('Нейросеть отказалась отвечать на этот фрагмент (ограничения провайдера)', 'filtered');
      return { data: { ok: true }, attempts: 1, model: 'mock' };
    },
  });
  const failed = records.filter((r) => r.status === 'failed');
  const ok = records.filter((r) => r.status === 'ok');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error_kind, 'filtered');
  assert.ok(ok.length >= 3, 'остальные части приняты');
  const pagesOf = (list) => new Set(list.flatMap((r) => r.ranges.map((x) => x.page)));
  assert.ok(pagesOf(failed).size <= 2, `непрочитанной осталась малая часть: стр. ${[...pagesOf(failed)].join(', ')}`);
  assert.ok(pagesOf(failed).has(6));
  assert.ok(pagesOf(ok).size >= 6);
  assert.ok(calls <= 8);
});

test('печатная копия документа (ТЗ.docx.pdf рядом с ТЗ.docx) второй раз не читается и пробелом не считается', () => {
  const { markRenditions } = require('../server/extract/renditions');
  const body = Array.from({ length: 40 }, (_, i) => `Пункт ${i + 1}. Поставщик обязан поставить многофункциональное устройство формата номер${i} в срок десять рабочих дней.`).join(' ');
  const cov = { unit: 'page', expected: 3, processed: 2, empty: [], unread: [{ unit: 3, reason: 'no_ocr' }], ocr: [], status: 'partial' };
  const files = [
    { name: 'ТЗ.docx.zip/ТЗ.docx', status: 'ok', pages: [{ page: 1, text: body }], coverage: { status: 'complete' } },
    { name: 'ТЗ.docx.zip/ТЗ.docx.pdf', status: 'ok', pages: [{ page: 1, text: body.slice(0, 2000) }, { page: 2, text: body.slice(2000) }], coverage: cov },
    { name: 'ТЗ.docx.zip/ТЗ.docx_Иванов.sig', status: 'unsupported', pages: [], coverage: { blocking: false } },
    // другой документ с похожим именем, но своим текстом — читается как обычно
    { name: 'Контракт.docx', status: 'ok', pages: [{ page: 1, text: body }], coverage: { status: 'complete' } },
    { name: 'Контракт.pdf', status: 'ok', pages: [{ page: 1, text: Array.from({ length: 40 }, (_, i) => `Раздел ${i}. Заказчик оплачивает товар платёжным поручением банк${i} после приёмки.`).join(' ') }], coverage: { status: 'complete' } },
    // PDF без оригинала рядом
    { name: 'Обоснование.pdf', status: 'ok', pages: [{ page: 1, text: body }], coverage: { status: 'complete' } },
  ];
  const out = markRenditions(files);
  assert.deepEqual(out.map((f) => f.status), ['ok', 'unsupported', 'unsupported', 'ok', 'ok', 'ok']);
  assert.match(out[1].message, /Печатная копия документа «ТЗ\.docx»/);
  assert.deepEqual([out[1].coverage.blocking, out[1].coverage.reason, out[1].pages.length], [false, 'rendition', 0]);
  // в отчёте о полноте копия — «пропущена», а не «не прочитана»
  const withIds = out.map((f, i) => ({ ...f, id: i + 1, coverage: f.status === 'ok' ? { unit: 'block', expected: 1, processed: 1, empty: [], unread: [], ocr: [], status: 'complete' } : f.coverage }));
  const report = analysisCoverage({ files: withIds, chunks: [], pageLengths: new Map() });
  assert.equal(report.extract.files_unreadable.length, 0);
  assert.equal(report.extract.files_skipped.length, 2);
});

test('печатная копия документа из картинок: шум распознавания не мешает узнать копию по страницам с текстом', () => {
  const { markRenditions } = require('../server/extract/renditions');
  const title = Array.from({ length: 30 }, (_, i) => `Описание объекта закупки: поставка многофункциональных устройств, раздел${i}, требования заказчика.`).join(' ');
  const table = Array.from({ length: 30 }, (_, i) => `Характеристика${i}: скорость печати не менее ${20 + i} страниц в минуту.`).join(' ');
  const noise = Array.from({ length: 60 }, (_, i) => `явзало${i} oxpyr${i} тепофом${i} uepyanso${i}`).join(' ');
  const original = { name: 'ТЗ.docx.zip/ТЗ.docx', status: 'ok', pages: [{ page: 1, text: title }, { page: 2, text: table }], coverage: { status: 'complete', ocr: [2] } };
  const copy = (extra = {}) => ({
    name: 'ТЗ.docx.zip/ТЗ.docx.pdf', status: 'ok', pages: [{ page: 1, text: title }, { page: 3, text: noise }],
    coverage: { unit: 'page', expected: 4, processed: 2, empty: [], unread: [{ unit: 2, reason: 'scan_no_text' }, { unit: 4, reason: 'scan_no_text' }], ocr: [3], status: 'partial' }, ...extra,
  });
  assert.equal(markRenditions([original, copy()])[1].coverage.reason, 'rendition', 'страница с текстом совпала — это копия');
  // сам документ прочитан не полностью — копию читаем: в ней может быть то, чего не хватило
  assert.equal(markRenditions([{ ...original, coverage: { status: 'partial', ocr: [2] } }, copy()])[1].status, 'ok');
  // имя не точная пара («ТЗ.pdf» рядом с «ТЗ.docx») — послабления нет
  assert.equal(markRenditions([original, copy({ name: 'ТЗ.docx.zip/ТЗ.pdf' })])[1].status, 'ok');
  // у копии нет ни одной страницы с текстовым слоем — судить не по чему, читаем
  assert.equal(markRenditions([original, copy({ pages: [{ page: 3, text: noise }] })])[1].status, 'ok');
  // текст на странице с текстовым слоем другой — это не копия
  assert.equal(markRenditions([original, copy({ pages: [{ page: 1, text: noise.replace(/\d/g, 'я') + ' ' + noise }, { page: 3, text: noise }] })])[1].status, 'ok');
});

test('противоречия: «значение» без источника не считается; у причины — все значения со своими местами в документе', () => {
  const { collectFields, buildFieldGroups, dropUnsourced } = require('../server/analyze/merge');
  const { decide } = require('../server/analyze/decision');
  const { cleanConflicts } = require('../server/analyze');
  const src = (file, page, quote) => ({ file, page, quote });
  // новый разбор: «не указано» без файла и цитаты в карточку не попадает
  const cands = collectFields([
    { fields: [{ key: 'delivery_term', value: 'не указано', source: src('', 1, '') }, { key: 'delivery_term', value: 'до 15.11.2026', source: src('Контракт.docx', 3, 'в срок до 15.11.2026') }] },
    { fields: [{ key: 'delivery_term', value: 'до 30.11.2026', source: src('Извещение.docx', 1, 'до 30.11.2026') }] },
  ]);
  assert.deepEqual(cands.get('delivery_term').map((c) => c.value), ['до 15.11.2026', 'до 30.11.2026']);
  const { groups } = buildFieldGroups(cands, new Map(), false);
  const field = groups.flatMap((g) => g.fields).find((f) => f.key === 'delivery_term');
  assert.equal(field.conflict, true);
  field.review = 'conflict';
  const cov = { status: 'complete', blocking: [], extract: { files_unreadable: [], gaps: [] }, download: { failed: [] }, send: {}, accept: {} };
  const d = decide({ coverage: cov, groups, risks: [], legal: null, candidate: 'участвовать' });
  const reason = d.reasons.find((r) => r.kind === 'document_conflict');
  assert.equal(reason.field, 'delivery_term');
  assert.deepEqual(reason.alternatives.map((a) => [a.value, a.source.file, a.source.page]), [['до 15.11.2026', 'Контракт.docx', 3], ['до 30.11.2026', 'Извещение.docx', 1]]);

  // готовая карточка: ложное противоречие «не указано» ↔ настоящее значение убирается, решение пересчитывается
  const real = { value: 'Требования по статье 31', sources: [{ file: 'Требования.docx', fileId: 7, page: 2, quote: 'статьи 31 Закона', verified: true }] };
  const empty = { value: 'не указано', sources: [{ file: '', fileId: null, page: 1, quote: '', verified: false }] };
  const card = {
    groups: [{ key: 'g', title: 'Требования', fields: [
      { key: 'participant_requirements', label: 'Требования к участнику', status: 'found', conflict: true, review: 'conflict', value: empty.value, sources: empty.sources, alternatives: [empty, real] },
      { key: 'delivery_term', label: 'Срок поставки', status: 'found', conflict: true, review: 'conflict', value: 'до 15.11', sources: [{ file: 'Контракт.docx', fileId: 1, page: 3, quote: 'до 15.11', verified: true }],
        alternatives: [{ value: 'до 15.11', sources: [{ file: 'Контракт.docx', fileId: 1, page: 3, quote: 'до 15.11', verified: true }] }, { value: 'до 30.11', sources: [{ file: 'Извещение.docx', fileId: 2, page: 1, quote: 'до 30.11', verified: true }] }] },
    ] }],
    risks: [{ type: 'противоречие_в_документации', level: 'high', explanation: 'Требования указаны по-разному', sources: [empty.sources[0], real.sources[0]] }],
    questions: [], legal: null, summary: { status: 'found', text: 'т', recommendation: { value: 'участвовать с оговорками', candidate: 'участвовать', reasons: [] } },
    meta: { coverage: cov, confirmed_gaps: [] },
    decision: { gaps: [], reasons: [{ kind: 'document_conflict', text: '«Требования к участнику» указано в документах по-разному' }] },
  };
  const clean = cleanConflicts(card);
  const fields = clean.groups[0].fields;
  assert.deepEqual([fields[0].conflict, fields[0].value, fields[0].sources[0].file], [undefined, 'Требования по статье 31', 'Требования.docx']);
  assert.equal(fields[1].conflict, true, 'настоящее противоречие остаётся');
  assert.equal(clean.risks.length, 0, 'риск по ложному противоречию убран');
  assert.deepEqual(clean.decision.reasons.filter((r) => r.kind === 'document_conflict').map((r) => r.field), ['delivery_term']);
  assert.equal(cleanConflicts(clean), null, 'повторная чистка ничего не меняет');
  assert.equal(cleanConflicts({ ...card, decision: undefined }), null, 'разборы прежней версии не трогаем');
  assert.equal(dropUnsourced(clean).changed, false);
});
