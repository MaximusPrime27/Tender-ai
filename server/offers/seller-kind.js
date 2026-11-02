// Кто перед нами среди победителей прошлых госконтрактов.
// Почти все они — такие же посредники, как и мы: купили товар у дистрибьютора или в магазине и перепродали заказчику
// (на данных сервиса: торговля — 72%, производители — 1%, сайт с каталогом — единицы). Поэтому это не поставщики,
// а конкуренты: их цена — цена продажи заказчику (с их наценкой), ориентир для нашей цены, а не закупочная.
// Исключения полезны: производитель такого товара или профильная торговая компания — у них можно спросить оптовую цену.
// Определяем по основному виду деятельности из ЕГРЮЛ (ОКВЭД) и коду товара (ОКПД2/КТРУ); правила — config/seller-kinds.json.

const fs = require('node:fs');
const path = require('node:path');

const RULES_FILE = path.join(__dirname, '..', '..', 'config', 'seller-kinds.json');
let rulesCache = null;
function rules(file = RULES_FILE) {
  if (rulesCache?.file === file) return rulesCache.data;
  let data = { profiles: [], names: {} };
  try { data = { profiles: [], names: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* правил нет — работают общие */ }
  rulesCache = { file, data };
  return data;
}

// Порядок в списке: сначала те, у кого можно спросить оптовую цену.
const KIND_ORDER = { maker: 0, profile: 1, trade: 2, unknown: 3, reseller: 4 };
const KIND_TITLE = {
  maker: 'производитель',
  profile: 'профильная торговля',
  trade: 'торговая компания',
  reseller: 'посредник',
  unknown: 'нет данных о компании',
};

const starts = (code, prefixes) => (prefixes || []).some((p) => code.startsWith(p));
const classOf = (code) => String(code || '').slice(0, 2);

/** Название вида деятельности простыми словами: самое длинное совпадающее начало кода. */
function okvedName(okved) {
  const names = rules().names || {};
  let best = '';
  for (const p of Object.keys(names)) if (String(okved).startsWith(p) && p.length > best.length) best = p;
  return best ? names[best] : null;
}

/** Профиль товара — группа, для которой известны коды профильной торговли и производства (самое точное совпадение). */
function profileOf(itemCode) {
  const code = String(itemCode || '');
  let best = null;
  let len = 0;
  for (const p of rules().profiles || []) {
    for (const prefix of p.items || []) if (code.startsWith(prefix) && prefix.length > len) { best = p; len = prefix.length; }
  }
  return best;
}

/**
 * @param {{okved?: string|null, inn?: string|null, govContracts?: number}} seller
 * @param {string|null} itemCode код ОКПД2/КТРУ товара, который он продавал
 * @returns {{kind: 'maker'|'profile'|'trade'|'reseller'|'unknown', title: string, note: string, can_ask: boolean}}
 *   can_ask — у такой компании имеет смысл спросить оптовую цену
 */
function sellerKind({ okved = null, inn = null, govContracts = 0 } = {}, itemCode = null) {
  const code = String(okved || '').trim();
  const person = /^\d{12}$/.test(String(inn || '')); // ИП
  const out = (kind, note) => ({ kind, title: KIND_TITLE[kind], note, can_ask: kind === 'maker' || kind === 'profile' });
  const won = govContracts > 1 ? ` Выиграл госконтрактов (по данным сервиса): ${govContracts}.` : '';
  if (!code) {
    return out('unknown', `Вид деятельности компании неизвестен (ЕГРЮЛ не проверялся)${person ? '; это индивидуальный предприниматель' : ''} — скорее всего, такой же посредник.${won}`);
  }
  const name = okvedName(code);
  const what = `ОКВЭД ${code}${name ? ` — ${name}` : ''}`;
  const item = String(itemCode || '');
  const profile = profileOf(item);
  const cls = Number(classOf(code));
  const manufacturing = cls >= 10 && cls <= 33 && !code.startsWith('33.');
  const trading = cls >= 45 && cls <= 47;

  if (manufacturing) {
    if ((profile && starts(code, profile.makers)) || (item && classOf(item) === classOf(code))) {
      return out('maker', `Производитель такого товара (${what}): у него можно спросить отпускную цену.${won}`);
    }
    return out('reseller', `Основная деятельность — производство другой продукции (${what}); этот товар он перепродал как посредник.${won}`);
  }
  if (trading) {
    if (code.startsWith('46.9') || code.startsWith('46.1')) {
      return out('reseller', `Посредник (${what}): покупает товар у других и перепродаёт заказчикам, как и вы.${won}`);
    }
    if (profile && starts(code, profile.trade)) {
      return out('profile', `Торгует именно такими товарами (${what}) — может оказаться дистрибьютором: спросите оптовую цену.${won}`);
    }
    if (!profile) return out('trade', `Торговая компания (${what}) — оптовик это или посредник, по коду не понять.${won}`);
    return out('reseller', `Торгует другими товарами (${what}); этот товар он перепродал как посредник.${won}`);
  }
  return out('reseller', `Основная деятельность не связана с этим товаром (${what}) — перепродал его как посредник.${won}`);
}

/** Предложение из прошлого контракта с пометкой, кто его продавец. item — позиция закупки (нужен код товара). */
function withKind(offer, item) {
  if (!offer || offer.source !== 'contracts') return offer;
  return {
    ...offer,
    seller_kind: sellerKind({ okved: offer.seller_okved, inn: offer.seller_inn, govContracts: offer.seller_gov_contracts || 0 }, item?.ktru_code || item?.okpd2_code || null),
  };
}

/** Сравнение для списка конкурентов: сначала те, у кого можно спросить цену, затем по цене. */
const byKind = (a, b) => (KIND_ORDER[a.seller_kind?.kind] ?? 9) - (KIND_ORDER[b.seller_kind?.kind] ?? 9);

/**
 * Цены, по которым такой товар продавали заказчикам: по контрактам с тем же товаром, что в ТЗ («соответствует»).
 * Это ориентир для нашей цены предложения — дороже конкурентов выиграть трудно.
 * @returns {{count: number, min: number, median: number, max: number}|null}
 */
function competitorPrice(competitors) {
  const prices = (competitors || []).filter((o) => o.match === 'соответствует' && o.unit_price != null).map((o) => o.unit_price).sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = prices.length % 2 ? prices[(prices.length - 1) / 2] : Math.round(((prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2) * 100) / 100;
  return { count: prices.length, min: prices[0], median: mid, max: prices[prices.length - 1] };
}

/**
 * Конкуренты по позиции: все победители прошлых контрактов с пометкой «кто это». Порядок: сначала тот же товар,
 * потом «не ясно», в конце — другой товар; внутри — производители и профильная торговля, затем по цене.
 */
function competitorsOf(offers, item) {
  const matchRank = (o) => (o.match === 'соответствует' ? 0 : o.match === 'не соответствует' ? 2 : 1);
  return offers.filter((o) => o.source === 'contracts' && o.seller_decision !== 'blocked').map((o) => withKind(o, item))
    .sort((a, b) => matchRank(a) - matchRank(b) || byKind(a, b) || (a.unit_price ?? Infinity) - (b.unit_price ?? Infinity));
}


module.exports = { sellerKind, withKind, byKind, competitorPrice, competitorsOf, okvedName, KIND_TITLE, KIND_ORDER };
