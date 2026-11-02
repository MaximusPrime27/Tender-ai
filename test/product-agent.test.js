// Ночной агент базы товаров: задачи из свежих закупок, модель из ТЗ — у поставщиков из своего каталога,
// паспорт PDF у модели из реестра, расхождения на решение человека, отчёт на странице и в Telegram, расписание.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createProductBase } = require('../server/offers/product-base');
const { createProductAgent, passportPairs, modelVariants } = require('../server/offers/product-agent');

const flat = (s) => String(s).toLowerCase().replace(/[^a-zа-я0-9]/g, '');
const supplierPage = (title, rows, price) => `<html><head><title>${title}</title>
  <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: title, offers: { '@type': 'Offer', price, priceCurrency: 'RUB' } })}</script></head>
  <body><h1>${title}</h1><table>${rows.map(([n, v]) => `<tr><td>${n}</td><td>${v}</td></tr>`).join('')}</table></body></html>`;

function setup(t, { pages = {}, files = {}, now = '2026-10-24T00:30:00Z', official = [], config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const clock = () => new Date(now);
  const base = createProductBase({ db: repo.db, clock, log: { log() {}, warn() {} } });
  const index = {
    // свой каталог страниц поставщиков: по модели в адресе
    find: (models, { limit = 3, skip = () => false } = {}) => Object.keys(pages).filter((u) => models.some((m) => flat(u).includes(flat(m))) && !skip(u)).slice(0, limit).map((url) => ({ url })),
    // страницы официальных сайтов по словам в адресе (сбор карточек мебели)
    sample: (words, { limit = 20, skip = () => false } = {}) => Object.keys(pages).filter((u) => official.some((d) => new URL(u).hostname === d) && words.some((w) => flat(u).includes(flat(w))) && !skip(u, new URL(u).hostname)).slice(0, limit).map((url) => ({ url, domain: new URL(url).hostname })),
  };
  const fetched = [];
  const fetcher = {
    fetchPage: async (url) => { fetched.push(url); if (!pages[url]) throw new Error('404'); return { url, status: 200, html: pages[url], text: pages[url].replace(/<[^>]+>/g, '\n'), structured: [{ title: 'x', price: Number(/"price":(\d+)/.exec(pages[url])?.[1] || 0) || null, props: [] }].filter((x) => x.price) }; },
    fetchFile: async (url) => { fetched.push(url); if (!files[url]) throw new Error('404'); return { url, buf: Buffer.from('pdf'), type: 'application/pdf' }; },
  };
  const extract = async ({ buffer }) => [{ status: 'ok', pages: [{ page: 1, text: files[Object.keys(files)[0]] }] }];
  const sent = [];
  const agent = createProductAgent({
    db: repo.db, productBase: base, siteIndex: index, fetcher, extract, clock, log: { log() {}, warn() {} },
    config: { PUBLIC_BASE_URL: 'https://tender.example', AGENT_HOUR: 3, DIGEST_TZ: 'Europe/Moscow', ...config }, official,
    notify: async (html) => { sent.push(html); return true; },
  });
  const tender = (number, items, published = '2026-10-23T08:00:00Z') => {
    const { id } = repo.upsertTender({ law: '44', number, title: 'Картриджи', price: 100000, currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: published, deadline_at: '2026-11-01T10:00:00Z', stage: 1, eis_url: null });
    repo.saveItems(id, items.map((i) => ({ quantity: 1, unit: 'шт', source: 'notification', ...i })));
    return id;
  };
  return { repo, base, agent, sent, fetched, tender };
}

test('модель из ТЗ, которой нет в базе, — найдена у поставщика: новая карточка с характеристиками и ценой; не найденная — в отчёте', async (t) => {
  const { base, agent, sent, tender } = setup(t, {
    pages: {
      'https://opt.ru/p/kartridzh-tk-1170': supplierPage('Тонер-картридж Kyocera TK-1170', [['Цвет', 'черный'], ['Ресурс', '7200 стр.'], ['Технология печати', 'лазерная']], 4100),
      // по номеру модели находятся и чужие товары — принтер и запчасть картриджем не становятся
      'https://opt.ru/p/printer-cf999z': supplierPage('Принтер HP LaserJet CF999Z', [['Скорость', '30 стр/мин'], ['Формат', 'A4']], 20000),
      'https://opt.ru/p/zapchast-cf999z': supplierPage('Запчасть HP узел CF999Z', [['Тип', 'узел'], ['Вес', '1 кг']], 900),
    },
  });
  tender('ag-1', [
    { name: 'Тонер-картридж TK-1170', characteristics: [{ name: 'Цвет', value: 'черный' }, { name: 'Ресурс', value: 'не менее 7200 страниц' }] },
    { name: 'Картридж CF999Z', characteristics: [{ name: 'Цвет', value: 'черный' }] },
    { name: 'Стол письменный', characteristics: [{ name: 'Ширина', value: '1200 мм' }] },
  ]);
  // старая закупка — не задача
  tender('ag-old', [{ name: 'Картридж Q2612A', characteristics: [] }], '2026-10-01T08:00:00Z');
  const tasks = agent.plan();
  assert.deepEqual(tasks.filter((x) => x.type === 'model').map((x) => x.model), ['TK-1170', 'CF999Z']);
  // стол без модели — задача сбора с сайтов фабрик (их в каталоге нет — ничего не откроется)
  assert.deepEqual(tasks.filter((x) => x.type === 'harvest').map((x) => x.kind.id), ['desk']);

  const r = await agent.run({ reason: 'manual' });
  const s = r.stats;
  assert.equal(s.products_new, 1);
  assert.equal(s.not_found.length, 1);
  assert.equal(s.not_found[0].model, 'CF999Z');
  const [p] = base.list('cartridge');
  assert.equal(p.model, 'TK-1170');
  assert.equal(p.price.value, 4100);
  assert.ok(p.specs.some((x) => x.name === 'Ресурс'));
  // отчёт ушёл в Telegram со ссылкой на страницу
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Агент базы товаров — отчёт за ночь/);
  assert.match(sent[0], /Новых товаров: 1/);
  assert.match(sent[0], /CF999Z/);
  assert.match(sent[0], /https:\/\/tender\.example\/#alerts/);
  // на странице — непрочитанный отчёт; повторно те же задачи не берутся две недели
  const v = agent.view();
  assert.equal(v.unread, 1);
  assert.equal(agent.markRead(), 1);
  assert.equal(agent.view().unread, 0);
  assert.equal(agent.plan().filter((x) => x.type !== 'harvest').length, 0);
});

test('расхождение в числах — на решение человека; «взять новое» меняет значение в карточке', async (t) => {
  const { base, agent, tender } = setup(t, {
    pages: { 'https://opt2.ru/p/tk-1170': supplierPage('Картридж TK-1170 Kyocera', [['Ресурс', '6000 стр.'], ['Вес', '0.5 кг'], ['Гарантия', '6 мес']], 3900) },
  });
  base.upsert({ kind: require('../server/offers/product-base').KIND.cartridge, brand: 'Kyocera', model: 'TK-1170', title: 'Тонер-картридж Kyocera TK-1170',
    specs: [{ name: 'Ресурс', value: '7200 стр.', src: 'https://opt.ru/p/tk-1170' }, { name: 'Гарантия', value: '12 мес' }], sources: [{ url: 'https://opt.ru/p/tk-1170', type: 'supplier', name: 'opt.ru' }] });
  // в ТЗ дважды спрашивают вес — его в карточке нет: задача «дополнить»
  tender('ag-2', [
    { name: 'Картридж TK-1170', characteristics: [{ name: 'Вес', value: 'не более 1 кг' }, { name: 'Ресурс', value: 'не менее 7000' }] },
    { name: 'Картридж для принтера Kyocera', characteristics: [{ name: 'Вес', value: 'не более 1 кг' }, { name: 'Ресурс', value: 'не менее 7000' }] },
  ]);
  const tasks = agent.plan();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].type, 'enrich');
  assert.deepEqual(tasks[0].missing, ['Вес']);
  const r = await agent.run();
  assert.equal(r.stats.products_enriched, 1);
  assert.equal(r.stats.conflicts, 1, 'ресурс 7200 и 6000 — расхождение; гарантия — не характеристика товара');
  const [c] = agent.view().conflicts;
  assert.equal(c.name, 'Ресурс');
  assert.equal(c.old_value, '7200 стр.');
  assert.equal(c.new_value, '6000 стр.');
  const p = () => base.get(base.list('cartridge')[0].id);
  assert.equal(p().specs.find((x) => x.name === 'Ресурс').value, '7200 стр.', 'до решения остаётся прежнее');
  assert.ok(p().specs.some((x) => x.name === 'Вес'), 'вес добавлен');
  agent.resolve(c.id, 'take');
  assert.equal(p().specs.find((x) => x.name === 'Ресурс').value, '6000 стр.');
  assert.equal(agent.view().conflicts.length, 0);
});

test('модель из реестра: паспорт PDF со страницы производителя дополняет карточку', async (t) => {
  const makerUrl = 'https://maker.test/catalog/noutbuki/n15i/';
  const pdf = 'https://maker.test/upload/passport-n15i.pdf';
  const { base, agent, tender, fetched } = setup(t, {
    pages: { [makerUrl]: `<html><h1>Ноутбук Мейкер Н15И</h1><a href="/upload/passport-n15i.pdf">Паспорт изделия</a><a href="https://other.ru/x.pdf">чужой</a></html>` },
    files: { [pdf]: 'Технические характеристики\nВес: 1,7 кг\nЕмкость аккумулятора: 45 Вт·ч\nВремя автономной работы\t8 ч' },
  });
  const { KIND } = require('../server/offers/product-base');
  base.upsert({ kind: KIND.laptop, brand: 'Мейкер', model: 'Мейкер Н15И', title: 'Ноутбук Мейкер Н15И', specs: [{ name: 'Процессор', value: 'Intel Core i5-1235U' }], sources: [{ url: makerUrl, type: 'maker', name: 'Мейкер' }] });
  tender('ag-3', [
    { name: 'Ноутбук', characteristics: [{ name: 'Вес', value: 'не более 1.8 кг' }, { name: 'Емкость аккумулятора', value: 'не менее 40' }] },
    { name: 'Ноутбук', characteristics: [{ name: 'Вес', value: 'не более 1.8 кг' }, { name: 'Емкость аккумулятора', value: 'не менее 40' }] },
  ]);
  const r = await agent.run();
  assert.equal(r.stats.pdf_read, 1);
  assert.ok(!fetched.includes('https://other.ru/x.pdf'), 'файлы чужих сайтов не берём');
  const p = base.get(base.list('laptop')[0].id);
  assert.equal(p.specs.find((x) => x.name === 'Вес').value, '1,7 кг');
  assert.equal(p.specs.find((x) => x.name === 'Вес').from, 'паспорт');
  assert.ok(p.sources.some((x) => x.type === 'pdf' && x.url === pdf));
});

test('расписание: проход в 3 часа ночи по Москве, один раз за ночь', async (t) => {
  const at = (iso) => setup(t, { now: iso }).agent;
  assert.equal(at('2026-10-24T00:30:00Z').due(), true, '03:30 по Москве');
  assert.equal(at('2026-10-24T05:00:00Z').due(), false, '08:00 по Москве');
  const { agent } = setup(t, { now: '2026-10-24T00:30:00Z' });
  await agent.run({ reason: 'night' });
  assert.equal(agent.due(), false, 'сегодня уже был');
});

test('варианты модели из ТЗ: без приставки бренда, ноль вместо O, серия HP', () => {
  assert.deepEqual(modelVariants('HB-CRG-728', 'cartridge'), ['HB-CRG-728', 'CRG-728']);
  assert.deepEqual(modelVariants('TK-523OK', 'cartridge'), ['TK-523OK', 'TK-5230K']);
  assert.deepEqual(modelVariants('283Х', 'cartridge'), ['283X', 'CF283X', 'CE283X'], 'кириллическая Х в ТЗ');
  assert.deepEqual(modelVariants('283A', 'laptop'), ['283A'], 'серия HP — только у расходников');
});

test('пары из паспорта: двоеточие, табуляция и соседние строки', () => {
  const pairs = passportPairs('Вес: 1,7 кг\nВремя работы\t8 ч\nДиагональ экрана\n15.6"');
  assert.deepEqual(pairs.slice(0, 2), [{ name: 'Вес', value: '1,7 кг' }, { name: 'Время работы', value: '8 ч' }]);
  assert.ok(pairs.some((x) => x.name === 'Диагональ экрана' && x.value === '15.6"'));
});

test('сбор (мебель): по видам из свежих ТЗ — страницы официальных сайтов фабрик; карточка с моделью и характеристиками, чужое и пустое — мимо', async (t) => {
  const { base, agent, tender, fetched, sent } = setup(t, {
    official: ['chairman.ru', 'rosmet.com'],
    config: { AGENT_HARVEST_PAGES: 10 },
    pages: {
      'https://chairman.ru/goods/kreslo-chairman-523': supplierPage('Кресло руководителя CHAIRMAN 523', [['Максимальная нагрузка', '150 кг'], ['Газлифт', 'класс 4'], ['Обивка', 'натуральная кожа/экокожа'], ['Крестовина', 'металл']], 25000),
      // заголовок — не кресло (раздел каталога), и кресло без таблицы характеристик
      'https://chairman.ru/goods/kresla-dlya-ofisa': supplierPage('Каталог: офисная мебель', [['a', '1'], ['b', '2'], ['c', '3']], 0),
      'https://chairman.ru/goods/kreslo-chairman-696': supplierPage('Кресло CHAIRMAN 696', [['Цвет', 'черный']], 9000),
      'https://rosmet.com/catalog/stol-uchenicheskiy-111rv': supplierPage('Стол ученический 111РВ', [['Ширина столешницы', '700 мм'], ['Глубина столешницы', '500 мм'], ['Толщина кромки', '1 мм']], 0),
      // магазин, а не фабрика — сбор его не трогает
      'https://shop.ru/kreslo-chairman-523': supplierPage('Кресло CHAIRMAN 523', [['a', '1'], ['b', '2'], ['c', '3']], 20000),
    },
  });
  tender('ag-f1', [
    { name: 'Кресло офисное', characteristics: [{ name: 'Максимальная нагрузка', value: 'не менее 120 кг' }] },
    { name: 'Кресло руководителя', characteristics: [{ name: 'Обивка', value: 'кожа' }] },
    { name: 'Стол ученический', characteristics: [{ name: 'Ширина столешницы', value: '700 мм' }] },
  ]);
  const tasks = agent.plan();
  assert.deepEqual(tasks.map((x) => [x.type, x.kind.id]), [['harvest', 'office_chair'], ['harvest', 'desk']], 'кресла спрашивают чаще — первыми');
  assert.ok(tasks[0].pages > tasks[1].pages);
  const r = await agent.run({ reason: 'manual' });
  assert.equal(r.stats.products_new, 2);
  assert.ok(!fetched.includes('https://shop.ru/kreslo-chairman-523'));
  const [chair] = base.list('office_chair');
  assert.equal(chair.model, 'CHAIRMAN 523');
  assert.ok(chair.from_official);
  assert.equal(base.get(chair.id).specs.find((s) => s.name === 'Максимальная нагрузка').from, 'сайт производителя');
  assert.equal(chair.price, null, 'цены фабрики в рознице не берём — это не поставщик');
  assert.equal(base.list('desk')[0].model, '111РВ');
  assert.match(sent[0], /Сбор карточек с сайтов фабрик \(мебель\): открыто страниц 4/);
  // следующей ночью открытые страницы не открываются снова
  const before = fetched.length;
  await agent.run({ reason: 'manual' });
  assert.equal(fetched.length, before);
});

test('закупки, с которыми работал агент заявок, ночью идут первыми', (t) => {
  const { repo, agent, tender } = setup(t);
  tender('hot-1', [{ name: 'Тонер-картридж TK-1170', characteristics: [] }]);
  const hot = tender('hot-2', [{ name: 'Тонер-картридж TL-5120X', characteristics: [] }]);
  repo.db.exec('CREATE TABLE IF NOT EXISTS bid_agent_items (id INTEGER PRIMARY KEY, tender_id INTEGER, created_at TEXT)');
  repo.db.prepare('INSERT INTO bid_agent_items (tender_id, created_at) VALUES (?, ?)').run(hot, '2026-10-23T20:00:00Z');
  assert.deepEqual(agent.plan().filter((x) => x.type === 'model').map((x) => x.model), ['TL-5120X', 'TK-1170']);
});
