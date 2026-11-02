// Пересчёт доставки у сохранённых предложений после правки таблицы веса по виду товара (config/logistics.json).
// Берёт только предложения, у которых вес был оценкой по виду товара, а доставку считал перевозчик по сетке: доставку,
// названную продавцом, и вес со страницы не трогает. Платных запросов нет.
//   node scripts/recalc-cargo.js [--apply] [--tender ID]   — без --apply только показывает, что изменится
const config = require('../server/config');
const { openDb } = require('../server/db');
const { cargoOf, loadLogistics } = require('../server/offers/cargo');
const { estimateDelivery } = require('../server/offers/logistics');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlyTender = args.includes('--tender') ? Number(args[args.indexOf('--tender') + 1]) : null;
const repo = openDb(config.DATA_DIR);
const db = repo.db;
const logistics = loadLogistics(config.LOGISTICS_CONFIG);
const settings = repo.getProfile().economics;

const rows = db.prepare(`SELECT o.id, o.tender_id, o.item_id, o.unit_price, o.price, o.seller_region, o.unit_weight_kg, o.unit_volume_m3, o.delivery_cost, o.delivery_days,
    o.delivery_carrier, o.specs_json, i.name AS item_name, i.quantity, t.region
  FROM offers o JOIN tender_items i ON i.id = o.item_id JOIN tenders t ON t.id = o.tender_id
  WHERE o.cargo_estimated = 1 AND o.source != 'contracts' AND COALESCE(o.delivery_carrier, '') != 'продавец'${onlyTender ? ' AND o.tender_id = ?' : ''}`)
  .all(...(onlyTender ? [onlyTender] : []));
const upd = db.prepare(`UPDATE offers SET unit_weight_kg = ?, unit_volume_m3 = ?, delivery_cost = ?, delivery_days = ?, delivery_note = ?,
  delivery_estimated = ?, delivery_carrier = ?, delivery_basis = ? WHERE id = ?`);
// доставка выбранного товара копируется в позицию закупки при выборе — по ней считается сделка
const updItem = db.prepare('UPDATE tender_items SET purchase_offer_delivery = ? WHERE purchase_offer_id = ?');
let changed = 0;
for (const r of rows) {
  let specs = [];
  try { specs = JSON.parse(r.specs_json || '[]'); } catch { specs = []; }
  const cargo = cargoOf({ specs, itemName: r.item_name, settings: logistics });
  const same = (a, b) => Math.abs((a || 0) - (b || 0)) < 1e-9;
  // вес мог прийти со страницы, а объём — старой оценкой по виду товара: перевозчик считает по большему из них
  if (!cargo?.weight_kg || (same(cargo.weight_kg, r.unit_weight_kg) && same(cargo.volume_m3, r.unit_volume_m3))) continue;
  const qty = r.quantity || 1;
  const d = estimateDelivery({
    sellerRegion: r.seller_region, customerRegion: r.region, goodsCost: (r.unit_price ?? r.price ?? 0) * qty,
    cargo, quantity: qty, logistics, deliveryTermDays: settings.default_delivery_days, logisticsPct: settings.logistics_pct,
    settings: { km_per_day: settings.delivery_km_per_day, handling_days: settings.delivery_handling_days, min_cost: settings.delivery_min_cost, reserve_days: settings.delivery_reserve_days },
  });
  console.log(`предложение ${r.id} (закупка ${r.tender_id}) «${String(r.item_name).slice(0, 40)}»: вес ${r.unit_weight_kg} → ${cargo.weight_kg} кг, объём ${r.unit_volume_m3} → ${cargo.volume_m3} м³, доставка ${r.delivery_cost} → ${d.delivery_cost} ₽`);
  if (apply) { upd.run(cargo.weight_kg, cargo.volume_m3 ?? null, d.delivery_cost, d.delivery_days, d.note, d.estimated ? 1 : 0, d.carrier, d.basis ?? null, r.id); updItem.run(d.delivery_cost, r.id); }
  changed++;
}
console.log(`${apply ? 'пересчитано' : 'изменится'}: ${changed} из ${rows.length}`);
repo.db.close();
