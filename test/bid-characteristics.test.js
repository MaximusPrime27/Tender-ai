// Характеристики для заявки: инструкция заказчика из извещения, «на проход», значение выбранного товара,
// проверка перед итогом, файл для площадки; позиции не отвязываются от товаров при дописывании характеристик.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { itemsFrom44Notification } = require('../server/tenders/items');
const C = require('../server/bids/characteristics');
const { openDb } = require('../server/db');
const { createCharService } = require('../server/bids/char-service');

const notice = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'notice-0372100041126000094.json'), 'utf8'));
const parsed = () => itemsFrom44Notification(notice).map((it, i) => ({ ...it, id: i + 1, idx: i }));

test('извещение: у характеристик КТРУ инструкция заказчика, диапазон, единица; у позиций мера нацрежима', () => {
  const items = parsed();
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.eis_chars.length), [24, 27, 20, 29]);
  assert.ok(items.every((i) => i.eis_measure === 'ограничение'), 'по ПП 1875 у всех позиций — ограничение');
  const ssd = items[3].eis_chars.find((c) => c.name === 'Общий объем накопителей SSD форм-фактора M.2');
  assert.deepEqual([ssd.fill, ssd.unit, ssd.range.min, ssd.range.min_op], ['concrete', 'Гбайт', 960, 'greaterOrEqual']);
  const port = items[3].eis_chars.find((c) => c.name === 'Тип интерфейса проводного сетевого контроллера');
  assert.equal(port.fill, 'fixed');
});

test('«на проход»: граница диапазона по точности — ≥170→170, >2,6→2,7, <2→1, <50→49, ≥250 и <300→250', () => {
  assert.equal(C.passNumber({ min: 170, min_op: 'greaterOrEqual', max: null }), 170);
  assert.equal(C.passNumber({ min: 2.6, min_op: 'greater', max: null }), 2.7);
  assert.equal(C.passNumber({ min: null, max: 2, max_op: 'less' }), 1);
  assert.equal(C.passNumber({ min: null, max: 50, max_op: 'less' }), 49);
  assert.equal(C.passNumber({ min: 250, min_op: 'greaterOrEqual', max: 300, max_op: 'less' }), 250);
  assert.deepEqual(C.rangeFromText('не менее 145 мм'), { min: 145, min_op: 'greaterOrEqual', max: null, max_op: null });
});

test('таблица позиции: «не менять» как есть, значение товара, несоответствие товара, «на проход» с пометкой', () => {
  const mon = parsed()[2];
  const offer = { specs: [{ name: 'Частота обновления экрана', value: '165 Гц' }, { name: 'Диагональ', value: '27 дюймов' }, { name: 'Страна производства', value: 'Китай' }] };
  const t = C.itemTable(mon, { offer });
  const row = (n) => t.rows.find((r) => r.name.startsWith(n));
  assert.equal(row('Глубина цвета').value, '8 бит');
  assert.equal(row('Разрешение экрана').value, '2560 x 1440', 'одно точное значение — в заявку как есть');
  assert.equal(row('Частота обновления').status, 'conflict', '165 Гц при «не менее 170» — не проходит');
  assert.equal(row('Размер диагонали').status, 'product');
  assert.equal(row('Потребляемая мощность').status, 'pass');
  assert.equal(row('Потребляемая мощность').value, '49 Вт');
  assert.equal(t.country, 'Китай');
  assert.equal(C.nameScore('Частота процессора базовая', 'Частота процессора максимальная') < 0.75, true, 'базовую и максимальную частоту не путаем');
});

test('заказчик запретил «искусственное приведение»: «на проход» не подставляется, и это причина не подавать', () => {
  const t = { ...C.itemTable(parsed()[2], { forbidPass: true }), idx: 0 };
  assert.equal(t.counts.pass, 0);
  assert.ok(t.counts.empty > 0);
  assert.ok(C.forbidsArtificial(['Запрещено искусственное приведение значений показателей товаров.']));
  const p = C.problems([t], { forbidPass: true });
  assert.ok(p.some((x) => x.level === 'block' && /страна происхождения/i.test(x.text)));
  assert.ok(p.some((x) => x.level === 'block' && /не заполнено/.test(x.text)));
});

test('файл для площадки: по позиции знак, страна, нацрежим и «характеристика: значение»; CSV для Excel', () => {
  const t = { ...C.itemTable(parsed()[2], { saved: { trademark: 'Acme', country: 'Россия', values: { 'Частота обновления экрана': '170 Гц' } } }), idx: 2 };
  const txt = C.exportText({ number: '0372100041126000094', title: 'Поставка' }, [t]);
  assert.match(txt, /Позиция 3\. Монитор/);
  assert.match(txt, /Товарный знак: Acme/);
  assert.match(txt, /Страна происхождения: Россия/);
  assert.match(txt, /Национальный режим \(ПП РФ № 1875\): ограничение/);
  assert.match(txt, /Частота обновления экрана: 170 Гц/);
  const csv = C.exportCsv([t]);
  assert.ok(csv.startsWith('﻿"Позиция";'));
});

test('дописывание характеристик ЕИС не отвязывает позицию от выбранного товара; сервис берёт извещение один раз', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-chars-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { id } = repo.upsertTender({ law: '44', number: '0372100041126000094', title: 'Поставка', price: 7001733.42, currency: 'RUB', region: 78, okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: null, stage: 1, eis_url: null });
  // позиции «как раньше» — без характеристик ЕИС
  const old = itemsFrom44Notification(notice).map(({ eis_chars, eis_measure, ...it }) => it);
  repo.saveItems(id, old, { source: 'notification' });
  const before = repo.getItems(id);
  assert.ok(before.every((i) => i.eis_chars == null));
  let calls = 0;
  const source = { getDetailsDoc: async () => { calls++; return notice; } };
  const svc = createCharService({ repo, source, log: { warn() {} } });
  const v = await svc.view(id);
  assert.equal(calls, 1);
  assert.equal(v.tables.length, 4);
  assert.deepEqual(repo.getItems(id).map((i) => i.id), before.map((i) => i.id), "те же позиции");
  await svc.view(id);
  assert.equal(calls, 1, 'второй раз извещение не нужно');
  // обновление позиций из извещения (уже с характеристиками ЕИС) — та же позиция, а не новая
  repo.saveItems(id, itemsFrom44Notification(notice), { source: 'notification' });
  assert.deepEqual(repo.getItems(id).map((i) => i.id), before.map((i) => i.id));
  // страна «во все пустые», своё значение позиции
  const s1 = svc.save(id, { all: true, country: 'Россия' });
  assert.ok((await s1).tables.every((x) => x.country === 'Россия'));
  const s2 = await svc.save(id, { item_id: before[2].id, values: { 'Частота обновления экрана': '170 Гц' }, trademark: 'Acme' });
  const mon = s2.tables.find((x) => x.item_id === before[2].id);
  assert.equal(mon.rows.find((r) => r.name === 'Частота обновления экрана').status, 'manual');
  assert.equal(mon.trademark, 'Acme');
});

test('строгая граница: «менее 2» — 2 не проходит, но с подсказкой про округление; «не более 2» — 2 проходит', () => {
  assert.equal(C.inRange({ min: 1.5, min_op: 'greaterOrEqual', max: 2, max_op: 'less' }, 2), false);
  assert.equal(C.inRange({ min: 1.5, min_op: 'greaterOrEqual', max: 2, max_op: 'lessOrEqual' }, 2), true);
  assert.equal(C.inRange({ min: 1.5, min_op: 'greaterOrEqual', max: 2, max_op: 'less' }, 1.5), true, '«не менее 1,5» — граница входит');
  assert.deepEqual(C.strictBoundary({ max: 2, max_op: 'less' }, 2), { word: 'менее', bound: 2 });
  assert.deepEqual(C.strictBoundary({ min: 1.5, min_op: 'greater' }, 1.5), { word: 'более', bound: 1.5 });
  assert.equal(C.strictBoundary({ max: 2, max_op: 'lessOrEqual' }, 2), null);
  assert.equal(C.strictBoundary({ max: 2, max_op: 'less' }, 2.1), null, 'просто больше — не граница, обычное несоответствие');
});
