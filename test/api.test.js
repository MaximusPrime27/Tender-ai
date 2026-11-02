process.env.EIS_FILE_INTERVAL_MS = '0'; // в тестах ЕИС подставной — минутная пауза не нужна
// Сквозные проверки HTTP API на временной БД: mock-LLM, fixture-источник, поддельная сеть для скачивания вложений.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { makeDocx, CONTRACT } = require('../samples/make-samples');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timeout');
    await sleep(100);
  }
}

function start({ download } = {}) {
  const config = {
    ...baseConfig, ANALYSIS_READER: 'llm',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-api-')),
    PORT: 0,
    LLM_PROVIDER: 'mock',
    TENDER_SOURCE: 'fixture',
    FIXTURES_DIR: FIX,
    TELEGRAM_BOT_TOKEN: '',
  };
  // Сеть подменена: скачивание вложений отвечает по функции download.
  const fetchImpl = async (url) => download(String(url));
  const log = { log() {}, error() {}, warn() {} };
  const s = startServer(config, { scheduler: false, fetchImpl, log, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: require('../server/sources/fixture').createFixtureSource({ dir: FIX }) });
  const base = () => `http://127.0.0.1:${s.server.address().port}`;
  const api = async (p, opts = {}) => {
    const res = await fetch(base() + p, {
      ...opts,
      headers: opts.json ? { 'Content-Type': 'application/json' } : opts.headers,
      body: opts.json ? JSON.stringify(opts.json) : opts.body,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { s, api };
}

const PROFILE = {
  description: 'Поставка медицинского оборудования для больниц и поликлиник',
  regions: [], price_min: '', price_max: '', codes: [], keywords: [], stop_words: ['ремонт'],
  min_days_to_deadline: 0, laws: ['44', '223'], score_threshold: 40, digest_size: 10,
};

test('API этапа 1 не изменилось: загрузка файла → разбор done', async () => {
  const { s, api } = start({ download: () => { throw new Error('сеть не нужна'); } });
  try {
    const fd = new FormData();
    fd.append('files', new Blob([makeDocx(CONTRACT)]), 'Проект контракта.docx');
    fd.append('title', 'Проверка этапа 1');
    const r = await api('/api/analyses', { method: 'POST', body: fd });
    assert.equal(r.status, 202);
    const a = await waitFor(async () => {
      const x = (await api(`/api/analyses/${r.body.id}`)).body;
      return x.status === 'done' || x.status === 'error' ? x : null;
    });
    assert.equal(a.status, 'done');
    assert.equal(a.title, 'Проверка этапа 1');
    assert.ok(a.card.risks.some((x) => x.type === 'жёсткие_штрафы'));
    assert.equal((await api('/api/analyses')).body.length, 1);
  } finally {
    await s.close();
  }
});

test('профиль: валидация, сохранение, синхронизация и лента', async () => {
  const { s, api } = start({ download: () => { throw new Error('нет'); } });
  try {
    const bad = await api('/api/profile', { method: 'PUT', json: { ...PROFILE, laws: [] } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /закон/);
    assert.equal((await api('/api/profile', { method: 'PUT', json: { ...PROFILE, price_min: 5, price_max: 1 } })).status, 400);

    const saved = await api('/api/profile', { method: 'PUT', json: PROFILE });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.price_min, null);
    assert.deepEqual(saved.body.stop_words, ['ремонт']);
    await waitFor(() => !s.sync.isRunning());

    assert.equal((await api('/api/sync', { method: 'POST' })).status, 202);
    await waitFor(async () => !(await api('/api/sync/status')).body.running);
    const status = (await api('/api/sync/status')).body;
    assert.equal(status.last.status, 'done');
    assert.ok(status.last.new_count >= 60);

    const feed = (await api('/api/tenders?sort=score&limit=5')).body;
    assert.ok(feed.total > 0);
    assert.ok(feed.items[0].score >= feed.items[1].score);
    assert.match(feed.items[0].title, /медицинского оборудования/i);

    const hidden = (await api('/api/tenders?status=filtered')).body;
    assert.ok(hidden.items.some((t) => t.filter_reason === 'стоп-слово: ремонт'));

    const id = feed.items[0].id;
    assert.equal((await api(`/api/tenders/${id}/dismiss`, { method: 'POST' })).status, 200);
    assert.ok(!(await api('/api/tenders?limit=100')).body.items.some((t) => t.id === id));
    assert.equal((await api('/api/tenders/999999/dismiss', { method: 'POST' })).status, 404);

    // Профиль переживает перезапуск (тот же файл БД)
    assert.equal(s.repo.getProfile().description, PROFILE.description);
  } finally {
    await s.close();
  }
});

async function tenderWithAttachments(api, s) {
  await api('/api/profile', { method: 'PUT', json: PROFILE });
  await waitFor(() => !s.sync.isRunning());
  await s.sync.run();
  // У этой закупки среди вложений есть DOCX — поддельная сеть отдаёт DOCX-файл.
  const row = s.repo.db.prepare("SELECT id FROM tenders WHERE law = '44' AND number = ?").get('0132600015226000103');
  return row.id;
}

test('«Разобрать документацию»: вложения скачиваются и разбор доходит до done', async () => {
  const { s, api } = start({
    download: () => new Response(makeDocx(CONTRACT), { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
  });
  try {
    const id = await tenderWithAttachments(api, s);
    const r = await api(`/api/tenders/${id}/analyze`, { method: 'POST' });
    assert.equal(r.status, 202);
    const a = await waitFor(async () => {
      const x = (await api(`/api/analyses/${r.body.analysisId}`)).body;
      return ['done', 'error'].includes(x.status) ? x : null;
    });
    assert.equal(a.status, 'done', `${a.error} ${JSON.stringify(a.files)}`);
    assert.ok(a.files.length > 0);
    const t = (await api('/api/tenders?limit=100&show_hidden=1')).body.items.find((x) => x.id === id);
    assert.equal(t.analysis_id, r.body.analysisId);
    assert.equal(t.analysis_status, 'done');
    assert.ok(t.analysis_recommendation);
  } finally {
    await s.close();
  }
});

test('«Разобрать документацию»: ошибка TLS ЕИС → понятное сообщение со ссылкой на ЕИС', async () => {
  const { s, api } = start({
    download: () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } }); },
  });
  try {
    const id = await tenderWithAttachments(api, s);
    const r = await api(`/api/tenders/${id}/analyze`, { method: 'POST' });
    const a = await waitFor(async () => {
      const x = (await api(`/api/analyses/${r.body.analysisId}`)).body;
      return ['done', 'error'].includes(x.status) ? x : null;
    });
    assert.equal(a.status, 'error');
    assert.match(a.error, /сертификат/);
    assert.match(a.error, /NODE_EXTRA_CA_CERTS/);
    assert.match(a.error, /https:\/\/zakupki\.gov\.ru\/epz\/order\/notice/);
    assert.equal((await api('/api/health')).status, 200, 'сервер продолжает работать');
  } finally {
    await s.close();
  }
});

test('дайджест без Telegram — 400 с подсказкой', async () => {
  const { s, api } = start({ download: () => { throw new Error('нет'); } });
  try {
    const r = await api('/api/digest/send', { method: 'POST' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /TELEGRAM_BOT_TOKEN/);
  } finally {
    await s.close();
  }
});
