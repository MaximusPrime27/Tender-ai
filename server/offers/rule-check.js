// Поиск поставщиков без нейросети (29.10.2026: оплаченный пакет GigaChat кончился, сверка и чтение страниц встали).
//
// 1. offerByRules(page) — товар со страницы магазина без разметки schema.org: название — из og:title / <h1> / <title>,
//    цена — из meta-тегов цены или первая цена «… ₽ / руб.» после названия, наличие — по словам рядом.
// 2. ruleAnswers(chars, offer) — ответы по требованиям ТЗ в том же виде, что у нейросети: «да: <как на странице>»,
//    «нет: <как на странице>» или «?». Дальше их проверяет judge() из match.js: цитата должна быть на странице, числа
//    пересчитываются с единицами, перечни — целиком. Поэтому правило может ошибиться только в сторону «не проверено».

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
const decode = (s) => String(s || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d))).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- товар со страницы ----------

function metaContent(html, re) {
  const m = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["'](?:${re})["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["'](?:${re})["']`, 'i').exec(String(html || ''));
  return m ? decode(m[1] || m[2]) : null;
}

const PRICE = /(\d{1,3}(?:[\s  ]\d{3})+|\d{2,7})(?:[.,](\d{1,2}))?\s*(?:₽|руб\.?|р\.(?![а-яё]))/i;
const toPrice = (m) => Number(`${m[1].replace(/[\s  ]/g, '')}.${m[2] || '0'}`);

/**
 * Название, цена и наличие со страницы магазина — без нейросети.
 * @param page {url, html, text}
 * @returns {{title, price, availability, seller_name: null, ...}|null} null — цену не нашли (страницу пусть разбирает
 *   нейросеть, если она есть)
 */
function offerByRules(page) {
  const html = String(page.html || '');
  const text = String(page.text || '');
  const h1 = decode(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || '');
  const title = (h1.length >= 6 ? h1 : null) || metaContent(html, 'og:title') || decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').split(/\s[|–—-]\s/)[0];
  if (!title || title.length < 4) return null;
  // цена: разметка цены, потом первая цена в тексте после названия (а не в меню и не у «похожих товаров» внизу)
  let price = Number(String(metaContent(html, 'product:price:amount|og:price:amount|price') || '').replace(/[\s ]/g, '').replace(',', '.')) || null;
  if (!price) {
    const at = Math.max(0, norm(text).indexOf(norm(title).slice(0, 40)));
    const m = PRICE.exec(text.slice(at, at + 2500));
    if (m) price = toPrice(m);
  }
  if (!price || price < 1) return null;
  const near = norm(text.slice(Math.max(0, norm(text).indexOf(norm(title).slice(0, 40))), 3000));
  const availability = /нет в наличии|отсутствует на складе|товар закончился/.test(near) ? 'нет в наличии' : /под заказ|предзаказ/.test(near) ? 'под заказ' : /в наличии|есть на складе|в наличие/.test(near) ? 'в наличии' : null;
  return { title, price, unit: null, availability, seller_name: null, seller_inn: null, seller_city: null, delivery_days: null, delivery_cost: null };
}

// ---------- сверка требований ----------

// одно и то же разными словами: «2-ой резинкой» — «двойной резинкой», «двухслойные» — «2 слоя»
const SYN = [[/(?:2|два|двух)[\s-]*(?:х|ой|ух)?\s*(?=слой|резин|дн)/g, 'двойн '], [/двух(?=слойн)/g, 'двойн'], [/мкр(?![а-я])|микрон\S*/g, 'мкм'],
  // «3-х компонентный» — «трехкомпонентный», «см3», «см[3*]», «куб. см» — миллилитры
  [/3[\s-]*х?\s*(?=компонент|детальн|слойн)/g, 'трех'], [/см\s*\[?3\*?\]?|см³|куб\.?\s*см/g, 'мл']];
// единицы для поиска числа без названия характеристики: «Толщина … не менее 40 мкм» и «40 мкр» в названии товара
const UNIT_OF = [[/мкм|микрон/, 'мкм'], [/(?<![а-я])мм(?![а-я])|миллиметр/, 'мм'], [/(?<![а-я])см(?![а-я])/, 'см'], [/(?<![а-я])кг(?![а-я])/, 'кг'], [/(?<![а-я])мл(?![а-я])/, 'мл'], [/(?<![а-я])г(?![а-я])|грамм/, 'г'], [/(?<![а-я])л(?![а-я])|литр/, 'л']];
const canon = (s) => { let t = ` ${norm(s).replace(/[«»"]/g, ' ')} `; for (const [re, to] of SYN) t = t.replace(re, to); return t.replace(/\s+/g, ' '); };
const STOP = new Set(['для', 'или', 'при', 'без', 'над', 'под', 'товар', 'товара', 'наличие', 'наличии', 'соответствие', 'тип', 'вид', 'количество', 'изделия', 'изделие', 'должен', 'должна', 'быть', 'менее', 'более', 'не', 'и', 'в', 'на', 'с', 'по', 'из']);
/** Основы значимых слов: «двойная резинка» → [«двой», «рези»] — по ним ищем в тексте страницы. */
const stems = (s) => canon(s).split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => (/^[a-z0-9]+$/.test(w) ? w : w.slice(0, Math.max(4, Math.ceil(w.length * 0.6)))));
const YES = /^(да|есть|имеется|наличие|соответствие|предусмотрен[оа]?)$/i;
const NO = /^(нет|отсутствует|отсутствие|не допускается|не предусмотрен[оа]?)$/i;

/** Кусок страницы, где стоят все основы (в окне ~120 символов) — дословно, для цитаты. */
function windowWith(text, parts, span = 120) {
  if (!parts.length) return null;
  const t = canon(text);
  const first = parts[0];
  for (let i = t.indexOf(first); i !== -1; i = t.indexOf(first, i + 1)) {
    const w = t.slice(Math.max(0, i - span), i + span);
    if (parts.every((p) => w.includes(p))) return { at: i, piece: w.trim() };
  }
  return null;
}

/** Дословный кусок исходного текста примерно в том же месте (canon почти не меняет длину). */
function quoteFrom(text, approxAt, len = 90) {
  const t = String(text);
  let from = Math.max(0, approxAt - 20);
  let to = Math.min(t.length, from + len);
  // по границам слов: проверка цитаты (judge) ищет её на странице целыми словами — «…высокой вяз» не найдётся
  const letter = /[a-zа-яё0-9]/i;
  while (from > 0 && from < to && letter.test(t[from - 1]) && letter.test(t[from])) from++;
  while (to < t.length && to > from && letter.test(t[to - 1]) && letter.test(t[to])) to--;
  return t.slice(from, to).replace(/\s+/g, ' ').trim();
}

/**
 * Ответы правил по требованиям — как у нейросети: {"1": "да: …", "2": "нет: …", "3": "?"}.
 * @param chars [{name, value}] требования ТЗ
 * @param offer {title, text}
 */
function ruleAnswers(chars, offer) {
  const text = `${offer.title || ''}\n${offer.text || ''}`;
  const out = {};
  // надёжные числа: пара «диаметр × длина» и единственное число с той же единицей — по ним можно и отклонять
  const sure = new Set();
  chars.forEach((c, i) => {
    const n = String(i + 1);
    const value = String(c.value ?? '').trim();
    const nameStems = stems(c.name);
    // «Игла в комплекте: ≥ 1» — на странице «с иглой», «игла в комплекте»
    const kit = /^(\S+)\s+в\s+комплекте/i.exec(c.name);
    if (kit && /^\s*(≥|>=|не менее)?\s*1\s*$/.test(value)) {
      const noun = stems(kit[1])[0];
      const m = noun && new RegExp(`(?:с|со|в комплекте)\\s+${noun}|${noun}\\S*\\s+в комплекте`).exec(canon(text));
      if (m) { out[n] = `да: ${quoteFrom(text, m.index, 40)}`; return; }
    }
    // «Количество слоев: 2» — «2 слоя», «двухслойные», «двойное дно» (у бахил двойное дно — это два слоя)
    const count = /количеств\S*\s+(\S+)/i.exec(c.name);
    if (count && /^\s*2\s*(шт)?\.?\s*$/i.test(value)) {
      const noun = stems(count[1])[0];
      const alts = [`двойн\\S*\\s*${noun}`, `двойн${noun}`, ...(/сло/.test(noun) ? ['двойн\\S* дн'] : [])];
      const re = new RegExp(alts.join('|'));
      const m = re.exec(canon(text));
      if (m) { out[n] = `да: ${quoteFrom(text, m.index, 60)}`; return; }
    }
    // короткое обозначение: «А4», «USB», «RJ-45» — целым словом; русские и латинские буквы-двойники одинаковы
    if (/^[a-zа-яё0-9-]{1,6}$/i.test(value) && /\d|^[a-z]+$/i.test(value)) {
      const look = (s) => ` ${require('./spec').normLook(s).replace(/[^a-zа-я0-9-]+/g, ' ')} `;
      const at = look(text).indexOf(` ${look(value).trim()} `);
      if (at !== -1) { out[n] = `да: ${quoteFrom(text, at, 60)}`; return; }
    }
    // «Количество листов в пачке: не менее 500 шт» — на странице «500 листов»
    const qty = /количеств\S*\s+(\S+)/i.exec(c.name);
    if (qty && /\d/.test(value)) {
      const noun = stems(qty[1])[0];
      const m = noun && new RegExp(`(\\d[\\d\\s]*)\\s*${noun}`).exec(canon(text));
      if (m) { out[n] = `да: ${m[1].trim()} ${qty[1]}`; sure.add(n); return; }
    }
    // числовое требование: число с единицей рядом с названием характеристики — «Длина: 420 мм», «Объём 5 кг»
    if (/\d/.test(value) && /не менее|не более|менее|более|от |до |≥|≤|^\s*\d/i.test(value)) {
      const hit = nameStems.length ? windowWith(text, nameStems.slice(0, 2), 60) : null;
      if (hit) {
        const after = canon(text).slice(hit.at, hit.at + 80);
        const m = /(\d+(?:[.,]\d+)?)\s*(мм|см|м|кг|г|гр|мл|л|мкм|мкр|шт|%|вт|квт|гб|тб|мб|гц|мгц|ггц|дюйм\S*|"|″)?/i.exec(after.slice(nameStems[0].length));
        if (m) { out[n] = `да: ${m[1]}${m[2] ? ` ${m[2]}` : ''}`; return; }
      }
      // пара «диаметр × длина»: «игла 0,6 × 30 мм» — диаметр (толщина, ширина) первым, длина (высота) вторым
      const pair = /(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)\s*(мм|см)(?![а-яё])/i.exec(text);
      if (pair && /диаметр|толщин|ширин|калибр/i.test(c.name)) { out[n] = `да: ${pair[1]} ${pair[3]}`; sure.add(n); return; }
      if (pair && /длин|высот|глубин/i.test(c.name)) { out[n] = `да: ${pair[2]} ${pair[3]}`; sure.add(n); return; }
      // названия на странице нет — число с той же единицей, если оно на странице одно («40 мкр» при «толщина, мкм»)
      const unit = UNIT_OF.find(([re]) => re.test(canon(`${c.name} ${value}`)))?.[1];
      if (unit) {
        const found = [...new Set([...String(text).matchAll(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${unit === 'мкм' ? 'мкм|мкр|микрон\\S*' : unit})(?![а-яё])`, 'gi'))].map((x) => `${x[1]} ${x[2]}`))];
        if (found.length === 1) { out[n] = `да: ${found[0]}`; sure.add(n); return; }
      }
      out[n] = '?';
      return;
    }
    // «Да» / «соответствие»: признак из названия требования есть на странице («двойная резинка» — «с 2-ой резинкой»)
    if (YES.test(value)) {
      const hit = windowWith(text, nameStems, 50);
      if (hit && !/(?:без|нет|отсутств)\S*\s+\S*\s*$/.test(canon(text).slice(Math.max(0, hit.at - 25), hit.at))) { out[n] = `да: ${quoteFrom(text, hit.at)}`; return; }
      out[n] = '?';
      return;
    }
    // «Нет»: на странице прямо сказано, что признака нет — «без сканера», «отсутствует»
    if (NO.test(value)) {
      const hit = windowWith(text, nameStems, 50);
      if (hit && /(?:без|нет|отсутств)/.test(canon(text).slice(Math.max(0, hit.at - 30), hit.at + 60))) { out[n] = `да: ${quoteFrom(text, hit.at)}`; return; }
      out[n] = '?';
      return;
    }
    // текстовое значение: все его значимые слова на странице рядом («Для ультразвуковых исследований», «Проводной»)
    const valStems = stems(value);
    if (valStems.length && valStems.length <= 6) {
      const hit = windowWith(text, valStems, 80);
      if (hit) { out[n] = `да: ${quoteFrom(text, hit.at, 70)}`; return; }
    }
    out[n] = '?';
  });
  // Число, найденное правилами «где-то рядом», не опровергает требование: «8 Мп — у товара 16» отклоняло подходящий
  // 32-канальный регистратор (аудит 29.10). Не сошлось — «не проверено»; отклоняют только точные проверки по подписи.
  const { fitsNumeric, parseRequirement } = require('./match');
  chars.forEach((c, i) => {
    const a = /^да:\s*(.+)$/.exec(out[String(i + 1)] || '');
    if (a && !sure.has(String(i + 1)) && parseRequirement(String(c.value ?? '')) && fitsNumeric(String(c.value), a[1]) === false) out[String(i + 1)] = '?';
  });
  return out;
}

module.exports = { offerByRules, ruleAnswers, stems, canon };
