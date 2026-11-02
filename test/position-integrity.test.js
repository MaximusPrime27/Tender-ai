// Позиции закупки при повторном сохранении: неизменившаяся позиция остаётся той же строкой (id, своя цена, выбранное
// предложение, прочитанное ТЗ), изменившаяся — новая, без чужих цен. Расчёт выгодности сбрасывается и считается заново.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-integrity-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { id } = repo.upsertTender({ law: '44', number: 'integrity', title: 'Equipment', price: 100,
    currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: null,
    deadline_at: null, stage: 1, eis_url: null });
  const items = ['Camera A', 'Switch B'].map((name) => ({ name, quantity: 1, unit: 'шт', source: 'notification', characteristics: [] }));
  repo.saveItems(id, items);
  return { repo, id, items };
}

test('позиции: перестановка сохраняет id, свою цену и выбранное предложение', (t) => {
  const { repo, id, items } = fixture(t);
  const before = repo.getItems(id);
  repo.setItemManualPrice(id, before[0].id, 42);
  const offerId = repo.insertOffer({ tender_id: id, item_id: before[0].id, source: 'yandex', unit_price: 40 });
  repo.setItemOffer(before[0].id, repo.getOffer(offerId), 'user');
  repo.saveItems(id, [...items].reverse());
  const after = repo.getItems(id);
  const camera = after.find((i) => i.name === 'Camera A');
  assert.equal(camera.id, before[0].id);
  assert.equal(camera.purchase_price_manual, 42);
  assert.equal(camera.purchase_offer_id, offerId);
  assert.equal(after[0].purchase_price_manual, null, 'цена не переехала на другую позицию по номеру строки');
});

test('позиции: изменившаяся позиция не наследует прежние цены и предложения', (t) => {
  const { repo, id, items } = fixture(t);
  const old = repo.getItems(id)[0];
  repo.setItemManualPrice(id, old.id, 42);
  repo.insertOffer({ tender_id: id, item_id: old.id, source: 'yandex', unit_price: 40 });
  repo.saveItems(id, [{ ...items[0], characteristics: [{ name: 'Resolution', value: '8 MP' }] }, items[1]]);
  const current = repo.getItems(id)[0];
  assert.notEqual(current.id, old.id);
  assert.equal(current.purchase_price_manual, null);
  assert.equal(repo.getOffers(id).length, 0);
});

test('позиции: характеристики, дописанные из ТЗ, не делают позицию «изменившейся» при обновлении извещения', (t) => {
  const { repo, id, items } = fixture(t);
  const item = repo.getItems(id)[0];
  // В извещении характеристик нет — их дописало чтение ТЗ (как details.readSpec).
  const required = [{ name: 'Разрешение', value: 'не менее 8 Мп', unit: 'Мп', comparator: 'min', source: null }];
  repo.setItemSpec(item.id, { name: item.name, required, identity: { model: 'DS-2CD2083' }, from: 'tz' }, required.map((r) => ({ name: r.name, value: r.value })));
  repo.setItemManualPrice(id, item.id, 4200);
  const offerId = repo.insertOffer({ tender_id: id, item_id: item.id, source: 'yandex', unit_price: 4100, title: 'DS-2CD2083' });
  repo.setOfferCart(offerId);

  repo.saveItems(id, items); // кнопка «Обновить»: то же извещение, снова без характеристик
  const after = repo.getItems(id).find((i) => i.name === 'Camera A');
  assert.equal(after.id, item.id, 'позиция та же');
  assert.equal(after.spec?.identity?.model, 'DS-2CD2083', 'прочитанное ТЗ не потеряно');
  assert.deepEqual(after.characteristics, [{ name: 'Разрешение', value: 'не менее 8 Мп' }]);
  assert.equal(after.purchase_price_manual, 4200);
  assert.ok(repo.getOffer(offerId), 'найденное предложение и корзина на месте');

  // А если заказчик действительно изменил позицию (другое количество) — это уже новая позиция.
  repo.saveItems(id, [{ ...items[0], quantity: 5 }, items[1]]);
  const changed = repo.getItems(id).find((i) => i.name === 'Camera A');
  assert.notEqual(changed.id, item.id);
  assert.equal(changed.spec, null);
  assert.equal(repo.getOffer(offerId), null);
});

test('позиции: новый поиск оставляет выбранное предложение и убирает остальные найденные', (t) => {
  const { repo, id } = fixture(t);
  const item = repo.getItems(id)[0];
  const selected = repo.insertOffer({ tender_id: id, item_id: item.id, source: 'yandex', unit_price: 40 });
  const unused = repo.insertOffer({ tender_id: id, item_id: item.id, source: 'yandex', unit_price: 50 });
  repo.setItemOffer(item.id, repo.getOffer(selected), 'user');
  repo.clearSearchOffers(id);
  assert.ok(repo.getOffer(selected));
  assert.equal(repo.getOffer(unused), null);
});

test('позиции: обновление сбрасывает расчёт, сохраняя ручные настройки калькулятора, и закупка встаёт в очередь на пересчёт', (t) => {
  const { repo, id, items } = fixture(t);
  repo.setScore(id, { score: 90, verdict: 'подходит', reasons: [], concerns: [] }, 1);
  repo.saveEconomics(id, { overrides: { logistics: 765, tax_pct: 6 }, result: { verdict: 'выгодно', result: { profit: 50, margin_pct: 10 } }, confirmed: true });
  const queue = () => repo.tendersWithoutEconomics({ threshold: 50, limit: 10, nowIso: '2026-01-01T00:00:00.000Z' }).map((x) => x.id);
  assert.deepEqual(queue(), [], 'расчёт есть — пересчитывать нечего');
  repo.saveItems(id, items);
  const econ = repo.getEconomics(id);
  assert.deepEqual(econ.overrides, { logistics: 765, tax_pct: 6 });
  assert.equal(econ.result, null);
  assert.equal(econ.confirmed, null);
  // Строка расчёта осталась (в ней ручные настройки), но результат пуст — фоновый расчёт должен её подобрать,
  // иначе закупка выпадает из «выгодных» и автопоиска, пока не откроют карточку.
  assert.deepEqual(queue(), [id]);
});
