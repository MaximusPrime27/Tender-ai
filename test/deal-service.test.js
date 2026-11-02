// Расчёт сделки через сервер: сбор входов из закупки, свои деньги, подтверждение цены КП, экспресс-проверки,
// утверждение и выгрузка. Суммы — в копейках; пустое значение не становится нулём.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');

function start() {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-deal-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, SUPPLIER_INDEX: false, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
    OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '',
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-10-16T09:00:00Z'), sourceOverride: createFixtureSource({ dir: FIX }) });
  const api = async (p, json, method) => {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${p}`, { method: method || (json ? 'POST' : 'GET'), headers: json ? { 'Content-Type': 'application/json' } : undefined, body: json ? JSON.stringify(json) : undefined });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), headers: res.headers };
  };
  return { s, api };
}

/** Закупка: цена заказчика 200 000 ₽, одна позиция 4 шт по 30 000 ₽ у продавца. */
async function tender(s, api) {
  await s.sync.run();
  const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
  const [item] = await s.details.ensureItems(s.repo.getTender(id));
  s.repo.db.prepare('DELETE FROM tender_items WHERE tender_id = ? AND id != ?').run(id, item.id);
  s.repo.db.prepare('UPDATE tender_items SET quantity = 4, unit_price = 50000, sum = 200000 WHERE id = ?').run(item.id);
  s.repo.db.prepare('UPDATE tenders SET price = 200000 WHERE id = ?').run(id);
  await api(`/api/tenders/${id}/economics`, { items: [{ id: item.id, purchase_price: 30000 }], price: 180000, lead: 'price' });
  return { id, itemId: item.id };
}

test('расчёт сделки: прибыль сходится с выручкой и затратами, суммы в копейках, у фактов есть статус', async () => {
  const { s, api } = start();
  try {
    const { id } = await tender(s, api);
    const v = (await api(`/api/tenders/${id}/deal`)).body;
    const c = v.variants[0].calc;
    assert.equal(c.price, 18000000, 'цена договора 180 000 ₽ — в копейках');
    const goods = v.lines.find((l) => l.kind === 'goods');
    assert.deepEqual([goods.gross, goods.status], [12000000, 'estimate'], 'цена продавца — оценка, пока нет КП');
    assert.equal(c.profit, c.revenue_net - c.costs_total - c.tax, 'прибыль = выручка без НДС − затраты − налог');
    for (const f of v.facts) assert.ok(['confirmed', 'estimate', 'missing', 'conflict', 'expired', 'not_applicable'].includes(f.status), `статус факта ${f.key}`);
    assert.equal(v.facts.find((f) => f.key === 'nmck').value, 20000000);
    // свои деньги не указаны — «не проверено», а не «хватает»
    assert.equal(v.axes.money, 'unknown');
    assert.equal(v.variants[0].cash.gap, null);
    assert.match(v.next_action.text, /своих денег/);
    // все проверки, кроме найденных автоматически, — «не проверено»
    assert.equal(v.checks.find((x) => x.id === 'customer_payments').state, 'not_checked');
    // осторожный вариант не лучше базового
    assert.ok(v.variants[1].calc.profit <= c.profit);
    assert.ok(v.variants[1].cash.recovered_day >= v.variants[0].cash.recovered_day);
  } finally { s.server.close(); }
});

test('свои деньги: нехватка видна с днём; заём закрывает нехватку, но телом займа прибыль не меняет', async () => {
  const { s, api } = start();
  try {
    const { id } = await tender(s, api);
    const put = (body) => api(`/api/tenders/${id}/deal`, body, 'PUT');
    const a = (await put({ budget: '50 000' })).body;
    assert.equal(a.inputs.budget, 50000);
    const cash = a.variants[0].cash;
    assert.ok(cash.gap > 0, 'пик вложений больше 50 000 ₽');
    assert.equal(cash.gap, cash.peak_need - 5000000);
    assert.equal(a.axes.money, 'shortfall');
    const profitBefore = a.variants[0].calc.profit;
    const b = (await put({ loan: { amount: '200 000', rate: 0, confirmed: true } })).body;
    assert.equal(b.variants[0].cash.gap, 0, 'заём приходит до оплаты поставщику и гасится из оплаты заказчика — нехватки нет');
    const tl = b.variants[0].cash.timeline;
    assert.ok(tl.findIndex((e) => e.id === 'loan-in') < tl.findIndex((e) => e.kind === 'supplier'));
    assert.ok(tl.findIndex((e) => e.id === 'loan-out') > tl.findIndex((e) => e.id === 'customer-pay'));
    assert.equal(b.variants[0].calc.profit, profitBefore, 'тело займа — не доход и не расход; при 0% прибыль та же');
    // ошибка ввода — понятный отказ, прошлые данные целы
    const bad = await put({ budget: 'много' });
    assert.equal(bad.status, 400);
    assert.equal((await api(`/api/tenders/${id}/deal`)).body.inputs.budget, 50000);
  } finally { s.server.close(); }
});

test('подтверждение цены КП: со сроком — подтверждено, срок прошёл — истёк; проверка «цена у поставщика» следует за ним', async () => {
  const { s, api } = start();
  try {
    const { id, itemId } = await tender(s, api);
    const put = (body) => api(`/api/tenders/${id}/deal`, body, 'PUT');
    assert.equal((await put({ price_confirmation: { item_id: itemId, basis: 'КП', by: 'Иванов' } })).status, 400, 'основание короче 5 символов — отказ');
    const ok = (await put({ price_confirmation: { item_id: itemId, basis: 'КП № 15 от 16.10.2026', valid_until: '2026-11-15', by: 'Иванов' } })).body;
    assert.equal(ok.lines.find((l) => l.kind === 'goods').status, 'confirmed');
    assert.equal(ok.checks.find((x) => x.id === 'supplier_price').state, 'clear');
    const old = (await put({ price_confirmation: { item_id: itemId, basis: 'КП № 3 от 01.09.2026', valid_until: '2026-10-01', by: 'Иванов' } })).body;
    assert.equal(old.lines.find((l) => l.kind === 'goods').status, 'expired');
    assert.equal(old.checks.find((x) => x.id === 'supplier_price').state, 'conflict');
    assert.equal(old.quality.status, 'needs_review');
    const off = (await put({ price_confirmation: { item_id: itemId, revoke: true } })).body;
    assert.equal(off.lines.find((l) => l.kind === 'goods').status, 'estimate');
  } finally { s.server.close(); }
});

test('экспресс-проверка: «риска нет» — только с автором и основанием; изменились данные — оценка устарела', async () => {
  const { s, api } = start();
  try {
    const { id } = await tender(s, api);
    const check = (body) => api(`/api/tenders/${id}/deal/checks/customer_payments`, body);
    assert.equal((await check({ state: 'clear' })).status, 400, 'без автора и основания — отказ');
    assert.equal((await api(`/api/tenders/${id}/deal/checks/nope`, { state: 'clear', by: 'И', note: 'основание' })).status, 404);
    const a = (await check({ state: 'clear', by: 'Иванов', note: 'Проверил картотеку: исков о неоплате нет' })).body;
    const row = a.checks.find((x) => x.id === 'customer_payments');
    assert.deepEqual([row.state, row.manual.by, row.manual.stale], ['clear', 'Иванов', false]);
    const b = (await api(`/api/tenders/${id}/deal`, { contract_price: '170 000' }, 'PUT')).body;
    const after = b.checks.find((x) => x.id === 'customer_payments');
    assert.deepEqual([after.state, after.manual.stale], ['not_checked', true], 'цена изменилась — прежняя оценка не действует');
    const c = (await check({ state: null })).body;
    assert.equal(c.checks.find((x) => x.id === 'customer_payments').manual, undefined, 'оценку можно снять');
  } finally { s.server.close(); }
});

test('утверждение и выгрузка: снимок с автором; после изменения данных — «устарел»; выгрузка с версиями и источниками', async () => {
  const { s, api } = start();
  try {
    const { id } = await tender(s, api);
    assert.equal((await api(`/api/tenders/${id}/deal/approve`, {})).status, 400, 'без автора — отказ');
    const a = (await api(`/api/tenders/${id}/deal/approve`, { by: 'Иванов' })).body;
    assert.deepEqual([a.snapshot.by, a.snapshot.current], ['Иванов', true]);
    const b = (await api(`/api/tenders/${id}/deal`, { budget: '1 000 000' }, 'PUT')).body;
    assert.equal(b.snapshot.current, false, 'данные изменились — утверждённый расчёт устарел');
    const ex = await api(`/api/tenders/${id}/deal/export`);
    assert.match(ex.headers.get('content-disposition'), /attachment/);
    assert.equal(ex.body.versions.formula, 'deal-1');
    assert.ok(ex.body.lines.every((l) => 'source' in l && 'status' in l));
    assert.match(ex.body.note, /в заявку не прикладывается/);
    assert.equal((await api('/api/tenders/999999/deal')).status, 404);
  } finally { s.server.close(); }
});

test('дешёвое предложение, выбранное вами: в расчёте сделки — с вопросом «проверьте цену» и ссылкой на позицию', async () => {
  const { s, api } = start();
  try {
    const { id, itemId } = await tender(s, api);
    s.repo.setItemOffer(itemId, { id: 1, unit_price: 5000, seller_name: 'ООО Дёшево', delivery_cost: 0 }, 'user');
    await api(`/api/tenders/${id}/economics`, { items: [{ id: itemId, purchase_price: '' }] });
    const deal = (await api(`/api/tenders/${id}/deal`)).body;
    const goods = deal.lines.find((l) => l.kind === 'goods');
    assert.equal(goods.gross, 5000 * 4 * 100, 'цена выбранного предложения в расчёте');
    const q = deal.quality.reasons.find((r) => r.code === 'price_far');
    assert.ok(q, 'есть вопрос «проверьте цену»');
    assert.equal(q.item_id, itemId);
    assert.match(q.text, /гораздо ниже рыночной/);
  } finally { s.server.close(); }
});

test('«что сделать сейчас» указывает поле: свои деньги не указаны → поле суммы; указаны → следующий совет со своим полем', async () => {
  const { s, api } = start();
  try {
    const { id } = await tender(s, api);
    const before = (await api(`/api/tenders/${id}/deal`)).body;
    if (before.inputs.budget == null) {
      assert.match(before.next_action.text, /своих денег/);
      assert.equal(before.next_action.focus, 'dealf-budget');
    }
    const after = (await api(`/api/tenders/${id}/deal`, { budget: 500000 }, 'PUT')).body;
    assert.doesNotMatch(after.next_action.text, /своих денег/);
    assert.ok(after.next_action.focus || after.next_action.item_id != null || /Утвердите|КП/.test(after.next_action.action || ''), JSON.stringify(after.next_action));
  } finally { s.server.close(); }
});
