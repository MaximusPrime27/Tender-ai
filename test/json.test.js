const test = require('node:test');
const assert = require('node:assert/strict');
const { callJson, ExtractSchema, SummarySchema, ExtractionFailed, parseJsonText } = require('../server/analyze/json');

/** LLM, которая по очереди отдаёт заранее заданные ответы и запоминает запросы. */
function scriptedLlm(answers) {
  const calls = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      return { text: answers[calls.length - 1], usage: { in: 10, out: 5 } };
    },
  };
}

const good = JSON.stringify({ fields: [{ key: 'nmck', value: '1 250 000 руб.', file: 'a.pdf', page: 1, quote: 'цена контракта' }] });

test('валидный JSON принимается с первой попытки', async () => {
  const llm = scriptedLlm([good]);
  const { data, usage } = await callJson(llm, { system: 's', user: 'u', schema: ExtractSchema });
  assert.equal(llm.calls.length, 1);
  assert.equal(data.fields[0].key, 'nmck');
  assert.deepEqual(data.risks, []);
  assert.deepEqual(usage, { in: 10, out: 5 });
});

test('JSON в ```-ограде и с текстом вокруг разбирается', () => {
  assert.deepEqual(parseJsonText('Вот ответ:\n```json\n{"a": 1}\n```'), { a: 1 });
});

test('кривой JSON → одна повторная попытка с текстом ошибки → успех', async () => {
  const llm = scriptedLlm(['{"fields": [ {"key": "nmck", ', good]);
  const { data, usage } = await callJson(llm, { system: 's', user: 'u', schema: ExtractSchema });
  assert.equal(llm.calls.length, 2);
  const retryMsg = llm.calls[1].messages.at(-1).content;
  assert.match(retryMsg, /Невалидный JSON/);
  assert.equal(llm.calls[1].messages[1].role, 'assistant');
  assert.equal(data.fields.length, 1);
  assert.deepEqual(usage, { in: 20, out: 10 });
});

test('несоответствие схеме тоже вызывает повтор с описанием ошибки', async () => {
  const llm = scriptedLlm(['{"summary": "x", "recommendation": "может быть"}', '{"summary": "x", "recommendation": "участвовать", "reasons": []}']);
  const { data } = await callJson(llm, { system: 's', user: 'u', schema: SummarySchema });
  assert.match(llm.calls[1].messages.at(-1).content, /recommendation/);
  assert.equal(data.recommendation, 'участвовать');
});

test('две неудачи подряд → ExtractionFailed, без третьего вызова', async () => {
  const llm = scriptedLlm(['мусор', 'опять мусор', good]);
  await assert.rejects(
    callJson(llm, { system: 's', user: 'u', schema: ExtractSchema }),
    (err) => err instanceof ExtractionFailed && err.usage.in === 20,
  );
  assert.equal(llm.calls.length, 2);
});

test('неизвестные поля отбрасываются, неизвестный тип риска → «другое»', async () => {
  const llm = scriptedLlm([JSON.stringify({
    fields: [{ key: 'unknown_field', value: 'x', file: 'a', page: 1, quote: 'q' }],
    risks: [{ type: 'странный', level: 'critical', explanation: 'e', file: 'a', page: '2', quote: 'q' }],
  })]);
  const { data } = await callJson(llm, { system: 's', user: 'u', schema: ExtractSchema });
  assert.equal(data.fields.length, 0);
  assert.equal(data.risks[0].type, 'другое');
  assert.equal(data.risks[0].level, 'medium');
  assert.equal(data.risks[0].page, 2);
});
