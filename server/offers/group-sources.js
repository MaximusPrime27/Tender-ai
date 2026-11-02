// Этап 2: источники по группам товаров. Каждая из групп каталога (config/product-groups.json) связывается
// с конкретными сайтами и способом получить цену:
//   — из наших списков (config/stores.json, config/profile-suppliers.json): опт с открытыми ценами, дистрибьюторы
//     по регистрации, API партнёра, прайс, КП, B2B-каталоги для поиска через Яндекс;
//   — из своей базы: сайты, которые уже дали цену при поиске по товарам этой группы (это проверено делом).
// К этому — профиль группы (config/group-sources.json): основной канал, доставка, документы, можно ли найти цену
// автоматически. Профиль — оценка рынка, не проверка; проверенное — только то, что сервис видел сам.
// Ничего платного здесь не запускается: таблица считается по уже собранным данным.

const fs = require('node:fs');
const path = require('node:path');
const directions = require('../tenders/directions');
const productGroups = require('../tenders/product-groups');

const PROFILE_FILE = path.join(__dirname, '..', '..', 'config', 'group-sources.json');

const CHANNEL = {
  open_wholesale: 'опт с ценами на сайтах',
  distributor: 'дистрибьюторы: цены после регистрации юрлица',
  maker_dealer: 'производители и дилеры: цена по запросу (КП)',
  local_quote: 'местные поставщики: только КП',
  license_partner: 'лицензии через партнёров производителя',
};
const DELIVERY = {
  national: 'по России транспортной компанией',
  heavy: 'тяжёлое или габаритное: доставка заметно влияет на цену',
  local: 'только местные поставщики: везти издалека невыгодно или нельзя',
};
const AUTO = { yes: 'сервис обычно находит цену сам', partly: 'часть товаров — сам, остальное — КП', no: 'только КП или прайс' };

// Как получить цену у компании: open — на сайте без входа, сервис читает сам; остальное — через человека.
const PRICE_OF_ACCESS = {
  public_site: 'open', api_partner: 'api', b2b_price_export: 'registration', partner_request: 'registration',
  public_price_link: 'pricelist', public_price_link_stale_risk: 'pricelist', public_excel_price_link: 'pricelist',
  wholesale_price_request: 'quote', quote_request: 'quote',
};
const PRICE_LABEL = {
  open: 'цена на сайте без входа', search: 'цена на сайте, ищем через Яндекс', api: 'API для партнёров (нужен договор)',
  registration: 'цена после регистрации юрлица', pricelist: 'прайс-лист (проверить актуальность)', quote: 'по запросу (КП)',
};

/** Пересекаются ли коды: «26.20» и «26.20.17» — да (один начинается с другого). */
const overlap = (a, b) => a.startsWith(b) || b.startsWith(a);

/**
 * @param catalog () => компании из списков (supplierCatalog.list(): опт, дистрибьюторы, профильные поставщики)
 * @param stores () => config/stores.json (b2b — каталоги для поиска через Яндекс, retail — розничные сети)
 * @param siteStatus () => состояние каталога страниц ({sites: [{domain, pages, status, refreshed_at}]}) или null
 */
function createGroupSources({ repo, catalog, stores, siteStatus = () => null, profileFile = PROFILE_FILE, clock = () => new Date(), ttlMs = 3600e3 }) {
  let cache = null;

  function profiles() {
    try { return JSON.parse(fs.readFileSync(profileFile, 'utf8')); } catch { return { groups: {} }; }
  }

  function build() {
    const groups = productGroups.loadGroups();
    const asDirs = groups.map(productGroups.toDirection);
    const standard = directions.loadStandard();
    // направление основной ниши (computers, office…) → группы с пересекающимися кодами
    const groupsOfDir = (id) => {
      if (String(id).startsWith('g-')) return [String(id).slice(2)];
      const d = standard.find((x) => x.id === id);
      return d ? groups.filter((g) => g.codes.some((c) => (d.codes || []).some((p) => overlap(c, p)))).map((g) => g.id) : [];
    };
    const bySite = (list) => new Map(list.map((s) => [s.domain, s]));
    const indexed = bySite((siteStatus()?.sites || []).filter((s) => s.status === 'ok'));
    const retail = new Set(((stores() || {}).retail || []).map((r) => r.site));
    const isRetail = (d) => [...retail].some((r) => d === r || d.endsWith(`.${r}`));
    const links = new Map(groups.map((g) => [g.id, new Map()]));
    const add = (gid, site, row) => {
      const m = links.get(gid);
      if (!m) return;
      m.set(site, { ...(m.get(site) || {}), ...row, site });
    };

    // 1. компании из списков
    for (const c of catalog()) {
      const price = PRICE_OF_ACCESS[c.access_mode] || 'registration'; // дистрибьютор без пометки — цены партнёрам
      for (const dir of c.directions || []) for (const gid of groupsOfDir(dir)) {
        add(gid, c.site, { name: c.name || c.site, price, note: c.notes || c.note || '', listed: true });
      }
    }
    // 2. B2B-каталоги: цена на сайте, страницы находим через Яндекс по сайту
    for (const b of (stores() || {}).b2b || []) {
      if (b.enabled === false) continue;
      const gids = (b.codes || []).length ? groups.filter((g) => g.codes.some((c) => b.codes.some((p) => overlap(c, p)))).map((g) => g.id) : [];
      for (const gid of gids) add(gid, b.site, { name: b.name || b.site, price: links.get(gid)?.get(b.site)?.price || 'search', note: b.note || '', listed: true });
    }
    // 3. проверено делом: сайты, которые уже дали цену по товарам группы со сверкой «соответствует» или «частично»
    const { items, offers } = repo.groupSourceRows();
    const groupOfItem = new Map();
    const demand = {};
    for (const it of items) {
      const d = directions.pick(asDirs, [it.ktru_code, it.okpd2_code].filter(Boolean), it.name || '');
      const gid = d?.id ? d.id.slice(2) : null;
      groupOfItem.set(it.id, gid);
      if (gid) demand[gid] = (demand[gid] || 0) + 1;
    }
    const used = new Map(); // gid|site → {offers, tenders:Set, regions}
    for (const o of offers) {
      const gid = groupOfItem.get(o.item_id);
      if (!gid || !['соответствует', 'частично'].includes(o.match)) continue;
      const site = String(o.domain).replace(/^www\./, '');
      const k = `${gid}|${site}`;
      const u = used.get(k) || { offers: 0, full: 0, tenders: new Set(), regions: {} };
      u.offers++; u.tenders.add(o.tender_id);
      if (o.match === 'соответствует') u.full++;
      if (o.seller_region) u.regions[o.seller_region] = (u.regions[o.seller_region] || 0) + 1;
      used.set(k, u);
    }
    for (const [k, u] of used) {
      // одна «частичная» цена — часто случайное совпадение (аптека в инструменте): нужно две или одна полная
      if (u.offers < 2 && !u.full) continue;
      const [gid, site] = k.split('|');
      const known = links.get(gid)?.get(site);
      add(gid, site, {
        ...(known ? {} : { name: site, price: isRetail(site) ? 'retail' : 'open', note: '' }),
        used: { offers: u.offers, tenders: u.tenders.size },
        region: Number(Object.entries(u.regions).sort((a, b) => b[1] - a[1])[0]?.[0]) || null,
      });
    }

    const prof = profiles();
    const out = groups.map((g) => {
      const p = prof.groups?.[g.id] || {};
      const sources = [...links.get(g.id).values()].map((s) => {
        const idx = indexed.get(s.site);
        const retailSite = s.price === 'retail' || isRetail(s.site);
        // насколько проверено: цены из поиска → каталог страниц собран → проверен при добавлении → только в списке
        const level = s.used ? 'used' : idx ? 'indexed' : s.price === 'open' && s.listed ? 'checked' : 'listed';
        const verified = s.used ? `цены получены в поиске: ${s.used.offers} в ${s.used.tenders} закупк.`
          : idx ? `каталог страниц собран: ${idx.pages.toLocaleString('ru-RU')} стр.`
            : level === 'checked' ? 'проверен при добавлении: сайт открыт роботу, цена видна без входа'
              : 'только в списке: условия не подтверждены';
        return {
          site: s.site, name: s.name, note: s.note || '', region: s.region || null, level, verified, used_offers: s.used?.offers || 0,
          price: retailSite ? 'retail' : s.price, price_label: retailSite ? 'розница: только для характеристик и как ориентир цены' : PRICE_LABEL[s.price] || PRICE_LABEL.registration,
          registration: ['registration', 'api'].includes(s.price) ? true : ['open', 'search'].includes(s.price) ? false : null,
          // роли источника: искать товар, брать характеристики, брать закупочную цену, ориентир цены
          roles: {
            discovery: Boolean(idx) || s.price === 'search' || s.price === 'open',
            specs: true,
            offers: !retailSite && ['open', 'search'].includes(s.price),
            reference_price: retailSite,
          },
        };
      }).sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (b.used_offers || 0) - (a.used_offers || 0) || PRICE_RANK[a.price] - PRICE_RANK[b.price] || a.site.localeCompare(b.site));
      const open = sources.filter((s) => s.roles.offers).length;
      const usedN = sources.filter((s) => s.level === 'used' && s.roles.offers).length;
      const closed = sources.filter((s) => ['registration', 'api', 'pricelist', 'quote'].includes(s.price)).length;
      const indexedN = sources.filter((s) => s.level === 'indexed' && s.roles.offers).length;
      // «хорошо» — три сайта с ценами, и это не только список: цены уже получали или каталог страниц собран
      const coverage = open >= 3 && (usedN >= 1 || indexedN >= 2) ? 'good' : open || closed ? 'weak' : 'none';
      const advice = coverage === 'good' ? (usedN ? 'Источников с ценами достаточно' : 'Источников достаточно, но цены по этой группе ещё не получали — проверьте на первой закупке')
        : p.auto === 'no' ? 'Цены на сайтах здесь обычно не публикуют — запрос КП поставщикам региона заказчика'
          : coverage === 'weak' ? (open >= 3 ? 'Сайты с ценами есть, но не проверены — проверьте на первой закупке' : open ? 'Мало сайтов с открытыми ценами — стоит добавить поставщиков' : 'Цены только после регистрации или по запросу — прайс или КП')
            : 'Поставщиков с открытыми ценами в списках нет — нужно подобрать';
      return {
        id: g.id, title: g.title, section: g.section, image: g.image, demand: demand[g.id] || 0,
        channel: p.channel || null, channel_label: CHANNEL[p.channel] || 'не оценено',
        delivery: p.delivery || null, delivery_label: DELIVERY[p.delivery] || 'не оценено',
        auto: p.auto || null, auto_label: AUTO[p.auto] || 'не оценено', docs: p.docs || '',
        counts: { open, used: usedN, indexed: indexedN, closed, total: sources.length }, coverage, advice, sources,
      };
    });
    const retailList = [...retail];
    return {
      at: clock().toISOString(), profile_checked_at: prof.checked_at || null, groups: out,
      retail: retailList, // розничные сети: в закупочную цену не идут, для характеристик — можно
      summary: {
        good: out.filter((g) => g.coverage === 'good').length, weak: out.filter((g) => g.coverage === 'weak').length, none: out.filter((g) => g.coverage === 'none').length,
        // где спрос большой, а источников нет — с этого начинать подбор поставщиков
        gaps: out.filter((g) => g.coverage !== 'good' && g.auto !== 'no').sort((a, b) => b.demand - a.demand).slice(0, 10).map((g) => ({ id: g.id, title: g.title, demand: g.demand, coverage: g.coverage })),
      },
    };
  }

  return {
    /** Таблица источников (пересчёт раз в час: обходит все позиции закупок). */
    get({ fresh = false } = {}) {
      if (!fresh && cache && clock().getTime() - cache.t < ttlMs) return cache.data;
      cache = { t: clock().getTime(), data: build() };
      return cache.data;
    },
  };
}

const LEVEL_RANK = { used: 0, indexed: 1, checked: 2, listed: 3 };
const PRICE_RANK = { open: 0, search: 1, api: 2, pricelist: 3, registration: 4, quote: 5, retail: 6 };

module.exports = { createGroupSources, CHANNEL, DELIVERY, AUTO, PRICE_LABEL };
