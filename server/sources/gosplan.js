// Адаптер ГосПлан API (https://gosplan.info). Спецификации: docs/gosplan/fz44.swagger.yaml, fz223.swagger.yaml.
// Тестовый сервер v2test.gosplan.info работает без ключа, боевой v2.gosplan.info — с заголовком `apikey`.

const { normalizePurchase, attachmentsFrom44Notification, attachmentsFrom223Purchase } = require('./normalize');

const PAGE_SIZE = 100;
const CLASSIFIER_MAX = 5; // ограничение API ГосПлан на число кодов в одном запросе
const MIN_PUBLISHED_AFTER = new Date('2024-01-01T00:00:00Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SourceError extends Error {}

function createGosplanSource({
  baseUrl, apiKey = '', laws = ['44', '223'], maxPages = 10, delayMs = 400,
  fetchImpl = fetch, log = console, retries = 3,
}) {
  const base = baseUrl.replace(/\/+$/, '');
  let lastRequestAt = 0;

  async function request(path, params = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
    }

    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();

      let res;
      try {
        res = await fetchImpl(url, {
          headers: { Accept: 'application/json', ...(apiKey ? { apikey: apiKey } : {}) },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
        throw new SourceError(`ГосПлан недоступен (${url.host}): ${err.cause?.code || err.message}`);
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          const retryAfter = Number(res.headers.get?.('retry-after')) * 1000;
          await sleep(retryAfter || 1500 * 2 ** attempt);
          continue;
        }
      }
      const text = await res.text();
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 403
          ? ' — проверьте GOSPLAN_API_KEY (для боевого сервера нужен ключ)'
          : res.status === 422 ? ' — сервер отклонил параметры запроса' : '';
        const msg = `ГосПлан ответил ${res.status} на ${path}${hint}: ${text.slice(0, 300)}`;
        log.warn?.(msg);
        // status — чтобы вызывающий отличал «такой закупки в ГосПлане нет» (404) от сбоя сервиса
        throw Object.assign(new SourceError(msg), { status: res.status });
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new SourceError(`ГосПлан вернул не JSON на ${path}: ${text.slice(0, 200)}`);
      }
    }
  }

  /** Параметры поиска из профиля: то, что умеет фильтровать сам API. */
  function baseParams(law, profile, since) {
    const after = new Date(Math.max(new Date(since).getTime(), MIN_PUBLISHED_AFTER.getTime()));
    return {
      published_after: after.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      stage: 1, // только закупки на этапе подачи заявок
      region: profile.regions?.length ? profile.regions : undefined,
      max_price_ge: profile.price_min ?? undefined,
      max_price_le: profile.price_max ?? undefined,
      sort: 'published_at_asc',
      limit: PAGE_SIZE,
    };
  }

  /**
   * Новые закупки с момента `since`. Для каждого ключевого слова — отдельный запрос (object_info),
   * результаты объединяются без дублей. Каждая страница сразу отдаётся в onPage, чтобы сбой
   * одного запроса не терял уже загруженное; ошибка одного закона/слова не останавливает остальные.
   * @returns {Promise<{tenders: Array, requests: number, truncated: boolean, errors: string[]}>}
   */
  async function fetchNew({ profile, since, onPage = () => {}, onProgress = () => {} }) {
    const byKey = new Map();
    let requests = 0;
    let truncated = false;
    const errors = [];
    const keywords = profile.keywords?.length ? profile.keywords : [undefined];
    // ГосПлан принимает не больше 5 кодов в classifier (иначе 422) — длинное направление идёт пачками по 5.
    const codes = (profile.codes || []).filter(Boolean);
    const codeChunks = codes.length ? Array.from({ length: Math.ceil(codes.length / CLASSIFIER_MAX) }, (_, i) => codes.slice(i * CLASSIFIER_MAX, (i + 1) * CLASSIFIER_MAX)) : [undefined];

    // только виды закупок, включённые в профиле
    const wantedLaws = profile.laws?.length ? laws.filter((l) => profile.laws.map(String).includes(String(l))) : laws;
    const queries = wantedLaws.length * codeChunks.length * keywords.length;
    let qi = 0;
    for (const law of wantedLaws) {
      for (const classifier of codeChunks) for (const keyword of keywords) {
        onProgress({ done: qi++, total: queries, label: `ГосПлан, ${law}-ФЗ (${qi} из ${queries})` });
        const params = { ...baseParams(law, profile, since), classifier, object_info: keyword };
        try {
          for (let page = 0; page < maxPages; page++) {
            const items = await request(`/fz${law}/purchases`, { ...params, skip: page * PAGE_SIZE });
            requests++;
            if (!Array.isArray(items)) throw new SourceError(`Неожиданный ответ ГосПлан на /fz${law}/purchases`);
            const pageTenders = [];
            for (const raw of items) {
              if (!raw?.purchase_number) continue;
              const t = normalizePurchase(law, raw);
              if (!byKey.has(`${t.law}:${t.number}`)) pageTenders.push(t);
              byKey.set(`${t.law}:${t.number}`, t);
            }
            await onPage(pageTenders);
            if (items.length < PAGE_SIZE) break;
            if (page === maxPages - 1) truncated = true;
          }
        } catch (err) {
          errors.push(`${law}-ФЗ${classifier && codeChunks.length > 1 ? ` (коды ${classifier.join(', ')})` : ''}${keyword ? ` «${keyword}»` : ''}: ${err.message}`);
        }
      }
    }
    if (errors.length && byKey.size === 0) throw new SourceError(errors.join('; '));
    return { tenders: [...byKey.values()], requests, truncated, errors };
  }

  // извещение запоминается на 10 минут: вложения и сведения для карточки разбора — одним запросом к ГосПлану
  const noticeCache = new Map();
  async function notification44(number) {
    const hit = noticeCache.get(number);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.doc;
    const doc = await request(`/fz44/purchases/${encodeURIComponent(number)}/notification`);
    noticeCache.set(number, { at: Date.now(), doc });
    if (noticeCache.size > 200) noticeCache.delete(noticeCache.keys().next().value);
    return doc;
  }

  async function getAttachments(tender) {
    if (tender.law === '44') {
      const n = await notification44(tender.number);
      return attachmentsFrom44Notification(n);
    }
    const p = await request(`/fz223/purchases/${encodeURIComponent(tender.number)}`);
    return attachmentsFrom223Purchase(p);
  }

  /** Полные данные закупки: извещение 44-ФЗ или закупка 223-ФЗ (там позиции, обеспечения, вложения). */
  async function getDetailsDoc(tender) {
    return tender.law === '44'
      ? notification44(tender.number)
      : request(`/fz223/purchases/${encodeURIComponent(tender.number)}`);
  }

  /** Контракты 44-ФЗ за последний год с товаром данного кода КТРУ/ОКПД2. */
  async function listContracts(code, { limit = 50 } = {}) {
    const items = await request('/fz44/contracts', { classifier: code, published_forpast: '1y', limit });
    return Array.isArray(items) ? items : [];
  }

  const getContract = (regNum) => request(`/fz44/contracts/${encodeURIComponent(regNum)}`);

  /** Контракты по номеру закупки 44-ФЗ — итог торгов: цена, с которой заключили контракт (агент заявок учится на них). */
  async function contractsByPurchase(purchaseNumber) {
    const items = await request('/fz44/contracts', { purchase_number: purchaseNumber, limit: 5 });
    return Array.isArray(items) ? items : [];
  }

  async function getPurchaseMaxPrice(purchaseNumber) {
    const items = await request('/fz44/purchases', { purchase_number: purchaseNumber, limit: 1 });
    const p = Array.isArray(items) ? items[0] : null;
    return p?.max_price ? Number(p.max_price) : null;
  }

  return { name: 'gosplan', laws, fetchNew, getAttachments, getDetailsDoc, listContracts, getContract, contractsByPurchase, getPurchaseMaxPrice, request };
}

module.exports = { createGosplanSource, SourceError };
