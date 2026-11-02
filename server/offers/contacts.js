// Контакты поставщика: телефоны, почта, сайт, страница «Контакты».
// Источники: страница товара и страница «Контакты» на сайте продавца; карточка контракта в ЕИС (там у поставщика
// указаны телефон и почта). Нужны, чтобы сразу позвонить или написать поставщику, а не искать его заново.

/** Телефон в виде +7 (XXX) XXX-XX-XX; null — если это не похоже на российский номер. */
function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) d = `7${d}`;
  if (d.length !== 11 || !/^[78]/.test(d)) return null;
  d = `7${d.slice(1)}`;
  if (/^7(\d)\1{9}$/.test(d) || /^7(0000000|1234567)/.test(d)) return null; // 7 000 000-00-00 и прочие заглушки
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`;
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,10}/gi;
const EMAIL_ONE = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,10}$/i;
// Почта не продавца: сервисы, заглушки, картинки с «@2x».
const junkEmail = (e) => /\.(png|jpe?g|gif|svg|webp)$|@(sentry|example|domain|email|mail)\.|wixpress|^(noreply|no-reply|donotreply)@|@\d+x/i.test(e);

const uniq = (list) => [...new Set(list.filter(Boolean))];

/**
 * Контакты со страницы сайта.
 * @returns {{phones: string[], emails: string[], contacts_url: string|null}}
 */
function extractContacts(html, pageUrl) {
  const src = String(html || '');
  const phones = [];
  // Самые надёжные — ссылки tel: и разметка schema.org; затем номера в тексте страницы.
  for (const m of src.matchAll(/href=["']tel:([^"']+)["']/gi)) phones.push(normPhone(decodeURIComponent(m[1])));
  for (const m of src.matchAll(/"telephone"\s*:\s*"([^"]+)"/gi)) phones.push(normPhone(m[1]));
  const text = src.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  for (const m of text.matchAll(/(?<!\d)(?:\+7|8)[\s(-]{0,3}\d{3}[\s)-]{0,3}\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g)) phones.push(normPhone(m[0]));

  const emails = [];
  for (const m of src.matchAll(/href=["']mailto:([^"'?]+)/gi)) emails.push(decodeURIComponent(m[1]).trim().toLowerCase());
  for (const m of src.matchAll(/"email"\s*:\s*"([^"]+)"/gi)) emails.push(m[1].trim().toLowerCase());
  for (const m of text.matchAll(EMAIL_RE)) emails.push(m[0].toLowerCase());

  // Ссылка на страницу «Контакты» — по тексту ссылки или адресу.
  let contactsUrl = null;
  for (const m of src.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const label = m[2].replace(/<[^>]+>/g, ' ');
    if (!/контакт/i.test(label) && !/(^|\/)(contacts?|kontakty?|about\/contacts?)(\/|\.|$|\?)/i.test(m[1])) continue;
    if (/^(mailto|tel|javascript):/i.test(m[1])) continue;
    try {
      const u = new URL(m[1], pageUrl);
      if (pageUrl && u.hostname.replace(/^www\./, '') !== new URL(pageUrl).hostname.replace(/^www\./, '')) continue;
      contactsUrl = u.href;
      break;
    } catch { /* кривая ссылка */ }
  }
  return {
    phones: uniq(phones).slice(0, 3),
    emails: uniq(emails.filter((e) => EMAIL_ONE.test(e) && !junkEmail(e))).slice(0, 2),
    contacts_url: contactsUrl,
  };
}

/** Телефон и почта поставщика из карточки контракта ЕИС (suppliersInfo.supplierInfo). */
function contactsFromContractSupplier(sup) {
  const entity = sup?.legalEntityRF || sup?.individualPersonRFIndEntr || sup?.individualPersonRF || sup?.legalEntityForeignState || {};
  const other = entity.otherInfo || sup?.otherInfo || {};
  const phone = normPhone(other.contactPhone || entity.contactPhone);
  const email = String(other.contactEMail || entity.contactEMail || '').trim().toLowerCase();
  return { phone, email: email && !junkEmail(email) && /@/.test(email) ? email : null };
}

/** Объединяет контакты из нескольких источников без повторов. */
function mergeContacts(...parts) {
  const out = { phones: [], emails: [], site: null, contacts_url: null };
  for (const p of parts) {
    if (!p) continue;
    out.phones.push(...(p.phones || []), p.phone);
    out.emails.push(...(p.emails || []), p.email);
    out.site = out.site || p.site || null;
    out.contacts_url = out.contacts_url || p.contacts_url || null;
  }
  out.phones = uniq(out.phones).slice(0, 3);
  out.emails = uniq(out.emails).slice(0, 2);
  return out;
}

// Бесплатные почтовые сервисы: по такой почте сайт поставщика не определить.
const PUBLIC_MAIL = /^(yandex|ya|mail|bk|list|inbox|internet|rambler|gmail|googlemail|outlook|hotmail|icloud|yahoo|live|me|ro|lenta|autorambler|myrambler|narod|qip|pochta|sibmail|tut|ngs|e1|km|ukr|aol|protonmail|proton)\.[a-z.]+$/i;

/** Домен сайта поставщика: из ссылки на сайт или из почты на собственном домене. */
function ownDomainOf(c) {
  if (c?.site) { try { return new URL(c.site).hostname.replace(/^www\./, ''); } catch { /* кривая ссылка */ } }
  return (c?.emails || []).map((e) => String(e).split('@')[1]?.toLowerCase()).find((d) => d && !PUBLIC_MAIL.test(d)) || null;
}

const hasContacts = (c) => Boolean(c && ((c.phones || []).length || (c.emails || []).length));

module.exports = { ownDomainOf, extractContacts, contactsFromContractSupplier, mergeContacts, normPhone, hasContacts };
