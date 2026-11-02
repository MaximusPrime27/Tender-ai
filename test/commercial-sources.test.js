// Коммерческие закупки площадок (вне ЕИС): ЭТП ГПБ — по карте сайта и страницам процедур, Фабрикант — по поиску
// и страницам коммерческих процедур. Закупки 44/223-ФЗ (они приходят из ЕИС) пропускаются.

const test = require('node:test');
const assert = require('node:assert/strict');
const gpb = require('../server/sources/etpgpb');
const fab = require('../server/sources/fabrikant');

const gpbPage = ({ section, notice = '', status = 'Приём предложений', items = true }) => `<html><body><nav>Поиск по торгам Секции Закупки по 223-ФЗ</nav>
  <h1>Поставка МФУ</h1><div>Дата и время окончания</div><div>30.10.2026, 09:00 Z</div>
  <h2>Основные сведения</h2><div>Секция ЭТП ${section}${notice ? ` Номер извещения ${notice}` : ''} Номер закупки 17900 Наименование закупки Поставка МФУ Способ закупки Ценовой запрос Начальная цена 26 463,00 Валюта процедуры RUB Дата публикации 23.10.2026 01:10 Z</div>
  <h2>Сведения об организаторе</h2><div>Наименование организации ГБУЗ «БОЛЬНИЦА № 1» ИНН 3015011111 КПП 301501001</div>
  <div>Текущий статус ${status} Условия договора Адрес поставки 414000, Астраханская обл, г Астрахань, ул Ленина, д 1 Предполагаемая дата поставки 20.11.2026</div>
  ${items ? '<h2>Перечень товаров</h2><table><tr><td>№ п/п</td><td>Наименование позиции</td><td>Количество</td><td>Единица измерения</td></tr><tr><td>1</td><td>МФУ лазерное A4</td><td>2</td><td>шт</td></tr><tr><td>2</td><td>Картридж к МФУ</td><td>4</td><td>шт</td></tr></table>' : ''}
  <footer>Электронная торговая площадка Группа Газпромбанка</footer></body></html>`;

test('ЭТП ГПБ: страница процедуры — номер, цена, срок, заказчик, регион, позиции; 223-ФЗ и закрытые — пропуск', () => {
  const url = 'https://etpgpb.ru/procedures/etp_click/2087880-postavka-mfu/';
  const t = gpb.parseProcedure(gpbPage({ section: 'ЭТП Клик' }), url);
  assert.equal(t.number, 'GPB-2087880');
  assert.equal(t.title, 'Поставка МФУ');
  assert.equal(t.price, 26463);
  assert.equal(t.deadline_at, '2026-10-30T09:00:00.000Z');
  assert.equal(t.customer_inn, '3015011111');
  assert.equal(t.region, 30);
  assert.deepEqual(t.items.map((i) => [i.name, i.quantity, i.unit]), [['МФУ лазерное A4', 2, 'шт'], ['Картридж к МФУ', 4, 'шт']]);
  assert.equal(gpb.parseProcedure(gpbPage({ section: 'Закупки корпоративных заказчиков', notice: '32616494459' }), url).skip, 'ЕИС');
  assert.equal(gpb.parseProcedure(gpbPage({ section: 'Закупки по 223-ФЗ' }), url).skip, 'ЕИС');
  // с eis: true закупка ЕИС берётся под своим законом и номером; без номера ЕИС — по-прежнему пропуск
  const e = gpb.parseProcedure(gpbPage({ section: 'Закупки по 223-ФЗ', notice: '32616494459' }), url, { eis: true });
  assert.deepEqual([e.law, e.number, e.price], ['223', '32616494459', 26463]);
  assert.equal(gpb.parseProcedure(gpbPage({ section: 'Закупки по 223-ФЗ' }), url, { eis: true }).skip, 'ЕИС');
  assert.equal(gpb.parseProcedure(gpbPage({ section: 'Закупки по 44-ФЗ', notice: '0358300045026000023' }), url, { eis: true }).law, '44');
  assert.equal(gpb.parseProcedure(gpbPage({ section: 'ЭТП Клик', status: 'Завершена' }), url).skip, 'закрыта');
  // номер извещения газпромовской секции («ГП646072») — не ЕИС
  assert.equal(gpb.parseProcedure(gpbPage({ section: 'Закупки корпоративных заказчиков', notice: 'ГП646072' }), url).number, 'GPB-2087880');
});

test('ЭТП ГПБ: свежие процедуры из карты сайта, отбор по словам направлений в адресе, «МФУ» — отдельным словом', async () => {
  const now = new Date('2026-10-23T12:00:00Z');
  const pages = {
    'https://etpgpb.ru/sitemap/procedures.xml': `<urlset><url><loc>https://etpgpb.ru/sitemap/procedures/procedures59.xml</loc><lastmod>2026-09-01T00:00:00+03:00</lastmod></url>
      <url><loc>https://etpgpb.ru/sitemap/procedures/procedures60.xml</loc><lastmod>2026-10-23T03:58:15+03:00</lastmod></url></urlset>`,
    'https://etpgpb.ru/sitemap/procedures/procedures60.xml': `<urlset>
      <url><loc>https://etpgpb.ru/procedures/etp_click/2087880-postavka-mfu/</loc><lastmod>2026-10-23T01:00:00+03:00</lastmod></url>
      <url><loc>https://etpgpb.ru/procedures/etp/1301295-transportno-ekspeditsionnye-uslugi-mfuzhd/</loc><lastmod>2026-10-23T01:00:00+03:00</lastmod></url>
      <url><loc>https://etpgpb.ru/procedures/etp/1301444-postavka-kompyuternogo-oborudovaniya/</loc><lastmod>2026-10-23T01:00:00+03:00</lastmod></url>
      <url><loc>https://etpgpb.ru/procedures/etp/1200000-prodazha-kompyuterov/</loc><lastmod>2026-10-23T01:00:00+03:00</lastmod></url>
      <url><loc>https://etpgpb.ru/procedures/etp/1000001-postavka-mfu-staraya/</loc><lastmod>2026-09-01T01:00:00+03:00</lastmod></url>
    </urlset>`,
    'https://etpgpb.ru/procedures/etp_click/2087880-postavka-mfu/': gpbPage({ section: 'ЭТП Клик' }),
    'https://etpgpb.ru/procedures/etp/1301444-postavka-kompyuternogo-oborudovaniya/': gpbPage({ section: 'Закупки корпоративных заказчиков', notice: '32616494459' }),
  };
  const opened = [];
  const fetchImpl = async (url) => { opened.push(url); return pages[url] ? new Response(pages[url], { status: 200 }) : new Response('', { status: 404 }); };
  const src = gpb.createEtpGpbSource({ fetchImpl, delayMs: 0, clock: () => now, log: { log() {} } });
  const r = await src.fetchNew({ profile: { focus_keywords: ['МФУ', 'компьютер'] } });
  assert.deepEqual(r.items.map((t) => `${t.law} ${t.number}`), ['com GPB-2087880', '223 32616494459']);
  assert.deepEqual((await src.fetchNew({ profile: { focus_keywords: ['МФУ', 'компьютер'], laws: ['com'] } })).items.map((t) => t.number), ['GPB-2087880'], 'профиль без 223-ФЗ — закупку ЕИС не берём');
  assert.ok(!opened.some((u) => /mfuzhd|prodazha|staraya|procedures59/.test(u)), 'чужое слово, продажа, старое и старая часть карты — не открываются');
  assert.ok(opened.includes('https://etpgpb.ru/procedures/etp/1301444-postavka-kompyuternogo-oborudovaniya/'), 'открыта: это 223-ФЗ с номером ЕИС');
  const d = await src.getDetailsDoc(r.items[0]);
  assert.equal(d.items.length, 2);
  assert.equal(d.platform.name, 'ЭТП ГПБ');
});

const fabSearch = (cards) => `<html><script>self.__next_f.push([1,"${cards.map((c) => `[\\"$\\",\\"$L72\\",null,{\\"url\\":\\"${c.url}\\",\\"name\\":\\"${c.name}\\",\\"lotId\\":1,\\"sectionEnum\\":\\"${c.section}\\",\\"procedureNumber\\":1}]`).join(',')}"])</script></html>`;
const fabPage = (section, extra = '') => `<html><body>Фабрикант Коммерческие процедуры Запрос предложений №5589665 Процедурная часть Тип процедуры Закупка
  Секция на торговой площадке ${section} Общее наименование закупки Поставка картриджей для принтеров Требование к отсутствию участника в РНП Да
  Информация о заказчике Тип Юридическое лицо Организация ООО "ВЕТРОПАРК" Почтовый адрес 123112, г. Москва, Пресненская наб., 10 ИНН 7703466461 КПП 770301001
  Дата публикации 23.10.2026 17:31 Действия Лот №1. Поставка картриджей для принтеров - Прием заявок Предмет договора Поставка картриджей ${extra}
  Начальная цена Цена без НДС : 150 000,00 Российский рубль (RUB) Товары и услуги ОКПД2 20.59.12 Тонеры Субъект РФ\\Регион: Город Москва Место поставки товара: по документации
  Дата и время окончания приема заявок 10.11.2026 15:00 Обеспечение заявки Не требуется</body></html>`;

test('Фабрикант: из поиска — только коммерческие процедуры; со страницы — заказчик, цена, срок, регион, ОКПД2; закупка из ЕИС — пропуск', async () => {
  const com = 'https://fabrikant.ru/v2/trades/procedure/view/QBk_PpCyUubjFGFtq5IPGw';
  const c223 = 'https://fabrikant.ru/v2/trades/procedure/view/wJwU4fW8raEASd_R-lL-vA';
  const cards = fab.parseSearch(fabSearch([
    { url: 'https://44.fabrikant.ru/44/procedure/ea21/0744200000226008630', name: 'Заправка картриджей', section: '44fz' },
    { url: c223, name: 'Поставка картриджей', section: '223fz' },
    { url: com, name: 'Поставка картриджей для принтеров', section: 'commercial' },
  ]));
  assert.deepEqual(cards.map((c) => c.section), ['44fz', '223fz', 'commercial']);
  const pages = {
    [`https://www.fabrikant.ru/procedure/search/purchases?query=${encodeURIComponent('картридж')}`]: fabSearch([{ url: com, name: 'Поставка картриджей для принтеров', section: 'commercial' }, { url: c223, name: 'x', section: '223fz' }]),
    'https://www.fabrikant.ru/v2/trades/procedure/view/QBk_PpCyUubjFGFtq5IPGw': fabPage('Коммерческие процедуры'),
  };
  const opened = [];
  const fetchImpl = async (url) => { opened.push(url); return pages[url] ? new Response(pages[url], { status: 200 }) : new Response('', { status: 404 }); };
  const src = fab.createFabrikantSource({ fetchImpl, delayMs: 0, log: { log() {} } });
  const r = await src.fetchNew({ profile: { focus_keywords: ['картридж'] } });
  assert.equal(r.items.length, 1);
  const t = r.items[0];
  assert.equal(t.number, 'FAB-QBk_PpCyUubjFGFtq5IPGw');
  assert.equal(t.price, 150000);
  assert.equal(t.customer_inn, '7703466461');
  assert.equal(t.deadline_at, '2026-11-10T12:00:00.000Z');
  assert.equal(t.region, 77);
  assert.deepEqual(t.okpd2, ['20.59.12']);
  assert.ok(!opened.some((u) => u.includes('wJwU4fW8')), 'закупку 223-ФЗ не открываем');
  assert.equal(fab.parseProcedure(fabPage('Коммерческие процедуры', 'Номер закупки в ЕИС 32616501380'), com).skip, 'ЕИС');
  assert.equal(fab.parseProcedure(fabPage('Закупки по 223-ФЗ'), com).skip, 'не коммерческая');
});

const sb = require('../server/sources/sberast');

const sbRow = (o = {}) => ({
  purchCode: 'SBR028-2610230064.1', IntegratorCode: '', SourceTerm: 'Торги коммерческих заказчиков', PurchaseTypeName: 'Запрос котировок (закупка, с ЭП)', PurchaseWayTerm: 'Закупка',
  PurchaseStageTerm: 'Подача заявок', purchName: 'Запрос котировок в электронной форме', purchAmount: '45600', purchCurrency: 'RUB',
  PublicDate: '23.10.2026 18:40', RequestDate: '28.10.2026 18:00', RegionName: 'Астраханская область', RegionId: '30',
  CustomerInn: '3015011111', CustomerFullName: 'ООО «РОМАШКА»', products: ['Картридж HP CF259X', 'Тонер-картридж Canon 057H', 'Планируется заключение рамочного договора'],
  objectHrefTerm: 'http://utp.sberbank-ast.ru/VIP/NBT/PurchaseView/48/0/0/4267530', ...o,
});

test('Сбербанк-АСТ: строка реестра — номер, цена, срок, заказчик, регион, товары в названии; ЕИС, продажи и закрытые — пропуск', () => {
  const now = new Date('2026-10-23T18:00:00Z');
  const t = sb.parseRow(sbRow(), now);
  assert.equal(t.law, 'com');
  assert.equal(t.number, 'SBAST-SBR028-2610230064.1');
  assert.equal(t.title, 'Запрос котировок в электронной форме: Картридж HP CF259X; Тонер-картридж Canon 057H');
  assert.equal(t.price, 45600);
  assert.equal(t.deadline_at, '2026-10-28T15:00:00.000Z');
  assert.equal(t.published_at, '2026-10-23T15:40:00.000Z');
  assert.equal(t.customer_inn, '3015011111');
  assert.equal(t.region, 30);
  assert.equal(t.eis_url, 'https://utp.sberbank-ast.ru/VIP/NBT/PurchaseView/48/0/0/4267530');
  assert.deepEqual(t.items.map((i) => i.name), ['Картридж HP CF259X', 'Тонер-картридж Canon 057H']);
  // товар уже в названии — к названию ничего не добавляется
  assert.equal(sb.parseRow(sbRow({ purchName: 'Поставка картриджей', products: ['Картриджи для принтера'] }), now).title, 'Поставка картриджей');
  assert.equal(sb.parseRow(sbRow({ IntegratorCode: '32616504208', SourceTerm: 'Закупки по 223-ФЗ' }), now).skip, 'ЕИС');
  assert.equal(sb.parseRow(sbRow({ SourceTerm: 'Госзакупки по 44-ФЗ' }), now).skip, 'другая секция');
  assert.equal(sb.parseRow(sbRow(), now, { eis: true }).skip, 'не ЕИС', 'в проходе 44/223-ФЗ закупки без номера ЕИС не берём');
  assert.equal(sb.parseRow(sbRow({ PurchaseTypeName: 'Анализ рынка' }), now).skip, 'не закупка');
  assert.equal(sb.parseRow(sbRow({ PurchaseStageTerm: 'Работа комиссии' }), now).skip, 'закрыта');
  assert.equal(sb.parseRow(sbRow({ RequestDate: '22.10.2026 10:00' }), now).skip, 'закрыта');
  assert.equal(sb.parseRow(sbRow({ purchAmount: '0' }), now).price, null);
  // запрос реестра: секции повторяются тегами, спецсимволы экранируются
  const body = sb.listRequest({ page: 2, text: 'A&B' });
  assert.match(body.filterBody, /<sourceTerm>Торги коммерческих заказчиков<\/sourceTerm><sourceTerm>/);
  assert.match(body.filterBody, /<pagenum>2<\/pagenum>/);
  assert.match(body.filterBody, /<mainInput>A&amp;B<\/mainInput>/);
});

test('Сбербанк-АСТ: свежие закупки по страницам до конца окна; перечень товаров после перезапуска — поиском по номеру', async () => {
  const now = new Date('2026-10-23T18:00:00Z');
  const fresh = Array.from({ length: 100 }, (_, i) => sbRow({ purchCode: `SBR028-26102300${String(i).padStart(2, '0')}.1`, PublicDate: '23.10.2026 10:00' }));
  const old = [sbRow({ purchCode: 'SBR028-2610190001.1', PublicDate: '19.10.2026 10:00' }), sbRow({ purchCode: 'SBR028-2610230099.2', PublicDate: '23.10.2026 09:00', IntegratorCode: '32616504208' })];
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    const b = JSON.parse(opts.body);
    bodies.push(b);
    assert.equal(url, 'https://www.sberbank-ast.ru/api/Processing/main');
    assert.equal(opts.headers['X-AST-WINDOWCODE'], '/EsOpenUnitedPurchaseList');
    const page = Number(/<pagenum>(\d+)<\/pagenum>/.exec(b.filterBody)[1]);
    const text = /<mainInput>([^<]*)<\/mainInput>/.exec(b.filterBody)?.[1];
    if (b.filterBody.includes('Госзакупки по 44-ФЗ')) return new Response(JSON.stringify({ PurchaseList: [] }), { status: 200 });
    const rows = text ? fresh.filter((r) => r.purchCode.startsWith(text)) : page === 0 ? fresh : page === 1 ? old : [];
    return new Response(JSON.stringify({ Total: 102, PurchaseList: rows.map((r) => ({ _source: r })) }), { status: 200 });
  };
  const src = sb.createSberAstSource({ fetchImpl, delayMs: 0, clock: () => now, log: { log() {} } });
  const pages = [];
  const r = await src.fetchNew({ profile: { price_max: 50000 }, onPage: (p) => pages.push(p.length) });
  assert.equal(r.items.length, 100, 'старая закупка и закупка с номером ЕИС не взяты');
  assert.equal(bodies.length, 3, 'на второй странице окно кончилось — дальше не спрашиваем; третий запрос — раздел 44/223-ФЗ');
  assert.deepEqual(pages, [100]);
  assert.equal((await src.fetchNew({ profile: { price_max: 1000 } })).items.length, 0, 'дороже максимума профиля — не берём');
  // первый опрос после запуска — за 3 дня, даже если прошлое обновление было час назад; следующие — с прошлого обновления
  const hourAgo = new Date(now.getTime() - 3600000).toISOString();
  const fresh2 = sb.createSberAstSource({ fetchImpl, delayMs: 0, clock: () => now, log: { log() {} } });
  assert.equal((await fresh2.fetchNew({ since: hourAgo })).items.length, 100);
  assert.equal((await fresh2.fetchNew({ since: hourAgo })).items.length, 0, 'опубликованные раньше прошлого обновления — уже загружены');
  // новый экземпляр (после перезапуска): позиции находятся поиском по номеру процедуры
  const again = sb.createSberAstSource({ fetchImpl, delayMs: 0, clock: () => now, log: { log() {} } });
  const d = await again.getDetailsDoc({ law: 'com', number: 'SBAST-SBR028-2610230005.1' });
  assert.deepEqual(d.items.map((i) => i.name), ['Картридж HP CF259X', 'Тонер-картридж Canon 057H']);
  assert.equal(d.platform.name, 'Сбербанк-АСТ');
  assert.equal(await again.getDetailsDoc({ law: 'com', number: 'FAB-1' }), null);
});

test('Сбербанк-АСТ: закупки 44-ФЗ и 223-ФЗ — под своим законом и номером ЕИС, отдельным проходом по их разделам', async () => {
  const now = new Date('2026-10-25T13:00:00Z');
  const row44 = sbRow({ purchCode: '0358300045026000023', SourceTerm: 'Госзакупки по 44-ФЗ', PurchaseTypeName: 'Электронный аукцион', PurchaseWayTerm: '', PublicDate: '25.10.2026 15:02', RequestDate: '30.10.2026 12:00', objectHrefTerm: '' });
  const row223 = sbRow({ purchCode: 'SBR003-2610250011', IntegratorCode: '32616520011', SourceTerm: 'Закупки по 223-ФЗ', PublicDate: '25.10.2026 11:00' });
  const t = sb.parseRow(row44, now, { eis: true });
  assert.equal(t.law, '44');
  assert.equal(t.number, '0358300045026000023');
  assert.equal(t.deadline_at, '2026-10-30T09:00:00.000Z');
  assert.equal(t.eis_url, 'https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=0358300045026000023', 'карточка закупки в ЕИС, а не поиск');
  const u = sb.parseRow(row223, now, { eis: true });
  assert.equal(u.law, '223');
  assert.equal(u.number, '32616520011');
  // коммерческий раздел в проходе ЕИС — не берём; без флага закупка ЕИС пропускается, как раньше
  assert.equal(sb.parseRow(sbRow({ IntegratorCode: '32616520012' }), now, { eis: true }).skip, 'другая секция');
  assert.equal(sb.parseRow(row44, now).skip, 'ЕИС');

  const bodies = [];
  const fetchImpl = async (url, opts) => {
    const b = JSON.parse(opts.body);
    bodies.push(b.filterBody);
    const rows = b.filterBody.includes('Госзакупки по 44-ФЗ') ? [row44, row223] : [sbRow({ PublicDate: '25.10.2026 10:00' })];
    return new Response(JSON.stringify({ PurchaseList: rows.map((r) => ({ _source: r })) }), { status: 200 });
  };
  const src = sb.createSberAstSource({ fetchImpl, delayMs: 0, clock: () => now, log: { log() {} } });
  assert.deepEqual(src.laws, ['com', '44', '223']);
  const all = await src.fetchNew({});
  assert.deepEqual(all.items.map((x) => `${x.law} ${x.number}`), ['com SBAST-SBR028-2610230064.1', '44 0358300045026000023', '223 32616520011']);
  // профиль только 44-ФЗ: коммерческий раздел не спрашиваем, 223-ФЗ отсеиваем
  bodies.length = 0;
  const only44 = await sb.createSberAstSource({ fetchImpl, delayMs: 0, clock: () => now, log: { log() {} } }).fetchNew({ profile: { laws: ['44'] } });
  assert.deepEqual(only44.items.map((x) => x.number), ['0358300045026000023']);
  assert.equal(bodies.length, 1);
  // позиции закупки ЕИС площадка не отдаёт — их берёт ГосПлан или ЕИС
  assert.equal(await src.getDetailsDoc({ law: '44', number: '0358300045026000023' }), null);
});
