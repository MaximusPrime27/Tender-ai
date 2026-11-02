const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { analyzeDocs } = require('../server/analyze');
const { buildChunks, parseChunk } = require('../server/analyze/chunk');
const { createLlm } = require('../server/llm');
const { extractFile } = require('../server/extract');
const { toMarkdown } = require('../server/analyze/export');
const { makePdf, makeDocx, NOTICE_PAGES, CONTRACT, TZ } = require('../samples/make-samples');

const field = (card, key) => card.groups.flatMap((g) => g.fields).find((f) => f.key === key);

async function sampleDocs() {
  const zip = new AdmZip();
  zip.addFile('Извещение.pdf', await makePdf(NOTICE_PAGES));
  zip.addFile('Проект_контракта.docx', makeDocx(CONTRACT));
  zip.addFile('ТЗ.docx', makeDocx(TZ));
  for (const e of zip.getEntries()) e.header.flags |= 0x800;
  const files = await extractFile({ name: 'sample-44fz.zip', buffer: zip.toBuffer() });
  return files.map((f, i) => ({ ...f, id: i + 1 }));
}

/** LLM с заданными ответами по задачам. */
function fakeLlm(byTask) {
  return {
    provider: 'fake', model: 'fake',
    async complete({ task, retry }) {
      const a = byTask[task];
      return { text: typeof a === 'function' ? a({ retry }) : a, usage: { in: 1, out: 1 } };
    },
  };
}

test('чанки сохраняют разметку файл+страница и не превышают лимит', () => {
  const docs = [{ name: 'a.pdf', status: 'ok', pages: [{ page: 1, text: 'x'.repeat(1500) }, { page: 2, text: 'y'.repeat(1500) }] }];
  const chunks = buildChunks(docs, 2000);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.length <= 2000));
  assert.deepEqual(parseChunk(chunks[1]).map((p) => [p.file, p.page]), [['a.pdf', 2]]);
});

test('mock: на эталонном комплекте пойманы все 4 заложенных риска, цитаты подтверждены', async () => {
  const { card } = await analyzeDocs(await sampleDocs(), createLlm('mock'), { maxChars: 24000 });
  const types = card.risks.map((r) => r.type);
  assert.ok(types.includes('противоречие_в_документации'), 'разный срок поставки');
  assert.ok(types.includes('жёсткие_штрафы'), 'пени 0,5%');
  assert.ok(types.includes('долгая_оплата'), 'оплата 30 рабочих дней');
  assert.ok(types.includes('заточка_под_поставщика'), 'товарный знак без эквивалента');

  const delivery = field(card, 'delivery_term');
  assert.equal(delivery.conflict, true);
  assert.equal(delivery.alternatives.length, 2);

  assert.equal(field(card, 'advance').status, 'found');
  const allSources = [
    ...card.groups.flatMap((g) => g.fields.flatMap((f) => f.sources)),
    ...card.risks.flatMap((r) => r.sources),
  ];
  assert.ok(allSources.length > 20);
  assert.ok(allSources.every((s) => s.verified && s.fileId), 'все цитаты mock берутся из текста');
  assert.ok(card.summary.recommendation.value);
});

test('противоречащие значения из разных документов не схлопываются, а становятся риском', async () => {
  const docs = [
    { id: 1, name: 'Извещение.pdf', status: 'ok', pages: [{ page: 1, text: 'Срок поставки: 10 календарных дней с даты заключения контракта.' }] },
    { id: 2, name: 'Контракт.docx', status: 'ok', pages: [{ page: 1, text: 'Срок поставки: 30 календарных дней с даты заключения контракта.' }] },
  ];
  // Каждый документ в своём чанке — как бывает с длинной документацией.
  let n = 0;
  const llm = fakeLlm({
    extract: () => {
      n++;
      const d = docs[(n - 1) % 2];
      return JSON.stringify({ fields: [{ key: 'delivery_term', value: d.pages[0].text.slice(15, 40), file: d.name, page: 1, quote: d.pages[0].text }], risks: [], questions: [] });
    },
    resolve: JSON.stringify({ results: [{ key: 'delivery_term', contradiction: true, value: '10 дней', explanation: 'В извещении 10 дней, в контракте 30.' }] }),
    summary: JSON.stringify({ summary: 's', recommendation: 'участвовать с оговорками', reasons: ['r'] }),
  });
  const { card } = await analyzeDocs(docs, llm, { maxChars: 120 });
  assert.equal(card.meta.chunks, 2);
  const f = field(card, 'delivery_term');
  assert.equal(f.conflict, true);
  const risk = card.risks.find((r) => r.type === 'противоречие_в_документации');
  assert.ok(risk);
  assert.equal(risk.level, 'high');
  assert.equal(risk.explanation, 'В извещении 10 дней, в контракте 30.');
  assert.deepEqual(risk.sources.map((s) => s.file).sort(), ['Извещение.pdf', 'Контракт.docx']);
});

test('разные формулировки одного значения сводятся в одно поле без риска', async () => {
  const docs = [
    { id: 1, name: 'a.pdf', status: 'ok', pages: [{ page: 1, text: 'НМЦК 1 250 000,00 рублей.' }, { page: 2, text: 'Цена контракта один миллион двести пятьдесят тысяч рублей.' }] },
  ];
  const llm = fakeLlm({
    extract: JSON.stringify({ fields: [
      { key: 'nmck', value: '1 250 000,00 руб.', file: 'a.pdf', page: 1, quote: 'НМЦК 1 250 000,00 рублей' },
      { key: 'nmck', value: 'один миллион двести пятьдесят тысяч рублей', file: 'a.pdf', page: 2, quote: 'один миллион двести пятьдесят тысяч рублей' },
    ], risks: [], questions: [] }),
    resolve: JSON.stringify({ results: [{ key: 'nmck', contradiction: false, value: '1 250 000,00 руб.' }] }),
    summary: JSON.stringify({ summary: 's', recommendation: 'участвовать', reasons: [] }),
  });
  const { card } = await analyzeDocs(docs, llm, { maxChars: 24000 });
  const f = field(card, 'nmck');
  assert.equal(f.conflict, undefined);
  assert.equal(f.value, '1 250 000,00 руб.');
  assert.equal(f.sources.length, 2);
  assert.equal(card.risks.length, 0);
});

test('невалидный ответ по чанку → поля extraction_failed, анализ не падает', async () => {
  const docs = [{ id: 1, name: 'a.pdf', status: 'ok', pages: [{ page: 1, text: 'a'.repeat(100) }, { page: 2, text: 'Срок поставки 10 дней с даты заключения.' }] }];
  let calls = 0;
  const llm = fakeLlm({
    extract: () => {
      calls++;
      // первый чанк — мусор дважды (с повтором), второй — нормально
      if (calls <= 2) return 'не JSON';
      return JSON.stringify({ fields: [{ key: 'delivery_term', value: '10 дней', file: 'a.pdf', page: 2, quote: 'Срок поставки 10 дней' }], risks: [], questions: [] });
    },
    summary: 'снова не JSON',
  });
  const { card } = await analyzeDocs(docs, llm, { maxChars: 150 });
  assert.equal(card.meta.failedChunks, 1);
  assert.equal(field(card, 'delivery_term').status, 'found');
  assert.equal(field(card, 'nmck').status, 'extraction_failed');
  assert.equal(card.summary.status, 'extraction_failed');
  assert.ok(card.meta.warnings.length >= 2);
});

test('нет читаемых файлов → понятная ошибка', async () => {
  const docs = [{ id: 1, name: 'x.rar', status: 'unsupported', message: 'RAR', pages: [] }];
  await assert.rejects(analyzeDocs(docs, createLlm('mock'), { maxChars: 1000 }), /Ни один файл не удалось прочитать/);
});

test('экспорт в Markdown содержит поля, риски и вопросы', async () => {
  const { card } = await analyzeDocs(await sampleDocs(), createLlm('mock'), { maxChars: 24000 });
  const md = toMarkdown({ title: 'Тест', created_at: new Date().toISOString(), provider: 'mock', model: 'rules-v1', duration_ms: 100, card });
  assert.match(md, /^# Тест/);
  assert.match(md, /\| НМЦК \| .*1 250 000,00/);
  assert.match(md, /## Риски/);
  assert.match(md, /заточка под поставщика/);
  assert.match(md, /## Вопросы для запроса разъяснений/);
});

test('промпты лежат в отдельных файлах', () => {
  for (const name of ['extract', 'resolve', 'summary']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'server', 'analyze', 'prompts', `${name}.md`)));
  }
});
