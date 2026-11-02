// Факты закупки из извещения ЕИС (структурированные данные — через ГосПлан) для карточки разбора документации:
// номер, закон, способ, сроки, обеспечения, нацрежим по позициям, преимущества. Это официальные сведения самой
// закупки — их не нужно искать в документах нейросетью. В карточке такие поля помечены «из извещения ЕИС».
//
// Нацрежим (ПП РФ № 1875) — по отметкам у каждой позиции (restrictionsInfo): запрет, ограничение, преимущество
// российским товарам и причина, по которой запрет не применяется. Отметок нет ни у одной позиции — мер в извещении нет.

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const yes = (v) => v === true || v === 'true';
const ru = (iso, withTime = true) => {
  if (!iso) return null;
  // дата без времени, как в ЕИС: «2026-10-26+03:00» — Date такую строку не разбирает
  const day = /^(\d{4})-(\d{2})-(\d{2})(?:[+-]\d{2}:\d{2}|Z)?$/.exec(String(iso));
  if (day) return `${day[3]}.${day[2]}.${day[1]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}), timeZone: 'Europe/Moscow' }) + (withTime ? ' (мск)' : '');
};
const money = (n) => `${Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} руб.`;

/** Нацрежим по отметкам позиций 44-ФЗ: текст для карточки и сводка по видам мер. */
function nationalRegime44(objects) {
  const rows = objects.map((o) => ({ name: String(o.name || o.KTRU?.name || 'позиция'), r: o.restrictionsInfo || null }));
  const marked = rows.filter((x) => x.r);
  if (!rows.length || !marked.length) return null; // в извещении нет отметок — судить не по чему
  const kinds = (r) => [yes(r.isProhibitionForeignPurchaseObjects) && 'запрет', yes(r.isRestrictForeignPurchaseObjects) && 'ограничение', yes(r.isPreferenseRFPurchaseObjects) && 'преимущество'].filter(Boolean);
  const groups = new Map();
  for (const x of marked) {
    const k = kinds(x.r).join(' + ') || 'нет';
    const reason = yes(x.r.isImposibilityProhibition) ? String(x.r.reasonImposibilityProhibition || '').replace(/\s+/g, ' ').split(/[,«"]/)[0].trim() : '';
    const key = `${k}|${reason}`;
    if (!groups.has(key)) groups.set(key, { k, reason, names: [] });
    groups.get(key).names.push(x.name);
  }
  const MEANING = {
    запрет: 'запрет допуска иностранных товаров',
    ограничение: 'ограничение допуска иностранных товаров: заявки с иностранным товаром отклоняются, если есть хотя бы одна заявка с российским',
    преимущество: 'преимущество российским товарам при оценке цены',
  };
  const parts = [...groups.values()].map((g) => {
    const who = groups.size === 1 && g.names.length === rows.length ? 'для всех позиций' : `для позиций: ${g.names.slice(0, 4).join('; ')}${g.names.length > 4 ? ` и ещё ${g.names.length - 4}` : ''}`;
    const what = g.k === 'нет' ? 'мер нет' : g.k.split(' + ').map((x) => MEANING[x]).join('; ');
    return `${what} — ${who}${g.reason ? `. Запрет не применяется: ${g.reason}` : ''}`;
  });
  const measures = [...new Set([...groups.values()].flatMap((g) => (g.k === 'нет' ? [] : g.k.split(' + '))))];
  return { text: `${measures.length ? 'Национальный режим (ПП РФ № 1875): ' : 'В извещении мер национального режима нет: '}${parts.join('. ')}`, measures };
}

/**
 * @param tender закупка из базы (номер, закон, срок, цена, ссылка)
 * @param doc извещение 44-ФЗ из источника (или null)
 * @returns {{facts: Object<key, string>, measures: string[], preferences: string[], eis_url: string|null}}
 *   facts — значения полей карточки (ключи как в analyze/fields.js)
 */
function noticeFacts(tender, doc) {
  const facts = {};
  if (tender?.number) facts.notice_number = String(tender.number);
  if (tender?.law) facts.law = String(tender.law) === 'com' ? 'коммерческая закупка' : `${tender.law}-ФЗ`;
  if (tender?.price != null) facts.nmck = money(tender.price);
  if (tender?.deadline_at) facts.bid_deadline = ru(tender.deadline_at);
  const out = { facts, measures: [], preferences: [], eis_url: tender?.eis_url || null };
  const src = doc?.source;
  if (!src || String(tender?.law) !== '44') return out;
  const ni = src.notificationInfo || {};
  const way = src.commonInfo?.placingWay?.name;
  if (way) facts.procurement_method = String(way);
  // аукцион и запрос котировок: победитель — наименьшая цена, критериев оценки заявок нет (конкурс — критерии в документах)
  if (/аукцион|котиров/i.test(String(way || ''))) facts.evaluation_criteria = `не применяются: ${String(way).toLowerCase()} — побеждает наименьшая цена`;
  const org = src.purchaseResponsibleInfo?.responsibleOrgInfo;
  const custInn = arr(src.notificationInfo?.customerRequirementsInfo?.customerRequirementInfo)[0]?.customer?.INN || org?.INN;
  const custName = arr(src.notificationInfo?.customerRequirementsInfo?.customerRequirementInfo)[0]?.customer?.fullName || org?.fullName;
  if (custName) facts.customer = `${String(custName)}${custInn ? `, ИНН ${custInn}` : ''}`;
  const subject = src.commonInfo?.purchaseObjectInfo;
  if (subject) facts.subject = String(subject);
  const cur = src.notificationInfo?.contractConditionsInfo?.maxPriceInfo?.currency?.name;
  if (cur) facts.currency = /рубл/i.test(cur) ? 'российский рубль' : String(cur);
  const proc = ni.procedureInfo || {};
  if (proc.collectingInfo?.endDT) facts.bid_deadline = ru(proc.collectingInfo.endDT);
  const results = [proc.biddingDate && `торги (аукцион) — ${ru(proc.biddingDate, false)}`, proc.summarizingDate && `подведение итогов — ${ru(proc.summarizingDate, false)}`].filter(Boolean);
  if (results.length) facts.results_date = results.join('; ');
  const req = arr(ni.customerRequirementsInfo?.customerRequirementInfo)[0];
  const max = Number(ni.contractConditionsInfo?.maxPriceInfo?.maxPrice ?? tender?.price);
  const sec = (g) => {
    if (!g) return null;
    const amount = g.amount != null ? Number(g.amount) : g.part != null && max > 0 ? (max * Number(g.part)) / 100 : null;
    return g.part != null ? `${g.part}%${amount != null ? ` — ${money(amount)}` : ''}` : amount != null ? money(amount) : null;
  };
  if (req) {
    facts.bid_security = sec(req.applicationGuarantee) || 'не требуется';
    facts.contract_security = sec(req.contractGuarantee) ? `${sec(req.contractGuarantee)} от цены контракта` : 'не требуется';
  }
  const objects = arr(ni.purchaseObjectsInfo?.notDrugPurchaseObjectsInfo?.purchaseObject ?? ni.purchaseObjectsInfo?.purchaseObject);
  // место поставки — из извещения: в документах его ищут правилами, но официальное значение здесь
  const place = require('./customer').deliveryPlace44(req?.contractConditionsInfo?.deliveryPlacesInfo);
  if (place) facts.delivery_place = place;
  const nr = nationalRegime44(objects);
  if (nr) { facts.national_regime = nr.text; out.measures = nr.measures; }
  out.preferences = arr(ni.preferensesInfo?.preferenseInfo).map((p) => p?.preferenseRequirementInfo?.name).filter(Boolean).map(String);
  return out;
}

module.exports = { noticeFacts, nationalRegime44 };
