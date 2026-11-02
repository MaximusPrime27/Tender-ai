// Сохраняет реальные ответы тестового сервера ГосПлан в samples/tenders/ для TENDER_SOURCE=fixture и тестов.
// Запуск: node samples/fetch-tender-fixtures.js [число закупок на закон, по умолчанию 30]

const fs = require('node:fs');
const path = require('node:path');
const { createGosplanSource } = require('../server/sources/gosplan');

const DIR = path.join(__dirname, 'tenders');
const COUNT = Math.min(Number(process.argv[2]) || 30, 100);
const WITH_ATTACHMENTS = 3;

async function main() {
  const src = createGosplanSource({
    baseUrl: process.env.GOSPLAN_BASE_URL || 'https://v2test.gosplan.info',
    apiKey: process.env.GOSPLAN_API_KEY || '',
    delayMs: 800,
  });
  fs.mkdirSync(DIR, { recursive: true });

  for (const law of ['44', '223']) {
    const list = await src.request(`/fz${law}/purchases`, { stage: 1, limit: COUNT, sort: 'published_at_desc' });
    fs.writeFileSync(path.join(DIR, `fz${law}-purchases.json`), JSON.stringify(list, null, 2));
    console.log(`fz${law}: ${list.length} закупок`);

    for (const item of list.slice(0, WITH_ATTACHMENTS)) {
      const n = item.purchase_number;
      const doc = law === '44'
        ? await src.request(`/fz44/purchases/${n}/notification`)
        : await src.request(`/fz223/purchases/${n}`);
      const file = law === '44' ? `fz44-notification-${n}.json` : `fz223-purchase-${n}.json`;
      fs.writeFileSync(path.join(DIR, file), JSON.stringify(doc, null, 2));
      console.log(`  ${file}`);
    }
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
