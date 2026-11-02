// Как агент учится на всех базах: официальные сайты производителей в своём каталоге страниц (за характеристиками,
// не как поставщики), старшинство источников (человек > паспорт > сайт производителя > продавец), опыт по сайтам,
// запрос на маркетплейсы по одному устройству.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSiteIndex } = require('../server/offers/site-index');
const { createProductBase, KIND } = require('../server/offers/product-base');
const { createProductAgent } = require('../server/offers/product-agent');
const { openDb } = require('../server/db');

const dirs = [];
const tmp = (t, name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), name)); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const urlset = (list) => `<?xml version="1.0"?><urlset>${list.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;

test('официальный сайт производителя — в каталоге с пометкой: поиск поставщиков его не берёт, агент — берёт', async (t) => {
  const net = {
    'https://opt.ru/robots.txt': 'User-agent: *\nSitemap: https://opt.ru/sitemap.xml',
    'https://opt.ru/sitemap.xml': urlset(['https://opt.ru/catalog/kartridzh-cf259x-100/']),
    'https://hp.test/robots.txt': 'User-agent: *\nSitemap: https://hp.test/sitemap.xml',
    'https://hp.test/sitemap.xml': urlset(['https://hp.test/products/toner-cf259x-123/', 'https://hp.test/products/toner-cf259a-124/']),
  };
  const fetchImpl = async (url) => (net[url] ? new Response(net[url], { status: 200 }) : new Response('', { status: 404 }));
  const index = createSiteIndex({ dataDir: tmp(t, 'si-'), fetchImpl, minIntervalMs: 0, log: { log() {}, warn() {} } });
  t.after(() => index.close());
  await index.refreshAll(['opt.ru'], { official: ['hp.test'], officialMaxPages: 1 });
  const st = index.status();
  assert.equal(st.ready, 1, 'в строке поставщиков — только поставщик');
  assert.deepEqual(st.official, { sites: 1, pages: 1 }, 'с официального сайта не больше officialMaxPages страниц');
  assert.deepEqual(index.find(['CF259X']).map((f) => f.domain), ['opt.ru']);
  assert.deepEqual(index.find(['CF259X'], { withOfficial: true, perDomain: 1 }).map((f) => f.domain).sort(), ['hp.test', 'opt.ru']);
  // повторное обновление без официального списка убирает его из каталога, как любой сайт не из списка
  await index.refreshAll(['opt.ru'], { maxAgeDays: 0 });
  assert.equal(index.status().official.sites, 0);
});

test('старшинство: паспорт не заменяется сайтом производителя, выбор человека — ничем; продавец паспорт не оспаривает', (t) => {
  const repo = openDb(tmp(t, 'pr-'));
  t.after(() => repo.db.close());
  const base = createProductBase({ db: repo.db, log: { log() {}, warn() {} } });
  const card = { kind: KIND.cartridge, brand: 'HP', model: 'CF259X', title: 'HP 59X CF259X' };
  base.upsert({ ...card, prefer: true, specs: [{ name: 'Ресурс картриджа', value: 'около 10000 стр.', from: 'паспорт производителя' }, { name: 'Цвет', value: 'черный', from: 'паспорт производителя' }] });
  // сайт производителя: ресурс не трогает, вес добавляет
  base.upsert({ ...card, prefer: true, specs: [{ name: 'Ресурс картриджа', value: '9000', from: 'сайт производителя' }, { name: 'Вес', value: '1,2 кг', from: 'сайт производителя' }] });
  const get = () => base.get(base.list('cartridge')[0].id).specs;
  assert.equal(get().find((s) => s.name === 'Ресурс картриджа').value, 'около 10000 стр.');
  assert.equal(get().find((s) => s.name === 'Вес').value, '1,2 кг');
  // продавец с другим ресурсом — не расхождение на решение: паспорт главнее
  const conflicts = [];
  base.upsert({ ...card, conflicts, specs: [{ name: 'Ресурс картриджа', value: '12000 стр.' }, { name: 'Вес', value: '2 кг' }] });
  assert.deepEqual(conflicts, [], 'паспорт и сайт производителя продавец не оспаривает');
  // выбор человека не меняет даже новый паспорт
  base.setSpec(base.list('cartridge')[0].id, 'Цвет', 'чёрный (матовый)', 'https://x');
  base.upsert({ ...card, prefer: true, specs: [{ name: 'Цвет', value: 'black', from: 'паспорт производителя' }] });
  assert.equal(get().find((s) => s.name === 'Цвет').value, 'чёрный (матовый)');
});

test('опыт по сайтам: полезный сайт — первым, бесполезный (8 раз пусто) — больше не открывается; официальный сайт — «сайт производителя»', async (t) => {
  const repo = openDb(tmp(t, 'ag-'));
  t.after(() => repo.db.close());
  const now = '2026-10-24T00:30:00Z';
  const base = createProductBase({ db: repo.db, log: { log() {}, warn() {} } });
  const pages = {
    'https://empty.ru/p/tk-1170': '<html><h1>Тонер-картридж TK-1170</h1></html>',
    'https://good.ru/p/tk-1170': '<html><body><h1>Тонер-картридж Kyocera TK-1170</h1><table><tr><td>Ресурс</td><td>7200 стр.</td></tr><tr><td>Цвет</td><td>черный</td></tr><tr><td>Технология</td><td>лазерная</td></tr></table></body></html>',
    'https://kyocera.test/p/tk-1170': '<html><body><h1>Kyocera TK-1170</h1><table><tr><td>Вес</td><td>0,6 кг</td></tr><tr><td>Ресурс</td><td>7200 стр.</td></tr><tr><td>Цвет</td><td>черный</td></tr></table></body></html>',
  };
  const opened = [];
  const fetcher = { fetchPage: async (url) => { opened.push(url); return { url, status: 200, html: pages[url], text: '', structured: [] }; } };
  const index = { find: (models, { skip = () => false, limit = 10 } = {}) => Object.keys(pages).filter((u) => !skip(u)).slice(0, limit).map((url) => ({ url, domain: new URL(url).hostname })) };
  const agent = createProductAgent({ db: repo.db, productBase: base, siteIndex: index, fetcher, official: ['kyocera.test'], clock: () => new Date(now), log: { log() {}, warn() {} }, config: { AGENT_TASKS_PER_NIGHT: 10 } });
  // пустой сайт уже 8 раз ничего не дал
  repo.db.prepare("INSERT INTO agent_sources (domain, opened, useful) VALUES ('empty.ru', 8, 0)").run();
  const { id } = repo.upsertTender({ law: '44', number: 'l-1', title: 'Картриджи', price: 1, currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: '2026-10-23T08:00:00Z', deadline_at: '2026-11-01T10:00:00Z', stage: 1, eis_url: null });
  repo.saveItems(id, [{ name: 'Тонер-картридж TK-1170', quantity: 1, unit: 'шт', source: 'notification', characteristics: [{ name: 'Ресурс', value: 'не менее 7200' }] }]);
  await agent.run();
  assert.ok(!opened.includes('https://empty.ru/p/tk-1170'), 'бесполезный сайт не открывается');
  assert.equal(opened[0], 'https://kyocera.test/p/tk-1170', 'официальный сайт — первым');
  const p = base.get(base.list('cartridge')[0].id);
  assert.equal(p.specs.find((s) => s.name === 'Вес').from, 'сайт производителя');
  assert.ok(p.sources.some((s) => s.type === 'official'));
  const v = agent.view();
  assert.ok(v.sources.some((x) => x.domain === 'good.ru' && x.useful === 1));
  assert.deepEqual(v.useless, ['empty.ru']);
});

test('выборка страниц фабрик по словам в адресе (сбор мебели): только официальные сайты, не больше perDomain с сайта, пропуск открытых', async (t) => {
  const net = {
    'https://mebel-opt.ru/robots.txt': 'User-agent: *\nSitemap: https://mebel-opt.ru/sitemap.xml',
    'https://mebel-opt.ru/sitemap.xml': urlset(['https://mebel-opt.ru/catalog/kreslo-523/']),
    'https://chairman.test/robots.txt': 'User-agent: *\nSitemap: https://chairman.test/sitemap.xml',
    'https://chairman.test/sitemap.xml': urlset(['https://chairman.test/goods/kreslo-523/', 'https://chairman.test/goods/kreslo-696/', 'https://chairman.test/goods/stol-120/', 'https://chairman.test/news/kreslo-goda-2026/']),
    'https://rosmet.test/robots.txt': 'User-agent: *\nSitemap: https://rosmet.test/sitemap.xml',
    'https://rosmet.test/sitemap.xml': urlset(['https://rosmet.test/catalog/кресло-ученическое-111/']),
  };
  const fetchImpl = async (url) => (net[url] ? new Response(net[url], { status: 200 }) : new Response('', { status: 404 }));
  const index = createSiteIndex({ dataDir: tmp(t, 'si-'), fetchImpl, minIntervalMs: 0, log: { log() {}, warn() {} } });
  t.after(() => index.close());
  await index.refreshAll(['mebel-opt.ru'], { official: ['chairman.test', 'rosmet.test'] });
  const urls = (opts) => index.sample(['kreslo', 'кресл'], { random: () => 0.5, ...opts }).map((x) => x.url).sort();
  assert.deepEqual(urls(), ['https://chairman.test/goods/kreslo-523/', 'https://chairman.test/goods/kreslo-696/', 'https://rosmet.test/catalog/кресло-ученическое-111/'], 'магазин и новость — не берутся');
  assert.equal(urls({ perDomain: 1 }).length, 2);
  assert.deepEqual(urls({ skip: (u) => /523/.test(u) }), ['https://chairman.test/goods/kreslo-696/', 'https://rosmet.test/catalog/кресло-ученическое-111/']);
});
