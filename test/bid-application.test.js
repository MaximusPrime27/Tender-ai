// Заявка одним документом по образцу владельца (bids/application.js) и проверки предложения о товаре:
// «да» при требовании «Нет», подозрительно большое число.

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { buildPackage } = require('../server/bids/package');
const { splitPrice } = require('../server/bids/application');

const textOf = (buf) => new AdmZip(buf).readAsText('word/document.xml').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const dossier = { kind: 'ip', name: 'Иванова Анна Сергеевна', data: { fio: 'Иванова Анна Сергеевна', inn: '500100732259', address_reg: '190000, г. Санкт-Петербург, ул. Примерная, д. 1', bank_account: '40802810000000000001', bank_name: 'АО «Банк»', bank_bik: '044525000', bank_corr: '30101810000000000000', vat_payer: false } };
const items = [{ id: 1, idx: 0, name: 'Мышь компьютерная', quantity: 30, unit: 'шт', unit_price: 1000 }];
const chars = { tables: [{ item_id: 1, trademark: 'ExeGate', country: 'Россия', rows: [
  { name: 'Тип подключения', tz: 'Проводной', value: 'Проводной', status: 'ok' },
  { name: 'Разрешение сенсора', unit: 'точек/дюйм', tz: 'не менее 10000', value: '100000', status: 'ok' },
  { name: 'Наличие сканера отпечатка пальца', tz: 'Нет', value: 'да', status: 'ok' },
] }] };
const chosen = new Map([[1, { offer: { title: 'Мышь ExeGate SH-9025' } }]]);
const customer = { org: 'ГБУЗ «Больница № 1»', inn: '7801000000', address: '190000, г. Санкт-Петербург, ул. Больничная, д. 2' };

test('заявка по образцу: участник, заказчик, товар с моделью и страной, декларация ИП, реквизиты; по аукциону — без цены', () => {
  const pkg = buildPackage({ tender: { number: '0372200000026000001', title: 'Поставка мышей' }, classification: { supported: true, scenario: '44_eauction', procedure: 'auction' }, items, chosen, dossier, chars, customer });
  const app = pkg.files.find((f) => f.id === 'application-form');
  assert.ok(app, 'заявка одним документом есть в пакете');
  assert.match(app.path, /Заявка на участие\.docx$/);
  const t = textOf(app.buffer);
  assert.match(t, /на участие в электронном аукционе на поставку товара/);
  assert.match(t, /Индивидуальный предприниматель Иванова Анна Сергеевна, адрес местонахождения: 190000/);
  assert.match(t, /ГБУЗ «Больница № 1», ИНН 7801000000, адрес 190000/);
  assert.match(t, /извещением о проведении электронного аукциона № 0372200000026000001/);
  assert.match(t, /«Мышь компьютерная» Россия Мышь ExeGate SH-9025 шт 30/);
  assert.doesNotMatch(t, /Стоимость, рублей/, 'по аукциону цена подаётся на торгах, не в заявке');
  assert.match(t, /пункт 11 части 1 статьи 31/);
  assert.match(t, /Расчётный счёт: 40802810000000000001/);
  assert.match(t, /Приложений нет/);
  assert.equal(app.todo, 0);
});

test('запрос котировок: цена по позициям пропорционально цене заказчика, «Итого» — ровно утверждённая цена', () => {
  assert.deepEqual(splitPrice(100, [{ unit_price: 10, quantity: 1 }, { unit_price: 20, quantity: 1 }]), [33.33, 66.67]);
  assert.equal(splitPrice(100, [{ unit_price: null, quantity: 1 }]), null);
  const pkg = buildPackage({ tender: { number: '0372200000026000002', title: 'Поставка мышей' }, classification: { supported: true, scenario: '44_equotation', procedure: 'quotation' }, items, chosen, dossier, chars, customer, price: { value: 27030, by: 'вы', at: '2026-10-25' } });
  const t = textOf(pkg.files.find((f) => f.id === 'application-form').buffer);
  assert.match(t, /запросе котировок в электронной форме/);
  assert.match(t, /Стоимость, рублей/);
  assert.match(t, /Итого .*27\s030/);
});

test('предложение о товаре: «да» при требовании «Нет» — метка «не соответствует ТЗ»; 100000 при «не менее 10000» — предупреждение', () => {
  const pkg = buildPackage({ tender: { number: '0372200000026000003', title: 'Поставка мышей' }, classification: { supported: true, scenario: '44_eauction', procedure: 'auction' }, items, chosen, dossier, chars, customer });
  const prop = pkg.files.find((f) => f.id === 'product-proposal');
  assert.match(textOf(prop.buffer), /ЗАПОЛНИТЬ: «Наличие сканера отпечатка пальца»: у выбранного товара «да» — не соответствует ТЗ \(«Нет»\)/);
  assert.ok(prop.todo >= 1);
  const warn = pkg.problems.find((p) => p.kind === 'suspicious_value');
  assert.match(warn.text, /100000 в 10 раз больше требования «не менее 10000»/);
});
