// Модели из реестра для компьютерной техники: вид техники, каталог моделей с сайтов производителей,
// подбор под ТЗ (таблица характеристик → нейросеть у лучших), блок в карточке позиции.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRegistryModels, pickModels, modelKind, itemKind, modelName, registryNote, linePairs, configurable } = require('../server/offers/registry-models');
const { matchOffer, fixFalseNo } = require('../server/offers/match');
const { htmlToText } = require('../server/offers/fetch-page');
const { openDb } = require('../server/db');
const { createOfferService } = require('../server/offers');
const { createProductBase } = require('../server/offers/product-base');
const baseConfig = require('../server/config');

test('вид техники позиции: по наименованию, «Мышь компьютерная» и стол — не компьютер, иначе по КТРУ', () => {
  assert.equal(itemKind({ name: 'Ноутбук' }), 'laptop');
  assert.equal(itemKind({ name: 'Компьютер персональный настольный (моноблок)' }), 'aio');
  assert.equal(itemKind({ name: 'Системный блок' }), 'pc');
  assert.equal(itemKind({ name: 'Поставка персональных компьютеров в сборе.' }), 'pc');
  assert.equal(itemKind({ name: 'Монитор, подключаемый к компьютеру' }), 'monitor');
  assert.equal(itemKind({ name: 'Мышь компьютерная' }), null);
  assert.equal(itemKind({ name: 'Стол компьютерный одноместный (750 мм)' }), null);
  assert.equal(itemKind({ name: 'Подставка под системный блок' }), null);
  assert.equal(itemKind({ name: 'Система рентгеновской компьютерной томографии всего тела' }), null);
  assert.equal(itemKind({ name: 'Планшетный компьютер', ktru_code: '26.20.11.110-00000152' }), null);
  assert.equal(itemKind({ name: 'Вычислительная машина', ktru_code: '26.20.11.110-00000165' }), 'laptop');
});

test('вид техники на странице модели: заголовок, адрес, иначе характеристики; принадлежности — не модели', () => {
  assert.equal(modelKind({ title: 'Ноутбук «Гравитон» Н15А-Б' }), 'laptop');
  assert.equal(modelKind({ title: 'Моноблок Graviton M95И' }), 'aio');
  assert.equal(modelKind({ title: 'Мышь BESHTAU M100RU' }), 'other');
  assert.equal(modelKind({ title: 'МФУ лазерный IRU Strato HM2401DNW', url: 'https://iru.ru/item/iru-strato-hm2401dnw/' }), 'other');
  assert.equal(modelKind({ title: 'Реестровые ноутбуки', url: 'https://graviton.ru/catalog/klientskie-ustroystva/noutbuki/reestrovye-noutbuki/' }), 'other', 'страница-подборка, а не модель');
  assert.equal(modelKind({ title: 'iRU Planio 15INP', url: 'https://iru.ru/item/iru-planio-15inp/', specs: [{ name: 'Диагональ экрана', value: '15.6' }, { name: 'Процессор', value: 'Intel N100' }, { name: 'Аккумулятор', value: '3 cell' }] }), 'laptop');
  assert.equal(modelKind({ title: 'BESHTAU PC1167-Q670', url: 'https://beshtau.ru/product/beshtau-pc1167-q670/' }), 'pc');
  assert.equal(modelKind({ title: 'iRU 23IM', url: 'https://iru.ru/item/iru-23im/', specs: [{ name: 'Диагональ', value: '23.8' }, { name: 'Матрица', value: 'IPS' }] }), 'monitor');
  assert.equal(modelName('Ноутбук «Гравитон» Н15А-Б'), 'Гравитон Н15А-Б');
  assert.equal(registryNote('Модель включена в реестр российской промышленной продукции, номер реестровой записи 10012345/2024.'), 'реестр российской промышленной продукции, номер реестровой записи 10012345/2024');
});

const page = (title, rows, extra = '') => `<html><head><title>${title}</title></head><body><nav>Каталог Новости</nav><h1>${title}</h1><table>${rows.map(([n, v]) => `<tr><td>${n}</td><td>${v}</td></tr>`).join('')}</table>${extra}</body></html>`;
const PAGES = {
  'https://maker.test/catalog/noutbuki/n15i/': page('Ноутбук Мейкер Н15И', [['Процессор', 'Intel Core i5-1235U'], ['Оперативная память', '16 ГБ'], ['Объем SSD', '512 ГБ'], ['Диагональ экрана', '15.6"']], '<p>Внесён в реестр российской промышленной продукции.</p>'),
  'https://maker.test/catalog/noutbuki/n14n/': page('Ноутбук Мейкер Н14Н', [['Процессор', 'Intel N100'], ['Оперативная память', '8 ГБ'], ['Объем SSD', '256 ГБ'], ['Диагональ экрана', '14"']]),
  'https://maker.test/catalog/monobloki/m24/': page('Моноблок Мейкер М24', [['Процессор', 'Intel Core i5-12400'], ['Диагональ экрана', '23.8"']]),
  'https://maker.test/catalog/noutbuki/sumka-15/': page('Сумка для ноутбука 15.6', [['Цвет', 'черный']]),
  // раздел: ссылки на модели, одна — подраздел (его адрес — начало адреса другой модели)
  'https://maker.test/catalog/': '<a href="/catalog/monobloki/m24/">М24</a><a href="/catalog/noutbuki/">Ноутбуки</a>',
  'https://maker.test/catalog/noutbuki/': '<a href="/catalog/noutbuki/n14n/">Н14Н</a>',
};
const SITEMAP = '<urlset><url><loc>https://maker.test/catalog/noutbuki/n15i/</loc></url><url><loc>https://maker.test/catalog/noutbuki/sumka-15/</loc></url><url><loc>https://maker.test/news/1/</loc></url></urlset>';

function catalog(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  const makersFile = path.join(dir, 'makers.json');
  fs.writeFileSync(makersFile, JSON.stringify({ makers: [{ id: 'maker', name: 'Мейкер', site: 'maker.test', sitemap: 'https://maker.test/sitemap.xml', listings: ['https://maker.test/catalog/'], product: '^/catalog/[^/]+/([^/]+/)?$' }] }));
  const fetchImpl = async (url) => (url === 'https://maker.test/sitemap.xml' ? new Response(SITEMAP, { status: 200 }) : new Response('', { status: 404 }));
  const fetcher = { fetchPage: async (url) => { if (!PAGES[url]) throw new Error('404'); return { url, status: 200, html: PAGES[url], text: htmlToText(PAGES[url]) }; } };
  const reg = createRegistryModels({ dataDir: dir, makersFile, fetchImpl, fetcher, retryPauseMs: 0, log: { log() {}, warn() {} } });
  t.after(() => { reg.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return reg;
}

test('каталог: модели из карты сайта и разделов, подраздел — не модель, сумка — не компьютер', async (t) => {
  const reg = catalog(t);
  const [r] = await reg.refreshAll({ only: ['maker'] });
  assert.equal(r.status, 'ok');
  assert.equal(r.models, 3, r.note);
  assert.deepEqual(reg.list('laptop').map((m) => m.title), ['Ноутбук Мейкер Н14Н', 'Ноутбук Мейкер Н15И']);
  assert.deepEqual(reg.list('aio').map((m) => m.title), ['Моноблок Мейкер М24']);
  const n15 = reg.list('laptop')[1];
  assert.equal(n15.maker_name, 'Мейкер');
  assert.ok(n15.specs.some((s) => /Процессор/.test(s.name)));
  assert.ok(!/Новости/.test(n15.text.slice(0, 30)), 'текст начинается с названия, без меню');
  assert.equal(n15.registry_note, 'на странице сказано о включении в реестр');
  assert.deepEqual(reg.status().kinds, { aio: 1, laptop: 2 });
});

const ITEM = { id: 1, name: 'Ноутбук', characteristics: [
  { name: 'Количество ядер процессора', value: '≥ 10 (Штука)' },
  { name: 'Количество потоков процессора', value: '≥ 12 (Штука)' },
  { name: 'Общий объем установленной оперативной памяти', value: '≥ 16 (Гигабайт)' },
  { name: 'Объем SSD накопителя', value: '≥ 480 (Гигабайт)' },
] };

test('подбор: модель с Intel N100 (4 потока) и 8 ГБ отсеяна без нейросети, подходящую сверяет нейросеть', async (t) => {
  const reg = catalog(t);
  await reg.refreshAll({ only: ['maker'] });
  let asked = 0;
  const llm = { complete: async ({ messages }) => {
    asked++;
    const ask = JSON.parse(messages[messages.length - 1].content);
    const checks = Object.fromEntries(ask.required.characteristics.map((c) => [c.n, /SSD/.test(c.name) ? 'да: 512 ГБ' : /памят/.test(c.name) ? 'да: 16 ГБ' : '?']));
    return { text: JSON.stringify({ kind: true, checks }) };
  } };
  const r = await pickModels(ITEM, reg.list('laptop'), { matchOffer, llm, system: 'сверка', top: 3 });
  assert.equal(r.considered, 2);
  assert.equal(r.rejected, 1);
  assert.match(r.reasons[0].reason, /потоков|памят|ядер/);
  assert.equal(asked, 1, 'нейросетью — только прошедшая отбор модель');
  assert.equal(r.models.length, 1);
  assert.equal(r.models[0].model, 'Мейкер Н15И');
  // процессор подтверждён справочником; память и SSD — по конфигурации, их подтверждает поставщик
  assert.equal(r.models[0].match, 'частично', JSON.stringify(r.models[0].checks?.rows));
  assert.equal(r.models[0].checks.confirmed, 2);
  assert.equal(r.models[0].checks.by_config, 2);
  assert.ok(r.models[0].checks.rows.filter((x) => x.config).every((x) => /по конфигурации/.test(x.found)));
});

test('ложное «нет» нейросети: среди найденного есть подходящее число с той же единицей', () => {
  const rows = [
    { name: 'Скорость сетевого контроллера', need: '≥ 1000 (Мбит/сек)', verdict: 'no', found: '2.5 Gigabit Ethernet 10/100/1000/2500 Мбит/с' },
    { name: 'Тактовая частота оперативной памяти', need: '≥ 5600 МГц', verdict: 'no', found: '4800-6400 МГц' },
    { name: 'Количество ядер процессора', need: '≥ 8', verdict: 'no', found: '4 ядра (8 потоков)' },
    { name: 'Вес', need: '≤ 1.7 (Килограмм)', verdict: 'no', found: '1,8 кг' },
    { name: 'Максимальный объём памяти', need: '≥ 128 Гб', verdict: 'no', found: 'до 64 ГБ' },
  ];
  fixFalseNo(rows);
  assert.deepEqual(rows.map((r) => r.verdict), ['yes', 'yes', 'no', 'no', 'no']);
});

test('характеристики соседними строками и требования «по конфигурации»', () => {
  const pairs = linePairs('Экран\nДиагональ экрана (дюйм)\n23.8″\nТип подсветки матрицы\nLCD\nТехнология изготовления матрицы\nIPS\nКонструкция\nПоворот на 90°\nда');
  assert.deepEqual(pairs, [
    { name: 'Диагональ экрана (дюйм)', value: '23.8"' },
    { name: 'Тип подсветки матрицы', value: 'LCD' },
    { name: 'Технология изготовления матрицы', value: 'IPS' },
    { name: 'Поворот на 90°', value: 'да' },
  ]);
  assert.ok(configurable('Объем установленной оперативной памяти'));
  assert.ok(configurable('Общий объем накопителей SSD форм-фактора M.2'));
  assert.ok(configurable('Объем каждого установленного модуля оперативной памяти'));
  assert.ok(!configurable('Допустимый максимальный объем увеличения оперативной памяти'));
  assert.ok(!configurable('Объем кэш памяти третьего уровня процессора (L3)'));
  assert.ok(!configurable('Тип оперативной памяти'));
});

test('карточка позиции: модели из реестра через свою базу товаров, сверка по кнопке, стол — мебель своей базы', async (t) => {
  const reg = catalog(t);
  await reg.refreshAll({ only: ['maker'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-svc-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { ...baseConfig, DATA_DIR: dir, OFFER_SOURCES: 'manual', YANDEX_SEARCH_API_KEY: '', DADATA_API_KEY: '', TELEGRAM_BOT_TOKEN: '', FETCH_MIN_INTERVAL_MS: 0, SUPPLIER_INDEX: false, RNP_AUTO: false };
  const { id } = repo.upsertTender({ law: '44', number: 'reg-1', title: 'Компьютерная техника', price: 500000, currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: 1, eis_url: null });
  repo.saveItems(id, [{ name: 'Ноутбук', quantity: 5, unit: 'шт', source: 'notification', characteristics: ITEM.characteristics }, { name: 'Стол компьютерный', quantity: 5, unit: 'шт', source: 'notification', characteristics: [] }]);
  const llm = { complete: async () => ({ text: JSON.stringify({ kind: true, checks: {} }) }) };
  const productBase = createProductBase({ db: repo.db, registry: reg, log: { log() {}, warn() {} } });
  await productBase.refresh();
  const offers = createOfferService({ config, repo, registry: reg, productBase, details: { computeEconomics: async () => ({}) }, llmFactory: () => llm });
  const [laptop, desk] = repo.getItems(id);
  let groups = offers.listForTender(id);
  const deskBase = groups.find((g) => g.item_id === desk.id).base;
  assert.deepEqual([deskBase.kind, deskBase.niche, deskBase.catalog], ['desk', 'мебель', 0], 'стол — мебель: блок базы есть, столов в базе пока нет');
  const before = groups.find((g) => g.item_id === laptop.id).base;
  assert.equal(before.kind, 'laptop');
  assert.equal(before.catalog, 2);
  assert.equal(before.at, undefined, 'ещё не сверялось');
  const r = await offers.baseCheck(id, laptop.id);
  assert.equal(r.base.considered, 2);
  assert.equal(r.base.models[0].model, 'Мейкер Н15И');
  assert.equal(r.base.models[0].from_registry, true);
  groups = offers.listForTender(id);
  assert.ok(groups.find((g) => g.item_id === laptop.id).base.at, 'итог сохранён');
  assert.equal((await offers.baseCheck(id, desk.id)).base.catalog, 0);
  // вешалки в базе нет ни как мебели, ни как техники
  repo.saveItems(id, [{ name: 'Вешалка напольная', quantity: 1, unit: 'шт', source: 'notification', characteristics: [] }]);
  const hanger = repo.getItems(id).find((i) => i.name === 'Вешалка напольная');
  await assert.rejects(offers.baseCheck(id, hanger.id), /компьютеры, картриджи.*мебель/);
});
