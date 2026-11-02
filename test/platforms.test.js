// Площадка закупки (куда подавать заявку): определение по извещению, хранение, отбор ленты по площадкам.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { normalizePlatform, platformFromDoc, NO_PLATFORM } = require('../server/tenders/platforms');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const readFix = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

test('площадка: одно короткое имя по коду, адресу сайта или названию; незнакомая — без «АО» и кавычек', () => {
  assert.deepEqual(normalizePlatform({ code: 'ETP_SBAST', name: 'АО «Сбербанк-АСТ»', url: 'http://www.sberbank-ast.ru' }), { name: 'Сбербанк-АСТ', url: 'https://www.sberbank-ast.ru' });
  assert.equal(normalizePlatform({ name: 'ЭТП ГПБ', url: 'http://etp.gpb.ru' }).name, 'ЭТП ГПБ');
  assert.equal(normalizePlatform({ code: 'ETP_GPB', name: 'ЭТП Газпромбанк', url: 'https://etpgpb.ru/' }).name, 'ЭТП ГПБ', 'у 44-ФЗ и 223-ФЗ одна площадка называется по-разному');
  assert.equal(normalizePlatform({ name: 'АКЦИОНЕРНОЕ ОБЩЕСТВО "АГЕНТСТВО ПО ГОСУДАРСТВЕННОМУ ЗАКАЗУ РЕСПУБЛИКИ ТАТАРСТАН"', url: 'http://etp.zakazrf.ru' }).name, 'АГЗ РТ');
  assert.equal(normalizePlatform({ code: 'ETP_MMVB', name: 'Электронная торговая площадка «Фабрикант»' }).name, 'Фабрикант');
  assert.equal(normalizePlatform({ name: 'РТС-тендер' }).name, 'РТС-тендер');
  assert.equal(normalizePlatform({ url: 'https://www.roseltorg.ru/procedure/1' }).name, 'Росэлторг');
  assert.deepEqual(normalizePlatform({ name: 'ООО «Электронная торговая площадка Регион»', url: 'https://www.etp-region.ru/lots' }), { name: 'ЭТП Регион', url: 'https://etp-region.ru' });
  assert.equal(normalizePlatform({}), null);
});

test('площадка из подробностей закупки: извещение 44-ФЗ, закупка 223-ФЗ, закупка без площадки', () => {
  assert.equal(platformFromDoc({ law: '44' }, readFix('fz44-notification-0333200014626000140.json')).name, 'Сбербанк-АСТ');
  assert.equal(platformFromDoc({ law: '44' }, readFix('fz44-notification-0132600015226000103.json')).name, 'Фабрикант');
  assert.equal(platformFromDoc({ law: '223' }, readFix('fz223-purchase-32616385078.json')).name, 'ЭТП ГПБ');
  assert.equal(platformFromDoc({ law: '223' }, readFix('fz223-purchase-32616386849.json')).name, 'АГЗ РТ');
  assert.deepEqual(platformFromDoc({ law: '223' }, readFix('fz223-purchase-32616386083.json')), { name: NO_PLATFORM, url: null }, 'закупка у единственного поставщика — не на площадке');
  assert.equal(platformFromDoc({ law: 'com' }, { items: [], platform: { name: 'ТЭК-Торг', url: 'https://www.tektorg.ru/x' } }).name, 'ТЭК-Торг', 'коммерческая площадка называет себя сама');
  assert.equal(platformFromDoc({ law: '44' }, null), null, 'подробности не загрузились — площадка пока неизвестна');
});

function start(overrides = {}, source = createFixtureSource({ dir: FIX })) {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-plat-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, SUPPLIER_INDEX: false, ...overrides,
  };
  const s = startServer(config, {
    scheduler: false, log: { log() {}, warn() {}, error() {} },
    clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: source,
  });
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, {
      method: opts.method, headers: opts.json ? { 'Content-Type': 'application/json' } : undefined, body: opts.json ? JSON.stringify(opts.json) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { s, api };
}

test('лента: площадки узнаются в фоне после обновления, по ним можно отобрать закупки', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    await s.funnel.run();
    const all = (await api('/api/tenders?limit=100')).body;
    const p = (await api('/api/platforms')).body;
    // У закупок, для которых источник отдал подробности, площадка известна; у остальных — «уточняется».
    const names = p.items.map((x) => x.name);
    for (const expected of ['Фабрикант', 'ЭТП ГПБ']) assert.ok(names.includes(expected), `площадки: ${names.join(', ')}`);
    assert.equal(p.total, all.total, 'счётчики — по тем же закупкам, что в ленте');
    assert.equal(p.items.reduce((n, x) => n + x.count, 0) + p.unknown, p.total);
    assert.ok(p.unknown > 0, 'у части закупок подробностей нет — площадка ещё не определена');
    assert.equal(p.items.find((x) => x.name === 'Фабрикант').url, 'https://www.fabrikant.ru');

    // Закупка 44-ФЗ из извещения: площадка — в ленте и в карточке.
    const gpb = all.items.find((t) => t.number === '0332200035226000280');
    assert.deepEqual([gpb.platform, gpb.platform_url], ['ЭТП ГПБ', 'https://etpgpb.ru']);
    assert.equal((await api(`/api/tenders/${gpb.id}`)).body.tender.platform, 'ЭТП ГПБ');

    // Отбор: одна площадка, несколько, «ещё не определена».
    const one = (await api(`/api/tenders?limit=100&platforms=${encodeURIComponent('ЭТП ГПБ')}`)).body;
    assert.equal(one.total, p.items.find((x) => x.name === 'ЭТП ГПБ').count);
    assert.ok(one.items.length > 0 && one.items.every((t) => t.platform === 'ЭТП ГПБ'));
    const two = (await api(`/api/tenders?limit=100&platforms=${encodeURIComponent('ЭТП ГПБ|Фабрикант')}`)).body;
    assert.equal(two.total, one.total + p.items.find((x) => x.name === 'Фабрикант').count);
    const unknown = (await api(`/api/tenders?limit=100&platforms=${encodeURIComponent('?')}`)).body;
    assert.equal(unknown.total, p.unknown);
    assert.ok(unknown.items.every((t) => t.platform == null));
    assert.equal((await api(`/api/tenders?limit=100&platforms=${encodeURIComponent('Такой площадки нет')}`)).body.total, 0);

    // Версия страницы: по ней открытая вкладка понимает, что сервис обновился и её пора перезагрузить.
    const health = (await api('/api/health')).body;
    assert.match(health.version, /^\d{10,}-\d{10,}$/, 'время изменения index.html и help.js');
    assert.equal((await api('/api/health')).body.version, health.version, 'между обновлениями версия не меняется');

    // Счётчики учитывают выбранное направление так же, как лента.
    const dir = (await api('/api/platforms?direction=none')).body;
    assert.equal(dir.total, (await api('/api/tenders?limit=1&direction=none')).body.total);

    // Где опубликована закупка: ЕИС — все госзакупки (44-ФЗ и 223-ФЗ), каким бы путём сервис о них ни узнал.
    assert.deepEqual(p.published.map((x) => x.id), ['eis', 'com']);
    const eisCount = p.published[0].count;
    assert.equal(eisCount + p.published[1].count, p.total, 'каждая закупка либо в ЕИС, либо вне его');
    assert.ok(eisCount > 0);
    const eis = (await api('/api/tenders?limit=100&published=eis')).body;
    assert.equal(eis.total, eisCount);
    assert.ok(eis.items.every((t) => t.law === '44' || t.law === '223'));
    assert.equal((await api('/api/tenders?limit=100&published=com')).body.total, p.published[1].count);
    assert.equal((await api('/api/tenders?limit=100&published=eis,com')).body.total, p.total, 'обе отметки — вся лента');
    // Два вопроса вместе сужают отбор: в ЕИС и на этой площадке.
    assert.equal((await api(`/api/tenders?limit=100&published=eis&platforms=${encodeURIComponent('ЭТП ГПБ')}`)).body.total, one.total);
    assert.equal((await api(`/api/tenders?limit=100&published=com&platforms=${encodeURIComponent('ЭТП ГПБ')}`)).body.total, 0);
    assert.equal((await api('/api/tenders?limit=100&published=что-то')).body.total, all.total, 'незнакомое значение отбор не включает');
    assert.equal(dir.published.reduce((n, x) => n + x.count, 0), dir.total);

    // Коммерческая закупка (не из ЕИС) считается отдельно.
    const some = eis.items[0];
    s.repo.db.prepare("UPDATE tenders SET law = 'com' WHERE id = ?").run(some.id);
    const p2 = (await api('/api/platforms')).body;
    assert.deepEqual(p2.published.map((x) => x.count), [eisCount - 1, 1]);
    assert.deepEqual((await api('/api/tenders?limit=100&published=com')).body.items.map((t) => t.id), [some.id]);

    // Счётчики одного вопроса — в пределах отмеченного в другом: число у площадки равно тому, что покажет лента.
    const inCom = (await api('/api/platforms?published=com')).body;
    assert.equal(inCom.items.reduce((n, x) => n + x.count, 0) + inCom.unknown, 1, 'вне ЕИС — одна закупка, она и посчитана');
    assert.equal(inCom.total, p.total, 'total — вся лента, от отметок не зависит');
    assert.deepEqual(inCom.published.map((x) => x.count), [eisCount - 1, 1], 'свои отметки счётчики вопроса не сужают');
    const onGpb = (await api(`/api/platforms?platforms=${encodeURIComponent('ЭТП ГПБ')}`)).body;
    const gpbFeed = async (pub) => (await api(`/api/tenders?limit=1&published=${pub}&platforms=${encodeURIComponent('ЭТП ГПБ')}`)).body.total;
    assert.deepEqual(onGpb.published.map((x) => x.count), [await gpbFeed('eis'), await gpbFeed('com')]);
    assert.equal(onGpb.items.find((x) => x.name === 'Фабрикант').count, p2.items.find((x) => x.name === 'Фабрикант').count);
  } finally {
    await s.close();
  }
});

test('площадки: фоновое определение можно выключить и запустить по запросу; закупки с самой площадки получают её сразу', async () => {
  const { s, api } = start({ PLATFORM_FETCH_PER_SYNC: 0 });
  try {
    await s.sync.run();
    await s.funnel.run();
    let p = (await api('/api/platforms')).body;
    assert.deepEqual([p.items.length, p.unknown], [0, p.total], 'PLATFORM_FETCH_PER_SYNC=0 — в фоне площадки не узнаём');

    const r = await api('/api/platforms/fill', { method: 'POST', json: { limit: 500 } });
    assert.equal(r.status, 202);
    assert.equal(r.body.pending, p.total);
    await s.funnel.fillPlatforms();
    p = (await api('/api/platforms')).body;
    assert.ok(p.items.some((x) => x.name === 'ЭТП ГПБ'));

    // Закупка, пришедшая с Росэлторга: источник и есть площадка.
    const any = s.repo.db.prepare('SELECT id FROM tenders WHERE platform IS NULL LIMIT 1').get();
    s.repo.db.prepare("UPDATE tenders SET source = 'roseltorg' WHERE id = ?").run(any.id);
    await s.funnel.fillPlatforms({ limit: 0 });
    assert.deepEqual(s.repo.db.prepare('SELECT platform, platform_url FROM tenders WHERE id = ?').get(any.id).platform, 'Росэлторг');
  } finally {
    await s.close();
  }
});

test('площадки: закупки, которых в источнике нет (ответ 404), не останавливают очередь — их откладываем и идём дальше', async () => {
  // Как у боевого ГосПлана: про часть закупок он отвечает «не найдено». Раньше три такие закупки в начале очереди
  // считались сбоем источника, проход останавливался — и площадки остальных закупок не узнавались никогда.
  const fixture = createFixtureSource({ dir: FIX });
  const asked = [];
  const source = {
    ...fixture,
    async getDetailsDoc(t) {
      asked.push(t.number);
      const doc = await fixture.getDetailsDoc(t);
      if (!doc) throw Object.assign(new Error('ГосПлан ответил 404'), { status: 404 });
      return doc;
    },
  };
  const { s, api } = start({ PLATFORM_FETCH_PER_SYNC: 0 }, source);
  try {
    await s.sync.run();
    await s.funnel.run();
    const total = (await api('/api/platforms')).body.total;
    // Первый проход загружает подробности (там ошибка источника не мешает), второй — спрашивает площадку отдельно.
    await s.funnel.fillPlatforms({ limit: 500 });
    await s.funnel.fillPlatforms({ limit: 500 });
    const p = (await api('/api/platforms')).body;
    assert.ok(p.unknown >= 3, 'закупок без подробностей в примерах больше трёх — раньше на них очередь и вставала');
    for (const name of ['Фабрикант', 'ЭТП ГПБ']) assert.ok(p.items.some((x) => x.name === name), `площадки: ${p.items.map((x) => x.name).join(', ')}`);
    assert.equal(p.items.reduce((n, x) => n + x.count, 0) + p.unknown, total);

    // Отложенные закупки не спрашиваем каждый проход…
    const pending = s.repo.platformCandidates({ limit: 500, nowIso: '2026-09-17T09:00:00Z' });
    assert.deepEqual(pending, [], 'все либо с площадкой, либо отложены');
    const before = asked.length;
    await s.funnel.fillPlatforms({ limit: 500 });
    assert.equal(asked.length, before, 'повторный проход источник не дёргает');
    // …а через полсуток спросим снова: закупка могла появиться в источнике.
    s.repo.db.prepare("UPDATE tenders SET platform_checked_at = '2026-09-01T00:00:00.000Z' WHERE platform IS NULL").run();
    assert.equal(s.repo.platformCandidates({ limit: 500, nowIso: '2026-09-17T09:00:00Z' }).length, p.unknown);

    // Настоящий сбой источника (не «не найдено») проход по-прежнему останавливает — после трёх ошибок подряд.
    let calls = 0;
    source.getDetailsDoc = async () => { calls++; throw new Error('ГосПлан недоступен'); };
    await s.funnel.fillPlatforms({ limit: 500 });
    assert.equal(calls, 3);
  } finally {
    await s.close();
  }
});
