// Агенты в рабочем процессе (AGENT_WORKER=1): сервис их не запускает сам — кнопки оставляют заявку в настройках,
// которую забирает рабочий процесс (server/worker.js); «идёт» на странице видно по незаконченному прогону в базе.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');

test('AGENT_WORKER=1: кнопки «Запустить» оставляют заявку рабочему процессу, сами агентов не запускают', async (t) => {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-worker-')), PORT: 0, TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, SUPPLIER_INDEX: false,
    PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0, OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '', MERLION: false, REGISTRY_MODELS: false,
    AGENT_WORKER: true,
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: FIX }) });
  t.after(() => s.close());
  if (!s.server.listening) await new Promise((r) => s.server.once('listening', r));
  const api = async (p, json) => (await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json || {}) })).json();
  const r = await api('/api/bid-agent/run', { tender_ids: [5], fresh_search: true });
  assert.deepEqual(r, { started: true, queued: true });
  const req = JSON.parse(s.repo.getSetting('worker:bid_run'));
  assert.deepEqual([req.tender_ids, req.fresh_search], [[5], true]);
  assert.equal(s.repo.db.prepare('SELECT COUNT(*) n FROM bid_agent_runs').get().n, 0, 'сервис агента не запускал');
  if (s.agent) {
    assert.equal((await api('/api/agent/run')).queued, true);
    assert.ok(s.repo.getSetting('worker:agent_run'));
  }
  // прогон, начатый в другом процессе, — «идёт» и на странице сервиса
  s.repo.db.prepare("INSERT INTO bid_agent_runs (started_at, status, reason) VALUES (?, 'running', 'morning')").run(new Date().toISOString());
  const view = await (await fetch(`http://127.0.0.1:${s.server.address().port}/api/bid-agent`)).json();
  assert.equal(view.running, true);
});

test('корзина заявок: положить закупку, увидеть со сроком и состоянием, убрать', async (t) => {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-bidcart-')), PORT: 0, TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, SUPPLIER_INDEX: false,
    PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0, OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '', MERLION: false, REGISTRY_MODELS: false,
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-10-25T09:00:00Z'), sourceOverride: createFixtureSource({ dir: FIX }) });
  t.after(() => s.close());
  if (!s.server.listening) await new Promise((r) => s.server.once('listening', r));
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const { id } = s.repo.upsertTender({ law: '44', number: 'bc-1', title: 'Картриджи', price: 30000, currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: '2026-10-24T08:00:00Z', deadline_at: '2026-10-30T06:00:00Z', stage: 1, eis_url: null });
  const post = (on) => fetch(`${base}/api/bid-cart/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) }).then((r) => r.json());
  assert.deepEqual(await post(true), { in_cart: true, count: 1 });
  const list = await (await fetch(`${base}/api/bid-cart`)).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].title, 'Картриджи');
  assert.equal(list.items[0].bid, null, 'заявка ещё не собрана');
  assert.deepEqual(await post(false), { in_cart: false, count: 0 });
});
