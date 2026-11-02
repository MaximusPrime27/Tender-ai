// Своя цена предложения на шаге «Расчёт»: выгода при цене, которую назначил владелец, и таблица «что будет при
// другой цене». Заказчик цену назвал — своя цена не выше её и равносильна снижению на торгах.

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
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-bid-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
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

/** Закупка с ценой заказчика 200 000 ₽ и одной позицией: 4 шт, закупаем по 30 000 ₽. */
async function tender(s) {
  await s.sync.run();
  const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
  const [item] = await s.details.ensureItems(s.repo.getTender(id));
  s.repo.db.prepare('DELETE FROM tender_items WHERE tender_id = ? AND id != ?').run(id, item.id);
  s.repo.db.prepare('UPDATE tender_items SET quantity = 4, unit_price = 50000, sum = 200000 WHERE id = ?').run(item.id);
  s.repo.db.prepare('UPDATE tenders SET price = 200000 WHERE id = ?').run(id);
  return { id, items: [{ id: item.id, purchase_price: 30000 }] };
}

test('своя цена при цене заказчика: 180 000 из 200 000 — то же, что снижение на 10%; цена и процент не расходятся', async () => {
  const { s, api } = start();
  try {
    const { id, items } = await tender(s);
    const post = (body) => api(`/api/tenders/${id}/economics`, { items, ...body });
    const auto = (await post({})).body.economics;                         // расчёт сервиса: снижение по умолчанию
    const byPct = (await post({ decline_pct: 10 })).body.economics;      // снижение 10% процентом
    assert.equal(byPct.result.result.revenue, 180000);

    const mine = (await post({ price: 180000, lead: 'price' })).body.economics;
    const r = mine.result;
    assert.deepEqual([r.result.revenue, r.result.profit, r.result.margin_pct, r.verdict], [180000, byPct.result.result.profit, byPct.result.result.margin_pct, byPct.result.verdict]);
    assert.equal(Math.round(r.inputs.decline_pct * 100) / 100, 10);
    assert.deepEqual([r.inputs.own_bid, r.inputs.own_price, r.inputs.nmck], [true, false, 200000], 'цена заказчика остаётся ценой заказчика');
    assert.deepEqual([mine.overrides.price, mine.overrides.decline_pct], [180000, undefined], 'сохранена цена; процент считается из неё');

    // выше цены заказчика — отказ простыми словами, расчёт прежний
    const over = await post({ price: 210000, lead: 'price' });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /выше цены заказчика .* заказчик не заплатит больше своей цены/);
    const kept = (await api(`/api/tenders/${id}`)).body.economics;
    assert.deepEqual([kept.overrides.price, kept.result.result.profit], [180000, r.result.profit]);

    // поменяли процент в калькуляторе — действует он, цена стирается
    const pct = (await post({ price: 180000, decline_pct: 5, lead: 'decline' })).body.economics;
    assert.deepEqual([pct.overrides.price, pct.overrides.decline_pct, pct.result.result.revenue, pct.result.inputs.own_bid], [undefined, 5, 190000, false]);
    // снова цена — процент стирается
    const again = (await post({ price: 170000, decline_pct: 5, lead: 'price' })).body.economics;
    assert.deepEqual([again.overrides.price, again.overrides.decline_pct, again.result.result.revenue], [170000, undefined, 170000]);

    // «Вернуть цену заказчика»: своя цена снята — расчёт как до неё
    const back = (await post({ price: '', lead: 'price' })).body.economics;
    assert.deepEqual([back.overrides.price, back.result.inputs.own_bid], [undefined, false]);
    assert.deepEqual([back.result.result.revenue, back.result.result.profit], [auto.result.result.revenue, auto.result.result.profit]);
  } finally {
    await s.close();
  }
});

test('что будет при другой цене: строки от дорогой к дешёвой, текущая выделена, запрос вариантов расчёт не меняет', async () => {
  const { s, api } = start();
  try {
    const { id, items } = await tender(s);
    const saved = (await api(`/api/tenders/${id}/economics`, { items, price: 184000, lead: 'price' })).body.economics;
    const v = saved.price_variants;
    assert.ok(v.length >= 5, `строк: ${v.length}`);
    assert.deepEqual(v.map((x) => x.price), v.map((x) => x.price).slice().sort((a, b) => b - a), 'от дорогой к дешёвой');
    assert.deepEqual(v.map((x) => x.decline_pct), v.map((x) => x.decline_pct).slice().sort((a, b) => a - b), 'снижение растёт');
    assert.deepEqual([v[0].price, v[0].decline_pct, v[0].label], [200000, 0, 'цена заказчика, без снижения']);
    assert.ok([190000, 180000, 170000].every((p) => v.some((x) => x.price === p)), 'на 5, 10 и 15% ниже');
    const cur = v.filter((x) => x.current);
    assert.equal(cur.length, 1);
    assert.deepEqual([cur[0].price, cur[0].profit, cur[0].margin_pct, cur[0].label], [184000, saved.result.result.profit, saved.result.result.margin_pct, 'ваша цена']);
    assert.ok(v.every((x) => x.profit != null && x.verdict), 'в каждой строке — выгода и вывод');
    assert.ok(v[0].profit > v[v.length - 1].profit, 'чем ниже цена, тем меньше выгода');
    const floor = v.find((x) => /самая низкая цена с вашей минимальной прибылью|минимальная с вашей прибылью/.test(x.label));
    assert.ok(floor && floor.price === saved.result.min_bid.price, 'есть строка с самой низкой ценой, при которой прибыль не ниже порога');

    // карточка отдаёт те же варианты, и сохранённый расчёт от этого не меняется
    const card1 = (await api(`/api/tenders/${id}`)).body.economics;
    const card2 = (await api(`/api/tenders/${id}`)).body.economics;
    assert.deepEqual(card1.price_variants, v);
    assert.deepEqual([card2.result, card2.overrides, card2.calculated_at], [card1.result, card1.overrides, card1.calculated_at]);
    assert.deepEqual(card1.result, saved.result);

    // без своей цены текущая строка называется иначе
    const auto = (await api(`/api/tenders/${id}/economics`, { items, price: '', lead: 'price' })).body.economics;
    const now = auto.price_variants.filter((x) => x.current);
    assert.deepEqual([now.length, now[0].label, now[0].price], [1, 'как в расчёте сейчас', auto.result.result.revenue]);
    assert.equal(new Set(auto.price_variants.map((x) => x.price)).size, auto.price_variants.length, 'одна цена — одна строка');
  } finally {
    await s.close();
  }
});

test('закупка без цены заказчика считается как раньше: своя цена — это и есть цена, вариантов нет', async () => {
  const { s, api } = start();
  try {
    const { id, items } = await tender(s);
    s.repo.db.prepare('UPDATE tenders SET price = NULL WHERE id = ?').run(id);
    const e = (await api(`/api/tenders/${id}/economics`, { items, price: 150000 })).body.economics;
    assert.deepEqual([e.result.inputs.own_price, e.result.inputs.own_bid, e.result.inputs.nmck, e.result.result.revenue], [true, false, 150000, 150000]);
    assert.ok(e.result.offer_price?.breakeven > 0, 'ориентиры цены на месте');
    assert.deepEqual(e.price_variants, []);
    const big = await api(`/api/tenders/${id}/economics`, { items, price: 900000 });
    assert.equal(big.status, 200, 'без цены заказчика верхнего предела нет');
  } finally {
    await s.close();
  }
});
