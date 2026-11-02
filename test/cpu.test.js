// Процессор ноутбука/компьютера по справочнику: сверка ядер, потоков, кэша, TDP и подбор процессоров для поиска.

const test = require('node:test');
const assert = require('node:assert/strict');
const { cpuOf, applyCpu, suitableCpus } = require('../server/offers/cpu');
const { fitsNumeric } = require('../server/offers/match');
const { specQueries } = require('../server/offers/sources/yandex-search');

const tz = [
  { name: 'Количество ядер процессора', value: '≥ 10 (Штука)' },
  { name: 'Количество потоков процессора', value: '≥ 12 (Штука)' },
  { name: 'Объем кэш памяти третьего уровня процессора (L3)', value: '≥ 10 (Мегабайт)' },
  { name: 'Тепловыделение процессора', value: '≤ 15 (Ватт)' },
];
const rows = () => tz.map((r) => ({ name: r.name, need: r.value, verdict: 'unknown', found: '' }));

test('процессор в названии: Intel и AMD; «5600» без Ryzen — не процессор', () => {
  assert.equal(cpuOf('Ноутбук HONOR Magicbook X14/Core i5 13420H/16/1 Tb').label, 'Intel Core i5-13420H');
  assert.equal(cpuOf('ASUS VivoBook Go 15 AMD Ryzen 5 7520U/8GB').label, 'AMD Ryzen 5 7520U');
  assert.equal(cpuOf('Блок питания 5600 мАч'), null);
});

test('сверка по справочнику: i5-1235U подходит по всем четырём, Ryzen 5 7520U — не подходит (факт справочника)', () => {
  const a = rows();
  applyCpu(a, 'Ноутбук Lenovo V15 i5-1235U', '', { fitsNumeric });
  assert.deepEqual(a.map((r) => r.verdict), ['yes', 'yes', 'yes', 'yes']);
  assert.match(a[0].method, /справочник процессоров: Intel Core i5-1235U/);
  const b = rows();
  applyCpu(b, 'Ноутбук ASUS Ryzen 5 7520U', '', { fitsNumeric });
  assert.deepEqual(b.map((r) => r.verdict), ['no', 'no', 'no', 'yes'], 'кэш 4 МБ при нужных «≥ 10 (Мегабайт)» — не подходит');
});

test('подбор процессоров под ТЗ и запрос к поиску по ним', () => {
  const list = suitableCpus(tz, 'mobile', { fitsNumeric }).map((c) => c.model);
  assert.ok(list.includes('i5-1235U') && !list.includes('7520U') && !list.includes('i5-12450H'), list.join(','));
  const q = specQueries({ name: 'Ноутбук' }, { name: 'Ноутбук', identity: {}, required: [...tz, { name: 'Общий объем установленной оперативной памяти', value: '≥ 16 (Гигабайт)' }, { name: 'Объем SSD накопителя', value: '≥ 480 (Гигабайт)' }, { name: 'Предустановленная операционная система', value: 'Нет' }] }, 2);
  assert.equal(q[0], 'Ноутбук Intel Core i5-1235U 16 ГБ 512 ГБ SSD без ОС купить');
});

test('единица в скобках, как в ТЗ из ЕИС: «≥ 16 (Гигабайт)» против «8 GB» — не подходит', () => {
  assert.equal(fitsNumeric('≥ 16 (Гигабайт)', '8 GB'), false);
  assert.equal(fitsNumeric('≥ 16 (Гигабайт)', '16 GB'), true);
});
