// Сверка требования ТЗ с таблицей характеристик страницы — без нейросети, по словарю config/attribute-synonyms.json.
// Одно свойство магазины называют по-разному: «Тип подключения: Проводная» в ТЗ и «Wired/Wireless: Wired» на странице,
// «оперативная память» и «RAM», «SSD» и «твердотельный». Словарь сводит их к одному свойству и одному значению.
// Свойства нет в словаре — ищем строку таблицы с тем же названием, что в ТЗ («Ширина сиденья» — «Ширина сиденья»).
// «Не подходит» ставится только по проверяемому факту: число не попало в границы или названо другое значение из
// взаимоисключающих («голубой» при нужном «черный»). Остальное — «не подтверждено», решает нейросеть или человек.

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '..', 'config', 'attribute-synonyms.json');
const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[​ ]/g, ' ').replace(/\s+/g, ' ').trim();
// начало названия, до «для …»: дальше чужие модели и цвета («… для принтеров с черным корпусом»)
const headTitle = (t) => {
  const s = String(t || '');
  const kind = s.match(/совместим\S*|аналог\S*|(?<!не)оригинальн\S*/i)?.[0] || '';
  return `${s.split(/\s(?:для|к)\s/i)[0]} ${kind}`;
};
const squash = (s) => norm(s).replace(/[^а-яa-z0-9]/g, '');
// числа упаковки и брутто — не свойства самого товара
const PACK = /брутто|в упаковке|упаковк|коробк|тары/;

let cache = null;
function load(file = FILE) {
  if (cache?.file === file) return cache.attrs;
  let json = { attributes: [] };
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* словаря нет — работает только сравнение по одинаковому названию */ }
  const re = (list) => (list || []).map((s) => new RegExp(s, 'i'));
  const attrs = (json.attributes || []).map((a) => ({
    ...a, names: re(a.names), skipNames: re(a.skipNames), page: re(a.page),
    values: Object.fromEntries(Object.entries(a.values || {}).map(([k, v]) => [k, re(v)])),
    titleValues: a.titleValues ? Object.fromEntries(Object.entries(a.titleValues).map(([k, v]) => [k, re(v)])) : null,
  }));
  cache = { file, attrs };
  return attrs;
}

/** Свойства словаря, к которым относится требование (по его названию). */
const attrsOf = (name, attrs = load()) => attrs.filter((a) => a.names.some((r) => r.test(norm(name))) && !a.skipNames.some((r) => r.test(norm(name))));
/** Какие значения словаря названы в тексте. */
const canon = (a, text) => new Set(Object.entries(a.values).filter(([, rs]) => rs.some((r) => r.test(norm(text)))).map(([k]) => k));

/**
 * @param row {name, need} требование
 * @param specs [{name, value, src?}] таблица характеристик (src — сайт, если таблица не со страницы продавца)
 * @param title название товара
 * @param fitsNumeric (need, found) => true | false | null — сравнение чисел с единицами из match.js
 * @returns {{verdict, found, method, quote}|null}
 */
function bySpecs(row, specs, title, { fitsNumeric, text = '' }) {
  const label = (s) => (s.name === 'название товара' ? `название товара: «${s.value}»` : s.name === 'текст страницы' ? `текст страницы: «${s.value}»` : `таблица характеристик${s.src ? ` (${s.src})` : ''}: «${s.name} — ${s.value}»`);
  const yes = (s, found = s.value) => ({ verdict: 'yes', found: String(found).slice(0, 120), method: label(s), quote: `${s.name}: ${s.value}` });
  const no = (s) => ({ verdict: 'no', found: String(s.value).slice(0, 120), method: label(s), quote: `${s.name}: ${s.value}` });
  const list = (specs || []).filter((s) => s && s.name && s.value != null);
  for (const a of attrsOf(row.name)) {
    const rows = list.filter((s) => a.page.some((r) => r.test(norm(s.name))));
    if (a.type === 'number') {
      const own = rows.filter((s) => !PACK.test(norm(s.name)));
      const ok = own.find((s) => fitsNumeric(row.need, s.value) === true);
      if (ok) return yes(ok);
      const bad = own.find((s) => fitsNumeric(row.need, s.value) === false);
      if (bad) return no(bad);
      continue;
    }
    const need = canon(a, row.need);
    if (!need.size) continue; // требование не про значения этого свойства («Тип: Совместимый» — не тип клавиатуры)
    const found = new Set();
    let src = null;
    for (const s of rows) { const c = canon(a, s.value); if (c.size) { c.forEach((x) => found.add(x)); src = src || s; } }
    if (!found.size && a.title && title) {
      // в названии «совместимый для Kyocera» — сам товар совместимый (на странице «совместим с …» — список принтеров)
      // бренд «Hi-Black» — не цвет; «… для принтеров с черным корпусом» — не про сам товар
      // цвет картриджа часто стоит в конце («… для Kyocera P7240, черный») — для цвета берём всё название, кроме бренда
      // «Hi-Black» и оборота «с черным корпусом» (это про принтер)
      const head = a.id === 'print_color' ? String(title).replace(/hi-?black|black\s*&\s*decker/gi, ' ').replace(/\S+\s+корпус\S*/gi, ' ') : a.fullTitle ? String(title) : headTitle(title);
      const c = a.titleValues ? canon({ values: a.titleValues }, head) : canon(a, head);
      if (c.size) { c.forEach((x) => found.add(x)); src = { name: 'название товара', value: title }; }
    }
    // в тексте страницы названо ровно одно значение («лазерный», «тонер», «LaserJet» и ни слова о струйной) — берём его
    if (!found.size && a.text && text) {
      const c = canon(a, String(text).slice(0, 20000));
      if (c.size === 1) { c.forEach((x) => found.add(x)); src = { name: 'текст страницы', value: [...c][0] }; }
    }
    if (!found.size) continue;
    const ok = a.all ? [...need].every((x) => found.has(x)) : [...need].some((x) => found.has(x));
    if (ok) return yes(src, [...found].join(', '));
    if (a.exclusive) return no(src);
  }
  // свойства нет в словаре — строка таблицы с тем же названием, что в ТЗ
  const same = list.find((s) => squash(s.name) === squash(row.name));
  if (same && !PACK.test(norm(same.name))) {
    const f = fitsNumeric(row.need, same.value);
    if (f === true) return yes(same);
    if (f === false) return no(same);
    const words = norm(row.need).match(/[а-яa-z0-9]{3,}/g) || [];
    // все слова требования есть в значении («порошковая краска» — «краска порошковая, черная»)
    if (words.length && words.every((w) => norm(same.value).includes(w.slice(0, Math.max(3, w.length - 2))))) return yes(same);
  }
  return null;
}

/**
 * Прогнать по таблице характеристик строки сверки: «не подтверждено» — подтвердить или отклонить по таблице;
 * «да» нейросети, которому таблица прямо противоречит, — «противоречие».
 * @returns {number} сколько строк изменено
 */
function applySpecs(rows, specs, title, opts, text = '') {
  if (!specs?.length && !title && !text) return 0;
  let changed = 0;
  for (const r of rows) {
    if (r.verdict !== 'unknown' && r.verdict !== 'yes') continue;
    const d = bySpecs({ name: r.name, need: r.need }, specs, title, { ...opts, text });
    if (!d) continue;
    if (r.verdict === 'unknown') { Object.assign(r, d); changed++; }
    // название товара — про сам товар («Картридж … TK-5290K черный»): другой цвет в названии — не подходит, а не противоречие
    else if (d.verdict === 'no' && /^название товара/.test(d.method)) { Object.assign(r, d); changed++; }
    else if (d.verdict === 'no') { Object.assign(r, { verdict: 'conflict', found: `${r.found}; в таблице: ${d.found}`, method: d.method, quote: d.quote, reason: 'нейросеть нашла одно, таблица характеристик — другое' }); changed++; }
  }
  return changed;
}

module.exports = { bySpecs, applySpecs, attrsOf, load };
