// Сверка с ТЗ: «соответствует» — только когда подтверждено каждое обязательное требование,
// и каждое подтверждение опирается на то, что действительно написано на странице.

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchOffer, judge } = require('../server/offers/match');

const llm = (checks) => ({ complete: async () => ({ text: JSON.stringify({ kind: true, checks }) }) });

test('обязательная сверка: 80% требований — ещё не «соответствует»', async () => {
  const characteristics = Array.from({ length: 5 }, (_, i) => ({ name: `Feature ${i}`, value: 'есть' }));
  const result = await matchOffer({ name: 'Коммутатор', characteristics },
    { title: 'Коммутатор', text: 'Feature 0 есть Feature 1 есть Feature 2 есть Feature 3 есть' },
    { llm: llm({ 1: 'да: есть', 2: 'да: есть', 3: 'да: есть', 4: 'да: есть', 5: '?' }), system: 'match' });
  assert.notEqual(result.match, 'соответствует');
  assert.equal(result.checks.unknown, 1);
});

test('обязательная сверка: без нейросети подошедшие числа не закрывают текстовые требования', async () => {
  const result = await matchOffer({ name: 'Системный блок', characteristics: [
    { name: 'Количество ядер процессора', value: 'не менее 4' },
    { name: 'Гарантия', value: 'три года' },
  ] }, { title: 'Системный блок', text: 'Процессор 8 ядер' });
  assert.notEqual(result.match, 'соответствует');
  // только числа, и все подошли — без нейросети этого достаточно
  const numeric = await matchOffer({ name: 'Системный блок', characteristics: [{ name: 'Количество ядер процессора', value: 'не менее 4' }] },
    { title: 'Системный блок', text: 'Процессор 8 ядер' });
  assert.equal(numeric.match, 'соответствует');
  assert.ok(numeric.notes.every((n) => typeof n === 'string' && n), 'в примечаниях нет пустых строк');
});

test('обязательная сверка: подтверждены все требования — «соответствует»', async () => {
  const result = await matchOffer({ name: 'Коммутатор', characteristics: [{ name: 'Feature', value: 'есть' }] },
    { title: 'Коммутатор', text: 'Feature есть' }, { llm: llm({ 1: 'да: есть' }), system: 'match' });
  assert.equal(result.match, 'соответствует');
});

test('обязательная сверка: ответ «да» без слов со страницы требование не подтверждает', async () => {
  const r = await matchOffer({ name: 'Коммутатор', characteristics: [{ name: 'Протокол', value: 'OSPF' }] },
    { title: 'Коммутатор', text: 'Только RIP' }, { llm: llm({ 1: 'да: OSPF' }), system: 'match' });
  assert.notEqual(r.match, 'соответствует');
});

test('обязательная сверка: требования из ТЗ дополняют характеристики извещения', async () => {
  const r = await matchOffer({ name: 'Коммутатор', characteristics: [{ name: 'Feature', value: 'есть' }],
    spec: { required: [{ name: 'Протокол', value: 'OSPF' }], identity: {} } },
    { title: 'Коммутатор', text: 'Feature есть' }, { llm: llm({ 1: '?', 2: 'да: есть' }), system: 'match' });
  assert.notEqual(r.match, 'соответствует');
  assert.equal(r.checks.total, 2);
});

test('обязательная сверка: модель из ТЗ совпала, но одно требование не подтверждено — в расчёт сам не идёт', async () => {
  const r = await matchOffer({ name: 'Картридж HP CF259X', characteristics: [{ name: 'Цвет', value: 'чёрный' }, { name: 'Ресурс', value: 'не менее 10000 стр' }] },
    { title: 'Картридж HP CF259X', text: 'Картридж HP CF259X, цвет чёрный' }, { llm: llm({ 1: 'да: чёрный', 2: '?' }), system: 'match' });
  assert.equal(r.match, 'частично');
  assert.deepEqual([r.checks.confirmed, r.checks.unknown], [1, 1]);
});

test('обязательная сверка: число ищется на странице целиком, знак препинания после него не мешает', () => {
  const nums = { ok: [], fail: [], unknown: [] };
  const verdict = (need, page, answer) => judge([{ name: 'Требование', value: need }], { 1: answer }, nums, page).rows[0].verdict;
  // нейросеть добавила слово («24 порта»), а на странице после числа — точка или запятая
  assert.equal(verdict('не менее 24', 'Количество портов: 24.', 'да: 24 порта'), 'yes');
  assert.equal(verdict('не менее 24', 'Портов 24, питание PoE', 'да: 24 порта'), 'yes');
  assert.equal(verdict('не менее 3.5', 'Форм-фактор 3,5 дюйма.', 'да: 3.5"'), 'yes');
  // кусок другого числа — не подтверждение
  assert.equal(verdict('менее 200 мм', '16 ГБ DDR4 3200 МГц', 'да: 200'), 'unknown');
  assert.equal(verdict('не менее 24', 'Диагональ 24.5 дюйма', 'да: 24 дюйма'), 'unknown');
  assert.equal(verdict('не менее 24', 'Версия прошивки 1.24', 'да: 24 порта'), 'unknown');
  // обозначение — только целиком
  assert.equal(verdict('DDR4', 'Память DDR4-2666', 'да: DDR4'), 'yes');
  assert.equal(verdict('DDR4', 'Память DDR3, 4 ГБ', 'да: DDR4'), 'unknown');
  // «да» без значения и противоречие дословно
  assert.equal(verdict('есть', 'Поддержка VLAN есть', 'да'), 'unknown');
  assert.equal(verdict('чёрно-белая', 'Цветность печати: цветная', 'нет: цветная'), 'no');
});

test('обязательная сверка: прежнее «соответствует» с неполной сверкой само в расчёт не идёт', () => {
  const { isEligible } = require('../server/offers/rank');
  assert.equal(isEligible({ source: 'yandex', unit_price: 100, match: 'соответствует',
    match_checks: { confirmed: 4, total: 5, of: 5, unknown: 1, failed: 0 } }), false);
  assert.equal(isEligible({ source: 'yandex', unit_price: 100, match: 'соответствует',
    match_checks: { confirmed: 5, total: 5, of: 5, unknown: 0, failed: 0 } }), true);
  // проверены первые 45 из 60 требований — остаток не проверен, значит, не подтверждён
  assert.equal(isEligible({ source: 'yandex', unit_price: 100, match: 'соответствует',
    match_checks: { confirmed: 45, total: 45, of: 60, unknown: 0, failed: 0 } }), false);
  for (const price of [0, -1, NaN, Infinity]) {
    assert.equal(isEligible({ source: 'yandex', unit_price: price, match: 'соответствует' }), false);
  }
});
