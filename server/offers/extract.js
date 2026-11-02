// Предложение продавца со страницы: сначала структурированные данные (schema.org), затем нейросеть.

const { z } = require('zod');
const { FetchSkipped } = require('./fetch-page');
const { modelTokens, specOf } = require('./spec');
const { imageFromPage, specsFromPage, productText, titleStart } = require('./product');
const { listingOf } = require('./listing');
const { callJson } = require('../analyze/json');
const { innFromText } = require('./seller-check');
const { regionFromText } = require('./logistics');
const { readStock, normalizeAvailability } = require('./stock');
const { docLinks } = require('./evidence-docs');

const numOrNull = z.preprocess((v) => (v === '' || v == null ? null : Number(String(v).replace(/\s/g, '').replace(',', '.'))), z.number().nonnegative().nullable()).catch(null);
const strOrNull = z.preprocess((v) => (v == null || v === '' ? null : String(v)), z.string().nullable()).catch(null);

const OfferSchema = z.object({
  title: z.coerce.string().catch(''),
  price: numOrNull,
  unit: strOrNull,
  pack_qty: numOrNull,
  availability: strOrNull,
  seller_name: strOrNull,
  seller_inn: strOrNull,
  seller_city: strOrNull,
  delivery_days: numOrNull,
  delivery_cost: numOrNull,
});

const words = (s) => new Set((String(s).toLowerCase().match(/[а-яёa-z0-9]{3,}/g) || []).map((w) => w.slice(0, 6)));

/** Из нескольких товаров на странице — самый похожий на искомую позицию. */
function bestStructured(list, itemName) {
  const want = words(itemName);
  let best = null;
  let bestScore = -1;
  for (const o of list) {
    const got = words(o.title);
    const score = [...got].filter((w) => want.has(w)).length;
    if (score > bestScore) { best = o; bestScore = score; }
  }
  return best;
}

function packFromText(text) {
  const m = String(text).match(/(\d+)\s*(?:шт\.?|штук)\s*(?:в\s*упак|\/\s*упак)|упаковк\S*\s*(?:по\s*)?(\d+)\s*шт/i);
  return m ? Number(m[1] || m[2]) : null;
}

function deliveryDaysFromText(text) {
  const m = String(text).match(/доставк\S*[^.\n]{0,60}?(?:от\s*\d+\s*до\s*|\d+\s*[-–—]\s*)?(\d{1,2})\s*(?:раб\S*\s*)?(?:дн|день|дня|дней)/i);
  return m ? Number(m[1]) : null;
}

/**
 * @param page результат fetchPage
 * @param item позиция {name, characteristics}
 * @returns {Promise<object|null>} предложение или null, если цены нет
 */
/** Модель позиции: из спецификации ТЗ, характеристик или наименования — чтобы найти нужный товар на странице каталога. */
function modelsOf(item) {
  const fromChars = (item.characteristics || []).filter((c) => /модел|артикул|парт.?номер/i.test(c.name)).map((c) => c.value);
  const explicit = [item.spec?.identity?.model, ...fromChars].filter(Boolean).map((m) => String(m).trim()); // «OptiPlex 7410» — целиком
  return [...explicit, ...modelTokens([...explicit, item.name].join(' '))].filter((m) => m.length >= 3).map((m) => m.toLowerCase());
}

/** Требования ТЗ к позиции — по их названиям на странице магазина находится раздел характеристик. */
function requirementsOf(item) {
  try {
    const required = specOf(item).required || [];
    return required.length ? required : item.characteristics || [];
  } catch {
    return item.characteristics || [];
  }
}

/** Текст страницы от товара: с небольшим запасом перед заголовком (там бывают цена и наличие). */
function fromProduct(page) {
  const text = String(page.text || '');
  return text.slice(Math.max(0, titleStart(page.html, text) - 1500));
}

const sameSite = (a, b) => {
  try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); } catch { return false; }
};

// Больше стольких товаров в разметке — это страница каталога, а не товара: цена «первого попавшегося» ничего не значит.
const LISTING_MIN = 4;

/**
 * @param page результат fetchPage
 * @param item позиция {name, characteristics, spec}
 * @param {{llm?, system?, listing?: boolean, candidates?: Array, hasModel?: boolean}} opts
 *   listing — распознавать каталог без разметки (поток поиска); candidates — товары, подобранные под ТЗ;
 *   hasModel — в ТЗ названа модель: с каталога берём только ссылки на неё, «похожие» товары не нужны
 * @returns {Promise<object|null>} предложение или null, если цены нет
 */
async function extractOffer(page, item, { llm, system, listing: detectListing = false, candidates = [], hasModel, stockAttr = null } = {}) {
  let offer = null;
  let method = null;
  // Цена в другой валюте (сумы, тенге, белорусские рубли) — не предложение для российской закупки.
  const all = page.structured || [];
  let list = all.filter((s) => !s.currency || /^(RUB|RUR)$/i.test(s.currency));
  if (all.length && !list.length) throw new FetchSkipped(`цена не в рублях (${all[0].currency})`, { kind: 'currency' });
  const listing = list.length >= LISTING_MIN || list.some((s) => s.range);
  if (listing) {
    const models = modelsOf(item);
    const whole = list;
    list = list.filter((s) => models.some((m) => String(s.title || '').toLowerCase().includes(m)));
    if (!list.length) {
      // Сам каталог — не предложение, но товары с него (название, цена, ссылка) пригодятся: поиск возьмёт
      // несколько похожих на позицию ТЗ и откроет их страницы (см. candidates.js → pickFromListing).
      const err = new FetchSkipped('это страница каталога, а не товара — цена конкретного товара неизвестна', { kind: 'listing' });
      err.listing = whole.filter((s) => s.url && s.url !== page.url && !s.range && sameSite(s.url, page.url)).map((s) => ({ title: s.title, price: s.price, url: s.url }));
      throw err;
    }
  }
  const structured = bestStructured(list, item.name);
  if (structured && !listing) {
    const h1 = String(page.html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    const heading = h1 ? h1.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const own = words(structured.title);
    if (heading.length >= 8 && ![...words(heading)].some((w) => own.has(w))) structured.title = heading.replace(/^(Описание|Характеристики|Отзывы о)\s+/i, '');
  }
  if (structured) {
    offer = {
      title: structured.title, price: structured.price, unit: null, pack_qty: packFromText(structured.title),
      availability: structured.availability,
      seller_name: structured.seller_name, seller_inn: null, seller_city: null, delivery_days: null, delivery_cost: null,
    };
    method = 'разметка страницы';
  } else {
    if (detectListing) {
      const models = modelsOf(item);
      const strict = hasModel ?? models.length > 0;
      const links = listingOf(page, item, { models, candidates });
      const exact = (links || []).filter((l) => l.exact);
      // Модель из ТЗ есть в каталоге — идём на страницу этого товара; моделей в ТЗ нет — берём похожие товары.
      // Модель названа, но ссылки на неё нет — пусть страницу читает нейросеть, как раньше.
      if (links && (!strict || exact.length)) {
        const err = new FetchSkipped('это страница каталога, а не товара — цена конкретного товара неизвестна', { kind: 'listing' });
        err.listing = (strict ? exact.slice(0, 2) : links).map((l) => ({ title: l.title, price: l.price, url: l.url, trusted: true }));
        err.exact = strict;
        throw err;
      }
    }
    // разметки нет — название и цену берут правила (заголовок, цена рядом с ним); нейросеть — только если они не смогли
    const byRules = require('./rule-check').offerByRules(page);
    if (byRules) {
      offer = byRules;
      method = 'правила';
    } else if (llm && system) {
      const { data } = await callJson(llm, {
        system,
        user: JSON.stringify({ item: { name: item.name, characteristics: (item.characteristics || []).slice(0, 12) }, page: { url: page.url, text: fromProduct(page).slice(0, 12000) } }, null, 1),
        schema: OfferSchema,
        task: 'offer',
      });
      offer = data;
      method = 'нейросеть';
    }
  }
  if (!offer) return null;
  const text = page.text || '';
  // Не новый товар: заказчику по контракту нужен новый, а уценка и б/у стоят в разы дешевле и портят сравнение цен.
  const label = `${offer.title || ''} ${decodeURIComponent(String(page.url || '').replace(/%(?![0-9a-f]{2})/gi, '%25'))}`;
  const condition = /уценк|ucenk|ucenen/i.test(label) ? 'уценка'
    : /(^|[^а-яё])б\/у([^а-яё]|$)|бывш\S* в употреблени|\bused\b|b-u-|\bbu\b/i.test(label) ? 'б/у'
      : /восстановленн|refurbish|\bref\b|после ремонта|витринн\S* образ/i.test(label) ? 'восстановленный' : null;
  // «Последняя цена» — магазин показывает, сколько товар стоил, когда был: сейчас его нет.
  const head = text.slice(titleStart(page.html, text, offer.title), titleStart(page.html, text, offer.title) + 700);
  const gone = /последняя цена|товар снят с продажи|снят с производства|нет в продаже|товар закончился|распродано/i.test(head);
  // разметка schema.org бывает неполной — дополняем её таблицей со страницы (без повторов по названию)
  const fromTable = specsFromPage(page.html);
  const specs = structured?.props?.length >= 3 ? [...structured.props, ...fromTable.filter((p) => !structured.props.some((q) => String(q.name).toLowerCase() === String(p.name).toLowerCase()))] : fromTable;
  // Количество в наличии: из разметки, иначе из текста возле названия товара (а не из блока «похожие товары» ниже).
  const from = titleStart(page.html, text, offer.title);
  const stock = gone ? { qty: null, at_least: false, note: null, availability: 'нет в наличии' }
    : readStock({ text: text.slice(from, from + 3500), html: page.html, level: structured?.stock, availability: offer.availability, attr: stockAttr });
  const inn = offer.seller_inn && /^\d{10}(\d{2})?$/.test(offer.seller_inn) ? offer.seller_inn : innFromText(text);
  return {
    ...offer,
    title: String(offer.title || item.name).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(),
    pack_qty: offer.pack_qty && offer.pack_qty > 1 ? offer.pack_qty : packFromText(`${offer.title} ${offer.unit || ''}`) || 1,
    seller_inn: inn,
    seller_inn_on_site: Boolean(inn && text.includes(inn)),
    seller_region: regionFromText(offer.seller_city || '') ?? regionFromText(text.slice(-4000)),
    delivery_days: offer.delivery_days ?? deliveryDaysFromText(text),
    // Нужный товар нашёлся на странице каталога — ссылка на его собственную страницу (из разметки), а не на каталог.
    url: listing && structured?.url && sameSite(structured.url, page.url) ? structured.url : page.url,
    extracted_by: method,
    condition,
    // Наличие — одним из трёх слов: «в наличии», «нет в наличии», «под заказ» (или null, если магазин его не показал).
    availability: gone ? (normalizeAvailability(offer.availability) === 'в наличии' ? 'в наличии' : 'нет в наличии') : stock.availability,
    stock_qty: stock.qty, stock_note: stock.note,
    // Для сверки с ТЗ: характеристики из разметки и та часть страницы, где описан товар (а не меню сайта).
    text: [specs.length ? `Характеристики: ${specs.map((s) => `${s.name}: ${s.value}`).join('; ')}` : '',
      productText(page, { title: offer.title, requirements: requirementsOf(item) })].filter(Boolean).join('\n'),
    // Карточка товара: фото и характеристики — из разметки страницы, иначе из её таблиц.
    image_url: imageFromPage(page.html, page.url, structured?.image),
    specs,
    brand: structured?.brand || null,
    model: structured?.model || null,
    // ссылки на вкладку «Характеристики» и PDF-паспорт — для добора, если на странице не всё (в базу не пишутся)
    doc_links: docLinks(page.html, page.url),
  };
}

module.exports = { extractOffer, OfferSchema, bestStructured, packFromText, deliveryDaysFromText };
