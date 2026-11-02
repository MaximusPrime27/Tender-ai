// Приведение закупок 44-ФЗ и 223-ФЗ из ГосПлан API к одной внутренней модели.
// Поля — по спецификациям docs/gosplan/*.swagger.yaml и реальным ответам v2test.gosplan.info.

/**
 * Даты в ответах API приходят без часового пояса. По сравнению с doc_created_at и типичным
 * временем окончания подачи заявок (08:00 МСК = 05:00 UTC) у 44-ФЗ время в UTC, а у 223-ФЗ — московское.
 * TODO: подтвердить у ГосПлана; при расхождении поправить смещения здесь.
 */
const TZ_OFFSET = { 44: 'Z', 223: '+03:00' };

function toIso(value, law) {
  if (!value) return null;
  const s = String(value);
  const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + TZ_OFFSET[law];
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function eisUrl(law, number) {
  return law === '44'
    ? `https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=${encodeURIComponent(number)}`
    : `https://zakupki.gov.ru/epz/order/notice/notice223/common-info.html?regNumber=${encodeURIComponent(number)}`;
}

/** @param {'44'|'223'} law @param raw элемент списка /fz44/purchases или /fz223/purchases */
function normalizePurchase(law, raw) {
  const number = String(raw.purchase_number);
  const customer = law === '44' ? arr(raw.customers)[0] : raw.customer;
  return {
    law,
    number,
    title: String(raw.object_info || '').replace(/\s+/g, ' ').trim(),
    price: raw.max_price == null ? null : Number(raw.max_price),
    currency: raw.currency_code || 'RUB',
    region: raw.region == null ? null : Number(raw.region),
    okpd2: arr(raw.okpd2).map(String),
    ktru: arr(raw.ktru).map(String),
    customer_inn: customer ? String(customer) : null,
    published_at: toIso(raw.published_at, law),
    deadline_at: toIso(law === '44' ? raw.collecting_finished_at : raw.submission_close_at, law),
    stage: raw.stage ?? null,
    eis_url: eisUrl(law, number),
    raw_json: raw,
  };
}

/**
 * Вложения закупки.
 * 44-ФЗ: извещение /fz44/purchases/{n}/notification → source.attachmentsInfo.attachmentInfo[]
 * 223-ФЗ: закупка /fz223/purchases/{n} → docs[].source.attachments.document (объект или массив)
 */
function attachmentsFrom44Notification(notification) {
  const info = notification?.source?.attachmentsInfo?.attachmentInfo;
  return arr(info)
    .filter((a) => a && a.url && a.fileName)
    .map((a) => ({ fileName: String(a.fileName), url: String(a.url), description: a.docDescription || null }));
}

function attachmentsFrom223Purchase(purchase) {
  const seen = new Set();
  const out = [];
  for (const doc of arr(purchase?.docs)) {
    for (const a of arr(doc?.source?.attachments?.document)) {
      if (!a?.url || !a?.fileName || seen.has(a.url)) continue;
      seen.add(a.url);
      out.push({ fileName: String(a.fileName), url: String(a.url), description: a.description || null });
    }
  }
  return out;
}

module.exports = { normalizePurchase, attachmentsFrom44Notification, attachmentsFrom223Purchase, eisUrl, toIso };
