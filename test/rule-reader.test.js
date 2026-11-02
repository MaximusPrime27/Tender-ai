// «Читатель по правилам»: таблицы документов сохраняются построчно, позиции и их характеристики читаются из них
// без нейросети. Документы в тестах — вымышленные.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { createLlm } = require('../server/llm');
const { extractFile } = require('../server/extract');
const { htmlWithTables } = require('../server/extract/tables');
const { itemsFromTables, pickItems, tablesOf, parseQty, cleanName } = require('../server/tenders/rule-items');
const { quoteInText } = require('../server/analyze/verify');
const { makeDocx } = require('../samples/make-samples');

const noTools = { ocr: { ready: async () => false, pdfReady: async () => false, maxPages: 0 }, archiver: { available: async () => false } };
const read = async (name, buffer) => { const [f] = await extractFile({ name, buffer }, 0, noTools); return { ...f, id: 1 }; };
const lines = (f) => f.pages.map((p) => p.text).join('\n').split('\n');

// Описание объекта закупки: одна таблица, у каждой позиции — строки характеристик под общим «Требования…»
const POSITIONS = { table: [
  [{ text: '№', vmerge: 'start' }, { text: 'ОКПД2/КТРУ\nНаименование товара', vmerge: 'start' }, { text: 'Требования к функциональным, техническим характеристикам', colspan: 2 }, { text: 'Ед. измерения', vmerge: 'start' }, { text: 'Кол-во', vmerge: 'start' }],
  [{ text: '', vmerge: 'cont' }, { text: '', vmerge: 'cont' }, 'Наименование характеристики', 'Значение характеристики', { text: '', vmerge: 'cont' }, { text: '', vmerge: 'cont' }],
  ['1', '2', '3', '4', '5', '6'],
  [{ text: '1.', vmerge: 'start' }, { text: 'Подушка\n13.92.24.140-00000002', vmerge: 'start' }, { text: 'Характеристики по КТРУ:', colspan: 2 }, { text: 'Шт.', vmerge: 'start' }, { text: '150', vmerge: 'start' }],
  [{ text: '', vmerge: 'cont' }, { text: '', vmerge: 'cont' }, 'Тип наполнителя', 'Искусственный', { text: '', vmerge: 'cont' }, { text: '', vmerge: 'cont' }],
  [{ text: '', vmerge: 'cont' }, { text: '', vmerge: 'cont' }, 'Длина', '> 65 и ≤ 70 см', { text: '', vmerge: 'cont' }, { text: '', vmerge: 'cont' }],
  [{ text: '2.', vmerge: 'start' }, { text: 'Одеяло\n13.92.11.110-00000007', vmerge: 'start' }, { text: 'Характеристики по КТРУ:', colspan: 2 }, { text: 'Шт.', vmerge: 'start' }, { text: '100', vmerge: 'start' }],
  [{ text: '', vmerge: 'cont' }, { text: '', vmerge: 'cont' }, 'Материал наполнителя', 'Синтетический', { text: '', vmerge: 'cont' }, { text: '', vmerge: 'cont' }],
  ['', 'Итого', '', '', '', '250'],
] };

test('таблица Word сохраняется построчно: объединённые ячейки не сдвигают столбцы, продолжение помечено «″»', async () => {
  const f = await read('Описание объекта закупки.docx', makeDocx(['Приложение № 1. Описание объекта закупки', POSITIONS, 'Срок поставки: 10 дней.']));
  assert.equal(f.status, 'ok');
  assert.equal(f.coverage.tables, 1);
  const rows = lines(f).filter((l) => l.includes('|'));
  assert.equal(rows[0], '№ | ОКПД2/КТРУ; Наименование товара | Требования к функциональным, техническим характеристикам |  | Ед. измерения | Кол-во');
  assert.equal(rows[1], '″ | ″ | Наименование характеристики | Значение характеристики | ″ | ″');
  assert.equal(rows[3], '1. | Подушка; 13.92.24.140-00000002 | Характеристики по КТРУ: |  | Шт. | 150');
  assert.equal(rows[4], '″ | ″ | Тип наполнителя | Искусственный | ″ | ″', 'строка характеристики стоит в своих столбцах и помнит, что она — продолжение позиции');
  assert.ok(lines(f).includes('Срок поставки: 10 дней.'), 'обычный текст вокруг таблицы на месте');
  // цитата, идущая через границу ячеек, подтверждается
  assert.ok(quoteInText('Тип наполнителя Искусственный', f.pages.map((p) => p.text).join('\n')));
  // вложенная таблица и спецсимволы не ломают разбор
  const nested = htmlWithTables('<p>До</p><table><tr><td>A &amp; B</td><td><table><tr><td>x</td><td>y</td></tr></table></td></tr><tr><td colspan="2">Итог</td></tr></table><p>После</p>');
  assert.equal(nested.text, 'До\n\nA & B | x y\nИтог\n\nПосле');
  assert.equal(nested.tables, 1);
});

test('правила читают позиции из таблицы: количество, единица, характеристики с цитатой; нумерация и «Итого» — не позиции', async () => {
  const f = await read('Описание объекта закупки.docx', makeDocx([POSITIONS]));
  const { items, tables, itemTables } = itemsFromTables([f]);
  assert.deepEqual([tables, itemTables], [1, 1]);
  assert.deepEqual(items.map((i) => [i.name, i.quantity, i.unit]), [['Подушка', 150, 'Шт'], ['Одеяло', 100, 'Шт']], 'код КТРУ из названия убран; строка «1 | 2 | 3» и «Итого» пропущены');
  assert.deepEqual(items[0].characteristics.map((c) => [c.name, c.value]), [['Тип наполнителя', 'Искусственный'], ['Длина', '> 65 и ≤ 70 см']]);
  assert.deepEqual(items[1].characteristics.map((c) => c.name), ['Материал наполнителя'], 'характеристика относится к своей позиции, а не к соседней');
  const c = items[0].characteristics[0];
  assert.ok(quoteInText(c.quote, f.pages.find((p) => p.page === c.page).text), 'цитата характеристики есть на названной странице');
  assert.deepEqual([items[0].source.file, items[0].source.page], ['Описание объекта закупки.docx', 1]);

  assert.equal(parseQty('15.00000000000'), 15);
  assert.equal(parseQty('1 000'), 1000);
  assert.equal(parseQty('2,5'), 2.5);
  assert.equal(parseQty('не менее 5'), null, 'условие вместо числа — не количество');
  assert.equal(cleanName('Мышь ОКПД 2 26.20.16.170 КТРУ'), 'Мышь');
});

test('другие виды таблиц: характеристики в ячейке; отдельная таблица характеристик после позиции; лист Excel', async () => {
  // характеристики перечислены в одной ячейке абзацами
  const inCell = await read('ООЗ.docx', makeDocx([{ table: [
    ['№ п/п', 'Наименование товара', 'Ед. изм.', 'Кол-во', 'Сведения о функциональных, технических характеристиках'],
    ['1', 'Картридж для электрографических печатающих устройств', 'Шт.', '80', 'Тип: Совместимый\nЦвет тонера: Чёрный\nРесурс: не менее 3000 страниц'],
    ['2', 'Картридж для электрографических печатающих устройств', 'Шт.', '80', 'Тип: Оригинальный\nЦвет тонера: Голубой\nРесурс: не менее 1400 страниц'],
  ] }]));
  const a = itemsFromTables([inCell]).items;
  assert.equal(a.length, 2, 'две позиции с одинаковым названием и количеством — это два товара');
  assert.deepEqual(a.map((i) => i.characteristics.find((c) => c.name === 'Тип').value), ['Совместимый', 'Оригинальный']);
  assert.deepEqual(pickItems(a).items.length, 2, 'при выборе списка одинаковые по названию позиции не склеиваются');

  // маленькая таблица «товар — количество», за ней — таблица характеристик
  const split = await read('Описание объекта закупки.docx', makeDocx([
    { table: [['Наименование товара, работы, услуги', 'Код позиции', 'Единица измерения', 'Количество (объем работы, услуги)'], ['Системный блок', '26.20.15.000-00000029', 'Штука', '15.00000000000']] },
    'Характеристики товара:',
    { table: [['Наименование характеристики', 'Значение характеристики', 'Единица измерения характеристики'], ['Частота процессора базовая', '≥ 3.3', 'Гигагерц'], ['Количество ядер процессора', '≥ 4', 'Штука']] },
  ]));
  const b = itemsFromTables([split]).items;
  assert.deepEqual(b.map((i) => [i.name, i.quantity, i.unit]), [['Системный блок', 15, 'Штука']]);
  assert.deepEqual(b[0].characteristics.map((c) => [c.name, c.value]), [['Частота процессора базовая', '≥ 3.3 Гигагерц'], ['Количество ядер процессора', '≥ 4 Штука']]);

  // лист Excel: объединение по вертикали — «″», по горизонтали текст не повторяется
  const ws = XLSX.utils.aoa_to_sheet([
    ['Спецификация к договору'],
    ['Наименование товара', 'Ед. изм.', 'Количество', 'Характеристика', 'Значение'],
    ['Монитор', 'шт', 8, 'Диагональ', 'не менее 23.8 дюйма'], ['', '', '', 'Разрешение', '1920x1080'],
    ['Клавиатура', 'шт', 8, 'Интерфейс', 'USB'],
  ]);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }, { s: { r: 2, c: 0 }, e: { r: 3, c: 0 } }, { s: { r: 2, c: 1 }, e: { r: 3, c: 1 } }, { s: { r: 2, c: 2 }, e: { r: 3, c: 2 } }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ТЗ');
  const sheet = await read('ТЗ Аукцион.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const text = lines(sheet);
  assert.ok(text.includes('Спецификация к договору'), 'заголовок, объединённый на всю ширину, написан один раз');
  assert.ok(text.includes('″ | ″ | ″ | Разрешение | 1920x1080'));
  const c = itemsFromTables([sheet]).items;
  assert.deepEqual(c.map((i) => [i.name, i.quantity, i.unit]), [['Монитор', 8, 'шт'], ['Клавиатура', 8, 'шт']]);
});

test('один список из самого подходящего файла: ТЗ важнее обоснования цены; нестандартная таблица правилами не читается', async () => {
  const tz = await read('Техническое задание.docx', makeDocx([{ table: [['Наименование товара', 'Кол-во', 'Ед. изм.'], ['Ноутбук', '6', 'шт'], ['Принтер', '6', 'шт']] }]));
  // обоснование цены: та же позиция повторена по числу коммерческих предложений
  const price = { ...(await read('Обоснование НМЦК.docx', makeDocx([{ table: [['Наименование товара', 'Источник', 'Кол-во'], ['Ноутбук', 'КП № 1', '6'], ['Ноутбук', 'КП № 2', '6'], ['Принтер', 'КП № 1', '6'], ['Принтер', 'КП № 2', '6'], ['Сканер', 'КП № 1', '2']] }]))), id: 2 };
  const all = itemsFromTables([price, tz]).items;
  const picked = pickItems(all);
  assert.equal(picked.file, 'Техническое задание.docx');
  assert.deepEqual(picked.items.map((i) => i.name), ['Ноутбук', 'Принтер']);
  assert.deepEqual(picked.alternatives, [{ file: 'Обоснование НМЦК.docx', count: 3 }], 'в другом файле список другой длины — это видно');
  // только обоснование цены: повторы по источникам цены склеены
  assert.deepEqual(pickItems(itemsFromTables([price]).items).items.map((i) => i.name), ['Ноутбук', 'Принтер', 'Сканер']);

  // таблица без столбца количества или с пустой формой — не позиции; текст без таблиц — тоже
  const form = await read('Форма заявки.docx', makeDocx([{ table: [['№ п/п', 'Наименование', 'Кол-во', 'Цена'], ['1', '2', '3', '4']] }, { table: [['Параметр', 'Значение'], ['Гарантия', '12 месяцев']] }]));
  assert.deepEqual(itemsFromTables([form]).items, []);
  assert.equal(tablesOf(form).length, 2);
  const plain = await read('Контракт.docx', makeDocx(['Поставщик обязуется поставить товар.', 'Количество: 25 штук.']));
  assert.deepEqual(itemsFromTables([plain]), { items: [], tables: 0, itemTables: 0 });
});

test('закупка из своих документов с таблицей в ТЗ: позиции и требования прочитаны по правилам, нейросеть для них не вызывается', async () => {
  const asked = [];
  const mock = createLlm('mock');
  const llmFactory = () => ({ ...mock, complete: async (args) => { asked.push(args.task); return mock.complete(args); } });
  const config = {
    ...baseConfig, ANALYSIS_READER: 'llm', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-rules-')), PORT: 0, LLM_PROVIDER: 'mock', TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '', SUPPLIER_INDEX: false,
    OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '', ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
  };
  const s = startServer(config, { scheduler: false, llmFactory, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: path.join(__dirname, '..', 'samples', 'tenders') }) });
  const api = async (p, opts = {}) => { const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, opts); return { status: res.status, body: await res.json().catch(() => null) }; };
  try {
    const fd = new FormData();
    fd.append('files', new Blob([makeDocx(['Объект закупки: поставка постельных принадлежностей. Срок поставки товара: 10 календарных дней.', POSITIONS])]), 'Описание объекта закупки.docx');
    fd.append('number', 'RULES-1');
    fd.append('platform', 'Тестовая площадка');
    const r = await api('/api/tenders/manual', { method: 'POST', body: fd });
    assert.equal(r.status, 201);
    for (let i = 0; i < 200; i++) { if (['done', 'error'].includes(s.repo.getTender(r.body.id).analysis_status)) break; await new Promise((x) => setTimeout(x, 50)); }
    await s.analyses.idle();
    await s.manualIdle();
    const card = (await api(`/api/tenders/${r.body.id}`)).body;
    assert.equal(card.details.items_source, 'rules');
    assert.deepEqual(card.items.map((i) => [i.name, i.quantity, i.unit]), [['Подушка', 150, 'Шт'], ['Одеяло', 100, 'Шт']]);
    assert.equal(card.details.spec_status, 'done');
    assert.match(card.details.spec_note, /позиций с требованиями из ТЗ: 2 из 2; прочитано по правилам из таблицы документа, без нейросети/);
    const req = card.items[0].spec.required;
    assert.deepEqual(req.map((x) => [x.name, x.value, x.comparator]), [['Тип наполнителя', 'Искусственный', '='], ['Длина', '> 65 и ≤ 70 см', 'range']]);
    assert.ok(req.every((x) => x.source.verified && x.source.file === 'Описание объекта закупки.docx'), 'каждое требование подтверждено цитатой из документа');
    assert.deepEqual([card.details.items_coverage.status, card.details.items_coverage.method, card.details.spec_coverage.status, card.details.spec_coverage.reconcile.ok], ['complete', 'rules', 'complete', true]);
    // общий разбор нейросеть делала; позиции и требования — нет
    assert.ok(asked.includes('extract') && asked.includes('summary'));
    assert.ok(!asked.includes('items') && !asked.includes('spec'), `задачи нейросети: ${[...new Set(asked)]}`);
  } finally { await s.close(); }
});

test('у закупки вместо позиций заглушка (извещение не загрузилось): список и требования берутся из таблицы документа по правилам', async () => {
  const asked = [];
  const mock = createLlm('mock');
  const llmFactory = () => ({ ...mock, complete: async (args) => { asked.push(args.task); return mock.complete(args); } });
  const config = {
    ...baseConfig, ANALYSIS_READER: 'llm', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-rules-stub-')), PORT: 0, LLM_PROVIDER: 'mock', TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '', SUPPLIER_INDEX: false,
    OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '', ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
  };
  const s = startServer(config, { scheduler: false, llmFactory, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: path.join(__dirname, '..', 'samples', 'tenders') }) });
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE law = '44' LIMIT 1").get().id;
    const tender = s.repo.getTender(id);
    // как на сервере, когда источник не отдал извещение: одна строка на всю закупку
    s.repo.saveItems(id, [{ name: tender.title, characteristics: [], quantity: null, unit: null, sum: tender.price, source: 'notification' }], { source: 'fallback', error: 'Не удалось загрузить извещение' });
    const doc = await read('Приложение № 1. ООЗ.docx', makeDocx([POSITIONS]));
    const aId = 'a-rules-stub';
    s.repo.createAnalysis({ id: aId, title: 'Документация' });
    s.repo.addFile(aId, doc);
    s.repo.finishAnalysis(aId, { card: { groups: [] }, provider: 'mock', model: 'rules-v1', durationMs: 0 });
    s.repo.setTenderAnalysis(id, aId);
    asked.length = 0;
    const r = await s.details.ensureSpec(s.repo.getTender(id), { force: true });
    assert.deepEqual([r.status, r.matched], ['done', 2]);
    const d = s.repo.getDetails(id);
    assert.equal(d.items_source, 'tz', 'заглушка заменена позициями из документа');
    assert.match(d.spec_note, /прочитано по правилам из таблицы документа, без нейросети/);
    assert.deepEqual(s.repo.getItems(id).map((i) => [i.name, i.quantity, i.spec.required.length]), [['Подушка', 150, 2], ['Одеяло', 100, 1]]);
    assert.deepEqual(asked, [], 'нейросеть не вызывалась');

    // у одной из строк таблицы нет характеристик — правила не берут список наполовину, читает нейросеть
    const half = await read('ООЗ.docx', makeDocx([{ table: [['Наименование товара', 'Кол-во', 'Характеристики'], ['Бумага офисная', '10', 'Формат: А4\nПлотность: 80 г/м2'], ['Папка-регистратор', '5', '']] }]));
    const a2 = 'a-rules-stub-2';
    s.repo.createAnalysis({ id: a2, title: 'Документация 2' });
    s.repo.addFile(a2, half);
    s.repo.finishAnalysis(a2, { card: { groups: [] }, provider: 'mock', model: 'rules-v1', durationMs: 0 });
    const id2 = s.repo.db.prepare("SELECT id FROM tenders WHERE law = '44' AND id != ? LIMIT 1").get(id).id;
    s.repo.saveItems(id2, [{ name: 'Канцтовары', characteristics: [], quantity: null, unit: null, source: 'notification' }], { source: 'fallback' });
    s.repo.setTenderAnalysis(id2, a2);
    asked.length = 0;
    await s.details.ensureSpec(s.repo.getTender(id2), { force: true });
    assert.ok(asked.includes('spec'), 'неполную таблицу читает нейросеть');
  } finally { await s.close(); }
});
