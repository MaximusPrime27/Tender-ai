// Сценарий закупки для подготовки заявки: закон, способ, электронная ли форма, только ли для малого бизнеса.
// От сценария зависит состав заявки, поэтому он определяется правилами по нескольким независимым признакам
// (извещение источника, разбор документации, название, площадка), а не нейросетью.
//   — Неизвестное остаётся неизвестным: «не знаем, только ли для МСП» не превращается в «не только».
//   — Признаки расходятся (в извещении аукцион, в документации котировки) — это блокирующий конфликт, большинством не решается.
//   — Название источника закон не определяет: закупочная сессия ЕАТ — не конкурентная заявка по 44-ФЗ.

const SUPPORTED = new Set([
  '44_eauction', '44_equotation', '44_ecompetition',
  '223_sme_eauction', '223_sme_equotation', '223_sme_ecompetition', '223_sme_eproposal',
  '223_other_competitive',
]);

const PROCEDURES = {
  auction: 'аукцион', quotation: 'запрос котировок', competition: 'конкурс', proposal: 'запрос предложений',
  single_supplier: 'закупка у единственного поставщика', small_purchase: 'малая закупка (электронный магазин)', other: 'иной способ',
};

/** Способ закупки по тексту («Электронный аукцион», «Запрос котировок в электронной форме, участниками которого…»). */
function readMethod(text) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  if (!t.trim()) return null;
  let procedure = null;
  if (/единственн\S* (поставщик|подрядчик|исполнител)/.test(t)) procedure = 'single_supplier';
  else if (/част\S* 12 стать\S* 93|ч\.\s*12 ст\.\s*93|электронн\S* магазин|малого объема|малой закупк|закупочн\S* сесси/.test(t)) procedure = 'small_purchase';
  else if (/аукцион/.test(t)) procedure = 'auction';
  else if (/котиров/.test(t)) procedure = 'quotation';
  else if (/конкурс/.test(t)) procedure = 'competition'; // «конкурентный отбор» сюда не попадает: в нём нет «конкурс»
  else if (/запрос\S* предложени/.test(t)) procedure = 'proposal';
  else if (/конкурентн\S* отбор|ценов\S* запрос|запрос цен|переговор/.test(t)) procedure = 'other';
  if (!procedure) return null;
  return {
    procedure,
    electronic: /электронн|в эл\.? форме/.test(t) ? true : /неэлектронн|бумажн|в письменной форме/.test(t) ? false : null,
    closed: /закрыт/.test(t) ? true : null,
    sme: /только субъект\S* мал|участник\S* котор\S* могут быть только|только смсп|субъект\S* мсп/.test(t) ? true : null,
  };
}

const lawFromText = (text) => { const m = String(text || '').match(/(44|223)\s*-?\s*ФЗ/i); return m ? m[1] : null; };
const cardField = (card, key) => card?.groups?.flatMap((g) => g.fields).find((f) => f.key === key && f.status === 'found')?.value ?? null;

/**
 * @param tender       {law, title, platform, source, number}
 * @param notification полные данные закупки из источника (44-ФЗ — извещение, 223-ФЗ — закупка) или null
 * @param card         карточка разбора документации или null
 * @returns {{scenario, supported, law, procedure, procedure_title, electronic, competitive, sme, closed, variant, signals, conflicts, unknown, reasons}}
 *   scenario — ветка правил или null (не определена / не поддерживается); sme: true | false | 'unknown'
 */
function classify({ tender, notification = null, card = null }) {
  const signals = [];
  const add = (source, kind, value, text) => { if (value != null) signals.push({ source, kind, value, text: String(text || '').slice(0, 200) }); };

  // --- закон ---
  const law = tender?.law != null ? String(tender.law) : null;
  add('закупка', 'law', law, law);
  const cardLaw = lawFromText(cardField(card, 'law'));
  add('документация', 'law', cardLaw, cardField(card, 'law'));

  // --- способ ---
  const src = notification?.source || notification?.docs?.[0]?.source || null;
  const way44 = src?.commonInfo?.placingWay;
  const fromNotice = readMethod(way44?.name || src?.purchaseCodeName || src?.purchaseMethodName);
  if (fromNotice) add('извещение', 'method', fromNotice, way44?.name || src?.purchaseCodeName || src?.purchaseMethodName);
  // код способа 44-ФЗ начинается с «E» у электронных процедур (EAP20, EZK20, EOK20)
  if (fromNotice && fromNotice.electronic == null && /^E/.test(String(way44?.code || ''))) fromNotice.electronic = true;
  const fromCard = readMethod(cardField(card, 'procurement_method'));
  if (fromCard) add('документация', 'method', fromCard, cardField(card, 'procurement_method'));
  const fromTitle = readMethod(tender?.title);
  if (fromTitle) add('название закупки', 'method', fromTitle, tender?.title);

  const conflicts = [];
  if (law && cardLaw && law !== cardLaw && law !== 'com') conflicts.push({ kind: 'law', text: `Закон: в данных закупки ${law}-ФЗ, в документации — ${cardLaw}-ФЗ`, values: [law, cardLaw] });
  const methods = [fromNotice, fromCard, fromTitle].filter(Boolean);
  const procedures = [...new Set(methods.map((m) => m.procedure))];
  if (procedures.length > 1) conflicts.push({ kind: 'procedure', text: `Способ закупки указан по-разному: ${procedures.map((p) => PROCEDURES[p]).join(' / ')}`, values: procedures });
  const procedure = procedures.length === 1 ? procedures[0] : null;
  // признак берётся, только если его кто-то назвал; «да» и «нет» от разных источников — конфликт
  const flag = (key) => {
    const vals = [...new Set(methods.map((m) => m[key]).filter((v) => v != null))];
    if (vals.length > 1) { conflicts.push({ kind: key, text: `Признак «${key}» в источниках расходится`, values: vals }); return null; }
    return vals.length ? vals[0] : null;
  };
  const electronic = flag('electronic');
  const closed = flag('closed');

  // --- только для малого бизнеса ---
  const smeText = `${src?.purchaseCodeName || ''} ${cardField(card, 'participant_requirements') || ''} ${cardField(card, 'procurement_method') || ''}`.toLowerCase();
  let sme = flag('sme');
  if (sme == null && /только (для )?(субъект\S* )?(мал\S* и средн|смсп|мсп|смп)|участник\S* .{0,40}могут быть только/.test(smeText)) sme = true;
  // «не только для МСП» утверждаем лишь по структурированному признаку источника; по умолчанию — неизвестно
  if (sme == null && law === '223' && src?.purchaseCodeName && fromNotice) sme = false;
  if (sme == null) sme = 'unknown';

  const unknown = [];
  const reasons = [];
  let scenario = null;
  const platformIsEat = /еат|берёзк|березк|agregatoreat/i.test(String(tender?.platform || '')) || /^EAT-/.test(String(tender?.number || ''));

  if (conflicts.length) reasons.push('Источники противоречат друг другу — сценарий не выбирается, пока противоречие не разобрано');
  else if (platformIsEat || procedure === 'small_purchase') reasons.push('Закупочная сессия ЕАТ / малая закупка через электронный магазин: состав конкурентной заявки к ней не применяется — отдельный сценарий не реализован');
  else if (law === 'com' || !law) reasons.push('Закупка вне 44-ФЗ и 223-ФЗ (коммерческая) или закон не определён — правил состава заявки для неё нет');
  else if (procedure === 'single_supplier') reasons.push('Закупка у единственного поставщика: конкурентная заявка не подаётся');
  else if (closed === true) reasons.push('Закрытая процедура: отдельный сценарий не реализован');
  else if (!procedure) { unknown.push('procedure'); reasons.push('Способ закупки не установлен: его нет ни в извещении, ни в разборе документации'); }
  else if (procedure === 'other') reasons.push('Способ закупки не из числа поддержанных (аукцион, запрос котировок, конкурс, запрос предложений)');
  else if (electronic === false) reasons.push('Неэлектронная процедура: сценарий не реализован');
  else if (electronic == null) { unknown.push('electronic'); reasons.push('Не установлено, электронная ли процедура'); }
  else if (law === '44') {
    if (procedure === 'proposal') reasons.push('Запрос предложений по 44-ФЗ в перечень поддержанных способов не входит');
    else scenario = { auction: '44_eauction', quotation: '44_equotation', competition: '44_ecompetition' }[procedure];
  } else if (law === '223') {
    if (sme === 'unknown') { unknown.push('sme'); reasons.push('Не установлено, только ли для субъектов малого и среднего предпринимательства эта закупка: от этого зависит, какие правила состава заявки применять'); }
    else if (sme === true) scenario = { auction: '223_sme_eauction', quotation: '223_sme_equotation', competition: '223_sme_ecompetition', proposal: '223_sme_eproposal' }[procedure];
    else scenario = '223_other_competitive';
  }

  return {
    scenario, supported: Boolean(scenario && SUPPORTED.has(scenario)),
    law, procedure, procedure_title: procedure ? PROCEDURES[procedure] : null,
    electronic, competitive: procedure ? !['single_supplier', 'small_purchase'].includes(procedure) : null,
    sme, closed,
    // у конкурса по 44-ФЗ структура заявки зависит от критериев оценки (ч. 2 или ч. 19 ст. 48) — уточняется по документации
    variant: scenario === '44_ecompetition' ? 'unknown' : null,
    signals, conflicts, unknown, reasons,
  };
}

module.exports = { classify, readMethod, SUPPORTED, PROCEDURES };
