const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { filterReason } = require('../server/tenders/filters');
const { scoreTenders } = require('../server/tenders/scoring');
const { createSyncService } = require('../server/tenders/sync');
const { buildDigestMessages, splitText, TG_LIMIT } = require('../server/tenders/digest');
const { createDigestService, isDigestDue } = require('../server/tenders/digest-service');
const { createLlm } = require('../server/llm');

const NOW = new Date('2026-09-17T09:00:00Z');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-test-'));

const baseProfile = {
  description: 'Поставка медицинского оборудования для больниц. Ремонт не выполняем.',
  regions: [], price_min: null, price_max: null, codes: [], keywords: [], stop_words: [],
  min_days_to_deadline: 2, laws: ['44', '223'], score_threshold: 50, digest_size: 10,
};

let seq = 0;
function tender(extra = {}) {
  seq++;
  return {
    law: '44', number: `T${seq}`, title: `Поставка медицинского оборудования №${seq}`, price: 500000, currency: 'RUB',
    region: 77, okpd2: ['26.60.12.119'], ktru: [], customer_inn: '7700000000',
    published_at: '2026-09-16T08:00:00.000Z', deadline_at: '2099-01-01T05:00:00.000Z', stage: 1,
    eis_url: `https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=T${seq}`, raw_json: {},
    ...extra,
  };
}

test('жёсткие фильтры возвращают понятную причину', () => {
  const p = { ...baseProfile, regions: [77], price_min: 100000, price_max: 1000000, codes: ['26.60'], stop_words: ['Ремонт'], laws: ['44'] };
  assert.equal(filterReason(tender(), p, NOW), null);
  assert.match(filterReason(tender({ law: '223' }), p, NOW), /223-ФЗ исключён/);
  assert.match(filterReason(tender({ region: 50 }), p, NOW), /регион 50/);
  assert.match(filterReason(tender({ price: 50000 }), p, NOW), /ниже минимума/);
  assert.match(filterReason(tender({ price: 5e6 }), p, NOW), /выше максимума/);
  assert.match(filterReason(tender({ okpd2: ['43.21'] }), p, NOW), /коды 43\.21/);
  assert.equal(filterReason(tender({ title: 'РЕМОНТ медицинского оборудования' }), p, NOW), 'стоп-слово: Ремонт');
  assert.match(filterReason(tender({ deadline_at: '2026-09-17T20:00:00Z' }), p, NOW), /до окончания подачи 11 ч/);
  assert.match(filterReason(tender({ deadline_at: '2026-09-16T00:00:00Z' }), p, NOW), /уже закончилась/);
  // пустой профиль ничего не отсекает
  assert.equal(filterReason(tender({ law: '223', region: 1 }), { ...baseProfile, min_days_to_deadline: 0 }, NOW), null);
});

test('скоринг пачками: кривой ответ ломает только свою пачку', async () => {
  const tenders = Array.from({ length: 5 }, () => tender());
  let call = 0;
  const mock = createLlm('mock');
  const llm = {
    async complete(req) {
      call++;
      // вторая пачка (вызовы 2 и 3 — ответ и повтор) возвращает мусор
      if (call === 2 || call === 3) return { text: 'не JSON', usage: {} };
      return mock.complete(req);
    },
  };
  const results = new Map();
  const r = await scoreTenders({ tenders, profile: baseProfile, llm, batchSize: 2, now: NOW, onResult: (t, res) => results.set(t.number, res) });
  assert.equal(call, 4);
  assert.equal(r.scored, 3);
  assert.equal(r.failed, 2);
  assert.deepEqual([...results.values()].map((x) => x.ok), [true, true, false, false, true]);
  assert.match(results.get(tenders[2].number).error, /Некорректный ответ модели/);
  const ok = results.get(tenders[0].number);
  assert.ok(ok.score >= 0 && ok.score <= 100);
  assert.ok(['подходит', 'возможно', 'не подходит'].includes(ok.verdict));
  assert.ok(ok.reasons.length > 0);
});

test('скоринг: пропущенная моделью закупка помечается ошибкой, вердикт выводится из оценки', async () => {
  const tenders = [tender(), tender()];
  const llm = { async complete() { return { text: JSON.stringify({ results: [{ number: tenders[0].number, score: 82.4, reasons: ['r'] }] }) }; } };
  const results = [];
  await scoreTenders({ tenders, profile: baseProfile, llm, now: NOW, onResult: (t, res) => results.push(res) });
  assert.equal(results[0].score, 82);
  assert.equal(results[0].verdict, 'подходит');
  assert.equal(results[1].ok, false);
});

function makeSync(repo, fetchedLists, llm = createLlm('mock')) {
  let i = 0;
  const source = {
    name: 'test',
    fetchNew: async ({ onPage }) => {
      const tenders = fetchedLists[Math.min(i++, fetchedLists.length - 1)];
      await onPage(tenders);
      return { tenders, truncated: false, errors: [] };
    },
  };
  return createSyncService({ repo, source, llmFactory: () => llm, batchSize: 10, clock: () => NOW, log: {} });
}

test('синхронизация: дедупликация, фильтры, оценки и пересчёт после смены профиля', async () => {
  const repo = openDb(tmpDir());
  repo.saveProfile({ ...baseProfile, stop_words: ['ремонт'] });
  const a = tender();
  const b = tender({ title: 'Ремонт медицинского оборудования' });
  const c = tender({ title: 'Поставка угля', okpd2: ['05.10'] });
  const sync = makeSync(repo, [[a, b, c], [a, b, c, tender()]]);

  const r1 = await sync.run();
  assert.equal(r1.status, 'done');
  assert.deepEqual([r1.fetched, r1.newCount, r1.filtered, r1.scored], [3, 3, 1, 2]);

  const r2 = await sync.run();
  assert.deepEqual([r2.fetched, r2.newCount, r2.filtered, r2.scored], [4, 1, 0, 1], 'старые закупки не дублируются и не переоцениваются');
  const runs = repo.db.prepare('SELECT COUNT(*) AS n FROM tenders').get().n;
  assert.equal(runs, 4);
  assert.equal(repo.lastSyncRun().new_count, 1);

  const filtered = repo.listTenders({ status: 'filtered' }).items;
  assert.equal(filtered[0].filter_reason, 'стоп-слово: ремонт');
  assert.equal(repo.listTenders({}).total, 3, 'отсеянные скрыты в ленте по умолчанию');

  // Новый профиль: стоп-слово убрано, добавлен регион — всё пересчитывается без загрузки
  repo.saveProfile({ ...baseProfile, regions: [50] });
  const r3 = await sync.run({ fetch: false });
  assert.equal(r3.fetched, 0);
  assert.equal(r3.filtered, 4);
  assert.match(repo.listTenders({ status: 'filtered' }).items[0].filter_reason, /регион 77/);
  assert.equal(repo.lastSuccessfulSyncRun().source, 'test', 'пересчёт без загрузки не сдвигает окно синхронизации');
});

test('синхронизация: закупка с истёкшим сроком не зависает в статусе new', async () => {
  const repo = openDb(tmpDir());
  const sync = makeSync(repo, [[tender({ deadline_at: '2026-09-01T00:00:00Z' })]]);
  const r = await sync.run();
  assert.equal(r.filtered, 1);
  assert.equal(repo.listTenders({ status: 'filtered' }).items[0].filter_reason, 'подача заявок уже закончилась');
  assert.equal(repo.listTenders({}).total, 0);
});

test('синхронизация: ошибка источника записывается в sync_runs, повторный запуск во время работы запрещён', async () => {
  const repo = openDb(tmpDir());
  let release;
  const source = { name: 'broken', fetchNew: () => new Promise((_, reject) => { release = () => reject(new Error('ГосПлан ответил 503')); }) };
  const sync = createSyncService({ repo, source, llmFactory: () => createLlm('mock'), clock: () => NOW, log: {} });
  const p = sync.run();
  assert.throws(() => sync.run(), /уже идёт/);
  release();
  const r = await p;
  assert.equal(r.status, 'error');
  assert.equal(repo.lastSyncRun().error, 'ГосПлан ответил 503');
  assert.equal(sync.isRunning(), false);
});

test('синхронизация: сбой части запросов сохраняет загруженное, статус partial не сдвигает окно', async () => {
  const repo = openDb(tmpDir());
  const sinces = [];
  const source = {
    name: 'flaky',
    fetchNew: async ({ since, onPage }) => {
      sinces.push(since.toISOString());
      await onPage([tender(), tender()]);
      return { tenders: [], truncated: false, errors: ['223-ФЗ: ГосПлан недоступен'] };
    },
  };
  const sync = createSyncService({ repo, source, llmFactory: () => createLlm('mock'), clock: () => NOW, firstDays: 3, log: {} });
  const r = await sync.run();
  assert.equal(r.status, 'partial');
  assert.equal(r.newCount, 2);
  assert.match(r.warning, /223-ФЗ: ГосПлан недоступен/);
  assert.equal(repo.lastSyncRun().fetched, 2);
  await sync.run();
  assert.equal(sinces[1], sinces[0], 'после partial окно загрузки не сдвигается');
});

function fakeBot(chats = ['111']) {
  const sent = [];
  return { allowedChatIds: chats, sent, async sendMessage(chatId, text, extra) { sent.push({ chatId, text, extra }); } };
}

test('дайджест: порог, порядок, лимит; повторно после «перезапуска» не отправляется', async () => {
  const dir = tmpDir();
  let repo = openDb(dir);
  repo.saveProfile({ ...baseProfile, score_threshold: 50, digest_size: 2 });
  const ids = [tender(), tender(), tender(), tender({ deadline_at: '2026-09-10T00:00:00Z' })].map((t) => repo.upsertTender(t).id);
  const v = repo.getProfile().version;
  repo.setScore(ids[0], { score: 55, verdict: 'возможно', reasons: ['a'], concerns: [] }, v);
  repo.setScore(ids[1], { score: 90, verdict: 'подходит', reasons: ['b'], concerns: [] }, v);
  repo.setScore(ids[2], { score: 30, verdict: 'не подходит', reasons: [], concerns: [] }, v);
  repo.setScore(ids[3], { score: 99, verdict: 'подходит', reasons: [], concerns: [] }, v); // срок истёк

  const bot = fakeBot(['111', '222']);
  const later = new Date(Date.now() + 1000);
  const digest = createDigestService({ repo, getBot: () => bot, tz: 'Europe/Moscow', clock: () => later, log: {} });
  const r = await digest.send();
  assert.equal(r.tenders, 2);
  assert.equal(bot.sent.length, 2, 'по сообщению в каждый чат');
  const text = bot.sent[0].text;
  assert.ok(text.indexOf('Оценка 90') < text.indexOf('Оценка 55'), 'лучшие сверху');
  assert.doesNotMatch(text, /Оценка 30|Оценка 99/);
  assert.deepEqual(bot.sent[0].extra.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`an:${ids[1]}`, `dm:${ids[1]}`]);

  // «Перезапуск»: новый repo на том же файле БД — дата последнего дайджеста сохранилась
  repo = openDb(dir);
  const lastDate = repo.getSetting('last_digest_date');
  assert.ok(lastDate);
  assert.equal(isDigestDue({ now: later, tz: 'Europe/Moscow', digestTime: '00:00', lastDigestDate: lastDate }), false);
  const bot2 = fakeBot();
  const r2 = await createDigestService({ repo, getBot: () => bot2, tz: 'Europe/Moscow', clock: () => new Date(later.getTime() + 1000), log: {} }).send();
  assert.equal(r2.tenders, 0, 'уже отправленные закупки не попадают в следующий дайджест');
  assert.match(bot2.sent[0].text, /нет/);
});

test('дайджест без настроенного бота — понятная ошибка', async () => {
  const repo = openDb(tmpDir());
  await assert.rejects(createDigestService({ repo, getBot: () => null, tz: 'Europe/Moscow', log: {} }).send(), /TELEGRAM_BOT_TOKEN/);
});

test('длинный дайджест делится на сообщения ≤ 4096 символов, у каждого свои кнопки', () => {
  const tenders = Array.from({ length: 15 }, (_, i) => ({
    ...tender({ title: `Поставка <оборудования> & расходных материалов ${'очень длинное наименование '.repeat(20)}` }),
    id: i + 1, score: 90 - i, verdict: 'подходит', reasons: ['x'.repeat(300), 'y'.repeat(300)],
  }));
  const messages = buildDigestMessages(tenders, { tz: 'Europe/Moscow', now: NOW });
  assert.ok(messages.length > 1);
  assert.ok(messages.every((m) => m.text.length <= TG_LIMIT));
  const buttons = messages.flatMap((m) => m.reply_markup.inline_keyboard);
  assert.equal(buttons.length, 15);
  assert.ok(messages[0].text.includes('&lt;оборудования&gt; &amp;'), 'текст экранирован для parse_mode HTML');
  assert.ok(Buffer.byteLength(buttons[14][1].callback_data) <= 64);
});

test('splitText режет по строкам и очень длинные строки', () => {
  const text = ['a'.repeat(3000), 'b'.repeat(3000), 'c'.repeat(9000)].join('\n');
  const parts = splitText(text, 4096);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join('').replace(/\n/g, ''), text.replace(/\n/g, ''));
});

test('время дайджеста считается в заданном часовом поясе', () => {
  // 05:40 UTC = 08:40 МСК
  const now = new Date('2026-09-17T05:40:00Z');
  assert.equal(isDigestDue({ now, tz: 'Europe/Moscow', digestTime: '08:30', lastDigestDate: null }), true);
  assert.equal(isDigestDue({ now, tz: 'Europe/Moscow', digestTime: '09:00', lastDigestDate: null }), false);
  assert.equal(isDigestDue({ now, tz: 'Europe/Moscow', digestTime: '8:30', lastDigestDate: '2026-09-17' }), false);
  assert.equal(isDigestDue({ now, tz: 'Asia/Vladivostok', digestTime: '15:00', lastDigestDate: '2026-09-16' }), true);
});

test('смена только фильтров профиля (виды закупок): оценки не стираются и возвращаются без нейросети', async () => {
  const repo = openDb(tmpDir());
  repo.saveProfile({ ...baseProfile });
  const a = tender();
  const b = tender({ law: '223' });
  let calls = 0;
  const mock = createLlm('mock');
  const llm = { ...mock, async complete(...args) { calls++; return mock.complete(...args); } };
  const sync = makeSync(repo, [[a, b]], llm);
  const r1 = await sync.run();
  assert.equal(r1.scored, 2);
  const callsAfterFirst = calls;
  assert.ok(callsAfterFirst > 0);
  const scoreOf = (n) => repo.db.prepare('SELECT status, score, score_basis FROM tenders WHERE number = ?').get(n);
  const before = scoreOf(a.number);
  assert.ok(before.score != null && before.score_basis, 'у оценки записано, на чём она основана');

  // выключили 44-ФЗ: закупка отсеяна, но оценка сохранена
  repo.saveProfile({ ...baseProfile, laws: ['223'] });
  await sync.run({ fetch: false });
  assert.deepEqual([scoreOf(a.number).status, scoreOf(a.number).score], ['filtered', before.score]);

  // включили обратно: закупка снова в работе с прежней оценкой, нейросеть не вызывалась
  repo.saveProfile({ ...baseProfile, laws: ['44', '223'] });
  const r3 = await sync.run({ fetch: false });
  assert.deepEqual([scoreOf(a.number).status, scoreOf(a.number).score], ['scored', before.score]);
  assert.equal(calls, callsAfterFirst, 'повторной оценки нейросетью не было');
  assert.equal(r3.scored, 2);

  // изменилось описание компании — оценка устарела, считаем заново
  repo.saveProfile({ ...baseProfile, description: 'Теперь поставляем только уголь' });
  await sync.run({ fetch: false });
  assert.ok(calls > callsAfterFirst, 'после смены описания профиля оценка пересчитывается');
});
