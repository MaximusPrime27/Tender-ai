// Проверяющий находки: каждую «выгодную» закупку агента заявок перед уведомлением в Telegram перепроверяет независимо —
// то, что 29–30.10 делалось вручную и поймало 4 ложных «выгодно» из 10:
//   • у каждой позиции есть товар поставщика;
//   • страница товара открывается, цена на ней не выросла больше чем на 20%, товар в наличии;
//   • это товар, а не раздел каталога («Мониторы 24 дюйма»), и не комплектующее из скобок названия;
//   • «оригинальный» — не совместимый бренд; спецпроверка (СП) — у найденного товара она есть;
//   • цена не подозрительно низкая (меньше 3% цены заказчика за единицу).
// Итог: ok — уведомлять; hold — в ленту с пометкой «проверить», в Telegram не слать; reject — не выгодно.
// Каждая пойманная ошибка — урок агенту заявок (журнал, source 'checker'); решение человека «пропустить» по закупке,
// которую проверяющий пропустил, — урок самому проверяющему: что он не поймал.

const { offerByRules } = require('../offers/rule-check');
const { categoryPage, componentOnly } = require('../offers/match');
const { COMPAT_BRANDS } = require('../offers/match-rules');
const { checkKind, getKindModel, KIND_ON } = require('../offers/kind-model');

const REASONS = {
  no_offer: 'Нет товара поставщика на позицию',
  page_gone: 'Страница товара не открывается',
  price_up: 'Цена на странице выросла больше чем на 20%',
  out_of_stock: 'На странице товара — нет в наличии',
  category: 'Ссылка ведёт на раздел каталога, а не на товар',
  component: 'Найдено комплектующее, а не сам товар',
  original: 'Нужен оригинальный товар, найден совместимый',
  special_check: 'Нужен товар со спецпроверкой (СП), у найденного её нет',
  too_cheap: 'Цена подозрительно низкая против цены заказчика',
  other_kind: 'Другой товар: совпали размеры, но не вид и не назначение',
};
// какие ошибки делают закупку невыгодной сразу, а какие — повод человеку посмотреть
const REJECT = new Set(['original', 'special_check', 'category', 'component', 'other_kind']);

function reqText(item) {
  let chars = [];
  try { chars = JSON.parse(item?.characteristics_json || '[]'); } catch { chars = []; }
  return [item?.name, ...chars.map((c) => `${c.name || ''} ${c.value || ''}`)].join(' ');
}

/** Проверка без сети: по названию, требованиям и сохранённому товару. */
function staticProblems(item, offer) {
  const out = [];
  if (!offer) return [{ code: 'no_offer' }];
  const name = String(item?.name || '');
  const title = String(offer.title || '');
  const req = reqText(item);
  if (categoryPage(name, title, offer.url)) out.push({ code: 'category' });
  if (componentOnly(name, title)) out.push({ code: 'component' });
  // проверяющий смотрит вид в медицине: вне её модель пока наблюдает, и отклонять заявки рано
  const kind = KIND_ON.test(String(item.ktru_code || item.okpd2_code || '')) ? checkKind(getKindModel(), item, offer) : null;
  if (kind?.verdict === 'other') out.push({ code: 'other_kind', text: kind.why });
  if (/оригинальн/i.test(req) && !/не\s+оригинальн|или\s+эквивалент|совместим/i.test(req) && (COMPAT_BRANDS.test(title) || /совместим/i.test(title))) out.push({ code: 'original' });
  if (/спец\.?\s*проверк|\(СП\)|\bСП\b/.test(req) && !/спец\.?\s*проверк|\bСП\b/i.test(title)) out.push({ code: 'special_check' });
  const p = Number(offer.price) || 0;
  const up = Number(item?.unit_price) || 0;
  if (p > 0 && up > 0 && p < up * 0.03) out.push({ code: 'too_cheap', text: `${p} ₽ против ${up} ₽` });
  return out;
}

function createChecker({ repo, journal, fetchPage = null, log = console }) {
  /** Перепроверить находку. @returns {{verdict:'ok'|'hold'|'reject', problems:Array}} */
  async function check(x) {
    const s = x?.summary || {};
    const items = new Map(repo.getItems(x.tender_id).map((i) => [i.id, i]));
    const problems = [];
    for (const it of s.items || []) {
      const item = items.get(it.id) || { name: it.name, unit_price: it.unit_price };
      const offer = it.offer;
      for (const p of staticProblems(item, offer)) problems.push({ ...p, item: it.name });
      if (!offer?.url || !fetchPage) continue;
      let page = null;
      try { page = await fetchPage(offer.url); } catch (err) {
        // запрет robots или сайт не пустил робота — не ошибка товара: проверить нечем
        if (!/robots|skip/i.test(String(err?.name || '') + String(err?.message || ''))) problems.push({ code: 'page_gone', item: it.name, text: String(err.message || '').slice(0, 80) });
        continue;
      }
      if (!page || page.status >= 400) { problems.push({ code: 'page_gone', item: it.name, text: `ответ ${page?.status}` }); continue; }
      const now = offerByRules(page);
      // в сводке цена — за единицу заказчика (505 ₽ за упаковку из 100 → 5,05 ₽): сравниваем с ценой страницы, как была
      const full = offer.id && repo.getOffer ? repo.getOffer(offer.id) : null;
      const was = Number(full?.price ?? offer.price) || 0;
      if (now?.price && was && now.price > was * 1.2) problems.push({ code: 'price_up', item: it.name, text: `${was} → ${now.price} ₽` });
      if (/нет\s+в\s+наличии|под\s+заказ\s+недоступ|снят\s+с\s+производства/i.test(String(now?.availability || ''))) problems.push({ code: 'out_of_stock', item: it.name });
    }
    const verdict = problems.some((p) => REJECT.has(p.code)) ? 'reject' : problems.length ? 'hold' : 'ok';
    for (const p of problems) journal.lesson('bid', p.code, REASONS[p.code], { scope: s.platform || '', tenderId: x.tender_id, text: `${p.item}: ${p.text || ''}`.trim(), source: 'checker' });
    journal.metric('checker', 'checked', 1);
    journal.metric('checker', verdict, 1);
    return { verdict, problems: problems.map((p) => ({ ...p, title: REASONS[p.code] })) };
  }

  /** Человек пропустил закупку, которую проверяющий признал выгодной, — урок проверяющему. */
  function humanSkipped(x, note = '') {
    journal.lesson('checker', 'missed', 'Пропустил ошибку, которую заметил человек', { scope: x?.summary?.platform || '', tenderId: x?.tender_id, text: note, source: 'human' });
    journal.metric('checker', 'missed', 1);
  }

  /**
   * Заявка, которую агент заявок готов назвать готовой: критичные замечания агента подготовки заявки (review) — значит,
   * не готова. @returns {Array} критичные проблемы (пусто — заявку можно считать готовой)
   */
  function checkApplication(x, rv) {
    if (!rv) return [];
    const crit = (rv.problems || []).filter((p) => p.critical);
    journal.metric('checker', 'applications', 1);
    if (crit.length) {
      journal.lesson('bid', 'ready_not_ready', 'Заявка названа готовой при критичных замечаниях', { scope: x?.summary?.platform || '', tenderId: x?.tender_id, text: crit.map((p) => p.text).join('; ').slice(0, 300), source: 'checker' });
      journal.metric('checker', 'app_blocked', 1);
    }
    return crit;
  }

  /**
   * Итог агента пакета против самого пакета: «можно выгружать», а в файлах незаполненные места, файл не читается или
   * предложения о товаре нет — ошибка агента пакета. @returns {string[]} что не так
   */
  function checkPackage(x, res, view) {
    if (!res || !view) return [];
    journal.metric('checker', 'packages', 1);
    const built = view.package?.built;
    const bad = [];
    if (res.final_ok) {
      if (!built) bad.push('файлы не составлены');
      else {
        if (!built.current) bad.push('файлы составлены на прежних данных');
        if (!built.files.some((f) => f.id === 'product-proposal')) bad.push('нет предложения о товаре');
        for (const f of built.files) {
          if (f.todo) bad.push(`незаполненные места в «${String(f.path).split('/').pop()}»`);
          if (f.check && !f.check.ok) bad.push(`«${String(f.path).split('/').pop()}» не прошёл проверку чтением`);
        }
      }
    }
    if (bad.length) {
      journal.lesson('package', 'final_not_ready', 'Пакет назван готовым к выгрузке, а он не готов', { scope: x?.platform || '', tenderId: x?.tender_id, text: bad.join('; ').slice(0, 300), source: 'checker' });
      journal.metric('checker', 'package_blocked', 1);
    }
    return bad;
  }

  return { check, checkApplication, checkPackage, humanSkipped };
}

module.exports = { createChecker, staticProblems, REASONS };
