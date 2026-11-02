// Воронка поиска поставщиков: что стало с каждым адресом по пути «запрос → отбор → страница → цена → сверка».
//
// Без неё на вопрос «почему сервис не показал товар, который находится в поисковике руками» ответить нечем:
// результат может потеряться на любом шаге, и раньше это нигде не было видно. Воронка считается по каждой позиции
// и сохраняется вместе с поиском; в интерфейсе показывается простыми словами.

/** Почему адрес из выдачи не взят в работу. */
const DROP_REASONS = {
  blocklist: 'площадки без постоянных продавцов: маркетплейсы, доски объявлений, соцсети, тендерные сайты',
  retail: 'крупные розничные сети — их цены выше оптовых',
  closed: 'сайты, закрытые для программ (запомнены при прошлых поисках)',
  foreign: 'зарубежные сайты — цены в другой валюте',
  domain_cap: 'лишние ссылки с уже взятого сайта',
  page_limit: 'не открыты: исчерпан лимит страниц на позицию',
};

/** Почему открытая страница не дала предложения. */
const PAGE_REASONS = {
  robots: 'сайт запрещает программам читать эту страницу (robots.txt)',
  denied: 'сайт не пускает программы (отказ в доступе)',
  captcha: 'сайт показал проверку «я не робот»',
  no_response: 'сайт не ответил',
  http: 'страница не найдена или сайт ответил ошибкой',
  too_big: 'страница слишком большая',
  unsafe: 'ссылка ведёт на внутренний или служебный адрес — не открываем',
  listing: 'страница каталога, а не товара — подходящих товаров на ней не нашлось',
  currency: 'цена не в рублях',
  no_price: 'на странице нет цены',
  error: 'страницу не удалось разобрать',
};

const MATCH_ORDER = ['соответствует', 'частично', 'не хватает данных', 'не соответствует'];

const site = (d) => String(d || '').replace(/^www\./, '');

function createFunnel(item) {
  const data = {
    item_id: item.id, name: String(item.name || '').slice(0, 120),
    queries: [], dropped: {}, taken: 0, catalog: 0, from_listings: 0, opened: 0, pages: {}, with_price: 0, offers: {},
  };
  const bump = (group, reason, domain) => {
    const g = (data[group][reason] ||= { n: 0, domains: [] });
    g.n++;
    const d = site(domain);
    if (d && !g.domains.includes(d) && g.domains.length < 15) g.domains.push(d);
  };
  return {
    data,
    /** Запрос к поисковику: сколько адресов он вернул и сколько из них взято в работу. */
    query(text, source, results, taken) { data.queries.push({ text: String(text).slice(0, 160), source, results, taken }); },
    drop(reason, domain) { bump('dropped', reason, domain); },
    take() { data.taken++; },
    catalog(n) { data.catalog += n; },
    listing(n) { data.from_listings += n; },
    open() { data.opened++; },
    page(reason, domain) { bump('pages', reason, domain); },
    price() { data.with_price++; },
    offer(match) { data.offers[match] = (data.offers[match] || 0) + 1; },
  };
}

/** Причина, по которой страница не открылась или не прочитана, — для счётчика воронки. */
function pageReason(err) {
  if (err?.kind && PAGE_REASONS[err.kind]) return err.kind;
  const m = String(err?.message || '');
  if (/robots\.txt/i.test(m)) return 'robots';
  if (/не робот/i.test(m)) return 'captcha';
  if (/HTTP (401|403|429|498)|закрыт от автоматического/i.test(m)) return 'denied';
  if (/не ответил/i.test(m)) return 'no_response';
  if (/слишком большая/i.test(m)) return 'too_big';
  if (/каталог/i.test(m)) return 'listing';
  if (/не в рублях/i.test(m)) return 'currency';
  if (/ответил \d{3}/i.test(m)) return 'http';
  return 'error';
}

/** Воронка в виде, готовом для показа: причины с подписями, по убыванию потерь. */
function describeFunnel(f) {
  if (!f) return null;
  const rows = (group, labels) => Object.entries(f[group] || {})
    .map(([key, v]) => ({ key, label: labels[key] || key, n: v.n, domains: v.domains || [] }))
    .sort((a, b) => b.n - a.n);
  const offers = MATCH_ORDER.filter((m) => f.offers?.[m]).map((m) => ({ match: m, n: f.offers[m] }));
  return {
    item_id: f.item_id, name: f.name,
    queries: f.queries || [],
    found: (f.queries || []).reduce((s, q) => s + (q.results || 0), 0),
    taken: f.taken || 0, catalog: f.catalog || 0, from_listings: f.from_listings || 0,
    dropped: rows('dropped', DROP_REASONS),
    opened: f.opened || 0,
    pages: rows('pages', PAGE_REASONS),
    with_price: f.with_price || 0,
    offers,
  };
}

module.exports = { createFunnel, describeFunnel, pageReason, DROP_REASONS, PAGE_REASONS };
