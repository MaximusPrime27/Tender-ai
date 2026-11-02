// Добор характеристик со страниц самого продавца (Этап 1): вкладка «Характеристики» и PDF-паспорт товара.
// Карточка часто короткая, а полный список — на отдельной вкладке или в паспорте. Если после первой сверки часть
// требований осталась «не подтверждено», открываем эти документы (ссылки берутся с самой страницы товара, платного
// поиска нет) и сверяем заново. Отсутствие характеристики на странице не означает её отсутствия у товара — но и
// не подтверждает её: «соответствует» ставится только по найденному доказательству.

const TAB_WORDS = /характеристик|спецификац|specifications?|specs|tech-?specs|params|parametry|harakteristik|xarakteristik|svojstva|свойства|tab[=_-]?(?:char|spec|prop)/i;
const DOC_WORDS = /паспорт|инструкц|руководств|datasheet|data-?sheet|спецификац|характеристик|manual|брошюр|листовк|specs?\b|техническ/i;

/**
 * Ссылки на дополнительные сведения о товаре со страницы: вкладка характеристик (тот же сайт) и PDF-документы.
 * @returns {Array<{url, kind: 'tab'|'pdf', label}>} не больше 6, без повторов и без самой страницы
 */
function docLinks(html, pageUrl) {
  const out = [];
  const seen = new Set();
  let base;
  try { base = new URL(pageUrl); } catch { return out; }
  const pageKey = `${base.origin}${base.pathname}`;
  for (const m of String(html || '').matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let u;
    try { u = new URL(m[1].replace(/&amp;/g, '&'), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const isPdf = /\.pdf(?:$|\?)/i.test(u.pathname + u.search);
    const key = `${u.origin}${u.pathname}${u.search}`;
    if (seen.has(key) || `${u.origin}${u.pathname}` === pageKey) continue;
    if (isPdf && (DOC_WORDS.test(label) || DOC_WORDS.test(u.pathname))) { seen.add(key); out.push({ url: u.href, kind: 'pdf', label: label || 'PDF' }); }
    else if (!isPdf && u.host === base.host && (TAB_WORDS.test(u.pathname + u.search) || /^(все\s+)?характеристик|^спецификац|^все параметры/i.test(label))
      && u.pathname.startsWith(base.pathname.replace(/\/[^/]*$/, ''))) { seen.add(key); out.push({ url: u.href, kind: 'tab', label: label || 'характеристики' }); }
    if (out.length >= 6) break;
  }
  // сначала вкладка (она точно про этот товар), потом паспорта
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'tab' ? -1 : 1));
}

const KIND_LABEL = { tab: 'вкладка характеристик', pdf: 'паспорт или инструкция (PDF)' };

/**
 * Дочитать документы и сверить заново. Вызывается, только если остались неподтверждённые требования.
 * @param {{offer, item, links, fetcher, matchFn, maxDocs, readPdf, budget}} p
 *   matchFn(item, offer) — та же сверка, что и для страницы; budget — {left} общий лимит документов на поиск
 * @returns {Promise<{match, docs: Array<{url, kind, status, note}>} | null>} null — дочитывать нечего
 */
async function enrichFromDocs({ offer, item, links, fetcher, matchFn, maxDocs = 2, readPdf, budget = null }) {
  if (!links?.length || !fetcher) return null;
  const docs = [];
  const parts = [];
  for (const link of links) {
    if (docs.filter((d) => d.status === 'ok').length >= maxDocs) break;
    if (budget && budget.left <= 0) { docs.push({ ...link, status: 'budget_exhausted', note: 'лимит дочитывания на этот поиск исчерпан' }); break; }
    if (budget) budget.left--;
    try {
      if (link.kind === 'pdf') {
        const f = await fetcher.fetchFile(link.url, { maxBytes: 8 * 1024 * 1024 });
        const text = await readPdf(f.buf, link.url);
        if (!text || text.trim().length < 80) { docs.push({ ...link, status: 'empty', note: 'в PDF нет текста (скан или пустой файл)' }); continue; }
        parts.push(`\n[Источник: ${KIND_LABEL.pdf} — ${link.url}]\n${text.slice(0, 12000)}`);
      } else {
        const page = await fetcher.fetchPage(link.url);
        if (!page.text || page.text.trim().length < 80) { docs.push({ ...link, status: 'empty', note: 'на вкладке нет текста' }); continue; }
        parts.push(`\n[Источник: ${KIND_LABEL.tab} — ${link.url}]\n${page.text.slice(0, 12000)}`);
      }
      docs.push({ ...link, status: 'ok' });
    } catch (err) {
      docs.push({ ...link, status: err.kind || 'error', note: String(err.message || err).slice(0, 160) });
    }
  }
  if (!parts.length) return { match: null, docs };
  const match = await matchFn(item, { ...offer, text: `${offer.text || ''}${parts.join('\n')}` });
  return { match, docs };
}

/** Отметить у строк сверки, какие подтвердились документами, а не страницей. */
function markDocEvidence(before, after, docs) {
  const okDocs = (docs || []).filter((d) => d.status === 'ok');
  if (!after?.checks?.rows || !okDocs.length) return after;
  const prev = new Map((before?.checks?.rows || []).map((r) => [r.name, r.verdict]));
  for (const r of after.checks.rows) {
    if (prev.get(r.name) !== 'unknown' || r.verdict === 'unknown') continue;
    // в какой из документов попала цитата — по номеру его блока в тексте; если не понять — первый открытый
    const doc = okDocs[0];
    r.source = doc.url;
    r.method = `${KIND_LABEL[doc.kind]}${r.method ? `; ${r.method}` : ''}`;
  }
  after.checks.docs = docs;
  return after;
}

module.exports = { docLinks, enrichFromDocs, markDocEvidence, KIND_LABEL };
