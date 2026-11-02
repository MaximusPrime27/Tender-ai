// Разбор документации: факты из извещения ЕИС (нацрежим по отметкам позиций, сроки, обеспечение) и прицельный
// дочит полей, которые основной проход не выписал (пени в длинном проекте контракта — закупка 0372100041126000094).
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocs } = require('../server/analyze');
const { fileCoverage } = require('../server/analyze/coverage');
const { noticeFacts } = require('../server/tenders/notice-facts');
const { planTargeted } = require('../server/analyze/targeted');

const field = (card, key) => card.groups.flatMap((g) => g.fields).find((f) => f.key === key);
const complete = (pages) => fileCoverage({ unit: 'page', expected: pages, processed: pages });
const doc = (id, name, texts) => ({ id, name, status: 'ok', pages: texts.map((text, i) => ({ page: i + 1, text })), coverage: complete(texts.length) });
const summaryOf = (recommendation) => JSON.stringify({ summary: 'Резюме.', recommendation, reasons: ['причина'] });
function scripted(byTask) {
  const calls = [];
  return {
    provider: 'scripted', model: 'test', retryDelayMs: 0, calls,
    async complete({ task, messages }) {
      const user = messages[0].content;
      calls.push({ task, user });
      const a = byTask[task];
      const r = typeof a === 'function' ? await a(user) : a;
      return { text: r ?? JSON.stringify({ result: 'nothing_found', fields: [], risks: [], questions: [] }), finish: 'stop', usage: { in: 1, out: 1 } };
    },
  };
}

const R = (o) => ({ isProhibitionForeignPurchaseObjects: 'false', isRestrictForeignPurchaseObjects: 'false', isPreferenseRFPurchaseObjects: 'false', ...o });
const notice = (objects, extra = {}) => ({ source: {
  commonInfo: { placingWay: { code: 'EAP20', name: 'Электронный аукцион' } },
  notificationInfo: {
    procedureInfo: { collectingInfo: { endDT: '2026-10-26T09:00:00+03:00' }, biddingDate: '2026-10-26+03:00', summarizingDate: '2026-10-28+03:00' },
    contractConditionsInfo: { maxPriceInfo: { maxPrice: '7001733.42' } },
    customerRequirementsInfo: { customerRequirementInfo: { applicationGuarantee: { part: '1' }, contractGuarantee: { part: '10' } } },
    purchaseObjectsInfo: { notDrugPurchaseObjectsInfo: { purchaseObject: objects } },
    preferensesInfo: { preferenseInfo: { preferenseRequirementInfo: { name: 'Преимущество в соответствии с ч. 3 ст. 30 Закона № 44-ФЗ' } } },
    ...extra,
  },
} });
const tender = { number: '0372100041126000094', law: '44', price: 7001733.42, deadline_at: '2026-10-26T06:00:00.000Z' };

test('факты из извещения: способ, сроки, обеспечения, преимущества; нацрежим — по отметкам позиций', () => {
  const reason = 'Подпункт м) пункта 10, Постановления Правительства РФ от 23.12.2024 N 1875 "О мерах…"';
  const r = noticeFacts(tender, notice([
    { name: 'Ноутбук', restrictionsInfo: R({ isRestrictForeignPurchaseObjects: 'true', isImposibilityProhibition: 'true', reasonImposibilityProhibition: reason }) },
    { name: 'Монитор', restrictionsInfo: R({ isRestrictForeignPurchaseObjects: 'true', isImposibilityProhibition: 'true', reasonImposibilityProhibition: reason }) },
  ]));
  assert.equal(r.facts.procurement_method, 'Электронный аукцион');
  assert.match(r.facts.bid_deadline, /^26\.10\.2026, 09:00/);
  assert.match(r.facts.results_date, /торги \(аукцион\) — 26\.10\.2026; подведение итогов — 28\.10\.2026/);
  const sp = (s) => s.replace(/\s/g, ' '); // формат чисел ставит неразрывные пробелы
  assert.equal(sp(r.facts.bid_security), '1% — 70 017,33 руб.');
  assert.match(sp(r.facts.contract_security), /^10% — 700 173,34 руб\. от цены контракта/);
  // finhelper в этой закупке написал «нацрежим не применяется» — а в извещении установлено ограничение
  assert.match(r.facts.national_regime, /ограничение допуска иностранных товаров.*для всех позиций\. Запрет не применяется: Подпункт м\) пункта 10/);
  assert.deepEqual(r.measures, ['ограничение']);
  assert.deepEqual(r.preferences, ['Преимущество в соответствии с ч. 3 ст. 30 Закона № 44-ФЗ']);
  // у позиций нет отметок — о нацрежиме ничего не утверждаем; отметки «всё ложь» — мер нет
  assert.equal(noticeFacts(tender, notice([{ name: 'Бумага' }])).facts.national_regime, undefined);
  assert.match(noticeFacts(tender, notice([{ name: 'Бумага', restrictionsInfo: R({}) }])).facts.national_regime, /^В извещении мер национального режима нет/);
  // извещения нет — только то, что известно о закупке
  assert.deepEqual(Object.keys(noticeFacts(tender, null).facts).sort(), ['bid_deadline', 'law', 'nmck', 'notice_number']);
});

test('прицельный дочит: пени в длинном контракте, которые основной проход не выписал, находятся по выдержке с цитатой', async () => {
  const filler = 'Прочие условия контракта. '.repeat(30);
  const penalty = 'Пеня начисляется за каждый день просрочки исполнения обязательства в размере одной трехсотой ключевой ставки ЦБ РФ.';
  const docs = [doc(1, 'Контракт.docx', [`${filler} Цена контракта 7 001 733,42 руб.`, `${filler} ${penalty} ${filler}`])];
  assert.deepEqual(planTargeted(['penalties', 'acceptance_term'], docs).map((c) => c.keys), [['penalties']], 'о приёмке в тексте ни слова — не спрашиваем');
  const llm = scripted({
    // основной проход «видит» только цену — как GigaChat на большом куске
    extract: JSON.stringify({ result: 'found', fields: [{ key: 'nmck', value: '7 001 733,42 руб.', file: 'Контракт.docx', page: 1, quote: 'Цена контракта 7 001 733,42 руб.' }], risks: [], questions: [] }),
    targeted: (user) => (user.includes('одной трехсотой')
      ? JSON.stringify({ result: 'found', fields: [{ key: 'penalties', value: 'пени 1/300 ключевой ставки ЦБ РФ за день просрочки', file: 'Контракт.docx', page: 2, quote: 'одной трехсотой ключевой ставки ЦБ РФ' }], risks: [], questions: [] })
      : null),
    summary: summaryOf('участвовать'),
  });
  const { card } = await analyzeDocs(docs, llm, { maxChars: 100000 });
  const f = field(card, 'penalties');
  assert.equal(f.status, 'found');
  assert.equal(f.sources[0].verified, true, 'цитата из выдержки проверена по тексту страницы');
  const asked = llm.calls.filter((c) => c.task === 'targeted');
  assert.equal(asked.length, 1);
  assert.ok(asked[0].user.length < 4000, 'в запрос ушли выдержки, а не весь документ');
});

test('карточка: официальные поля — из извещения ЕИС (подтверждены); что сказано в документах — рядом; прочее — если не найдено', async () => {
  const docs = [doc(1, 'ТЗ.docx', ['Национальный режим не установлен. Обеспечение исполнения контракта 5% от цены контракта.'])];
  const llm = scripted({
    extract: JSON.stringify({ result: 'found', fields: [
      { key: 'national_regime', value: 'не установлен', file: 'ТЗ.docx', page: 1, quote: 'Национальный режим не установлен' },
      { key: 'contract_security', value: '5%', file: 'ТЗ.docx', page: 1, quote: 'Обеспечение исполнения контракта 5%' },
    ], risks: [], questions: [] }),
    summary: summaryOf('участвовать'),
  });
  const facts = noticeFacts(tender, notice([{ name: 'Ноутбук', restrictionsInfo: R({ isRestrictForeignPurchaseObjects: 'true' }) }]));
  const { card } = await analyzeDocs(docs, llm, { maxChars: 100000, notice: facts });
  const nr = field(card, 'national_regime');
  assert.deepEqual([nr.origin, nr.review, nr.doc_value], ['eis', 'confirmed', 'не установлен']);
  assert.match(nr.value, /ограничение/);
  assert.deepEqual([field(card, 'contract_security').value, field(card, 'contract_security').origin], ['5%', undefined], 'найденное в документах не заменяется — извещение главнее только в официальных полях');
  assert.deepEqual([field(card, 'procurement_method').value, field(card, 'procurement_method').origin], ['Электронный аукцион', 'eis']);
  assert.equal(card.meta.eis_notice.preferences.length, 1);
  assert.equal(llm.calls.filter((c) => c.task === 'targeted' && /national_regime|bid_deadline/.test(c.user.split('\n')[0])).length, 0, 'поля из извещения не дочитываются нейросетью');
});
