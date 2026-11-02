const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createBot } = require('../server/telegram/bot');
const { setupTelegram } = require('../server/telegram');
const { formatAnalysisResult } = require('../server/tenders/digest');

const TOKEN = '123456:SECRET-TOKEN';

/** Поддельный Telegram Bot API: запоминает вызовы, отдаёт заданные обновления. */
function fakeTelegram(updates = []) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(opts.body || '{}');
    calls.push({ method, body, url: String(url) });
    let result = true;
    if (method === 'getUpdates') result = updates.splice(0);
    if (method === 'getMe') result = { username: 'test_bot' };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  return { calls, fetchImpl, sent: () => calls.filter((c) => c.method === 'sendMessage') };
}

const msg = (chatId, text, id = 1) => ({ update_id: id, message: { chat: { id: chatId }, text } });

test('/start из чужого чата отвечает chat id, остальные команды из чужого чата игнорируются', async () => {
  const tg = fakeTelegram([msg(555, '/start', 10), msg(555, '/digest', 11)]);
  let commands = 0;
  let offset = 0;
  const bot = createBot({
    token: TOKEN, allowedChatIds: ['111'], fetchImpl: tg.fetchImpl, log: {},
    onCommand: async () => { commands++; }, getOffset: () => offset, setOffset: (v) => { offset = v; },
  });
  await bot.pollOnce();
  assert.equal(commands, 0);
  assert.equal(tg.sent().length, 1);
  assert.match(tg.sent()[0].body.text, /<code>555<\/code>/);
  assert.match(tg.sent()[0].body.text, /TELEGRAM_ALLOWED_CHAT_IDS/);
  assert.equal(offset, 12, 'offset сдвигается, обновления не обрабатываются повторно');
});

test('сообщение длиннее 4096 символов отправляется частями, кнопки — у последней', async () => {
  const tg = fakeTelegram();
  const bot = createBot({ token: TOKEN, allowedChatIds: ['1'], fetchImpl: tg.fetchImpl, log: {} });
  await bot.sendMessage('1', 'строка\n'.repeat(1500), { reply_markup: { inline_keyboard: [] } });
  const sent = tg.sent();
  assert.ok(sent.length >= 2);
  assert.ok(sent.every((c) => c.body.text.length <= 4096 && c.body.parse_mode === 'HTML'));
  assert.equal(sent[0].body.reply_markup, undefined);
  assert.ok(sent.at(-1).body.reply_markup);
});

test('ошибка сети не раскрывает токен', async () => {
  const bot = createBot({
    token: TOKEN, allowedChatIds: ['1'], log: {},
    fetchImpl: async () => { throw Object.assign(new Error('fail'), { cause: { code: 'ECONNRESET' } }); },
  });
  await assert.rejects(bot.sendMessage('1', 'x'), (err) => !err.message.includes('SECRET') && /ECONNRESET/.test(err.message));
});

function setup(updates) {
  const repo = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-tg-')));
  const { id } = repo.upsertTender({
    law: '44', number: '0373100000126000001', title: 'Поставка МФУ', price: 100, currency: 'RUB', region: 77,
    okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: 1, eis_url: 'https://zakupki.gov.ru/x', raw_json: {},
  });
  const tg = fakeTelegram(updates);
  const listeners = [];
  const analyses = {
    started: [],
    startFromTender({ tender }) { this.started.push(tender.number); return 'analysis-1'; },
    onFinished(fn) { listeners.push(fn); },
  };
  const digest = { calls: 0, async send() { this.calls++; } };
  const sync = { run: () => Promise.resolve({ status: 'done', fetched: 5, newCount: 2, filtered: 1, scored: 1 }) };
  const config = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_CHAT_IDS: ['111'], PUBLIC_BASE_URL: 'http://localhost:8850' };
  const bot = setupTelegram({ config, repo, sync, digest, analyses, source: {}, log: {}, fetchImpl: tg.fetchImpl });
  return { repo, tg, bot, analyses, digest, tenderId: id, finish: (a) => listeners.forEach((fn) => fn(a)) };
}

test('без токена бот не создаётся', () => {
  assert.equal(setupTelegram({ config: { TELEGRAM_BOT_TOKEN: '' }, log: {} }), null);
});

test('/digest и /sync из разрешённого чата', async () => {
  const s = setup([msg(111, '/digest', 1), msg(111, '/sync@test_bot', 2)]);
  await s.bot.pollOnce();
  assert.equal(s.digest.calls, 1);
  const texts = s.tg.sent().map((c) => c.body.text);
  assert.ok(texts.some((t) => /новых 2/.test(t)));
});

test('кнопки: «Не интересно» скрывает закупку, «Разобрать» запускает разбор и присылает результат', async () => {
  // несуществующие закупки
  const s = setup([
    { update_id: 1, callback_query: { id: 'q1', data: 'dm:99999', message: { chat: { id: 111 } } } },
    { update_id: 2, callback_query: { id: 'q2', data: 'an:0', message: { chat: { id: 111 } } } },
  ]);
  await s.bot.pollOnce();
  const answers = s.tg.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text);
  assert.deepEqual(answers, ['Закупка не найдена', 'Закупка не найдена']);

  await s.bot.handleUpdate({ update_id: 4, callback_query: { id: 'q4', data: `an:${s.tenderId}`, message: { chat: { id: 111 } } } });
  assert.deepEqual(s.analyses.started, ['0373100000126000001']);
  assert.equal(s.repo.getTender(s.tenderId).analysis_id, 'analysis-1');

  const card = { summary: { recommendation: { value: 'участвовать с оговорками' } }, risks: [{ level: 'high', explanation: 'Пени 0,5% <в день>' }] };
  s.finish({ id: 'analysis-1', status: 'done', title: 'Поставка МФУ', card });
  await new Promise((r) => setImmediate(r));
  const last = s.tg.sent().at(-1).body.text;
  assert.match(last, /Разбор готов/);
  assert.match(last, /участвовать с оговорками/);
  assert.match(last, /&lt;в день&gt;/);
  assert.match(last, /http:\/\/localhost:8850\/#analysis-1/);

  await s.bot.handleUpdate({ update_id: 5, callback_query: { id: 'q5', data: `dm:${s.tenderId}`, message: { chat: { id: 111 } } } });
  assert.equal(s.repo.getTender(s.tenderId).status, 'dismissed');

  // чужой чат не может нажимать кнопки
  await s.bot.handleUpdate({ update_id: 6, callback_query: { id: 'q6', data: `an:${s.tenderId}`, message: { chat: { id: 999 } } } });
  assert.equal(s.analyses.started.length, 1);
});

test('сообщение об ошибке разбора содержит текст ошибки со ссылкой на ЕИС', () => {
  const text = formatAnalysisResult({ id: 'x', status: 'error', title: 'МФУ', error: 'Не удалось скачать: https://zakupki.gov.ru/x' }, 'http://h');
  assert.match(text, /Разбор не выполнен/);
  assert.match(text, /zakupki\.gov\.ru/);
});

test('уведомления: выгодная подтверждённая закупка — одно сообщение в Telegram и запись в список', async () => {
  const { createAlertService, formatAlert } = require('../server/tenders/alerts');
  const repo = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-al-')));
  const NOW = new Date('2026-10-02T09:00:00Z');
  const mk = (number, title) => repo.upsertTender({ law: '44', number, title, price: 293250, currency: 'RUB', customer_inn: null, stage: 1, region: 78, okpd2: ['26.20.13.000'], ktru: [], deadline_at: '2026-10-08T06:00:00Z', eis_url: 'https://zakupki.gov.ru/x', published_at: '2026-10-01T06:00:00Z' }).id;
  const good = mk('1', 'Поставка интерактивной панели');
  const unconfirmed = mk('2', 'Поставка ноутбуков');
  const loss = mk('3', 'Поставка картриджей');
  for (const id of [good, unconfirmed, loss]) repo.setScore(id, { score: 80, verdict: 'подходит', reasons: [], concerns: [] }, 1);
  const econ = (verdict, profit) => ({ verdict, result: { profit, margin_pct: 23.4, purchase: 172900, revenue: 263925 } });
  repo.saveItems(good, [{ name: 'Интерактивная панель', characteristics: [], quantity: 1, unit: 'шт', unit_price: 293250, source: 'notification' }], { source: 'notification' });
  repo.saveEconomics(good, { result: econ('выгодно', 61807), confirmed: true });
  repo.saveEconomics(unconfirmed, { result: econ('выгодно', 490988), confirmed: false });
  repo.saveEconomics(loss, { result: econ('невыгодно', -5000), confirmed: true });

  const sent = [];
  let bot = null;
  const alerts = createAlertService({ repo, getBot: () => bot, config: { PUBLIC_BASE_URL: 'https://app.test', DIGEST_TZ: 'Europe/Moscow' }, log: {}, clock: () => NOW });
  assert.equal(alerts.telegramStatus(), 'no_token');
  assert.deepEqual(await alerts.check(), { fresh: 1, sent: 0 }, 'без Telegram закупка всё равно попадает в список');
  assert.deepEqual(repo.listAlerts(NOW.toISOString()).map((t) => [t.id, t.still]), [[good, true]]);

  bot = { allowedChatIds: ['42'], sendMessage: async (chatId, text, extra) => { sent.push({ chatId, text, extra }); } };
  assert.equal(alerts.telegramStatus(), 'on');
  assert.deepEqual(await alerts.check(), { fresh: 0, sent: 1 }, 'бот появился — отложенное уведомление уходит');
  assert.deepEqual(await alerts.check(), { fresh: 0, sent: 0 }, 'повторно не шлём');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Выгодная закупка/);
  assert.match(sent[0].text, /61\s?807/);
  assert.match(sent[0].text, /https:\/\/app\.test\/#tender\//);
  assert.equal(sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data, `dm:${good}`);

  // закупка перестала быть выгодной — в списке помечена, нового сообщения нет
  repo.saveEconomics(good, { result: econ('невыгодно', -1), confirmed: true });
  assert.equal(repo.listAlerts(NOW.toISOString())[0].still, false);
  // контакты поставщика и ссылка на товар — в сообщении
  const withContacts = formatAlert({ id: 2, title: 'Мониторы', price: 100000, law: '44', region: 78, deadline_at: null }, {
    econ: { result: { result: { profit: 20000, margin_pct: 20, purchase: 60000 } } }, baseUrl: 'https://app.test',
    items: [{ name: 'Монитор 24', unit_price: 10000, purchase_price_offer: 6000, purchase_offer_id: 7 }],
    offers: [{ id: 7, source: 'yandex', seller_name: 'ООО Экран', domain: 'ekran.ru', url: 'https://ekran.ru/p/24', contacts: { phones: ['+7 (812) 123-45-67'], emails: ['sale@ekran.ru'], site: 'https://ekran.ru' } }],
  });
  assert.ok(withContacts.includes('☎ +7 (812) 123-45-67 · ✉ sale@ekran.ru'), withContacts);
  assert.ok(withContacts.includes('<a href="https://ekran.ru/p/24">товар у продавца</a>'), withContacts);
  assert.match(formatAlert({ id: 1, title: 'A<b>', price: 100, law: '44', region: 1, deadline_at: null }, { econ: null, items: [], offers: [], baseUrl: 'x' }), /A&lt;b&gt;/);
});

test('уведомления: «на грани» и «товар найден без цены заказчика» тоже сообщаются; повторно — только если стало лучше', async () => {
  const { createAlertService, formatAlert, purchaseTotal } = require('../server/tenders/alerts');
  const repo = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-al2-')));
  const NOW = new Date('2026-10-02T09:00:00Z');
  const mk = (number, title, price, extra = {}) => repo.upsertTender({ law: 'com', number, title, price, currency: 'RUB', customer_inn: null, stage: 1, region: 78, okpd2: ['26.20.40.110'], ktru: [], deadline_at: '2026-10-08T06:00:00Z', eis_url: 'https://www.roseltorg.ru/x', published_at: '2026-10-01T06:00:00Z', ...extra }).id;
  const edge = mk('e1', 'Поставка картриджей', 85970);
  const found = mk('f1', 'Запрос цен: картриджи Xerox', null);
  const foundUnconfirmed = mk('f2', 'Запрос цен: мониторы', null);
  const noDataWithPrice = mk('n1', 'Поставка камер', 50000);
  const late = mk('l1', 'Запрос цен: коммутаторы', null, { deadline_at: '2026-10-01T06:00:00Z' });
  for (const id of [edge, found, foundUnconfirmed, noDataWithPrice, late]) repo.setScore(id, { score: 80, verdict: 'подходит', reasons: [], concerns: [] }, 1);
  const noData = { verdict: 'нет данных', reasons: ['не известна НМЦК'], result: null };
  repo.saveEconomics(edge, { result: { verdict: 'на грани', result: { profit: 7370, margin_pct: 9, purchase: 54887 } }, confirmed: true });
  repo.saveEconomics(foundUnconfirmed, { result: noData, confirmed: false });
  repo.saveEconomics(noDataWithPrice, { result: noData, confirmed: true });
  repo.saveEconomics(late, { result: noData, confirmed: true });
  repo.saveItems(found, [{ name: 'Картридж Xerox 106R02609', characteristics: [], quantity: 3, unit: 'шт', unit_price: null, source: 'notification' }], { source: 'notification' });
  const item = repo.getItems(found)[0];
  const offerId = repo.insertOffer({ tender_id: found, item_id: item.id, source: 'yandex', title: 'Xerox 106R02609', price: 10410, unit_price: 10410, pack_qty: 1, seller_name: 'ООО Тонер', match: 'соответствует', match_notes: [], delivery_cost: 0 });
  repo.setItemOffer(item.id, repo.getOffer(offerId), 'auto');
  // Расчёт сохраняем после позиций и выбранных цен: сохранение позиций сбрасывает прежний расчёт.
  repo.saveEconomics(found, { result: noData, confirmed: true });
  assert.equal(purchaseTotal(repo.getItems(found)), 31230);

  const sent = [];
  const bot = { allowedChatIds: ['42'], sendMessage: async (chatId, text) => { sent.push(text); } };
  const alerts = createAlertService({ repo, getBot: () => bot, config: { PUBLIC_BASE_URL: 'https://app.test', DIGEST_TZ: 'Europe/Moscow' }, log: {}, clock: () => NOW });
  assert.deepEqual(await alerts.check(), { fresh: 2, sent: 2 });
  const list = repo.listAlerts(NOW.toISOString());
  assert.deepEqual(list.map((t) => [t.id, t.alert_kind, t.still]).sort(), [[edge, 'edge', true], [found, 'found', true]].sort());
  assert.equal(list.find((t) => t.id === found).alert_purchase, 31230, 'запоминаем, во сколько обойдётся товар');
  assert.ok(sent.some((s) => /на грани/i.test(s) && /7\s?370/.test(s)), sent.join('\n---\n'));
  const foundText = sent.find((s) => /цена заказчика не указана/.test(s));
  assert.match(foundText, /Товар обойдётся ≈ <b>31\s?230/);
  assert.doesNotMatch(foundText, /Прибыль/);
  assert.deepEqual(await alerts.check(), { fresh: 0, sent: 0 }, 'повторно не сообщаем');

  // «на грани» → «выгодно»: закупка стала лучше — новое уведомление, снова непрочитанное
  repo.markAlertsRead(null, NOW.toISOString());
  repo.saveEconomics(edge, { result: { verdict: 'выгодно', result: { profit: 20000, margin_pct: 23, purchase: 45000 } }, confirmed: true });
  assert.deepEqual(await alerts.check(), { fresh: 1, sent: 1 });
  const up = repo.listAlerts(NOW.toISOString()).find((t) => t.id === edge);
  assert.deepEqual([up.alert_kind, up.alert_read_at, up.still], ['profit', null, true]);
  assert.match(sent.at(-1), /Выгодная закупка/);
  // «выгодно» → «на грани»: хуже — молчим, а прежнее уведомление помечается неактуальным
  repo.saveEconomics(edge, { result: { verdict: 'на грани', result: { profit: 5000, margin_pct: 6, purchase: 60000 } }, confirmed: true });
  assert.deepEqual(await alerts.check(), { fresh: 0, sent: 0 });
  assert.equal(repo.listAlerts(NOW.toISOString()).find((t) => t.id === edge).still, false);
  assert.match(formatAlert({ id: 1, title: 'Запрос цен', price: null, law: 'com', region: null, deadline_at: null }, { kind: 'found', econ: null, items: [], offers: [], baseUrl: 'x' }), /Где купить товар/);
});

test('уведомление агента заявок «на грани» не перезаписывает; «выгодно» по расчёту — перезаписывает', async () => {
  const { createAlertService } = require('../server/tenders/alerts');
  const repo = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-al3-')));
  const NOW = new Date('2026-10-02T09:00:00Z');
  const id = repo.upsertTender({ law: '44', number: 'ag1', title: 'Поставка картриджей', price: 30000, currency: 'RUB', customer_inn: null, stage: 1, region: 78, okpd2: [], ktru: [], deadline_at: '2026-10-08T06:00:00Z', eis_url: null, published_at: '2026-10-01T06:00:00Z' }).id;
  repo.setScore(id, { score: 80, verdict: 'подходит', reasons: [], concerns: [] }, 1);
  repo.saveEconomics(id, { result: { verdict: 'на грани', result: { profit: 3000, margin_pct: 10, purchase: 26000 } }, confirmed: true });
  repo.markAlerted(id, NOW.toISOString(), 'agent', null);
  const alerts = createAlertService({ repo, getBot: () => null, config: { DIGEST_TZ: 'Europe/Moscow' }, log: {}, clock: () => NOW });
  assert.deepEqual(await alerts.check(), { fresh: 0, sent: 0 });
  assert.equal(repo.listAlerts(NOW.toISOString()).find((t) => t.id === id).alert_kind, 'agent');
  repo.saveEconomics(id, { result: { verdict: 'выгодно', result: { profit: 9000, margin_pct: 30, purchase: 20000 } }, confirmed: true });
  await alerts.check();
  assert.equal(repo.listAlerts(NOW.toISOString()).find((t) => t.id === id).alert_kind, 'profit');
});

test('уведомления: в Telegram — только по заданию (маржа и прибыль не ниже), «на грани» — только в ленте', async () => {
  const { createAlertService } = require('../server/tenders/alerts');
  const repo = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-al4-')));
  const NOW = new Date('2026-10-02T09:00:00Z');
  const mk = (number, title) => repo.upsertTender({ law: '44', number, title, price: 100000, currency: 'RUB', customer_inn: null, stage: 1, region: 78, okpd2: [], ktru: [], deadline_at: '2026-10-08T06:00:00Z', eis_url: 'https://zakupki.gov.ru/x', published_at: '2026-10-01T06:00:00Z' }).id;
  const good = mk('g1', 'Поставка мониторов');
  const edge = mk('e1', 'Поставка картриджей');
  for (const id of [good, edge]) repo.setScore(id, { score: 80, verdict: 'подходит', reasons: [], concerns: [] }, 1);
  repo.saveEconomics(good, { result: { verdict: 'выгодно', result: { profit: 20000, margin_pct: 20, purchase: 70000 } }, confirmed: true });
  repo.saveEconomics(edge, { result: { verdict: 'на грани', result: { profit: 1345, margin_pct: 4.6, purchase: 90000 } }, confirmed: true });
  const sent = [];
  const bot = { allowedChatIds: ['42'], sendMessage: async (chatId, text) => { sent.push(text); } };
  const task = { margin_min: 10, profit_min: 5000 };
  const telegramOk = (t) => { const e = repo.getEconomics(t.id); return e.margin_pct >= task.margin_min && e.profit >= task.profit_min; };
  const alerts = createAlertService({ repo, getBot: () => bot, config: { PUBLIC_BASE_URL: 'https://app.test', DIGEST_TZ: 'Europe/Moscow' }, telegramOk, log: {}, clock: () => NOW });
  assert.deepEqual(await alerts.check(), { fresh: 2, sent: 1 });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /мониторов/);
  assert.deepEqual(repo.listAlerts(NOW.toISOString()).map((t) => t.id).sort(), [good, edge].sort(), 'в ленте на сайте — обе');
  assert.deepEqual(await alerts.check(), { fresh: 0, sent: 0 }, '«на грани» не перебирается каждую минуту и не уходит');
});
