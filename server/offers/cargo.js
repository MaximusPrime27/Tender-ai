// Вес и объём единицы товара — для расчёта доставки транспортной компанией.
//
// Сначала характеристики со страницы продавца («Вес», «Масса», «Габариты»); если их нет — значения по умолчанию
// для вида товара из config/logistics.json. Второе — оценка, и это всегда помечается (estimated: true).

const fs = require('node:fs');

const num = (s) => Number(String(s).replace(/\s/g, '').replace(',', '.'));

/** «2,5 кг», «850 г», «1.2 kg» → килограммы; непонятное — null. */
function weightKg(value) {
  const m = /(\d[\d\s]*(?:[.,]\d+)?)\s*(кг|kg|килограмм|г(?:р|рамм)?(?![а-яё])|g(?![a-z])|т(?:онн)?(?![а-яё]))/i.exec(String(value || ''));
  if (!m) return null;
  const v = num(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  const unit = m[2].toLowerCase();
  const kg = /^(кг|kg|килограмм)/.test(unit) ? v : /^т/.test(unit) ? v * 1000 : v / 1000;
  return kg > 0 && kg < 5000 ? Math.round(kg * 1000) / 1000 : null;
}

/** «430 x 250 x 44 мм», «30х20х10 см» → кубометры; непонятное — null. Без единицы считаем миллиметрами. */
function volumeM3(value) {
  const m = /(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)\s*(мм|mm|см|cm|м(?![а-яё])|m(?![a-z]))?/i.exec(String(value || ''));
  if (!m) return null;
  const k = /^(см|cm)$/i.test(m[4] || '') ? 0.01 : /^(м|m)$/i.test(m[4] || '') ? 1 : 0.001;
  const v = num(m[1]) * k * num(m[2]) * k * num(m[3]) * k;
  return Number.isFinite(v) && v > 0 && v < 50 ? Math.round(v * 1e6) / 1e6 : null;
}

/** Вес и объём из характеристик страницы товара: {weight_kg, volume_m3} (любое может быть null). */
function cargoFromSpecs(specs) {
  let weight = null;
  let volume = null;
  // «Вес брутто» и «в упаковке» точнее для перевозки, поэтому идут первыми.
  const ordered = (specs || []).slice().sort((a, b) => Number(/брутто|упаковк/i.test(b.name)) - Number(/брутто|упаковк/i.test(a.name)));
  for (const s of ordered) {
    const name = String(s.name || '');
    if (weight == null && /(^|[^а-яё])(вес|масса)([^а-яё]|$)/i.test(name)) weight = weightKg(s.value);
    if (volume == null && /габарит|размер/i.test(name) && !/экран|диагонал|матриц|бумаг|лист|отпечат/i.test(name)) volume = volumeM3(s.value);
  }
  return { weight_kg: weight, volume_m3: volume };
}

let cache = null;
/** Настройки логистики: тарифная сетка перевозчиков и вес/объём по умолчанию. Файла нет — пустые. */
function loadLogistics(file) {
  if (!file) return { carriers: [], cargo_defaults: [], cargo_fallback: null, volumetric_kg_per_m3: 200 };
  try {
    const stat = fs.statSync(file);
    const stamp = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (cache?.stamp === stamp) return cache.data;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = {
      // enabled: false — перевозчик выключен (его тарифы не подтверждены настоящими расчётами)
      carriers: Array.isArray(raw.carriers) ? raw.carriers.filter((c) => c && c.name && c.enabled !== false && Array.isArray(c.zones) && c.zones.length) : [],
      cargo_defaults: Array.isArray(raw.cargo_defaults) ? raw.cargo_defaults : [],
      cargo_fallback: raw.cargo_fallback || null,
      volumetric_kg_per_m3: Number(raw.volumetric_kg_per_m3) > 0 ? Number(raw.volumetric_kg_per_m3) : 200,
    };
    cache = { stamp, data };
    return data;
  } catch {
    return { carriers: [], cargo_defaults: [], cargo_fallback: null, volumetric_kg_per_m3: 200 };
  }
}

/**
 * Вес и объём единицы товара для перевозки.
 * @returns {{weight_kg: number|null, volume_m3: number|null, estimated: boolean, basis: string}}
 *   estimated — взято не со страницы, а из значений по умолчанию для вида товара
 */
function cargoOf({ specs, itemName, settings }) {
  const own = cargoFromSpecs(specs);
  if (own.weight_kg != null && own.volume_m3 != null) return { ...own, estimated: false, basis: 'вес и габариты со страницы товара' };
  const text = String(itemName || '').toLowerCase().replace(/ё/g, 'е');
  const rule = (settings?.cargo_defaults || []).find((r) => (r.words || []).some((w) => text.includes(String(w).toLowerCase().replace(/ё/g, 'е'))));
  const def = rule || settings?.cargo_fallback || null;
  if (own.weight_kg != null) {
    // вес известен, габаритов нет — объём берём по умолчанию: для расчёта важнее вес
    return { weight_kg: own.weight_kg, volume_m3: def?.volume_m3 ?? null, estimated: def?.volume_m3 != null, basis: 'вес со страницы товара, объём — оценка' };
  }
  if (!def) return { weight_kg: null, volume_m3: own.volume_m3, estimated: false, basis: 'вес товара не известен' };
  return { weight_kg: def.weight_kg, volume_m3: own.volume_m3 ?? def.volume_m3 ?? null, estimated: true, basis: 'вес и объём — оценка по виду товара' };
}

module.exports = { cargoOf, cargoFromSpecs, weightKg, volumeM3, loadLogistics };
