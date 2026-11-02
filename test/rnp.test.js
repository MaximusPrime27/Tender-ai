// Автоматическая проверка продавцов по реестру недобросовестных поставщиков (РНП) ЕИС.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { createRnpChecker, parseRnpPage } = require('../server/offers/rnp');
const { createGate, eisGate } = require('../server/sources/eis-gate');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');

// Разметка — как на странице поиска реестра в ЕИС (zakupki.gov.ru/epz/dishonestsupplier/search/results.html).
const entry = ({ number, status = 'Размещено', name = 'ООО «Ромашка»', inn, included = '25.10.2024', planned = '25.10.2026' }) => `
  <div class="search-registry-entry-block box-shadow-search-input">
    <div class="registry-entry__header"><div class="registry-entry__header-top__title text-truncate"> 44-ФЗ </div>
      <div class="d-flex registry-entry__header-mid align-items-center">
        <div class="registry-entry__header-mid__number"> <a href="/epz/dishonestsupplier/view/info.html?reestrNumber=${number}&amp;law=FZ44" target="_blank"> № ${number} </a> </div>
        <div class="registry-entry__header-mid__title ${status === 'Исключено' ? 'colorRed' : ''}">
            ${status} </div></div></div>
    <div class="registry-entry__body">
      <div class="registry-entry__body-block"><div class="registry-entry__body-title">Наименование (ФИО) недобросовестного поставщика</div> <div class="registry-entry__body-value">${name}</div></div>
      <div class="registry-entry__body-block"><div class="registry-entry__body-title">ИНН (аналог ИНН)</div> <div class="registry-entry__body-value"><span class='highlightColor'>${inn}</span></div></div></div>
    <div class="row"><div class="col-6"><div class="data-block__title">Включено</div> <div class="data-block__value"> ${included} </div></div>
      ${status === 'Исключено' ? '<div class="col-6"><div class="data-block__title">Исключено</div> <div class="data-block__value"> 09.10.2026 </div></div>'
    : `<div class="data-block__title">Планируемая дата исключения</div> <div class="data-block__value"> ${planned} </div>`}</div>
  </div>`;
const page = (entries, total = entries.length) => `<html><head><title>Реестр недобросовестных поставщиков (подрядчиков, исполнителей)</title></head><body>
  <div class="search-results__total">${entries.length ? `${total} записей` : ''}</div>
  ${entries.length ? entries.join('') : '<p class="noRecords">Поиск не дал результатов</p>'}</body></html>`;
const html = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
/** Заглушка сайта реестра: что ответить на поиск по ИНН. */
const registry = (byInn, calls = []) => async (url) => {
  const u = new URL(String(url));
  calls.push(u);
  const answer = byInn[u.searchParams.get('searchString')];
  return typeof answer === 'function' ? answer(u) : html(answer ?? page([]));
};

test('реестр: разбор страницы поиска — действующие и исключённые записи, пустой результат, чужая страница', () => {
  const p = parseRnpPage(page([entry({ number: '24011236', inn: '9725077046' }), entry({ number: '24010246', status: 'Исключено', inn: '9725077046', name: 'ООО "НЕРУДГРУПП"' })], 12));
  assert.deepEqual([p.recognized, p.empty, p.total, p.entries.length], [true, false, 12, 2]);
  assert.deepEqual(p.entries[0], { number: '24011236', status: 'Размещено', active: true, name: 'ООО «Ромашка»', inn: '9725077046', included: '25.10.2024', planned_exclusion: '25.10.2026',
    url: 'https://zakupki.gov.ru/epz/dishonestsupplier/view/info.html?reestrNumber=24011236&law=FZ44' });
  assert.deepEqual([p.entries[1].active, p.entries[1].status, p.entries[1].planned_exclusion], [false, 'Исключено', null]);
  assert.deepEqual(parseRnpPage(page([])), { recognized: true, empty: true, total: null, entries: [] });
  assert.equal(parseRnpPage('<html><body>Подтвердите, что вы не робот</body></html>').recognized, false);
  assert.equal(parseRnpPage(page([entry({ number: '1', inn: '1' })], 120000).replace('120000 записей', 'более 120 000 записей')).total, 120000);
});

test('реестр: продавец чист, в реестре, был в реестре раньше; совпадение ИНН — только точное', async () => {
  const calls = [];
  const checker = createRnpChecker({ delayMs: 0, clock: () => new Date('2026-10-09T09:00:00Z'), fetchImpl: registry({
    7700000001: page([entry({ number: '24011236', inn: '7700000001' }), entry({ number: '24010246', status: 'Исключено', inn: '7700000001' })]),
    7700000002: page([entry({ number: '23000001', status: 'Исключено', inn: '7700000002' }), entry({ number: '23000002', status: 'Исключено', inn: '7700000002' })]),
    // поиск нашёл ИНН у другой компании (например, среди её учредителей) — это не наш продавец
    7700000003: page([entry({ number: '25000009', inn: '5000000000', name: 'ООО «Чужая»' })]),
  }, calls) });

  assert.deepEqual(await checker.check('7700000099'), { status: 'clean', records: [], excluded: 0, total: null, checked_at: '2026-10-09T09:00:00.000Z' });
  const listed = await checker.check('7700000001');
  assert.deepEqual([listed.status, listed.excluded, listed.records.length], ['listed', 1, 1]);
  assert.deepEqual(listed.records[0], { number: '24011236', name: 'ООО «Ромашка»', included: '25.10.2024', planned_exclusion: '25.10.2026', url: 'https://zakupki.gov.ru/epz/dishonestsupplier/view/info.html?reestrNumber=24011236&law=FZ44' });
  assert.deepEqual([(await checker.check('7700000002')).status, (await checker.check('7700000002')).excluded], ['clean', 2], 'записи исключены — сейчас запрета нет, но это видно');
  assert.equal((await checker.check('7700000003')).status, 'clean');

  const u = calls[0];
  assert.equal(`${u.origin}${u.pathname}`, 'https://zakupki.gov.ru/epz/dishonestsupplier/search/results.html');
  assert.deepEqual([u.searchParams.get('searchString'), u.searchParams.get('strictEqual'), u.searchParams.get('recordsPerPage')], ['7700000099', 'true', '_50']);
  assert.ok(['fz94', 'fz223', 'ppRf615'].every((k) => u.searchParams.get(k) === 'on'), 'все три реестра: 44-ФЗ, 223-ФЗ и ПП 615');
  await assert.rejects(checker.check('123'), /ИНН — 10 или 12 цифр/);
});

test('реестр: страница не та или сайт отказал — ошибка, а не «чисто»; длинный список — «проверьте вручную»', async () => {
  const many = (n, from) => Array.from({ length: n }, (_, i) => entry({ number: String(from + i), status: 'Исключено', inn: '7700000005' }));
  const calls = [];
  const checker = createRnpChecker({ delayMs: 0, maxPages: 2, fetchImpl: registry({
    7700000001: '<html><body>Подтвердите, что вы не робот <div class="captcha"></div></body></html>',
    7700000002: () => html('Service Unavailable', 503),
    // 120 исключённых записей, действующей среди первых ста нет — сервис не утверждает, что продавец чист
    7700000005: (u) => html(page(many(50, Number(u.searchParams.get('pageNumber')) * 1000), 120)),
    // действующая запись — на второй странице
    7700000006: (u) => html(page(u.searchParams.get('pageNumber') === '1' ? many(50, 1000).map((x) => x.replace(/7700000005/g, '7700000006')) : [entry({ number: '99', inn: '7700000006' })], 51)),
  }, calls) });
  await assert.rejects(checker.check('7700000001'), /страница реестра не распознана/);
  await assert.rejects(checker.check('7700000002'), /ЕИС ответил 503/);
  const unsure = await checker.check('7700000005');
  assert.deepEqual([unsure.status, unsure.excluded, unsure.total], [null, 100, 120]);
  assert.equal(calls.filter((u) => u.searchParams.get('searchString') === '7700000005').length, 2, 'не больше заданного числа страниц');
  assert.deepEqual([(await checker.check('7700000006')).status], ['listed']);
});

test('очередь запросов к ЕИС: между запросами — пауза, очередь с одной паузой общая', async () => {
  const gate = createGate(60);
  const t0 = Date.now();
  await gate.wait();
  const first = Date.now() - t0;
  await Promise.all([gate.wait(), gate.wait()]);
  const total = Date.now() - t0;
  assert.ok(first < 40, 'первый запрос идёт сразу');
  assert.ok(total >= 110, `три запроса — не меньше двух пауз (прошло ${total} мс)`);
  assert.equal(eisGate(60000), eisGate(60000), 'лента ЕИС и проверка по реестру берут одну очередь');
  assert.notEqual(eisGate(60000), eisGate(5));
});

function start(fetchImpl, extra = {}) {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-rnp-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, SUPPLIER_INDEX: false, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
    OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '', RNP_AUTO: true, EIS_REQUEST_DELAY_MS: 0, ...extra,
  };
  let now = new Date('2026-09-17T09:00:00Z');
  const s = startServer(config, { scheduler: false, fetchImpl, log: { log() {}, warn() {}, error() {} }, clock: () => now, sourceOverride: createFixtureSource({ dir: FIX }) });
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, { method: opts.method, headers: opts.json ? { 'Content-Type': 'application/json' } : undefined, body: opts.json ? JSON.stringify(opts.json) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { s, api, setNow: (iso) => { now = new Date(iso); } };
}

test('реестр в сервисе: продавцы проверяются в фоне; найденный в реестре сам в расчёт не идёт', async () => {
  const LISTED = '7707083893'; const CLEAN = '5249185655'; const MANUAL_CLEAN = '7736207543'; const MANUAL_LISTED = '7702070139';
  const calls = [];
  const { s, api, setNow } = start(registry({
    [LISTED]: page([entry({ number: '24011236', inn: LISTED })]),
    [MANUAL_CLEAN]: page([entry({ number: '25000077', inn: MANUAL_CLEAN })]),
  }, calls));
  try {
    await s.sync.run();
    await s.funnel.idle();
    await s.offers.rnpIdle();
    assert.equal(calls.length, 0, 'предложений с ИНН ещё нет — проверять некого');
    assert.equal((await api('/api/health')).body.rnpAuto, true);
    const id = (await api('/api/tenders?limit=1')).body.items[0].id;
    s.repo.saveItems(id, [{ name: 'Картридж HP CF259X', characteristics: [], quantity: 2, unit: 'шт', unit_price: 9000, source: 'notification' }], { source: 'notification' });
    const item = s.repo.getItems(id)[0];
    const offer = (price, inn, source = 'yandex') => s.repo.insertOffer({ tender_id: id, item_id: item.id, source, title: 'HP CF259X', domain: `s${price}.ru`, url: `https://s${price}.ru/x`,
      price, unit_price: price, pack_qty: 1, seller_name: `Продавец ${price}`, seller_inn: inn, match: 'соответствует', match_notes: [], delivery_cost: 0 });
    const cheap = offer(4000, LISTED);
    const spare = offer(5000, CLEAN);
    offer(4500, MANUAL_CLEAN);
    offer(4600, MANUAL_LISTED);
    offer(3000, '6449013711', 'contracts'); // победитель прошлого контракта — конкурент, его не проверяем
    s.repo.setItemOffer(item.id, s.repo.getOffer(cheap), 'auto');
    // свои отметки пользователя
    await api(`/api/sellers/${MANUAL_CLEAN}/rnp`, { method: 'POST', json: { status: 'clean' } });
    await api(`/api/sellers/${MANUAL_LISTED}/rnp`, { method: 'POST', json: { status: 'listed' } });

    assert.equal(s.offers.checkRnp(), 2, 'в очереди — продавцы без отметки; отмеченные пользователем не перепроверяются');
    await s.offers.rnpIdle();
    assert.deepEqual(calls.map((u) => u.searchParams.get('searchString')), [LISTED, CLEAN], 'сначала продавец выбранного предложения');

    const g = (await api(`/api/tenders/${id}/offers`)).body.groups[0];
    const by = (inn) => g.ranked.find((o) => o.seller_inn === inn);
    assert.deepEqual([by(LISTED).seller_rnp, by(LISTED).seller_rnp_source], ['listed', 'auto']);
    assert.equal(by(LISTED).seller_rnp_info.records[0].number, '24011236', 'видно, какая запись найдена');
    assert.deepEqual([by(CLEAN).seller_rnp, by(CLEAN).seller_rnp_source], ['clean', 'auto']);
    assert.notEqual(g.selected_offer_id, cheap, 'продавец из реестра снят с автоматического выбора');
    assert.ok([by(CLEAN).id, by(MANUAL_CLEAN).id].includes(g.selected_offer_id), 'выбран продавец, которого в реестре нет');
    assert.equal(g.selected_by, 'auto');
    assert.equal(g.competitors.some((o) => o.seller_rnp), false);

    // повторно сразу — никого: проверка свежая; через 15 дней — автоматические перепроверяются
    assert.equal(s.offers.checkRnp(), 0);
    setNow('2026-10-03T09:00:00Z');
    s.repo.db.prepare("UPDATE tenders SET deadline_at = '2026-12-01T00:00:00Z' WHERE id = ?").run(id);
    s.repo.db.prepare("UPDATE sellers SET rnp_checked_at = '2026-09-17T09:00:00.000Z' WHERE rnp_source = 'auto'").run();
    assert.equal(s.offers.checkRnp(), 2);
    await s.offers.rnpIdle();

    // проверка по кнопке — вне очереди, в том числе для продавца со своей отметкой
    const now = await api(`/api/sellers/${MANUAL_CLEAN}/rnp/check`, { method: 'POST', json: {} });
    assert.deepEqual([now.status, now.body.queued], [202, true]);
    assert.equal((await api('/api/sellers/123/rnp/check', { method: 'POST', json: {} })).status, 409);
    await api(`/api/sellers/${MANUAL_LISTED}/rnp/check`, { method: 'POST', json: {} });
    await s.offers.rnpIdle();
    const g2 = (await api(`/api/tenders/${id}/offers`)).body.groups[0];
    const by2 = (inn) => g2.ranked.find((o) => o.seller_inn === inn);
    // пользователь отметил «в реестре нет», а проверка нашла действующую запись — показываем найденное
    assert.deepEqual([by2(MANUAL_CLEAN).seller_rnp, by2(MANUAL_CLEAN).seller_rnp_source], ['listed', 'auto']);
    // пользователь отметил «в реестре», проверка записей не нашла — его решение остаётся
    assert.deepEqual([by2(MANUAL_LISTED).seller_rnp, by2(MANUAL_LISTED).seller_rnp_source], ['listed', 'manual']);
    assert.equal(g2.selected_offer_id, spare, 'выбран единственный продавец, которого в реестре нет');
  } finally {
    await s.close();
  }
});

test('реестр в сервисе: сайт не отвечает — отметки не меняются, очередь не крутится впустую; выключено — кнопка отвечает отказом', async () => {
  const calls = [];
  const { s, api } = start(async (url) => { calls.push(String(url)); return html('<html>Подтвердите, что вы не робот</html>'); });
  try {
    await s.sync.run();
    await s.funnel.idle();
    const id = (await api('/api/tenders?limit=1')).body.items[0].id;
    s.repo.saveItems(id, [{ name: 'Картридж', characteristics: [], quantity: 1, unit: 'шт', source: 'notification' }], { source: 'notification' });
    const item = s.repo.getItems(id)[0];
    for (let i = 0; i < 6; i++) s.repo.insertOffer({ tender_id: id, item_id: item.id, source: 'yandex', title: 'x', url: `https://s${i}.ru/x`, price: 100 + i, unit_price: 100 + i, seller_inn: `770000000${i}`, match: 'соответствует', match_notes: [] });
    assert.equal(s.offers.checkRnp(), 6);
    await s.offers.rnpIdle();
    assert.equal(calls.length, 3, 'после трёх неудач подряд очередь сброшена — до следующего раза');
    const g = (await api(`/api/tenders/${id}/offers`)).body.groups[0];
    assert.ok(g.ranked.every((o) => o.seller_rnp == null && !o.seller_rnp_pending), 'никто не помечен ни «чистым», ни «в реестре»');
  } finally {
    await s.close();
  }
  const off = start(async () => { throw new Error('сеть не нужна'); }, { RNP_AUTO: false });
  try {
    assert.equal((await off.api('/api/health')).body.rnpAuto, false);
    assert.equal(off.s.offers.checkRnp(), 0);
    const r = await off.api('/api/sellers/7707083893/rnp/check', { method: 'POST', json: {} });
    assert.deepEqual([r.status, /выключена/.test(r.body.error)], [409, true]);
  } finally {
    await off.s.close();
  }
});
