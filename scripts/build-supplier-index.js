// Собрать или обновить каталог страниц оптовых поставщиков (config/stores.json → suppliers) по картам сайтов.
// На сервере каталог обновляется сам раз в неделю; этот скрипт — чтобы собрать его сразу или проверить один сайт.
//   node scripts/build-supplier-index.js                  — обновить все сайты, которые не читались неделю
//   node scripts/build-supplier-index.js --force          — перечитать все
//   node scripts/build-supplier-index.js regard.ru kns.ru — только названные
//   node scripts/build-supplier-index.js --find ST8000NE0001 "WD80EFZX" — у кого есть такая модель
const fs = require('node:fs');
const config = require('../server/config');
const { createSiteIndex } = require('../server/offers/site-index');

const args = process.argv.slice(2);
const index = createSiteIndex({ dataDir: config.DATA_DIR });

(async () => {
  const at = args.indexOf('--find');
  if (at >= 0) {
    const found = index.find(args.slice(at + 1), { perDomain: 2, limit: 40 });
    for (const f of found) console.log(`${f.domain.padEnd(20)} ${f.url}`);
    console.log(`найдено страниц: ${found.length}`);
    return;
  }
  const suppliers = (JSON.parse(fs.readFileSync(config.STORES_CONFIG, 'utf8')).suppliers || []).filter((s) => s.enabled !== false);
  const named = args.filter((a) => !a.startsWith('--'));
  const domains = named.length ? named : suppliers.map((s) => s.site);
  const started = Date.now();
  if (named.length || args.includes('--force')) {
    for (const d of domains) {
      try {
        const r = await index.refresh(d);
        console.log(`${r.domain}: ${r.status === 'ok' ? `страниц товаров ${r.pages}` : r.note}, файлов карты ${r.files}${r.note && r.status === 'ok' ? ` (${r.note})` : ''}`);
      } catch (err) {
        console.log(`${d}: ошибка — ${err.message}`);
      }
    }
  } else {
    await index.refreshAll(domains, { concurrency: 3, onProgress: (p) => console.log(`  готово ${p.current} из ${p.total}: ${p.domain}`) });
  }
  const st = index.status();
  console.log(`\nВ каталоге: ${st.ready} поставщиков, ${st.pages} страниц товаров (${Math.round((Date.now() - started) / 1000)} с)`);
  for (const s of st.sites) console.log(`  ${s.domain.padEnd(20)} ${String(s.pages).padStart(7)}  ${s.status}${s.note ? `  ${s.note}` : ''}`);
})().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => index.close());
