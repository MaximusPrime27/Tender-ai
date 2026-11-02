// Профильные компании, у которых цену нужно запросить (прайс партнёрам, КП, B2B-кабинет).
//
// Это кандидаты, а не предложения: пока компания не прислала цену, в расчёт выгодности она не попадает и закупочной
// цены у неё нет. Каталог собирается из config/profile-suppliers.json и уже известных сайтов из config/stores.json
// (suppliers — магазины, чьи цены сервис читает сам; distributors — дистрибьюторы с ценами для партнёров).
// Состояние работы с компанией (запрос подготовлен, ждём ответа…) — отметка пользователя в настройках базы.
// Модуль ничего не скачивает и не отправляет: черновик запроса КП — только текст для копирования.
const fs = require('node:fs');
const path = require('node:path');
const directions = require('../tenders/directions');
const productGroups = require('../tenders/product-groups');
const { specOf } = require('./spec');

const STATES = ['not_contacted', 'rfq_prepared', 'awaiting_reply', 'terms_received', 'blocked'];
const STATE_LABELS = {
  not_contacted: 'Контакт не установлен', rfq_prepared: 'Запрос КП подготовлен',
  awaiting_reply: 'Ожидается ответ', terms_received: 'Условия получены, требуется проверка', blocked: 'Не работаем',
};
// Как у компании получить цену.
const ACCESS_LABELS = {
  api_partner: 'Нужен партнёрский доступ к API', b2b_price_export: 'Нужен прайс из B2B',
  public_excel_price_link: 'Прайс заявлен на сайте, файл требует проверки',
  public_price_link: 'Прайс заявлен на сайте, актуальность требует проверки',
  public_price_link_stale_risk: 'Запросить актуальный прайс',
  wholesale_price_request: 'Запросить оптовый прайс', partner_request: 'Запросить условия партнёрства',
  quote_request: 'Запросить КП',
  // магазин из config/stores.json: розничная цена на сайте открыта, сервис читает её сам при поиске
  public_site: 'Цена на сайте открыта — сервис читает её сам; на партию запросите КП',
  unknown: 'Уточнить способ получения цены',
};

/** Домен без www и пути; null — не сайт (javascript:, адрес с логином и паролем и т. п.). */
function normalizeDomain(value) {
  try {
    const url = new URL(String(value).includes('://') ? value : `https://${value}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const domain = url.hostname.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
  } catch { return null; }
}

const safeUrl = (value) => {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; }
  catch { return null; }
};

function readJson(file, fallback) {
  if (!file) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw new Error(`Некорректный каталог поставщиков: ${path.basename(file)}`); }
}

/**
 * Один список компаний из профильного каталога и прежних списков: записи с одним сайтом склеиваются,
 * направления складываются, запрет (enabled: false) в любой из записей сохраняется.
 */
function mergeCatalog(profile, legacy) {
  const bySite = new Map();
  const rows = [
    ...(legacy.distributors || []),
    ...(legacy.suppliers || []).map((r) => ({ access_mode: 'public_site', ...r })),
    ...(profile.suppliers || []),
  ];
  for (const row of rows) {
    const site = normalizeDomain(row.site);
    if (!site) continue;
    const old = bySite.get(site) || {};
    const dirs = [...new Set([...(old.directions || []), ...(row.directions || []), ...(row.dir ? [row.dir] : [])])];
    bySite.set(site, { ...old, ...row, site, id: site, directions: dirs,
      enabled: old.enabled !== false && row.enabled !== false,
      contacts: { ...(old.contacts || {}), ...(row.contacts || {}) },
      source_url: safeUrl(row.source_url || old.source_url) || `https://${site}/`,
      evidence_urls: [...new Set([...(old.evidence_urls || []), ...(row.evidence_urls || [])])].map(safeUrl).filter(Boolean),
    });
  }
  return [...bySite.values()];
}

const MATCH_RANK = { 'соответствует': 0, 'частично': 1, 'не хватает данных': 2, 'не соответствует': 3 };
/** Страница этого сайта? Городские зеркала (kazan.xcom-shop.ru) — тот же магазин. */
const onSite = (domain, site) => { const d = String(domain || '').replace(/^www\./, ''); return Boolean(d) && (d === site || d.endsWith(`.${site}`)); };

/**
 * Компании блока вместе с товаром, найденным на их сайтах по позиции: у компании с открытыми ценами (магазин из
 * config/stores.json) — до трёх предложений с её сайта, сначала подходящие под ТЗ и дешёвые. Раньше в блоке стояла
 * только ссылка на сайт, и модель человек искал там сам.
 * @param candidates компании позиции (forItem)
 * @param offers предложения по этой позиции (магазины и ручные)
 * @param lookupOf (site) → итог отдельного поиска товара на сайте {status, models, reason, at} или null — ещё не искали
 */
function attachProducts(candidates, offers, lookupOf = () => null) {
  return (candidates || []).map((c) => {
    const open = c.access_mode === 'public_site';
    const seen = new Set();
    const mine = (offers || []).filter((o) => o.source !== 'contracts' && o.url && o.unit_price != null && onSite(o.domain, c.site))
      .sort((a, b) => (MATCH_RANK[a.match] ?? 9) - (MATCH_RANK[b.match] ?? 9) || (a.unit_price ?? Infinity) - (b.unit_price ?? Infinity) || (b.id ?? 0) - (a.id ?? 0))
      // одна страница — один товар: выбранное предложение переживает новый поиск и находится им снова
      .filter((o) => !seen.has(o.url) && seen.add(o.url))
      .map((o) => ({
        id: o.id, title: o.title, url: o.url, unit_price: o.unit_price, match: o.match, availability: o.availability ?? null,
        stock_qty: o.stock_qty ?? null, stock_note: o.stock_note ?? null, condition: o.condition || null, too_cheap: o.too_cheap ?? null,
        confirmed: o.match_checks?.confirmed ?? null, of: o.match_checks ? (o.match_checks.of ?? o.match_checks.total) : null,
        why: o.match === 'не соответствует' ? String((o.match_notes || [])[0] || '').slice(0, 160) : null,
      }));
    // В блоке — только то, что можно покупать; неподходящий товар с этого сайта — одной строкой, с причиной.
    const products = mine.filter((p) => p.match !== 'не соответствует').slice(0, 3);
    const unfit = products.length ? null : mine.find((p) => p.match === 'не соответствует') || null;
    const look = open && !products.length ? lookupOf(c.site) : null;
    const lookup = !open ? null
      : products.length ? { status: 'found' }
        : look ? { status: look.status, models: look.models || [], reason: look.reason || null, at: look.at || null } : { status: 'pending' };
    return { ...c, open_prices: open, products, unfit, lookup };
  });
}

function createSupplierCatalog({ config, repo, clock = () => new Date() }) {
  const file = config.SUPPLIER_CANDIDATES_CONFIG || path.join(config.ROOT || path.join(__dirname, '../..'), 'config/profile-suppliers.json');
  const cache = new Map(); // файл → {stamp, data}: перечитываем, только когда файл изменился
  function document(filename, fallback) {
    if (!filename || !fs.existsSync(filename)) return fallback;
    const stat = fs.statSync(filename);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const found = cache.get(filename);
    if (found?.stamp === stamp) return found.data;
    const data = readJson(filename, fallback);
    cache.set(filename, { stamp, data });
    return data;
  }

  /** Отметка пользователя о работе с компанией. */
  function state(site) {
    try { const s = JSON.parse(repo.getSetting(`supplier_candidate:${site}`) || '{}'); return STATES.includes(s.status) ? s : {}; }
    catch { return {}; }
  }

  /** Компании каталога (все или одного направления). Цена и юрлицо здесь никогда не «подтверждены». */
  function list(direction = null) {
    const profile = document(file, {});
    return mergeCatalog(profile, document(config.STORES_CONFIG, {})).filter((r) => r.enabled !== false && (!direction || r.directions.includes(direction))).map((r) => {
      const saved = state(r.site);
      const status = saved.status || 'not_contacted';
      const mode = r.access_mode || 'unknown';
      return { ...r, status, status_label: STATE_LABELS[status], access_label: ACCESS_LABELS[mode] || ACCESS_LABELS.unknown,
        notes: r.notes || r.note || '', user_note: saved.note || '', updated_at: saved.updated_at || null,
        evidence_checked_at: r.evidence_checked_at || (r.evidence_level ? profile.checked_at : null),
        price_confirmed: false, legal_entity_verified: false, connection_verified: false,
      };
    }).sort((a, b) => (a.recommended_priority || 99) - (b.recommended_priority || 99) || String(a.name || a.site).localeCompare(String(b.name || b.site), 'ru'));
  }

  /** Кому можно отправить запрос цены по этой позиции — компании её направления (не по наличию модели). */
  function forItem(item) {
    const profile = repo.getProfile?.();
    const dirs = [...directions.loadStandard(), ...(profile?.directions || [])];
    const codes = [item.ktru_code, item.okpd2_code].filter(Boolean);
    const d = directions.pick(dirs, codes, item.name || '');
    // Ниша позиции по каталогу групп товаров (мебель, сантехника…) — у ниши свои поставщики (направление g-<группа>),
    // даже если ниша в профиле не включена. Её кандидаты добавляются к кандидатам направления.
    const niche = directions.pick(productGroups.loadGroups().map(productGroups.toDirection), codes, item.name || '');
    // Направление не определилось или позиция попала под слово-исключение (pick вернёт id: null) — кандидатов нет:
    // без этой проверки list(null) отдал бы весь каталог.
    const ids = [...new Set([d?.id, niche?.id].filter(Boolean))];
    if (!ids.length) return [];
    const seen = new Set();
    return ids.flatMap((id) => list(id)).filter((r) => !seen.has(r.site) && seen.add(r.site)).filter((r) => r.status !== 'blocked' && (!r.focus_words?.length || r.focus_words.some((w) => String(item.name).toLowerCase().includes(w.toLowerCase()))));
  }

  /** Сохранить отметку о работе с компанией. На расчёт выгодности она не влияет. */
  function update(site, input) {
    const normalized = normalizeDomain(site);
    if (!list().some((r) => r.site === normalized)) throw new Error('Поставщик не найден');
    if (!STATES.includes(input?.status) || typeof input?.note !== 'string' || input.note.length > 2000) throw new Error('Некорректный статус или заметка');
    const saved = { status: input.status, note: input.note, updated_at: clock().toISOString() };
    repo.setSetting(`supplier_candidate:${normalized}`, JSON.stringify(saved));
    return list().find((r) => r.site === normalized);
  }

  /** Черновик запроса КП по позиции: только текст. Ничего не отправляет и отметку о работе не меняет. */
  function draft(tender, item, site) {
    const candidate = forItem(item).find((r) => r.site === normalizeDomain(site));
    if (!candidate) throw new Error('Нет подходящего кандидата для позиции');
    const spec = specOf(item);
    const requirements = (spec.required || []).map((r) => `- ${r.name}: ${r.value}`).join('\n');
    const amount = item.quantity != null ? [item.quantity, item.unit].filter(Boolean).join(' ') : '';
    const subject = `Запрос КП: ${item.name}, ${amount || 'количество уточняется'}`;
    const body = [
      'Здравствуйте!', `Просим предоставить предложение по позиции «${item.name}».`,
      `Количество: ${amount || 'уточняется'}.`,
      spec.identity?.model ? `Модель/артикул из ТЗ: ${spec.identity.model}.` : 'Подбор модели: по требованиям ниже; подтвердите каждый параметр.',
      requirements ? `Обязательные требования:\n${requirements}` : 'Требования необходимо уточнить по документации закупки.',
      spec.equivalent_allowed === false ? 'Замена модели эквивалентом не допускается по извлечённой спецификации; проверьте это по документации.' : 'Если предлагаете другую модель, укажите её отдельно и приложите таблицу соответствия требованиям.',
      tender.region != null ? `Регион доставки: код региона ${tender.region}; точный адрес уточняется.` : 'Адрес доставки уточняется.',
      'Просим указать цену за единицу и за всю партию, валюту, включён ли НДС, доступное количество, склад, срок отгрузки и доставки, стоимость доставки, условия оплаты, гарантию и срок действия КП.',
      'Приложите спецификацию/паспорт, сведения о комплектации и происхождении товара и доступные подтверждающие документы. Для расходников укажите оригинальный или совместимый товар.',
      'Срок поставки и адрес должны быть согласованы по документации закупки. Запрос не является заказом или обязательством приобрести товар.',
    ].filter(Boolean).join('\n\n');
    return { supplier: candidate.name, site: candidate.site, contacts: candidate.contacts, subject, body,
      source_url: candidate.source_url, sent: false };
  }

  return { list, forItem, update, draft };
}

module.exports = { createSupplierCatalog, mergeCatalog, normalizeDomain, attachProducts, onSite, STATES };
