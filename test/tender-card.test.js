// Этап 3 целиком: миграция БД, карточка закупки, ручные значения калькулятора, сортировка по выгодности.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const baseConfig = require('../server/config');
const { openDb } = require('../server/db');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-e3-'));

test('миграция: база со старой схемой профиля открывается, данные сохраняются', () => {
  const dir = tmp();
  const old = new DatabaseSync(path.join(dir, 'app.db'));
  old.exec(`CREATE TABLE profile (id INTEGER PRIMARY KEY CHECK (id = 1), description TEXT NOT NULL DEFAULT '', regions_json TEXT NOT NULL DEFAULT '[]',
    price_min REAL, price_max REAL, codes_json TEXT NOT NULL DEFAULT '[]', keywords_json TEXT NOT NULL DEFAULT '[]', stop_words_json TEXT NOT NULL DEFAULT '[]',
    min_days_to_deadline INTEGER NOT NULL DEFAULT 2, laws_json TEXT NOT NULL DEFAULT '["44","223"]', score_threshold INTEGER NOT NULL DEFAULT 60,
    digest_size INTEGER NOT NULL DEFAULT 15, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT);
    INSERT INTO profile (id, description) VALUES (1, 'Старый профиль');`);
  old.close();
  const repo = openDb(dir);
  const p = repo.getProfile();
  assert.equal(p.description, 'Старый профиль');
  assert.equal(p.economics.tax_mode, 'usn6');
  assert.equal(p.economics.vat_rate, 22);
});

function start(overrides = {}) {
  const config = { ...baseConfig, DATA_DIR: tmp(), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '', ECONOMICS_MAX_PER_SYNC: 0, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, ...overrides };
  const s = startServer(config, {
    scheduler: false, log: { log() {}, warn() {}, error() {} },
    clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: FIX }),
  });
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, {
      ...opts, headers: opts.json ? { 'Content-Type': 'application/json' } : undefined, body: opts.json ? JSON.stringify(opts.json) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { s, api };
}

test('карточка закупки: позиции, ориентир, выгодность и ручные значения', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    const first = await api(`/api/tenders/${id}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 1, 'позиции — сразу');
    assert.equal(first.body.benchmark_pending, true, 'цены контрактов — в фоне');
    assert.deepEqual(first.body.benchmark_missing, ['26.20.15.000-00000026']);
    await s.details.idle();
    const { status, body: card } = await api(`/api/tenders/${id}`);
    assert.equal(status, 200);
    assert.equal(card.benchmark_pending, false);
    assert.equal(card.items.length, 1);
    assert.equal(card.items[0].unit_price, 94775);
    assert.equal(card.benchmarks['26.20.15.000-00000026'].contracts, 5);
    const e = card.economics;
    assert.equal(e.result.inputs.items[0].purchase_price, 47999, 'без ручной цены — 25-й перцентиль контрактов');
    assert.match(e.result.inputs.items[0].purchase_source, /контракты ЕИС/);
    assert.equal(e.result.inputs.sources.decline_pct, 'по умолчанию из профиля', 'мало торгов для оценки снижения');
    assert.equal(e.verdict, 'выгодно');

    // ручная цена закупки и срок поставки
    const r = await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { items: [{ id: card.items[0].id, purchase_price: 90000 }], delivery_days: 3 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.economics.result.inputs.items[0].purchase_source, 'ручной ввод');
    assert.equal(r.body.economics.result.inputs.sources.delivery_days, 'ручной ввод');
    assert.equal(r.body.economics.verdict, 'невыгодно');
    assert.ok(r.body.economics.result.reasons.some((x) => /мало времени/.test(x)));

    // сброс ручных значений
    const reset = await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { items: [{ id: card.items[0].id, purchase_price: '' }], delivery_days: '' } });
    assert.equal(reset.body.economics.verdict, 'выгодно');
    assert.deepEqual(reset.body.economics.overrides, {});

    // снижение 67% по трём контрактам — рамочные контракты, а не торги: берём значение профиля и объясняем почему
    const code = '26.20.15.000-00000026';
    const b = s.repo.getBenchmark(code, 365);
    s.repo.saveBenchmark(code, { ...b, decline: { median: 0.67, samples: 3 } });
    const framed = await api(`/api/tenders/${id}/economics`, { method: 'POST', json: {} });
    assert.match(framed.body.economics.result.inputs.sources.decline_pct, /^по умолчанию из профиля: .*67%.*рамочные/);
    assert.equal(framed.body.economics.result.inputs.decline_pct, 10);
    s.repo.saveBenchmark(code, { ...b, decline: { median: 0.3, samples: 3 } });
    const real = await api(`/api/tenders/${id}/economics`, { method: 'POST', json: {} });
    assert.equal(real.body.economics.result.inputs.decline_pct, 30, 'правдоподобное снижение берётся из контрактов');
    s.repo.saveBenchmark(code, b);

    assert.equal((await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { decline_pct: 150 } })).status, 400);
    assert.equal((await api('/api/tenders/999999')).status, 404);

    // лента: сортировка по прибыли и фильтр «только выгодные»
    const feed = (await api('/api/tenders?sort=profit&limit=5')).body;
    assert.equal(feed.items[0].id, id);
    assert.equal(feed.items[0].econ_verdict, 'выгодно');
    assert.ok(feed.items[0].econ_profit > 0);
    const only = (await api('/api/tenders?profitable=1')).body;
    assert.ok(only.items.length >= 1 && only.items.every((t) => t.econ_verdict === 'выгодно'));
  } finally {
    await s.close();
  }
});

test('профиль: настройки экономики сохраняются и не сбрасываются при сохранении без них', async () => {
  const { s, api } = start();
  try {
    const p0 = (await api('/api/profile')).body;
    const put = await api('/api/profile', { method: 'PUT', json: { ...p0, economics: { tax_mode: 'osn', min_profit: 25000 } } });
    assert.equal(put.status, 200);
    assert.equal(put.body.economics.tax_mode, 'osn');
    assert.equal(put.body.economics.vat_rate, 22, 'остальные значения по умолчанию на месте');
    const { economics, ...withoutEconomics } = put.body;
    void economics;
    const again = await api('/api/profile', { method: 'PUT', json: withoutEconomics });
    assert.equal(again.body.economics.tax_mode, 'osn');
    assert.equal(again.body.economics.min_profit, 25000);
    assert.equal((await api('/api/profile', { method: 'PUT', json: { ...p0, economics: { tax_mode: 'патент' } } })).status, 400);
  } finally {
    await s.close();
  }
});

test('позиции из текста документации через LLM, если в извещении их нет', async () => {
  const { s } = start();
  try {
    // закупка без фикстуры извещения + готовый разбор эталонного комплекта
    const { id } = s.repo.upsertTender({ law: '44', number: 'NO-NOTICE-1', title: 'МФУ', price: 1250000, currency: 'RUB', region: 77,
      okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: 1, eis_url: 'https://x', raw_json: {} });
    const { makeDocx, TZ } = require('../samples/make-samples');
    const file = path.join(tmp(), 'tz.docx');
    fs.writeFileSync(file, makeDocx(TZ));
    const analysisId = s.analyses.newId();
    s.analyses.startFromUploads({ id: analysisId, title: 'ТЗ', files: [{ originalname: 'ТЗ.docx', path: file }] });
    await s.analyses.idle();
    s.repo.setTenderAnalysis(id, analysisId);
    const items = await s.details.ensureItems(s.repo.getTender(id));
    assert.equal(s.repo.getDetails(id).items_source, 'llm');
    assert.equal(items[0].quantity, 25);
    assert.match(items[0].name, /многофункциональное устройство/);
  } finally {
    await s.close();
  }
});

test('подтверждённая прибыль: цена из прошлого госконтракта — ориентир, предложение поставщика — подтверждение', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    await api(`/api/tenders/${id}`);
    await s.details.idle();
    const item = s.repo.getItems(id)[0];
    const offer = (source) => s.repo.insertOffer({ tender_id: id, item_id: item.id, source, title: 'Моноблок', price: 60000, unit_price: 60000, pack_qty: 1, seller_name: 'ООО Поставщик', match: 'соответствует', match_notes: [], delivery_cost: 0 });

    const fromContract = offer('contracts');
    s.repo.setItemOffer(item.id, s.repo.getOffer(fromContract), 'auto');
    let e = (await api(`/api/tenders/${id}/economics`, { method: 'POST', json: {} })).body.economics;
    assert.equal(e.result.inputs.items[0].purchase_price, 60000, 'цена контракта идёт в расчёт');
    assert.match(e.result.inputs.items[0].purchase_source, /^контракты ЕИС: .*уточните сегодняшнюю цену/);
    assert.equal(e.confirmed, false, 'но прибыль подтверждённой не считается');
    assert.deepEqual((await s.alerts.check()), { fresh: 0, sent: 0 }, 'и уведомления нет');

    const fromShop = offer('yandex');
    s.repo.setItemOffer(item.id, s.repo.getOffer(fromShop), 'auto');
    e = (await api(`/api/tenders/${id}/economics`, { method: 'POST', json: {} })).body.economics;
    assert.equal(e.result.inputs.items[0].purchase_source, 'поиск поставщиков');
    assert.equal(e.confirmed, true);
    assert.equal(e.verdict, 'выгодно');
    assert.equal((await s.alerts.check()).fresh, 1, 'предложение магазина на тот же товар — уведомление');

    // вкладка «Уведомления»: новое → прочитано; в истории остаётся прибыль на момент уведомления
    let list = (await api('/api/alerts')).body;
    assert.equal(list.unread, 1);
    assert.deepEqual([list.items[0].id, list.items[0].read, list.items[0].still], [id, false, true]);
    assert.equal(list.items[0].alert_profit, e.profit);
    assert.equal((await api('/api/alerts/read', { method: 'POST', json: {} })).status, 400);
    assert.equal((await api('/api/alerts/read', { method: 'POST', json: { ids: [id] } })).body.updated, 1);
    s.repo.setItemOffer(item.id, null, null); // предложение сняли — закупка больше не подтверждена
    await api(`/api/tenders/${id}/economics`, { method: 'POST', json: {} });
    list = (await api('/api/alerts')).body;
    assert.equal(list.unread, 0);
    assert.deepEqual([list.items[0].read, list.items[0].still, list.items[0].alert_profit], [true, false, e.profit], 'история хранит, что было найдено');
    assert.equal((await s.alerts.check()).fresh, 0, 'повторно по той же закупке не уведомляем');
  } finally {
    s.server.close();
  }
});

test('документы закупки: ссылки в карточке, ТЗ отмечено, файл скачивается — в том числе из ZIP', async () => {
  const AdmZip = require('adm-zip');
  const { s, api } = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    const dir = tmp();
    const zip = new AdmZip();
    zip.addFile('ТЗ/1_ООЗ.docx', Buffer.from('docx-bytes'));
    zip.addFile('Проект контракта.docx', Buffer.from('contract'));
    const zipPath = path.join(dir, 'Документация.zip');
    zip.writeZip(zipPath);
    const pdfPath = path.join(dir, 'Обоснование.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.4 test');
    const aId = 'a-docs-1';
    s.repo.createAnalysis({ id: aId, title: 'Документация' });
    const tz = s.repo.addFile(aId, { name: 'Документация.zip/ТЗ/1_ООЗ.docx', path: zipPath, status: 'ok', pages: [{ page: 1, text: 'ТЗ' }] });
    s.repo.addFile(aId, { name: 'Документация.zip/Проект контракта.docx', path: zipPath, status: 'ok', pages: [{ page: 1, text: 'контракт' }] });
    const pdf = s.repo.addFile(aId, { name: 'Обоснование.pdf', path: pdfPath, status: 'ok', pages: [{ page: 1, text: 'цена' }] });
    s.repo.finishAnalysis(aId, { card: { groups: [] }, provider: 'mock', model: 'm', durationMs: 0 });
    s.repo.setTenderAnalysis(id, aId);

    const card = (await api(`/api/tenders/${id}`)).body;
    assert.deepEqual(card.docs.map((d) => [d.name, d.is_tz]), [['1_ООЗ.docx', true], ['Проект контракта.docx', false], ['Обоснование.pdf', false]]);
    const port = s.server.address().port;
    const get = (u) => fetch(`http://127.0.0.1:${port}${u}`);
    const r1 = await get(card.docs[0].url);
    assert.equal(r1.status, 200);
    assert.equal(Buffer.from(await r1.arrayBuffer()).toString(), 'docx-bytes', 'файл достаётся из архива');
    assert.match(r1.headers.get('content-disposition'), /attachment; filename\*=UTF-8''1_%D0%9E%D0%9E%D0%97\.docx/);
    const r2 = await get(`/api/analyses/${aId}/files/${pdf}/download`);
    assert.match(r2.headers.get('content-type'), /application\/pdf/);
    assert.match(r2.headers.get('content-disposition'), /^inline/, 'PDF — открыть в браузере');
    assert.equal((await get(`/api/analyses/other/files/${tz}/download`)).status, 404, 'файл чужого разбора не отдаём');
  } finally {
    s.server.close();
  }
});

test('корзина: отложенные предложения сравниваются рядом, переживают повторный поиск и обновляются на свежую запись', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    await api(`/api/tenders/${id}`);
    await s.details.idle();
    const item = s.repo.getItems(id)[0];
    const offer = (o) => s.repo.insertOffer({ tender_id: id, item_id: item.id, source: 'yandex', title: 'Моноблок', price: 60000, unit_price: 60000, pack_qty: 1, total_cost: 60000, seller_name: 'ООО Поставщик', match: 'соответствует', match_notes: [], delivery_cost: 0, ...o });
    const cheap = offer({ unit_price: 55000, price: 55000, total_cost: 56000, url: 'https://shop-a.ru/p/1', seller_name: 'ООО А' });
    const dear = offer({ unit_price: 58000, price: 58000, total_cost: 61000, url: 'https://shop-b.ru/p/2', seller_name: 'ООО Б' });
    const other = offer({ url: 'https://shop-c.ru/p/3', seller_name: 'ООО В' });

    assert.deepEqual((await api('/api/cart')).body, { count: 0, tenders: [] });
    assert.equal((await api(`/api/offers/${dear}/cart`, { method: 'POST', json: {} })).status, 400);
    assert.equal((await api('/api/offers/999999/cart', { method: 'POST', json: { in: true } })).status, 404);
    let r = (await api(`/api/offers/${dear}/cart`, { method: 'POST', json: { in: true } })).body;
    assert.equal(r.count, 1);
    assert.equal(r.groups[0].ranked.find((o) => o.id === dear).in_cart, true, 'в карточке закупки видно, что предложение отложено');
    r = (await api(`/api/offers/${cheap}/cart`, { method: 'POST', json: { in: true } })).body;
    assert.equal(r.count, 2);

    let cart = (await api('/api/cart')).body;
    assert.equal(cart.count, 2);
    assert.equal(cart.tenders[0].id, id);
    const it = cart.tenders[0].items[0];
    assert.deepEqual(it.offers.map((o) => o.id), [cheap, dear], 'дешёвое — сверху');
    assert.equal(it.cheapest_id, cheap);
    // «Что дальше»: пока ничего не выбрано, позиция не закрыта; заявку ещё не собирали
    const total = s.repo.getItems(id).length;
    let p = cart.tenders[0].progress;
    assert.deepEqual([p.items_total, p.items_closed, p.items_elsewhere, p.bid], [total, 0, total - 1, null]);
    // выбор из корзины идёт в расчёт прибыли
    await api(`/api/offers/${dear}/select`, { method: 'POST', json: {} });
    cart = (await api('/api/cart')).body;
    assert.equal(cart.tenders[0].items[0].selected_offer_id, dear);
    p = cart.tenders[0].progress;
    assert.equal(p.items_closed, 1, 'выбранная из корзины позиция закрыта — путь можно продолжать');
    assert.equal(p.calc, total === 1, 'расчёт подтверждён, когда товар выбран по всем позициям');

    // повторный поиск: неотложенное удаляется, отложенное остаётся
    s.repo.clearSearchOffers(id);
    assert.deepEqual(s.repo.getOffers(id).map((o) => o.id).sort(), [cheap, dear].sort());
    assert.equal(s.repo.getOffer(other), null);
    // то же предложение найдено снова по новой цене — корзина и выбор переходят на свежую запись
    const fresh = offer({ unit_price: 57000, price: 57000, total_cost: 60000, url: 'https://shop-b.ru/p/2', seller_name: 'ООО Б' });
    assert.equal(s.offers.mergeCart(id), 1);
    cart = (await api('/api/cart')).body;
    assert.deepEqual(cart.tenders[0].items[0].offers.map((o) => [o.id, o.unit_price]), [[cheap, 55000], [fresh, 57000]]);
    assert.equal(s.repo.getItems(id)[0].purchase_offer_id, fresh);
    assert.equal(s.repo.getItems(id)[0].purchase_price_offer, 57000);

    assert.equal((await api(`/api/offers/${cheap}/cart`, { method: 'POST', json: { in: false } })).body.count, 1);
    assert.equal((await api('/api/cart/clear', { method: 'POST', json: {} })).status, 400);
    assert.deepEqual((await api('/api/cart/clear', { method: 'POST', json: { tender_id: id } })).body, { removed: 1, count: 0, tenders: [] });
    assert.equal(s.repo.getOffers(id).length, 2, 'из корзины убрали — предложения в закупке остались');
  } finally {
    s.server.close();
  }
});

test('направления: метки у закупок, фильтр ленты и счётчики, выключенное направление отсеивается, своё направление', async () => {
  const { s, api } = start();
  try {
    let d = (await api('/api/directions')).body;
    assert.deepEqual(d.items.map((x) => [x.id, x.enabled]), [['computers', false], ['network', false], ['cctv', false], ['office', false]], 'новая база: стандартные направления выключены — любой товар');
    assert.equal(d.active, false);
    assert.equal(d.standard.length, 4);
    await s.sync.run();
    // «любой товар»: закупки всё равно получают метки направлений
    const mono = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    assert.equal((await api(`/api/tenders/${mono}`)).body.tender.direction, null, 'в списке у закупки нет ни названия, ни кодов');
    await s.details.idle();
    assert.equal((await api(`/api/tenders/${mono}`)).body.tender.direction, 'computers', 'позиции загружены — направление по составу (моноблоки)');
    d = (await api('/api/directions')).body;
    const cnt = Object.fromEntries(d.items.map((x) => [x.id, x.count]));
    assert.ok(cnt.computers >= 1 && cnt.cctv >= 1, JSON.stringify(cnt));
    assert.equal(d.total, cnt.computers + cnt.network + cnt.cctv + cnt.office + d.none);
    let list = (await api('/api/tenders?direction=computers&limit=100')).body;
    assert.equal(list.total, cnt.computers);
    assert.ok(list.items.every((t) => t.direction === 'computers') && list.items.some((t) => t.id === mono));
    assert.equal((await api('/api/tenders?direction=none&limit=100')).body.total, d.none);

    // включаем только видеонаблюдение: коды и слова профиля собираются из направления, остальное отсеивается
    const profile = (await api('/api/profile')).body;
    const only = (ids) => profile.directions.map((x) => ({ ...x, enabled: ids.includes(x.id) }));
    let saved = await api('/api/profile', { method: 'PUT', json: { ...profile, directions: only(['cctv']) } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.codes, ['26.40.33', '26.70.13', '26.30.13', '26.30.5', '26.30.6']);
    assert.ok(saved.body.keywords.includes('видеонаблюдение'));
    await s.sync.current();
    d = (await api('/api/directions')).body;
    assert.equal(d.active, true);
    assert.equal(d.search_words_each, 5);
    const t = s.repo.getTender(mono);
    assert.equal(t.status, 'filtered');
    assert.match(t.filter_reason, /не из выбранного направления/);
    list = (await api('/api/tenders?limit=100')).body;
    assert.ok(list.total >= 1 && list.items.every((x) => x.direction === 'cctv'), 'в ленте осталось только включённое направление');
    assert.equal((await api('/api/tenders?direction=none&limit=100')).body.total, 0, '«прочее» — закупки вне включённых направлений; здесь таких нет');
    // профиль без поля directions направления не трогает
    const { directions: _omit, ...noDirs } = profile;
    saved = await api('/api/profile', { method: 'PUT', json: noDirs });
    assert.deepEqual(saved.body.directions.filter((x) => x.enabled).map((x) => x.id), ['cctv']);
    await s.sync.current();

    // своё направление
    const custom = { id: 'custom-furniture', title: 'Мебель', enabled: true, codes: ['31.01'], keywords: ['мебель', '-мягкая'] };
    saved = await api('/api/profile', { method: 'PUT', json: { ...profile, directions: [...only([]), custom] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.directions.at(-1), { ...custom, short: 'Мебель', note: '' });
    assert.deepEqual(saved.body.codes, ['31.01']);
    await s.sync.current();
    // проверки
    const bad = async (dirs) => (await api('/api/profile', { method: 'PUT', json: { ...profile, directions: dirs } }));
    assert.equal((await bad([custom, custom])).status, 400, 'одинаковые имена');
    assert.match((await bad([{ ...custom, codes: [], keywords: ['-мягкая'] }])).body.error, /хотя бы один код или одно ключевое слово/);
    assert.equal((await bad([{ ...custom, id: 'Мебель' }])).status, 400);
    assert.equal((await bad([{ ...custom, codes: ['мебель'] }])).status, 400);
  } finally {
    s.server.close();
  }
});

test('направления: старый профиль с общим направлением переносится — включаются все четыре, версия растёт', () => {
  const dir = tmp();
  let repo = openDb(dir);
  const v0 = repo.getProfile().version;
  repo.db.prepare("UPDATE profile SET directions_json = NULL, codes_json = ?, keywords_json = ? WHERE id = 1")
    .run(JSON.stringify(['26.20', '20.59.12', '26.30', '26.40.3', '26.70.13', '28.23', '26.70.16']), JSON.stringify(['видеонаблюдение', 'коммутатор', 'оргтехника', 'МФУ', 'картридж', '-мониторинг']));
  repo.db.close();
  repo = openDb(dir);
  const p = repo.getProfile();
  assert.deepEqual(p.directions.map((x) => [x.id, x.enabled]), [['computers', true], ['network', true], ['cctv', true], ['office', true]]);
  assert.deepEqual(p.codes, ['26.20', '26.30', '26.40.33', '26.70.13', '28.23.2', '20.59.12']);
  assert.equal(p.version, v0 + 1, 'закупки будут перепроверены при следующей синхронизации');
  repo.db.close();
  assert.equal(openDb(dir).getProfile().version, v0 + 1, 'повторное открытие ничего не меняет');
});

test('группы товаров: каталог со счётчиками, отбор ленты по группам, группа → направление', async () => {
  const PG = require('../server/tenders/product-groups');
  const groups = PG.loadGroups();
  assert.ok(groups.length >= 60, 'каталог большой');
  assert.equal(new Set(groups.map((g) => g.id)).size, groups.length, 'id групп не повторяются');
  for (const g of groups) assert.ok(g.title && g.section && (g.codes.length || g.keywords.some((w) => !w.startsWith('-'))), g.id);
  // отнесение к группе: слово в названии, код закупки, заметная доля позиций; слово-исключение
  const G = (id) => groups.find((g) => g.id === id);
  const row = (title, codes = [], itemCodes = []) => ({ text: title.toLowerCase().replace(/ё/g, 'е'), codes, itemCodes });
  assert.ok(PG.inGroup(G('furniture'), row('Поставка офисной мебели')));
  assert.ok(PG.inGroup(G('furniture'), row('Поставка товара', ['31.01.12.110'])));
  assert.ok(!PG.inGroup(G('stationery'), row('Хозяйственные товары', [], ['32.99.12.110', ...Array(9).fill('20.41.32.110')])), 'одна ручка среди десяти позиций — не канцтовары');
  assert.ok(PG.inGroup(G('stationery'), row('Товары для офиса', [], ['32.99.12.110', '32.99.12.120', '17.12.14.110'])));
  assert.ok(PG.inGroup(G('cartridges'), row('Картриджи для принтеров')) && !PG.inGroup(G('printers'), row('Картриджи для принтеров')), 'картриджи — не принтеры');
  assert.ok(!PG.inGroup(G('cable'), row('Ремонт водопровода')), '«провод» внутри слова не считается');

  const { s, api } = start();
  try {
    await s.sync.run();
    const mono = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    await api(`/api/tenders/${mono}`);
    await s.details.idle();
    let cat = (await api('/api/product-groups')).body;
    assert.equal(cat.can_add, false, 'направления не включены — сервис и так берёт любой товар');
    const comp = cat.groups.find((g) => g.id === 'computers');
    assert.ok(comp.count >= 1 && comp.covered === true && comp.section && comp.aliases.length);
    let list = (await api('/api/tenders?groups=computers&limit=100')).body;
    assert.equal(list.total, comp.count);
    assert.ok(list.items.some((t) => t.id === mono), 'моноблоки — по кодам позиций');
    const two = (await api('/api/tenders?groups=computers,furniture&limit=100')).body;
    assert.ok(two.total >= list.total, 'несколько групп — закупки любой из них');
    assert.equal((await api('/api/tenders?groups=no-such-group')).body.total, 0);
    assert.equal((await api('/api/product-groups/furniture/direction', { method: 'POST', json: {} })).status, 400);

    // включено направление «Компьютеры»: мебель сервис не загружает → её можно добавить в направления одной кнопкой
    const profile = (await api('/api/profile')).body;
    await api('/api/profile', { method: 'PUT', json: { ...profile, directions: profile.directions.map((d) => ({ ...d, enabled: d.id === 'computers' })) } });
    await s.sync.current();
    cat = (await api('/api/product-groups')).body;
    assert.equal(cat.can_add, true);
    assert.deepEqual(['computers', 'monitors', 'furniture'].map((id) => cat.groups.find((g) => g.id === id).covered), [true, true, false]);
    assert.equal((await api('/api/product-groups/nope/direction', { method: 'POST', json: {} })).status, 404);
    const added = await api('/api/product-groups/furniture/direction', { method: 'POST', json: {} });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual([added.body.direction.id, added.body.direction.enabled, added.body.direction.codes], ['g-furniture', true, ['31.0']]);
    await s.sync.current();
    const after = (await api('/api/profile')).body;
    assert.ok(after.codes.includes('31.0') && after.codes.includes('26.20'), 'коды загрузки — из обоих направлений');
    assert.equal((await api('/api/product-groups')).body.groups.find((g) => g.id === 'furniture').covered, true);
    assert.equal((await api('/api/product-groups/furniture/direction', { method: 'POST', json: {} })).status, 200, 'повторно — без дубля');
    await s.sync.current();
    assert.equal((await api('/api/profile')).body.directions.filter((d) => d.id === 'g-furniture').length, 1);
  } finally {
    s.server.close();
  }
});

test('лента: закупки с истёкшим сроком подачи скрыты; ход обновления и расписание в состоянии синхронизации', async () => {
  const { s, api } = start();
  try {
    let st = (await api('/api/sync/status')).body;
    assert.deepEqual([st.running, st.progress, st.interval_min, st.next_at], [false, null, 0, null], 'без планировщика автообновления нет');
    const run = s.sync.run();
    const p0 = s.sync.progress();
    assert.ok(p0 && p0.pct === 0 && /площадк/.test(p0.text), JSON.stringify(p0));
    await run;
    assert.equal(s.sync.progress(), null, 'обновление закончилось — хода нет');

    const before = (await api('/api/tenders?limit=100')).body.total;
    const mk = (number, deadline_at) => {
      const id = s.repo.upsertTender({ law: '44', number, title: 'Поставка ноутбуков', price: 100000, currency: 'RUB', customer_inn: null, stage: 1, region: 78, okpd2: ['26.20.11.110'], ktru: [], deadline_at, eis_url: 'https://zakupki.gov.ru/x', published_at: '2026-09-01T06:00:00Z' }).id;
      s.repo.setScore(id, { score: 80, verdict: 'подходит', reasons: [], concerns: [] }, 1);
      s.repo.setDirection(id, 'computers');
      return id;
    };
    const live = mk('live-1', '2026-09-20T06:00:00Z');   // часы теста — 17.09.2026
    const expired = mk('old-1', '2026-09-16T06:00:00Z');
    const noDeadline = mk('nd-1', null);
    const feed = (await api('/api/tenders?limit=100')).body;
    assert.equal(feed.total, before + 2);
    assert.ok(feed.items.some((t) => t.id === live) && feed.items.some((t) => t.id === noDeadline) && !feed.items.some((t) => t.id === expired));
    const all = (await api('/api/tenders?limit=100&show_hidden=1&q=ноутбуков')).body;
    assert.ok(all.items.some((t) => t.id === expired), 'с галочкой «показать…» видна и закупка с истёкшим сроком');
    // счётчики направлений и групп товаров — тоже без истёкших
    const dirs = (await api('/api/directions')).body;
    assert.equal(dirs.total, feed.total);
    assert.equal((await api('/api/tenders?groups=computers&q=ноутбуков')).body.total, 2);
    assert.equal((await api(`/api/tenders/${expired}`)).status, 200, 'карточка закупки открывается и после срока');
  } finally {
    s.server.close();
  }
});

test('источники: опрашиваются только площадки с видами закупок из профиля; ход загрузки по запросам', async () => {
  const { createMultiSource } = require('../server/sources/multi');
  const calls = [];
  const fake = (name, laws) => ({ name, laws, async fetchNew({ onProgress }) { calls.push(name); onProgress({ done: 1, total: 2, label: `${name}: второй запрос` }); return { items: [{ law: laws[0], number: name }] }; } });
  const multi = createMultiSource([fake('gosplan', ['44', '223']), fake('eis-rss', ['44', '223']), fake('roseltorg', ['com'])], { log: {} });
  const seen = [];
  let r = await multi.fetchNew({ profile: { laws: ['com'] }, onProgress: (p) => seen.push([p.done, p.total, p.label]) });
  assert.deepEqual(calls, ['roseltorg'], 'только коммерческие — ЕИС и ГосПлан не опрашиваем');
  assert.deepEqual(r.items.map((t) => t.number), ['roseltorg']);
  assert.deepEqual(seen, [[0, 1, 'roseltorg'], [0.5, 1, 'roseltorg: второй запрос']]);
  calls.length = 0;
  r = await multi.fetchNew({ profile: { laws: ['44', 'com'] } });
  assert.deepEqual(calls, ['gosplan', 'eis-rss', 'roseltorg']);
  calls.length = 0;
  await multi.fetchNew({ profile: {} });
  assert.equal(calls.length, 3, 'виды закупок не заданы — все источники');
});

test('расчёт без цены заказчика: подсказка цены предложения; своя цена → маржа, выгода, налоги', () => {
  const { calculate } = require('../server/tenders/economics');
  const items = [{ id: 1, quantity: 5, purchase_price: 10000 }];
  const none = calculate({ nmck: null, items, logistics: 2000 });
  assert.equal(none.verdict, 'нет данных');
  assert.equal(none.result, null);
  assert.deepEqual(none.costs, { purchase: 50000, logistics: 2000 });
  const { breakeven, target } = none.offer_price;
  assert.ok(breakeven > 52000 && target > breakeven, JSON.stringify(none.offer_price));
  const at = (price) => calculate({ nmck: price, own_price: true, decline_pct: 0, items, logistics: 2000 });
  assert.ok(at(breakeven).result.profit >= 0 && at(breakeven - 2).result.profit < 0, 'ниже цены «без убытка» — уже убыток');
  assert.equal(at(target).verdict, 'выгодно');
  assert.equal(at(target - 2).verdict, 'на грани', 'на рубль-два ниже порога — уже «на грани»');
  const t = at(target);
  assert.equal(t.inputs.own_price, true);
  assert.ok(Math.abs(t.offer_price.target - target) <= 1 && Math.abs(t.offer_price.breakeven - breakeven) <= 1, 'ориентиры остаются на экране и при своей цене');
  // получим − потратим − налоги = выгода
  const x = t.result;
  const spent = x.purchase + x.logistics + x.etp_fee + x.money_cost + x.bid_security_cost + x.guarantee_cost + x.warranty_cost;
  assert.ok(Math.abs(x.revenue - spent - x.tax - x.vat - x.profit) < 0.05);
  assert.equal(calculate({ nmck: null, items: [{ id: 1, quantity: 5, purchase_price: null }] }).offer_price, null, 'нет цены закупки — подсказывать нечего');
});

test('закупка без цены заказчика: своя цена в калькуляторе, уведомление «товар найден», порядок ленты и города регионов', async () => {
  const { s, api } = start();
  try {
    assert.deepEqual([(await api('/api/regions')).body['38'], (await api('/api/regions')).body['77']], ['Иркутск', 'Москва']);
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    await api(`/api/tenders/${id}`);
    await s.details.idle();
    s.repo.db.prepare('UPDATE tenders SET price = NULL WHERE id = ?').run(id); // как в запросе цен на площадке
    const item = s.repo.getItems(id)[0];
    const offer = s.repo.insertOffer({ tender_id: id, item_id: item.id, source: 'yandex', title: 'Моноблок', price: 60000, unit_price: 60000, pack_qty: 1, seller_name: 'ООО Поставщик', match: 'соответствует', match_notes: [], delivery_cost: 3000 });
    s.repo.setItemOffer(item.id, s.repo.getOffer(offer), 'auto');
    let e = (await api(`/api/tenders/${id}/economics`, { method: 'POST', json: {} })).body.economics;
    assert.deepEqual([e.verdict, e.confirmed, e.result.result], ['нет данных', true, null]);
    const { target } = e.result.offer_price;
    assert.ok(target > e.result.costs.purchase + e.result.costs.logistics);
    assert.equal((await api('/api/tenders?limit=100')).body.items.find((t) => t.id === id).econ_purchase, e.result.costs.purchase, 'в ленте видно, во сколько обойдётся товар');

    e = (await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { price: target } })).body.economics;
    assert.equal(e.verdict, 'выгодно');
    assert.deepEqual([e.result.inputs.own_price, e.result.inputs.nmck, e.result.inputs.decline_pct, e.overrides.price], [true, target, 0, target]);
    assert.match(e.result.inputs.sources.price, /ваша цена/);
    assert.equal((await s.alerts.check()).fresh, 1);
    assert.equal((await api('/api/alerts')).body.items[0].kind, 'found', 'выгодность от нашей же цены — это всё ещё «товар найден», а не «выгодная закупка»');
    // сброс ручных значений убирает и свою цену
    e = (await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { price: '' } })).body.economics;
    assert.deepEqual([e.verdict, e.overrides.price], ['нет данных', undefined]);
    assert.equal((await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { price: -5 } })).status, 400);

    // порядок «сначала выгодные»: от самых выгодных к менее интересным
    const ids = s.repo.db.prepare("SELECT id FROM tenders WHERE status = 'scored' AND id != ? ORDER BY id LIMIT 6").all(id).map((r) => r.id);
    assert.equal(ids.length, 6);
    const fake = (verdict, profit, margin) => ({ verdict, result: profit == null ? null : { profit, margin_pct: margin } });
    s.repo.saveEconomics(ids[0], { result: fake('невыгодно', -500, -5), opportunity: -5, confirmed: true });
    s.repo.saveEconomics(ids[1], { result: fake('на грани', 900, 4), opportunity: 2, confirmed: false });
    s.repo.saveEconomics(ids[2], { result: fake('выгодно', 5000, 30), opportunity: 20, confirmed: false });
    s.repo.saveEconomics(ids[3], { result: fake('на грани', 700, 3), opportunity: 1003, confirmed: true });
    s.repo.saveEconomics(ids[4], { result: fake('выгодно', 3000, 12), opportunity: 1012, confirmed: true });
    s.repo.db.prepare('DELETE FROM tender_economics WHERE tender_id = ?').run(ids[5]);
    const order = s.repo.listTenders({ sort: 'opportunity', limit: 500, nowIso: '2026-01-01T00:00:00.000Z' }).items.map((t) => t.id).filter((x) => [...ids, id].includes(x));
    assert.deepEqual(order.slice(0, 4), [ids[4], ids[3], ids[2], id], 'подтверждённые выгодные → на грани → выгодные по оценке → товар найден');
    assert.equal(order.at(-1), ids[0], 'невыгодные — в самом низу');
    assert.ok(order.indexOf(ids[1]) < order.indexOf(ids[5]), '«на грани по оценке» выше закупок без расчёта');
  } finally {
    s.server.close();
  }
});
