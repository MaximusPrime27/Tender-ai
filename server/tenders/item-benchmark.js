// Ориентир цены для конкретной позиции ТЗ: из строк прошлых контрактов с тем же кодом берём только «тот же товар»
// (по спецификации: модель, характеристики, наименование) и приводим цену к единице заказчика.
// Под одним кодом ОКПД2/КТРУ бывают разные товары — картриджи от 87 до 16 600 ₽ — поэтому код сам по себе не годится.

const { specOf, sameProductDet } = require('../offers/spec');
const { convertPrice, normUnit } = require('../offers/units');
const { percentile } = require('./benchmark');

/**
 * Похожа ли цена на правду: в реестре контрактов попадаются строки с ценой за копейки или в тысячи раз дороже
 * (ошибка заполнения или другая позиция). Больше чем в 5 раз от цены заказчика — в расчёт не берём.
 */
function priceLooksSane(item, price) {
  if (item.unit_price == null || price == null || !price) return true;
  const r = price / item.unit_price;
  // расходники: совместимый картридж дешевле оригинала у заказчика в 5–15 раз — нормальная цена (TL-5120X: 10 762 и 903 ₽)
  return r >= (/картридж|тонер|фотобарабан|драм|чернил/i.test(String(item.name || '')) ? 0.05 : 0.2) && r <= 5;
}

/** Текст строки контракта для сверки: наименование + характеристики по КТРУ. */
const lineText = (line) => [line.name, line.chars].filter(Boolean).join('. ');

/** Вердикт по строке контракта: сохранённый (нейросеть) или детерминированный. */
function lineVerdict(item, spec, line, code = item.ktru_code || item.okpd2_code) {
  const saved = item.contract_match?.[line.name];
  if (saved?.verdict && saved.verdict !== 'unknown') return saved;
  const det = sameProductDet(spec, lineText(line));
  // Точная позиция каталога КТРУ (код с номером «-000000NN») с характеристиками в контракте, которые не противоречат ТЗ, —
  // тот же товар по каталогу, если ТЗ не требует конкретной модели. Голое наименование без характеристик проверить нельзя.
  if (det.verdict === 'unknown' && line.chars && !spec.identity?.model && item.ktru_code && String(code).includes('-') && code === item.ktru_code) {
    return { verdict: 'same', reason: `та же позиция каталога КТРУ ${item.ktru_code}` };
  }
  return saved?.verdict ? saved : det;
}

/**
 * @returns {null | {checked: true, total, same, different, unknown, unconverted, contracts, unit_price, suppliers, lines}}
 *   null — в ориентире нет строк с наименованиями (старый кеш): тогда работает прежняя проверка по соотношению цен.
 */
function itemBenchmark(item, bench) {
  if (!bench?.lines?.length) return null;
  const spec = specOf(item);
  const counts = { same: 0, different: 0, unknown: 0, unconverted: 0, suspicious: 0 };
  const same = [];
  for (const line of bench.lines) {
    const v = lineVerdict(item, spec, line);
    counts[v.verdict] = (counts[v.verdict] || 0) + 1;
    if (v.verdict !== 'same') continue;
    // Нет единицы у заказчика или в контракте — считаем, что единицы совпадают (как в извещении и контракте по КТРУ).
    const price = item.unit && line.unit
      ? convertPrice(line.unit_price, line.unit, item.unit, { packQty: spec.pack_qty, name: item.name })
      : line.unit_price;
    if (price == null) { counts.unconverted++; continue; }
    // Цена «за копейки» или в разы дороже заказчика — ошибка в реестре контрактов, в ориентир не берём.
    if (!priceLooksSane(item, price)) { counts.suspicious++; continue; }
    same.push({ ...line, unit_price_converted: price, reason: v.reason });
  }
  const prices = same.map((l) => l.unit_price_converted).sort((a, b) => a - b);
  const suppliers = [];
  const seen = new Set();
  for (const l of same.slice().sort((a, b) => a.unit_price_converted - b.unit_price_converted)) {
    const key = l.supplier_inn || l.supplier_name || l.reg_num;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    suppliers.push({ inn: l.supplier_inn, name: l.supplier_name, address: l.supplier_address, unit_price: l.unit_price_converted,
      quantity: l.quantity, date: l.date, region: l.region, reg_num: l.reg_num, product: l.name, reason: l.reason });
  }
  return {
    checked: true,
    total: bench.lines.length, ...counts,
    contracts: new Set(same.map((l) => l.reg_num)).size,
    unit_price: prices.length ? { min: prices[0], p25: percentile(prices, 0.25), median: percentile(prices, 0.5), max: prices[prices.length - 1] } : null,
    suppliers: suppliers.slice(0, 15),
    same_units: normUnit(item.unit),
  };
}

/**
 * Ответ нейросети «тот же товар» принимаем, только если в тексте товара подтверждено хотя бы одно требование ТЗ
 * (или у позиции нет требований и совпало наименование). Иначе облегчённая модель соглашается на общие названия
 * вроде «Бумага для офисной техники. Товарный знак: …», по которым формат и плотность не проверить.
 */
function acceptLlmVerdict(item, spec, text, llmSame, reason = '') {
  if (llmSame === false) return { verdict: 'different', reason, by: 'llm' };
  if (llmSame !== true) return { verdict: 'unknown', reason, by: 'llm' };
  const det = sameProductDet(spec, text);
  const noReq = !(spec.required || []).length && !spec.identity?.model;
  if (det.confirmed.length || (noReq && det.verdict === 'same')) return { verdict: 'same', reason, by: 'llm' };
  return { verdict: 'unknown', reason: `нейросеть считает тем же, но в наименовании не подтверждено ни одно требование ТЗ${reason ? ` (${reason})` : ''}`, by: 'llm' };
}

/** Наименования строк, по которым правила не решили, — их проверяет нейросеть. */
function unresolvedLines(item, bench, max = 25) {
  if (!bench?.lines?.length) return [];
  const spec = specOf(item);
  const names = [];
  for (const line of bench.lines) {
    if (names.includes(line.name)) continue;
    if (lineVerdict(item, spec, line).verdict === 'unknown') names.push(line.name);
    if (names.length >= max) break;
  }
  return names;
}

module.exports = { itemBenchmark, unresolvedLines, lineVerdict, lineText, acceptLlmVerdict, priceLooksSane };
