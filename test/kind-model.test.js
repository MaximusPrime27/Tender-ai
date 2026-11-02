const test = require('node:test');
const assert = require('node:assert/strict');
const { buildKindModel, checkKind, setKindModel } = require('../server/offers/kind-model');
const { matchOffer, priceBelowContracts } = require('../server/offers/match');

const rows = [];
const add = (name, ktru, n = 3) => { for (let i = 0; i < n; i++) rows.push({ name, ktru_code: ktru }); };
add('Комплект для переливания крови, не обменный', '32.50.13.190-00022');
add('Система для переливания крови', '32.50.13.190-00022');
add('Система инфузионная', '32.50.13.190-00031');
add('Набор для внутривенных вливаний инфузионный', '32.50.13.190-00031');
add('Система инфузионная с иглой', '32.50.13.190-00032');
add('Катетер инфузионный', '32.50.13.190-00033');
add('Игла для забора крови, стандартная', '32.50.13.110-00005');
add('Наконечник для дозатора', '32.50.50.000-00011');
add('Трубка эндотрахеальная', '32.50.13.110-00077');
add('Трубка эндотрахеальная с манжетой', '32.50.13.110-00077');
add('Трубка трахеостомическая', '32.50.13.110-00078');
add('Трубка назогастральная', '32.50.13.110-00079');
add('Изделия медицинские, в том числе хирургические', '32.50.50.190-00001');
const model = buildKindModel(rows);
const transfusion = { name: 'Комплект для переливания крови, не обменный', ktru_code: '32.50.13.190-00022' };

test('вид товара: капельница к комплекту для переливания крови — другой товар, с объяснением', () => {
  const r = checkKind(model, transfusion, { title: 'Система Инфузионная с иглой 21G / 0,8х40' });
  assert.equal(r.verdict, 'other');
  assert.match(r.why, /кров/);
});

test('вид товара: синоним того же вида и верное назначение проходят', () => {
  assert.equal(checkKind(model, transfusion, { title: 'Система для переливания крови ПК 21-02' }).verdict, 'same');
  assert.equal(checkKind(model, { name: 'Игла для забора крови, стандартная', ktru_code: '32.50.13.110-00005' }, { title: 'Игла двусторонняя 21G для забора крови' }).verdict, 'same');
});

test('вид товара: общее название позиции и отсутствие модели — судить не по чему', () => {
  assert.equal(checkKind(model, { name: 'Изделия медицинские, в том числе хирургические', ktru_code: '32.50.50.190-00001' }, { title: 'Трубка эндотрахеальная' }).verdict, 'unknown');
  assert.equal(checkKind(null, transfusion, { title: 'что угодно' }).verdict, 'unknown');
});

test('сверка: в медицине другой вид — «не соответствует», режим наблюдения решения не меняет', async () => {
  setKindModel(model);
  try {
    const offer = { title: 'Система инфузионная с иглой 21G', price: 15 };
    const on = await matchOffer(transfusion, offer, { offline: true, kindMode: 'on' });
    assert.equal(on.match, 'не соответствует');
    assert.ok(on.notes.some((n) => /другой товар/.test(n)));
    const before = await matchOffer(transfusion, offer, { offline: true, kindMode: 'off' });
    const watch = await matchOffer(transfusion, offer, { offline: true, kindMode: 'shadow' });
    assert.equal(watch.match, before.match);
    assert.equal(watch.checks.kind.verdict, 'other');
  } finally { setKindModel(null); }
});

test('сверка: вне медицины другой вид только записывается', async () => {
  const m = buildKindModel(rows.map((r) => ({ ...r, ktru_code: r.ktru_code.replace('32.50', '26.20') })));
  setKindModel(m);
  try {
    const item = { ...transfusion, ktru_code: '26.20.13.190-00022' };
    const r = await matchOffer(item, { title: 'Система инфузионная с иглой 21G', price: 15 }, { offline: true, kindMode: 'on' });
    assert.equal(r.checks.kind.verdict, 'other');
    assert.equal(r.match, (await matchOffer(item, { title: 'Система инфузионная с иглой 21G', price: 15 }, { offline: true, kindMode: 'off' })).match);
  } finally { setKindModel(null); }
});

test('цена вдвое ниже прошлых контрактов — подозрительна, при малом числе контрактов судить не по чему', () => {
  assert.equal(priceBelowContracts(15, [20, 37, 54, 40]).median, 40);
  assert.equal(priceBelowContracts(25, [20, 37, 54, 40]), null);
  assert.equal(priceBelowContracts(15, [40, 50]), null);
});

test('обучение: отвергнутый человеком товар становится ошибкой, верные названия контрактов — своими', () => {
  const { checkKind: ck, buildKindModel: bm } = require('../server/offers/kind-model');
  const r2 = [...rows];
  const add2 = (name, ktru, n = 3) => { for (let i = 0; i < n; i++) r2.push({ name, ktru_code: ktru }); };
  add2('Минтай свежий или охлажденный', '10.20.13.110-00002');
  add2('Минтай мороженый', '10.20.13.110-00002');
  const fish = { name: 'Минтай свежий или охлажденный', ktru_code: '10.20.13.110-00002' };
  assert.equal(ck(bm(r2), fish, { title: 'Икра минтая, 125 г' }).verdict, 'unknown');
  const learned = bm(r2, [{ item_name: fish.name, ktru_code: fish.ktru_code, title: 'Икра минтая соленая', verdict: 'wrong' }]);
  assert.equal(ck(learned, fish, { title: 'Икра минтая, 125 г' }).verdict, 'other');
  const bandage = { name: 'Трубка трахеостомическая', ktru_code: '32.50.13.110-00078' };
  const ex = [1, 2].map(() => ({ item_name: bandage.name, ktru_code: bandage.ktru_code, title: 'Канюля трахеостомическая', verdict: 'right' }));
  assert.ok(bm(rows, ex).kinds.get(bm(rows, ex).find('k:32.50.13.110-00078')).all.has('канюл'));
});

test('запрос по виду: без размеров и только для медицины', () => {
  const { kindQuery } = require('../server/offers/kind-model');
  assert.match(kindQuery(model, transfusion), /для переливания крови купить$/);
  assert.equal(kindQuery(model, { name: 'Телевизор', ktru_code: '26.40.33.110' }), null);
});
