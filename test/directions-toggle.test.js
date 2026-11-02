// Убрать направление с главного экрана и вернуть его: направление выключается, настройки остаются.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const directions = require('../server/tenders/directions');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');

function start() {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-dirs-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, SUPPLIER_INDEX: false, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
    OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '',
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: FIX }) });
  const api = async (p, json) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, { method: json ? 'POST' : 'GET', headers: json ? { 'Content-Type': 'application/json' } : undefined, body: json ? JSON.stringify(json) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { s, api };
}

test('направление убирается с главного экрана и возвращается; последнее включённое убрать нельзя', async () => {
  const { s, api } = start();
  try {
    const profile = s.repo.getProfile();
    const std = directions.loadStandard();
    s.repo.saveProfile({ ...profile, mode: 'resale', directions: std.map((d) => ({ ...d, enabled: d.id === 'computers' || d.id === 'cctv' })) });
    const on = async () => (await api('/api/directions')).body.items.filter((d) => d.enabled).map((d) => d.id);
    assert.deepEqual(await on(), ['computers', 'cctv']);
    const before = s.repo.getProfile().directions.find((d) => d.id === 'cctv');

    const off = await api('/api/directions/cctv/enabled', { enabled: false });
    assert.deepEqual([off.status, off.body.direction.enabled], [200, false]);
    assert.deepEqual(await on(), ['computers']);
    const kept = s.repo.getProfile().directions.find((d) => d.id === 'cctv');
    assert.deepEqual([kept.codes, kept.keywords, kept.title], [before.codes, before.keywords, before.title], 'настройки направления не тронуты');
    assert.ok(!s.repo.getProfile().keywords.some((w) => before.keywords.includes(w) && !s.repo.getProfile().directions.find((d) => d.id === 'computers').keywords.includes(w)), 'слова убранного направления больше не участвуют в загрузке');

    const last = await api('/api/directions/computers/enabled', { enabled: false });
    assert.equal(last.status, 400, 'единственное включённое направление убрать нельзя');
    assert.match(last.body.error, /единственное включённое направление/);
    assert.deepEqual(await on(), ['computers']);

    const back = await api('/api/directions/cctv/enabled', { enabled: true });
    assert.deepEqual([back.status, back.body.direction.enabled], [200, true]);
    assert.deepEqual(await on(), ['computers', 'cctv']);

    assert.equal((await api('/api/directions/no-such/enabled', { enabled: false })).status, 404);
    assert.equal((await api('/api/directions/cctv/enabled', { enabled: 'нет' })).status, 400);
    await s.sync.current?.()?.catch?.(() => {});
  } finally {
    await s.close();
  }
});
