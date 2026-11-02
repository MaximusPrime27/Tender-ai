// Лента: отбор по цене закупки (НМЦК) «от … до …» — любая сумма; закупки без цены при отборе не показываются.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');

test('цена закупки от и до: только закупки в диапазоне; без цены — не попадают; без отбора — все', async () => {
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-price-')), PORT: 0, TENDER_SOURCE: 'fixture', TELEGRAM_BOT_TOKEN: '',
    ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0,
    SUPPLIER_INDEX: false, STAGE_CHECK_PER_SYNC: 0, PLATFORM_FETCH_PER_SYNC: 0, NOTICE_RETRY_PER_SYNC: 0,
  };
  const s = startServer(config, { scheduler: false, log: { log() {}, warn() {}, error() {} }, clock: () => new Date('2026-09-17T09:00:00Z'), sourceOverride: createFixtureSource({ dir: FIX }) });
  const list = async (qs) => (await (await fetch(`http://127.0.0.1:${s.server.address().port}/api/tenders?show_hidden=1&limit=100${qs}`)).json());
  try {
    await s.sync.run();
    // три закупки с известными ценами и одна без цены
    const ids = s.repo.db.prepare('SELECT id FROM tenders ORDER BY id LIMIT 4').all().map((r) => r.id);
    const set = s.repo.db.prepare('UPDATE tenders SET price = ? WHERE id = ?');
    [[90000, ids[0]], [250000, ids[1]], [1500000, ids[2]], [null, ids[3]]].forEach(([p, id]) => set.run(p, id));
    const all = await list('');
    const pick = (r) => r.items.filter((t) => ids.includes(t.id)).map((t) => t.price).sort((a, b) => (a ?? -1) - (b ?? -1));
    assert.deepEqual(pick(all), [null, 90000, 250000, 1500000], 'без отбора — все, включая закупку без цены');
    assert.deepEqual(pick(await list('&price_min=100000')), [250000, 1500000]);
    assert.deepEqual(pick(await list('&price_max=300000')), [90000, 250000]);
    assert.deepEqual(pick(await list('&price_min=200000&price_max=300000')), [250000]);
    assert.deepEqual(pick(await list('&price_min=abc')), [null, 90000, 250000, 1500000], 'непонятное значение — отбора нет');
  } finally { s.server.close(); }
});

test('разбор суммы из поля: цифры с пробелами, копейки, «тыс», «млн»; непонятное — null', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const src = /function parsePrice\(text\) \{[\s\S]*?\n\}/.exec(html)[0];
  const parsePrice = new Function(`${src}; return parsePrice;`)();
  assert.equal(parsePrice('150000'), 150000);
  assert.equal(parsePrice('1 500 000'), 1500000);
  assert.equal(parsePrice('1 500 000,50'), 1500001);
  assert.equal(parsePrice('300 тыс'), 300000);
  assert.equal(parsePrice('1,5 млн'), 1500000);
  assert.equal(parsePrice('2 млрд'), 2000000000);
  assert.equal(parsePrice('250 000 ₽'), 250000);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('много'), null);
});
