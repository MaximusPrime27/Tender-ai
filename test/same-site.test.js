// Добор на сайте (offers/same-site.js): товар подошёл не во всём — на этом же сайте берём соседние товары с тем,
// чего не хватило.

const test = require('node:test');
const assert = require('node:assert/strict');
const { wantedStems, sameSiteLinks } = require('../server/offers/same-site');

test('гель средней вязкости вместо высокой — со страницы берётся «высокой вязкости» того же сайта, чужие сайты и другой товар — нет', () => {
  const offer = { match_checks: { rows: [{ name: 'Область применения', need: 'Для ультразвуковых исследований', verdict: 'yes' }, { name: 'Степень вязкости', need: 'Высокая', verdict: 'no' }] } };
  const html = '<a href="/catalog/gel-srednei">Гель для УЗИ Медиагель средней вязкости 5 кг 820 ₽</a>'
    + '<a href="/catalog/gel-vysokoi">Гель для УЗИ Медиагель высокой вязкости 5 кг 990 ₽</a>'
    + '<a href="/catalog/krem">Крем для рук высокой вязкости 300 ₽</a>'
    + '<a href="https://other.ru/catalog/gel">Гель высокой вязкости другого магазина</a>';
  const links = sameSiteLinks(html, 'https://shop.ru/catalog/gel-srednei', { name: 'Гель местный контактный' }, wantedStems(offer));
  assert.deepEqual(links.map((l) => [l.url, l.price]), [['https://shop.ru/catalog/gel-vysokoi', 990]]);
});

test('бахилы: «двойная резинка» и «2 слоя» не подтверждены — первыми бахилы с двойным дном и 2-ой резинкой', () => {
  const offer = { match_checks: { rows: [{ name: 'Двойная резинка', need: 'Да', verdict: 'unknown' }, { name: 'Количество слоев', need: '2 шт', verdict: 'unknown' }, { name: 'Длина', need: 'не менее 400 мм', verdict: 'unknown' }] } };
  const html = '<a href="/product/bahily-sinie">Бахилы синие с 2-ой резинкой 40 мкр</a><a href="/product/bahily-dno">Бахилы прочные с двойным дном (с 2-ой резинкой) 65 мкр</a><a href="/product/odnosloinye">Бахилы одноразовые однослойные</a>';
  const links = sameSiteLinks(html, 'https://b.ru/product/bahily-1', { name: 'Бахилы водонепроницаемые' }, wantedStems(offer));
  assert.deepEqual(links.map((l) => l.url), ['https://b.ru/product/bahily-dno', 'https://b.ru/product/bahily-sinie']);
  assert.deepEqual(sameSiteLinks(html, 'https://b.ru/x', { name: 'Бахилы' }, []), [], 'чего искать — неизвестно: ничего не берём');
});
