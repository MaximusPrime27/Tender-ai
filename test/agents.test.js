// Пакет агентов, этап 1: журнал обучения, проверяющий находки, управляющий с дневным отчётом.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createJournal } = require('../server/agents/journal');
const { createChecker, staticProblems } = require('../server/agents/checker');
const { createManager } = require('../server/agents/manager');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  return openDb(path.join(dir, 'app.db'));
}

test('журнал: уроки копятся по коду и площадке, показатели — по дням, динамика против прошлых дней', () => {
  const repo = fresh();
  let t = new Date('2026-10-28T10:00:00Z');
  const j = createJournal({ repo, clock: () => t });
  j.lesson('bid', 'original', 'Нужен оригинал', { scope: 'ЭТП ГПБ', tenderId: 1 });
  j.lesson('bid', 'original', 'Нужен оригинал', { scope: 'ЭТП ГПБ', tenderId: 2 });
  j.lesson('bid', 'original', 'Нужен оригинал', { scope: 'Сбербанк-АСТ', tenderId: 3 });
  assert.equal(j.known('bid', 'ЭТП ГПБ')[0].count, 2);
  assert.equal(j.known('bid').length, 2);
  j.metric('bid', 'profitable', 2);
  t = new Date('2026-10-29T10:00:00Z');
  j.metric('bid', 'profitable', 4);
  t = new Date('2026-10-30T10:00:00Z');
  j.metric('bid', 'profitable', 5);
  assert.deepEqual(j.trend('bid', 'profitable'), { today: 5, avg: 3, days: 2 });
});

test('проверяющий без сети: оригинал против совместимого, спецпроверка, комплектующее, слишком дёшево', () => {
  assert.deepEqual(staticProblems({ name: 'Картридж оригинальный HP 85A' }, { title: 'Картридж GalaPrint CE285A', price: 500 }).map((p) => p.code), ['original']);
  assert.deepEqual(staticProblems({ name: 'Тонер-картридж (СП)' }, { title: 'Тонер-картридж Pantum TL-420', price: 900 }).map((p) => p.code), ['special_check']);
  assert.deepEqual(staticProblems({ name: 'Мышь', unit_price: 5000 }, { title: 'Мышь ExeGate SH-9027', price: 100 }).map((p) => p.code), ['too_cheap']);
  assert.deepEqual(staticProblems({ name: 'Мышь' }, null).map((p) => p.code), ['no_offer']);
  assert.deepEqual(staticProblems({ name: 'Мышь компьютерная', unit_price: 600 }, { title: 'Мышь ExeGate SH-9027', price: 145 }), []);
});

test('проверяющий: страница товара — пропала, цена выросла, нет в наличии; итог и уроки агенту заявок', async () => {
  const repo = fresh();
  const j = createJournal({ repo });
  const pages = {
    'https://a.ru/1': { status: 200, html: '<h1>Мышь ExeGate SH-9027</h1>', text: 'Мышь ExeGate SH-9027 Цена 300 ₽ В наличии' },
    'https://a.ru/2': { status: 404, html: '', text: '' },
  };
  const checker = createChecker({ repo, journal: j, fetchPage: async (u) => pages[u] });
  const x = (url, price) => ({ tender_id: 99, summary: { platform: 'Сбербанк-АСТ', items: [{ id: 0, name: 'Мышь компьютерная', unit_price: 600, offer: { title: 'Мышь ExeGate SH-9027', price, url } }] } });
  const ok = await checker.check(x('https://a.ru/1', 290));
  assert.equal(ok.verdict, 'ok');
  const up = await checker.check(x('https://a.ru/1', 145));
  assert.equal(up.verdict, 'hold');
  assert.equal(up.problems[0].code, 'price_up');
  const gone = await checker.check(x('https://a.ru/2', 145));
  assert.equal(gone.problems[0].code, 'page_gone');
  assert.ok(j.known('bid', 'Сбербанк-АСТ').some((l) => l.code === 'price_up' && l.source === 'checker'));
  assert.equal(j.trend('checker', 'checked').today, 3);
});

test('управляющий: состояние агентов, расход поиска, отчёт раз в день после часа отчёта', async () => {
  const repo = fresh();
  let t = new Date('2026-10-30T14:00:00Z'); // 17:00 по Москве
  const j = createJournal({ repo, clock: () => t });
  j.lesson('bid', 'original', 'Нужен оригинальный товар, найден совместимый', { source: 'checker' });
  const sent = [];
  const m = createManager({ repo, journal: j, config: { MANAGER_REPORT_HOUR: 20, SEARCH_DAILY_MAX_API_REQUESTS: 400 }, notify: async (h) => { sent.push(h); return true; }, clock: () => t });
  const v = m.view();
  assert.ok(v.agents.some((a) => a.id === 'checker'));
  assert.equal(v.spend.limit, 400);
  assert.equal(await m.tick(), false);
  t = new Date('2026-10-30T17:05:00Z'); // 20:05 по Москве
  assert.equal(await m.tick(), true);
  assert.equal(await m.tick(), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Чему научились/);
  assert.match(sent[0], /найден совместимый/);
});

// ---------- этап 2: читатель документов учится по извещению ЕИС ----------
const { grade, anchorsFrom, applyAnchors } = require('../server/analyze/learn');
const { createReaderLearner } = require('../server/agents/reader');
const doc = (text) => [{ id: 1, name: 'ТЗ.docx', status: 'ok', pages: [{ page: 1, text }] }];

test('читатель: сверка с ЕИС — совпало, не то, не нашёл; суммы с пробелами и проценты', () => {
  const g = grade([
    { key: 'nmck', value: '1 250 000,00 руб.' },
    { key: 'contract_security', value: '10% от цены контракта' },
  ], { nmck: '1 250 000,00 ₽', contract_security: '5 % от цены контракта', bid_security: 'не требуется' });
  assert.deepEqual(g.map((x) => [x.key, x.result]), [['nmck', 'agree'], ['bid_security', 'missed'], ['contract_security', 'mismatch']]);
});

test('читатель: опора из документа по значению ЕИС — и поле по опоре в закупке без извещения', () => {
  const a = anchorsFrom(doc('Раздел 8. Размер обеспечения исполнения договора устанавливается в размере 5 (пяти) % от начальной цены.'), 'contract_security', '5 % от цены контракта');
  assert.deepEqual(a, ['размер обеспечения исполнения договора устанавливается']);
  const f = applyAnchors(doc('11. Размер обеспечения исполнения договора устанавливается: 3% от цены договора.'), [{ key: 'contract_security', anchor: a[0] }]);
  assert.equal(f.length, 1);
  assert.match(f[0].value, /3%/);
  assert.equal(f[0].learned, a[0]);
  // поле уже найдено правилами — опора не нужна
  assert.equal(applyAnchors(doc('Размер обеспечения исполнения договора устанавливается: 3%.'), [{ key: 'contract_security', anchor: a[0] }], new Set(['contract_security'])).length, 0);
});

test('читатель: опора в работе после 2 закупок, подтверждения и ошибки считаются, уроки по площадке', () => {
  const repo = fresh();
  const j = createJournal({ repo });
  const L = createReaderLearner({ repo, journal: j });
  const cand = { key: 'contract_security', anchor: 'размер обеспечения исполнения договора' };
  L.record({ grades: [{ key: 'contract_security', result: 'missed', eis: '5 %' }], candidates: [cand] }, { platform: 'ЭТП ГПБ', tenderId: 1 });
  assert.equal(L.active().length, 0);
  L.record({ grades: [], candidates: [cand] }, { platform: 'ЭТП ГПБ' });
  assert.equal(L.active().length, 1);
  L.record({ grades: [{ key: 'contract_security', result: 'agree', eis: '5 %', learned: cand.anchor }] });
  for (let i = 0; i < 4; i++) L.record({ grades: [{ key: 'contract_security', result: 'mismatch', eis: '5 %', rules: '1%', learned: cand.anchor }] });
  assert.equal(L.active().length, 0); // 1 верно, 4 ошибки — выбыла
  assert.ok(j.known('reader', 'ЭТП ГПБ').some((l) => l.code === 'missed_contract_security'));
  const acc = L.accuracy();
  assert.equal(acc.checked, 6);
  assert.equal(acc.today, 17);
});

test('читатель: значения нет в документах — не ошибка; опора без смыслового слова не запоминается', () => {
  const g = grade([], { nmck: '480 000,00 ₽', bid_deadline: '05.11.2026 09:00' }, doc('Начальная цена контракта: 480 000,00 руб. Срок подачи — в извещении.'));
  assert.deepEqual(g.map((x) => [x.key, x.result]), [['nmck', 'missed'], ['bid_deadline', 'absent']]);
  assert.deepEqual(anchorsFrom(doc('Пила хирургическая ручная проволочная штука 125 000,00'), 'nmck', '125 000 ₽'), []);
});

test('читатель: смысловое слово — с начала слова («концентратор» не «цена»)', () => {
  assert.deepEqual(anchorsFrom(doc('Концентратор кислорода мобильный портативный штука 125 000,00'), 'nmck', '125 000 ₽'), []);
  assert.deepEqual(anchorsFrom(doc('Установлена начальная максимальная цена контракта 125 000,00 руб.'), 'nmck', '125 000 ₽'), ['установлена начальная максимальная цена контракта']);
});

test('читатель: НМЦК — сокращением и не по первому упоминанию (выучено по ЕИС)', () => {
  const { readByRules } = require('../server/analyze/rules');
  const v = (t) => readByRules(doc(t)).fields.find((f) => f.key === 'nmck')?.value;
  assert.equal(v('На основании проведенных расчетов НМЦК составляет: 39456 рублей.'), '39 456,00 руб.');
  assert.equal(v('Итого НМЦК, Российский рубль 34 860,00'), '34 860,00 руб.');
  assert.equal(v('| Начальная (максимальная) цена контракта, руб. 1 | Мочеприемник |\nНачальная (максимальная) цена Контракта составляет: 112320,00 (Сто двенадцать тысяч) рублей.'), '112 320,00 руб.');
});

test('читатель ТЗ: столбцы «Наименование закупаемой услуги», «Тип товара», «Штук»; пары через тире; печатная форма ЕИС в строку', () => {
  const { itemsFromTables } = require('../server/tenders/rule-items');
  const read = (t) => itemsFromTables(doc(t)).items;
  const a = read('№; п/п | Наименование закупаемой услуги, входящей в объект закупки | Требования к характеристикам | Единица измерения | Штук\n1 | Картридж TN-2375 | Цвет: чёрный; Ресурс (страниц): 10000 | шт | 10');
  assert.equal(a.length, 1);
  assert.equal(a[0].quantity, 10);
  assert.deepEqual(a[0].characteristics.map((c) => c.value), ['чёрный', '10000']);
  const b = read('№ п/п | Тип товара; ОКПД2/КТРУ | Характеристики | Единица измерения | Кол-во\n1. | Аккумуляторы свинцовые; 27.20.21.000 | Напряжение – 12 Вольт; Пусковой ток аккумулятора -> 600 и ≤ 700 Ампер | штука | 2');
  assert.deepEqual(b[0].characteristics.map((c) => [c.name, c.value]), [['Напряжение', '12 Вольт'], ['Пусковой ток аккумулятора', '> 600 и ≤ 700 Ампер']]);
  const c = read('Стойка; Идентификатор: 224762212; 31.01.12.190; Товар; Штука; 1.00000000000\nХарактеристики товара, работы, услуги ( Стойка ); Наименование характеристики; Значение характеристики; Единица измерения характеристики; Инструкция по заполнению характеристики в заявке; Длина; ≥ 2550 и ≤ 2650; Миллиметр; Участник закупки указывает в заявке конкретное значение характеристики; Обоснование включения дополнительной информации в сведения о товаре; Вид материала каркаса; ЛДСП; Значение характеристики не может изменяться участником закупки');
  assert.equal(c[0].name, 'Стойка');
  assert.equal(c[0].quantity, 1);
  assert.deepEqual(c[0].characteristics.map((x) => [x.name, x.value]), [['Длина', '≥ 2550 и ≤ 2650 Миллиметр'], ['Вид материала каркаса', 'ЛДСП']]);
});

test('читатель ТЗ: шапка характеристик в строке товара; характеристика в самой строке товара; список ячейкой с инструкциями', () => {
  const { itemsFromTables } = require('../server/tenders/rule-items');
  const read = (t) => itemsFromTables(doc(t)).items;
  const a = read('№; п/п | Наименование товара[1] | Ед.; изм. | Кол-во | Наименование показателя [2] | Содержание (значение) показателя[3] | Инструкция участнику закупки\n1 | Сельдь соленая | кг | 200.0000 | Вид разделки; Филе без кожи; Код позиции КТРУ; 10.20.23.122-00000004; Значение характеристики не может изменяться участником закупки; Вид засола; Слабосоленая; Значение характеристики не может изменяться участником закупки');
  assert.equal(a[0].quantity, 200);
  assert.deepEqual(a[0].characteristics.map((c) => [c.name, c.value]), [['Вид разделки', 'Филе без кожи'], ['Вид засола', 'Слабосоленая']]);
  const b = read('№; п/п | ОКПД2 | Наименование товара | Наименование характеристики | Значение характеристики | Единица измерения характеристики | Инструкция | Ед. изм. | Кол-во\n1 | 32.50.50.190 | Кювета для анализатора | Количество емкостей в одном сегменте | ≥ 9 | штука | Участник закупки указывает в заявке конкретное значение характеристики | штука | 54\n″ | ″ | ″ | Материал изделия | пластик |  | Значение характеристики не может изменяться участником закупки | ″ | ″');
  assert.equal(b[0].quantity, 54);
  assert.equal(b[0].unit, 'штука');
  assert.deepEqual(b[0].characteristics.map((c) => [c.name, c.value]), [['Количество емкостей в одном сегменте', '≥ 9 штука'], ['Материал изделия', 'пластик']]);
});

// ---------- этап 3: агент подготовки заявки ----------
const { createApplicationAgent } = require('../server/agents/application');

test('подготовка заявки: уроки по площадке, новое требование после 5 заявок, «готово» только без критичных', () => {
  const repo = fresh();
  const j = createJournal({ repo });
  const A = createApplicationAgent({ repo, journal: j });
  const view = (id, reqs = []) => ({ id, findings: [{ type: 'product_mismatch', severity: 'critical', text: 'цвет', status: 'open' }], package: { built: { files: [{ path: 'Заявка.docx', todo: 2 }] } }, readiness: { counters: { mandatory_fail: 0 } }, dossier: { exists: true, complete: true }, requirements: reqs });
  const r = A.review(view(1), { platform: 'ЭТП ГПБ', law: '44' });
  assert.equal(r.ready, false);
  assert.deepEqual(r.problems.map((p) => p.code), ['finding_product_mismatch', 'todo_file']);
  assert.ok(j.known('application', 'ЭТП ГПБ · 44-ФЗ').some((l) => l.code === 'todo_file'));
  for (let i = 2; i <= 6; i++) A.review(view(i, [{ origin: 'rule', legal_rule_ids: ['r1'], requirement: 'Декларация' }]), { platform: 'ЭТП ГПБ', law: '44' });
  assert.ok(!j.known('application').some((l) => l.code === 'new_requirement'));
  A.review(view(7, [{ origin: 'rule', legal_rule_ids: ['r9'], requirement: 'Новая форма' }]), { platform: 'ЭТП ГПБ', law: '44' });
  assert.ok(j.known('application').some((l) => l.code === 'new_requirement'));
  const ok = A.review({ id: 8, findings: [], package: { built: { files: [] } }, dossier: { exists: true, complete: true } }, {});
  assert.equal(ok.ready, true);
});

test('подготовка заявки: знак и страна из ваших прежних правок того же товара', () => {
  const repo = fresh();
  const j = createJournal({ repo });
  const db = repo.db;
  db.prepare("INSERT INTO tenders (id, law, number, title, first_seen_at) VALUES (1,'44','1','a','x'), (2,'44','2','b','x')").run();
  const offer = (tid) => repo.db.prepare("INSERT INTO offers (tender_id, item_id, source, title, url, created_at) VALUES (?, 0, 'manual', 'Мышь ExeGate SH-9027', 'https://a.ru/m', 'x')").run(tid).lastInsertRowid;
  const mk = (tid, oid) => db.prepare("INSERT INTO tender_items (tender_id, idx, name, source, purchase_offer_id) VALUES (?, 0, 'Мышь', 'notification', ?)").run(tid, oid).lastInsertRowid;
  const i1 = mk(1, offer(1));
  const i2 = mk(2, offer(2));
  repo.setSetting(`bidchars:${i1}`, JSON.stringify({ trademark: 'ExeGate', country: 'Китай' }));
  const saved = [];
  const A = createApplicationAgent({ repo, journal: j, charService: { save: (t, x) => saved.push([t, x]) } });
  assert.equal(A.prefill(2), 1);
  assert.deepEqual(saved[0], [2, { item_id: Number(i2), trademark: 'ExeGate', country: 'Китай' }]);
});

// ---------- этап 4: разведчик поставщиков ----------
const { createSourcesAgent } = require('../server/agents/sources');

test('разведчик поставщиков: хорошие сайты — в каталог, пустые — вон, слабая ниша — агенту поиска', () => {
  const repo = fresh();
  const j = createJournal({ repo });
  const db = repo.db;
  db.prepare("INSERT INTO tenders (id, law, number, title, first_seen_at, direction) VALUES (1,'44','1','a','x','medical')").run();
  const add = (domain, match, n) => { for (let i = 0; i < n; i++) db.prepare("INSERT INTO offers (tender_id, item_id, source, domain, match, created_at) VALUES (1, 0, 'yandex', ?, ?, ?)").run(domain, match, new Date().toISOString()); };
  add('good.ru', 'соответствует', 3); add('good.ru', 'не соответствует', 2);
  add('empty.ru', 'не соответствует', 9);
  add('ozon.ru', 'соответствует', 5);
  repo.setSetting('offers:discovered_suppliers', JSON.stringify([{ site: 'empty.ru' }]));
  require('../server/tenders/bid-agent').createBidAgent({ repo, log: { warn() {}, log() {} } });
  for (let i = 0; i < 8; i++) {
    db.prepare("INSERT INTO tenders (law, number, title, first_seen_at, direction) VALUES ('44', ?, 'b', 'x', 'medical')").run(`n${i}`);
    db.prepare("INSERT INTO bid_agent_items (tender_id, status, reason, created_at, updated_at) VALUES (?, 'rejected', ?, ?, ?)").run(i + 2, i < 5 ? 'нет подходящего товара: …' : 'невыгодно', new Date().toISOString(), new Date().toISOString());
  }
  const S = createSourcesAgent({ repo, journal: j });
  const r = S.run();
  assert.deepEqual(JSON.parse(repo.getSetting('offers:discovered_suppliers')).map((x) => x.site), ['good.ru']);
  assert.equal(r.weak, 1);
  assert.deepEqual(JSON.parse(repo.getSetting('scout:auto_niches')), ['medical']);
  assert.ok(j.known('scout').some((l) => l.code === 'weak_niche'));
});

test('читатель ТЗ: характеристики строкой под таблицей; ячейка со своей шапкой «Показатель; Значение; …»', () => {
  const { itemsFromTables } = require('../server/tenders/rule-items');
  const read = (t) => itemsFromTables(doc(t)).items;
  const a = read('№; п/п | Наименование | Количество\n | МФУ лазерное Kyocera ECOSYS MA4000x | 1\n\nМФУ лазерное Kyocera ECOSYS MA4000x– всего 1 шт.\nОсновные характеристики:; Тип - МФУ лазерное; Оперативная память - 1024 МБ; Размещение - настольный');
  assert.deepEqual(a[0].characteristics.map((c) => [c.name, c.value]), [['Тип', 'МФУ лазерное'], ['Оперативная память', '1024 МБ'], ['Размещение', 'настольный']]);
  const b = read('№; п/п | Наименование товара | Функциональные, технические характеристики | Ед. изм. | Кол-во\n1 | Стекло предметное | Показатель; Значение; показателя; Единица измерения показателя; Инструкция по заполнению характеристик в заявке; Адгезивное покрытие; Да; Значение характеристики не может изменяться участником закупки; Длина; ≥ 75; Миллиметр; Участник закупки указывает в заявке конкретное значение характеристики | шт | 100');
  assert.deepEqual(b[0].characteristics.map((c) => [c.name, c.value]), [['Адгезивное покрытие', 'Да'], ['Длина', '≥ 75 Миллиметр']]);
});

// ---------- этап 5: итоги торгов ----------
const { createOutcomesAgent } = require('../server/agents/outcomes');

test('итоги торгов: снижение по заказчику и нише, ошибка прогноза агента заявок, лимит запросов', async () => {
  const repo = fresh();
  const j = createJournal({ repo });
  const db = repo.db;
  require('../server/tenders/bid-agent').createBidAgent({ repo, log: { warn() {}, log() {} } });
  const past = new Date(Date.now() - 20 * 86400e3).toISOString();
  for (let i = 1; i <= 6; i++) db.prepare("INSERT INTO tenders (id, law, number, title, first_seen_at, direction, customer_inn, price, deadline_at) VALUES (?, '44', ?, 't', 'x', 'office', ?, 100000, ?)").run(i, `N${i}`, i <= 2 ? '7700000001' : '7700000002', past);
  db.prepare("INSERT INTO bid_agent_items (tender_id, status, summary_json, created_at, updated_at) VALUES (1, 'ready', ?, 'x', 'x')").run(JSON.stringify({ econ: { decline_pct: 5 } }));
  const prices = { N1: 70000, N2: 72000, N3: 90000, N4: 88000, N5: 91000, N6: 0 };
  const O = createOutcomesAgent({ repo, journal: j, source: { contractsByPurchase: async (n) => (prices[n] ? [{ price: prices[n], supplier_inn: '5000000000' }] : []) }, config: { OUTCOMES_EVERY_MIN: 0, OUTCOMES_DAILY: 5 } });
  for (let i = 0; i < 8; i++) await O.tick();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outcomes WHERE status = 'done'").get().n, 5); // лимит 5 в сутки
  assert.deepEqual(O.decline('office', '7700000001'), { pct: 29, samples: 2, by: 'customer' });
  assert.deepEqual(O.decline('office', '7700000002'), { pct: 10, samples: 3, by: 'customer' });
  assert.deepEqual(O.decline('office', '7799999999'), { pct: 12, samples: 5, by: 'niche' });
  assert.ok(j.known('bid').some((l) => l.code === 'decline_forecast')); // ждали 5%, было 30%
});

test('рабочий процесс получает всех агентов: разведчика поставщиков и итоги торгов', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'server.js'), 'utf8');
  const ret = src.split(String.fromCharCode(10)).find((l) => l.includes('server, repo, analyses, sync, digest')) || '';
  const names = ret.split(',').map((s) => s.trim());
  for (const name of ['manager', 'sourcesAgent', 'outcomesAgent']) assert.ok(names.includes(name), name);
});

test('итоговый пакет: ваш выбор документа ставится сам, сбой — пересборка, ошибки файлов — уроки, исправленное считается', async () => {
  const { createPackager } = require('../server/agents/packager');
  const repo = fresh();
  const j = createJournal({ repo });
  const line = (choice) => ({ id: 'signer-poa', closure: 'dossier_document', doc_kinds: ['power_of_attorney'], state: 'missing', candidates: [{ id: 7 }, { id: 9 }], ...(choice ? { choice } : {}) });
  const file = (o = {}) => ({ id: 'product-proposal', path: 'part1/Предложение.docx', todo: 0, check: { ok: true, issues: [] }, ...o });
  let state = { checklist: [line({ document_id: 9, by: 'Иванов' })], package: { built: { current: true, files: [file()], fields: [] } } };
  const calls = [];
  const bids = {
    view: () => state,
    blockers: () => (state.package.built.files.some((f) => f.todo) ? ['незаполнено'] : []),
    choose: async (id, lineId, o) => calls.push(['choose', lineId, o.document_id, o.by]),
    draft: async () => { calls.push(['draft']); state = { ...state, package: { built: { ...state.package.built, current: true } } }; },
  };
  const p = createPackager({ repo, journal: j, bids });
  // первая заявка: вы выбрали доверенность 9 — запомнено; пакет готов
  let r = await p.afterDraft(1, { platform: 'ЭТП ГПБ', law: '44' });
  assert.equal(r.final_ok, true);
  assert.equal(p.stats().memory, 1);
  // вторая заявка: строка без выбора — агент ставит 9 и пересобирает; в файле незаполненные места — урок
  state = { checklist: [line()], package: { built: { current: true, files: [file({ todo: 2 })], fields: [] } } };
  r = await p.afterDraft(2, { platform: 'ЭТП ГПБ', law: '44' });
  assert.deepEqual(calls[0].slice(0, 3), ['choose', 'signer-poa', 9]);
  assert.equal(r.redrafted, 1);
  assert.equal(r.final_ok, false);
  assert.equal(j.known('package', 'ЭТП ГПБ · 44-ФЗ')[0].code, 'product-proposal:todo');
  // проверяющий: «готово», а в файле пусто — урок агенту пакета
  const ch = createChecker({ repo, journal: j, fetchPage: async () => null });
  assert.equal(ch.checkPackage({ tender_id: 2 }, { final_ok: true }, state).length, 1);
  assert.ok(j.known('package').some((l) => l.code === 'final_not_ready'));
  // исправили — в следующей сборке той же заявки ошибки нет: «исправлено 1»
  state = { checklist: [line({ document_id: 9, by: BYX() })], package: { built: { current: false, files: [file()], fields: [] } } };
  r = await p.afterDraft(2, { platform: 'ЭТП ГПБ', law: '44' });
  assert.equal(r.fixed, 1);
  assert.equal(r.final_ok, true);
  function BYX() { return require('../server/agents/packager').BY; }
});

test('страна и знак: из характеристик разных сайтов, ФСЗ — не Россия, страница товара, ваша правка — урок', async () => {
  const { fromSpecs, fromText, createMarksFinder } = require('../server/agents/marks');
  assert.deepEqual(fromSpecs([{ name: 'Производитель', value: 'Exegate' }, { name: 'Место изготовления товара', value: 'КИТАЙ' }]).country, 'Китай');
  assert.equal(fromSpecs([{ name: 'Производитель', value: 'Exegate' }]).trademark, 'Exegate');
  const pak = fromSpecs([{ name: 'Производитель', value: 'Пакистан, Surgiwell' }]);
  assert.equal(pak.country, 'Пакистан');
  assert.equal(pak.trademark, 'Surgiwell');
  assert.equal(fromSpecs([{ name: 'Страна производства', value: 'РОССИЯ' }, { name: 'Производитель', value: 'Полимерные изделия' }]).country, 'Россия');
  assert.equal(fromSpecs([{ name: 'Производитель / Бренд', value: 'Alba Healthcare ?' }, { name: 'Регистрация Минздрава', value: 'ФСЗ 2009/04992 ?' }, { name: 'Страна', value: 'Россия' }]).country, null);
  assert.equal(fromSpecs([{ name: 'Производитель / Бренд', value: 'Alba Healthcare ?' }]).trademark, 'Alba Healthcare');
  assert.equal(fromText('Описание. Страна производства: Китай\nВес 1 кг').country, 'Китай');

  const repo = fresh();
  const j = createJournal({ repo });
  const saved = {};
  const charService = { save: async (tid, p) => { saved[p.item_id] = { ...(saved[p.item_id] || {}), ...p }; repo.setSetting(`bidchars:${p.item_id}`, JSON.stringify(saved[p.item_id])); } };
  const m = createMarksFinder({ repo, journal: j, fetchPage: async () => ({ html: '<table><tr><td>Страна изготовления</td><td>Германия</td></tr><tr><td>Бренд</td><td>Hartmann</td></tr><tr><td>Объем</td><td>2000 мл</td></tr></table>', text: '' }) });
  const offer = { id: 5, domain: 'sigma-med.ru', url: 'https://sigma-med.ru/x', title: 'Мочеприемник 2000 мл', specs: [] };
  const n = await m.fill(1, { tables: [{ item_id: 11, trademark: null, country: null }] }, () => offer, charService);
  assert.equal(n, 1);
  assert.equal(saved[11].country, 'Германия');
  assert.equal(saved[11].trademark, 'Hartmann');
  assert.equal(m.judge(), 0); // своё значение — не ошибка
  repo.setSetting('bidchars:11', JSON.stringify({ country: 'Китай', trademark: 'Hartmann' }));
  assert.equal(m.judge(), 1);
  assert.ok(j.known('package', 'sigma-med.ru').some((l) => l.code === 'marks_wrong'));
});

test('страна и знак: та же модель у другого поставщика — спорное, только подсказка; вписали сами — подсказки нет', async () => {
  const { createMarksFinder } = require('../server/agents/marks');
  const repo = fresh();
  const j = createJournal({ repo });
  repo.db.prepare("INSERT INTO tenders (id, law, number, title, first_seen_at) VALUES (1, '44', 'N1', 'Щиты', 'x')").run();
  repo.db.prepare("INSERT INTO tender_items (id, tender_id, idx, name, characteristics_json, source) VALUES (11, 1, 0, 'Щит', '[]', 't')").run();
  repo.db.prepare("INSERT INTO offers (id, tender_id, item_id, source, match_notes_json, trust_reasons_json, title, domain, specs_json, created_at) VALUES (900, 1, 11, 'web', '[]', '[]', 'Щит спинальный YXH-1A6A', 'bestkanc.ru', ?, '2026-10-30')").run(JSON.stringify([{ name: 'Страна производства', value: 'Россия' }]));
  const saved = {};
  const charService = { save: async (tid, p) => { saved[p.item_id] = p; } };
  const m = createMarksFinder({ repo, journal: j });
  const offer = { id: 5, domain: 'mebelmed.ru', title: 'Щит спинальный YXH-1A6A с ремнями', specs: [] };
  const n = await m.fill(1, { tables: [{ item_id: 11, trademark: 'X', country: null }] }, () => offer, charService);
  assert.equal(n, 0);
  assert.equal(saved[11], undefined);
  assert.equal(m.suggestions(1)[0].country, 'Россия');
  repo.setSetting('bidchars:11', JSON.stringify({ country: 'Китай' }));
  assert.equal(m.suggestions(1).length, 0);
});

test('управляющий: подсказки страны совпали с вашими решениями 20 из 20 — одно сообщение «можно включать автономно»', async () => {
  const repo = fresh();
  const j = createJournal({ repo });
  const sent = [];
  let ready = false;
  const packager = { stats: () => ({ built: { today: 0 }, final_ok: { today: 0 }, top: [], memory: 0, suggest: [{ kind: 'та же модель у других поставщиков', n: 20, agree: ready ? 20 : 15, share: ready ? 100 : 75, ready, need: 20 }] }) };
  const m = createManager({ repo, journal: j, packager, notify: async (t) => { sent.push(t); return true; }, clock: () => new Date('2026-10-30T08:00:00Z') });
  await m.watch();
  assert.equal(sent.length, 0);
  ready = true;
  await m.watch();
  await m.watch();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Можно включать автономно/);
});

test('итоговый пакет в автомате: подтверждает декларацию всеми положениями и утверждает цену, выключается auto:false', async () => {
  const { createPackager, AUTO_BY } = require('../server/agents/packager');
  const repo = fresh();
  const j = createJournal({ repo });
  const calls = [];
  const view = { checklist: [], requirements: [{ id: 'r1', evidence_kind: 'attestation', applicability: 'applies' }], attestations: [], package: { built: { current: true, files: [], fields: [] } } };
  const bids = {
    view: () => view, blockers: () => [], draft: async () => calls.push(['draft']),
    declarationIds: () => ['s1', 's2'],
    priceState: () => ({ required: true, approved: false, own: 1000 }),
    attest: async (id, rid, o) => calls.push(['attest', rid, o.by, o.statements]),
    approvePrice: async (id, o) => calls.push(['price', o.by]),
  };
  const r = await createPackager({ repo, journal: j, bids }).afterDraft(1, {});
  assert.deepEqual(calls[0], ['attest', 'r1', AUTO_BY, ['s1', 's2']]);
  assert.deepEqual(calls[1], ['price', AUTO_BY]);
  assert.equal(r.auto, 2);
  calls.length = 0;
  await createPackager({ repo, journal: j, bids, auto: false }).afterDraft(1, {});
  assert.ok(!calls.some((c) => c[0] === 'attest' || c[0] === 'price'));
  // данные изменились после проверки — сначала «проверить заново», потом подтверждение
  calls.length = 0;
  const stale = { ...view, stale: true };
  await createPackager({ repo, journal: j, bids: { ...bids, view: () => stale, rebuild: async () => { calls.push(['rebuild']); return view; } } }).afterDraft(1, {});
  assert.deepEqual(calls.slice(0, 2).map((c) => c[0]), ['rebuild', 'attest']);
});

test('наладчик: повторяет закупки, где ЕИС не отдал файлы, через 2 часа после отказа; неизлечимое — владельцу раз в сутки', async () => {
  const { createFixer } = require('../server/agents/fixer');
  const repo = fresh();
  let t = new Date('2026-10-31T06:00:00Z');
  const j = createJournal({ repo, clock: () => t });
  repo.db.exec(`CREATE TABLE IF NOT EXISTS bid_agent_items (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, tender_id INTEGER NOT NULL, status TEXT NOT NULL, step TEXT,
      reason TEXT, summary_json TEXT, findings_json TEXT, decision TEXT, decision_note TEXT, decided_at TEXT, outcome_json TEXT, outcome_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const add = (tid, status, reason, at) => repo.db.prepare('INSERT INTO bid_agent_items (tender_id, status, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(tid, status, reason, at, at);
  const tenders = { 1: { id: 1, deadline_at: '2026-11-10T00:00:00Z' }, 2: { id: 2, deadline_at: '2026-11-01T00:00:00Z' } };
  repo.getTender = (id) => tenders[id] || null;
  add(1, 'error', 'Не удалось скачать документацию из ЕИС (4 файл.): ЕИС ответил 434.', '2026-10-31T05:00:00Z');
  add(2, 'error', 'Не удалось скачать документацию из ЕИС (1 файл.): ЕИС ответил 434.', '2026-10-31T05:00:00Z');
  for (let i = 0; i < 3; i++) add(10 + i, 'error', 'Непонятная ошибка разбора 42', '2026-10-31T05:30:00Z');
  const runs = [];
  const bidAgent = { settings: () => ({ min_days: 3 }), isRunning: () => false, run: async ({ tenderIds }) => { runs.push(tenderIds); for (const id of tenderIds) add(id, 'needs_work', '', t.toISOString()); return { stats: {} }; } };
  const sent = [];
  const fx = createFixer({ repo, journal: j, bidAgent, notify: async (m) => { sent.push(m); return true; }, clock: () => t });
  // через час после отказа ЕИС — рано
  assert.equal(fx.plan().length, 0);
  t = new Date('2026-10-31T07:10:00Z');
  // закупка 2 — срок подачи ближе запаса дней — не повторяется
  assert.deepEqual(fx.plan().map((x) => x.tender_id), [1]);
  const r = await fx.tick();
  assert.deepEqual(runs[0], [1]);
  assert.equal(r.fixed, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /нужна доработка/);
  t = new Date('2026-10-31T08:00:00Z');
  await fx.tick();
  assert.equal(sent.length, 1, 'раз в сутки');
  assert.equal(fx.stats().fixed, 1);
});

test('управляющий: повторившаяся ошибка становится задачей, через срок проверяется по числам', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { createJournal } = require('../server/agents/journal');
  const { createManager } = require('../server/agents/manager');
  let t = new Date('2026-10-31T10:00:00Z');
  const clock = () => t;
  const db = new DatabaseSync(':memory:');
  const repo = { db, getSetting: () => null, setSetting() {} };
  const journal = createJournal({ repo, clock });
  const m = createManager({ repo, journal, clock, log: {} });
  for (let i = 0; i < 3; i++) journal.lesson('bid', 'other_kind', 'Другой товар', { scope: 'Катетер' });
  journal.lesson('bid', 'нечто', 'Редкое');
  assert.equal(m.planTasks().length, 1);
  assert.equal(m.planTasks().length, 0, 'вторая задача на ту же ошибку не ставится');
  const [task] = m.tasks();
  assert.equal(task.whom, 'kinds');
  assert.equal(task.whom_name, 'Знаток товара');
  journal.lesson('bid', 'other_kind', 'Другой товар', { scope: 'Катетер' });
  t = new Date('2026-11-08T10:00:00Z');
  const [done] = m.verifyTasks();
  assert.equal(done.status, 'failed');
  assert.match(m.tasks()[0].result, /новых ошибок: 1/);
});
