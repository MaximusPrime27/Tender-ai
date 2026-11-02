// Карточка товара у поставщика: фото, характеристики, запрос по товару из госконтракта.

const test = require('node:test');
const assert = require('node:assert/strict');
const { imageFromPage, specsFromPage, specsFromChars, brandOfLine, productQueryOfLine } = require('../server/offers/product');
const { extractStructured, htmlToText } = require('../server/offers/fetch-page');
const { extractOffer } = require('../server/offers/extract');

const PAGE = `<html><head>
  <meta property="og:image" content="/img/panel-75.jpg">
  <script type="application/ld+json">{"@type":"Product","name":"Интерактивная панель EXELLTECH 75","brand":{"name":"EXELLTECH"},"mpn":"EX-75U",
    "image":["https://cdn.shop.ru/p/ex75.jpg"],
    "additionalProperty":[{"name":"Диагональ","value":"75\\""},{"name":"Разрешение","value":"3840x2160"},{"name":"ОС","value":"Android 13"}],
    "offers":{"@type":"Offer","price":"189000","priceCurrency":"RUB","availability":"https://schema.org/InStock"}}</script>
  </head><body><h1>Интерактивная панель EXELLTECH 75</h1></body></html>`;

test('со страницы магазина: фото, характеристики, производитель и модель — из разметки', async () => {
  const structured = extractStructured(PAGE, 'https://shop.ru/p/ex75');
  assert.equal(structured[0].image, 'https://cdn.shop.ru/p/ex75.jpg');
  assert.deepEqual(structured[0].props.map((p) => p.name), ['Диагональ', 'Разрешение', 'ОС']);
  const offer = await extractOffer({ url: 'https://shop.ru/p/ex75', html: PAGE, text: htmlToText(PAGE), structured }, { name: 'Интерактивная панель', characteristics: [] });
  assert.equal(offer.price, 189000);
  assert.equal(offer.image_url, 'https://cdn.shop.ru/p/ex75.jpg');
  assert.equal(offer.specs.length, 3);
  assert.equal(offer.brand, 'EXELLTECH');
  assert.equal(offer.model, 'EX-75U');
});

test('без разметки: фото из og:image, характеристики из таблицы; логотип и случайные таблицы не берутся', () => {
  assert.equal(imageFromPage(PAGE, 'https://shop.ru/p/1', null), 'https://shop.ru/img/panel-75.jpg');
  assert.equal(imageFromPage('<meta property="og:image" content="https://s.ru/logo.png">', 'https://s.ru/', null), null);
  assert.equal(imageFromPage('<p>нет</p>', 'https://s.ru/', null), null);
  const html = `<table><tr><th>Диагональ</th><td>75 дюймов</td></tr><tr><td>Разрешение:</td><td><b>3840x2160</b></td></tr>
    <tr><td>Яркость</td><td>400 кд/м2</td></tr></table><dl><dt>Гарантия</dt><dd>36 мес.</dd></dl>`;
  assert.deepEqual(specsFromPage(html), [
    { name: 'Диагональ', value: '75 дюймов' }, { name: 'Разрешение', value: '3840x2160' },
    { name: 'Яркость', value: '400 кд/м2' }, { name: 'Гарантия', value: '36 мес.' },
  ]);
  assert.deepEqual(specsFromPage('<table><tr><td>Понедельник</td><td>9–18</td></tr></table>'), [], 'меньше трёх пар — не характеристики');
});

test('товар из госконтракта: характеристики, производитель и запрос для поиска в магазинах', () => {
  assert.deepEqual(specsFromChars('Диагональ: 75; Разрешение: 3840x2160; мусор'), [{ name: 'Диагональ', value: '75' }, { name: 'Разрешение', value: '3840x2160' }]);
  assert.equal(brandOfLine('Интерактивная панель. Товарный знак: EXELLTECH'), 'EXELLTECH');
  assert.equal(brandOfLine('Интерактивная панель. Товарный знак: отсутствует'), null);
  assert.equal(productQueryOfLine('Интерактивная панель. Товарный знак: EXELLTECH'), 'Интерактивная панель EXELLTECH');
  assert.equal(productQueryOfLine('Сервер Supermicro AS-4125GS-TNRT, 4U GPU Server (в рамках сп'), 'Сервер Supermicro AS-4125GS-TNRT, 4U GPU Server');
  assert.equal(productQueryOfLine('Моноблоки. Товарный знак: отсутствует'), null, 'без производителя и модели искать нечего');
});
