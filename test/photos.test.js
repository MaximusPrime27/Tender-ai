// Поиск «как у людей»: фото товаров из ТЗ → поиск по картинке в Яндексе → страницы магазинов.
// Документы и ответы Яндекса подменены, сеть и .env не используются.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { imagesFromDocx, extractPhotos } = require('../server/extract/images');
const { itemForPhoto } = require('../server/tenders/photos');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const big = (n) => Buffer.alloc(20 * 1024, n); // «фото» 20 КБ
const small = Buffer.alloc(2 * 1024, 7); // логотип 2 КБ — отбрасывается

/** Word-файл: текст, картинка после каждой позиции, мелкий логотип и векторная картинка. */
function makeDocx() {
  const z = new AdmZip();
  const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const img = (id) => `<w:p><w:r><w:drawing><a:blip r:embed="${id}"/></w:drawing></w:r></w:p>`;
  z.addFile('word/document.xml', Buffer.from(`<w:document><w:body>${img('rIdLogo')}${p('Техническое задание')}${p('1. Стул пластиковый, цвет белый')}${img('rId1')}${p('2. Стол ученический регулируемый')}${img('rId2')}${img('rIdVec')}</w:body></w:document>`));
  z.addFile('word/_rels/document.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="media/image1.png"/><Relationship Id="rId2" Target="media/image2.jpeg"/><Relationship Id="rIdLogo" Target="media/logo.png"/><Relationship Id="rIdVec" Target="media/vector.emf"/></Relationships>'));
  z.addFile('word/media/image1.png', big(1));
  z.addFile('word/media/image2.jpeg', big(2));
  z.addFile('word/media/logo.png', small);
  z.addFile('word/media/vector.emf', big(3));
  return z.toBuffer();
}

test('фото из Word: только крупные картинки, с текстом перед ними; архивы тоже', () => {
  const photos = imagesFromDocx(makeDocx(), 'ТЗ.docx');
  assert.deepEqual(photos.map((p) => p.name), ['image1.png', 'image2.jpeg'], 'логотип и векторная картинка отброшены');
  assert.match(photos[0].context, /Стул пластиковый/);
  assert.equal(photos[1].mime, 'image/jpeg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-'));
  const zip = new AdmZip();
  zip.addFile('Описание объекта закупки.docx', makeDocx());
  fs.writeFileSync(path.join(dir, 'docs.zip'), zip.toBuffer());
  fs.writeFileSync(path.join(dir, 'Спецификация.docx'), makeDocx());
  const all = extractPhotos(dir);
  assert.equal(all.length, 4);
  assert.match(all[0].file, /Описание объекта закупки/, 'фото из ТЗ / описания объекта закупки — первыми');
  assert.deepEqual(extractPhotos(path.join(dir, 'нет такой папки')), []);
});

test('фото привязывается к позиции, наименование которой стоит перед ним', () => {
  const items = [{ idx: 0, name: 'Стул пластиковый', characteristics: [] }, { idx: 1, name: 'Стол ученический', characteristics: [] }];
  const [chair, desk] = imagesFromDocx(makeDocx(), 'ТЗ.docx');
  assert.equal(itemForPhoto(chair, items).idx, 0);
  assert.equal(itemForPhoto(desk, items).idx, 1);
  assert.equal(itemForPhoto({ context: 'ничего похожего' }, items), null);
  assert.equal(itemForPhoto({ context: '' }, [items[0]]).idx, 0, 'одна позиция — фото её');
});

test('поиск поставщиков: фото из ТЗ уходит в поиск по картинке, найденные страницы открываются', async () => {
  const calls = { byImage: [], pages: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const res = (body, type = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'content-type': type } });
    if (u.endsWith('/v2/image/search_by_image')) {
      const body = JSON.parse(opts.body);
      calls.byImage.push(body);
      return res(JSON.stringify({ images: [{ url: 'https://cdn.shop-photo.ru/1.jpg', pageUrl: 'https://shop-photo.ru/p/1', pageTitle: 'Системный блок Офис', host: 'shop-photo.ru' }], page: 0, maxPage: 3 }), 'application/json');
    }
    if (u.startsWith('https://searchapi.api.cloud.yandex.net')) return res(JSON.stringify({ rawData: Buffer.from('<yandexsearch></yandexsearch>').toString('base64') }), 'application/json');
    if (u.endsWith('/robots.txt')) return res('', 'text/plain', 404);
    calls.pages.push(u);
    return res('<html><head><script type="application/ld+json">{"@type":"Product","name":"Системный блок Офис","offers":{"price":"50000"}}</script></head><body>ИНН 7707083893</body></html>');
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-ph-'));
  const s = startServer({
    ...baseConfig, DATA_DIR: dataDir, PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '', FETCH_MIN_INTERVAL_MS: 0,
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0,
    YANDEX_SEARCH_API_KEY: 'k', YANDEX_FOLDER_ID: 'f', DADATA_API_KEY: '', OFFER_SOURCES: 'photo', SEARCH_MAX_PAGES_PER_ITEM: 5,
  }, { scheduler: false, log: { log() {}, warn() {}, error() {} }, fetchImpl, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: FIX }) });
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0332200035226000280'").get().id;
    await s.details.ensureItems(s.repo.getTender(id));
    const aId = 'a-photo-1';
    s.repo.createAnalysis({ id: aId, title: 'ТЗ' });
    s.repo.finishAnalysis(aId, { card: { groups: [] }, provider: 'mock', model: 'm', durationMs: 0 });
    fs.mkdirSync(path.join(dataDir, 'uploads', aId), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'uploads', aId, 'ТЗ.docx'), makeDocx());
    s.repo.setTenderAnalysis(id, aId);

    // Карточка отдаёт фото и готовый запрос для ручного поиска.
    const port = s.server.address().port;
    const card = await (await fetch(`http://127.0.0.1:${port}/api/tenders/${id}`)).json();
    assert.equal(card.photos.length, 2);
    assert.equal(card.photos[0].item_idx, 0, 'в закупке одна позиция — фото относится к ней');
    assert.ok(card.search_queries[card.items[0].id]);
    const img = await fetch(`http://127.0.0.1:${port}${card.photos[0].url}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await img.arrayBuffer()).byteLength, 20 * 1024);

    const searchId = s.offers.start(id);
    await s.offers.idle();
    const search = s.repo.getOfferSearch(searchId);
    assert.equal(search.status, 'done', search.error);
    assert.equal(calls.byImage.length, 1, 'один запрос поиска по картинке на позицию');
    assert.equal(calls.byImage[0].folderId, 'f');
    assert.equal(Buffer.from(calls.byImage[0].data, 'base64').length, 20 * 1024, 'фото передано целиком в base64');
    assert.ok(calls.pages.includes('https://shop-photo.ru/p/1'), 'страница из поиска по фото открыта');
    assert.ok(search.log.some((l) => /по фото из ТЗ/.test(l.text)));
    const offers = s.repo.getOffers(id);
    assert.ok(offers.some((o) => o.source === 'photo' && o.unit_price === 50000));
  } finally {
    s.server.close();
  }
});

test('запросы для поиска: без знаков сравнения, голых чисел, номеров позиций и «или эквивалент»', () => {
  const { searchValue, searchName, specOf } = require('../server/offers/spec');
  const { queriesFor } = require('../server/offers/sources/yandex-search');
  assert.equal(searchValue({ value: 'не менее 80 и не более 90 г/м2' }), '80 г/м2');
  assert.equal(searchValue({ value: '≥ 50000' }), null, 'голое число поисковику не поможет');
  assert.equal(searchValue({ value: 'не менее 1400 и не более 1600 мм' }), '1400 мм');
  assert.equal(searchValue({ value: 'А4' }), 'А4');
  assert.equal(searchValue({ value: 'Да' }), null);
  assert.equal(searchName('18 Ноутбук ASUS ROG Strix G815JPR-S9037 или эквивалент'), 'Ноутбук ASUS ROG Strix G815JPR-S9037');
  const mfu = { name: 'Многофункциональное устройство (МФУ)', characteristics: [{ name: 'Ресурс', value: '≥ 50000' }, { name: 'Формат', value: 'А4' }, { name: 'Тип печати', value: 'лазерная' }] };
  assert.equal(queriesFor(mfu, 1, { spec: specOf(mfu) })[0], 'МФУ А4 лазерная купить', 'длинное название с сокращением в скобках — в запросе сокращение, как пишут магазины');
});

test('скан страницы документа (лист А4) — не фото товара', () => {
  const { imageSize, looksLikeScannedPage } = require('../server/extract/images');
  const png = (w, h) => { const b = Buffer.alloc(32); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  assert.deepEqual(imageSize(png(1275, 1650)), { width: 1275, height: 1650 });
  assert.equal(looksLikeScannedPage(imageSize(png(1275, 1650))), true, 'страница А4 при 150 dpi');
  assert.equal(looksLikeScannedPage(imageSize(png(2480, 3508))), true, 'страница А4 при 300 dpi');
  assert.equal(looksLikeScannedPage(imageSize(png(800, 600))), false, 'обычное фото товара');
  assert.equal(looksLikeScannedPage(imageSize(png(600, 848))), false, 'небольшая картинка с пропорциями листа — возможно, фото');
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20]), Buffer.alloc(24)]);
  assert.deepEqual(imageSize(jpg), { width: 800, height: 600 });
});

test('картинки из обоснования цены, проекта контракта и форм заявки — не фото товара', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-nd-'));
  fs.writeFileSync(path.join(dir, 'Часть 3. Обоснование НМЦК.docx'), makeDocx());
  fs.writeFileSync(path.join(dir, 'Проект контракта.docx'), makeDocx());
  fs.writeFileSync(path.join(dir, 'Техническое задание.docx'), makeDocx());
  const all = extractPhotos(dir);
  assert.equal(all.length, 2);
  assert.ok(all.every((p) => p.file === 'Техническое задание.docx'));
});
