// Жёсткие фильтры профиля — бесплатно отсекают неподходящие закупки до обращения к нейросети.

const DAY_MS = 24 * 60 * 60 * 1000;

const fs = require('node:fs');
const directions = require('./directions');

/** Подпись вида закупки: «44-ФЗ», «223-ФЗ» или «коммерческая» (закупки компаний на площадках, вне ЕИС). */
const lawLabel = (law) => (String(law) === 'com' ? 'коммерческая' : `${law}-ФЗ`);

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

// ---------- режим «Перепродажа» ----------
let exclusionsCache = null;
/** Правила из config/resale-exclusions.json (путь — RESALE_EXCLUSIONS). */
function loadExclusions(file) {
  if (exclusionsCache && exclusionsCache.file === file) return exclusionsCache.data;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  exclusionsCache = { file, data };
  return data;
}

/** Код ОКПД2/КТРУ относится к товарам (а не к работам и услугам)? */
function isGoodsCode(code, ex) {
  const c = String(code || '');
  return (ex.goods_sections || []).includes(c.slice(0, 2)) || (ex.goods_extra_prefixes || []).some((p) => c.startsWith(p));
}

/**
 * Жёсткие фильтры перепродажи: только поставка товаров и без товаров, для которых нужна лицензия.
 * @returns {string|null} причина отсева
 */
function resaleReason(tender, ex) {
  const codes = [...(tender.okpd2 || []), ...(tender.ktru || [])].map(String).filter(Boolean);
  const title = norm(tender.title);
  for (const rule of ex.excluded || []) {
    const byCode = codes.find((c) => (rule.prefixes || []).some((p) => c.startsWith(p)));
    const byWord = (rule.words || []).find((w) => title.includes(norm(w)));
    if (byCode || byWord) return `${rule.reason}${byCode ? ` (код ${byCode})` : ''}`;
  }
  if (codes.length) {
    if (!codes.some((c) => isGoodsCode(c, ex))) return `работы или услуги, а не поставка товара (код ${codes[0]}) — посредник их не выполнит`;
  } else if (!/поставк|приобретен|закупк[аи]\s+товар/.test(title)) {
    // Без кодов решает наименование: «Услуги делопроизводителя», «Выполнение работ…», «Ремонт…».
    const w = (ex.service_words || []).find((x) => title.includes(norm(x)))
      || (/(^|[^а-яё])(услуг[а-яё]*|работ[а-яё]*)([^а-яё]|$)/.test(title) ? 'услуги или работы' : null);
    if (w) return `похоже на работы или услуги, а не поставку товара («${w}»)`;
  }
  return null;
}

/**
 * Направление в режиме «Перепродажа» (коды ОКПД2/КТРУ и ключевые слова профиля): закупка подходит, если код товара
 * начинается с одного из кодов направления или в наименовании есть ключевое слово. Пустое направление — любой товар.
 * @returns {string|null}
 */
function focusReason(tender, profile) {
  if (directions.usesDirections(profile)) {
    // Направления профиля: закупка подходит, если относится хотя бы к одному включённому (слова-исключения — у каждого свои).
    const codes = [...(tender.okpd2 || []), ...(tender.ktru || [])].map(String);
    const m = directions.pick(directions.enabledOf(profile), codes, tender.title);
    if (m?.id) return null;
    if (m?.minus) return 'не из выбранного направления (слово-исключение в наименовании)';
    return codes.length
      ? `не из выбранного направления (код ${codes[0]})`
      : 'не из выбранного направления (в наименовании нет слов направления)';
  }
  const { codes: focusCodes, words: focusWords, minus } = focusOf(profile);
  if (!focusCodes.length && !focusWords.length) return null;
  const title = norm(tender.title);
  const neg = minus.find((w) => title.includes(w));
  if (neg) return `не из выбранного направления (слово-исключение «${neg}»)`;
  const codes = [...(tender.okpd2 || []), ...(tender.ktru || [])].map(String);
  if (codes.some((c) => focusCodes.some((p) => c.startsWith(p)))) return null;
  if (focusWords.some((w) => title.includes(w))) return null;
  return codes.length
    ? `не из выбранного направления (код ${codes[0]})`
    : 'не из выбранного направления (в наименовании нет слов направления)';
}

/**
 * Направление из профиля: коды, слова (по основе: «видеонаблюдение» находит «видеонаблюдения») и слова-исключения —
 * с минусом в начале, как в Яндексе: «-мониторинг» убирает «изделия чрескожного мониторинга», хотя там есть «монитор».
 */
function focusOf(profile) {
  const stem = (w) => (w.length > 6 && /[а-я]$/.test(w) ? w.slice(0, -2) : w);
  const all = (profile.keywords || []).map((w) => norm(w).trim()).filter(Boolean);
  return {
    codes: (profile.codes || []).map((c) => String(c).trim()).filter(Boolean),
    words: all.filter((w) => !w.startsWith('-')).map(stem),
    minus: all.filter((w) => w.startsWith('-')).map((w) => w.slice(1).trim()).filter(Boolean).map(stem),
  };
}

/** Слова направления без исключений — для поиска по ленте ЕИС и подсказки нейросети. */
const positiveKeywords = (keywords) => (keywords || []).filter((w) => w && !String(w).trim().startsWith('-'));

/**
 * Какая доля суммы закупки приходится на товары направления — по позициям (код позиции или слово в наименовании).
 * «Канцтовары» с двумя картриджами среди 40 позиций проходят фильтр по наименованию, но по составу — не наши.
 * @returns {number|null} 0–1; null — направление не задано или позиций нет
 */
function focusShare(items, profile) {
  if (directions.usesDirections(profile)) return directions.itemsShare(items, directions.enabledOf(profile)).total;
  const { codes: focusCodes, words: focusWords, minus } = focusOf(profile);
  if ((!focusCodes.length && !focusWords.length) || !items?.length) return null;
  let all = 0;
  let mine = 0;
  for (const i of items) {
    const w = i.sum ?? (i.unit_price != null && i.quantity ? i.unit_price * i.quantity : 1);
    all += w;
    const code = String(i.ktru_code || i.okpd2_code || '');
    const name = norm(i.name);
    if (minus.some((x) => name.includes(x))) continue;
    if ((code && focusCodes.some((p) => code.startsWith(p))) || focusWords.some((x) => name.includes(x))) mine += w;
  }
  return all ? Math.round((mine / all) * 100) / 100 : null;
}

/**
 * @returns {string|null} причина отсева или null, если закупка прошла фильтры
 */
function filterReason(tender, profile, now = new Date(), { exclusions } = {}) {
  const resale = profile.mode === 'resale';
  if (profile.laws?.length && !profile.laws.includes(String(tender.law))) {
    return String(tender.law) === 'com' ? 'коммерческие закупки исключены в профиле' : `закон ${tender.law}-ФЗ исключён в профиле`;
  }
  if (profile.regions?.length && tender.region != null && !profile.regions.includes(Number(tender.region))) {
    return `регион ${tender.region} не входит в профиль`;
  }
  if (tender.price != null) {
    if (profile.price_min != null && tender.price < profile.price_min) {
      return `НМЦК ${formatMoney(tender.price)} ниже минимума ${formatMoney(profile.price_min)}`;
    }
    if (profile.price_max != null && tender.price > profile.price_max) {
      return `НМЦК ${formatMoney(tender.price)} выше максимума ${formatMoney(profile.price_max)}`;
    }
  }
  if (resale) {
    const reason = resaleReason(tender, exclusions || loadExclusions(require('../config').RESALE_EXCLUSIONS)) || focusReason(tender, profile);
    if (reason) return reason;
  } else if (profile.codes?.length) {
    const codes = [...(tender.okpd2 || []), ...(tender.ktru || [])];
    if (codes.length && !codes.some((c) => profile.codes.some((p) => String(c).startsWith(p)))) {
      return `коды ${codes.slice(0, 3).join(', ')} не входят в профиль`;
    }
  }
  const title = norm(tender.title);
  const stop = (profile.stop_words || []).find((w) => w.trim() && title.includes(norm(w.trim())));
  if (stop) return `стоп-слово: ${stop.trim()}`;

  // в ЕИС закупку отменили или приём заявок закрыли — участвовать уже нельзя, какой бы срок ни был указан
  if (tender.closed_stage) return closedReason(tender.closed_stage);
  if (tender.deadline_at) {
    const daysLeft = (new Date(tender.deadline_at).getTime() - now.getTime()) / DAY_MS;
    if (daysLeft <= 0) return 'подача заявок уже закончилась';
    if (profile.min_days_to_deadline && daysLeft < profile.min_days_to_deadline) {
      return `до окончания подачи ${daysLeftText(daysLeft)} (минимум в профиле — ${profile.min_days_to_deadline} дн.)`;
    }
  }
  return null;
}

/** Причина отсева закупки, по которой в ЕИС приём заявок закрыт: «отменено», «завершено», «работа комиссии». */
function closedReason(stage) {
  return `в ЕИС этап «${stage}» — подать заявку уже нельзя`;
}

function daysLeftText(days) {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} ч`;
  return `${Math.floor(days)} дн.`;
}

function formatMoney(n) {
  return `${Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}

module.exports = { closedReason, lawLabel, filterReason, resaleReason, focusReason, focusShare, positiveKeywords, isGoodsCode, loadExclusions, formatMoney, daysLeftText, DAY_MS };
