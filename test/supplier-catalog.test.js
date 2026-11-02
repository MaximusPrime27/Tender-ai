// Профильные компании для запроса цены: каталог кандидатов, отметки о работе с ними, черновик запроса КП.
// Кандидат — не предложение: цены у него нет и в расчёт он не попадает.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSupplierCatalog, mergeCatalog, normalizeDomain } = require('../server/offers/supplier-catalog');
const { openDb } = require('../server/db');
const { createOfferService } = require('../server/offers');
const { createApp } = require('../server/server');
const baseConfig = require('../server/config');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplier-catalog-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { ...baseConfig, DATA_DIR: dir, OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '', TELEGRAM_BOT_TOKEN: '' };
  const catalog = createSupplierCatalog({ config, repo });
  return { dir, repo, config, catalog };
}

test('каталог компаний: сайт приводится к домену, небезопасные адреса отбрасываются', () => {
  assert.equal(normalizeDomain('https://WWW.NETLAB.RU/path'), 'netlab.ru');
  assert.equal(normalizeDomain('www.netlab.ru'), 'netlab.ru');
  assert.equal(normalizeDomain('javascript:alert(1)'), null);
  assert.equal(normalizeDomain('https://user:secret@netlab.ru/'), null);
});

test('каталог компаний: записи с одним сайтом склеиваются, направления складываются', () => {
  const rows = mergeCatalog({ suppliers: [{ site: 'netlab.ru', name: 'NETLAB', directions: ['office', 'cctv'] }] },
    { distributors: [{ site: 'www.netlab.ru', name: 'Old', dir: 'computers' }] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].directions, ['computers', 'office', 'cctv']);
});

test('каталог компаний: выключенная компания не включается обратно при склейке', () => {
  const rows = mergeCatalog({ suppliers: [{ site: 'netlab.ru', name: 'NETLAB' }] }, { suppliers: [{ site: 'netlab.ru', enabled: false }] });
  assert.equal(rows[0].enabled, false);
});

test('каталог компаний: для камеры — поставщики видеонаблюдения, без специалистов по картриджам', (t) => {
  const { catalog } = setup(t);
  const sites = catalog.forItem({ name: 'IP-камера видеонаблюдения', okpd2_code: '26.40.33' }).map((c) => c.site);
  assert.ok(sites.includes('tinko.ru'));
  assert.ok(sites.includes('netlab.ru'));
  assert.ok(!sites.includes('vtt.ru'));
  assert.ok(!sites.includes('bulat-group.ru'));
});

test('каталог компаний: позиция вне направлений и позиция под словом-исключением кандидатов не получают', (t) => {
  const { catalog } = setup(t);
  assert.ok(catalog.list().length > 40, 'каталог не пуст');
  assert.deepEqual(catalog.forItem({ name: 'Стул офисный' }), []);
  // «Компьютерный стол» — слово-исключение направления «Компьютеры»: раньше такой позиции отдавался весь каталог.
  assert.deepEqual(catalog.forItem({ name: 'Компьютерный стол' }), []);
  assert.deepEqual(catalog.forItem({ name: 'Мониторинг состояния оборудования' }), []);
});

test('каталог компаний: у магазина, чьи цены сервис читает сам, подпись об этом, а не «уточнить способ получения цены»', (t) => {
  const { catalog } = setup(t);
  const all = catalog.list();
  const shop = all.find((c) => c.site === 'regard.ru'); // из config/stores.json → suppliers
  assert.match(shop.access_label, /сервис читает её сам/);
  const partner = all.find((c) => c.site === 'netlab.ru'); // из профильного каталога
  assert.equal(partner.access_label, 'Нужен партнёрский доступ к API');
  assert.ok(all.every((c) => c.price_confirmed === false && c.connection_verified === false), 'цена и подключение не «подтверждены» ни у кого');
  assert.ok(all.indexOf(partner) < all.indexOf(shop), 'сначала профильные компании по порядку подключения');
});

test('каталог компаний: «условия получены» и «не работаем» сохраняются, цену не подтверждая', (t) => {
  const { catalog } = setup(t);
  const candidate = catalog.update('www.netlab.ru', { status: 'terms_received', note: 'Проверить НДС' });
  assert.equal(candidate.price_confirmed, false);
  assert.equal(candidate.connection_verified, false);
  assert.equal(catalog.list().find((c) => c.site === 'netlab.ru').user_note, 'Проверить НДС');
  catalog.update('netlab.ru', { status: 'blocked', note: '' });
  assert.ok(!catalog.forItem({ name: 'IP-камера видеонаблюдения' }).some((c) => c.site === 'netlab.ru'));
});

test('каталог компаний: черновик запроса КП содержит требования, ничего не отправляет и отметку не меняет', (t) => {
  const { catalog } = setup(t);
  const item = { name: 'IP-камера видеонаблюдения', quantity: 7, unit: 'шт', characteristics: [{ name: 'Разрешение', value: '8 MP' }] };
  const draft = catalog.draft({ region: 27 }, item, 'tinko.ru');
  assert.equal(draft.sent, false);
  assert.match(draft.body, /Разрешение: 8 MP/);
  assert.match(draft.body, /НДС/);
  assert.match(draft.subject, /7 шт$/);
  assert.match(draft.body, /Количество: 7 шт\./);
  assert.equal(catalog.list().find((c) => c.site === 'tinko.ru').status, 'not_contacted');
  assert.throws(() => catalog.draft({}, item, 'vtt.ru'), /Нет подходящего/);
  // количество в закупке не указано
  const noQty = catalog.draft({}, { ...item, quantity: null }, 'tinko.ru');
  assert.match(noQty.subject, /количество уточняется$/);
  assert.match(noQty.body, /Количество: уточняется\./);
});

test('каталог компаний: испорченный файл каталога — явная ошибка, а не молча пустой список', (t) => {
  const { config, repo, dir } = setup(t);
  const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, '{');
  const catalog = createSupplierCatalog({ config: { ...config, SUPPLIER_CANDIDATES_CONFIG: bad }, repo });
  assert.throws(() => catalog.list(), /Некорректный каталог/);
});

test('каталог компаний: API отдаёт кандидатов и черновики, но предложением с ценой кандидат не становится', async (t) => {
  const { config, repo } = setup(t);
  const { id } = repo.upsertTender({ law: '44', number: 'supplier-api', title: 'Камеры', price: 10000,
    currency: 'RUB', region: 27, okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: 1, eis_url: null });
  repo.saveItems(id, [{ name: 'IP-камера видеонаблюдения', quantity: 3, unit: 'шт', source: 'notification' }]);
  const item = repo.getItems(id)[0];
  const offers = createOfferService({ config, repo, details: {}, llmFactory: () => null,
    fetchImpl: () => { throw new Error('В этой проверке сеть не используется'); } });
  const app = createApp({ config, repo, offers });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url) => fetch(`${base}${url}`);
  const put = (url, body) => fetch(`${base}${url}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const res = await request(`/api/tenders/${id}/offers`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.groups[0].candidates.some((c) => c.site === 'tinko.ru'));
    assert.equal(body.groups[0].best, null);
    assert.equal(repo.getOffers(id).length, 0);
    const draft = await request(`/api/tenders/${id}/supplier-candidates/tinko.ru/rfq?item_id=${item.id}`);
    assert.equal(draft.status, 200);
    assert.equal((await draft.json()).sent, false);
    assert.equal((await request(`/api/tenders/${id}/supplier-candidates/tinko.ru/rfq?item_id=99999`)).status, 404);
    assert.equal((await put('/api/supplier-candidates/netlab.ru', { status: 'api_connected' })).status, 400);

    // Отметка о работе с компанией сохраняется и видна в карточке; на предложения и расчёт она не влияет.
    const saved = await put('/api/supplier-candidates/tinko.ru', { status: 'awaiting_reply', note: '' });
    assert.equal(saved.status, 200);
    const after = await (await request(`/api/tenders/${id}/offers`)).json();
    assert.equal(after.groups[0].candidates.find((c) => c.site === 'tinko.ru').status, 'awaiting_reply');
    assert.equal(repo.getOffers(id).length, 0);
    const byDirection = await (await request('/api/supplier-candidates?direction=cctv')).json();
    assert.ok(byDirection.candidates.length > 0 && byDirection.candidates.every((c) => c.directions.includes('cctv')));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('ниши: позиция мебели получает поставщиков ниши «Мебель», даже если ниша не включена; техника — свои', (t) => {
  const { dir, repo, config } = setup(t);
  const stores = path.join(dir, 'stores.json');
  fs.writeFileSync(stores, JSON.stringify({ suppliers: [
    { name: 'Мебель-опт', site: 'mebel-opt.example.ru', directions: ['g-furniture'] },
    { name: 'Техника', site: 'tech.example.ru', dir: 'computers' },
  ] }));
  const empty = path.join(dir, 'profile-suppliers.json');
  fs.writeFileSync(empty, JSON.stringify({ suppliers: [] }));
  const catalog = createSupplierCatalog({ config: { ...config, STORES_CONFIG: stores, SUPPLIER_CANDIDATES_CONFIG: empty }, repo });
  const sites = (item) => catalog.forItem(item).map((c) => c.site).sort();
  assert.deepEqual(sites({ name: 'Стол письменный офисный', okpd2_code: '31.01.11.150' }), ['mebel-opt.example.ru']);
  assert.deepEqual(sites({ name: 'Ноутбук', okpd2_code: '26.20.11.110' }), ['tech.example.ru']);
  assert.deepEqual(sites({ name: 'Услуги по уборке помещений', okpd2_code: '81.21.10.000' }), []);
});
