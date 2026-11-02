// Источник без сети: читает сохранённые ответы ГосПлан API из samples/tenders/.
//   fz44-purchases.json, fz223-purchases.json      — списки закупок (как /fz44/purchases)
//   fz44-notification-<номер>.json                  — извещения 44-ФЗ (вложения)
//   fz223-purchase-<номер>.json                     — полные закупки 223-ФЗ (вложения)
//   synthetic.json                                  — {"44": [...], "223": [...]} синтетические закупки для тестов

const fs = require('node:fs');
const path = require('node:path');
const { normalizePurchase, attachmentsFrom44Notification, attachmentsFrom223Purchase } = require('./normalize');

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function createFixtureSource({ dir, laws = ['44', '223'] }) {
  function load(law) {
    const list = readJson(path.join(dir, `fz${law}-purchases.json`)) || [];
    const synthetic = readJson(path.join(dir, 'synthetic.json'))?.[law] || [];
    return [...list, ...synthetic].map((raw) => normalizePurchase(law, raw));
  }

  async function fetchNew({ profile, onPage = () => {} }) {
    const tenders = [];
    for (const law of laws) {
      // Имитируем серверные фильтры API, чтобы поведение совпадало с боевым источником.
      for (const t of load(law)) {
        if (profile.regions?.length && !profile.regions.includes(t.region)) continue;
        if (profile.price_min != null && t.price != null && t.price < profile.price_min) continue;
        if (profile.price_max != null && t.price != null && t.price > profile.price_max) continue;
        if (profile.codes?.length && ![...t.okpd2, ...t.ktru].some((c) => profile.codes.some((p) => c.startsWith(p)))) continue;
        if (profile.keywords?.length && !profile.keywords.some((k) => t.title.toLowerCase().includes(k.toLowerCase()))) continue;
        tenders.push(t);
      }
    }
    await onPage(tenders);
    return { tenders, requests: 0, truncated: false, errors: [] };
  }

  async function getAttachments(tender) {
    if (tender.law === '44') {
      return attachmentsFrom44Notification(readJson(path.join(dir, `fz44-notification-${tender.number}.json`)));
    }
    return attachmentsFrom223Purchase(readJson(path.join(dir, `fz223-purchase-${tender.number}.json`)));
  }

  async function getDetailsDoc(tender) {
    return tender.law === '44'
      ? readJson(path.join(dir, `fz44-notification-${tender.number}.json`))
      : readJson(path.join(dir, `fz223-purchase-${tender.number}.json`));
  }

  //   fz44-contracts-<код>.json  — список контрактов (как /fz44/contracts?classifier=<код>)
  //   fz44-contract-<reg_num>.json — полный контракт
  async function listContracts(code) {
    return readJson(path.join(dir, `fz44-contracts-${code}.json`)) || [];
  }

  async function getContract(regNum) {
    const c = readJson(path.join(dir, `fz44-contract-${regNum}.json`));
    if (!c) throw new Error(`нет фикстуры контракта ${regNum}`);
    return c;
  }

  //   fz44-purchase-<номер>.json — ответ /fz44/purchases?purchase_number=<номер>
  async function getPurchaseMaxPrice(purchaseNumber) {
    const single = readJson(path.join(dir, `fz44-purchase-${purchaseNumber}.json`));
    if (Array.isArray(single) && single[0]?.max_price) return Number(single[0].max_price);
    const all = [...(readJson(path.join(dir, 'fz44-purchases.json')) || []), ...(readJson(path.join(dir, 'synthetic.json'))?.['44'] || [])];
    const p = all.find((x) => x.purchase_number === purchaseNumber);
    return p?.max_price ?? null;
  }

  return { name: 'fixture', fetchNew, getAttachments, getDetailsDoc, listContracts, getContract, getPurchaseMaxPrice };
}

module.exports = { createFixtureSource };
