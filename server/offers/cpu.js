// Процессор ноутбука или компьютера: по модели из названия товара (i5-1235U, Ryzen 5 7530U) — ядра, потоки, кэш L3,
// тепловыделение и частоты из справочника config/cpu-specs.json. Магазины пишут их редко, а в ТЗ это 4–6 требований:
// без справочника такие товары оставались «частично». И обратная задача — подобрать процессоры под требования ТЗ,
// чтобы искать «ноутбук i5-1235U 16 ГБ», а не любой ноутбук.

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '..', 'config', 'cpu-specs.json');
let cache = null;
function load() {
  if (cache) return cache;
  let list = [];
  try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')).cpus || []; } catch { list = []; }
  cache = list.map((c) => {
    const m = c.model.toLowerCase().replace(/-/g, '[\\s-]?');
    // AMD — только рядом со словом Ryzen: «5600» без него — что угодно
    const re = /amd/i.test(c.vendor) ? new RegExp(`ryzen\\s*[3579]?\\s*(?:pro\\s*)?${m}(?![a-z0-9])`, 'i') : new RegExp(`(?<![a-z0-9])(?:core\\s*)?${m}(?![a-z0-9])`, 'i');
    return { ...c, re, label: `${c.vendor} ${c.model}` };
  });
  return cache;
}

/** Процессор в тексте: первое упоминание модели из справочника. */
function cpuOf(text) {
  const t = String(text || '');
  let best = null;
  for (const c of load()) {
    const m = c.re.exec(t);
    if (m && (!best || m.index < best.at)) best = { cpu: c, at: m.index };
  }
  return best?.cpu || null;
}

// какое поле процессора проверяет требование ТЗ; потоки — раньше ядер («количество потоков» не про ядра)
const FIELDS = [
  [/поток/i, 'threads', 'шт', 'потоков'],
  [/ядер|ядра/i, 'cores', 'шт', 'ядер'],
  [/кэш|cache/i, 'l3', 'МБ', 'кэш L3'],
  [/тепловыдел|tdp|расчетн\S* мощност/i, 'tdp', 'Вт', 'тепловыделение'],
  [/базов\S*\s+(?:тактов\S*\s+)?частот|частот\S*\s+(?:процессора\s+)?базов/i, 'base', 'ГГц', 'базовая частота'],
  [/(?:максим|турбо|boost)\S*\s+(?:тактов\S*\s+)?частот|частот\S*\s+(?:процессора\s+)?(?:максим|турбо|в\s+режиме\s+турбо)/i, 'max', 'ГГц', 'максимальная частота'],
];
const fieldOf = (name) => {
  if (!/процессор|ядер|ядра|поток|кэш|cache|tdp|тепловыдел|частот/i.test(name)) return null;
  // «кэш» — только L3 / третьего уровня; «частота» — только базовая или максимальная (иначе неясно, какая)
  if (/кэш|cache/i.test(name) && !/l3|третьего/i.test(name)) return null;
  return FIELDS.find(([re]) => re.test(name)) || null;
};

/**
 * Неподтверждённые строки сверки о процессоре — по справочнику. «Не подходит» — тоже факт справочника (4 потока при
 * нужных 12). Процессор берётся из названия товара, иначе из начала текста страницы.
 * @returns {number} сколько строк изменено
 */
function applyCpu(rows, title, text, { fitsNumeric }) {
  const cpu = cpuOf(title) || cpuOf(String(text || '').slice(0, 6000));
  if (!cpu) return 0;
  let changed = 0;
  for (const r of rows) {
    if (r.verdict !== 'unknown') continue;
    const f = fieldOf(r.name);
    if (!f) continue;
    const value = cpu[f[1]];
    if (value == null) continue;
    const fit = fitsNumeric(r.need, `${value} ${f[2]}`);
    if (fit == null) continue;
    Object.assign(r, { verdict: fit ? 'yes' : 'no', found: `${value} ${f[2]}`, method: `справочник процессоров: ${cpu.label} — ${f[3]} ${value} ${f[2]}`, quote: null });
    changed++;
  }
  return changed;
}

/**
 * Процессоры из справочника, которые выполняют все требования ТЗ о процессоре (ядра, потоки, кэш, TDP, частоты),
 * — для запросов к поиску. segment: mobile (ноутбук) или desktop (системный блок, моноблок).
 */
function suitableCpus(required, segment, { fitsNumeric }) {
  const reqs = (required || []).map((r) => ({ r, f: fieldOf(r.name) })).filter((x) => x.f);
  if (!reqs.length) return [];
  return load().filter((c) => c.segment === segment && reqs.every(({ r, f }) => c[f[1]] != null && fitsNumeric(r.value, `${c[f[1]]} ${f[2]}`) !== false));
}

const segmentOf = (name) => (/ноутбук|laptop|notebook/i.test(name) ? 'mobile' : /системн\S*\s+блок|компьютер|моноблок|(?<![а-я])пк(?![а-я])|рабоч\S*\s+станц/i.test(name) ? 'desktop' : null);

module.exports = { cpuOf, applyCpu, suitableCpus, segmentOf, fieldOf };
