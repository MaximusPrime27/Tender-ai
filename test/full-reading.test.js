// Полное чтение документации: приёмочные сценарии этапа 1. Документы — синтетические (вымышленные), нейросеть —
// управляемая подставная или учебная (mock), сеть и настоящие ключи не нужны.
// Номера в названиях тестов — номера сценариев из задания (раздел «Проверки приёмки»).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { analyzeDocs, redecide } = require('../server/analyze');
const { buildChunkQueue, splitPage, halveChunk } = require('../server/analyze/chunk');
const { callJson, ExtractSchema, ExtractionFailed } = require('../server/analyze/json');
const { rangesLength, gaps, fileCoverage, unreadableCoverage, analysisCoverage, describe } = require('../server/analyze/coverage');
const { decide } = require('../server/analyze/decision');
const { verifySource } = require('../server/analyze/verify');
const { extractFile } = require('../server/extract');
const { createOcr } = require('../server/extract/ocr');
const { createLlm } = require('../server/llm');
const { makePdf, makeDocx, makeScanPdf, addScanPage, NOTICE_PAGES, CONTRACT, TZ } = require('../samples/make-samples');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const noArchiver = { available: async () => false };
const noOcr = { ready: async () => false, pdfReady: async () => false, maxPages: 40 };
const field = (card, key) => card.groups.flatMap((g) => g.fields).find((f) => f.key === key);
const EXTRACT_KEYS = ['fields', 'risks', 'questions'];
const complete = (pages) => fileCoverage({ unit: 'page', expected: pages, processed: pages });
const doc = (id, name, texts) => ({ id, name, status: 'ok', pages: texts.map((text, i) => ({ page: i + 1, text })), coverage: complete(texts.length) });

/** Управляемая нейросеть: ответ по задаче — строка, {text, finish} или функция от текста запроса. */
function scripted(byTask) {
  const calls = [];
  return {
    provider: 'scripted', model: 'test', retryDelayMs: 0, calls,
    async complete({ task, messages, retry }) {
      const user = messages[0].content;
      calls.push({ task, user, retry: Boolean(retry) });
      const a = byTask[task];
      const r = typeof a === 'function' ? await a(user, { retry: Boolean(retry), n: calls.filter((c) => c.task === task).length }) : a;
      if (r instanceof Error) throw r;
      return typeof r === 'string' ? { text: r, finish: 'stop', usage: { in: 1, out: 1 } } : { finish: 'stop', usage: { in: 1, out: 1 }, ...r };
    },
  };
}
const nothing = JSON.stringify({ result: 'nothing_found', fields: [], risks: [], questions: [] });
const summaryOf = (recommendation) => JSON.stringify({ summary: 'Резюме.', recommendation, reasons: ['причина'] });

/** Подставное распознавание: работает через настоящий createOcr с поддельными программами tesseract и pdftoppm. */
function ocrOf(textOf, { maxPages = 200, failPages = [] } = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-read-ocr-'));
  const run = async (cmd, args) => {
    if (cmd === 'tesseract' && args[0] === '--list-langs') return { stdout: 'rus\neng\n', stderr: '' };
    if (cmd === 'pdftoppm') {
      const from = Number(args[args.indexOf('-f') + 1]);
      if (failPages.includes(from)) throw new Error('страница повреждена');
      fs.writeFileSync(`${args.at(-1)}.png`, String(from));
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'tesseract') return { stdout: textOf(Number(fs.readFileSync(args[0], 'utf8'))), stderr: '' };
    throw new Error(`неожиданная команда ${cmd}`);
  };
  return createOcr({ run, has: async () => true, maxPages, tmpRoot });
}

function start(extra = {}, llmFactory = undefined) {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-read-')), PORT: 0, LLM_PROVIDER: 'mock', TENDER_SOURCE: 'fixture', FIXTURES_DIR: FIX,
    TELEGRAM_BOT_TOKEN: '', SUPPLIER_INDEX: false, OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0, ...extra,
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-17T09:00:00Z'),
    sourceOverride: createFixtureSource({ dir: FIX }), ...(llmFactory ? { llmFactory } : { llmFactory: () => createLlm('mock') }) });
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, { ...opts, headers: opts.json ? { 'Content-Type': 'application/json' } : opts.headers, body: opts.json ? JSON.stringify(opts.json) : opts.body });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { s, api, config };
}

/** Закупка из своих документов с готовым разбором: тексты файлов кладутся прямо в базу. */
function tenderWithDocs(s, files, { number = 'READ-1', title = 'Поставка товаров (тест)' } = {}) {
  const id = s.repo.createManualTender({ number, title, price: 500000 });
  const aId = `a-${number}`;
  s.repo.createAnalysis({ id: aId, title });
  for (const [name, texts] of Object.entries(files)) {
    s.repo.addFile(aId, { name, status: 'ok', pages: texts.map((text, i) => ({ page: i + 1, text })), sha256: `sha-${name}`, coverage: complete(texts.length) });
  }
  s.repo.finishAnalysis(aId, { card: { groups: [] }, provider: 'mock', model: 'rules-v1', durationMs: 0 });
  s.repo.setTenderAnalysis(id, aId);
  return { id, aId };
}
const filler = (n) => Array.from({ length: n }, (_, i) => `Раздел ${i + 1}. Общие положения договора поставки: стороны, термины, порядок обмена документами и подписания актов.`);
const itemBlock = (name, qty, extra = '') => `Наименование товара: ${name}\nКоличество: ${qty} шт\n${extra}`;

// ---------- 1 ----------
test('1. товар и важное условие после шестой страницы извлекаются с верным источником', async () => {
  const { s } = start();
  try {
    // товар описан на 8-й странице, срок поставки — на 9-й; раньше позиции искались только на первых шести
    const pages = [...filler(7), itemBlock('Коммутатор управляемый', 4, 'Число портов: не менее 24\nСкорость портов: 1 Гбит/с'), 'Срок поставки товара: в течение 5 календарных дней с даты заключения контракта.'];
    const { id, aId } = tenderWithDocs(s, { 'Документация.pdf': pages });
    const items = await s.details.ensureItems(s.repo.getTender(id));
    assert.deepEqual(items.map((i) => [i.name, i.quantity]), [['Коммутатор управляемый', 4]]);
    const r = await s.details.ensureSpec(s.repo.getTender(id), { force: true });
    assert.equal(r.status, 'done');
    const port = s.repo.getItems(id)[0].spec.required.find((x) => /порт/i.test(x.name));
    assert.deepEqual([port.source.file, port.source.page, port.source.verified], ['Документация.pdf', 8, true]);
    assert.equal(s.repo.getDetails(id).items_coverage.status, 'complete');
    assert.equal(s.repo.getDetails(id).spec_coverage.status, 'complete');

    // общий разбор: условие с последней страницы найдено и привязано к ней
    const { card } = await analyzeDocs(s.repo.getFilesFull(aId), createLlm('mock'), { maxChars: 1200 });
    const term = field(card, 'delivery_term');
    assert.equal(term.status, 'found');
    assert.deepEqual([term.sources[0].page, term.sources[0].verified, term.review], [9, true, 'confirmed']);
  } finally { await s.close(); }
});

// ---------- 2, 3, 10 ----------
test('2. документация больше одного лимита входа: в очередь попадают все диапазоны, включая конец файла', () => {
  const docs = [doc(1, 'ТЗ.pdf', Array.from({ length: 12 }, (_, i) => `Страница ${i + 1}. ${'текст требований '.repeat(40)}`)), doc(2, 'Контракт.docx', ['Последний файл. Гарантия 36 месяцев.'])];
  const queue = buildChunkQueue(docs, 1500);
  assert.ok(queue.length > 5);
  assert.ok(queue.every((c) => c.text.length <= 1500), 'каждый фрагмент — в пределах лимита');
  for (const d of docs) for (const p of d.pages) {
    const ranges = queue.flatMap((c) => c.ranges).filter((r) => r.fileId === d.id && r.page === p.page);
    assert.deepEqual(gaps(p.text.length, ranges), [], `${d.name}, стр. ${p.page} — вошла целиком`);
  }
  assert.match(queue.at(-1).text, /Гарантия 36 месяцев/, 'конец последнего файла — в очереди');
});

test('3. страница длиннее лимита делится на части, а не пропускается; 10. перекрытие не считается дважды', async () => {
  const long = Array.from({ length: 120 }, (_, i) => `Пункт ${i + 1}. Поставщик обязан выполнить условие номер ${i + 1} в установленный срок.`).join('\n');
  const parts = splitPage(long, 900);
  assert.ok(parts.length > 5);
  assert.ok(parts.every((p) => p.text.length <= 900));
  assert.deepEqual(gaps(long.length, parts), [], 'части покрывают страницу целиком');
  assert.ok(parts.slice(1).every((p, i) => p.from < parts[i].to), 'соседние части перекрываются');
  // каждая строка целиком есть хотя бы в одной части — условие не рвётся пополам
  for (const line of long.split('\n')) assert.ok(parts.some((p) => p.text.includes(line)), line);
  assert.equal(rangesLength(parts), long.length, 'перекрытие не увеличивает покрытие');

  const docs = [doc(1, 'Договор.docx', [long])];
  const llm = scripted({ extract: nothing, summary: summaryOf('недостаточно данных') });
  const { card } = await analyzeDocs(docs, llm, { maxChars: 1100 });
  const cov = card.meta.coverage;
  assert.ok(cov.send.chunks_built > 5);
  assert.deepEqual([cov.send.chars_total, cov.send.chars_sent, cov.accept.chars_accepted], [long.length, long.length, long.length]);
  assert.deepEqual([cov.send.status, cov.accept.status, cov.status], ['complete', 'complete', 'complete']);
});

// ---------- 4 ----------
test('4. скан больше 40 страниц: распознаются все партиями; при бюджете остаток назван и дочитывается, последняя страница не теряется', async () => {
  const scan = await makeScanPdf(45);
  const textOf = (n) => (n === 45 ? 'Страница 45. Гарантийный срок на товар: не менее 36 месяцев.' : `Страница ${n}. Общие условия поставки и приёмки товара.`);

  const [all] = await extractFile({ name: 'Скан.pdf', buffer: scan }, 0, { ocr: ocrOf(textOf), archiver: noArchiver });
  assert.deepEqual([all.status, all.pages.length, all.coverage.status, all.coverage.expected, all.coverage.processed], ['ok', 45, 'complete', 45, 45]);
  assert.match(all.pages[44].text, /36 месяцев/);
  assert.equal(all.coverage.ocr.length, 45, 'все страницы помечены как распознанные — их сверяют с оригиналом');

  // бюджет одного прохода — 40 страниц: остаток не «обрезан молча», а назван
  const [part] = await extractFile({ name: 'Скан.pdf', buffer: scan }, 0, { ocr: ocrOf(textOf, { maxPages: 40 }), archiver: noArchiver });
  assert.deepEqual([part.status, part.coverage.status, part.coverage.processed], ['ok', 'partial', 40]);
  assert.deepEqual(part.coverage.unread, [41, 42, 43, 44, 45].map((unit) => ({ unit, reason: 'ocr_budget' })));
  assert.match(part.message, /не прочитано страниц: 5 \(41–45\)/);
  assert.ok(!/36 месяцев/.test(part.pages.map((p) => p.text).join(' ')));

  // следующий проход: распознанные страницы не распознаются повторно, дочитываются только оставшиеся пять
  const known = new Map([['Скан.pdf', new Map(part.pages.filter((p) => p.text).map((p) => [p.page, p.text]))]]);
  const asked = [];
  const [rest] = await extractFile({ name: 'Скан.pdf', buffer: scan }, 0, { ocr: ocrOf((n) => { asked.push(n); return textOf(n); }, { maxPages: 40 }), archiver: noArchiver, known });
  assert.deepEqual(asked, [41, 42, 43, 44, 45]);
  assert.deepEqual([rest.coverage.status, rest.coverage.processed, rest.coverage.unread], ['complete', 45, []]);
  assert.match(rest.pages[44].text, /36 месяцев/);
});

// ---------- 5 ----------
test('5. смешанный PDF: текст извлечён, страница-скан не распознана — файл частичный, окончательное решение заблокировано', async () => {
  const { PDFDocument } = require('pdf-lib');
  const base = await PDFDocument.load(await makePdf(NOTICE_PAGES));
  await addScanPage(base);
  const mixed = Buffer.from(await base.save());
  const [f] = await extractFile({ name: 'Извещение.pdf', buffer: mixed }, 0, { ocr: ocrOf(() => 'x', { failPages: [4] }), archiver: noArchiver });
  assert.equal(f.status, 'ok', 'текстовые страницы прочитаны');
  assert.deepEqual([f.coverage.status, f.coverage.expected, f.coverage.processed], ['partial', 4, 3]);
  assert.deepEqual(f.coverage.unread.map((u) => [u.unit, u.reason]), [[4, 'ocr_failed']]);

  const { card } = await analyzeDocs([{ ...f, id: 1 }], createLlm('mock'), { maxChars: 24000 });
  assert.equal(card.meta.coverage.status, 'partial');
  assert.equal(card.meta.coverage.extract.pages_processed, 3);
  assert.deepEqual([card.decision.analysis_status, card.decision.decision_status], ['incomplete', 'preliminary']);
  assert.notEqual(card.decision.participation_recommendation, 'участвовать');
  assert.notEqual(card.decision.participation_recommendation, 'участвовать с оговорками');
  assert.ok(card.decision.gaps.some((g) => /Извещение\.pdf/.test(g.text) && g.action === 'retry'), 'пробел назван вместе с действием');
  assert.match(describe(card.meta.coverage), /обработано страниц PDF: 3 из 4/);

  // человек открыл страницу и проверил её сам — пробел больше не блокирует решение (нейросеть не вызывается)
  const gap = card.decision.gaps.find((g) => /Извещение\.pdf/.test(g.text));
  const after = redecide(card, [{ key: gap.key, note: 'страница — лист согласования, требований нет' }]);
  assert.notEqual(after.decision.analysis_status, 'incomplete');
  assert.equal(after.decision.gaps.find((g) => g.key === gap.key).confirmed, true);
});

// ---------- 6 ----------
test('6. один фрагмент из двух не принят: успешные данные сохранены, итог видит пробел, повторяется только сбойный фрагмент', async () => {
  const docs = [doc(1, 'a.pdf', ['Срок поставки 10 дней с даты заключения контракта. '.padEnd(110, 'а'), 'Аванс не предусмотрен, оплата в течение 7 рабочих дней. '.padEnd(110, 'б')])];
  const good = JSON.stringify({ result: 'found', fields: [{ key: 'delivery_term', value: '10 дней', file: 'a.pdf', page: 1, quote: 'Срок поставки 10 дней' }], risks: [], questions: [] });
  let briefSeen = null;
  const llm = scripted({
    extract: (user) => (user.includes('Аванс') ? 'не JSON' : good), // второй фрагмент — мусор и в первый раз, и после повтора
    summary: (user) => { briefSeen = JSON.parse(user); return summaryOf('участвовать'); },
  });
  const first = await analyzeDocs(docs, llm, { maxChars: 200 });
  const card = first.card;
  assert.deepEqual([card.meta.chunks, card.meta.failedChunks, card.summary.status], [2, 1, 'found']);
  assert.equal(field(card, 'delivery_term').status, 'found', 'данные принятого фрагмента сохранены');
  // модель резюме получила сведения о сбое, а не только «не найдено»
  assert.deepEqual([briefSeen.reading.complete, briefSeen.reading.failed_fragments], [false, 1]);
  assert.ok(briefSeen.reading.not_read.some((t) => /a\.pdf.*стр\. 2/.test(t)));
  assert.equal(briefSeen.fields['Аванс'].status, 'unknown_due_to_incomplete_review', '«не найдено» в непрочитанной части — это «неизвестно»');
  assert.equal(field(card, 'advance').review, 'unknown_due_to_incomplete_review');
  // рекомендация нейросети «участвовать» не становится окончательной
  assert.deepEqual([card.decision.participation_recommendation, card.decision.decision_status, card.summary.recommendation.candidate], ['недостаточно данных', 'preliminary', 'участвовать']);
  assert.deepEqual(first.chunks.map((c) => [c.status, c.error_kind || null]), [['ok', null], ['failed', 'invalid_json']]);
  assert.deepEqual(card.meta.coverage.accept.failed[0].pages, [{ file: 'a.pdf', pages: [2] }]);

  // повторный проход: принятый фрагмент берётся из хранилища, нейросети отправляется только несостоявшийся
  const store = new Map(first.chunks.filter((c) => c.status === 'ok').map((c) => [c.cache_key, { result: c.result }]));
  const llm2 = scripted({
    extract: (user) => JSON.stringify({ result: 'found', fields: [{ key: 'advance', value: 'не предусмотрен', file: 'a.pdf', page: 2, quote: 'Аванс не предусмотрен' }], risks: [], questions: [] }),
    summary: summaryOf('участвовать'),
  });
  const second = await analyzeDocs(docs, llm2, { maxChars: 200, chunkStore: { get: (k) => store.get(k) } });
  const sent = llm2.calls.filter((c) => c.task === 'extract');
  assert.equal(sent.length, 1);
  assert.match(sent[0].user, /Аванс/);
  assert.deepEqual([second.card.meta.failedChunks, second.card.meta.coverage.status], [0, 'complete']);
  assert.deepEqual([field(second.card, 'delivery_term').status, field(second.card, 'advance').status], ['found', 'found']);
});

// ---------- 7, 8 ----------
test('7. ответ оборван лимитом, но похож на JSON — не принимается; фрагмент делится и разбирается по частям', async () => {
  const valid = JSON.stringify({ result: 'found', fields: [{ key: 'advance', value: 'нет', file: 'a.pdf', page: 1, quote: 'Аванс не предусмотрен' }], risks: [], questions: [] });
  await assert.rejects(
    callJson(scripted({ extract: { text: valid, finish: 'length' } }), { system: 's', user: 'u', schema: ExtractSchema, task: 'extract', requiredKeys: EXTRACT_KEYS }),
    (err) => err instanceof ExtractionFailed && err.kind === 'truncated' && /оборван лимитом/.test(err.message),
  );
  // отказ провайдера и не поместившийся запрос — свои виды ошибок, не «ничего не найдено»
  await assert.rejects(callJson(scripted({ extract: { text: valid, finish: 'filtered' } }), { system: 's', user: 'u', schema: ExtractSchema, task: 'extract' }), (err) => err.kind === 'filtered');
  await assert.rejects(callJson(scripted({ extract: new Error('gigachat.devices.sberbank.ru ответил 422: context length exceeded') }), { system: 's', user: 'u', schema: ExtractSchema, task: 'extract' }), (err) => err.kind === 'too_large');
  const flaky = scripted({ extract: (u, { n }) => (n === 1 ? new Error('Нет связи с gigachat: ETIMEDOUT') : valid) });
  assert.equal((await callJson(flaky, { system: 's', user: 'u', schema: ExtractSchema, task: 'extract', requiredKeys: EXTRACT_KEYS })).attempts, 2, 'сбой связи — одна повторная попытка');
  await assert.rejects(callJson(scripted({ extract: new Error('Нет связи') }), { system: 's', user: 'u', schema: ExtractSchema, task: 'extract' }), (err) => err.kind === 'transport');

  // в разборе: большой фрагмент обрывается лимитом → делится пополам → части принимаются; охват полный
  const text = Array.from({ length: 60 }, (_, i) => `Условие ${i + 1}: поставщик обеспечивает исполнение обязательства номер ${i + 1}.`).join('\n');
  const docs = [doc(1, 'a.pdf', [text])];
  const llm = scripted({ extract: (user) => (user.length > 2500 ? { text: valid.slice(0, 40), finish: 'length' } : nothing), summary: summaryOf('недостаточно данных') });
  const { card, chunks } = await analyzeDocs(docs, llm, { maxChars: 24000 });
  assert.ok(chunks.length >= 2, 'вместо одного оборванного — несколько принятых частей');
  assert.ok(chunks.every((c) => c.status === 'ok'));
  assert.deepEqual([card.meta.failedChunks, card.meta.coverage.accept.status, card.meta.coverage.accept.chars_accepted], [0, 'complete', text.length]);
  assert.equal(halveChunk({ ranges: [{ fileId: 1, file: 'a.pdf', page: 1, from: 0, to: 100 }] }, [doc(1, 'a.pdf', ['коротко'])]).length, 0, 'делить нечего — честный сбой, а не бесконечное деление');
});

test('8. пустой JSON вместо обязательной структуры — ошибка; подтверждённо пустой фрагмент принимается', async () => {
  const opts = { system: 's', user: 'u', schema: ExtractSchema, task: 'extract', requiredKeys: EXTRACT_KEYS, emptyNeedsConfirm: EXTRACT_KEYS };
  await assert.rejects(callJson(scripted({ extract: '{}' }), opts), (err) => err.kind === 'schema' && /нет обязательных ключей: fields, risks, questions/.test(err.message));
  await assert.rejects(callJson(scripted({ extract: JSON.stringify({ fields: [], risks: [], questions: [] }) }), opts), (err) => err.kind === 'unconfirmed');
  const ok = await callJson(scripted({ extract: nothing }), opts);
  assert.deepEqual(ok.data, { fields: [], risks: [], questions: [] });
  // модель исправилась после замечания — принимается со второй попытки
  const fixed = await callJson(scripted({ extract: (u, { retry }) => (retry ? nothing : '{}') }), opts);
  assert.equal(fixed.attempts, 2);
});

// ---------- 9 ----------
test('9. таблица, уходящая на следующий фрагмент: заголовок повторяется, строка не рвётся, указаны лист и строки', async () => {
  const rows = [['№', 'Наименование товара', 'Количество', 'Ед. изм.', 'Характеристики']];
  for (let i = 1; i <= 150; i++) rows.push([i, `Картридж модель KX-${1000 + i}`, i + 2, 'шт', `ресурс не менее ${i * 100} страниц, цвет чёрный`]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Спецификация');
  const hiddenWs = XLSX.utils.aoa_to_sheet([['Примечание'], ['Гарантия на картриджи — 12 месяцев']]);
  XLSX.utils.book_append_sheet(wb, hiddenWs, 'Доп');
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
  const [f] = await extractFile({ name: 'Спецификация.xlsx', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) }, 0, { ocr: noOcr, archiver: noArchiver });
  assert.equal(f.status, 'ok');
  assert.ok(f.pages.length > 3, 'длинная таблица разбита на группы строк');
  const head = '№ | Наименование товара | Количество | Ед. изм. | Характеристики';
  const main = f.pages.filter((p) => p.locator.sheet === 'Спецификация');
  assert.ok(main.every((p) => p.text.includes(head)), 'заголовок столбцов — в каждом фрагменте');
  assert.match(main[1].text, /^Лист «Спецификация», строки \d+–\d+\n/);
  assert.deepEqual(main[0].locator.rows[0], 1);
  assert.equal(main.at(-1).locator.rows[1], 151, 'последняя строка таблицы на месте');
  // каждая позиция целиком (название, количество, единица, характеристика) — в одном фрагменте
  for (let i = 1; i <= 150; i++) {
    const line = `${i} | Картридж модель KX-${1000 + i} | ${i + 2} | шт | ресурс не менее ${i * 100} страниц, цвет чёрный`;
    assert.ok(f.pages.some((p) => p.text.split('\n').includes(line)), line);
  }
  assert.match(f.pages.at(-1).text, /Лист «Доп» \(скрытый лист\)[\s\S]*Гарантия на картриджи/, 'скрытый лист тоже прочитан');
  assert.deepEqual([f.coverage.status, f.coverage.unit, f.coverage.sheets], ['complete', 'sheet_rows', ['Спецификация', 'Доп']]);

  // длинная страница-таблица (как из PDF): при делении на части строка остаётся целой, заголовок повторяется
  const table = [head, ...rows.slice(1).map((r) => r.join(' | '))].join('\n');
  const queue = buildChunkQueue([doc(1, 'ТЗ.pdf', [table])], 1800);
  assert.ok(queue.length > 4);
  assert.ok(queue.slice(1).every((c) => c.text.includes(`заголовок таблицы: ${head}`)));
  for (const r of rows.slice(1)) assert.ok(queue.some((c) => c.text.includes(r.join(' | '))), r.join(' | '));
});

// ---------- 10 ----------
test('10. перекрытие частей и повторный запуск не создают дубли товаров', async () => {
  const { s } = start({ LLM_MAX_CHARS_PER_CHUNK: 700 });
  try {
    // одна длинная страница: при делении позиции на стыке попадают в обе соседние части
    const text = Array.from({ length: 14 }, (_, i) => itemBlock(`Картридж для принтера модель ${String.fromCharCode(65 + i)}-${100 + i}`, i + 1, `Ресурс: не менее ${1000 + i} страниц`)).join('\n\n');
    const { id, aId } = tenderWithDocs(s, { 'ТЗ.docx': [text] }, { number: 'READ-10' });
    const items = await s.details.ensureItems(s.repo.getTender(id));
    assert.ok(s.repo.listChunks(aId, 'items').length > 2, 'страница разобрана несколькими фрагментами');
    assert.equal(items.length, 14, 'каждая позиция — один раз');
    assert.equal(new Set(items.map((i) => i.name)).size, 14);
    const again = await s.details.ensureItems(s.repo.getTender(id), { force: true });
    assert.deepEqual(again.map((i) => [i.id, i.name, i.quantity]), items.map((i) => [i.id, i.name, i.quantity]), 'повторный запуск — те же записи, без дублей');
  } finally { await s.close(); }
});

// ---------- 11, 17 ----------
test('11. в закупке больше позиций, чем нашлось в ТЗ: состав не сверен, расчёт не объявляется полным', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    s.repo.saveItems(id, [
      { name: 'Картридж', characteristics: [{ name: 'Модель', value: 'CE743A' }], quantity: 2, unit: 'шт', unit_price: 5000, sum: 10000, source: 'notification' },
      { name: 'Картридж', characteristics: [{ name: 'Модель', value: 'P2V67A' }], quantity: 5, unit: 'шт', unit_price: 3000, sum: 15000, source: 'notification' },
      { name: 'Бумага офисная', characteristics: [], quantity: 40, unit: 'пачка', unit_price: 400, sum: 16000, source: 'notification' },
    ], { source: 'notification' });
    const aId = 'a-read-11';
    s.repo.createAnalysis({ id: aId, title: 'ТЗ' });
    // в ТЗ описаны только два картриджа, причём у второго другое количество
    s.repo.addFile(aId, { name: 'ТЗ.docx', status: 'ok', coverage: complete(1), pages: [{ page: 1, text: `${itemBlock('Картридж', 2, 'Модель: CE743A\nЦвет: чёрный')}\n\n${itemBlock('Картридж', 7, 'Модель: P2V67A\nЦвет: голубой')}` }] });
    s.repo.finishAnalysis(aId, { card: { groups: [] }, provider: 'mock', model: 'm', durationMs: 0 });
    s.repo.setTenderAnalysis(id, aId);
    const r = await s.details.ensureSpec(s.repo.getTender(id), { force: true });
    assert.equal(r.matched, 2);
    const rec = s.repo.getDetails(id).spec_coverage.reconcile;
    assert.deepEqual([rec.items, rec.tz, rec.matched, rec.ok], [3, 2, 2, false]);
    assert.deepEqual(rec.unmatched_items, ['Бумага офисная']);
    assert.deepEqual(rec.quantity_conflicts, [{ name: 'Картридж', values: [5, 7] }], 'расхождение количества показано, меньшее молча не выбирается');
    assert.equal(s.repo.getItems(id)[1].quantity, 5, 'количество из извещения не подменено');

    const econ = (await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { items: s.repo.getItems(id).map((i) => ({ id: i.id, purchase_price: 100 })) } })).body.economics;
    assert.equal(econ.result.preliminary, true);
    assert.ok(econ.result.spec_gaps.some((g) => /в ТЗ не найдены позиции закупки: 1 из 3/.test(g)));
    assert.ok(econ.result.spec_gaps.some((g) => /количество в извещении и ТЗ расходится/.test(g)));
    assert.ok(!econ.confirmed, 'цены всех позиций введены, но расчёт не «подтверждён»: состав не сверен');
  } finally { await s.close(); }
});

test('17. общий анализ полон, а ТЗ прочитано частично (бюджет прохода): расчёт и карточка видят неполноту; следующий проход дочитывает', async () => {
  const { s, api } = start({ LLM_MAX_CHARS_PER_CHUNK: 600, SPEC_MAX_CHUNKS: 1, ITEMS_MAX_CHUNKS: 50 });
  try {
    const pages = Array.from({ length: 6 }, (_, i) => itemBlock(`Монитор модель M-${200 + i}`, i + 1, `Диагональ: не менее ${22 + i} дюймов\nРазрешение: 1920x1080`));
    const { id, aId } = tenderWithDocs(s, { 'ТЗ.docx': pages }, { number: 'READ-17' });
    await s.details.ensureItems(s.repo.getTender(id));
    assert.equal(s.repo.getItems(id).length, 6);
    assert.equal(s.repo.getDetails(id).items_coverage.status, 'complete', 'позиции извлечены полностью');
    await s.details.ensureSpec(s.repo.getTender(id), { force: true });
    const sc = s.repo.getDetails(id).spec_coverage;
    assert.equal(sc.status, 'partial');
    assert.ok(sc.chunks_skipped >= 1 && sc.chunks_accepted === 1, JSON.stringify(sc));
    assert.ok(sc.blocking.some((b) => b.kind === 'budget'));
    const card = (await api(`/api/tenders/${id}`)).body;
    assert.equal(card.details.spec_coverage.status, 'partial', 'карточка закупки отдаёт отчёт о чтении ТЗ отдельно от общего разбора');
    assert.match(card.details.spec_note, /документация прочитана не полностью/);
    const econ = (await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { items: card.items.map((i) => ({ id: i.id, purchase_price: 9000 })) } })).body.economics;
    assert.equal(econ.result.preliminary, true);
    assert.ok(econ.result.spec_gaps.includes('требования ТЗ прочитаны не полностью'));
    assert.ok(!econ.confirmed);

    // следующий проход: принятый фрагмент не отправляется заново, читаются следующие
    const before = s.repo.listChunks(aId, 'spec').filter((c) => c.status === 'ok').length;
    await s.details.ensureSpec(s.repo.getTender(id), { force: true });
    assert.equal(s.repo.listChunks(aId, 'spec').filter((c) => c.status === 'ok').length, before + 1);
  } finally { await s.close(); }
});

// ---------- 12, 16 ----------
test('12. все источники обработаны, но документы противоречат друг другу: охват полный, решение требует проверки', async () => {
  const zip = new AdmZip();
  zip.addFile('Извещение.pdf', await makePdf(NOTICE_PAGES));
  zip.addFile('Проект_контракта.docx', makeDocx(CONTRACT));
  zip.addFile('ТЗ.docx', makeDocx(TZ));
  for (const e of zip.getEntries()) e.header.flags |= 0x800;
  const docs = (await extractFile({ name: 'sample-44fz.zip', buffer: zip.toBuffer() })).map((f, i) => ({ ...f, id: i + 1 }));
  assert.ok(docs.every((d) => d.coverage.status === 'complete' && /^[0-9a-f]{64}$/.test(d.sha256)));
  const { card } = await analyzeDocs(docs, createLlm('mock'), { maxChars: 24000 });
  assert.equal(card.meta.coverage.status, 'complete');
  assert.equal(describe(card.meta.coverage), 'получено вложений: 3 из 3; прочитано файлов: 3 из 3; обработано страниц PDF: 3 из 3; принято фрагментов: 1 из 1');
  assert.equal(field(card, 'delivery_term').review, 'conflict');
  assert.deepEqual([card.decision.analysis_status, card.decision.decision_status], ['needs_review', 'preliminary']);
  assert.ok(card.decision.reasons.some((r) => r.kind === 'document_conflict' && /Срок поставки/.test(r.text)));
  // настоящие риски сохранены и названы причинами — это оговорки, а не «недостаточно данных»
  assert.ok(card.decision.reasons.filter((r) => r.kind === 'confirmed_risk').length >= 3);
  assert.notEqual(card.decision.participation_recommendation, 'недостаточно данных');
});

test('16. полный комплект: реальный риск сохраняет «с оговорками»; без рисков оговорки из-за шаблона не появляются', async () => {
  const text = 'Объект закупки: поставка бумаги офисной. Начальная (максимальная) цена контракта: 100 000,00 рублей. Окончание подачи заявок: 01.10.2026 09:00. '
    + 'Срок поставки товара: 10 календарных дней. Место поставки товара: г. Тверь, ул. Советская, д. 1. Оплата в течение 7 рабочих дней после приёмки.';
  const docs = [doc(1, 'Извещение.pdf', [text])];
  const f = (key, value, quote) => ({ key, value, file: 'Извещение.pdf', page: 1, quote });
  const fields = [f('subject', 'бумага офисная', 'поставка бумаги офисной'), f('nmck', '100 000,00 руб.', 'цена контракта: 100 000,00 рублей'), f('bid_deadline', '01.10.2026 09:00', 'Окончание подачи заявок: 01.10.2026 09:00'),
    f('delivery_term', '10 календарных дней', 'Срок поставки товара: 10 календарных дней'), f('delivery_place', 'г. Тверь', 'Место поставки товара: г. Тверь'), f('payment_terms', '7 рабочих дней', 'Оплата в течение 7 рабочих дней')];
  const answer = (risks) => JSON.stringify({ result: 'found', fields, risks, questions: [] });

  // нейросеть по привычке ответила «с оговорками», но ни рисков, ни спорных условий, ни пробелов нет
  const clean = await analyzeDocs(docs, scripted({ extract: answer([]), summary: summaryOf('участвовать с оговорками'), legal: JSON.stringify({ issues: [], reasons: [] }) }), { maxChars: 24000 });
  assert.equal(clean.card.meta.coverage.status, 'complete');
  assert.deepEqual([clean.card.decision.analysis_status, clean.card.decision.decision_status, clean.card.decision.participation_recommendation], ['complete', 'final', 'участвовать']);
  assert.equal(clean.card.summary.recommendation.candidate, 'участвовать с оговорками', 'ответ нейросети сохранён для сверки');
  assert.equal(clean.card.summary.recommendation.value, 'участвовать');

  // настоящий подтверждённый риск: оговорка остаётся и названа причиной с источником
  const risk = [{ type: 'долгая_оплата', level: 'high', explanation: 'Оплата дольше обычного', file: 'Извещение.pdf', page: 1, quote: 'Оплата в течение 7 рабочих дней' }];
  const risky = await analyzeDocs(docs, scripted({ extract: answer(risk), summary: summaryOf('участвовать с оговорками'), legal: JSON.stringify({ issues: [], reasons: [] }) }), { maxChars: 24000 });
  assert.deepEqual([risky.card.decision.participation_recommendation, risky.card.decision.decision_status], ['участвовать с оговорками', 'final']);
  const reason = risky.card.decision.reasons.find((r) => r.kind === 'confirmed_risk');
  assert.deepEqual([reason.text, reason.source.page, reason.source.verified, reason.impact], ['Оплата дольше обычного', 1, true, 'оговорка']);
  // и наоборот: нейросеть сказала «участвовать», а серьёзный подтверждённый риск есть — без оговорки не остаётся
  const naive = await analyzeDocs(docs, scripted({ extract: answer(risk), summary: summaryOf('участвовать'), legal: JSON.stringify({ issues: [], reasons: [] }) }), { maxChars: 24000 });
  assert.equal(naive.card.decision.participation_recommendation, 'участвовать с оговорками');

  // правило окончательности — в коде: при пробелах в чтении положительное решение не выдаётся, что бы ни сказала модель
  const cov = analysisCoverage({ files: [{ ...docs[0] }, { id: 2, name: 'ТЗ.rar', status: 'unsupported', message: 'Архив RAR — нет программы распаковки', pages: [], coverage: unreadableCoverage(true, 'unsupported') }], chunks: [], pageLengths: new Map() });
  const d = decide({ coverage: cov, groups: clean.card.groups, risks: [], candidate: 'участвовать' });
  assert.deepEqual([d.analysis_status, d.decision_status, d.participation_recommendation], ['incomplete', 'preliminary', 'недостаточно данных']);
  // подтверждённое препятствие обосновывает предварительное «не участвовать» и при неполном чтении — неполнота остаётся видимой
  const no = decide({ coverage: cov, groups: clean.card.groups, risks: [{ type: 'жёсткие_штрафы', level: 'high', explanation: 'Штраф 30%', sources: [{ verified: true }] }], candidate: 'не участвовать' });
  assert.deepEqual([no.participation_recommendation, no.decision_status, no.counts.blockers], ['не участвовать', 'preliminary', 1]);
});

// ---------- 13 ----------
test('13. подтверждённо пустая страница учитывается; неизвестное число страниц не даёт ложного охвата 100%', async () => {
  // текст, пустой лист (ни текста, ни изображений), текст
  const withBlank = await makePdf([['Первая страница: предмет закупки — поставка мониторов для учреждения.'], [], ['Третья страница: срок поставки 10 дней с даты заключения контракта.']]);
  const [f] = await extractFile({ name: 'ТЗ.pdf', buffer: withBlank }, 0, { ocr: noOcr, archiver: noArchiver });
  assert.deepEqual([f.status, f.coverage.status, f.coverage.expected, f.coverage.processed, f.coverage.empty, f.coverage.unread], ['ok', 'complete', 3, 2, [2], []]);
  assert.equal(f.message, undefined, 'пустой лист — не «страница-скан без текста»');

  // а страница с изображением и без текста — не пустая: без распознавания она остаётся непрочитанной
  const { PDFDocument } = require('pdf-lib');
  const pdf = await PDFDocument.load(withBlank);
  await addScanPage(pdf);
  const [g] = await extractFile({ name: 'ТЗ.pdf', buffer: Buffer.from(await pdf.save()) }, 0, { ocr: noOcr, archiver: noArchiver });
  assert.deepEqual([g.coverage.status, g.coverage.empty, g.coverage.unread], ['partial', [2], [{ unit: 4, reason: 'no_ocr' }]]);

  // файл не открылся как PDF и распознан картинками, но до конца не дошли: сколько в нём страниц — неизвестно
  const broken = Buffer.from('%PDF-1.4 повреждённый файл');
  const ocr = { ready: async () => true, pdfReady: async () => true, maxPages: 2,
    pdf: async () => ({ pages: [{ page: 1, text: 'Страница 1: описание объекта закупки и требования к товару.' }, { page: 2, text: 'Страница 2: порядок приёмки товара и оформления документов.' }], failed: [], pending: [], total: null, truncated: true }) };
  const [u] = await extractFile({ name: 'Скан.pdf', buffer: broken }, 0, { ocr, archiver: noArchiver });
  assert.deepEqual([u.status, u.coverage.expected, u.coverage.processed, u.coverage.status], ['ok', null, 2, 'partial']);
  assert.ok(u.coverage.unread.some((x) => x.reason === 'unknown_tail'));
  const cov = analysisCoverage({ files: [{ ...u, id: 1 }], chunks: buildChunkQueue([{ ...u, id: 1 }], 5000).map((c) => ({ ...c, status: 'ok' })), pageLengths: new Map(u.pages.map((p) => [`1:${p.page}`, p.text.length])) });
  assert.equal(cov.extract.pages_expected, null);
  assert.notEqual(cov.status, 'complete');
  assert.match(describe(cov), /обработано страниц PDF: 2;/, 'без знаменателя: «2», а не «2 из 2»');
  // файл без отчёта о полноте (старый разбор) — полнота неизвестна, а не «полная»
  assert.equal(analysisCoverage({ files: [{ id: 1, name: 'a.pdf', status: 'ok', pages: [{ page: 1, text: 'текст' }] }], chunks: [{ id: 'x', status: 'ok', ranges: [{ fileId: 1, file: 'a.pdf', page: 1, from: 0, to: 5 }] }], pageLengths: new Map([['1:1', 5]]) }).status, 'unknown');
  assert.equal(describe(null), 'Разбор сделан прежней версией сервиса — полнота чтения неизвестна');
});

// ---------- 14 ----------
test('14. недоступное вложение и нераспакованный вложенный архив: причина и блокировка видны, это не «требования не найдены»', async () => {
  const inner = new AdmZip();
  inner.addFile('Требования.rar', Buffer.concat([Buffer.from('Rar!\x1a\x07\x00', 'latin1'), Buffer.alloc(200, 1)]));
  inner.addFile('Извещение.docx', makeDocx(['Объект закупки: поставка мониторов. Срок поставки товара: 10 календарных дней.']));
  inner.addFile('Извещение.docx.sig', Buffer.from('подпись'));
  const files = (await extractFile({ name: 'Документация.zip', buffer: inner.toBuffer() }, 0, { ocr: noOcr, archiver: noArchiver })).map((f, i) => ({ ...f, id: i + 1 }));
  const byName = Object.fromEntries(files.map((f) => [f.name.split('/').pop(), f]));
  assert.deepEqual([byName['Требования.rar'].status, byName['Требования.rar'].coverage.blocking], ['unsupported', true]);
  assert.deepEqual([byName['Извещение.docx.sig'].status, byName['Извещение.docx.sig'].coverage.blocking], ['unsupported', false], 'файл подписи — не пробел в чтении');
  // и одно вложение не скачалось вовсе
  files.push({ id: 9, name: 'Проект контракта.pdf', status: 'error', message: 'Не скачан: zakupki.gov.ru ответил 404', pages: [], coverage: unreadableCoverage(true, 'download') });

  const { card } = await analyzeDocs(files, createLlm('mock'), { maxChars: 24000 });
  const cov = card.meta.coverage;
  assert.deepEqual([cov.download.expected, cov.download.received, cov.download.status], [3, 2, 'partial'], 'подпись в счёт вложений не идёт');
  assert.deepEqual(cov.extract.files_unreadable.map((f) => f.name), ['Документация.zip/Требования.rar']);
  assert.deepEqual(cov.blocking.map((b) => b.kind).sort(), ['file_unreadable', 'source_unavailable']);
  assert.match(describe(cov), /получено вложений: 2 из 3; прочитано файлов: 1 из 2/);
  assert.deepEqual([card.decision.analysis_status, card.decision.participation_recommendation], ['incomplete', 'недостаточно данных']);
  assert.ok(card.decision.reasons.some((r) => r.kind === 'source_unavailable' && /Проект контракта\.pdf/.test(r.text)));
  // «не найдено» в такой ситуации — «неизвестно», а не «в документации этого нет»
  assert.equal(field(card, 'payment_terms').review, 'unknown_due_to_incomplete_review');
  assert.equal(field(card, 'delivery_term').review, 'confirmed', 'подтверждённые факты сохраняются');
});

// ---------- 15 ----------
test('15. документ изменён: результаты прежней версии не переиспользуются; цитата из другого файла источником не считается', async () => {
  const v1 = [doc(1, 'ТЗ.docx', ['Срок поставки товара: 10 календарных дней с даты заключения контракта.']), doc(2, 'Контракт.docx', ['Оплата в течение 7 рабочих дней после подписания акта приёмки.'])];
  const answerFor = (user) => {
    const m = user.match(/Срок поставки товара: (\d+) календарных дней/);
    return m ? JSON.stringify({ result: 'found', fields: [{ key: 'delivery_term', value: `${m[1]} дней`, file: 'ТЗ.docx', page: 1, quote: m[0] }], risks: [], questions: [] }) : nothing;
  };
  const llm1 = scripted({ extract: answerFor, summary: summaryOf('участвовать') });
  const first = await analyzeDocs(v1, llm1, { maxChars: 130 });
  assert.equal(first.chunks.length, 2);
  const store = new Map(first.chunks.map((c) => [c.cache_key, { result: c.result }]));

  // заказчик изменил ТЗ: срок 3 дня. Контракт прежний.
  const v2 = [doc(1, 'ТЗ.docx', ['Срок поставки товара: 3 календарных дней с даты заключения контракта.']), v1[1]];
  const llm2 = scripted({ extract: answerFor, summary: summaryOf('участвовать') });
  const second = await analyzeDocs(v2, llm2, { maxChars: 130, chunkStore: { get: (k) => store.get(k) } });
  const sent = llm2.calls.filter((c) => c.task === 'extract');
  assert.equal(sent.length, 1, 'заново отправлен только изменившийся документ');
  assert.match(sent[0].user, /3 календарных дней/);
  assert.equal(field(second.card, 'delivery_term').value, '3 дней', 'значение прежней версии не подставлено');
  assert.equal(second.chunks.filter((c) => c.cached).length, 1);

  // версия файла — хеш содержимого: изменился текст — изменился хеш
  const [a] = await extractFile({ name: 'ТЗ.docx', buffer: makeDocx(['Срок поставки 10 дней']) }, 0, { ocr: noOcr, archiver: noArchiver });
  const [b] = await extractFile({ name: 'ТЗ.docx', buffer: makeDocx(['Срок поставки 3 дня']) }, 0, { ocr: noOcr, archiver: noArchiver });
  assert.notEqual(a.sha256, b.sha256);

  // цитата названа в одном файле, а есть только в другом — источник не подтверждён (раньше ссылка молча переносилась)
  const src = verifySource({ file: 'ТЗ.docx', page: 1, quote: 'Оплата в течение 7 рабочих дней' }, v1);
  assert.deepEqual([src.verified, src.mismatch, src.file, src.suggested.file], [false, 'other_file', 'ТЗ.docx', 'Контракт.docx']);
  // та же страница названа неверно в том же файле — исправляется, названная страница сохраняется
  const two = [doc(1, 'ТЗ.docx', ['Первая страница.', 'Гарантия 12 месяцев со дня поставки.'])];
  assert.deepEqual((({ verified, page, claimed_page }) => [verified, page, claimed_page])(verifySource({ file: 'ТЗ.docx', page: 1, quote: 'Гарантия 12 месяцев' }, two)), [true, 2, 1]);
});

// ---------- повторный проход через сервис ----------
test('«Повторить непрочитанные части»: сервис дочитывает нераспознанные страницы и не отправляет заново принятые фрагменты', async () => {
  const sent = [];
  const mock = createLlm('mock');
  const llmFactory = () => ({ ...mock, complete: async (args) => { if (args.task === 'extract') sent.push(args.messages[0].content); return mock.complete(args); } });
  const { s, api, config } = start({ LLM_MAX_CHARS_PER_CHUNK: 24000 }, llmFactory);
  try {
    // настоящий путь: файл на диске → извлечение → разбор. Распознавание в первом проходе «падает» на 3-й странице.
    const { PDFDocument } = require('pdf-lib');
    const base = await PDFDocument.load(await makePdf([['Объект закупки: поставка мониторов для нужд учреждения. Срок поставки товара: 10 календарных дней.'], ['Оплата в течение 7 рабочих дней после приёмки товара заказчиком.']]));
    await addScanPage(base);
    const dir = path.join(config.DATA_DIR, 'uploads', 'retry-test');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'Документация.pdf');
    fs.writeFileSync(file, Buffer.from(await base.save()));
    const textOf = () => 'Страница 3. Гарантийный срок на товар: не менее 36 месяцев со дня поставки.';
    const ext = { ocr: ocrOf(textOf, { failPages: [3] }), archiver: noArchiver };
    const { createAnalysisService } = require('../server/analyses-service');
    const svc = createAnalysisService({ repo: s.repo, uploadsDir: path.join(config.DATA_DIR, 'uploads'), maxChars: 24000, llmFactory, log: { log() {}, warn() {}, error() {} }, extractOpts: ext });
    const id = svc.startFromUploads({ id: svc.newId(), title: 'Повтор', files: [{ originalname: 'Документация.pdf', path: file }] });
    await svc.idle();
    let a = s.repo.getAnalysis(id);
    assert.equal(a.status, 'done');
    assert.deepEqual([a.files[0].coverage.status, a.files[0].coverage.unread.map((u) => [u.unit, u.reason])], ['partial', [[3, 'ocr_failed']]]);
    assert.deepEqual([a.card.decision.analysis_status, a.card.decision.decision_status], ['incomplete', 'preliminary']);
    assert.equal(a.card.meta.coverage.extract.pages_processed, 2);
    assert.equal(sent.length, 1);
    assert.equal((await api(`/api/analyses/${id}`)).body.card.meta.coverage.status, 'partial', 'отчёт о полноте отдаётся вместе с карточкой');

    // второй проход: распознавание исправно — дочитана страница 3; фрагмент изменился и отправлен заново
    ext.ocr = ocrOf(textOf);
    assert.equal(svc.retryUnread(id), true);
    await svc.idle();
    a = s.repo.getAnalysis(id);
    assert.deepEqual([a.status, a.files[0].coverage.status, a.files[0].coverage.processed], ['done', 'complete', 3]);
    assert.equal(a.card.meta.coverage.status, 'complete');
    assert.equal(a.card.meta.coverage.extract.pages_processed, 3);
    assert.match(s.repo.getFilePage(id, a.files[0].id, 3).text, /36 месяцев/);
    assert.equal(sent.length, 2);

    // третий проход: ничего не изменилось — нейросети по извлечению не отправляется ничего
    assert.equal(svc.retryUnread(id), true);
    await svc.idle();
    assert.equal(sent.length, 2, 'принятые фрагменты берутся из хранилища');
    assert.equal(s.repo.listChunks(id, 'extract').length, 1);

    // маршруты: повтор и отметка пробела
    assert.equal((await api('/api/analyses/нет-такого/retry', { method: 'POST' })).status, 404);
    assert.equal((await api(`/api/analyses/${id}/gaps`, { method: 'POST', json: { key: 'zzz' } })).status, 400);
    assert.equal((await api(`/api/analyses/${id}/gaps`, { method: 'POST', json: { key: 'abcdef012345' } })).status, 404);
  } finally { await s.close(); }
});

// ---------- пакет запросов у провайдера закончился ----------
test('у нейросети закончился оплаченный пакет (ответ 402): понятная причина, остальные фрагменты не отправляются, принятое сохраняется', async () => {
  const docs = [doc(1, 'a.pdf', ['Срок поставки товара: 10 календарных дней с даты заключения контракта. '.padEnd(120, 'а'), 'Вторая страница. '.padEnd(120, 'б'), 'Третья страница. '.padEnd(120, 'в')])];
  const good = JSON.stringify({ result: 'found', fields: [{ key: 'delivery_term', value: '10 дней', file: 'a.pdf', page: 1, quote: 'Срок поставки товара: 10 календарных дней' }], risks: [], questions: [] });
  const paid = new Error('gigachat.devices.sberbank.ru ответил 402: {"status":402,"message":"Payment Required"}');
  const llm = scripted({ extract: (u, { n }) => (n === 1 ? good : paid), summary: summaryOf('участвовать') });
  const { card, chunks } = await analyzeDocs(docs, llm, { maxChars: 200 });
  assert.equal(llm.calls.filter((c) => c.task === 'extract').length, 2, 'после отказа «нет оплаты» третий фрагмент не отправлялся и повтор не делался');
  assert.deepEqual(chunks.map((c) => [c.status, c.error_kind || null]), [['ok', null], ['failed', 'quota'], ['skipped', 'quota']]);
  assert.equal(field(card, 'delivery_term').status, 'found');
  assert.ok(card.meta.coverage.blocking.some((b) => /закончился оплаченный пакет/.test(b.text)));
  assert.deepEqual([card.decision.analysis_status, card.decision.participation_recommendation], ['incomplete', 'недостаточно данных']);
  // пакет закончился до первого же фрагмента — разбор не выполнен, причина названа простыми словами
  // пакет закончился до первого же фрагмента — разбор не падает: документацию читают правила, причина в предупреждениях
  const byRules = await analyzeDocs(docs, scripted({ extract: paid }), { maxChars: 200 });
  assert.equal(byRules.card.meta.reader, 'rules');
  assert.match(byRules.card.meta.warnings[0], /Нейросеть недоступна.*оплаченный пакет/);
  assert.match(field(byRules.card, 'delivery_term').value, /10 календарных дней/);
});

// ---------- одинаковые названия позиций ----------
test('позиции с одинаковым названием и количеством сопоставляются с ТЗ по характеристикам, а не по порядку', async () => {
  const { s } = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    const cart = 'Картридж для электрографических печатающих устройств';
    const colors = [['черный', 25000], ['голубой', 13000], ['пурпурный', 13000]];
    s.repo.saveItems(id, colors.map(([c, n]) => ({ name: cart, characteristics: [{ name: 'Цвет печати', value: c }, { name: 'Ресурс', value: `не менее ${n} страниц` }], quantity: 2, unit: 'шт', source: 'notification' })), { source: 'notification' });
    const aId = 'a-read-same-names';
    s.repo.createAnalysis({ id: aId, title: 'ТЗ' });
    // в ТЗ позиции идут в другом порядке
    const text = [colors[2], colors[0], colors[1]].map(([c, n]) => itemBlock(cart, 2, `Цвет печати: ${c}\nРесурс: не менее ${n} страниц`)).join('\n\n');
    s.repo.addFile(aId, { name: 'ТЗ.docx', status: 'ok', coverage: complete(1), pages: [{ page: 1, text }] });
    s.repo.finishAnalysis(aId, { card: { groups: [] }, provider: 'mock', model: 'm', durationMs: 0 });
    s.repo.setTenderAnalysis(id, aId);
    await s.details.ensureSpec(s.repo.getTender(id), { force: true });
    let checked = 0;
    for (const it of s.repo.getItems(id)) {
      const own = it.characteristics.find((c) => c.name === 'Цвет печати').value;
      const tz = (it.spec?.required || []).find((r) => /цвет/i.test(r.name))?.value;
      if (!tz) continue;
      checked++;
      assert.equal(String(tz).toLowerCase(), own, `позиции «${own}» не приклеены требования чужой позиции («${tz}»)`);
    }
    assert.ok(checked >= 2, 'требования ТЗ сопоставлены хотя бы с двумя позициями');
  } finally { await s.close(); }
});
