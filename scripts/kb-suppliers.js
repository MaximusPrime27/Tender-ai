// Добавить поставщиков из пакета базы знаний (config/knowledge/suppliers.json) в профильные компании
// (config/profile-suppliers.json). Уже известные (тот же сайт) не трогаем: их история, приоритет и пометки — наши;
// им только добавляются ссылки на документацию выгрузок (feed_docs), если их не было.
// Новые помечаются «не связывались, цены не подтверждены» — как и остальные профильные компании.
//   node scripts/kb-suppliers.js            — показать, что изменится
//   node scripts/kb-suppliers.js --write    — записать
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KB = path.join(ROOT, 'config', 'knowledge', 'suppliers.json');
const OUT = path.join(ROOT, 'config', 'profile-suppliers.json');
const STORES = path.join(ROOT, 'config', 'stores.json');

const DIRECTION = { computers: 'computers', 'comp-parts': 'computers', monitors: 'computers', peripherals: 'computers', printers: 'office', cartridges: 'office', network: 'network', av: 'g-av', furniture: 'g-furniture' };
// как получить цену (supplier-catalog.js / group-sources.js PRICE_OF_ACCESS)
const ACCESS = {
  partner_api: 'api_partner', partner_portal: 'partner_request', public_catalog: 'public_site', public_catalog_or_partner: 'partner_request',
  public_catalog_or_contact: 'quote_request', manufacturer_or_partner: 'partner_request',
};
const ROLE = {
  manufacturer: 'производитель', manufacturer_group: 'группа производителей', brand_supplier: 'поставщик бренда', manufacturer_brand: 'бренд производителя',
  wholesale_supplier: 'оптовый поставщик', manufacturer_supplier: 'производитель-поставщик', manufacturer_distributor: 'производитель и дистрибьютор',
  wholesale_distributor: 'оптовый дистрибьютор', wholesale_retail_supplier: 'оптово-розничный поставщик', distributor: 'дистрибьютор', seller: 'продавец',
  b2b_seller: 'продавец для юрлиц', wholesale_seller: 'оптовый продавец',
};
const site = (d) => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

/** @param stores config/stores.json: сайты оттуда (магазины, оптовики с открытыми ценами, розничные сети) уже известны — второй раз не добавляем */
function merge(kb, profile, stores = {}) {
  const bySite = new Map(profile.suppliers.map((s) => [site(s.site), s]));
  const inStores = new Set(['stores', 'b2b', 'suppliers', 'retail', 'distributors'].flatMap((k) => (stores[k] || []).map((x) => site(x.site || x.domain))));
  const added = [];
  const touched = [];
  const skipped = [];
  for (const s of kb.suppliers || []) {
    const sites = (s.domains || []).map(site);
    const known = sites.map((d) => bySite.get(d)).find(Boolean);
    if (!known && sites.some((d) => inStores.has(d))) { skipped.push(sites[0]); continue; }
    if (known) {
      if (s.feed_docs?.length && !known.feed_docs?.length) { known.feed_docs = s.feed_docs; touched.push(known.id); }
      continue;
    }
    const directions = [...new Set((s.category_ids || []).map((c) => DIRECTION[c]).filter(Boolean))];
    if (!directions.length || !sites[0]) continue;
    const row = {
      id: `kb_${s.id}`, name: s.name, site: sites[0], directions,
      source_url: s.evidence_url || s.entry_url, access_mode: ACCESS[s.access] || 'quote_request',
      notes: [ROLE[s.role] ? `${ROLE[s.role][0].toUpperCase()}${ROLE[s.role].slice(1)}.` : null, s.notes].filter(Boolean).join(' '),
      recommended_priority: s.seed_priority ?? 3, priority_basis: 'начальная оценка из пакета базы знаний (23.10.2026); после реальных находок — по ним',
      commercial_status: 'not_contacted', legal_entity_verified: false, price_confirmed: false, api_credentials_available: false,
      crawl_permission: 'not_checked', evidence_level: s.read_status === 'page_read' ? 'official_page' : 'search_result',
      evidence_urls: [s.evidence_url, s.entry_url].filter(Boolean), contacts: {}, focus_words: [],
      ...(s.feed_docs?.length ? { feed_docs: s.feed_docs } : {}), from_package: 'Tender_Knowledge_Base_Package 23.10.2026',
    };
    profile.suppliers.push(row);
    bySite.set(sites[0], row);
    added.push(row);
  }
  return { added, touched, skipped };
}

if (require.main === module) {
  const kb = JSON.parse(fs.readFileSync(KB, 'utf8'));
  const profile = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const before = profile.suppliers.length;
  const { added, touched, skipped } = merge(kb, profile, JSON.parse(fs.readFileSync(STORES, 'utf8')));
  console.log(`было ${before}, добавляется ${added.length}, у известных добавлены ссылки на выгрузки: ${touched.join(', ') || 'нет'}`);
  const by = {};
  for (const a of added) for (const d of a.directions) by[d] = (by[d] || 0) + 1;
  console.log('по направлениям:', JSON.stringify(by));
  console.log('уже есть в списке магазинов и поставщиков (stores.json):', skipped.join(', ') || 'нет');
  console.log(added.map((a) => `${a.site} (${a.access_mode})`).join(', '));
  if (process.argv.includes('--write')) {
    profile.kb_imported_at = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(OUT, `${JSON.stringify(profile, null, 2)}\n`);
    console.log('записано');
  }
}

module.exports = { merge, DIRECTION, ACCESS };
