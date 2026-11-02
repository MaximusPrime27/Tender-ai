// Вкладка «История»: заполнение по уже сделанному, отметка просмотра, «на чём остановились», «убрать».
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createHistory } = require('../server/history');

const tender = (repo, number, title) => repo.upsertTender({ law: '44', number, title, price: 100000, currency: 'RUB', region: 78, okpd2: [], ktru: [], customer_inn: null, published_at: '2026-10-01T00:00:00Z', deadline_at: '2026-10-30T07:00:00Z', stage: 1, eis_url: null }).id;

test('история: по уже сделанному, по просмотрам, состояние закупки и «убрать»', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const a = tender(repo, '0300000000026000001', 'Картриджи');
  const b = tender(repo, '0300000000026000002', 'Бумага');
  const c = tender(repo, '0300000000026000003', 'Ноутбуки');
  repo.saveItems(a, [{ name: 'Картридж', quantity: 12, unit: 'шт', source: 'notification' }, { name: 'Тонер', quantity: 2, unit: 'шт', source: 'notification' }], { source: 'notification' });
  // по закупке «Картриджи» вы уже вписали свою цену — она попадёт в историю сразу; «Бумагу» и «Ноутбуки» не трогали
  const [first] = repo.getItems(a);
  repo.db.prepare('UPDATE tender_items SET purchase_price_manual = 150 WHERE id = ?').run(first.id);

  let now = new Date('2030-01-01T08:00:00Z');
  const h = createHistory({ repo, clock: () => now });
  let list = h.list().items;
  assert.deepEqual(list.map((x) => x.tender_id), [a], 'заполнено по уже сделанному, без чужих закупок');
  assert.equal(list[0].progress.items, 2);
  assert.equal(list[0].progress.chosen, 1);

  // открыли «Бумагу», потом шаг «Поставщики» у «Ноутбуков» — последние сверху, шаг запомнен
  h.visit(b, 'docs');
  now = new Date('2030-01-01T09:00:00Z');
  h.visit(c, 'suppliers');
  h.visit(c, null);
  list = h.list().items;
  assert.deepEqual(list.map((x) => x.tender_id), [c, b, a]);
  assert.equal(list[0].last_step, 'suppliers', 'открытие без шага не затирает последний шаг');
  assert.equal(list[0].visits, 2);
  assert.equal(h.visit(999999, 'docs'), null, 'несуществующая закупка не записывается');
  h.visit(b, 'hack');
  assert.equal(h.list().items.find((x) => x.tender_id === b).last_step, 'docs', 'неизвестный шаг не сохраняется');

  // убрали — пропала; открыли снова — вернулась
  h.hide(b);
  assert.ok(!h.list().items.some((x) => x.tender_id === b));
  now = new Date('2030-01-01T10:00:00Z');
  h.visit(b, 'calc');
  assert.equal(h.list().items[0].tender_id, b);
  assert.equal(h.list().items[0].last_step, 'calc');

  // повторный запуск сервиса не заполняет историю заново
  const again = createHistory({ repo, clock: () => now });
  assert.equal(again.list().items.length, 3);
});
