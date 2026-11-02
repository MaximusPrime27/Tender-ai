// Этап 5, перепродажа: насколько закупка интересна для заработка на разнице цен.
// Ранг возможности сортирует ленту: сначала подтверждённая поставщиками прибыль, потом ожидаемая маржа
// с поправкой на уверенность в оценке, в конце — закупки без оценки маржи.

const { estimateDelivery, distanceKm } = require('../offers/logistics');

const CONFIRMED_BONUS = 1000;

/** Ближайший к региону заказчика крупный узел поставок. @returns {{hub, km}|null} */
function nearestHub(region, hubs) {
  if (!region || !hubs?.length) return null;
  let best = null;
  for (const hub of hubs) {
    const km = hub.region === Number(region) ? 0 : distanceKm(hub.region, Number(region));
    if (km == null) continue;
    if (!best || km < best.km) best = { hub, km };
  }
  return best;
}

/** Доставка от ближайшего узла, пока поставщик не найден. @returns {{cost, days, note}|null} */
function hubDelivery({ region, goodsCost, settings = {}, hubs, deliveryTermDays }) {
  const near = nearestHub(region, hubs);
  if (!near) return null;
  const d = estimateDelivery({
    sellerRegion: near.hub.region, customerRegion: Number(region), goodsCost, deliveryTermDays, logisticsPct: settings.logistics_pct,
    // Не заданные в профиле значения не затирают умолчания логистики.
    settings: Object.fromEntries(Object.entries({
      km_per_day: settings.delivery_km_per_day, handling_days: settings.delivery_handling_days,
      min_cost: settings.delivery_min_cost, reserve_days: settings.delivery_reserve_days,
    }).filter(([, v]) => v != null)),
  });
  return { cost: d.delivery_cost, days: d.delivery_days, km: d.distance_km ?? 0, hub: near.hub.name };
}

/**
 * Уверенность в ожидаемой марже 0–1: какая доля суммы закупки оценена по сопоставимым ценам контрактов
 * и сколько контрактов в ориентире (5 и больше — полная уверенность).
 * @param {Array<{weight, contracts}|{weight, priced: false}>} parts — по позициям
 */
function confidenceOf(parts) {
  const total = parts.reduce((s, p) => s + p.weight, 0);
  if (!total) return 0;
  let acc = 0;
  for (const p of parts) if (p.contracts) acc += p.weight * Math.min(1, p.contracts / 5);
  return Math.round((acc / total) * 100) / 100;
}

/**
 * Ранг возможности (чем больше, тем выше в ленте).
 * @param {{marginPct: number|null, confidence: number, score: number|null, confirmed: boolean}} p
 */
function opportunityRank({ marginPct, confidence = 0, score = null, confirmed = false }) {
  const s = (score ?? 0) * 0.1;
  if (marginPct == null || !Number.isFinite(marginPct)) return Math.round((s - 100) * 100) / 100;
  if (confirmed) return Math.round(((marginPct > 0 ? CONFIRMED_BONUS : -100) + marginPct + s) * 100) / 100;
  const expected = marginPct > 0 ? marginPct * confidence : marginPct;
  return Math.round((expected + s) * 100) / 100;
}

module.exports = { nearestHub, hubDelivery, confidenceOf, opportunityRank, CONFIRMED_BONUS };
