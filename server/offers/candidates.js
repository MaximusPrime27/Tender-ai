// Подбор конкретных товаров под ТЗ, в котором товар описан характеристиками, без модели.
// Такие позиции — две трети всех; искать их по общему названию («Ноутбук», «МФУ») бесполезно: поисковик отдаёт
// страницы каталогов, а не товара с ценой (на данных сервиса подходящий товар находился в 12% случаев против 76%
// у позиций с моделью). Поэтому сначала выясняем, какие именно товары подходят, а потом ищем их по названию.
// Кандидатов называет нейросеть; она может ошибиться или назвать снятую с продажи модель — это не страшно:
// каждый найденный товар всё равно сверяется с требованиями ТЗ по странице магазина.

const crypto = require('node:crypto');
const { z } = require('zod');
const { callJson } = require('../analyze/json');
const { searchName, distinctiveTerms } = require('./spec');
const { kindWords, typeOfCandidate } = require('./listing');
const { requiredTraits, titleFits } = require('./traits');

const CandidatesSchema = z.object({
  products: z.array(z.object({
    name: z.coerce.string().catch(''),
    brand: z.coerce.string().catch(''),
    model: z.coerce.string().catch(''),
  })).catch([]),
});

const CACHE_DAYS = 30;
const CACHE_EMPTY_DAYS = 1; // пустой ответ помним недолго: нейросеть могла просто «не захотеть»
const PROMPT_VERSION = 5; // меняется вместе с prompts/models.md — старые ответы из кеша не берём
const clean = (s) => String(s || '').replace(/[«»"“”]/g, '').replace(/\s+/g, ' ').trim();

/** Требования в компактном виде для нейросети: без подробностей, которые модель товара не определяют. */
function requirementsFor(spec, max = 40) {
  return (spec.required || []).filter((r) => r.name && r.value && String(r.value).length <= 120)
    .filter((r) => !/гарант|упаков|маркиров|документ|сертификат|страна происхожден|срок годност|год выпуск/i.test(r.name))
    .slice(0, max).map((r) => ({ name: clean(r.name), value: clean(r.value) }));
}

/** Бренды из строк прошлых контрактов: без повторов, без «товарный знак отсутствует» и номеров вместо названия. */
function deliveredBrands(lines, max = 8) {
  const out = new Set();
  for (const raw of lines || []) {
    const line = clean(raw);
    const mark = /товарный знак:?\s*(.*)$/i.exec(line)?.[1];
    if (mark != null && (!/[a-zа-яё]{2,}/i.test(mark) || /отсутству|без товарного|не указан|нет\b/i.test(mark))) continue;
    if (line) out.add(line);
  }
  return [...out].slice(0, max);
}

/**
 * Что спрашивать у поисковика: «тип товара + производитель + модель». Нейросеть дописывает в название параметры
 * («8TB SATA III CMR 3,5 7200rpm 256MB») — в запросе они лишние: магазины пишут их по-разному, и точная страница
 * товара находится хуже, чем по одной модели.
 */
function queryName(name, brand, model) {
  if (!brand || !model) return name.split(' ').slice(0, 8).join(' ');
  const at = name.toLowerCase().indexOf(brand.toLowerCase());
  const type = at > 0 ? name.slice(0, at).trim() : '';
  const tail = model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${brand} ${model}`;
  return `${type} ${tail}`.trim();
}

/**
 * Кандидаты из ответа нейросети: название для поиска, производитель, модель. Отбрасываем пустые, слишком общие
 * (название совпадает с наименованием позиции — искать по нему так же бесполезно) и повторы.
 */
function normalizeCandidates(products, itemName, max = 5) {
  const base = clean(searchName(itemName)).toLowerCase();
  const out = [];
  const seen = new Set();
  for (const p of products || []) {
    const brand = clean(p.brand);
    const model = clean(p.model);
    let name = clean(p.name) || clean(`${brand} ${model}`);
    if (!name || name.length < 5 || name.length > 140) continue;
    // Конкретный товар — это производитель или обозначение модели в названии, а не только тип товара.
    const specific = Boolean(brand && name.toLowerCase().includes(brand.toLowerCase())) || /[a-z]{2,}|\d{3,}/i.test(name.replace(base, ''));
    if (!specific || name.toLowerCase() === base) continue;
    const key = (model || name).toLowerCase().replace(/[\s\-_/.]+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, brand, model, query: `${queryName(name, brand, model)} купить` });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * @param {{item, spec, delivered?: string[], llm, system: string, repo?, clock?, max?: number}} p
 *   delivered — что поставляли по этой позиции раньше (строки из прошлых контрактов)
 * @returns {Promise<Array<{name, brand, model, query}>>}
 */
async function suggestProducts({ item, spec, delivered = [], rejected = [], critical = [], llm, system, repo = null, clock = () => new Date(), max = 5 }) {
  const requirements = requirementsFor(spec);
  if (!llm || !system || !requirements.length) return [];
  const input = {
    item: { name: clean(searchName(item.name)), quantity: item.quantity ?? null, unit: item.unit ?? null },
    requirements,
    delivered_before: deliveredBrands(delivered),
    // Жёсткие признаки вида товара отдельной строкой: среди сорока требований нейросеть их теряет.
    ...((must) => (must.length ? { must } : {}))(requiredTraits(item.name, spec.required).map((t) => `${t.trait.title}: только ${t.label}`)),
    // Второй заход: что уже проверено по страницам магазинов и отклонено, и на каких требованиях товары «спотыкались».
    ...(rejected.length ? { rejected: rejected.slice(0, 10).map((r) => ({ name: clean(r.name), why: clean(r.why).slice(0, 160) })) } : {}),
    ...(critical.length ? { critical: critical.slice(0, 8).map((c) => ({ name: clean(c.name), value: clean(c.value) })) } : {}),
  };
  // Один и тот же товар с теми же требованиями встречается у разных заказчиков — ответ помним месяц.
  const key = `candidates:${crypto.createHash('sha1').update(JSON.stringify([PROMPT_VERSION, input])).digest('hex').slice(0, 20)}`;
  if (repo) {
    try {
      const cached = JSON.parse(repo.getSetting(key) || 'null');
      const days = cached?.products?.length ? CACHE_DAYS : CACHE_EMPTY_DAYS;
      if (cached && clock().getTime() - new Date(cached.at).getTime() < days * 86400000) return cached.products.slice(0, max);
    } catch { /* битый кеш — спросим заново */ }
  }
  const ask = async (payload) => {
    const { data } = await callJson(llm, { system, user: JSON.stringify(payload, null, 1), schema: CandidatesSchema, task: 'models' });
    // В названии прямо сказано другое («Color LaserJet» при чёрно-белом ТЗ) — такой товар не ищем.
    return normalizeCandidates(data.products, item.name, 8).filter((p) => titleFits(item.name, spec.required, p.name));
  };
  let products = await ask(input);
  // Уже отклонённые товары второй раз не берём, даже если нейросеть назвала их снова.
  if (rejected.length) {
    const flat = (x) => String(x || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
    const gone = rejected.map((r) => flat(r.model || r.name)).filter((x) => x.length >= 4);
    products = products.filter((p) => !gone.some((g) => flat(p.model || p.name).includes(g) || g.includes(flat(p.model || p.name))));
  }
  // Подсказка о брендах из прошлых контрактов иногда сбивает нейросеть (бренды не вяжутся с требованиями, и она
  // не называет ничего) — тогда спрашиваем ещё раз, только по требованиям.
  if (!products.length && input.delivered_before.length) products = await ask({ ...input, delivered_before: [] });
  if (repo) repo.setSetting(key, JSON.stringify({ at: clock().toISOString(), products }));
  return products.slice(0, max);
}

/**
 * Товары со страницы каталога, похожие на позицию ТЗ: вместо «это каталог — пропускаем» берём с него несколько
 * подходящих товаров и открываем их страницы. Так делает человек: открыл раздел — выбрал подходящие модели.
 * @param list товары из разметки страницы каталога: [{title, price, url}]
 * @param {{item, spec, candidates?: Array<{model, brand}>, max?: number}} p
 * @returns {Array<{title, price, url}>}
 */
function pickFromListing(list, { item, spec, candidates = [], max = 3 } = {}) {
  const stem = (w) => w.toLowerCase().replace(/ё/g, 'е').slice(0, 5);
  // Тип товара — из наименования ТЗ и из названий подобранных товаров: в ТЗ «накопитель данных», в магазине «жёсткий диск».
  const nameWords = new Set([...kindWords(item.name), ...candidates.flatMap((c) => kindWords(typeOfCandidate(c)))].map(stem));
  const terms = distinctiveTerms(spec || { required: [] }, 5).map((t) => t.toLowerCase().replace(/\s+/g, ' '));
  const { checkNumbers } = require('./match');
  const chars = (spec?.required || []).map((r) => ({ name: r.name, value: r.value }));
  const scored = [];
  for (const o of list || []) {
    if (!o?.url || !o.title || (o.price == null && !o.trusted)) continue;
    if (chars.length && checkNumbers(chars, String(o.title)).fail.length) continue; // в названии — число, которое ТЗ не подходит
    if (!titleFits(item.name, chars, o.title)) continue; // в названии — другой вид товара: цветной при чёрно-белом ТЗ
    const title = String(o.title).toLowerCase();
    const compact = title.replace(/[\s\-_/.]+/g, '');
    const sameKind = (title.match(/[а-яёa-z]{3,}/g) || []).some((w) => nameWords.has(stem(w)));
    const byModel = candidates.some((c) => c.model && c.model.length >= 3 && compact.includes(c.model.toLowerCase().replace(/[\s\-_/.]+/g, '')));
    if (!sameKind && !byModel && !o.trusted) continue; // на странице каталога бывают и чужие товары: аксессуары, сопутствующее
    // «16 дюймов» в ТЗ — в названии товара это «16"», «16 "» или «16-дюймовый»: сравниваем по самому числу.
    const hits = terms.filter((t) => {
      const m = /^(\d+(?:[.,]\d+)?)/.exec(t);
      if (!m) return title.includes(t);
      return new RegExp(`(^|[^\\d.,])${m[1].replace(/[.,]/, '[.,]')}(?!\\d)`).test(title);
    }).length;
    scored.push({ o, score: (byModel ? 10 : 0) + hits * 2 + (sameKind ? 1 : 0) });
  }
  // При равной похожести — дешевле: нам нужен самый недорогой подходящий товар.
  scored.sort((a, b) => b.score - a.score || (a.o.price ?? Infinity) - (b.o.price ?? Infinity));
  const out = [];
  const seen = new Set();
  for (const { o } of scored) {
    if (seen.has(o.url)) continue;
    seen.add(o.url);
    out.push({ title: o.title, price: o.price, url: o.url });
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { suggestProducts, normalizeCandidates, requirementsFor, pickFromListing, deliveredBrands, CandidatesSchema };
