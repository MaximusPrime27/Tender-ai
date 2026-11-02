// Взаимоисключающие признаки товара: чёрно-белая или цветная печать и подобные (config/exclusive-traits.json).
//
// Зачем отдельно от общей сверки. Общая сверка засчитывает требование, только если значение дословно есть на странице,
// а магазины пишут то же самое другими словами: в ТЗ «Цветность печати: Черно-Белая», на странице «монохромный»,
// «ч/б», «Количество цветов: 1». И наоборот: цветной принтер подходит под десятки требований чёрно-белого ТЗ и без
// жёсткой проверки получал «частично». Здесь признак определяется по словам и синонимам — одинаково для ТЗ, названия
// товара и страницы магазина; противоречие отклоняет товар сразу, совпадение засчитывается как подтверждение.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'config', 'exclusive-traits.json');
const re = (src) => new RegExp(src, 'i');
const norm = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

let cache = null;
/** Признаки из файла; выражения собираются один раз, файл перечитывается при изменении. */
function loadTraits(file = process.env.EXCLUSIVE_TRAITS_CONFIG || DEFAULT_FILE) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  if (cache && cache.file === file && cache.mtime === mtime) return cache.traits;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const valueMap = (v) => Object.entries(v || {}).map(([id, src]) => [id, re(src)]);
  const traits = (raw.traits || []).map((t) => ({
    id: t.id, title: t.title, values: t.values || {},
    items: re(t.items || '.'),
    requirement: (t.requirement || []).map((r) => ({ name: re(r.name), value: valueMap(r.value) })),
    page: (t.page || []).map((p) => ({ re: new RegExp(p.re, 'gi'), value: valueMap(p.value) })),
    title_words: valueMap(t.title),
  }));
  cache = { file, mtime, traits };
  return traits;
}

/** Значение признака по тексту: то единственное, чьё выражение сработало; два разных сразу — неоднозначно, null. */
function valueOf(map, text) {
  const hit = map.filter(([, r]) => r.test(text)).map(([id]) => id);
  return hit.length === 1 ? hit[0] : null;
}

/**
 * Что требует ТЗ: по требованию о самом признаке («Цветность печати: Черно-Белая»), а не по словам в названиях других
 * характеристик («Скорость черно-белой печати» есть и у цветных устройств).
 * @returns {Array<{trait, value: string, label: string, name: string, need: string}>}
 */
function requiredTraits(itemName, requirements, traits = loadTraits()) {
  const out = [];
  for (const trait of traits) {
    if (!trait.items.test(String(itemName || ''))) continue;
    for (const r of requirements || []) {
      const name = norm(r?.name);
      const rule = trait.requirement.find((q) => q.name.test(name));
      if (!rule) continue;
      const value = valueOf(rule.value, norm(r.value));
      if (!value) continue;
      out.push({ trait, value, label: trait.values[value] || value, name: r.name, need: String(r.value) });
      break;
    }
  }
  return out;
}

/** Признак по названию товара («HP Color LaserJet…», «МФУ лазерное ч/б»). */
function traitInTitle(trait, title) {
  const value = valueOf(trait.title_words, norm(title));
  return value ? { value, label: trait.values[value] || value, by: 'title', evidence: norm(title).slice(0, 90) } : null;
}

/**
 * Признак у товара: сначала по характеристикам на странице (там он назван прямо), потом по названию.
 * Если характеристики говорят разное (на странице описаны и другие товары) — верим названию; нет ясности — null.
 * @returns {{value, label, by: 'page'|'title', evidence: string}|null}
 */
function traitInOffer(trait, { title = '', text = '' } = {}) {
  const page = norm(text);
  const found = new Map();
  for (const p of trait.page) {
    for (const m of page.matchAll(p.re)) {
      const value = valueOf(p.value, m[1]);
      if (value && !found.has(value)) found.set(value, norm(m[0]).replace(/[;.,]+$/, '').slice(0, 90));
    }
  }
  if (found.size === 1) {
    const [[value, evidence]] = [...found];
    return { value, label: trait.values[value] || value, by: 'page', evidence };
  }
  return traitInTitle(trait, title);
}

/**
 * Сверка признаков позиции с товаром.
 * @returns {{conflicts: Array<{name, need, need_label, got_label, evidence}>, agreed: Array<{name, found}>}}
 *   conflicts — товар другого вида (отклонять); agreed — требование подтверждено (name — как в ТЗ, found — что на странице)
 */
function checkTraits(itemName, requirements, offer, traits = loadTraits()) {
  const out = { conflicts: [], agreed: [] };
  for (const need of requiredTraits(itemName, requirements, traits)) {
    const got = traitInOffer(need.trait, offer);
    if (!got) continue;
    if (got.value === need.value) out.agreed.push({ name: need.name, found: got.evidence });
    else out.conflicts.push({ name: need.name, need: need.need, need_label: need.label, got_label: got.label, evidence: got.evidence });
  }
  return out;
}

/** Причина отказа простыми словами: «в ТЗ чёрно-белый, товар цветной (на странице: «Цветность печати: цветная»)». */
const conflictNote = (c) => `в ТЗ ${c.need_label} (${c.name}: ${c.need}), а товар ${c.got_label} — на странице: «${c.evidence}»`;

/** Подходит ли название товара под признаки ТЗ: false — в названии прямо сказано другое («Color LaserJet» при ч/б ТЗ). */
function titleFits(itemName, requirements, title, traits = loadTraits()) {
  return requiredTraits(itemName, requirements, traits).every((need) => {
    const got = traitInTitle(need.trait, title);
    return !got || got.value === need.value;
  });
}

module.exports = { loadTraits, requiredTraits, traitInOffer, traitInTitle, checkTraits, conflictNote, titleFits };
