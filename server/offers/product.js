// Карточка товара у поставщика: фото и характеристики со страницы магазина; что именно поставляли по госконтракту.
// Нужна, чтобы видеть сам товар — что купить, как он выглядит и что о нём написано, — а не только цену и продавца.

const { htmlToText } = require('./fetch-page');

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Абсолютная https-ссылка на картинку или null. */
function absUrl(src, pageUrl) {
  if (!src || /^data:/i.test(src)) return null;
  try {
    const u = new URL(String(src).trim(), pageUrl);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}

/** Фото товара: из разметки schema.org, иначе og:image / twitter:image. */
function imageFromPage(html, pageUrl, structuredImage) {
  const src = String(html || '');
  const meta = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i.exec(src)?.[1]
    || /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i.exec(src)?.[1]
    || /<img[^>]+itemprop=["']image["'][^>]*src=["']([^"']+)["']/i.exec(src)?.[1];
  const url = absUrl(structuredImage, pageUrl) || absUrl(meta, pageUrl);
  // Логотип сайта вместо фото товара не нужен.
  return url && !/logo|sprite|placeholder|no[-_]?photo|noimage/i.test(url) ? url : null;
}

// Не характеристики: шапка сайта («Вы находитесь: Москва?»), доставка, телефоны, заголовок блока «Описание».
const NOT_SPEC = /вы находитесь|ваш город|доставк|самовывоз|колл-центр|телефон|e-?mail|время работы|^(пн|вт|ср|чт|пт)\b|заказ|оплат|^цена|оптом от|эконом|комплектом|в корзин|^max$|^описание$|^характеристики$|^\+?\d[\d\s()-]{6,}$/i;
const okPair = (name, value) => name.length >= 2 && name.length <= 70 && value.length >= 1 && value.length <= 140 && !/^[\d\s.,₽]+$/.test(name)
  && !NOT_SPEC.test(name) && !/^[\d\s.,]+\s*(страниц\S*|шт\.?|мм|см|гц|вт|кг|гб|мб|тб|стр\.?)$/i.test(name)
  && !/код товара|в корзину|купить|₽/i.test(value) && !(/\d$/.test(name) && /^\d+$/.test(value)); // «доски 16:9» — пункт меню

/**
 * Пары «название — значение» из блоков с классами. Что название, а что значение, — по последней части имени класса:
 * «row__key», «…-name-text» — название; «row__value», «…-value-item» — значение. Раньше годилось любое слово в классе,
 * и у e2e4 («offer-description__properties-…») каждое значение принималось за название следующей строки — пары сдвигались.
 */
function blockPairs(src) {
  const NAME = new Set(['name', 'label', 'key', 'term', 'title', 'caption', 'param', 'attr', 'property', 'prop']);
  const VALUE = new Set(['value', 'val', 'values', 'data', 'desc']);
  const kind = (cls) => {
    let n = false; let v = false;
    for (const c of String(cls).toLowerCase().split(/\s+/).filter(Boolean)) {
      // «ShortCharacteristics_name__ZMFoK» (CSS-модули): после «__» — хеш, смысл — в части до него
      const segs = String(cls).split(/\s+/).find((x) => x.toLowerCase() === c)?.split('__') || c.split('__');
      const tail = segs[segs.length - 1];
      const el = (segs.length > 1 && /^[A-Za-z0-9]{4,8}$/.test(tail) && /[A-Z]/.test(tail) ? segs[segs.length - 2] : tail).toLowerCase();
      const parts = el.split(/[-_]+/);
      // у элемента «…-value-item» последнее значимое слово — value; у «…-name-text» — name
      const last = [...parts].reverse().find((p) => NAME.has(p) || VALUE.has(p));
      if (VALUE.has(last)) v = true; else if (NAME.has(last)) n = true;
    }
    return v && !n ? 'v' : n && !v ? 'n' : null;
  };
  const tags = [...src.matchAll(/<(?:span|div|p|dt|dd|td|th)\b[^>]*class=["']([^"']*)["'][^>]*>/gi)]
    .map((m) => ({ at: m.index, end: m.index + m[0].length, k: kind(m[1]) })).filter((t) => t.k);
  const out = [];
  for (let i = 0; i < tags.length - 1; i++) {
    const a = tags[i];
    const b = tags[i + 1];
    if (a.k !== 'n' || b.k !== 'v' || b.at - a.end > 600) continue;
    const next = tags.slice(i + 2).find((t) => t.k === 'n')?.at ?? b.end + 400;
    out.push([src.slice(a.end, b.at), src.slice(b.end, Math.min(next, b.end + 400))]);
  }
  return out;
}

/**
 * Характеристики товара со страницы: таблицы «название — значение» и списки dt/dd.
 * Берём, только если пар не меньше трёх: иначе это не характеристики, а случайная таблица.
 * @returns {Array<{name: string, value: string}>}
 */
function specsFromPage(html, limit = 60) {
  // HTML-комментарии («Тип печати<!-- -->: лазерная» у regard.ru) мешают узнать «название: значение»
  const src = String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ');
  const pairs = [];
  const seen = new Set();
  // кусок разметки, обрезанный посреди тега («300.3У <div class="flexbox…»), htmlToText не узнаёт — отрезаем его
  const cut = (s) => String(s).replace(/<\/?[a-z][^>]*$/i, ' ');
  const add = (n, v) => {
    const name = clean(htmlToText(cut(n))).replace(/[:：]\s*$/, '');
    const value = clean(htmlToText(cut(v)));
    if (/<\/?[a-z]|class=|style=/i.test(`${name} ${value}`)) return;
    if (!okPair(name, value) || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    pairs.push({ name, value });
  };
  // Название и значение в одной ячейке: <td><small>Тип устройства</small>настольный принтер</td> (kyoshop)
  const inCell = [...src.matchAll(/<td[^>]*>\s*<(small|b|strong|span)[^>]*>([^<]{2,70})<\/\1>\s*([^<]{1,140}?)\s*<\/td>/gi)];
  for (const m of inCell) add(m[2], m[3]);
  if (inCell.length < 3) for (const m of src.matchAll(/<tr[^>]*>\s*<t[hd][^>]*>([\s\S]{1,300}?)<\/t[hd]>\s*<td[^>]*>([\s\S]{1,400}?)<\/td>\s*<\/tr>/gi)) add(m[1], m[2]);
  for (const m of src.matchAll(/<dt[^>]*>([\s\S]{1,300}?)<\/dt>\s*<dd[^>]*>([\s\S]{1,400}?)<\/dd>/gi)) add(m[1], m[2]);
  // Пары блоков «название / значение»: <span class="…name…">Цвет</span><span class="…value…">Черный</span> — так
  // вёрстаны характеристики у многих магазинов (без таблиц и списков dt/dd).
  for (const [n, v] of blockPairs(src)) add(n, v);
  // Блок из двух безымянных span: <div class="property__block"><span>Ресурс, страниц</span><span>17000</span></div>
  for (const m of src.matchAll(/<(div|li|p)\b[^>]*>\s*<span[^>]*>([^<]{2,70})<\/span>\s*<span[^>]*>([^<]{1,140})<\/span>\s*<\/\1>/gi)) add(m[2], m[3]);
  // Строки списка «Название: значение» — по одному пункту: пункт целиком (до 600 знаков), разметка убрана, потом простое
  // правило. Прежнее общее выражение по всей странице (вложенные «(<тег>\s*)*» перед ленивыми группами) на некоторых
  // страницах перебирало варианты часами — 25.10 так завис поиск поставщиков вместе с рабочим процессом.
  for (const m of src.matchAll(/<li\b[^>]*>([\s\S]{0,600}?)<\/li>/gi)) {
    const kv = /^([^:：]{2,70}?)\s*[:：]\s*(.{1,140})$/.exec(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (kv) add(kv[1], kv[2]);
  }
  // Таблица «Условия кредита» (платёж, взнос, срок) стоит на странице раньше характеристик — это не про товар.
  const credit = pairs.some((p) => /кредит|рассроч|ежемесячн\S* плат|первый взнос/i.test(p.name));
  const own = credit ? pairs.filter((p) => !/кредит|рассроч|плат[её]ж|взнос|^срок$|переплат/i.test(p.name)) : pairs;
  return own.length >= 3 ? own.slice(0, limit) : [];
}

/** Где в тексте страницы начинается сам товар: заголовок h1, иначе название предложения. До него — шапка и меню сайта. */
function titleStart(html, text, title = '') {
  const src = String(html || '');
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(src);
  const h1 = clean(htmlToText(m?.[1] || ''));
  const name = clean(title);
  // Название страницы (<title>) попадает в самое начало текста и повторяет заголовок — ищем после него.
  const skip = Math.min(text.length, clean(htmlToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1] || '')).length);
  for (const probe of [h1.slice(0, 40), h1.slice(0, 20), name.slice(0, 30), name.slice(0, 15)]) {
    if (probe.length < 8) continue;
    const at = text.indexOf(probe, skip);
    if (at >= 0) return at;
  }
  // Заголовок разбит тегами — берём его место в разметке.
  if (m && h1.length >= 4) return Math.min(text.length, htmlToText(src.slice(0, m.index)).length);
  return 0;
}

// Слова из названий требований, по которым раздел характеристик не узнать: они есть в любом тексте.
const COMMON_WORDS = /^(количе|наличи|максим|минима|значен|характ|общий|общая|общее|другие|прочие|должен|должна|менее|более)/;

const SPEC_HEADING = /(?:технические\s+|основные\s+|общие\s+)?характеристик[иа]|спецификаци[яи]|технические\s+данные|параметры/g;
const UNIT_VALUE = /\d\s?(?:гб|мб|тб|gb|mb|tb|ггц|мгц|гц|вт|мм|см|кг|дюйм\S*|"|″|об\/мин|rpm|стр\b|dpi|мач|мбит|гбит|кд|мс\b|лист\S*|шт\b)/gi;

/**
 * Текст страницы для сверки с ТЗ: та её часть, где описан сам товар.
 * Первые тысячи знаков страницы магазина — это шапка и меню каталога; название товара начинается на 5–12-й тысяче,
 * характеристики — ещё ниже. Если брать начало страницы, сверка честно отвечает «не хватает данных», хотя всё написано.
 * Берём начало описания (от названия товара) и кусок, где больше всего слов из названий требований ТЗ.
 * @param page {html, text}
 * @param {{title?: string, requirements?: Array<{name: string}>, max?: number, head?: number}} p
 */
function productText(page, { title = '', requirements = [], max = 7000, head = 2200 } = {}) {
  const text = String(page?.text || '');
  if (text.length <= max) return text;
  const start = titleStart(page.html, text, title);
  const stems = [...new Set(requirements.flatMap((r) => String(r?.name || '').toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z]{5,}/g) || [])
    .map((w) => w.slice(0, 6)).filter((w) => !COMMON_WORDS.test(w)))];
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  const win = max - head;
  const scoreAt = (at, len) => {
    const chunk = lower.slice(at, at + len);
    let score = 0;
    for (const st of stems) if (chunk.includes(st)) score++;
    // В меню каталога те же слова («память», «диски»), но нет значений: раздел характеристик выдают числа с единицами.
    return score + Math.min(12, (chunk.match(UNIT_VALUE) || []).length);
  };
  let best = { at: -1, score: 2 }; // меньше трёх совпадений — это не раздел характеристик
  // Раздел характеристик начинается с заголовка «Характеристики» — их на странице несколько (вкладка, ссылка, сам раздел):
  // берём тот, после которого больше всего слов из требований ТЗ и чисел с единицами.
  for (const m of lower.matchAll(SPEC_HEADING)) {
    if (m.index < start) continue;
    const score = scoreAt(m.index, Math.min(win, 3000));
    if (score > best.score) best = { at: m.index, score };
  }
  // Заголовка нет — ищем самый «плотный» кусок.
  if (best.at < 0) {
    for (let at = start; at < text.length; at += 400) {
      const score = scoreAt(at, win);
      if (score > best.score) best = { at, score };
      if (at + win >= text.length) break;
    }
  }
  // Характеристики сразу под названием — берём одним куском.
  if (best.at < 0 || best.at < start + head) return text.slice(start, start + max);
  return `${text.slice(start, start + head)}\n…\n${text.slice(best.at, best.at + win)}`;
}

/** Характеристики из строки контракта: «Диагональ: 75; Разрешение: 4K» → пары. */
function specsFromChars(chars, limit = 15) {
  return String(chars || '').split(/;\s*/).map((p) => {
    const i = p.indexOf(':');
    return i > 0 ? { name: clean(p.slice(0, i)), value: clean(p.slice(i + 1)) } : null;
  }).filter((p) => p && okPair(p.name, p.value)).slice(0, limit);
}

/** Производитель из наименования в контракте: «…. Товарный знак: EXELLTECH» → «EXELLTECH»; «отсутствует» → null. */
function brandOfLine(name) {
  const tm = /товарный знак\s*:\s*([^.;(]+)/i.exec(String(name || ''))?.[1]?.trim();
  return tm && !/отсутств|без товарного|не указ|нет$/i.test(tm) ? tm.replace(/[,\s]+$/, '') : null;
}

/**
 * Что искать в магазинах, чтобы найти товар из контракта: «Интерактивная панель EXELLTECH».
 * Без производителя и модели запрос бесполезен (нашлось бы что угодно) — null.
 */
function productQueryOfLine(name) {
  const brand = brandOfLine(name);
  const base = clean(String(name || '').replace(/\.?\s*товарный знак\s*:.*$/i, '').replace(/\(в рамках[^)]*\)?/gi, ''));
  const hasModel = /(?<![A-Za-z0-9-])(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]{3,}/.test(base);
  if (!brand && !hasModel) return null;
  return clean(`${base.slice(0, 90)} ${brand && !base.toLowerCase().includes(brand.toLowerCase()) ? brand : ''}`);
}

module.exports = { imageFromPage, specsFromPage, specsFromChars, brandOfLine, productQueryOfLine, productText, titleStart };
