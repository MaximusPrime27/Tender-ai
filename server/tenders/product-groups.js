// Каталог групп товаров — для выпадающего списка в ленте: «мебель», «кабель и провод», «канцтовары»…
// В отличие от направлений (то, что сервис постоянно ищет на площадках), каталог — это быстрый отбор по ленте:
// выбрал одну или несколько групп — видишь только такие закупки. Группу, которой нет среди включённых направлений,
// можно одной кнопкой превратить в направление — тогда сервис начнёт загружать такие закупки.
// Правила отнесения те же, что у направлений (directions.js): код ОКПД2/КТРУ закупки или её позиций либо слово
// в наименовании; слово с минусом — исключение.

const fs = require('node:fs');
const path = require('node:path');
const directions = require('./directions');

const CATALOG_FILE = path.join(__dirname, '..', '..', 'config', 'product-groups.json');

let cache = null;
/** Группы каталога плоским списком: {id, title, section, aliases, codes, keywords}. */
function loadGroups(file = CATALOG_FILE) {
  if (cache?.file === file) return cache.data;
  let data = [];
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = (json.sections || []).flatMap((s) => (s.groups || []).map((g) => ({
      id: g.id, title: g.title, section: s.title, aliases: g.aliases || [], codes: g.codes || [], keywords: g.keywords || [], image: g.image || null,
    })));
  } catch { /* каталога нет — список пуст */ }
  cache = { file, data };
  return data;
}

// По кодам закупка относится к группе, если товары группы — не меньше этой доли её кодов (позиций): одна ручка
// среди сорока позиций хозтоваров не делает закупку «канцтоварами». Когда кодов один-два, достаточно одного.
const CODES_SHARE = 0.3;

/**
 * Закупка относится к группе? row — {text: наименование в нижнем регистре, codes: коды закупки, itemCodes: коды позиций}.
 * Да — если в наименовании есть слово группы, либо заметная часть кодов (позиций, а без них — кодов закупки) — её товары.
 */
function inGroup(group, row) {
  const byWord = directions.matchScore(group, [], row.text);
  if (byWord.score > 0) return true;
  const codes = row.itemCodes?.length ? row.itemCodes : row.codes;
  if (!codes?.length) return false;
  const mine = codes.filter((c) => group.codes.some((prefix) => c.startsWith(prefix))).length;
  if (!mine || mine / codes.length < (codes.length <= 2 ? 0.01 : CODES_SHARE)) return false;
  // слово-исключение в наименовании снимает и совпадение по коду
  return !minusHit(group, row.text);
}

const minusTests = new WeakMap();
/** В наименовании есть слово-исключение группы? */
function minusHit(group, text) {
  if (!minusTests.has(group)) {
    minusTests.set(group, group.keywords.filter((w) => w.startsWith('-')).map((w) => {
      const probe = { codes: ['x'], keywords: [w] };
      return (t) => directions.matchScore(probe, ['x'], t).minus;
    }));
  }
  return minusTests.get(group).some((test) => test(text));
}

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

/** Закупки в виде для отбора по группам: коды закупки и позиций, наименование в нижнем регистре. */
function rowsOf(repo, { includeHidden = false, nowIso } = {}) {
  return repo.tendersForGroups(includeHidden, nowIso).map((t) => ({ id: t.id, text: norm(t.title), codes: t.codes, itemCodes: t.itemCodes }));
}

/** id закупок, которые относятся хотя бы к одной из выбранных групп. Неизвестные id групп пропускаются. */
function matchIds(repo, groupIds, opts = {}) {
  const groups = loadGroups().filter((g) => groupIds.includes(g.id));
  if (!groups.length) return [];
  return rowsOf(repo, opts).filter((row) => groups.some((g) => inGroup(g, row))).map((row) => row.id);
}

/** Сколько закупок ленты (без отсеянных и скрытых) в каждой группе. */
function counts(repo, opts = {}) {
  const groups = loadGroups();
  const out = Object.fromEntries(groups.map((g) => [g.id, 0]));
  for (const row of rowsOf(repo, opts)) for (const g of groups) if (inGroup(g, row)) out[g.id]++;
  return out;
}

/**
 * Сервис загружает такие закупки с площадок? Да, если отбор идёт не по направлениям (любой товар) или группа уже
 * стала направлением, или её коды (хотя бы часть) входят во включённые направления.
 */
function isCovered(group, profile) {
  if (!directions.usesDirections(profile)) return !(profile.codes?.length || profile.keywords?.length) || profile.mode === 'profile';
  const enabled = directions.enabledOf(profile);
  if (enabled.some((d) => d.id === directionId(group.id))) return true;
  const codes = directions.unionCodes(enabled);
  // хотя бы часть кодов группы входит во включённые направления — такие закупки загружаются
  return group.codes.some((c) => codes.some((p) => c.startsWith(p)));
}

const directionId = (groupId) => `g-${groupId}`;

/** Направление из группы каталога — чтобы сервис начал искать такие закупки на площадках. */
function toDirection(group) {
  return {
    id: directionId(group.id), title: group.title, short: group.title.split(/[,(—]/)[0].trim().slice(0, 30),
    note: 'добавлено из каталога групп товаров', enabled: true, codes: [...group.codes], keywords: [...group.keywords],
  };
}

module.exports = { loadGroups, matchIds, counts, isCovered, toDirection, directionId, inGroup, CATALOG_FILE };
