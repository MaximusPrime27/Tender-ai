// Извещение «не найдено» в ГосПлане: закупка пришла из ленты ЕИС раньше, чем ГосПлан её загрузил. Раньше ошибка
// запоминалась навсегда — у закупки не было ни срока подачи, ни позиций из извещения. Теперь сервис спрашивает снова.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const NUM = '0332200035226000280';

function start() {
  const fixture = createFixtureSource({ dir: FIX });
  const state = { missing: new Set([NUM]), asked: 0 };
  const source = {
    ...fixture,
    async getDetailsDoc(t) {
      if (t.number === NUM) state.asked++;
      if (state.missing.has(t.number)) throw Object.assign(new Error(`ГосПлан ответил 404 на /fz44/purchases/${t.number}/notification: {"detail":"Документ не найден"}`), { status: 404 });
      const doc = await fixture.getDetailsDoc(t);
      // в образце извещения нет срока подачи — добавляем, как в настоящем извещении ЕИС
      if (t.number !== NUM || !doc) return doc;
      const ni = doc.source?.notificationInfo || {};
      return { ...doc, source: { ...doc.source, notificationInfo: { ...ni, procedureInfo: { ...(ni.procedureInfo || {}), collectingInfo: { endDT: '2026-09-28T10:00:00+03:00' } } } } };
    },
  };
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-notice-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0,
    SUPPLIER_INDEX: false, STAGE_CHECK_PER_SYNC: 0, PLATFORM_FETCH_PER_SYNC: 0, NOTICE_RETRY_PER_SYNC: 15, NOTICE_RETRY_MINUTES: 60,
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: source });
  const api = async (p) => { const r = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`); return { status: r.status, body: await r.json() }; };
  return { s, api, state };
}

/** Закупка как из ленты ЕИС: срока подачи нет; первая попытка извещения — «не найдено». */
async function freshFromEis(s) {
  await s.sync.run();
  const id = s.repo.db.prepare('SELECT id FROM tenders WHERE number = ?').get(NUM).id;
  s.repo.db.prepare('UPDATE tenders SET deadline_at = NULL WHERE id = ?').run(id);
  await s.details.ensureItems(s.repo.getTender(id));
  const d = s.repo.getDetails(id);
  assert.match(d.error, /404/);
  assert.notEqual(d.items_source, 'notification');
  return id;
}
const ago = (s, id, iso) => s.repo.db.prepare('UPDATE tender_details SET fetched_at = ? WHERE tender_id = ?').run(iso, id);

test('извещение появилось в ГосПлане: при открытии закупки — позиции, срок подачи и условия из извещения; ошибка снята', async () => {
  const { s, api, state } = start();
  try {
    const id = await freshFromEis(s);
    // час не прошёл — не спрашиваем (время попытки — по часам сервиса)
    ago(s, id, '2026-09-17T08:30:00.000Z');
    state.missing.delete(NUM);
    const asked = state.asked;
    await api(`/api/tenders/${id}`);
    assert.equal(state.asked, asked, 'меньше часа с прошлой попытки — источник не дёргаем');
    ago(s, id, '2026-09-17T07:00:00.000Z');
    await api(`/api/tenders/${id}`);
    await new Promise((r) => setTimeout(r, 200)); // перезапрос идёт в фоне
    const card = (await api(`/api/tenders/${id}`)).body;
    const d = s.repo.getDetails(id);
    assert.deepEqual([d.items_source, d.error], ['notification', null]);
    assert.ok(card.tender.deadline_at, 'срок подачи — из извещения');
    assert.ok(card.items.length >= 1 && card.items.every((i) => i.source === 'notification'));
  } finally { s.server.close(); }
});

test('извещение появилось, а по закупке уже есть предложение — позиции не трогаем, берём только срок и условия', async () => {
  const { s, state } = start();
  try {
    const id = await freshFromEis(s);
    const [item] = s.repo.getItems(id);
    s.repo.insertOffer({ tender_id: id, item_id: item.id, source: 'manual', title: 'Товар', url: null, domain: null, price: 1000, unit_price: 1000, pack_qty: 1, match: 'соответствует', match_notes: [], trust: 50, trust_reasons: [] });
    ago(s, id, '2026-09-17T07:00:00.000Z');
    state.missing.delete(NUM);
    assert.equal(await s.details.retryNotice(s.repo.getTender(id)), true);
    assert.deepEqual(s.repo.getItems(id).map((i) => i.id), [item.id], 'позиция с предложением осталась той же');
    assert.equal(s.repo.getDetails(id).error, null);
    assert.ok(s.repo.getTender(id).deadline_at, 'срок подачи — из извещения');
    assert.ok(s.repo.getDetails(id).conditions.deadline_at);
  } finally { s.server.close(); }
});

test('фоновый проход: спрашивает снова только «не найденные» и только раз в час; по-прежнему нет — ошибка остаётся', async () => {
  const { s, state } = start();
  try {
    const id = await freshFromEis(s);
    ago(s, id, '2026-09-17T07:00:00.000Z');
    assert.equal(s.repo.noticeRetryCandidates({ limit: 15, olderThanIso: '2026-09-17T08:00:00.000Z', nowIso: '2026-09-17T09:00:00.000Z' }).length, 1);
    const asked = state.asked;
    await s.funnel.idle();
    await s.funnel.retryNotices();
    assert.equal(state.asked, asked + 1, 'спросили один раз');
    assert.match(s.repo.getDetails(id).error, /404/, 'всё ещё нет в источнике — ошибка остаётся, время попытки обновлено');
    await s.funnel.retryNotices();
    assert.equal(state.asked, asked + 1, 'следующий проход — не раньше чем через час');
  } finally { s.server.close(); }
});
