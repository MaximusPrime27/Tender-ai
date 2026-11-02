// Проверка продавца: ИНН со страницы, данные ЕГРЮЛ через DaData (если есть ключ), эвристики.
// Итог — доверие 0–100 с причинами простыми словами. Решение «работаем / не работаем» принимает человек.

const DADATA_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const STATUS_RU = { ACTIVE: 'действует', LIQUIDATING: 'в процессе ликвидации', LIQUIDATED: 'ликвидирована', BANKRUPT: 'банкротство', REORGANIZING: 'реорганизация' };

/** Контрольная сумма ИНН (10 цифр — организация, 12 — ИП). */
function validInn(inn) {
  const s = String(inn || '');
  const d = s.split('').map(Number);
  const check = (w) => (w.reduce((sum, k, i) => sum + k * d[i], 0) % 11) % 10;
  if (/^\d{10}$/.test(s)) return check([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  if (/^\d{12}$/.test(s)) return check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
  return false;
}

/** ИНН из текста страницы: рядом со словом «ИНН», с проверкой контрольной суммы. */
function innFromText(text) {
  for (const m of String(text || '').matchAll(/ИНН\s*[:№]?\s*(\d{10}|\d{12})(?!\d)/gi)) {
    if (validInn(m[1])) return m[1];
  }
  return null;
}

/** Запрос в DaData. Без ключа — null. TODO: проверить на реальном ключе формат ответа (поля ниже по документации). */
const yearsRu = (n) => {
  const d = n % 10, dd = n % 100;
  return `${n} ${d === 1 && dd !== 11 ? 'год' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'года' : 'лет'}`;
};

async function lookupEgrul(inn, { apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey || !validInn(inn)) return null;
  const res = await fetchImpl(DADATA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Token ${apiKey}` },
    body: JSON.stringify({ query: inn }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`DaData ответила ${res.status}`);
  const data = (await res.json())?.suggestions?.[0]?.data;
  if (!data) return { found: false };
  return {
    found: true,
    inn: data.inn,
    name: data.name?.short_with_opf || data.name?.full_with_opf || null,
    status: data.state?.status || null,
    registration_date: data.state?.registration_date ? new Date(data.state.registration_date).toISOString() : null,
    okved: data.okved || null,
    address: data.address?.value || null,
    city: data.address?.data?.city || null,
    invalid: Boolean(data.invalid),
  };
}

/**
 * Доверие к продавцу.
 * @param {{inn, egrul, price, medianPrice, hasInnOnSite, decision, now}} p
 * @returns {{trust: number, reasons: string[], verified: boolean}}
 */
function assessTrust({ inn, egrul, price, medianPrice, hasInnOnSite, decision, now = new Date(), govContracts = 0, innFromRegistry = false }) {
  if (decision === 'trusted') return { trust: 100, reasons: ['вы отметили продавца как проверенного'], verified: true };
  if (decision === 'blocked') return { trust: 0, reasons: ['вы отметили: не работаем с этим продавцом'], verified: false };
  const r = scoreTrust({ inn, egrul, price, medianPrice, hasInnOnSite, now });
  // «Проверенный»: ИНН на сайте или из реестра контрактов, действует по ЕГРЮЛ 3+ лет, уже выигрывал госконтракты.
  const years = egrul?.registration_date ? (now - new Date(egrul.registration_date)) / (365.25 * 86400000) : 0;
  const verified = Boolean(validInn(inn) && (hasInnOnSite || innFromRegistry) && egrul?.found && egrul.status === 'ACTIVE'
    && !egrul.invalid && years >= 3 && govContracts > 0);
  if (verified) r.reasons.unshift('проверенный: действует 3+ лет и уже поставлял по госконтрактам');
  return { ...r, verified };
}

function scoreTrust({ inn, egrul, price, medianPrice, hasInnOnSite, now }) {
  let trust = 50;
  const reasons = [];
  if (!inn) { trust -= 25; reasons.push('на сайте не найден ИНН продавца — нельзя проверить, кто продаёт'); }
  else if (!hasInnOnSite) { reasons.push('ИНН известен из госконтракта'); trust += 10; }
  else { trust += 10; reasons.push('ИНН указан на сайте'); }

  if (egrul?.found) {
    if (egrul.status === 'ACTIVE') { trust += 15; reasons.push('компания действует по ЕГРЮЛ'); }
    else { trust -= 60; reasons.push(`по ЕГРЮЛ: ${STATUS_RU[egrul.status] || egrul.status}`); }
    if (egrul.registration_date) {
      const years = (now - new Date(egrul.registration_date)) / (365.25 * 86400000);
      if (years < 1) { trust -= 20; reasons.push('компании меньше года'); }
      else if (years >= 3) { trust += 10; reasons.push(`работает ${yearsRu(Math.floor(years))}`); }
    }
    if (egrul.invalid) { trust -= 25; reasons.push('в ЕГРЮЛ есть отметка о недостоверности сведений'); }
  } else if (egrul && !egrul.found) {
    trust -= 30; reasons.push('ИНН не найден в ЕГРЮЛ');
  } else if (inn) {
    reasons.push('проверка по ЕГРЮЛ не выполнялась (нет ключа DaData)');
  }

  if (price != null && medianPrice) {
    const ratio = price / medianPrice;
    if (ratio < 0.6) { trust -= 20; reasons.push(`цена на ${Math.round((1 - ratio) * 100)}% ниже медианы госконтрактов — подозрительно дёшево, проверьте`); }
  }
  return { trust: Math.max(0, Math.min(100, trust)), reasons };
}

module.exports = { validInn, innFromText, lookupEgrul, assessTrust, STATUS_RU };
