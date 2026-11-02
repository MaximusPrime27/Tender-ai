// Рыночный ориентир по прошлым госконтрактам на такой же товар (ГосПлан /fz44/contracts):
// цена за единицу (медиана, минимум, 25-й перцентиль), типичное снижение цены на торгах
// и поставщики, которые уже выигрывали такие контракты.

const { parseCharacteristics } = require('./items');

const { contactsFromContractSupplier } = require('../offers/contacts');

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)) * 100) / 100;
}

/** Совпадает ли товар из контракта с кодом позиции (КТРУ — точно, ОКПД2 — по началу кода). */
function productMatches(product, code) {
  const ktru = product?.KTRU?.code;
  const okpd = product?.OKPD2?.OKPDCode || product?.OKPD2?.code;
  if (code === '*') return true; // все товары контракта (итог торгов: чей товар победил)
  if (!code) return false;
  if (code.includes('-')) return ktru === code; // код КТРУ — только точное совпадение
  return Boolean((ktru && ktru.startsWith(code)) || (okpd && okpd.startsWith(code)));
}

/**
 * Разбор полного контракта (ответ /fz44/contracts/{reg_num}): строки нужного товара и поставщик.
 * @returns {{reg_num, purchase_number, date, price, lines: [{name, unit_price, quantity}], supplier: {inn, name, address}|null}}
 */
function parseContract(contract, code) {
  const src = arr(contract?.docs).map((d) => d.source).find((s) => s?.products) || {};
  const lines = arr(src.products?.product)
    .filter((p) => productMatches(p, code))
    .map((p) => ({
      name: String(p.name || p.KTRU?.name || ''),
      unit_price: num(p.price) == null ? null : Math.round(num(p.price) * 100) / 100,
      quantity: num(p.quantity),
      // Единица из контракта (код ОКЕИ или название) — чтобы пересчитать цену в единицу заказчика.
      unit: p.OKEI?.nationalCode || p.OKEI?.name || p.OKEI?.code || null,
      // Характеристики товара по каталогу КТРУ — по ним сверяется «тот же ли это товар», что в ТЗ.
      chars: p.KTRU?.characteristics ? parseCharacteristics(p.KTRU.characteristics).slice(0, 25).map((c) => `${c.name}: ${c.value}`).join('; ') : '',
      // страна происхождения поставленного товара (643 — Россия): по ней видно, побеждает ли импорт при нацрежиме
      origin: p.originCountry?.countryCode ? String(p.originCountry.countryCode) : null,
    }))
    .filter((l) => l.unit_price != null && l.unit_price > 0);
  const sup = arr(src.suppliersInfo?.supplierInfo)[0];
  // Поставщик — юрлицо (ЕГРЮЛ) или предприниматель (ЕГРИП: ФИО вместо названия).
  const ip = sup?.individualPersonRFIndEntr?.EGRIPInfo || null;
  const egrul = sup?.legalEntityRF?.EGRULInfo || ip || sup?.individualPersonRF || null;
  const ipName = ip ? `ИП ${[ip.lastName, ip.firstName, ip.middleName].filter(Boolean).join(' ')}`.trim() : null;
  // Телефон и почта поставщика указаны в карточке контракта — по ним с ним можно связаться.
  const contact = contactsFromContractSupplier(sup);
  const supplier = egrul
    ? { inn: egrul.INN || egrul.inn || null, name: egrul.shortName || egrul.fullName || (ipName && ipName !== 'ИП' ? ipName : null), address: egrul.address || null, phone: contact.phone, email: contact.email }
    : (contract?.suppliers?.[0] ? { inn: contract.suppliers[0], name: null, address: null, phone: contact.phone, email: contact.email } : null);
  // Закупка у единственного поставщика: торгов не было, снижение цены по ней не показательно.
  const singleSupplier = Boolean(src.foundation?.fcsOrder?.order?.singleCustomer || src.foundation?.notOversightOrder);
  return {
    single_supplier: singleSupplier,
    reg_num: contract?.reg_num || null,
    purchase_number: contract?.purchase_number || null,
    date: contract?.published_at || null,
    region: contract?.region ?? null,
    price: num(contract?.price),
    lines,
    supplier,
  };
}

/**
 * Чей товар побеждал: доля контрактов с иностранным товаром и цены российского и иностранного. При нацрежиме
 * (ограничение допуска) иностранная заявка проходит, только если российских нет — эта доля показывает, как часто так бывает.
 */
function originStats(parsed) {
  const rows = parsed.filter((c) => c.lines.length && !c.single_supplier).map((c) => ({ origin: c.lines[0].origin, price: c.lines[0].unit_price }));
  const known = rows.filter((r) => r.origin);
  if (!known.length) return null;
  const ru = known.filter((r) => r.origin === '643');
  const foreign = known.filter((r) => r.origin !== '643');
  const med = (a) => (a.length ? percentile(a.map((r) => r.price).sort((x, y) => x - y), 0.5) : null);
  return { contracts: known.length, russian: ru.length, foreign: foreign.length, foreign_share: Math.round((foreign.length / known.length) * 100) / 100, price_russian: med(ru), price_foreign: med(foreign) };
}

/**
 * Статистика по разобранным контрактам.
 * @param parsed результаты parseContract
 * @param declines доли снижения цены (0.12 = 12%) по контрактам, где известна НМЦК закупки
 */
function computeBenchmark(parsed, declines = []) {
  const prices = parsed.flatMap((c) => c.lines.map((l) => l.unit_price)).sort((a, b) => a - b);
  const d = declines.filter((x) => x >= 0 && x < 0.9).sort((a, b) => a - b);
  const suppliers = [];
  for (const c of parsed) {
    if (!c.supplier || !c.lines.length) continue;
    suppliers.push({
      inn: c.supplier.inn, name: c.supplier.name, address: c.supplier.address, phone: c.supplier.phone ?? null, email: c.supplier.email ?? null,
      unit_price: c.lines[0].unit_price, quantity: c.lines[0].quantity,
      date: c.date, region: c.region, reg_num: c.reg_num,
    });
  }
  // Строки контрактов с наименованием товара: по ним отбирается «тот же товар», что в ТЗ (этап 6b).
  const lines = [];
  for (const c of parsed) {
    for (const l of c.lines) {
      lines.push({
        name: l.name, chars: l.chars || '', unit_price: l.unit_price, quantity: l.quantity, unit: l.unit ?? null, origin: l.origin ?? null, reg_num: c.reg_num, date: c.date, region: c.region,
        supplier_inn: c.supplier?.inn ?? null, supplier_name: c.supplier?.name ?? null, supplier_address: c.supplier?.address ?? null,
        supplier_phone: c.supplier?.phone ?? null, supplier_email: c.supplier?.email ?? null,
      });
    }
  }
  return {
    contracts: parsed.filter((c) => c.lines.length).length,
    lines: lines.slice(0, 120),
    unit_price: prices.length ? {
      min: prices[0], p25: percentile(prices, 0.25), median: percentile(prices, 0.5), max: prices[prices.length - 1],
    } : null,
    decline: d.length ? { median: percentile(d, 0.5), samples: d.length } : null,
    origin: originStats(parsed),
    suppliers: suppliers.sort((a, b) => a.unit_price - b.unit_price).slice(0, 15),
  };
}

/**
 * Загружает ориентир через источник (методы listContracts, getContract, getPurchaseMaxPrice).
 * @returns {Promise<{code, fetched_at, contracts, unit_price, decline, suppliers, error?}>}
 */
async function fetchBenchmark(source, code, { maxContracts = 15, declineSamples = 5 } = {}) {
  const base = { code, fetched_at: new Date().toISOString() };
  if (!code) return { ...base, contracts: 0, unit_price: null, decline: null, suppliers: [], error: 'у позиции нет кода КТРУ/ОКПД2' };
  if (!source.listContracts) return { ...base, contracts: 0, unit_price: null, decline: null, suppliers: [], error: 'источник не умеет искать контракты' };
  const list = (await source.listContracts(code)).slice(0, maxContracts);
  const parsed = [];
  for (const c of list) {
    try {
      parsed.push(parseContract(await source.getContract(c.reg_num), code));
    } catch {
      // один недоступный контракт не мешает остальным
    }
  }
  const declines = [];
  for (const c of parsed.filter((x) => x.purchase_number && x.price && !x.single_supplier).slice(0, declineSamples)) {
    try {
      const max = await source.getPurchaseMaxPrice(c.purchase_number);
      if (max) declines.push(1 - c.price / max);
    } catch {
      // нет данных о закупке — снижение по этому контракту не считаем
    }
  }
  return { ...base, ...computeBenchmark(parsed, declines) };
}

module.exports = { parseContract, computeBenchmark, fetchBenchmark, percentile, productMatches };
