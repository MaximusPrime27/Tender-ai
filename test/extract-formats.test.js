// Чтение «трудных» файлов документации: OpenOffice, презентации, HTML/XML под чужим расширением, сканы и картинки
// (распознавание текста), архивы RAR/7z. Внешние программы (tesseract, pdftoppm, bsdtar) заменены подставными.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { extractFile, detectType, readStoredFile, htmlToText, xmlToText } = require('../server/extract');
const { createOcr } = require('../server/extract/ocr');
const { createArchiver } = require('../server/extract/archive');
const { makePdf, makeDocx, makeScanPdf, addScanPage, NOTICE_PAGES } = require('../samples/make-samples');

const noTools = { ocr: { ready: async () => false, pdfReady: async () => false, maxPages: 40 }, archiver: { available: async () => false } };
/** Подставное распознавание: возвращает заранее заданный текст и запоминает, что просили. */
function fakeOcr(textOf = (page) => `Распознанный текст страницы ${page}: поставка картриджей, 12 штук, срок 10 дней`) {
  const calls = [];
  return {
    calls, maxPages: 3,
    ready: async () => true, pdfReady: async () => true,
    image: async (buffer, ext) => { calls.push(['image', ext, buffer.length]); return textOf(1); },
    pdf: async (buffer, { pages = null, onPage = () => {} } = {}) => {
      const list = (pages || [1, 2]).slice(0, 3);
      calls.push(['pdf', pages]);
      list.forEach((p, i) => onPage(i + 1, list.length));
      const pending = (pages || []).slice(list.length); // не дошла очередь — бюджет одного прохода
      return { pages: list.map((p) => ({ page: p, text: textOf(p) })), failed: [], pending, total: null, truncated: pending.length > 0 };
    },
  };
}
const zipOf = (files) => { const z = new AdmZip(); for (const [n, b] of Object.entries(files)) z.addFile(n, Buffer.isBuffer(b) ? b : Buffer.from(b)); return z.toBuffer(); };

test('тип файла определяется по содержимому: DOCX под видом ZIP, HTML под видом DOC, картинки, OpenOffice', () => {
  const docx = makeDocx(['Текст']);
  assert.equal(detectType('Приложение 1.docx.zip', docx), '.docx');
  assert.equal(detectType('без расширения', docx), '.docx');
  assert.equal(detectType('ТЗ.doc', Buffer.from('<html><body>Текст</body></html>')), '.html');
  assert.equal(detectType('ТЗ.xls', Buffer.from('  <!DOCTYPE html><html>')), '.html');
  assert.equal(detectType('выгрузка.doc', Buffer.from('<?xml version="1.0"?><w:wordDocument>')), '.xml');
  assert.equal(detectType('скан.pdf', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0])), '.jpg', 'JPEG под расширением .pdf');
  assert.equal(detectType('a.dat', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), '.png');
  assert.equal(detectType('НМЦК.odt', zipOf({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<x/>' })), '.odt');
  assert.equal(detectType('цены.zip', zipOf({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet', 'content.xml': '<x/>' })), '.ods');
  assert.equal(detectType('доклад.pptx', zipOf({ 'ppt/presentation.xml': '<p/>' })), '.pptx');
  assert.equal(detectType('архив.zip', zipOf({ 'a.txt': 'текст' })), '.zip');
});

test('OpenOffice ODT и презентация PPTX читаются; DOCX, названный архивом, не «рассыпается» на служебные файлы', async () => {
  const odt = zipOf({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': '<office:document-content><office:body><office:text><text:h>Обоснование НМЦК</text:h><text:p>Накопитель данных &quot;SSD&quot;<text:tab/>250&#160;ГБ</text:p>'
      + '<table:table><table:table-row><table:table-cell><text:p>Цена</text:p></table:table-cell><table:table-cell><text:p>4 500 руб.</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>',
    'styles.xml': '<s/>', 'META-INF/manifest.xml': '<m/>',
  });
  const [o, ...rest] = await extractFile({ name: 'НМЦК накопитель данных.odt', buffer: odt }, 0, noTools);
  assert.equal(rest.length, 0, 'один документ, а не набор content.xml / styles.xml / manifest');
  assert.equal(o.status, 'ok');
  assert.match(o.pages[0].text, /Обоснование НМЦК\nНакопитель данных "SSD"\t250.ГБ/);
  assert.match(o.pages[0].text, /Цена \| 4 500 руб\./);

  const pptx = zipOf({
    'ppt/presentation.xml': '<p/>',
    'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Второй слайд: сроки</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Требования к</a:t></a:r><a:r><a:t> товару</a:t></a:r></a:p><a:p><a:r><a:t>Гарантия 12 мес.</a:t></a:r></a:p></p:sld>',
  });
  const [p] = await extractFile({ name: 'Презентация.pptx', buffer: pptx }, 0, noTools);
  assert.deepEqual(p.pages, [{ page: 1, text: 'Требования к товару\nГарантия 12 мес.' }, { page: 2, text: 'Второй слайд: сроки' }]);

  const files = await extractFile({ name: 'Приложение 3.docx.zip', buffer: makeDocx(['Описание объекта закупки', 'Картридж HP CF283A']) }, 0, noTools);
  assert.equal(files.length, 1);
  assert.equal(files[0].status, 'ok');
  assert.match(files[0].pages[0].text, /Картридж HP CF283A/);
});

test('HTML и XML: теги убираются, кодировка Windows-1251 и UTF-16 распознаётся, таблицы читаются построчно', async () => {
  const html1251 = Buffer.concat([
    Buffer.from('<html><head><meta charset="windows-1251"><style>p{color:red}</style><title>t</title></head><body><script>var a = "<b>";</script><h1>', 'latin1'),
    new Uint8Array([0xd2, 0xe5, 0xf5, 0xe7, 0xe0, 0xe4, 0xe0, 0xed, 0xe8, 0xe5]), // «Техзадание» в 1251
    Buffer.from('</h1><table><tr><td>Bumaga&nbsp;A4</td><td>500 &lt;= x</td></tr><tr><td>&laquo;SvetoCopy&raquo;</td><td>&#8470; 1</td></tr></table></body></html>', 'latin1'),
  ]);
  const [h] = await extractFile({ name: 'ТЗ.doc', buffer: html1251 }, 0, noTools);
  assert.equal(h.status, 'ok');
  assert.equal(h.pages[0].text, 'Техзадание\nBumaga A4 | 500 <= x\n«SvetoCopy» | № 1');
  assert.equal(htmlToText(Buffer.from('<p>Один</p><div>Два<br>Три</div>')), 'Один\nДва\nТри');

  assert.equal(xmlToText(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><doc><!-- c --><item>Монитор 24&quot;</item><item><![CDATA[Цена < 20000]]></item></doc>')), 'Монитор 24"\nЦена < 20000');
  const [x] = await extractFile({ name: 'спецификация.xml', buffer: Buffer.from('<?xml version="1.0"?><a><b>Коммутатор</b><c>24 порта</c></a>') }, 0, noTools);
  assert.equal(x.status, 'ok');
  assert.match(x.pages[0].text, /Коммутатор\s+24 порта/);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Срок поставки: 10 дней', 'utf16le')]);
  assert.equal((await extractFile({ name: 'условия.txt', buffer: utf16 }, 0, noTools))[0].pages[0].text, 'Срок поставки: 10 дней');
  assert.equal((await extractFile({ name: 'позиции.csv', buffer: Buffer.from('Товар;Кол-во\nКартридж;5') }, 0, noTools))[0].status, 'ok');
  assert.deepEqual((await extractFile({ name: 'пусто.txt', buffer: Buffer.alloc(0) }, 0, noTools)).map((f) => [f.status, f.message]), [['error', 'Пустой файл (0 байт)']]);
});

test('скан PDF: без программы распознавания — понятная причина; с ней — текст по страницам и пометка «распознано»', async () => {
  const scan = await makeScanPdf(4); // четыре отсканированных листа: изображения без текстового слоя

  const [none] = await extractFile({ name: 'ТЗ скан.pdf', buffer: scan }, 0, noTools);
  assert.equal(none.status, 'scan_no_text');
  assert.match(none.message, /нет программы распознавания/);

  const ocr = fakeOcr();
  const notes = [];
  const [f] = await extractFile({ name: 'ТЗ скан.pdf', buffer: scan }, 0, { ...noTools, ocr, onNote: (n) => notes.push(n) });
  assert.equal(f.status, 'ok');
  assert.deepEqual(ocr.calls, [['pdf', [1, 2, 3, 4]]], 'скан целиком — распознаём все страницы');
  assert.deepEqual(f.pages.map((p) => p.page), [1, 2, 3, 4], 'номера страниц сохраняются — по ним ссылки на источник');
  assert.match(f.pages[1].text, /страницы 2: поставка картриджей/);
  assert.equal(f.pages[3].text, '', 'четвёртая страница — за пределом (в подставном распознавании — 3)');
  assert.match(f.message, /текст распознан автоматически \(3 стр\.; не прочитано страниц: 1 \(4\)/);
  // полнота чтения: файл прочитан частично, непрочитанная страница названа вместе с причиной
  assert.deepEqual([f.coverage.status, f.coverage.expected, f.coverage.processed, f.coverage.unread], ['partial', 4, 3, [{ unit: 4, reason: 'ocr_budget' }]]);
  assert.deepEqual(f.coverage.ocr, [1, 2, 3], 'распознанные страницы помечены — их сверяют с оригиналом');
  assert.deepEqual(notes, ['распознаю скан: страница 1 из 3', 'распознаю скан: страница 2 из 3', 'распознаю скан: страница 3 из 3']);

  // пустые листы: распознавание ничего не нашло
  const [blank] = await extractFile({ name: 'пусто.pdf', buffer: scan }, 0, { ...noTools, ocr: fakeOcr(() => '') });
  assert.equal(blank.status, 'scan_no_text');
  assert.match(blank.message, /текста на страницах не нашлось/);
});

test('PDF с текстом и отсканированным листом внутри: распознаётся только лист-скан', async () => {
  const { PDFDocument } = require('pdf-lib');
  const base = await PDFDocument.load(await makePdf(NOTICE_PAGES));
  await addScanPage(base); // подписанный и отсканированный лист в конце
  const mixed = Buffer.from(await base.save());

  const [plain] = await extractFile({ name: 'Извещение.pdf', buffer: mixed }, 0, noTools);
  assert.equal(plain.status, 'ok');
  assert.match(plain.message, /Страниц-сканов без текста: 1 из 4 — они не прочитаны/);

  const ocr = fakeOcr(() => 'Приложение № 2. Спецификация: тонер-картридж TK-1140, 5 шт.');
  const [f] = await extractFile({ name: 'Извещение.pdf', buffer: mixed }, 0, { ...noTools, ocr });
  assert.deepEqual(ocr.calls, [['pdf', [4]]]);
  assert.match(f.pages[0].text, /Начальная \(максимальная\) цена контракта/, 'страницы с текстом не трогаем');
  assert.match(f.pages[3].text, /TK-1140/);
  assert.match(f.message, /Распознано страниц-сканов: 1 из 1/);
});

test('картинки: скан в JPG распознаётся, логотип пропускается, файл подписи — «текста нет»', async () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30000, 7)]);
  const ocr = fakeOcr();
  const [f] = await extractFile({ name: 'Спецификация.jpg', buffer: jpg }, 0, { ...noTools, ocr });
  assert.equal(f.status, 'ok');
  assert.match(f.pages[0].text, /поставка картриджей/);
  assert.match(f.message, /текст распознан автоматически/);
  assert.deepEqual(ocr.calls, [['image', '.jpg', jpg.length]]);

  const [nothing] = await extractFile({ name: 'фото товара.jpg', buffer: jpg }, 0, { ...noTools, ocr: fakeOcr(() => ' ') });
  assert.deepEqual([nothing.status, /текст не найден/.test(nothing.message)], ['scan_no_text', true]);
  const [noOcr] = await extractFile({ name: 'Спецификация.jpg', buffer: jpg }, 0, noTools);
  assert.equal(noOcr.status, 'scan_no_text');

  const logo = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000)]);
  const [l] = await extractFile({ name: 'logo.png', buffer: logo }, 0, { ...noTools, ocr });
  assert.deepEqual([l.status, /логотип/.test(l.message)], ['unsupported', true]);
  for (const name of ['ТЗ.docx.sig', 'Извещение_50480526.sign', 'x.p7s']) {
    const [s] = await extractFile({ name, buffer: Buffer.from('MIIGxQYJKoZIhvcNAQcCoIIGtjCCBrICAQExDjAMBggqhQMHAQECAgUA') }, 0, noTools);
    assert.deepEqual([s.status, /подписи — текста в нём нет/.test(s.message)], ['unsupported', true], name);
  }
});

test('архивы RAR и 7z: раскрываются внешней программой, вложенное читается; без неё — понятная причина', async () => {
  const rar = Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1');
  const [none] = await extractFile({ name: 'Закупочная_документация.rar', buffer: rar }, 0, noTools);
  assert.equal(none.status, 'unsupported');
  assert.match(none.message, /Архив RAR — на сервере нет программы распаковки/);

  const inner = zipOf({ 'Проект договора.txt': 'Оплата в течение 7 рабочих дней', '__MACOSX/._x': 'мусор' });
  const seen = [];
  const archiver = {
    available: async () => true,
    extractAll: async (buffer, ext) => {
      seen.push(ext);
      return [
        { name: 'ТЗ/Описание объекта закупки.docx', buffer: makeDocx(['Описание объекта закупки', 'МФУ Pantum BM5100ADN']) },
        { name: 'вложение.zip', buffer: inner },
        { name: 'ТЗ/Thumbs.db', buffer: Buffer.from('x') },
        { name: 'ТЗ/Описание объекта закупки.docx.sig', buffer: Buffer.from('подпись') },
      ];
    },
  };
  const files = await extractFile({ name: 'Закупочная_документация.rar', buffer: rar }, 0, { ...noTools, archiver });
  assert.deepEqual(seen, ['.rar']);
  assert.deepEqual(files.map((f) => [f.name, f.status]), [
    ['Закупочная_документация.rar/ТЗ/Описание объекта закупки.docx', 'ok'],
    ['Закупочная_документация.rar/вложение.zip/Проект договора.txt', 'ok'],
    ['Закупочная_документация.rar/ТЗ/Описание объекта закупки.docx.sig', 'unsupported'],
  ], 'служебный мусор (Thumbs.db, __MACOSX) в список не попадает');
  assert.match(files[0].pages[0].text, /Pantum BM5100ADN/);

  const sevenZ = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]);
  assert.equal((await extractFile({ name: 'docs.7z', buffer: sevenZ }, 0, { ...noTools, archiver }))[0].status, 'ok');
  assert.deepEqual(seen, ['.rar', '.7z']);

  // скачать файл, лежащий внутри RAR (и внутри ZIP внутри RAR)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-rar-'));
  const disk = path.join(dir, 'f1');
  fs.writeFileSync(disk, rar);
  assert.equal((await readStoredFile(disk, 'Закупочная_документация.rar/вложение.zip/Проект договора.txt', { archiver })).toString(), 'Оплата в течение 7 рабочих дней');
  assert.equal(await readStoredFile(disk, 'Закупочная_документация.rar/нет такого.txt', { archiver }), null);
  assert.equal(await readStoredFile(disk, 'Закупочная_документация.rar/ТЗ/x.docx', noTools), null, 'распаковать нечем');
  assert.deepEqual(await readStoredFile(disk, 'Закупочная_документация.rar', noTools), rar, 'сам архив отдаётся как есть');
});

test('распознавание: команды tesseract и pdftoppm, язык из установленных, лимит страниц, временные файлы удаляются', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-ocr-'));
  const log = [];
  const run = async (cmd, args) => {
    log.push([cmd, ...args.map((a) => (String(a).startsWith(tmpRoot) ? path.basename(a) : a))]);
    if (cmd === 'tesseract' && args[0] === '--list-langs') return { stdout: 'List of available languages in "/usr/share/tessdata/" (3):\neng\nosd\nrus\n', stderr: '' };
    if (cmd === 'pdftoppm') { fs.writeFileSync(`${args.at(-1)}.png`, 'png'); return { stdout: '', stderr: '' }; }
    if (cmd === 'tesseract') { assert.ok(fs.existsSync(args[0]), 'картинка страницы существует во время распознавания'); return { stdout: ` Текст ${path.basename(args[0])} \n\n\n\nстрока \f`, stderr: '' }; }
    throw new Error(`неожиданная команда ${cmd}`);
  };
  const ocr = createOcr({ run, has: async () => true, langs: 'rus+eng+deu', maxPages: 2, tmpRoot });
  assert.equal(await ocr.pdfReady(), true);
  const r = await ocr.pdf(Buffer.from('%PDF-1.4'), { pages: [2, 5, 7] });
  // бюджет прохода — 2 страницы: третья не потеряна, а названа в pending и дочитывается следующим проходом
  assert.deepEqual(r, { pages: [{ page: 2, text: 'Текст p2.png\n\nстрока' }, { page: 5, text: 'Текст p5.png\n\nстрока' }], failed: [], pending: [7], total: null, truncated: true });
  assert.deepEqual(log.filter((l) => l[0] === 'pdftoppm'), [
    ['pdftoppm', '-r', '200', '-f', '2', '-l', '2', '-gray', '-png', '-singlefile', 'in.pdf', 'p2'],
    ['pdftoppm', '-r', '200', '-f', '5', '-l', '5', '-gray', '-png', '-singlefile', 'in.pdf', 'p5'],
  ]);
  assert.deepEqual(log.find((l) => l[0] === 'tesseract' && l[1] === 'p2.png'), ['tesseract', 'p2.png', 'stdout', '-l', 'rus+eng', '--psm', '3'], 'немецкий не установлен — не просим');
  assert.equal(await ocr.image(Buffer.from('jpeg'), '.jpg'), 'Текст image.jpg\n\nстрока');
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'временные папки удалены');

  const off = createOcr({ run, has: async () => true, enabled: false });
  assert.equal(await off.ready(), false, 'распознавание можно выключить настройкой OCR_ENABLED=0');
  const missing = createOcr({ run, has: async (cmd) => cmd !== 'tesseract' });
  assert.equal(await missing.pdfReady(), false);
});

test('распаковка: файлы архива собираются из временной папки, пароль — понятная ошибка, лимиты соблюдаются', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-arc-'));
  const run = async (cmd, args) => {
    assert.equal(cmd, 'bsdtar');
    const out = args[args.indexOf('-C') + 1];
    fs.mkdirSync(path.join(out, 'ТЗ'), { recursive: true });
    fs.writeFileSync(path.join(out, 'ТЗ', 'описание.txt'), 'текст');
    fs.writeFileSync(path.join(out, 'договор.txt'), 'договор');
    return { stdout: '', stderr: '' };
  };
  const a = createArchiver({ run, has: async () => true, tmpRoot });
  const files = await a.extractAll(Buffer.from('Rar!'), '.rar');
  assert.deepEqual(files.map((f) => [f.name, f.buffer.toString()]).sort(), [['ТЗ/описание.txt', 'текст'], ['договор.txt', 'договор']]);
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
  assert.equal((await createArchiver({ run, has: async () => true, tmpRoot, maxFiles: 1 }).extractAll(Buffer.from('x'), '.7z')).length, 1);

  const locked = createArchiver({ run: async () => { throw Object.assign(new Error('exit 1'), { stderr: 'bsdtar: Encrypted file is unsupported\n' }); }, has: async () => true, tmpRoot });
  await assert.rejects(() => locked.extractAll(Buffer.from('Rar!'), '.rar'), /защищён паролем/);
  const [f] = await extractFile({ name: 'закрытый.rar', buffer: Buffer.from('Rar!\x1a\x07\x00', 'latin1') }, 0, { ...noTools, archiver: locked });
  assert.deepEqual([f.status, f.message], ['error', 'Не удалось прочитать файл: архив защищён паролем']);
});
