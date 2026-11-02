// Готовая база знаний (пакет Tender_Knowledge_Base_Package, config/knowledge/): модели и их характеристики,
// каждая — с документом производителя (страница, PDF, раздел), плюс заявленная производителем совместимость
// картриджей и принтеров. Загружается в свою базу товаров как источник «паспорт»: характеристики из него
// надёжнее страниц продавцов и при совпадении названия заменяют их значения.
//
// Правила пакета, которые здесь соблюдены:
//   — серия (family) и точная модель (MPN) — разные вещи: общие свойства серии переходят только в карточки её моделей,
//     собственной карточки у серии с моделями нет;
//   — «до 40 стр/мин», «от …», «около …» остаются с этой оговоркой, опции и условия — с пометкой;
//   — сетевое оборудование в базу пока не идёт (ниши базы — компьютеры, картриджи, оргтехника, комплектующие, мебель).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { modelOf, furnitureModel } = require('./maker-search');

// Правила разбора пакета: поменялись (например, новая ниша) — карточки загружаются заново, даже если файлы те же.
const SEED_RULES = 'rules-2: furniture';

const DIR = path.join(__dirname, '..', '..', 'config', 'knowledge');
const FIELDS = path.join(__dirname, '..', '..', 'config', 'kb-fields.json');

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

/** Версия пакета — по содержимому файлов: изменился пакет — загружаем заново. */
function seedVersion(dir = DIR) {
  const h = crypto.createHash('sha256');
  h.update(SEED_RULES);
  for (const f of ['models.json', 'facts.json', 'documents.json', 'compatibility.json']) {
    try { h.update(fs.readFileSync(path.join(dir, f))); } catch { h.update(f); }
  }
  return h.digest('hex').slice(0, 16);
}

/** Значение характеристики по-русски: единицы, «до/не менее/около», да/нет, разрешение «1920×1200». */
function formatFact(f, dict) {
  const unit = f.unit ? (dict.units[f.unit] ?? f.unit) : '';
  const word = (v) => dict.values[v] ?? v;
  let v;
  if (typeof f.value === 'boolean') v = f.value ? 'да' : 'нет';
  else if (Array.isArray(f.value)) {
    v = f.value.every((x) => typeof x === 'number') && f.value.length === 2 ? f.value.join('×') : f.value.map(word).join(', ');
    if (unit && unit !== 'пикс.') v = `${v} ${unit}`;
  } else if (typeof f.value === 'number') v = `${String(f.value).replace('.', ',')}${unit ? (unit === '"' ? unit : ` ${unit}`) : ''}`;
  else v = `${word(f.value)}${unit && unit !== '"' ? ` ${unit}` : unit}`;
  const pre = { upper_bound: 'до ', lower_bound: 'не менее ', approximate: 'около ' }[f.qualifier] || '';
  const post = f.scope === 'optional' ? ' (опционально)' : f.scope === 'conditional' && f.condition ? ` (${f.condition})` : f.condition ? ` (${f.condition})` : '';
  return `${pre}${v}${post}`;
}

/** Вид товара модели из пакета (код вида своей базы) или null — не из ниш базы. */
function kbKind(m, facts) {
  const has = (re) => facts.some((f) => re.test(f.field));
  const name = `${m.brand} ${m.name}`;
  switch (m.category_id) {
    case 'computers': return /thinkpad|latitude|book|ноутбук|vostro|probook|elitebook/i.test(name) ? 'laptop' : 'pc';
    case 'monitors': return 'monitor';
    case 'comp-parts':
      // у платы тоже есть «сокет процессора»: плата — по чипсету, слотам памяти и портам задней панели
      if (has(/^chipset$|^ram\.slots$|^ports\.rear_|^storage\.sata_ports_physical$/) || /\b(prime|pro)\s+[a-z]\d{3}m?\b/i.test(`${m.brand} ${m.name}`)) return 'motherboard';
      if (has(/^cpu\./)) return 'cpu';
      if (has(/^ram\.(capacity_gb|pins|form_factor)$/)) return 'ram';
      if (has(/^storage\.(capacity_gb|read_max)$/)) return 'storage';
      return null;
    case 'printers': {
      const fn = facts.find((f) => f.field === 'functions')?.value;
      if (Array.isArray(fn)) return fn.includes('scan') ? 'mfp' : 'printer';
      return /\b(m\d|mf\d|dcp|mfc|l\d{4}|ecotank)/i.test(name) ? 'mfp' : 'printer';
    }
    case 'cartridges': return facts.some((f) => f.field === 'consumable.type' && f.value === 'drum') ? 'drum' : 'cartridge';
    case 'peripherals': return has(/^keyboard\./) || /клавиатур|keyboard|k1\d\d/i.test(name) ? 'keyboard' : has(/^mouse\./) ? 'mouse' : null;
    // мебель: вид указан в модели пакета (kind) или по полям — кресло с газлифтом и обивкой, стол со столешницей
    case 'furniture': {
      if (m.kind) return m.kind;
      if (has(/^(gaslift|upholstery|armrests|castors\.stem)/)) return 'office_chair';
      if (has(/^(tabletop|edge)\./)) return 'desk';
      if (has(/^(mattress)\./)) return 'mattress';
      if (has(/^(bed)\./)) return 'bed';
      if (has(/^(shelf|shelves)\./)) return 'shelving';
      return null;
    }
    default: return null;
  }
}

/**
 * Карточки для своей базы товаров из пакета.
 * @returns {Array<{kindId, brand, model, title, specs, sources}>}
 */
function seedCards(dir = DIR, fieldsFile = FIELDS) {
  const models = readJson(path.join(dir, 'models.json'), []);
  const facts = readJson(path.join(dir, 'facts.json'), []);
  const docs = new Map(readJson(path.join(dir, 'documents.json'), []).map((d) => [d.id, d]));
  const compat = readJson(path.join(dir, 'compatibility.json'), []);
  const dict = readJson(fieldsFile, { labels: {}, units: {}, values: {} });
  const byModel = new Map();
  for (const f of facts) if (f.status === 'confirmed') byModel.set(f.model_id, [...(byModel.get(f.model_id) || []), f]);
  const children = new Set(models.map((m) => m.parent_id).filter(Boolean));
  const byId = new Map(models.map((m) => [m.id, m]));
  const out = [];
  for (const m of models) {
    if (children.has(m.id)) continue; // серия с моделями: её общие свойства — в карточках моделей
    // свои факты модели, затем свойства серии, которых у модели нет
    const own = byModel.get(m.id) || [];
    const parent = m.parent_id ? (byModel.get(m.parent_id) || []).filter((f) => f.scope === 'model_invariant' && !own.some((o) => o.field === f.field)) : [];
    const all = [...own, ...parent];
    if (!all.length) continue; // только идентичность без характеристик (ждёт извлечения) — карточку не заводим
    const kindId = kbKind(m.parent_id ? { ...m, category_id: m.category_id || byId.get(m.parent_id)?.category_id } : m, all);
    if (!kindId) continue;
    const specs = all.filter((f) => dict.labels[f.field]).map((f) => {
      const d = docs.get(f.document_id);
      return { name: dict.labels[f.field], value: formatFact(f, dict), src: d?.url || null, from: 'паспорт производителя', note: f.locator || null };
    });
    // заявленная производителем совместимость (картридж → устройства)
    const devices = compat.filter((c) => c.from_model_id === m.id || (m.parent_id && c.from_model_id === m.parent_id)).map((c) => c.to_model_name);
    if (devices.length) {
      const d = docs.get(compat.find((c) => c.from_model_id === m.id || c.from_model_id === m.parent_id)?.document_id);
      specs.push({ name: 'Совместимые устройства', value: [...new Set(devices.map((x) => (x.toLowerCase().startsWith(m.brand.toLowerCase()) ? x : `${m.brand} ${x}`)))].join(', '), src: d?.url || null, from: 'паспорт производителя', note: 'заявлено производителем; исполнение и прошивку устройства проверить' });
    }
    const docIds = [...new Set(all.map((f) => f.document_id).filter(Boolean))];
    const sources = docIds.map((id) => docs.get(id)).filter(Boolean).map((d) => ({ url: d.url, type: 'kb', name: d.title || 'документ производителя', at: d.checked_on }));
    // серия без точной модели: общие свойства, исполнение (процессор, память, экран) уточняется у поставщика
    const family = !m.mpn && m.identity_scope === 'family';
    // у мебели вид товара в названии пакета не назван («CHAIRMAN 523») — ставим его впереди (product_type)
    const base = `${m.brand} ${m.name}${m.mpn && !m.name.includes(m.mpn) ? ` (${m.mpn})` : ''}${family ? ' — серия, исполнение уточнить' : ''}`.replace(/^(\S+) \1 /i, '$1 ');
    const title = m.product_type ? `${m.product_type} ${base}` : base;
    const model = m.mpn || (m.category_id === 'furniture' ? furnitureModel(title, m.brand) : modelOf(title)) || m.name;
    out.push({ kindId, brand: m.brand, model, title, specs, sources, kb_id: m.id, family: !m.mpn && m.identity_scope === 'family' });
  }
  return out;
}

// ниши своей базы товаров в категориях пакета
const NICHE_CATEGORIES = new Set(['computers', 'comp-parts', 'printers', 'cartridges', 'monitors', 'peripherals', 'furniture']);

/**
 * Официальные сайты производителей из пакета (technical-sources.json) по нишам базы, которые открылись при подготовке
 * пакета: их карты сайта читаются в свой каталог страниц (с пометкой «официальный»), ночной агент берёт оттуда характеристики.
 */
function officialDomains(dir = DIR) {
  const list = readJson(path.join(dir, 'technical-sources.json'), []);
  return [...new Set(list.filter((s) => (s.category_ids || []).some((c) => NICHE_CATEGORIES.has(c)) && ['page_read', 'search_index'].includes(s.read_status))
    .map((s) => String((s.domains || [])[0] || '').replace(/^www\./, '')).filter(Boolean))];
}

module.exports = { seedCards, seedVersion, formatFact, kbKind, officialDomains, DIR };
