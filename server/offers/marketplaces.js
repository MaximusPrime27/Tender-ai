// Модель, подходящая под ТЗ, — на маркетплейсах (Ozon, Wildberries, Яндекс Маркет, Мегамаркет).
// Сами маркетплейсы сервису закрыты (капча, блокировка, запрет в robots.txt — разведка 17.10.2026), поэтому их страницы
// сервис не открывает. Карточки товаров находит официальный поиск Яндекса (Search API, платный: 1 запрос на модель),
// цену человек видит по ссылке и вписывает сам. Ищутся только модели, которые уже сверены с ТЗ: модель из ТЗ или модель
// товара, у которого подтверждено каждое требование, — поэтому найденная карточка — та же модель, а не похожий товар.

const { modelTokens, searchName } = require('./spec');

const enc = encodeURIComponent;
const MARKETS = [
  { id: 'ozon', name: 'Ozon', site: 'ozon.ru', card: /^https?:\/\/(www\.)?ozon\.ru\/product\//i, search: (q) => `https://www.ozon.ru/search/?text=${enc(q)}` },
  { id: 'wb', name: 'Wildberries', site: 'wildberries.ru', card: /^https?:\/\/(www\.)?wildberries\.ru\/catalog\/\d+\/detail/i, search: (q) => `https://www.wildberries.ru/catalog/0/search.aspx?search=${enc(q)}` },
  { id: 'ym', name: 'Яндекс Маркет', site: 'market.yandex.ru', card: /^https?:\/\/market\.yandex\.ru\/(product|card)/i, search: (q) => `https://market.yandex.ru/search?text=${enc(q)}` },
  { id: 'mm', name: 'Мегамаркет', site: 'megamarket.ru', card: /^https?:\/\/megamarket\.ru\/catalog\/details\//i, search: (q) => `https://megamarket.ru/catalog/?q=${enc(q)}` },
];
const MAX_MODELS = 3;
const flat = (s) => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
// название товара без «для …» (у картриджа «для HP M404» — это совместимость, а не его модель)
// «для офисной техники», «для печати» — назначение товара, а не совместимость: их не отрезаем
const PURPOSE = /\s+для\s+(офисной\s+техники|оргтехники|печати|офиса|дома(\s+и\s+офиса)?|принтеров(\s+и\s+копиров)?|копировальных\s+аппаратов)/gi;
const ownName = (title) => String(title || '').replace(PURPOSE, ' ').split(/(?:^|[\s(,])(?:для|for|к)(?=\s)/i)[0];
/** Название товара для поиска: без кавычек и хвоста характеристик, до 7 слов. */
const shortTitle = (t) => String(t || '').replace(/[«»"]/g, '').split(/[,(;]/)[0].split(/\s+/).filter(Boolean).slice(0, 7).join(' ');

// слова вида товара — не марка: «МФУ лазерное Катюша M130» → марка «Катюша»
const KIND_WORDS = /^(мфу|принтер[а-яёa-z]*|сканер[а-яёa-z]*|копир[а-яёa-z]*|лазерн[а-яёa-z]*|струйн[а-яёa-z]*|картридж[а-яёa-z]*|тонер[а-яёa-z]*|ноутбук[а-яёa-z]*|монитор[а-яёa-z]*|ssd|hdd|накопител[а-яёa-z]*|диск[а-яёa-z]*|внутренн[а-яёa-z]*|твердотельн[а-яёa-z]*|коммутатор[а-яёa-z]*|видеокамер[а-яёa-z]*|камер[а-яёa-z]*|ip-камер[а-яёa-z]*|видеорегистратор[а-яёa-z]*|системн[а-яёa-z]*|блок[а-яёa-z]*|компьютер[а-яёa-z]*|моноблок[а-яёa-z]*|планшет[а-яёa-z]*|клавиатур[а-яёa-z]*|мыш[а-яёa-z]*|кабел[а-яёa-z]*|многофункциональн[а-яёa-z]*|устройств[а-яёa-z]*|черн[а-яёa-z]*|цветн[а-яёa-z]*|оригинальн[а-яёa-z]*|новый|новая|риббон|лент[а-яё]*|красящ[а-яё]*|бел[а-яё]*|син[а-яё]*|желт[а-яё]*|пурпурн[а-яё]*|голуб[а-яё]*|бумага|мешк[а-яёa-z]*|средств[а-яёa-z]*)$/i;

/** Марка перед моделью в названии: «МФУ лазерное Pantum M6700DW» → «Pantum», «МФУ Катюша M130» → «Катюша». */
function brandBefore(title, model) {
  const words = ownName(title).split(/[\s,]+/).filter(Boolean);
  const i = words.findIndex((w) => flat(w).includes(flat(model)));
  // первое слово-марка в названии: «Бумага Canon Yellow Label Print 6821B002» → Canon, а не Print
  for (let j = 0; j < i; j++) {
    const w = words[j].replace(/[«»"()]/g, '');
    if (/^[A-Za-zА-ЯЁ][A-Za-zА-Яа-яЁё-]{1,}$/.test(w) && !KIND_WORDS.test(w) && !KIND_WORDS.test(w.split('-')[0]) && !/^(для|бумага)$/i.test(w)) return w;
  }
  return null;
}

/**
 * Модели позиции, сверенные с ТЗ: из самого ТЗ и из товаров «соответствует» (подтверждено каждое требование).
 * @returns [{model, query, basis}]
 */
function confirmedModels(item, offers = []) {
  const out = [];
  const add = (model, query, basis) => { if (model && !out.some((m) => flat(m.model) === flat(model))) out.push({ model, query, basis }); };
  const noModel = []; // товар сверен с ТЗ, но модели в названии нет (мешки, моющее средство): только бесплатный поиск по названию
  // вид товара для запроса: «МФУ» из «Многофункциональное устройство (МФУ)», иначе первое слово названия
  // «Красящая лента» — прилагательное с существительным, а не одно «Красящая»
  const words = searchName(item.name).split(/\s+/).filter(Boolean);
  const kind = /\(([А-ЯЁA-Z]{2,6})\)/.exec(item.name)?.[1] || (/(ая|ый|ое|ий|ые)$/i.test(words[0] || '') && words[1] ? `${words[0]} ${words[1]}` : words[0] || '');
  const tzModel = item.spec?.identity?.model;
  if (tzModel) add(tzModel, [kind, item.spec.identity.brand, tzModel].filter(Boolean).join(' '), 'модель указана в ТЗ');
  for (const o of offers.filter((x) => x.match === 'соответствует' && x.source !== 'contracts')) {
    const own = modelTokens(ownName(o.title));
    if (!own.length && !noModel.length) noModel.push({ model: null, query: shortTitle(o.title), basis: `товар сверен с ТЗ по странице ${o.domain || 'продавца'}; модели в названии нет — только поиск по названию` });
    for (const m of own.slice(0, 1)) add(m, [kind, brandBefore(o.title, m), m].filter(Boolean).join(" "), `сверена с ТЗ по странице ${o.domain || 'продавца'}`);
  }
  return out.length ? out.slice(0, MAX_MODELS) : noModel;
}

/** В названии — именно эта модель (целым словом: M130W — не M130) и не «совместимый аналог». */
const sameModel = (title, model) => modelTokens(ownName(title)).some((t) => flat(t) === flat(model)) && !/совместим|аналог|compatible|замена/i.test(String(title || ''));

/** Карточки маркетплейсов из выдачи: только страницы товара, в названии — та же модель; аналоги помечены. */
function cardsFrom(results, model) {
  const want = flat(model);
  const seen = new Set();
  const cards = [];
  for (const r of results) {
    const m = MARKETS.find((x) => x.card.test(r.url));
    if (!m) continue;
    // одна карточка — один адрес: без параметров, страницы отзывов и разницы в конечной «/»
    const key = r.url.split('?')[0].replace(/\/reviews\/?$/, '').replace(/\/?$/, '/').replace(/(detail\.aspx)\/$/, '$1');
    if (seen.has(key)) continue;
    const title = String(r.title || '').replace(/\s*(купить|—|-)\s*(на\s+)?(ozon|озон|wildberries|яндекс маркет[е]?).*$/i, '').trim();
    // модель — целым словом в названии самого товара: CF259X вместо CF259A и M130W вместо M130 — не та
    if (!modelTokens(ownName(title)).some((t) => flat(t) === want)) continue;
    seen.add(key);
    if (cards.filter((c) => c.market === m.id).length >= 4) continue; // не больше 4 с одного маркетплейса — чтобы были видны и другие
    cards.push({ market: m.id, market_name: m.name, url: key, title: title || r.title, snippet: String(r.snippet || '').slice(0, 400), analog: /совместим|аналог|compatible|замена/i.test(title) });
  }
  return cards.slice(0, 12);
}

/**
 * Карточки по описанию из ТЗ (модели в ТЗ нет): все страницы товаров маркетплейсов из выдачи — подходит ли товар,
 * решает сверка с ТЗ по названию и описанию карточки, а не совпадение модели.
 */
function cardsByDescription(results) {
  const seen = new Set();
  const cards = [];
  for (const r of results) {
    const m = MARKETS.find((x) => x.card.test(r.url));
    if (!m) continue;
    const key = r.url.split('?')[0].replace(/\/reviews\/?$/, '').replace(/\/?$/, '/').replace(/(detail\.aspx)\/$/, '$1');
    if (seen.has(key)) continue;
    seen.add(key);
    const title = String(r.title || '').replace(/\s*(купить|—|-)\s*(на\s+)?(ozon|озон|wildberries|яндекс маркет[е]?).*$/i, '').trim();
    cards.push({ market: m.id, market_name: m.name, url: key, title: title || r.title, snippet: String(r.snippet || '').slice(0, 400), analog: /совместим|аналог|compatible|замена/i.test(title) });
  }
  return cards.slice(0, 12);
}

/** Ссылки «эта модель на маркетплейсе» — бесплатно: поиск самого маркетплейса по точной модели. */
const searchLinks = (query) => MARKETS.map((m) => ({ market: m.id, market_name: m.name, url: m.search(query) }));

module.exports = { MARKETS, confirmedModels, cardsFrom, cardsByDescription, searchLinks, brandBefore, sameModel };
