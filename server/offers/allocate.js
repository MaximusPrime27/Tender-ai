// Набор партии: закрыть нужное количество позиции предложениями нескольких продавцов.
//
// У продавца с лучшей ценой товара может быть меньше, чем нужно заказчику. Тогда берём у него сколько есть,
// остаток — у следующего подходящего, и так до полного количества. Один продавец на всё количество — частный случай.

/**
 * Сколько можно взять у продавца.
 * @returns {{qty: number, check: string|null}} qty — Infinity, если количество не ограничено известным числом;
 *   check — что уточнить у продавца (null — количество известно точно)
 */
function availableOf(offer, need) {
  if (offer.stock_qty == null) return { qty: Infinity, check: 'количество на странице не указано — уточните наличие' };
  // «более 10»: до десяти — точно есть; сверх — неизвестно, но, возможно, тоже есть: берём всё и просим уточнить.
  if (/^(более|от)\s/.test(offer.stock_note || '')) return need <= offer.stock_qty ? { qty: Infinity, check: null } : { qty: Infinity, check: `на странице «${offer.stock_note} шт» — уточните, есть ли всё количество` };
  return { qty: offer.stock_qty, check: null };
}

/**
 * @param offers подходящие предложения в порядке предпочтения (лучшее — первым)
 * @param needed сколько нужно заказчику
 * @returns {{allocations: Array<{offer_id, qty, check}>, covered: number, missing: number}}
 */
function allocate(offers, needed) {
  const need = needed > 0 ? needed : 1;
  let left = need;
  const allocations = [];
  for (const o of offers) {
    if (left <= 0) break;
    const a = availableOf(o, left);
    const take = Math.min(left, a.qty);
    if (!(take > 0)) continue; // у продавца ноль — пропускаем
    allocations.push({ offer_id: o.id, qty: take, check: a.check });
    left = Math.round((left - take) * 1000) / 1000;
  }
  return { allocations, covered: Math.round((need - left) * 1000) / 1000, missing: left > 0 ? left : 0 };
}

module.exports = { allocate, availableOf };
