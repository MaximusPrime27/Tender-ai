// Пробный прогон «как ищут люди»: текстовый поиск по ТЗ против поиска по фото — на реальных выгодных закупках.
//
//   node scripts/pilot-search.js            — подобрать закупки для прогона → docs/pilot-candidates.md (ключ не нужен)
//   node scripts/pilot-search.js --run      — прогнать оба способа через Yandex Search API → docs/pilot-search-results.md
//                                             (нужны YANDEX_API_KEY и YANDEX_FOLDER_ID; тратит платные запросы: ~4–6 на закупку)
//   --limit N                               — сколько закупок взять (по умолчанию 20)
//
// Для каждой закупки берётся первая позиция. Текстовый поиск — первый запрос из ТЗ (модель/отличительные числа).
// Поиск по фото — фото из ТЗ; если его нет — сначала картинка по тексту, затем поиск по этой картинке.
// Найденные страницы открываются (robots.txt соблюдается), цена сверяется с ТЗ теми же правилами, что в сервисе.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../server/config');
const { loadExtraCaCertificates } = require('../server/certs');
const { openDb } = require('../server/db');
const { createPhotoService } = require('../server/tenders/photos');
const { createYandexSearch, queriesFor } = require('../server/offers/sources/yandex-search');
const { createPageFetcher, foreignDomain } = require('../server/offers/fetch-page');
const { extractOffer } = require('../server/offers/extract');
const { matchOffer } = require('../server/offers/match');
const { createLlm } = require('../server/llm');

loadExtraCaCertificates(config.EXTRA_CA_DIR, { log() {} });
const args = process.argv.slice(2);
const RUN = args.includes('--run');
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || 20;
const ONLY = args.includes('--only') ? Number(args[args.indexOf('--only') + 1]) : null; // --only <id закупки> — перепроверить одну
const repo = openDb(config.DATA_DIR, { recoverInterrupted: false }); // сервер может работать рядом
const photos = createPhotoService({ repo, dataDir: config.DATA_DIR, log: { log() {} } });
const DOCS = path.join(__dirname, '..', 'docs');
const money = (n) => (n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`);

// Группы товаров направления «Оргтехника, сеть, видеонаблюдение» — чтобы в прогон попали разные:
// где решает модель (картриджи, коммутаторы), где фото (камеры), где характеристики (компьютеры).
const GROUPS = [
  ['картриджи и печать', /картридж|тонер|принтер|мфу|фотобарабан|копир/i],
  ['компьютеры и периферия', /компьют|ноутбук|моноблок|монитор|системн|клавиатур|мыш|планшет|сервер|накопител|ssd/i],
  ['сеть', /коммутатор|маршрутизатор|роутер|точк[аи] доступа|сетев|патч|витая|кабел/i],
  ['видеонаблюдение и СКУД', /видео|камер|регистратор|скуд|домофон|турникет|охран/i],
  ['ИБП, проекторы, прочая техника', /ибп|бесперебойн|проектор|мультимед|экран|оргтехник|телефон|техник/i],
  ['прочее', /./],
];

function candidates() {
  const rows = repo.db.prepare(`SELECT t.id FROM tenders t JOIN tender_economics e ON e.tender_id = t.id
    WHERE t.status = 'scored' AND t.analysis_id IS NOT NULL
      AND t.scored_profile_version = (SELECT version FROM profile WHERE id = 1) -- оценена под текущее направление
      AND (t.deadline_at IS NULL OR t.deadline_at > ?)
    ORDER BY e.opportunity DESC NULLS LAST LIMIT 400`).all(new Date().toISOString());
  const byGroup = new Map(GROUPS.map(([g]) => [g, []]));
  for (const { id } of rows) {
    const t = repo.getTender(id);
    const items = repo.getItems(id);
    if (!items.length) continue;
    const ph = photos.ensurePhotos(t);
    const group = GROUPS.find(([, re]) => re.test(t.title))[0];
    byGroup.get(group).push({ t, item: items[0], photo: ph.find((p) => p.item_idx === items[0].idx) || null, photos: ph.length, econ: repo.getEconomics(id) });
  }
  // С фото — вперёд в каждой группе; берём поровну из групп.
  for (const list of byGroup.values()) list.sort((a, b) => Number(Boolean(b.photo)) - Number(Boolean(a.photo)));
  const out = [];
  for (let round = 0; out.length < LIMIT && round < 50; round++) {
    for (const list of byGroup.values()) if (list[round] && out.length < LIMIT) out.push(list[round]);
  }
  return out;
}

// Маркетплейсы и сайты, закрытые для роботов (их запоминает поиск сервиса), — мимо: место занимают магазины, которые открываются.
const blocked = String(config.OFFER_DOMAIN_BLOCKLIST || '').split(',').map((x) => x.trim()).filter(Boolean);
const openable = (url) => {
  let d; try { d = new URL(url).hostname.replace(/^www./, ''); } catch { return false; }
  if (foreignDomain(d) || blocked.some((b) => d === b || d.endsWith(`.${b}`))) return false;
  const at = repo.getSetting(`closed_domain:${d}`);
  return !(at && Date.now() - new Date(at).getTime() < 30 * 86400000);
};

async function tryPages(results, item, fetcher, llm, maxPages = 5) {
  const found = [];
  for (const r of results.filter((x) => openable(x.url)).slice(0, maxPages)) {
    try {
      const page = await fetcher.fetchPage(r.url);
      const offer = await extractOffer(page, item, { llm, system: fs.readFileSync(path.join(__dirname, '..', 'server', 'analyze', 'prompts', 'offer.md'), 'utf8') });
      if (!offer?.price) continue;
      const m = await matchOffer(item, { ...offer, text: page.text.slice(0, 6000) }, { llm, system: fs.readFileSync(path.join(__dirname, '..', 'server', 'analyze', 'prompts', 'match.md'), 'utf8') });
      found.push({ url: r.url, price: offer.price, match: m.match });
      if (ONLY) console.log(`  ${m.match.padEnd(16)} ${offer.price} ₽  ${String(offer.title || '').slice(0, 70)}\n    ${r.url}\n    ${(m.notes || []).join('; ').slice(0, 240)}`);
    } catch (err) { /* страница закрыта для роботов или недоступна */ if (err.closed) repo.setSetting(`closed_domain:${new URL(r.url).hostname.replace(/^www\./, '')}`, new Date().toISOString()); }
  }
  const ok = found.filter((f) => f.match === 'соответствует');
  return { pages: found.length, matched: ok.length, best: ok.length ? Math.min(...ok.map((f) => f.price)) : null, bestUrl: ok.sort((a, b) => a.price - b.price)[0]?.url || null };
}

(async () => {
  const list = ONLY ? candidates().filter((c) => c.t.id === ONLY) : candidates();
  const lines = [
    `# Пробный прогон: поиск поставщиков по тексту ТЗ и по фото\n`,
    `Подобрано ${new Date().toLocaleDateString('ru-RU')}: ${list.length} выгодных закупок с прочитанной документацией, разные группы товаров. Фото из ТЗ есть у ${list.filter((c) => c.photo).length}.\n`,
    '| # | Закупка | Группа | НМЦК | Маржа (оценка) | Фото в ТЗ | Запрос для текстового поиска |',
    '|---|---|---|---|---|---|---|',
    ...list.map((c, n) => `| ${n + 1} | ${c.t.title.slice(0, 70).replace(/\|/g, '/')} (id ${c.t.id}) | ${GROUPS.find(([, re]) => re.test(c.t.title))[0]} | ${money(c.t.price)} | ${c.econ?.margin_pct != null ? `${c.econ.margin_pct}%` : '—'} | ${c.photo ? 'да' : c.photos ? 'есть, не к этой позиции' : 'нет'} | ${(queriesFor(c.item, 1, { spec: c.item.spec, title: c.t.title })[0] || c.item.name).replace(/\|/g, '/')} |`),
  ];
  fs.mkdirSync(DOCS, { recursive: true });
  if (!ONLY) fs.writeFileSync(path.join(DOCS, 'pilot-candidates.md'), `${lines.join('\n')}\n`);
  console.log(`Кандидаты: ${list.length} (с фото из ТЗ: ${list.filter((c) => c.photo).length}) → docs/pilot-candidates.md`);
  if (!RUN) return;

  const yandex = createYandexSearch({ apiKey: config.YANDEX_SEARCH_API_KEY, folderId: config.YANDEX_FOLDER_ID, resultsPerQuery: 10 });
  if (!yandex) { console.log('Нет ключа Яндекса (YANDEX_API_KEY, YANDEX_FOLDER_ID) — прогон не запущен.'); return; }
  const fetcher = createPageFetcher({ minIntervalMs: config.FETCH_MIN_INTERVAL_MS });
  const llm = createLlm();
  const res = [];
  let requests = 0;
  for (const c of list) {
    const q = queriesFor(c.item, 1, { spec: c.item.spec, title: c.t.title })[0] || c.item.name;
    const row = { c, q };
    try { requests++; row.text = await tryPages(await yandex.search(q), c.item, fetcher, llm); } catch (err) { row.text = { error: err.message }; }
    try {
      let img = c.photo ? fs.readFileSync(photos.photoPath(c.t.id, c.photo)) : null;
      row.photoFrom = c.photo ? 'фото из ТЗ' : 'картинка по тексту';
      if (!img) {
        requests++;
        const pics = await yandex.searchImages(q, { docsOnPage: 5 });
        const src = pics.find((p) => p.image)?.image;
        if (src) img = Buffer.from(await (await fetch(src, { signal: AbortSignal.timeout(20000) })).arrayBuffer());
      }
      if (img) { requests++; row.photo = await tryPages(await yandex.searchByImage(img), c.item, fetcher, llm); } else row.photo = { error: 'не нашлось картинки' };
    } catch (err) { row.photo = { error: err.message }; }
    res.push(row);
    console.log(`${res.length}/${list.length} ${c.t.title.slice(0, 50)}: текст ${row.text.matched ?? '×'} подходящих, фото ${row.photo.matched ?? '×'}`);
  }
  const cell = (r) => (r.error ? `ошибка: ${r.error.slice(0, 60)}` : `${r.matched} из ${r.pages}${r.best ? `, от [${money(r.best)}](${r.bestUrl})` : ''}`);
  const margin = (c, best) => (best && c.item.unit_price ? `${Math.round((1 - best / c.item.unit_price) * 100)}%` : '—');
  const out = [
    '# Результаты пробного прогона: текст против фото\n',
    `Дата: ${new Date().toLocaleDateString('ru-RU')}. Закупок: ${res.length}. Платных запросов к Яндексу: ${requests}.`,
    'В ячейках: сколько найденных страниц подошли под ТЗ из открытых, и лучшая цена. «Запас к цене заказчика» — насколько лучшая подходящая цена ниже цены заказчика за единицу (до налогов и доставки).\n',
    '| # | Закупка | По тексту | По фото | Запас (текст / фото) |',
    '|---|---|---|---|---|',
    ...res.map((r, n) => `| ${n + 1} | ${r.c.t.title.slice(0, 55).replace(/\|/g, '/')} | ${cell(r.text)} | ${r.photoFrom}: ${cell(r.photo)} | ${margin(r.c, r.text.best)} / ${margin(r.c, r.photo.best)} |`),
    '',
    `Итого: подходящий товар по тексту найден в ${res.filter((r) => r.text.matched).length} закупках, по фото — в ${res.filter((r) => r.photo.matched).length}.`,
  ];
  fs.writeFileSync(path.join(DOCS, ONLY ? `pilot-search-${ONLY}.md` : 'pilot-search-results.md'), `${out.join('\n')}\n`);
  console.log('Готово → docs/pilot-search-results.md');
})();
