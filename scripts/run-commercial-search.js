// Прогон: поиск товара в магазинах по коммерческим закупкам (Росэлторг) — прямые ссылки на товар из ТЗ.
//   node scripts/run-commercial-search.js            — по всем действующим коммерческим закупкам в работе
//   --reserve N                                      — оставить N запросов суточного лимита нетронутыми (по умолчанию 10)
//   --report-only                                    — только собрать отчёт docs/commercial-links.md по уже найденному
// Работает через API запущенного сервиса (http://127.0.0.1:PORT): поиски идут по одному, лимиты сервиса соблюдаются.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../server/config');
const { openDb } = require('../server/db');

const args = process.argv.slice(2);
const RESERVE = Number(args[args.indexOf('--reserve') + 1]) || 10;
const REPORT_ONLY = args.includes('--report-only');
const BASE = `http://127.0.0.1:${config.PORT}`;
const repo = openDb(config.DATA_DIR, { recoverInterrupted: false }); // сервер работает рядом
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => (n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`);
const api = async (p, opts) => (await fetch(BASE + p, opts)).json();

const tenders = () => repo.db.prepare(`SELECT id, title, price, deadline_at, eis_url FROM tenders
  WHERE law = 'com' AND status = 'scored' AND (deadline_at IS NULL OR deadline_at > ?) ORDER BY score DESC, id`).all(new Date().toISOString());

async function run() {
  let used = 0;
  for (const t of tenders()) {
    const card = await api(`/api/tenders/${t.id}`); // подгружает позиции со страницы закупки, если их ещё нет
    const offers = await api(`/api/tenders/${t.id}/offers`);
    const left = offers.sources?.yandex_daily_left ?? 0;
    if (left <= RESERVE) { console.log(`Остановка: суточного лимита осталось ${left} (резерв ${RESERVE})`); break; }
    const hasShops = (offers.groups || []).some((g) => [...g.ranked, ...g.rejected.map((x) => x.offer)].some((o) => o.source !== 'contracts' && o.source !== 'manual'));
    if (hasShops && (card.items || []).length <= 1) { console.log(`${t.id}: уже искали — пропуск`); continue; }
    const r = await api(`/api/tenders/${t.id}/offers/search`, { method: 'POST' });
    if (!r.searchId) { console.log(`${t.id}: ${r.error || 'поиск не запущен'}`); continue; }
    let s;
    for (let i = 0; i < 180; i++) {
      await sleep(5000);
      s = await api(`/api/offer-searches/${r.searchId}`);
      if (s.status === 'done' || s.status === 'error') break;
    }
    used += s?.api_requests || 0;
    console.log(`${t.id}: ${s?.status}, запросов ${s?.api_requests}, страниц ${s?.pages_fetched} — ${t.title.slice(0, 60)}`);
  }
  console.log(`Платных запросов за прогон: ${used}`);
}

function report() {
  const lines = ['# Коммерческие закупки: товар в магазинах — прямые ссылки\n',
    `Собрано ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (Москва). «Подходит» — совпала модель или характеристики из закупки; цена — со страницы магазина в день поиска.\n`];
  let withLinks = 0;
  let total = 0;
  for (const t of tenders()) {
    const items = repo.getItems(t.id);
    const offers = repo.getOffers(t.id).filter((o) => o.source !== 'contracts' && o.source !== 'manual' && o.url && o.unit_price != null);
    if (!items.length) continue;
    total++;
    const block = [];
    for (const i of items) {
      const mine = offers.filter((o) => o.item_id === i.id);
      const ok = mine.filter((o) => o.match === 'соответствует').sort((a, b) => a.unit_price - b.unit_price);
      const maybe = mine.filter((o) => o.match === 'не хватает данных' || o.match === 'частично').sort((a, b) => a.unit_price - b.unit_price);
      const row = (o, mark) => `  - ${mark} **${money(o.unit_price)}** — [${String(o.title || o.domain).slice(0, 70)}](${o.url}) · ${o.domain}`;
      if (!ok.length && !maybe.length) { block.push(`- ${i.name} (${i.quantity ?? '?'} ${i.unit || ''}) — в магазинах не найдено`); continue; }
      block.push(`- **${i.name}** (${i.quantity ?? '?'} ${i.unit || ''})${i.unit_price ? ` · цена заказчика ${money(i.unit_price)}` : ''}`);
      ok.slice(0, 4).forEach((o) => block.push(row(o, '✅ подходит')));
      if (!ok.length) maybe.slice(0, 2).forEach((o) => block.push(row(o, '❔ проверьте')));
    }
    if (block.some((b) => b.includes('✅'))) withLinks++;
    lines.push(`## ${t.title}\n`, `[Закупка на площадке](${t.eis_url}) · [карточка в сервисе](${config.PUBLIC_BASE_URL}/#tender/${t.id})${t.price ? ` · цена закупки ${money(t.price)}` : ''} · подача до ${t.deadline_at ? new Date(t.deadline_at).toLocaleDateString('ru-RU') : '—'}\n`, ...block, '');
  }
  lines.splice(2, 0, `Закупок с позициями: ${total}; с подходящим товаром в магазинах (прямая ссылка): ${withLinks}.\n`);
  const file = path.join(__dirname, '..', 'docs', 'commercial-links.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  console.log(`Отчёт: docs/commercial-links.md — закупок ${total}, с прямыми ссылками ${withLinks}`);
}

/**
 * Пересверка уже найденных предложений магазинов по названию товара — после улучшения правил сверки
 * (например, «оригинал» против совместимого). Платных запросов не делает.
 */
function rematch() {
  const { specOf, sameProductDet } = require('../server/offers/spec');
  const upd = repo.db.prepare('UPDATE offers SET match = ?, match_notes_json = ? WHERE id = ?');
  let changed = 0;
  for (const t of tenders()) {
    const items = new Map(repo.getItems(t.id).map((i) => [i.id, i]));
    for (const o of repo.getOffers(t.id)) {
      if (o.source === 'contracts' || o.source === 'manual' || o.match !== 'соответствует') continue;
      const item = items.get(o.item_id);
      if (!item) continue;
      const det = sameProductDet(specOf(item), o.title || '');
      if (det.verdict === 'different') { upd.run('не соответствует', JSON.stringify([det.reason]), o.id); changed++; }
    }
  }
  console.log(`Пересверка: помечено неподходящими ${changed}`);
}

/** Перевыбор лучших предложений и пересчёт прибыли по всем коммерческим закупкам (без платных запросов). */
async function reselect() {
  let n = 0;
  for (const t of tenders()) { await api(`/api/tenders/${t.id}/offers/reselect`, { method: 'POST' }); n++; }
  console.log(`Перевыбор и пересчёт прибыли: ${n} закупок`);
}

(async () => {
  if (!REPORT_ONLY) await run();
  if (args.includes('--rematch')) { rematch(); await reselect(); }
  report();
})().catch((err) => { console.error(err.message); process.exit(1); });
