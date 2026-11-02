// Яндекс Search API (Yandex Cloud): обычная поисковая выдача без рекламных блоков.
// Документация: https://aistudio.yandex.ru/docs/ru/search-api/api-ref/WebSearch/search
// Авторизация — API-ключ сервисного аккаунта (заголовок Authorization: Api-Key …), каталог — folderId.

const API_URL = 'https://searchapi.api.cloud.yandex.net/v2/web/search';
const IMAGE_SEARCH_URL = 'https://searchapi.api.cloud.yandex.net/v2/image/search';
const IMAGE_BY_IMAGE_URL = 'https://searchapi.api.cloud.yandex.net/v2/image/search_by_image';

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Разбор XML-выдачи: <doc><url/><domain/><title/><passages/></doc>. TODO: проверить на реальном ключе полноту полей. */
function parseResultsXml(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<doc\b[^>]*>([\s\S]*?)<\/doc>/g)) {
    const doc = m[1];
    const url = /<url>([\s\S]*?)<\/url>/.exec(doc)?.[1];
    if (!url) continue;
    out.push({
      url: stripTags(url),
      domain: stripTags(/<domain>([\s\S]*?)<\/domain>/.exec(doc)?.[1]),
      title: stripTags(/<title>([\s\S]*?)<\/title>/.exec(doc)?.[1]),
      snippet: stripTags([...doc.matchAll(/<passage>([\s\S]*?)<\/passage>/g)].map((p) => p[1]).join(' … ')),
    });
  }
  return out;
}

function createYandexSearch({ apiKey, folderId, fetchImpl = fetch, resultsPerQuery = 10 }) {
  if (!apiKey || !folderId) return null;
  return {
    name: 'yandex-search',
    async search(queryText) {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${apiKey}` },
        body: JSON.stringify({
          query: { searchType: 'SEARCH_TYPE_RU', queryText: queryText.slice(0, 400), familyMode: 'FAMILY_MODE_MODERATE' },
          groupSpec: { groupMode: 'GROUP_MODE_DEEP', groupsOnPage: resultsPerQuery, docsInGroup: 1 },
          maxPassages: 2,
          l10n: 'LOCALIZATION_RU',
          folderId,
          responseFormat: 'FORMAT_XML',
        }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Яндекс Search API ответил ${res.status}: ${text.slice(0, 200)}`);
      const raw = JSON.parse(text).rawData;
      return parseResultsXml(Buffer.from(raw || '', 'base64').toString('utf8'));
    },

    /**
     * Поиск по картинке (как «поиск по фото» в Яндекс Картинках): где в интернете встречается такое же изображение.
     * POST /v2/image/search_by_image, фото — в поле data (base64), JPEG/PNG/GIF до 3 МБ.
     * TODO: проверить на реальном ключе полноту полей ответа (images[].pageUrl, pageTitle, host).
     * @returns {Promise<Array<{url, domain, title, image}>>}
     */
    async searchByImage(buffer, { page = 0, site } = {}) {
      const res = await fetchImpl(IMAGE_BY_IMAGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${apiKey}` },
        body: JSON.stringify({ folderId, data: Buffer.from(buffer).toString('base64'), page, familyMode: 'FAMILY_MODE_MODERATE', ...(site ? { site } : {}) }),
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Яндекс (поиск по картинке) ответил ${res.status}: ${text.slice(0, 200)}`);
      const data = JSON.parse(text);
      return (data.images || [])
        .filter((i) => i.pageUrl)
        .map((i) => ({ url: i.pageUrl, domain: i.host || null, title: stripTags(i.pageTitle || ''), image: i.url || null, snippet: stripTags(i.passage || '') }));
    },

    /** Картинки по тексту (модель, характеристики) — чтобы получить фото товара, когда в ТЗ его нет. */
    async searchImages(queryText, { docsOnPage = 10 } = {}) {
      const res = await fetchImpl(IMAGE_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${apiKey}` },
        body: JSON.stringify({ query: { searchType: 'SEARCH_TYPE_RU', queryText: queryText.slice(0, 400), familyMode: 'FAMILY_MODE_MODERATE' }, docsOnPage, folderId }),
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Яндекс (поиск картинок) ответил ${res.status}: ${text.slice(0, 200)}`);
      const xml = Buffer.from(JSON.parse(text).rawData || '', 'base64').toString('utf8');
      // В выдаче картинок у документа есть ссылка на страницу и на само изображение.
      return [...xml.matchAll(/<doc\b[^>]*>([\s\S]*?)<\/doc>/g)].map((m) => ({
        url: stripTags(/<url>([\s\S]*?)<\/url>/.exec(m[1])?.[1]),
        image: stripTags(/<image-link>([\s\S]*?)<\/image-link>|<original-image-url>([\s\S]*?)<\/original-image-url>/.exec(m[1])?.slice(1).find(Boolean) || ''),
        title: stripTags(/<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1]),
      })).filter((d) => d.url);
    },
  };
}

const clean = (s) => String(s || '').replace(/[«»"]/g, '').replace(/\s+/g, ' ').trim();

/** Артикул или модель из характеристик («Модель: TK-5240K») или из названия (латиница с цифрами). */
function modelOf(item) {
  const ch = (item.characteristics || []).find((c) => /модел|артикул|парт.?номер|каталожн/i.test(c.name) && c.value && c.value.length <= 40);
  if (ch) return clean(ch.value);
  // Модель в наименовании: латиница с цифрами; русские буквы-двойники («М348») приводим к латинским.
  const m = require('../spec').latinizeModels(item.name).match(/(?<![A-Za-z0-9-])(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]{2,}(?![A-Za-z0-9-])/);
  return m ? m[0] : null;
}

/**
 * Поисковые запросы по позиции ТЗ — от точных к широким, чтобы охватить не только крупные магазины:
 * артикул/модель → название + ключевые характеристики → «оптом» → «дистрибьютор» → «для юрлиц с НДС» → город заказчика.
 * @param {{name, characteristics}} item
 * @param {number} max
 * @param {{city?: string}} opts — город заказчика: ближе продавец — короче доставка
 */
function queriesFor(item, max = 3, { city, spec, title, variant = 0 } = {}) {
  if (spec?.required) return queriesFromSpec(item, spec, max, { city, title, variant });
  const name = require('../spec').withSpecies(require('../spec').itemSearchName(item.name, title), item.characteristics);
  // Значения характеристик — только те, что отличают товар («24 портов», «А4», «SATA III»); «Да», «1 шт» и
  // подробности устройства в запрос не идут — они превращали его в «МФУ Да Да купить цена».
  const keyChars = (item.characteristics || []).filter((c) => !/модел|артикул/i.test(c.name))
    .map((c) => require('../spec').searchValue({ name: c.name, value: c.value })).filter(Boolean).slice(0, 3).map(clean);
  const model = modelOf(item);
  const qs = [
    model && !name.includes(model) ? `${name} ${model} купить` : null,
    `${name} ${keyChars.slice(0, 2).join(' ')} купить цена`,
    `${name} купить оптом для юрлиц`,
    `${name} цена с доставкой по России`,
    `${name} ${keyChars.slice(0, 1).join(' ')} дистрибьютор официальный`,
    `${name} поставщик с НДС безналичный расчёт`,
    city ? `${name} купить ${city}` : null,
  ].filter(Boolean);
  // Город заказчика — всегда в пределах лимита, если он есть: он даёт продавцов с короткой доставкой.
  const uniq = [...new Set(qs.map((q) => q.replace(/\s+/g, ' ').trim()))];
  if (city && max > 1 && uniq.length > max) return [...uniq.slice(0, max - 1), uniq[uniq.length - 1]];
  return uniq.slice(0, max);
}

/**
 * Запросы по спецификации из ТЗ — по отличительным признакам, а не по общему наименованию КТРУ:
 * модель/артикул (с производителем) → наименование + отличительные числа с единицами → совместимость → «оптом».
 */
function queriesFromSpec(item, spec, max = 3, { city, title, variant = 0 } = {}) {
  const { distinctiveTerms, searchName, itemSearchName, isGenericName, modelTokens, furnitureSearch, withSpecies } = require('../spec');
  // «Рыба трескообразная» + «Вид рыбы: Минтай» → «минтай …»
  const name = withSpecies(itemSearchName(spec.name && !isGenericName(spec.name) ? spec.name : item.name, title), [...(spec?.required || []), ...(item.characteristics || [])]);
  // мебель: настоящий вид из «тип» и размеры Ш×Г×В — вперёд («тумба медицинская 1000x600x900 купить»)
  const furn = furnitureSearch(spec, name);
  const id = spec.identity || {};
  const terms = distinctiveTerms(spec, 3).map(clean);
  // Модель не выделена, но стоит в наименовании («Ноутбук ASUS ROG Strix G815JPR-S9037 или эквивалент») —
  // ищем по наименованию до модели включительно: там и тип товара, и производитель.
  const inName = !id.model ? modelTokens(name)[0] : null;
  const model = id.model ? searchName(id.model) : inName;
  const brand = id.brand ? searchName(id.brand) : null;
  const qs = [
    ...(furn && (furn.real || furn.dims) ? furnitureQueries(furn, name, variant) : []),
    !model ? cpuQuery(item, spec, name) : null,
    inName ? `${name.slice(0, name.indexOf(inName) + inName.length)} купить`
      : model ? `${brand && !model.includes(brand) ? `${brand} ` : ''}${model} купить` : null,
    `${name} ${terms.join(' ')} купить`,
    id.compatible_with ? `${name} для ${clean(id.compatible_with)} купить` : null,
    model ? `${name}${name.includes(model) ? '' : ` ${model}`} цена оптом` : `${name} ${terms.slice(0, 2).join(' ')} оптом для юрлиц`,
    `${name} ${terms.slice(0, 1).join(' ')} поставщик с НДС`,
    city ? `${name} ${model || terms.slice(0, 1).join(' ')} купить ${city}` : null,
  ].filter(Boolean);
  const uniq = [...new Set(qs.map((q) => q.replace(/\s+/g, ' ').trim()))];
  if (city && max > 1 && uniq.length > max) return [...uniq.slice(0, max - 1), uniq[uniq.length - 1]];
  return uniq.slice(0, max);
}

/**
 * Запросы для позиции БЕЗ модели (товар описан характеристиками): название + отличительные признаки, и всё.
 * Варианты «оптом для юрлиц», «с доставкой по России», «дистрибьютор официальный», «поставщик с НДС» для таких
 * позиций приводили только на каталоги и агрегаторы — платные запросы уходили впустую.
 */
/**
 * Ноутбук или компьютер, у которого ТЗ задаёт процессор характеристиками (ядра, потоки, кэш, TDP): запрос по
 * подходящему процессору из справочника + память, накопитель, «без ОС» — «Ноутбук Intel Core i5-1235U 16 ГБ 512 ГБ SSD
 * без ОС». Без этого поиск приносил любые ноутбуки, и почти все не подходили по процессору.
 */
function cpuQuery(item, spec, name) {
  const { suitableCpus, segmentOf } = require('../cpu');
  const { fitsNumeric } = require('../match');
  const segment = segmentOf(`${item.name} ${spec?.name || ''}`);
  if (!segment) return null;
  const cpus = suitableCpus(spec?.required, segment, { fitsNumeric });
  if (!cpus.length) return null;
  const req = spec?.required || [];
  const num = (re, not) => { const r = req.find((x) => re.test(x.name) && !(not && not.test(x.name))); const m = r && /(\d+(?:[.,]\d+)?)/.exec(String(r.value)); return m ? Number(m[1].replace(',', '.')) : null; };
  const up = (n, sizes) => (n == null ? null : sizes.find((s) => s >= n) || n);
  const ram = up(num(/оперативн\S*\s+памят/i, /максим|поддерж/i), [4, 8, 16, 32, 64]);
  const ssd = up(num(/ssd|накопител/i, /количеств|интерфейс/i), [128, 256, 512, 1000, 2000]);
  const noOs = req.some((r) => /операционн/i.test(r.name) && /^\s*(нет|отсутств|без)/i.test(String(r.value)));
  return [name, cpus[0].label, ram ? `${ram} ГБ` : null, ssd ? `${ssd >= 1000 ? `${ssd / 1000} ТБ` : `${ssd} ГБ`} SSD` : null, noOs ? 'без ОС' : null, 'купить'].filter(Boolean).join(' ');
}

function specQueries(item, spec, max = 2, { title, variant = 0 } = {}) {
  const { distinctiveTerms, itemSearchName, isGenericName, furnitureSearch, withSpecies } = require('../spec');
  const name = withSpecies(itemSearchName(spec?.name && !isGenericName(spec.name) ? spec.name : item.name, title), [...(spec?.required || []), ...(item.characteristics || [])]);
  const terms = distinctiveTerms(spec || { required: [] }, 5).map(clean);
  const id = spec?.identity || {};
  // мебель: настоящий вид из «тип» и размеры Ш×Г×В — вперёд (без этого «Стеллаж лабораторный 900 ММ 600 ММ…»)
  const furn = furnitureSearch(spec, name);
  const qs = [
    ...(furn && (furn.real || furn.dims) ? furnitureQueries(furn, name, variant) : []),
    cpuQuery(item, spec, name),
    `${name} ${terms.slice(0, 3).join(' ')} купить`,
    id.compatible_with ? `${name} для ${clean(id.compatible_with)} купить` : null,
    // второй запрос — по другим признакам, чтобы не получить ту же выдачу
    terms.length > 3 ? `${name} ${terms.slice(2, 5).join(' ')} цена` : terms.length ? `${name} ${terms.slice(0, 2).join(' ')} цена` : null,
  ].filter(Boolean);
  // запрос по виду и назначению добавляется к прежним: те, что были, остаются
  const { getKindModel, kindQuery } = require('../kind-model');
  const kq = kindQuery(getKindModel(), item);
  return [...new Set([...(kq ? [kq] : []), ...qs.map((q) => q.replace(/\s+/g, ' ').trim())])].slice(0, max + (kq ? 1 : 0));
}

/**
 * «Простой» запрос — как ищет человек: наименование из ТЗ и модель, а если модели нет — две-три главные характеристики.
 * Без «купить», «оптом» и других добавок. По разбору 09.10.2026 (docs/supplier-search-losses.md) в ответе на такой запрос
 * были подходящие товары, которых нет в ответах на остальные запросы сервиса (5 адресов из 80).
 */
function plainQuery(item, spec, { title } = {}) {
  const { distinctiveTerms, itemSearchName, modelTokens, withSpecies } = require('../spec');
  const name = withSpecies(itemSearchName(item.name, title), [...(spec?.required || []), ...(item.characteristics || [])]);
  const furn = require('../spec').furnitureSearch(spec, name);
  if (furn && (furn.real || furn.dims)) return `${furn.real || name} ${furn.dims || ''}`.replace(/\s+/g, ' ').trim();
  const model = spec?.identity?.model || modelTokens(item.name)[0] || '';
  const tail = model ? (name.includes(model) ? '' : model) : distinctiveTerms(spec || { required: [] }, 3).map(clean).join(' ');
  return `${name} ${tail}`.replace(/\s+/g, ' ').trim();
}

/**
 * Запрос по сайту магазина или каталога через поисковик: «site:pulscen.ru картридж TK-5240K».
 * terms — отличительные признаки для позиции без модели: без них поисковик отдаёт раздел каталога, а не товар.
 */
function siteQuery(item, site, terms = []) {
  const model = modelOf(item);
  const extra = model ? (String(item.name).includes(model) ? '' : ` ${model}`) : terms.length ? ` ${terms.slice(0, 2).map(clean).join(' ')}` : '';
  const { itemSearchName } = require('../spec');
  return `site:${site} ${clean(itemSearchName(item.name)).slice(0, 80)}${extra}`.replace(/\s+/g, ' ');
}

/**
 * Какие B2B-сайты спрашивать по позиции. Профильный сайт (codes/words в config/stores.json) — только если позиция
 * подходит по коду или наименованию; общие каталоги — всегда. Каждый сайт — платный запрос, поэтому не больше limit:
 * сначала профильные, одно место оставляем общему каталогу (там оптовики), остаток — снова профильным.
 */
function b2bSitesFor(item, sites, limit = 3) {
  const code = String(item.ktru_code || item.okpd2_code || '');
  const name = String(item.name || '').toLowerCase().replace(/ё/g, 'е');
  const general = [];
  const special = [];
  for (const s of sites) {
    if (!s.codes?.length && !s.words?.length) { general.push(s); continue; }
    const byCode = code && (s.codes || []).some((p) => code.startsWith(p));
    const byWord = (s.words || []).some((w) => name.includes(String(w).toLowerCase()));
    if (byCode || byWord) special.push(s);
  }
  const first = special.slice(0, general.length ? Math.max(0, limit - 1) : limit);
  const rest = [...general, ...special.slice(first.length)];
  return [...first, ...rest].slice(0, Math.max(0, limit));
}


// Мебель, повторные попытки агента поиска поставщиков: каждая попытка — другие формулировки и другие магазины.
// 1 — синонимы вида и «от производителя»; 2 — розница и маркетплейсы (через поисковик, сайты маркетплейсов роботу закрыты).
const FURN_SYNONYMS = [
  [/тумб/i, ['шкаф-тумба', 'тумба']], [/стеллаж/i, ['стеллаж металлический', 'этажерка']], [/стол/i, ['стол рабочий', 'стол']],
  [/шкаф/i, ['шкаф металлический', 'шкаф']], [/кресл/i, ['кресло офисное', 'кресло']], [/стул/i, ['стул офисный', 'стул']],
  [/витрин/i, ['шкаф-витрина', 'витрина']], [/кушет/i, ['кушетка медицинская', 'кушетка']], [/скам|банкетк/i, ['скамья', 'банкетка']],
];
function furnitureQueries(furn, name, variant = 0) {
  const what = furn.real || name;
  const dims = furn.dims || '';
  if (variant === 1) {
    const syn = (FURN_SYNONYMS.find(([re]) => re.test(what))?.[1] || []).find((s) => !what.toLowerCase().includes(s)) || what;
    return [`${what} ${dims} от производителя`, `${syn} ${dims} купить`, `${what} ${dims} производитель цена`];
  }
  if (variant >= 2) {
    return [`${what} ${dims} (site:ozon.ru | site:market.yandex.ru | site:wildberries.ru | site:megamarket.ru)`, `${what} ${dims} интернет-магазин доставка`];
  }
  return [furn.real ? `${furn.real} ${dims} купить` : null, furn.dims ? `${what} ${furn.dims} цена` : null, furn.dims && furn.real ? `${name} ${furn.dims} купить` : null].filter(Boolean);
}

module.exports = { furnitureQueries, createYandexSearch, parseResultsXml, queriesFor, queriesFromSpec, specQueries, plainQuery, siteQuery, b2bSitesFor, modelOf };
