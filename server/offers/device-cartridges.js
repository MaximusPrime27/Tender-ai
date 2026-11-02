// Картридж «для МФУ Pantum M6800FDW», «Тонер-картридж для принтера НР Laser Jet 3050»: в ТЗ названа модель аппарата,
// а не картриджа. Раньше поиск искал по ней («M7310DN купить») и находил чужие картриджи (CE285A, TK-1150), а сверка
// ставила им «частично» — в ТЗ нет характеристик, которые бы им противоречили.
// Здесь модели картриджей к аппарату берутся из своей базы товаров: у карточек картриджей есть характеристика
// совместимости («M7100/P3010/P3300/M6700/M6800», «LJ 1010/1020/3050»). Серия покрывает исполнения: M6800FDW → M6800.
// Марка аппарата должна совпасть (3050 у HP и у Xerox — разные аппараты).

const BRANDS = [
  ['HP', /(?<![a-zа-я])(hp|нр|hewlett|laser\s*jet|laserjet)(?![a-zа-я])/i],
  ['Pantum', /pantum|пантум/i], ['Canon', /canon|кэнон|кенон/i], ['Kyocera', /kyocera|киосера|куосера/i],
  ['Xerox', /xerox|ксерокс/i], ['Brother', /brother|бразер/i], ['Ricoh', /ricoh|рикох/i], ['Samsung', /samsung|самсунг/i],
  ['Lexmark', /lexmark/i], ['Sharp', /sharp/i], ['Konica', /konica|minolta/i], ['OKI', /(?<![a-z])oki(?![a-z])/i],
  ['Катюша', /катюша|katusha/i],
];
const COMPAT_NAME = /совмест|применим|устройств|для\s+(принтер|мфу|аппарат)|модел\S*\s+(принтер|техник|устройств)/i;
// приставка совместимого бренда перед моделью картриджа: «NV-TL-420H», «CS-TL-420E», «GG-Q2612A»
const VENDOR_PREFIX = /^(nv|nvp|cs|gg|g&g|hb|bion|t2|sakura|sa|ep|pl|aq|n)[-_ ]/i;

/** Аппараты из текста после «для»: [{brand, series}] — «Pantum M6800FDW» → Pantum / M6800, «НР Laser Jet 3050» → HP / 3050. */
function devicesOf(text) {
  const parts = String(text || '').split(/\s(?:для|к)\s/i);
  if (parts.length < 2) return [];
  const tail = parts.slice(1).join(' ');
  const brand = BRANDS.find(([, re]) => re.test(tail))?.[0] || null;
  if (!brand) return [];
  const out = [];
  // буквы серии — слитно («M6800», «LBP223») или одна-две через пробел («MF 3010»); «Jet 3050» — это «3050»
  for (const m of tail.matchAll(/(?<![a-zа-я0-9])(?:([a-z]{1,4})|([a-z]{1,2})[\s-])?(\d{3,5})([a-z]{0,4})(?![a-z0-9])/gi)) {
    const prefix = m[1] || m[2] || '';
    const series = `${prefix}${m[3]}`.toUpperCase();
    if (/^(19|20)\d\d$/.test(m[3]) && !prefix) continue; // год, а не модель
    if (!out.some((d) => d.series === series)) out.push({ brand, series });
  }
  return out;
}

/**
 * Модели картриджей к аппаратам позиции из своей базы.
 * @param db рабочая база (таблица products)
 * @param {string} itemName наименование позиции
 * @param {Array<{name, value}>} requirements требования позиции (совместимость, ресурс)
 * @returns {Array<{model, title, device}>} не больше limit, без повторов модели
 */
function cartridgesForDevice(db, itemName, requirements = [], { limit = 4 } = {}) {
  const head = String(itemName || '').split(/\s(?:для|к)\s/i)[0];
  // модель картриджа названа сама («Картридж HP 59X для …») — обычный поиск по ней
  if (/[a-z]{1,4}[-\s]?\d{2,5}[a-z]{0,3}/i.test(head.replace(/(?<![a-zа-я])(нр|hp)(?![a-zа-я])/i, ''))) return [];
  const compat = (requirements || []).filter((r) => COMPAT_NAME.test(String(r.name))).map((r) => `для ${r.value}`).join(' ');
  const devices = [...devicesOf(itemName), ...devicesOf(compat)].filter((d, i, a) => a.findIndex((x) => x.series === d.series) === i);
  if (!devices.length) return [];
  const out = [];
  for (const d of devices) {
    const seriesRe = new RegExp(`(^|[^a-z0-9])${d.series.replace(/^([A-Z]+)/, '$1[-\\s]?')}(?![0-9])`, 'i');
    const brandRe = BRANDS.find(([b]) => b === d.brand)[1];
    let rows = [];
    // своя база товаров выключена (PRODUCT_BASE=0) — таблицы нет: картриджей к аппарату не знаем
    try { rows = db.prepare(`SELECT model, title, specs_json FROM products WHERE niche = 'cartridges' AND kind IN ('cartridge', 'toner')
      AND (specs_json LIKE ? OR title LIKE ?) LIMIT 200`).all(`%${d.series.replace(/^[A-Z]+/, '')}%`, `%${d.series.replace(/^[A-Z]+/, '')}%`); } catch { return out; }
    for (const r of rows) {
      let specs = [];
      try { specs = JSON.parse(r.specs_json || '[]'); } catch { specs = []; }
      // из названия — только то, что после «для» («… для HP LJ 1010, 3050»): в начале названия бывает ресурс («(3050стр.)»)
      const forPart = String(r.title).split(/\s(?:для|к)\s/i).slice(1).join(' ');
      const compatText = [forPart, ...specs.filter((s) => COMPAT_NAME.test(String(s.name))).map((s) => s.value)].join(' ');
      // марка аппарата названа — или не названа никакая другая («Cactus CS-TL-420E: M6700/M6800» — Pantum по смыслу);
      // серия из одних цифр («3050») без марки ничего не значит — «CTP-3050D» тоже подходит под неё
      const text = `${r.title} ${compatText}`;
      const otherBrand = BRANDS.some(([b, re]) => b !== d.brand && re.test(text));
      const digitsOnly = /^\d+$/.test(d.series);
      if (!seriesRe.test(compatText) || (!brandRe.test(text) && (otherBrand || digitsOnly))) continue;
      const model = String(r.model || '').replace(VENDOR_PREFIX, '').trim();
      if (!model || out.some((x) => x.model.toLowerCase() === model.toLowerCase())) continue;
      out.push({ model, title: r.title, device: `${d.brand} ${d.series}` });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

module.exports = { cartridgesForDevice, devicesOf };
