// Поиск поставщиков без нейросети (offers/rule-check.js): товар со страницы и сверка требований ТЗ правилами.

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchOffer } = require('../server/offers/match');
const { offerByRules } = require('../server/offers/rule-check');

test('сверка без нейросети: гель для УЗИ высокой вязкости 5 кг подходит, тюбик троксерутина 50 г — нет', async () => {
  const gel = { name: 'Гель местный контактный', characteristics: [{ name: 'Область применения', value: 'Для ультразвуковых исследований' }, { name: 'Степень вязкости', value: 'Высокая' }, { name: 'Масса', value: '5000 г' }] };
  const good = 'Гель для УЗИ Медиагель высокой вязкости, канистра 5 кг. Для ультразвуковых исследований. Масса 5000 г';
  assert.equal((await matchOffer(gel, { title: 'Гель для УЗИ Медиагель высокой вязкости', text: good })).match, 'соответствует');
  const bad = await matchOffer(gel, { title: 'Троксерутин гель 2%, 50 г', text: 'Троксерутин гель для наружного применения 2%, 50 г' });
  assert.equal(bad.match, 'не соответствует');
  assert.match(bad.notes[0], /нужно 5000 г, у товара 50 г/);
});

test('сверка без нейросети: «с 2-ой резинкой» — двойная резинка, «двойное дно» — два слоя, «40 мкр» — толщина в мкм; 30 мкм — не подходит', async () => {
  const item = { name: 'Бахилы водонепроницаемые', characteristics: [{ name: 'Двойная резинка', value: 'Да' }, { name: 'Количество слоев', value: '2 шт' }, { name: 'Длина', value: 'не менее 400 мм' }, { name: 'Толщина подошвы бахилы, мкм', value: 'не менее 40' }] };
  const two = 'Бахилы прочные бело-голубые с двойным дном (с 2-ой резинкой) в евроблоках (2500 шт.), 65 мкр';
  const one = 'Бахилы Прочные синие (с 2-ой резинкой) в евроблоках (2500 шт.), 40 мкр';
  const a = await matchOffer(item, { title: two, text: two });
  const b = await matchOffer(item, { title: one, text: one });
  assert.equal(a.checks.confirmed, 3, 'двойная резинка, два слоя, толщина');
  assert.equal(b.checks.confirmed, 2, 'без двойного дна два слоя не подтверждены');
  assert.equal(b.checks.rows.find((r) => r.name === 'Количество слоев').verdict, 'unknown');
  const thin = await matchOffer(item, { title: 'Бахилы одноразовые 30 мкм', text: 'Бахилы одноразовые 30 мкм' });
  assert.equal(thin.match, 'не соответствует');
  assert.equal(thin.checks.rows.find((r) => r.name === 'Количество слоев').verdict, 'unknown', 'число 30 не принимается за количество слоёв');
});

test('страница без разметки: название из заголовка, цена рядом с ним, а не из меню и не у похожих товаров', () => {
  const html = '<html><body><nav>Акция 990 ₽</nav><h1>Гель для УЗИ Медиагель 5 кг</h1><p>Цена: 1 250 ₽. В наличии.</p><div>Похожие: Гель 250 г — 199 ₽</div></body></html>';
  const text = 'Акция 990 ₽\nГель для УЗИ Медиагель 5 кг\nЦена: 1 250 ₽. В наличии.\nПохожие: Гель 250 г — 199 ₽';
  const o = offerByRules({ html, text });
  assert.deepEqual([o.title, o.price, o.availability], ['Гель для УЗИ Медиагель 5 кг', 1250, 'в наличии']);
  assert.equal(offerByRules({ html: '<h1>Гель</h1>', text: 'Гель без цены' }), null, 'нет цены — не предложение');
});

test('комплектующее вместо товара: в позиции «QNAP TS-133 (… WD40EFZZ)» диск WD40EFZZ — не сетевое хранилище', async () => {
  const item = { name: 'Сетевое хранилище (NAS) QNAP TS-133 (4TBWD Red Plus WD40EFZZ 3.5")', characteristics: [{ name: 'Диск', value: '4TB WD Red Plus WD40EFZZ' }] };
  const disk = await matchOffer(item, { title: '4TB WD Red Plus WD40EFZZ 3.5" 5400 RPM NAS Edition', text: '4TB WD Red Plus WD40EFZZ' });
  assert.equal(disk.match, 'не соответствует');
  assert.match(disk.notes[0], /комплектующее .* а не сам товар «TS-133»/);
  assert.notEqual((await matchOffer(item, { title: 'Сетевое хранилище QNAP TS-133 с диском WD40EFZZ', text: 'QNAP TS-133, диск WD40EFZZ' })).match, 'не соответствует');
});
