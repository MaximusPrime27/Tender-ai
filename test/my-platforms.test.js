// Мои площадки (где есть регистрация): лента по умолчанию — только они и ещё не определённые, «все площадки» —
// без отбора; список хранится на сервере и не меняет версию профиля.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const NOW = '2026-09-17T09:00:00Z';

function start() {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-myplat-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, SUPPLIER_INDEX: false, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
    OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '', KNOWLEDGE_DIR: '', REGISTRY_MODELS: false,
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date(NOW), sourceOverride: createFixtureSource({ dir: FIX }) });
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, {
      method: opts.method, headers: opts.json ? { 'Content-Type': 'application/json' } : undefined, body: opts.json ? JSON.stringify(opts.json) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { s, api };
}

test('мои площадки: «@mine» — только они и неопределённые; не заданы — без отбора; версия профиля не меняется', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    await s.funnel.idle();
    const all = (await api('/api/tenders?limit=100')).body;
    assert.ok(all.total >= 3, 'в примерах достаточно закупок');
    const ids = all.items.map((t) => t.id);
    // площадки трём закупкам: две — на моих, одна — на чужой; остальные — площадка не определена
    s.repo.setPlatform(ids[0], { name: 'Сбербанк-АСТ', url: 'https://www.sberbank-ast.ru' });
    s.repo.setPlatform(ids[1], { name: 'РТС-тендер', url: 'https://www.rts-tender.ru' });
    s.repo.setPlatform(ids[2], { name: 'ТЭК-Торг', url: 'https://www.tektorg.ru' });
    // мои не заданы — «@mine» не отбирает
    assert.equal((await api('/api/tenders?limit=100&platforms=%40mine')).body.total, all.total);
    const version = s.repo.getProfile().version;
    const r = await api('/api/my-platforms', { method: 'PUT', json: { platforms: ['Сбербанк-АСТ', 'РТС-тендер', ' ', 'Сбербанк-АСТ'] } });
    assert.deepEqual(r.body.platforms, ['Сбербанк-АСТ', 'РТС-тендер']);
    assert.equal(s.repo.getProfile().version, version, 'переоценка закупок не запускается');
    const mine = (await api('/api/tenders?limit=100&platforms=%40mine')).body;
    assert.equal(mine.total, all.total - 1, 'чужая площадка скрыта, неопределённые — видны');
    assert.ok(!mine.items.some((t) => t.platform === 'ТЭК-Торг'));
    const p = (await api('/api/platforms')).body;
    assert.deepEqual(p.mine, ['Сбербанк-АСТ', 'РТС-тендер']);
    assert.ok(p.known.some((k) => k.name === 'ЕАТ «Берёзка»'));
  } finally {
    s.close();
  }
});

test('лента: отбор по сложности (по позициям и характеристикам) и сортировка по цене', async () => {
  const { s, api } = start();
  try {
    await s.sync.run();
    await s.funnel.idle();
    const all = (await api('/api/tenders?limit=100')).body.items;
    assert.ok(all.length >= 3);
    const [a, b, c] = all;
    const item = (n, chars) => ({ name: `Товар ${n}`, quantity: 1, unit: 'шт', source: 'notification', characteristics: Array.from({ length: chars }, (_, i) => ({ name: `Х${i}`, value: '1' })) });
    s.repo.saveItems(a.id, [item(1, 5)]); // простая
    s.repo.saveItems(b.id, [item(1, 20)]); // одна позиция, но 20 характеристик — средняя
    s.repo.saveItems(c.id, Array.from({ length: 7 }, (_, i) => item(i, 2))); // сложная
    const ids = async (q) => (await api(`/api/tenders?limit=100&${q}`)).body.items.map((t) => t.id);
    assert.ok((await ids('difficulty=simple')).includes(a.id));
    assert.ok(!(await ids('difficulty=simple')).includes(b.id));
    assert.ok((await ids('difficulty=simple,medium')).includes(b.id));
    assert.deepEqual((await ids('difficulty=complex')).filter((id) => [a.id, b.id, c.id].includes(id)), [c.id]);
    const one = (await api('/api/tenders?limit=100&difficulty=simple')).body.items.find((t) => t.id === a.id);
    assert.equal(one.difficulty, 'simple');
    // неизвестная сложность — у закупок без позиций
    const unknown = await ids('difficulty=unknown');
    assert.ok(!unknown.includes(a.id));
    // сортировка по цене: закупки без цены — в конце
    const asc = (await api('/api/tenders?limit=100&sort=price_asc')).body.items.filter((t) => t.price != null).map((t) => t.price);
    assert.deepEqual(asc, [...asc].sort((x, y) => x - y));
    const desc = (await api('/api/tenders?limit=100&sort=price_desc')).body.items.filter((t) => t.price != null).map((t) => t.price);
    assert.deepEqual(desc, [...desc].sort((x, y) => y - x));
  } finally {
    s.close();
  }
});
