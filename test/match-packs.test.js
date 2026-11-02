// Сверка длинного ТЗ: все требования проверяются пачками, ни одно не теряется; сбой пачки не даёт полного соответствия.

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchOffer, packText, PACK_SIZE } = require('../server/offers/match');

const chars = (n) => Array.from({ length: n }, (_, i) => ({ name: `Свойство ${i + 1}`, value: 'есть' }));
// нейросеть отвечает «да» на всё, кроме названных общих номеров; fail — номера пачек без ответа
function packLlm({ no = [], fail = [] } = {}) {
  let call = 0;
  return { calls: () => call, retryDelayMs: 0, complete: async ({ messages }) => {
    const p = call++;
    if (fail.includes(p)) throw new Error('нет связи');
    const ask = JSON.parse(messages[messages.length - 1].content);
    const answers = Object.fromEntries(ask.required.characteristics.map((c) => [c.n, no.includes(Number(c.name.split(' ')[1])) ? 'нет: нету' : 'да: есть']));
    return { text: JSON.stringify({ kind: true, checks: answers }) };
  } };
}

for (const n of [46, 90, 160]) {
  test(`${n} требований: проверены все, вызовов нейросети — ${Math.ceil(n / PACK_SIZE)}`, async () => {
    const llm = packLlm();
    const r = await matchOffer({ name: 'Ноутбук', characteristics: chars(n) }, { title: 'Ноутбук', text: 'есть нету' }, { llm, system: 'm' });
    assert.equal(r.checks.total, n);
    assert.equal(r.checks.confirmed, n);
    assert.equal(r.match, 'соответствует');
    assert.equal(llm.calls(), Math.ceil(n / PACK_SIZE));
  });
}

test('160 требований: несоответствие только в последней пачке — товар не подходит', async () => {
  const r = await matchOffer({ name: 'Ноутбук', characteristics: chars(160) }, { title: 'Ноутбук', text: 'есть нету' }, { llm: packLlm({ no: [158] }), system: 'm' });
  assert.equal(r.match, 'не соответствует');
  assert.equal(r.checks.failed, 1);
  assert.equal(r.checks.rows[157].verdict, 'no');
});

test('90 требований: на одну пачку нейросеть не ответила — не «соответствует», причина видна', async () => {
  // callJson повторяет запрос один раз — пачка 2 (вызовы 2 и 3) падает оба раза
  const r = await matchOffer({ name: 'Ноутбук', characteristics: chars(90) }, { title: 'Ноутбук', text: 'есть' }, { llm: packLlm({ fail: [1, 2] }), system: 'm' });
  assert.notEqual(r.match, 'соответствует');
  assert.equal(r.checks.packs_failed, 1);
  assert.ok(r.checks.rows.some((x) => /не ответила/.test(x.found)));
});

test('длинный текст: для пачки берутся места, где говорится о её требованиях, — в том числе из конца паспорта', () => {
  const text = `Начало страницы. ${'шум '.repeat(3000)} Раздел интерфейсов: Видеовыход DisplayPort 1.4 через USB-C.`;
  const out = packText(text, [{ name: 'Видеовыход' }]);
  assert.ok(out.length <= 9100);
  assert.match(out, /DisplayPort 1\.4/);
});
