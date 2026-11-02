// Заказчик закупки: организация, контактное лицо и место поставки — из извещения 44-ФЗ или закупки 223-ФЗ.
//
// Нужно для письма заказчику (адресат — ФИО контактного лица) и для итоговой страницы закупки (куда поставляем).
// Чего в извещении нет, того нет и здесь: пустые поля не заполняются догадками.

const text = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));

/** «ХРАМОВА» → «Храмова»: в извещениях фамилии часто заглавными. Инициалы («И.») не трогаем. */
const nameCase = (s) => { const t = text(s); return t && t.length > 2 && t === t.toUpperCase() ? t[0] + t.slice(1).toLowerCase() : t; };

function personOf({ lastName, firstName, middleName } = {}) {
  const last = nameCase(lastName); const first = nameCase(firstName); const middle = nameCase(middleName);
  const full = [last, first, middle].filter(Boolean).join(' ');
  return full ? clean({ person: full, first_name: first, middle_name: middle }) : {};
}

/** Место поставки из извещения 44-ФЗ: адрес строкой, иначе адрес по ГАР; несколько мест — через «;». */
function deliveryPlace44(info) {
  const places = [].concat(info || []).flatMap((p) => [].concat(p?.byGARInfo || p || []));
  const out = places.map((p) => text(p?.deliveryPlace) || text(p?.GARInfo?.GARAddress)).filter(Boolean);
  return out.length ? [...new Set(out)].join('; ') : null;
}

function customerFrom44(doc) {
  const src = doc?.source || doc || {};
  const resp = src.purchaseResponsibleInfo || {};
  const info = resp.responsibleInfo || {};
  const req = [].concat(src.notificationInfo?.customerRequirementsInfo?.customerRequirementInfo || [])[0] || {};
  const org = text(req.customer?.fullName) || text(resp.responsibleOrgInfo?.fullName);
  const placer = text(resp.responsibleOrgInfo?.fullName);
  return clean({
    org,
    // закупку за заказчика может размещать уполномоченный орган — контактное лицо тогда его
    placer: placer && placer !== org ? placer : null,
    ...personOf(info.contactPersonInfo),
    email: text(info.contactEMail), phone: text(info.contactPhone),
    address: text(info.orgFactAddress) || text(info.orgPostAddress) || text(resp.responsibleOrgInfo?.factAddress),
    delivery_place: deliveryPlace44(req.contractConditionsInfo?.deliveryPlacesInfo),
  });
}

function customerFrom223(doc) {
  const docs = Array.isArray(doc?.docs) ? doc.docs : [doc];
  // берём последнюю редакцию извещения, в которой есть сведения
  let src = null;
  for (const d of docs) if (d?.source && (d.source.contact || d.source.customer)) src = d.source;
  if (!src) return {};
  const main = src.customer?.mainInfo || {};
  const lot = [].concat(src.lots?.lot || [])[0];
  const place = text(lot?.lotData?.deliveryPlace?.address);
  return clean({
    org: text(main.fullName) || text(main.shortName),
    ...personOf(src.contact),
    email: text(src.contact?.email) || text(main.email), phone: text(src.contact?.phone) || text(main.phone),
    address: text(main.postalAddress) || text(main.legalAddress),
    // «согласно закупочной документации» — это не адрес
    delivery_place: place && !/согласно|в соответствии с/i.test(place) ? place : null,
  });
}

/**
 * Сведения о заказчике из полных данных закупки.
 * @returns {{org?, placer?, person?, first_name?, middle_name?, email?, phone?, address?, delivery_place?}} пусто — данных нет
 */
function customerFromDoc(tender, doc) {
  if (!doc || typeof doc !== 'object') return {};
  // коммерческая площадка отдаёт документ в нашем формате: заказчика может назвать сама
  if (doc.customer && typeof doc.customer === 'object' && !doc.source && !doc.docs) return clean(doc.customer);
  return String(tender?.law) === '44' ? customerFrom44(doc) : customerFrom223(doc);
}

module.exports = { customerFromDoc, customerFrom44, customerFrom223, deliveryPlace44 };
