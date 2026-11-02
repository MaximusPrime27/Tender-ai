// Контакты поставщика: со страниц сайта и из карточки контракта ЕИС.

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractContacts, contactsFromContractSupplier, mergeContacts, normPhone, hasContacts } = require('../server/offers/contacts');
const { parseContract } = require('../server/tenders/benchmark');

test('телефон приводится к одному виду, заглушки и не-телефоны отбрасываются', () => {
  assert.equal(normPhone('8 (812) 123-45-67'), '+7 (812) 123-45-67');
  assert.equal(normPhone('7 9250455557'), '+7 (925) 045-55-57');
  assert.equal(normPhone('+7-495-000-11-22'), '+7 (495) 000-11-22');
  assert.equal(normPhone('9250455557'), '+7 (925) 045-55-57');
  assert.equal(normPhone('+7 (000) 000-00-00'), null);
  assert.equal(normPhone('12345'), null);
  assert.equal(normPhone(''), null);
});

test('со страницы магазина: tel:, mailto:, номер в тексте и ссылка «Контакты»; мусорная почта не берётся', () => {
  const html = `<html><head><script>var a = "+7 999 111-22-33";</script></head><body>
    <header><a href="tel:+78121234567">8 (812) 123-45-67</a> <a href="/about/contacts/">Контакты</a></header>
    <p>Отдел продаж: 8 800 555-35-35, sales@Shop.RU</p>
    <a href="mailto:zakaz@shop.ru?subject=x">Написать</a>
    <img src="logo@2x.png"> <span>noreply@shop.ru</span> <span>hash@sentry.io</span>
  </body></html>`;
  const c = extractContacts(html, 'https://www.shop.ru/product/1');
  assert.deepEqual(c.phones, ['+7 (812) 123-45-67', '+7 (800) 555-35-35']);
  assert.deepEqual(c.emails, ['zakaz@shop.ru', 'sales@shop.ru']);
  assert.equal(c.contacts_url, 'https://www.shop.ru/about/contacts/');
  assert.deepEqual(extractContacts('<p>Нет контактов</p>', 'https://s.ru/'), { phones: [], emails: [], contacts_url: null });
  // ссылка «Контакты» на чужой сайт не берётся
  assert.equal(extractContacts('<a href="https://other.ru/contacts">Контакты</a>', 'https://s.ru/').contacts_url, null);
});

test('из карточки контракта ЕИС: телефон и почта поставщика — юрлицо и предприниматель', () => {
  const ip = { individualPersonRFIndEntr: { EGRIPInfo: { lastName: 'ИВАНОВА', firstName: 'АННА', middleName: 'ПЕТРОВНА', INN: '860231380141', address: 'г Тюмень' },
    otherInfo: { contactEMail: 'IP@YANDEX.RU', contactPhone: '7 9250455557' } } };
  assert.deepEqual(contactsFromContractSupplier(ip), { phone: '+7 (925) 045-55-57', email: 'ip@yandex.ru' });
  const org = { legalEntityRF: { EGRULInfo: { INN: '7707083893', shortName: 'ООО "АРГУМЕНТ"' }, otherInfo: { contactPhone: '8-812-1234567' } } };
  assert.deepEqual(contactsFromContractSupplier(org), { phone: '+7 (812) 123-45-67', email: null });
  assert.deepEqual(contactsFromContractSupplier(null), { phone: null, email: null });

  const contract = { reg_num: '1', docs: [{ source: { products: { product: [{ name: 'Монитор', price: 100, quantity: 1, OKPD2: { code: '26.20.17.110' } }] }, suppliersInfo: { supplierInfo: ip } } }] };
  const parsed = parseContract(contract, '26.20.17.110');
  assert.equal(parsed.supplier.name, 'ИП ИВАНОВА АННА ПЕТРОВНА', 'у предпринимателя вместо названия — ФИО');
  assert.equal(parsed.supplier.phone, '+7 (925) 045-55-57');
  assert.equal(parsed.supplier.email, 'ip@yandex.ru');
});

test('объединение контактов из нескольких источников без повторов', () => {
  const c = mergeContacts({ phones: ['+7 (812) 123-45-67'], emails: [] }, { phone: '+7 (812) 123-45-67', email: 'a@b.ru' }, null, { site: 'https://b.ru', contacts_url: 'https://b.ru/contacts' });
  assert.deepEqual(c, { phones: ['+7 (812) 123-45-67'], emails: ['a@b.ru'], site: 'https://b.ru', contacts_url: 'https://b.ru/contacts' });
  assert.equal(hasContacts(c), true);
  assert.equal(hasContacts(mergeContacts({ site: 'https://b.ru' })), false);
});
