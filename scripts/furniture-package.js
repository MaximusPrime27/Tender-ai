// Пакет мебели Quod (config/knowledge/furniture/, 23.10.2026): у мебельных поставщиков — их виды мебели (профили пакета)
// и слова, по которым поставщик подходит к позиции ТЗ (focus_words: «кресл», «матрас»…), — чтобы матрасную фабрику
// не предлагали под стол, а лабораторную мебель — под офисное кресло.
// Трогаем только поставщиков, у которых мебель — единственное направление и слова ещё не заданы: у многопрофильных
// (Сима-ленд, Комус) слова сузили бы и остальные их направления. История находок, приоритет и пометки не меняются.
//   node scripts/furniture-package.js            — показать, что изменится
//   node scripts/furniture-package.js --write    — записать
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'config', 'knowledge', 'furniture', 'furniture-suppliers.json');
const OUT = path.join(ROOT, 'config', 'profile-suppliers.json');

// профиль мебели пакета → начала слов в наименовании позиции ТЗ
const PROFILE_WORDS = {
  office_tables: ['стол', 'ресепшн', 'ресепшен', 'стойк', 'конференц'],
  office_storage: ['шкаф', 'тумб', 'стеллаж', 'гардероб', 'пенал'],
  office_chairs: ['кресл'],
  visitor_seating: ['стул', 'кресл', 'секци', 'табурет'],
  soft_seating: ['диван', 'кресл', 'пуф', 'банкетк', 'кушетк', 'мягк'],
  school: ['парт', 'стол', 'стул', 'ученическ', 'школьн', 'доск', 'шкаф'],
  kindergarten: ['детск', 'стол', 'стул', 'кроват', 'шкаф', 'стеллаж'],
  metal_storage: ['шкаф', 'стеллаж', 'сейф', 'локер', 'картотек', 'металлическ'],
  industrial: ['верстак', 'шкаф', 'тумб', 'стеллаж', 'стол', 'инструмент'],
  medical: ['медицин', 'кушетк', 'кроват', 'стол', 'шкаф', 'тумб', 'ширм', 'стул', 'тележк'],
  laboratory: ['лаборатор', 'вытяжн', 'стол', 'шкаф', 'тумб', 'мойк'],
  hotel_dormitory: ['кроват', 'шкаф', 'тумб', 'стол', 'стул', 'матрас'],
  mattresses: ['матрас', 'матрац', 'наматрасник', 'кроват'],
  horeca: ['стол', 'стул', 'обеденн', 'барн', 'кресл'],
  outdoor: ['скам', 'урн', 'уличн', 'парков', 'беседк', 'качел', 'стол'],
  library: ['стеллаж', 'кафедр', 'стол', 'стул', 'библиотеч', 'шкаф'],
};
const site = (d) => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

function apply(pkg, profile) {
  const bySite = new Map(profile.suppliers.map((s) => [site(s.site), s]));
  const titles = Object.fromEntries((pkg.profiles || []).map((p) => [p.id, p.title]));
  const changed = [];
  const kept = [];
  for (const s of pkg.suppliers || []) {
    const known = bySite.get(site(s.domain));
    if (!known) continue;
    const onlyFurniture = (known.directions || []).every((d) => d === 'g-furniture');
    const profiles = (s.profile_ids || []).filter((id) => PROFILE_WORDS[id]);
    if (!onlyFurniture || !profiles.length) { kept.push(known.site); continue; }
    // «Мебель для кабинета», «Комплект мебели» — без вида в названии: такие позиции остаются у всех мебельных поставщиков
    const words = [...new Set([...profiles.flatMap((id) => PROFILE_WORDS[id]), 'мебел', 'гарнитур'])];
    const before = JSON.stringify([known.furniture_profiles, known.focus_words]);
    known.furniture_profiles = profiles.map((id) => ({ id, title: titles[id] || id }));
    if (!known.focus_words?.length) known.focus_words = words;
    if (JSON.stringify([known.furniture_profiles, known.focus_words]) !== before) changed.push({ site: known.site, profiles, words: known.focus_words });
  }
  return { changed, kept };
}

if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const profile = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const { changed, kept } = apply(pkg, profile);
  console.log(`мебельных поставщиков с видами мебели: ${changed.length}; многопрофильные, не трогаем: ${kept.join(', ') || 'нет'}`);
  for (const c of changed) console.log(`  ${c.site}: ${c.profiles.join(', ')} → ${c.words.join(', ')}`);
  if (process.argv.includes('--write')) {
    profile.furniture_package_at = '2026-10-23';
    fs.writeFileSync(OUT, `${JSON.stringify(profile, null, 2)}\n`);
    console.log('записано');
  }
}

module.exports = { apply, PROFILE_WORDS };
