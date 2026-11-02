// Mock-провайдер: без сети, детерминированно. Правилами (регулярками) находит поля и риски
// в реальном тексте чанка и возвращает JSON в том же формате, что и настоящая модель.
// Цитаты берутся дословно из текста — проверка цитат должна их подтверждать.
// Нужен для разработки, тестов и демонстрации без ключей.

const { parseChunk } = require('../analyze/chunk');

const FIELD_RULES = [
  ['notice_number', /(извещени\S* .{0,30}№|номер закупки|реестровый номер)/i],
  ['law', /\b(44|223)-ФЗ/, (m) => m[0]],
  ['procurement_method', /(электронн\S+ аукцион|открыт\S+ конкурс|запрос\S* котировок|запрос\S* предложений)/i],
  ['customer', /^заказчик\s*:/i],
  ['subject', /(объект|предмет)\S* закупки/i],
  ['okpd_ktru', /(ОКПД|КТРУ)/],
  ['nmck', /начальн\S* \(максимальн\S*\) цен/i],
  ['currency', /валюта/i],
  ['bid_deadline', /окончани\S* (срока )?подачи заявок/i],
  ['results_date', /подведени\S* итогов/i],
  ['delivery_term', /срок\S* (поставки|выполнения работ|оказания услуг)/i],
  ['delivery_place', /место поставки/i],
  ['bid_security', /обеспечени\S* заяв/i],
  ['contract_security', /обеспечени\S* исполнения контракта/i],
  ['warranty_security', /обеспечени\S* гарантийных/i],
  ['advance', /аванс/i],
  ['payment_terms', /оплат\S*.{0,60}(дн|дней)/i],
  ['participant_requirements', /требовани\S* к участник/i],
  ['application_composition', /(состав\S* заявки|заявка должна содержать)/i],
  ['national_regime', /(1875|национальн\S* режим)/i],
  ['evaluation_criteria', /критери\S* оценки/i],
  ['penalties', /(пен[иьяю]|штраф)/i],
  ['termination', /одностор\S+ (отказ|расторжени)/i],
];

const MAX_QUOTE = 300;
const MIN_FIELD_SENTENCE = 20; // короче — скорее заголовок раздела, а не значение
const ABBR = '(?:г|ул|д|ч|ст|п|пп|т|руб|им|пр|корп|стр)';

function sentences(text) {
  return text
    .split(new RegExp(`\\n+|(?<=[.;!?])(?<!(?:^|[\\s(])${ABBR}\\.)\\s+(?=[А-ЯЁA-Z0-9])`, 'u'))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 8);
}

function extract(chunk) {
  const fields = [];
  const risks = [];
  const questions = [];

  for (const p of parseChunk(chunk)) {
    const ref = (s) => ({ file: p.file, page: p.page, quote: s.slice(0, MAX_QUOTE) });
    const taken = new Set();
    for (const s of sentences(p.text)) {
      for (const [key, re, pick] of FIELD_RULES) {
        const m = s.match(re);
        if (taken.has(key) || !m || (!pick && s.length < MIN_FIELD_SENTENCE)) continue;
        taken.add(key); // одно значение поля на страницу — меньше шума
        const value = pick ? pick(m) : s.replace(/^\d+(\.\d+)*\.\s*/, '').slice(0, 200);
        fields.push({ key, value, ...ref(s) });
      }

      // жёсткие пени: процент в день выше 0,1%
      if (/пен/i.test(s)) {
        const pct = [...s.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((m) => Number(m[1].replace(',', '.')));
        if (pct.some((x) => x > 0.1)) {
          risks.push({ type: 'жёсткие_штрафы', level: 'high', explanation: 'Размер пени выше обычного для 44-ФЗ (1/300 ключевой ставки ЦБ).', ...ref(s) });
          questions.push({ text: 'Просим разъяснить обоснование размера пени и привести его в соответствие с ч. 7 ст. 34 44-ФЗ.', reference: '', ...ref(s) });
        }
      }
      // долгая оплата
      if (/оплат/i.test(s)) {
        const work = s.match(/(\d+)\s*\(?[а-я ]*\)?\s*рабоч\S* дн/i);
        const cal = s.match(/(\d+)\s*\(?[а-я ]*\)?\s*календарн\S* дн/i);
        if ((work && Number(work[1]) > 7) || (cal && Number(cal[1]) > 15)) {
          risks.push({ type: 'долгая_оплата', level: 'medium', explanation: 'Срок оплаты длиннее обычного (для СМП по 44-ФЗ — не более 7 рабочих дней).', ...ref(s) });
        }
      }
      // конкретная марка без эквивалента
      if (/(товарн\S* знак\S*|марк[аиу]|модел[ьи])\s*[:«"]/i.test(s) && !/эквивалент/i.test(s)) {
        risks.push({ type: 'заточка_под_поставщика', level: 'high', explanation: 'Указан конкретный товарный знак/модель без слов «или эквивалент».', ...ref(s) });
        questions.push({ text: 'Просим разъяснить, допускается ли поставка эквивалентного товара, и дополнить описание словами «или эквивалент».', reference: '', ...ref(s) });
      }
    }
  }
  return { result: fields.length || risks.length || questions.length ? 'found' : 'nothing_found', fields, risks, questions };
}

const digits = (v) => (String(v).match(/\d+/g) || []).join(' ');

function resolve(user) {
  const { conflicts } = JSON.parse(user);
  return {
    results: conflicts.map((c) => {
      const distinct = new Set(c.candidates.map((x) => digits(x.value)));
      const contradiction = distinct.size > 1;
      return {
        key: c.key,
        contradiction,
        value: c.candidates[0].value,
        explanation: contradiction
          ? `«${c.label}» различается в документах: ${c.candidates.map((x) => `«${x.value}» (${x.file}, стр. ${x.page})`).join(' и ')}.`
          : '',
      };
    }),
  };
}

function summary(user) {
  const brief = JSON.parse(user);
  const high = brief.risks.filter((r) => r.level === 'high').length;
  const recommendation = high === 0 ? 'участвовать' : high <= 3 ? 'участвовать с оговорками' : 'не участвовать';
  // поля приходят со статусом проверки: {value, status}
  const f = Object.fromEntries(Object.entries(brief.fields).map(([k, v]) => [k, v && typeof v === 'object' ? v.value ?? 'не найдено' : v]));
  return {
    summary: `[mock] Предмет: ${f['Предмет закупки']}. НМЦК: ${f['НМЦК']}. Срок поставки: ${f['Срок поставки / выполнения']}. Найдено рисков: ${brief.risks.length}, из них высоких: ${high}.`,
    recommendation,
    reasons: brief.risks.slice(0, 5).map((r) => `${r.type}: ${r.explanation}`),
  };
}

// Скоринг закупок: пересечение основ слов профиля и наименования + совпадение кодов и региона.
// Слова, которые есть почти в любой закупке, не говорят о соответствии профилю.
const COMMON_STEMS = new Set(['поста', 'закуп', 'оказа', 'услуг', 'выпол', 'работ', 'нужд', 'товар', 'обесп', 'приоб', 'госуд', 'муниц', 'учреж', 'для']);
const stems = (text) => new Set(
  (String(text || '').toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z0-9]{4,}/g) || [])
    .map((w) => w.slice(0, 5))
    .filter((s) => !COMMON_STEMS.has(s))
);

function score(user) {
  const { profile, tenders } = JSON.parse(user);
  const profileStems = stems(`${profile.description} ${(profile.keywords || []).join(' ')}`);
  return {
    results: tenders.map((t) => {
      const titleStems = [...stems(t.title)];
      const common = titleStems.filter((s) => profileStems.has(s));
      const ratio = titleStems.length ? common.length / titleStems.length : 0;
      const codeMatch = (profile.codes || []).length > 0
        && [...(t.okpd2 || []), ...(t.ktru || [])].some((c) => profile.codes.some((p) => c.startsWith(p)));
      const regionMatch = (profile.regions || []).includes(t.region);
      const value = Math.min(100, Math.round(15 + 70 * ratio + (codeMatch ? 15 : 0) + (regionMatch ? 5 : 0)));
      const reasons = [
        common.length
          ? `[mock] В наименовании есть слова из профиля: ${common.length} из ${titleStems.length}`
          : '[mock] В наименовании нет слов из описания профиля',
      ];
      if (codeMatch) reasons.push('[mock] Коды ОКПД2/КТРУ совпадают с профилем');
      if (regionMatch) reasons.push('[mock] Регион из профиля');
      const concerns = t.days_left != null && t.days_left < 3 ? ['[mock] Мало времени до окончания подачи заявок'] : [];
      return {
        number: t.number,
        score: value,
        verdict: value >= 70 ? 'подходит' : value >= 40 ? 'возможно' : 'не подходит',
        reasons,
        concerns,
      };
    }),
  };
}

// Потенциал перепродажи: базовая оценка, штрафы за работы/услуги и растянутые поставки, бонус за массовые товары.
const MASS_GOODS = /(бумаг|канцеляр|картридж|тонер|расходн|хозяйствен|моющ|бытов.. хим|компьютер|ноутбук|монитор|принтер|мфу|мебел|стул|стол|инструмент|спецодежд|перчат|посуд|электротовар|ламп|кабел|батаре)/;
const HARD = /(монтаж|установк|пусконалад|обучени|обслуживани|изготовлени|по заявкам|в течение года|ремонт)/;

function resale_score(user) {
  const { tenders } = JSON.parse(user);
  return {
    results: tenders.map((t) => {
      const title = String(t.title || '').toLowerCase().replace(/ё/g, 'е');
      let value = 50;
      const reasons = [];
      const concerns = [];
      if (MASS_GOODS.test(title)) { value += 25; reasons.push('[mock] массовый товар — его продают многие'); }
      if (HARD.test(title)) { value -= 30; reasons.push('[mock] кроме поставки нужны работы или поставка растянута'); }
      if (t.price != null && t.price < 30000) { value -= 20; reasons.push('[mock] маленькая НМЦК — заработок не окупит участие'); }
      if (!reasons.length) reasons.push('[mock] по наименованию нельзя уверенно судить о товаре');
      if (t.days_left != null && t.days_left < 3) concerns.push('[mock] мало времени до окончания подачи заявок');
      value = Math.max(0, Math.min(100, value));
      return { number: t.number, score: value, verdict: value >= 70 ? 'подходит' : value >= 40 ? 'возможно' : 'не подходит', reasons, concerns };
    }),
  };
}

// Позиции из текста ТЗ: строка «Наименование товара: …» и ближайшее «Количество: N».
function items(user) {
  const text = parseChunk(user).map((p) => p.text).join('\n');
  const out = [];
  const re = /Наименование(?: товара)?\s*:\s*([^\n]+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const after = text.slice(m.index, m.index + 600);
    const q = after.match(/Количество\s*:\s*(\d+(?:[.,]\d+)?)\s*([а-яa-z.]+)?/i);
    const chars = [...after.matchAll(/^([А-ЯЁ][^:\n]{2,60}):\s*([^\n]{1,120})$/gm)]
      .filter((c) => !/Наименование|Количество/i.test(c[1])).slice(0, 10)
      .map((c) => ({ name: c[1].trim(), value: c[2].trim().replace(/\.$/, '') }));
    out.push({
      name: m[1].trim().replace(/\.$/, ''),
      quantity: q ? Number(q[1].replace(',', '.')) : null,
      unit: q?.[2] ? q[2].replace(/штук\S*/i, 'шт') : null,
      characteristics: chars,
    });
  }
  return { items: out };
}

// Спецификация из ТЗ: «Наименование товара: …», строки «Характеристика: значение» после него, «или эквивалент».
function spec(user) {
  const { positions = [], documents = '' } = JSON.parse(user);
  const pages = parseChunk(documents);
  const out = [];
  for (const pg of pages) {
    const re = /Наименование(?: товара)?\s*:\s*([^\n]+)/gi;
    let m;
    while ((m = re.exec(pg.text))) {
      const after = pg.text.slice(m.index, m.index + 900);
      const block = after.split(/\n(?=Наименование)/i)[0];
      const name = m[1].trim().replace(/\.$/, '');
      const q = block.match(/Количество\s*:\s*(\d+(?:[.,]\d+)?)\s*([а-яa-z.]+)?/i);
      const lines = [...block.matchAll(/^([А-ЯЁ][^:\n]{2,60}):\s*([^\n]{1,120})$/gm)].filter((c) => !/Наименование|Количество/i.test(c[1]));
      const model = lines.find((c) => /модел|артикул/i.test(c[1]))?.[2].trim() || null;
      const brand = lines.find((c) => /производител|товарный знак|марка/i.test(c[1]))?.[2].trim() || null;
      const pack = block.match(/(\d+)\s*(?:листов|шт)\.?\s*в\s*(?:пачке|упаковке)/i);
      const stems = new Set((name.toLowerCase().match(/[а-яё]{4,}/g) || []).map((w) => w.slice(0, 5)));
      const pos = positions.find((p) => (String(p.name).toLowerCase().match(/[а-яё]{4,}/g) || []).some((w) => stems.has(w.slice(0, 5))));
      out.push({
        idx: pos ? pos.idx : null, name,
        quantity: q ? Number(q[1].replace(',', '.')) : null, unit: q?.[2] ? q[2].replace(/штук\S*/i, 'шт') : null,
        pack_qty: pack ? Number(pack[1]) : null,
        equivalent_allowed: /или эквивалент/i.test(block) ? true : model ? false : null,
        identity: { model, brand, compatible_with: null, standard: null },
        required: lines.filter((c) => !/модел|артикул|производител|товарный знак|марка/i.test(c[1])).slice(0, 15).map((c) => ({
          name: c[1].trim(), value: c[2].trim().replace(/\.$/, ''), unit: null, comparator: /не менее/i.test(c[2]) ? '>=' : /не более/i.test(c[2]) ? '<=' : '=',
          quote: `${c[1].trim()}: ${c[2].trim()}`, file: pg.file, page: pg.page,
        })),
      });
    }
  }
  return { items: out };
}

// «Тот же товар»: те же детерминированные правила, что в server/offers/spec.js.
function same_product(user) {
  const { sameProductDet } = require('../offers/spec');
  const { spec: s, candidates = [] } = JSON.parse(user);
  return {
    results: candidates.map((c) => {
      const r = sameProductDet(s, c.name);
      return { i: c.i, same: r.verdict === 'same' ? true : r.verdict === 'different' ? false : null, reason: `[mock] ${r.reason}` };
    }),
  };
}

// Предложение со страницы: первая цена с «₽/руб», заголовок — первая содержательная строка.
function offer(user) {
  const { page } = JSON.parse(user);
  const text = String(page?.text || '');
  const price = text.match(/(\d[\d\s]{0,9}(?:[.,]\d{1,2})?)\s*(?:₽|руб)/i);
  const inn = text.match(/ИНН\s*[:№]?\s*(\d{12}|\d{10})(?!\d)/i);
  const city = text.match(/(?:г\.|город)\s*([А-ЯЁ][а-яё-]+(?:\s[А-ЯЁ][а-яё-]+)?)/);
  const days = text.match(/доставк\S*[^.\n]{0,40}?(\d{1,2})\s*(?:раб\S*\s*)?дн/i);
  return {
    title: text.split('\n').map((s) => s.trim()).find((s) => s.length > 5) || '',
    price: price ? Number(price[1].replace(/\s/g, '').replace(',', '.')) : null,
    unit: 'шт', pack_qty: 1,
    availability: /в наличии/i.test(text) ? 'в наличии' : /под заказ/i.test(text) ? 'под заказ' : null,
    seller_name: null,
    seller_inn: inn ? inn[1] : null,
    seller_city: city ? city[1] : null,
    delivery_days: days ? Number(days[1]) : null,
    delivery_cost: null,
  };
}

// Сверка с ТЗ по каждому требованию: «да», если значение требования встречается в описании товара, иначе «?».
function match(user) {
  const { required, offer: o } = JSON.parse(user);
  const chars = required?.characteristics || [];
  const text = `${o?.title || ''} ${o?.text || ''}`.toLowerCase();
  const checks = {};
  chars.forEach((c, i) => {
    const key = String(c.value).toLowerCase().replace(/^(не менее|не более|более|менее|от|до)\s*/, '').split(/\s+/)[0];
    checks[String(c.n ?? i + 1)] = key && key.length > 1 && text.includes(key) ? `да: ${key}` : '?';
  });
  // Другой вид товара: услуга или запчасть «для» того, что в ТЗ.
  const need = String(required?.name || '').toLowerCase();
  const title = String(o?.title || '').toLowerCase();
  const other = /^(чип|заправка|ремонт|ракель|чехол|кабель)(?![а-яё])/.test(title.replace(/[^а-яёa-z ]/g, ' ').trim()) && !need.startsWith(title.split(/\s+/)[0]);
  return { kind: !other, checks };
}

// Подбор конкретных товаров под ТЗ: правила моделей не знают — честно возвращаем пустой список.
function models() {
  return { products: [] };
}

// Правовая проверка: по рискам из разбора — замечание со ссылкой на норму из переданного перечня (если она в нём есть).
const LEGAL_BY_RISK = {
  'заточка_под_поставщика': ['44-33-1-1', 'Допустить поставку эквивалентного товара: дополнить описание объекта закупки словами «или эквивалент» и указать параметры эквивалентности.'],
  'жёсткие_штрафы': ['44-34-8', 'Размер штрафа определяется в порядке, установленном Правительством Российской Федерации.'],
  'долгая_оплата': ['44-34-13.1', 'Оплата производится в срок не более 7 (семи) рабочих дней с даты подписания заказчиком документа о приёмке.'],
  'нестандартное_требование': [null, 'Исключить требование либо обосновать его необходимость.'],
};
function legal(user) {
  const input = JSON.parse(user);
  const known = new Set((input.norms || []).map((n) => n.id));
  const issues = [];
  for (const r of input.risks || []) {
    const rule = LEGAL_BY_RISK[r.type];
    if (!rule || r.level === 'low') continue;
    issues.push({ risk: r.n, field: null, condition: String(r.explanation).slice(0, 200), why: `[mock] условие спорное: ${String(r.type).replace(/_/g, ' ')}`,
      norm_id: rule[0] && known.has(rule[0]) ? rule[0] : null, proposal: rule[1], fatal: false });
  }
  return { issues, reasons: issues.length ? [`[mock] спорных условий: ${issues.length}`] : [] };
}

function create() {
  return {
    provider: 'mock',
    model: 'rules-v1',
    async complete({ messages, task }) {
      const user = messages[0].content;
      const handlers = { resolve, summary, score, resale_score, extract, items, offer, match, spec, same_product, models, legal };
      const data = (handlers[task] || extract)(user);
      return { text: JSON.stringify(data), finish: 'stop', model: 'rules-v1', usage: { in: 0, out: 0 } };
    },
  };
}

module.exports = { create };
