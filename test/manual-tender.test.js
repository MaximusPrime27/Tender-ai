// Закупка, добавленная вручную из своих документов (например, скачанных с ЕАТ «Берёзка»): загрузка файлов → обычная
// карточка закупки → разбор, позиции, расчёт. К источникам и в сеть сервис при этом не ходит.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { parseMoney, parseDate, innFrom } = require('../server/tenders/manual');
const { keepKnown } = require('../server/tenders/details');
const { makeDocx, NOTICE_PAGES, TZ, CONTRACT } = require('../samples/make-samples');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timeout');
    await sleep(100);
  }
}

function start() {
  const config = {
    ...baseConfig, ANALYSIS_READER: 'llm', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-manual-')), PORT: 0, LLM_PROVIDER: 'mock', TENDER_SOURCE: 'fixture', FIXTURES_DIR: FIX,
    TELEGRAM_BOT_TOKEN: '', SUPPLIER_INDEX: false, OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
  };
  // Источник считает обращения по закупкам, добавленным вручную: их быть не должно. Сеть закрыта совсем.
  const asked = [];
  const fixture = createFixtureSource({ dir: FIX });
  const source = {
    ...fixture,
    getDetailsDoc: async (t) => { if (t?.source === 'manual') asked.push(`getDetailsDoc ${t.number}`); return fixture.getDetailsDoc ? fixture.getDetailsDoc(t) : null; },
    getAttachments: async (t) => { if (t?.source === 'manual') asked.push(`getAttachments ${t.number}`); return fixture.getAttachments(t); },
  };
  const net = [];
  const fetchImpl = async (url) => { net.push(String(url)); throw new Error('сеть в этом тесте закрыта'); };
  const s = startServer(config, { scheduler: false, fetchImpl, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: source });
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, {
      ...opts, headers: opts.json ? { 'Content-Type': 'application/json' } : opts.headers, body: opts.json ? JSON.stringify(opts.json) : opts.body,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { s, api, asked, net, config };
}

/** Форма добавления: файлы заказчика и поля. */
function form(fields = {}, files = { 'Извещение.docx': NOTICE_PAGES.flat(), 'Техническое задание.docx': TZ }) {
  const fd = new FormData();
  for (const [name, paragraphs] of Object.entries(files)) fd.append('files', new Blob([makeDocx(paragraphs)]), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** Дождаться, пока документы прочитаны и из них собраны позиции и требования. */
async function ready(s, api, id) {
  await waitFor(async () => {
    const t = s.repo.getTender(id);
    return ['done', 'error'].includes(t.analysis_status) ? t : null;
  });
  await s.analyses.idle();
  await s.manualIdle();
  return (await api(`/api/tenders/${id}`)).body;
}

test('разбор полей из документов: цена, срок подачи, ИНН', () => {
  assert.equal(parseMoney('Начальная (максимальная) цена контракта: 1 250 000,00 рублей.'), 1250000);
  assert.equal(parseMoney('325 000 руб.'), 325000);
  assert.equal(parseMoney('1,2 млн руб.'), 1200000);
  assert.equal(parseMoney('цена не указана'), null);
  assert.equal(parseDate('Дата и время окончания срока подачи заявок: 29.09.2026 09:00 (МСК).'), '2026-09-29T06:00:00.000Z');
  assert.equal(parseDate('до 5 октября 2026 г. 18:30'), '2026-10-05T15:30:00.000Z');
  assert.equal(parseDate('15 мая 2027 года'), '2027-05-15T20:59:00.000Z', 'без времени — конец дня по Москве');
  assert.equal(parseDate('в течение 10 дней'), null);
  assert.equal(innFrom('ГБУ «Поликлиника № 7», ИНН 7701234567'), '7701234567');
  assert.equal(innFrom('телефон 84951234567'), null);
});

test('повторное чтение документов: та же позиция, названная чуть иначе, остаётся прежней записью (с ценами и поставщиками)', () => {
  const saved = [
    { id: 1, name: 'Картридж HP CF259A (59A) оригинальный, чёрный', quantity: 10, unit: 'шт', characteristics: [{ name: 'Ресурс', value: 'не менее 3000 страниц' }],
      spec: { required: [{ name: 'Ресурс', value: 'не менее 3000 страниц' }] } },
    { id: 2, name: 'Картридж Kyocera TK-1170 оригинальный, чёрный', quantity: 6, unit: 'шт', characteristics: [{ name: 'Цвет', value: 'чёрный' }], spec: null },
  ];
  const fresh = [
    { name: 'Картридж HP CF259A (59A) оригинальный, чёрный, ресурс не менее 3000 страниц', quantity: 10, unit: 'штук', characteristics: [], source: 'llm' },
    { name: 'Картридж Kyocera TK-1170 оригинальный, чёрный, ресурс не менее 7200 страниц', quantity: 6, unit: 'шт', characteristics: [], source: 'llm' },
    { name: 'Бумага офисная А4, 80 г/м2', quantity: 40, unit: 'пачек', characteristics: [], source: 'llm' },
    { name: 'Картридж HP CF259A (59A) оригинальный, чёрный', quantity: 4, unit: 'шт', characteristics: [], source: 'llm' },
  ];
  const out = keepKnown(fresh, saved);
  // прежние название и единица; характеристики, дописанные чтением ТЗ, считаются пустыми — так позицию узнаёт saveItems
  assert.deepEqual([out[0].name, out[0].unit, out[0].characteristics], [saved[0].name, 'шт', []]);
  assert.deepEqual([out[1].name, out[1].characteristics], [saved[1].name, saved[1].characteristics]);
  assert.equal(out[2].name, 'Бумага офисная А4, 80 г/м2', 'новая позиция остаётся новой');
  assert.equal(out[3].name, fresh[3].name);
  assert.equal(out[3].quantity, 4, 'другое количество — другая позиция');
  assert.deepEqual(keepKnown([{ name: 'Мышь компьютерная', quantity: 10, unit: 'шт' }], saved)[0].name, 'Мышь компьютерная', 'другой товар с тем же количеством не подменяется');
});

test('закупка из своих документов: карточка, поля из документов, позиции, расчёт; повтор не создаёт вторую', async () => {
  const { s, api, asked, net, config } = start();
  try {
    const empty =await api('/api/tenders/manual', { method: 'POST', body: form({}, {}) });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /Загрузите хотя бы один файл/);
    const badInn = await api('/api/tenders/manual', { method: 'POST', body: form({ customer_inn: '123' }) });
    assert.equal(badInn.status, 400);
    assert.match(badInn.body.error, /ИНН заказчика: ИНН — это 10 или 12 цифр/);
    assert.equal(s.repo.countManualTenders(), 0);

    // Вписан только номер: остальное сервис берёт из документов.
    const r = await api('/api/tenders/manual', { method: 'POST', body: form({ number: ' 100 200 300 ' }) });
    assert.equal(r.status, 201);
    const id = r.body.id;
    const card = await ready(s, api, id);
    const t = card.tender;
    assert.deepEqual([t.source, t.law, t.number, t.platform, t.status], ['manual', 'com', 'EAT-100200300', 'ЕАТ «Берёзка»', 'new']);
    assert.equal(t.analysis_status, 'done');
    assert.equal(t.analysis_id, r.body.analysisId, 'разбор привязан к закупке');
    assert.deepEqual([t.price, t.deadline_at, t.customer_inn, t.region], [1250000, '2026-09-29T06:00:00.000Z', '7701234567', 77]);
    assert.match(t.title, /многофункциональн/i, 'название — предмет закупки из документов');
    assert.deepEqual(card.manual.files.map((f) => f.name), ['Извещение.docx', 'Техническое задание.docx']);
    assert.deepEqual(card.manual.given, []);
    assert.ok(['title', 'price', 'deadline_at', 'customer_inn', 'region', 'delivery_place'].every((k) => card.manual.from_docs.includes(k)), `из документов: ${card.manual.from_docs}`);
    assert.match(card.manual.delivery_place, /Москва/);
    assert.equal(card.manual.customer_name, 'ГБУ города Москвы «Городская поликлиника № 7»', 'название заказчика — без ИНН');
    assert.match(t.title, /^[А-ЯЁA-Z]/, 'название с заглавной буквы');
    // позиции — из документов, с количеством; требования ТЗ прочитаны
    assert.ok(card.items.length >= 1);
    assert.ok(card.items.some((i) => /многофункц|мфу/i.test(i.name) && i.quantity === 25), JSON.stringify(card.items.map((i) => [i.name, i.quantity])));
    assert.notEqual(card.details.items_source, 'fallback');
    assert.ok(card.details.spec_status, 'ТЗ прочитано');
    assert.equal(card.docs.length, 2, 'документы закупки открываются из карточки');

    // тот же номер ещё раз — второй закупки нет, сервис отдаёт ссылку на первую; лишние файлы не остаются
    const dup = await api('/api/tenders/manual', { method: 'POST', body: form({ number: '100200300' }) });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.id, id);
    assert.equal(s.repo.countManualTenders(), 1);
    assert.equal(fs.readdirSync(path.join(config.DATA_DIR, 'uploads')).filter((d) => d.startsWith('manual-')).length, 1);

    // расчёт с ручной ценой закупки
    const econ = await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { items: card.items.map((i) => ({ id: i.id, purchase_price: 30000 })) } });
    assert.equal(econ.status, 200);
    const res = econ.body.economics.result.result;
    assert.ok(res && Number.isFinite(res.profit), 'расчёт посчитан');
    assert.ok(res.purchase >= 30000 * 25);

    // синхронизация ленты закупку не трогает: не отсеивает (в профиле коммерческие выключены) и не оценивает
    await s.sync.run();
    const after = s.repo.getTender(id);
    assert.deepEqual([after.status, after.score, after.filter_reason], ['new', null, null]);
    const mine = (await api('/api/tenders?manual=1')).body;
    assert.deepEqual([mine.total, mine.items[0].id, mine.manual_total], [1, id, 1]);
    const feed = (await api('/api/tenders?limit=100')).body;
    assert.ok(feed.items.some((x) => x.id === id), 'видна и в общей ленте');
    assert.equal(feed.manual_total, 1);

    // «Разобрать заново» и «Обновить данные» читают сохранённые файлы: ни источников, ни сети
    const again = await api(`/api/tenders/${id}/analyze`, { method: 'POST' });
    assert.equal(again.status, 202);
    assert.notEqual(again.body.analysisId, r.body.analysisId);
    const card2 = await ready(s, api, id);
    assert.equal(card2.tender.analysis_status, 'done');
    assert.equal(card2.tender.analysis_id, again.body.analysisId);
    assert.deepEqual(card2.items.map((i) => [i.name, i.quantity]), card.items.map((i) => [i.name, i.quantity]), 'позиции после повторного разбора те же');
    assert.equal(card2.items[0].purchase_price_manual, 30000, 'ручная цена закупки сохранилась');
    const refreshed = await api(`/api/tenders/${id}/refresh`, { method: 'POST' });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.items[0].purchase_price_manual, 30000);
    assert.equal((await api(`/api/tenders/${id}/customer`)).status, 200);
    assert.deepEqual(asked, [], 'к источникам по ручной закупке не обращались');
    assert.deepEqual(net, [], 'в сеть не ходили');
  } finally {
    await s.close();
  }
});

test('правка полей, дозагрузка файлов и удаление ручной закупки', async () => {
  const { s, api, config } = start();
  try {
    // своя площадка и свои поля: вписанное владельцем документы не перебивают
    const r = await api('/api/tenders/manual', { method: 'POST', body: form({ platform: 'Портал поставщиков', number: 'ПП-77', title: 'МФУ для поликлиники', price: '900000', region: '50' }, { 'Извещение.docx': NOTICE_PAGES.flat() }) });
    assert.equal(r.status, 201);
    const id = r.body.id;
    let card = await ready(s, api, id);
    assert.deepEqual([card.tender.number, card.tender.platform, card.tender.title, card.tender.price, card.tender.region], ['ПП-77', 'Портал поставщиков', 'МФУ для поликлиники', 900000, 50]);
    assert.deepEqual(card.manual.given.sort(), ['price', 'region', 'title']);
    assert.ok(card.manual.from_docs.includes('deadline_at') && !card.manual.from_docs.includes('price'));

    // правка: цена и срок; пустая ссылка — «не указано»; ошибка в поле — отказ простыми словами
    const bad = await api(`/api/tenders/${id}/manual`, { method: 'PUT', json: { url: 'agregatoreat.ru/x' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /ссылка на закупку: ссылка должна начинаться с http/);
    const put = await api(`/api/tenders/${id}/manual`, { method: 'PUT', json: { price: 800000, deadline_at: '2026-10-01T12:00:00+03:00', url: 'https://agregatoreat.ru/purchases/1', delivery_place: 'г. Химки, ул. Мира, 1' } });
    assert.equal(put.status, 200);
    assert.deepEqual([put.body.tender.price, put.body.tender.deadline_at, put.body.tender.eis_url], [800000, '2026-10-01T09:00:00.000Z', 'https://agregatoreat.ru/purchases/1']);
    assert.equal(put.body.manual.delivery_place, 'г. Химки, ул. Мира, 1');
    assert.ok(!put.body.manual.from_docs.includes('deadline_at') && put.body.manual.given.includes('deadline_at'));
    assert.equal(put.body.tender.number, 'ПП-77', 'номер не меняется');

    // дозагрузка: появляется ТЗ — позиции собираются из документов заново
    const more = await api(`/api/tenders/${id}/files`, { method: 'POST', body: form({ text: 'Дополнительно: доставка до кабинета.' }, { 'ТЗ.docx': TZ, 'Проект контракта.docx': CONTRACT }) });
    assert.equal(more.status, 202);
    card = await ready(s, api, id);
    assert.deepEqual(card.manual.files.map((f) => f.name), ['Извещение.docx', 'ТЗ.docx', 'Проект контракта.docx', 'Текст из карточки закупки.txt']);
    assert.ok(card.manual.files.every((f) => !f.missing));
    assert.equal(card.tender.analysis_id, more.body.analysisId);
    assert.ok(card.items.some((i) => i.quantity === 25), 'позиции с количеством из ТЗ');
    assert.equal(card.tender.price, 800000, 'вписанная цена осталась');
    const nothing = await api(`/api/tenders/${id}/files`, { method: 'POST', body: form({}, {}) });
    assert.equal(nothing.status, 400);

    // удалять можно только ручные закупки
    await s.sync.run();
    const other = s.repo.db.prepare("SELECT id FROM tenders WHERE COALESCE(source, '') != 'manual' LIMIT 1").get();
    assert.equal((await api(`/api/tenders/${other.id}`, { method: 'DELETE' })).status, 400);
    assert.equal((await api(`/api/tenders/${other.id}/manual`, { method: 'PUT', json: { price: 1 } })).status, 400);

    const dir = path.join(config.DATA_DIR, 'uploads', s.repo.getTenderRaw(id).manual.dir);
    const analysesOf = s.repo.getTenderRaw(id).manual.analyses;
    assert.equal(analysesOf.length, 2);
    assert.ok(fs.existsSync(dir));
    const del = await api(`/api/tenders/${id}`, { method: 'DELETE' });
    assert.deepEqual([del.status, del.body], [200, { ok: true }]);
    assert.equal((await api(`/api/tenders/${id}`)).status, 404);
    assert.ok(!fs.existsSync(dir), 'файлы удалены');
    assert.ok(analysesOf.every((a) => !s.repo.getAnalysis(a)), 'разборы удалены');
    assert.equal(s.repo.db.prepare('SELECT COUNT(*) AS n FROM tender_items WHERE tender_id = ?').get(id).n, 0);
    assert.equal(s.repo.countManualTenders(), 0);
  } finally {
    await s.close();
  }
});

test('закупка только из текста карточки, без файлов и без номера', async () => {
  const { s, api } = start();
  try {
    const fd = new FormData();
    fd.append('text', NOTICE_PAGES.flat().join('\n') + '\n' + TZ.join('\n'));
    const r = await api('/api/tenders/manual', { method: 'POST', body: fd });
    assert.equal(r.status, 201);
    const card = await ready(s, api, r.body.id);
    assert.equal(card.tender.number, 'MANUAL-20260917-1');
    assert.equal(card.tender.analysis_status, 'done');
    assert.deepEqual(card.manual.files.map((f) => f.name), ['Текст из карточки закупки.txt']);
    assert.equal(card.tender.price, 1250000);
    const second = await api('/api/tenders/manual', { method: 'POST', body: (() => { const f = new FormData(); f.append('text', 'Поставка бумаги офисной, 100 пачек.'); return f; })() });
    assert.equal(second.status, 201);
    await ready(s, api, second.body.id);
    assert.equal(s.repo.getTender(second.body.id).number, 'MANUAL-20260917-2');
  } finally {
    await s.close();
  }
});
