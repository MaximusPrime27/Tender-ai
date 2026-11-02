// Победители прошлых госконтрактов (source = contracts) — конкуренты, а не поставщики: почти все они сами купили
// товар и перепродали заказчику, и в их цене уже сидит наценка. В списке они остаются (как ориентир цены), но
// закупочной ценой их цена не становится ни автоматически, ни вручную.
// Ранжирование предложений по позиции: соответствует ТЗ → не опаздывает к сроку → настоящее предложение магазина раньше цены
// прошлого госконтракта → минимальная полная стоимость → отмечен вами → доверие к продавцу → быстрее доставка.
// Лучшее (берётся в расчёт прибыли) — самое дешёвое из подходящих под ТЗ.

const { MATCH_ORDER } = require('./match');

// Отодвигаем только те, кто точно не успевает к сроку. «Срок неизвестен» (не определился регион продавца) — не повод
// ставить дешёвое предложение ниже дорогого: срок уточняется у продавца.
const timeRank = (o) => (o.in_time === false ? 0 : 1);
// Цена магазина или введённая вручную — предложение, по которому можно купить сегодня; цена из госконтракта — прошлая поставка.
const isReal = (o) => (o.source !== 'contracts' ? 1 : 0);
// «Нет в наличии», «снят с продажи» — купить нельзя: в списке предложение остаётся (цена — ориентир), но ниже тех, что есть.
const outOfStock = (o) => /нет в наличии|отсутствует|распродан|снят[оа]? с (продажи|производства)|недоступ/i.test(o.availability || '');
const stockRank = (o) => (outOfStock(o) ? 0 : 1);
// Среди «частично» выше те, у кого подтверждена хотя бы половина требований ТЗ: их меньше уточнять у поставщика.
// Уценка, б/у и цена вдвое ниже обычной — в списке остаются, но после обычных предложений: сначала то, что можно брать в расчёт.
const soundRank = (o) => (o.condition || o.too_cheap ? 0 : 1);
const coverRank = (o) => (o.match === 'частично' && o.match_checks?.total ? (o.match_checks.confirmed / o.match_checks.total >= 0.5 ? 1 : 0) : 1);

/**
 * Подходит ли предложение, чтобы автоматически подставить его как закупочную цену.
 * Только подтверждённое соответствие ТЗ: «частично» и «не хватает данных» остаются в списке («спросите у продавца»),
 * но в прибыль не попадают — иначе маржа считается по чужому товару. Доверие к продавцу на выбор не влияет
 * (показывается рядом, чтобы проверить продавца перед покупкой); заблокированные вами продавцы не выбираются.
 */
function isEligible(o) {
  return o.source !== 'contracts'
    && !o.condition
    && !o.too_cheap
    && Number.isFinite(o.unit_price) && o.unit_price > 0
    && (!o.match_checks || (o.match_checks.failed === 0 && o.match_checks.unknown === 0
      && o.match_checks.confirmed === o.match_checks.total
      && o.match_checks.confirmed === (o.match_checks.of ?? o.match_checks.total)))
    && o.seller_decision !== 'blocked'
    && o.seller_rnp !== 'listed' // продавец в реестре недобросовестных поставщиков — сам в расчёт не идёт
    && o.in_time !== false
    && !outOfStock(o)
    && !o.retail
    && o.match === 'соответствует';
}

function compareOffers(a, b) {
  return (
    (MATCH_ORDER[b.match] ?? 1) - (MATCH_ORDER[a.match] ?? 1)
    || timeRank(b) - timeRank(a)
    || stockRank(b) - stockRank(a)
    || soundRank(b) - soundRank(a)
    || coverRank(b) - coverRank(a)
    // Крупная розничная сеть — не поставщик: её цена остаётся в конце списка как розничный потолок.
    || Number(Boolean(a.retail)) - Number(Boolean(b.retail))
    || isReal(b) - isReal(a)
    || (a.total_cost ?? Infinity) - (b.total_cost ?? Infinity)
    // При равной цене — продавец, отмеченный вами, затем с большим доверием, затем кто быстрее привезёт.
    || (b.seller_decision === 'trusted') - (a.seller_decision === 'trusted')
    || (b.trust ?? 0) - (a.trust ?? 0)
    || (a.delivery_days ?? Infinity) - (b.delivery_days ?? Infinity)
  );
}

/**
 * Делит предложения позиции на подходящие (по порядку) и отложенные (с причиной); заблокированные продавцы скрыты.
 * @returns {{ranked: Array, rejected: Array<{offer, reason}>, best: object|null}}
 */
// Подозрительно низкая цена: б/у без пометки, ошибка на сайте, цена «от», другой товар.
// Порог считаем от нижней границы обычных цен (четверть самых дешёвых подходящих предложений), а не от середины:
// под «не менее 8 ТБ» подходят и диски на 16 ТБ втрое дороже — середина из-за них уезжает вверх, и нормальная
// цена недорогого товара выглядела бы подозрительной. Второе условие (треть середины) страхует, когда предложений мало.
const CHEAP_OF_LOW = 0.5;
const CHEAP_OF_MID = 0.33;
const CHEAP_MIN_OFFERS = 4;
/** Значение, ниже которого лежит доля q упорядоченного ряда (0.5 — середина, 0.25 — нижняя четверть). */
const quantile = (a, q) => {
  const s = a.slice().sort((x, y) => x - y);
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (at - lo);
};

/** Помечает предложения с подозрительно низкой ценой для этой позиции (too_cheap — во сколько раз ниже обычной). */
function markTooCheap(offers) {
  const pool = (matches) => offers.filter((o) => o.source !== 'contracts' && o.source !== 'manual' && o.unit_price > 0 && matches.includes(o.match) && !o.condition && !o.retail && !outOfStock(o)).map((o) => o.unit_price);
  // Полностью подтверждённых предложений обычно меньше четырёх (подтвердить нужно каждое требование) — тогда обычную
  // цену считаем и по «частично»: иначе МФУ «за 640 ₽» (цена бумаги со страницы) уходил в расчёт как самый дешёвый.
  let usual = pool(['соответствует']);
  if (usual.length < CHEAP_MIN_OFFERS) usual = pool(['соответствует', 'частично']);
  if (usual.length < CHEAP_MIN_OFFERS) return offers.map((o) => ({ ...o, too_cheap: null, usual_price: null }));
  const mid = quantile(usual, 0.5);
  const limit = Math.max(quantile(usual, 0.25) * CHEAP_OF_LOW, mid * CHEAP_OF_MID);
  return offers.map((o) => ({
    ...o, usual_price: mid,
    too_cheap: o.source !== 'contracts' && o.source !== 'manual' && o.unit_price > 0 && o.unit_price < limit ? Math.round((mid / o.unit_price) * 10) / 10 : null,
  }));
}

function rankOffers(offers) {
  const visible = markTooCheap(offers.filter((o) => o.seller_decision !== 'blocked'));
  const rejected = [];
  const ranked = [];
  for (const o of visible) {
    if (o.unit_price == null) rejected.push({ offer: o, reason: 'цена не найдена на странице' });
    else if (o.match === 'не соответствует') rejected.push({ offer: o, reason: `не соответствует ТЗ${o.match_notes?.length ? `: ${o.match_notes[0]}` : ''}` });
    else ranked.push(o);
  }
  ranked.sort(compareOffers);
  return { ranked, rejected, best: ranked.find((o) => isEligible(o)) || null, hidden: offers.length - visible.length };
}

module.exports = { rankOffers, isEligible, compareOffers, outOfStock, markTooCheap };
