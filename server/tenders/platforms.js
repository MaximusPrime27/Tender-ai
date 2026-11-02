// Площадка, на которой проходит закупка, — то есть куда подавать заявку.
//
// Источник закупки (откуда сервис о ней узнал: ГосПлан, лента ЕИС) и площадка — разные вещи: извещение лежит в ЕИС,
// а торги идут на одной из электронных площадок (Сбербанк-АСТ, РТС-тендер, Росэлторг…). Чтобы участвовать, нужно быть
// зарегистрированным именно на ней, поэтому площадку показываем в ленте и даём по ней отбирать.
// В списке закупок площадки нет — она указана в извещении (44-ФЗ) или в карточке закупки (223-ФЗ), которые сервис
// загружает вместе с позициями. Для закупок, найденных на самой площадке (Росэлторг), она известна сразу.

// Известные площадки: по адресу сайта, коду из извещения 44-ФЗ или названию — к одному короткому имени.
const KNOWN = [
  { name: 'Сбербанк-АСТ', url: 'https://www.sberbank-ast.ru', hosts: ['sberbank-ast.ru'], codes: ['ETP_SBAST'], re: /сбербанк/i },
  { name: 'РТС-тендер', url: 'https://www.rts-tender.ru', hosts: ['rts-tender.ru'], codes: ['ETP_RTS'], re: /ртс[\s-]*тендер/i },
  { name: 'Росэлторг', url: 'https://www.roseltorg.ru', hosts: ['roseltorg.ru'], codes: ['ETP_EETP'], re: /росэлторг|единая электронная торговая площадка|(^|[^а-яё])еэтп/i },
  { name: 'ЭТП ГПБ', url: 'https://etpgpb.ru', hosts: ['etpgpb.ru', 'etp.gpb.ru', 'gpb.ru'], codes: ['ETP_GPB'], re: /газпромбанк|этп гпб/i },
  { name: 'АГЗ РТ', url: 'https://etp.zakazrf.ru', hosts: ['zakazrf.ru'], codes: [], re: /агентство по государственному заказу|агз\s*рт/i },
  { name: 'Фабрикант', url: 'https://www.fabrikant.ru', hosts: ['fabrikant.ru'], codes: ['ETP_MMVB'], re: /фабрикант/i },
  { name: 'РАД (Lot-online)', url: 'https://tender.lot-online.ru', hosts: ['lot-online.ru'], codes: [], re: /российский аукционный дом|lot-online/i },
  { name: 'ТЭК-Торг', url: 'https://www.tektorg.ru', hosts: ['tektorg.ru'], codes: [], re: /тэк[\s-]*торг/i },
  { name: 'ЭТС (НЭП)', url: 'https://www.etp-ets.ru', hosts: ['etp-ets.ru'], codes: [], re: /национальная электронная площадка|электронные торговые системы|(^|[^а-яё])этс([^а-яё]|$)/i },
  { name: 'АСТ ГОЗ', url: 'https://www.astgoz.ru', hosts: ['astgoz.ru'], codes: [], re: /аст\s*гоз/i },
  { name: 'B2B-Center', url: 'https://www.b2b-center.ru', hosts: ['b2b-center.ru'], codes: [], re: /b2b-center|центр развития экономики/i },
  { name: 'OTC-тендер', url: 'https://otc.ru', hosts: ['otc.ru'], codes: [], re: /otc[\s.-]|отс[\s-]*тендер/i },
  { name: 'ЕАТ «Берёзка»', url: 'https://agregatoreat.ru', hosts: ['agregatoreat.ru'], codes: [], re: /агрегатор торговли|бер[её]зка/i },
];

/** Закупка идёт не на электронной площадке (бумажная, у единственного поставщика и т. п.). */
const NO_PLATFORM = 'Без электронной площадки';

// Источники, которые сами являются площадкой: закупка найдена там, там же и подаётся заявка.
const SOURCE_PLATFORM = {
  roseltorg: { name: 'Росэлторг', url: 'https://www.roseltorg.ru' },
  etpgpb: { name: 'ЭТП ГПБ', url: 'https://etpgpb.ru' },
  fabrikant: { name: 'Фабрикант', url: 'https://www.fabrikant.ru' },
  sberast: { name: 'Сбербанк-АСТ', url: 'https://www.sberbank-ast.ru' },
};

const hostOf = (url) => {
  if (!url) return '';
  try { return new URL(/^https?:/i.test(String(url)) ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
};

/** Короткое имя для незнакомой площадки: без «АО», «ООО», кавычек и слов «электронная торговая площадка». */
function shortName(name) {
  return String(name || '')
    .replace(/[«»"“”]/g, ' ')
    .replace(/(^|\s)(акционерное общество|общество с ограниченной ответственностью|ао|ооо|пао|зао)(?=\s|$)/gi, ' ')
    .replace(/электронная торговая площадка|электронная площадка/gi, 'ЭТП')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * Площадка по данным извещения: {code?, name?, url?} → {name, url} с единым коротким именем.
 * @returns {{name: string, url: string|null}|null} null — данных нет
 */
function normalizePlatform({ code, name, url } = {}) {
  const host = hostOf(url);
  const known = KNOWN.find((k) => (code && k.codes.includes(String(code)))
    || (host && k.hosts.some((h) => host === h || host.endsWith(`.${h}`)))
    || (name && k.re.test(String(name))));
  if (known) return { name: known.name, url: known.url };
  const short = shortName(name) || host;
  if (!short) return null;
  return { name: short, url: host ? `https://${host}` : null };
}

/**
 * Площадка из полных данных закупки: извещение 44-ФЗ (commonInfo.ETP) или закупка 223-ФЗ (electronicPlaceInfo).
 * @returns {{name: string, url: string|null}} если площадка не указана — «Без электронной площадки»
 */
function platformFromDoc(tender, doc) {
  if (!doc || typeof doc !== 'object') return null;
  // Документ уже в нашем формате (коммерческие площадки): площадку называет сам источник.
  if (doc.platform?.name) return normalizePlatform(doc.platform) || { name: NO_PLATFORM, url: null };
  let raw = null;
  if (tender.law === '44') raw = doc.source?.commonInfo?.ETP || doc.commonInfo?.ETP || null;
  else {
    const docs = Array.isArray(doc.docs) ? doc.docs : [doc];
    // Берём последнюю редакцию извещения, в которой площадка названа.
    for (const d of docs) if (d?.source?.electronicPlaceInfo) raw = d.source.electronicPlaceInfo;
    raw = raw || doc.electronicPlaceInfo || null;
  }
  return (raw && normalizePlatform(raw)) || { name: NO_PLATFORM, url: null };
}

module.exports = { normalizePlatform, platformFromDoc, shortName, KNOWN, NO_PLATFORM, SOURCE_PLATFORM };
