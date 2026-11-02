// Читатель документации по правилам — без нейросети. Заполняет те же поля карточки, что и нейросеть (analyze/fields.js):
// для каждого поля — устойчивые формулировки 44-ФЗ/223-ФЗ («в течение 10 рабочих дней», «пеня … одной трехсотой»,
// «обеспечение исполнения контракта … 5 %»). Значение берётся только с цитатой — дословным куском страницы, поэтому
// проверка цитат (verify.js) подтверждает его так же, как ответ нейросети. Не нашлось формулировки — поле «не найдено»,
// догадок нет. Официальные поля (номер, способ, сроки, обеспечение заявки, нацрежим, НМЦК) дополняет извещение ЕИС.
//
// Почему так: на 6 закупках (11.10.2026) правила нашли 32 из 33 позиций, нейросеть — 64%; с 26.10.2026 оплаченный
// пакет нейросети закончился, и все разборы падали. Нейросеть теперь — крайний случай (ANALYSIS_READER, см. index.js).
// Уроки сравнения с нейросетью на 20 закупках (29.10.2026): числа словами («десяти рабочих дней»), «с … по …»,
// «Оплачивается в течение …», НМЦК «55,570.00», обеспечение не из антидемпинговой оговорки, штраф «1 000 рублей».

const SENT_MAX = 700;

/** Предложение (кусок между точками, «;» и переводами строк) вокруг позиции в тексте — дословно, для цитаты. */
function sentenceAt(text, index, len = 0) {
  let from = index;
  while (from > 0 && index - from < SENT_MAX && !/[.;\n]/.test(text[from - 1])) from--;
  // «п. 5.1.», «ст. 34», «руб.» — не конец предложения
  let to = index + len;
  while (to < text.length && to - index < SENT_MAX && !(/[;\n]/.test(text[to]) || (text[to] === '.' && !/(\d|\s[пстч]|\sг|руб|коп)$/i.test(text.slice(Math.max(0, to - 4), to)) && /\s|$/.test(text[to + 1] || '')))) to++;
  return text.slice(from, to).replace(/^[\s,:–—-]+/, '').trim();
}

/**
 * Склеить строки, разорванные внутри предложения (PDF: «в течение 7 (семи) рабочих дней с⏎даты подписания»): иначе
 * срок и его ключевое слово оказываются в разных «предложениях». Не склеиваем: конец предложения (. ; : ! ?), новый
 * пункт («2.7.3.», «а)», «-», «•», «Статья»), строки таблиц (« | ») и пустые строки.
 */
function joinLines(text) {
  const lines = String(text || '').split('\n');
  let out = lines[0] || '';
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    const keep = !prev.trim() || !cur.trim() || /[.;:!?]\s*$/.test(prev) || prev.includes(' | ') || cur.includes(' | ')
      || /^\s*(?:\d+(?:\.\d+)*\.?\s|[а-яa-z]\)\s|[-•–—]\s|статья\s|раздел\s|глава\s)/i.test(cur);
    out += keep ? `\n${cur}` : ` ${cur.replace(/^\s+/, '')}`;
  }
  return out;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
const cut = (s, n = 300) => { const t = clean(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * Все совпадения шаблона по страницам документов.
 * @returns [{file, page, text: страница, index, match}]
 */
function findAll(docs, re, limit = 40) {
  const out = [];
  const g = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
  for (const d of docs) {
    for (const p of d.pages || []) {
      const text = p.text || '';
      for (const m of text.matchAll(g)) {
        out.push({ file: d.name, page: p.page, text, index: m.index, match: m });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

const field = (key, value, hit, quote) => ({ key, value: clean(value), source: { file: hit.file, page: hit.page, quote: cut(quote, 400) } });
const sentOf = (hit) => sentenceAt(hit.text, hit.index, hit.match[0].length);

// числа словами в сроках: «не позднее десяти рабочих дней» (длинные основы — раньше коротких)
const WORD_NUM = [['тридцат', 30], ['двадцат', 20], ['пятнадцат', 15], ['четырнадцат', 14], ['десят', 10], ['девят', 9], ['восьм', 8], ['сем', 7], ['шест', 6], ['пят', 5], ['четыр', 4], ['тр[её]х', 3], ['три', 3], ['двух', 2], ['два', 2], ['одн', 1]];
const WORDS = WORD_NUM.map(([w]) => `${w}[а-яё]*`).join('|');
/** «10» или «десяти» → 10 */
function dayNum(s) {
  const t = String(s || '').toLowerCase();
  if (/^\d/.test(t)) return Number(t);
  const hit = WORD_NUM.find(([w]) => new RegExp(`^${w}`).test(t));
  return hit ? hit[1] : NaN;
}
// число дней с видом: «10 (десяти) рабочих дней», «десяти рабочих дней», «30 календарных дней», «7 дней»
const DAYS = String.raw`(\d{1,3}|${WORDS})\s*(?:\([а-яё\s-]+\)\s*)?(рабоч[а-яё]*|календарн[а-яё]*)?\s*(?:дн[а-яё]*|сут[а-яё]*)`;
const DATE = String.raw`\d{1,2}\s*[.]\s*\d{1,2}\s*[.]\s*\d{2,4}|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+\d{4}`;
const PERCENT = String.raw`(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:\([а-яё\s,-]+\)\s*)?(?:%|процент)`;

/** Срок «в течение N дней …», «с … по …» или «до DATE» в предложении, где есть одно из ключевых слов. */
function termIn(docs, keyRe, key, { maxDays = 400, prefer = null, allowRefusal = false } = {}) {
  // сроки из статей о нарушениях, штрафах, претензиях и отказах — не те («в течение 30 дней со дня нарушения»)
  const OFF = /нарушени|неустойк|пен[ияюе](?![а-яё])|штраф|претензи|мотивированн[а-яё]* отказ|расторжени|гарантийн[а-яё]* срок|замен[а-яё]* товара/i;
  // у приёмки «либо мотивированный отказ» — часть той же фразы, её не отсеиваем
  const off = allowRefusal ? new RegExp(OFF.source.replace('|мотивированн[а-яё]* отказ', ''), 'i') : OFF;
  const hits = findAll(docs, keyRe, 80).filter((h) => !off.test(sentOf(h)));
  // предпочтительные формулировки — вперёд (оплата: «с даты подписания документа о приёмке»)
  if (prefer) hits.sort((a, b) => Number(!prefer.test(sentOf(a))) - Number(!prefer.test(sentOf(b))));
  for (const hit of hits) {
    const s = sentOf(hit);
    // «в течение 10 рабочих дней …» или сразу за названием: «Срок поставки товара: 10 календарных дней с даты …»
    const after = s.slice(Math.max(0, s.toLowerCase().indexOf(hit.match[0].toLowerCase())));
    const m = new RegExp(String.raw`(?:в течени[ея](?:\s+не более)?|не позднее|не более|в срок(?: не более)?|до)(?:\s+чем)?\s+(?<![\d])${DAYS}[^.;\n]{0,140}`, 'i').exec(s)
      || new RegExp(String.raw`(?<=^[^0-9]{0,80}[:—–-]\s*)${DAYS}[^.;\n]{0,140}`, 'i').exec(after);
    // «за 15 рабочих дней до истечения срока приёмки» — оговорка о сроке, а не сам срок
    if (m && dayNum(m[1]) <= maxDays && !/до истечени/i.test(m[0])) return field(key, m[0], hit, s);
    const span = new RegExp(String.raw`с\s+(?:${DATE})(?:\s*г\.?)?\s+по\s+(?:${DATE})(?:\s*г(?:ода|\.)?)?`, 'i').exec(s);
    if (span) return field(key, span[0], hit, s);
    // «начало срока поставки: 01.01.2027. окончание срока поставки: 31.12.2027.» — две строки подряд
    const from = Math.max(0, hit.index - 40);
    const se = new RegExp(String.raw`начал[а-яё]* срока[^:\n]{0,40}:\s*(${DATE})[\s\S]{0,40}?окончани[а-яё]* срока[^:\n]{0,40}:\s*(${DATE})`, 'i').exec(hit.text.slice(from, hit.index + 600));
    if (se) return field(key, `с ${se[1]} по ${se[2]}`, hit, hit.text.slice(from + se.index, from + se.index + se[0].length));
    const d = new RegExp(String.raw`(?:до|по|не позднее)\s+(?:${DATE})(?:\s*г(?:ода|\.)?)?[^.;\n]{0,80}`, 'i').exec(s);
    if (d) return field(key, d[0], hit, s);
  }
  return null;
}

/** Есть ли в предложении «не требуется / не установлено / не предусмотрено». */
const NOT_REQUIRED = /не (?:требуется|установлен|предусмотрен|устанавлива|предоставля)/i;

// ---------- поля ----------

const EXTRACTORS = {
  notice_number(docs) {
    const m = findAll(docs, /(?:извещени[а-яё]*|закупк[а-яё]*|реестров[а-яё]* номер)[^0-9\n]{0,40}(?:№\s*)?(\d{19}|\d{11})(?!\d)/i, 1)[0];
    return m ? field('notice_number', m.match[1], m, sentOf(m)) : null;
  },
  law(docs) {
    const m = findAll(docs, /(44|223)\s*-\s*ФЗ/i, 1)[0];
    return m ? field('law', `${m.match[1]}-ФЗ`, m, sentOf(m)) : null;
  },
  procurement_method(docs) {
    const m = findAll(docs, /электронн[а-яё]* аукцион[а-яё]*|запрос[а-яё]* котировок(?: в электронной форме)?|открыт[а-яё]* конкурс[а-яё]*(?: в электронной форме)?|запрос[а-яё]* предложений/i, 1)[0];
    if (!m) return null;
    const t = m.match[0].toLowerCase();
    const v = /аукцион/.test(t) ? 'электронный аукцион' : /котиров/.test(t) ? 'запрос котировок в электронной форме' : /конкурс/.test(t) ? 'открытый конкурс в электронной форме' : 'запрос предложений';
    return field('procurement_method', v, m, sentOf(m));
  },
  okpd_ktru(docs) {
    const hits = findAll(docs, /(?<![\d.])\d{2}\.\d{2}\.\d{2}\.\d{3}(?:-\d{8})?(?![\d])/, 60);
    if (!hits.length) return null;
    const codes = [...new Set(hits.map((h) => h.match[0]))].slice(0, 12);
    return field('okpd_ktru', codes.join(', '), hits[0], sentOf(hits[0]));
  },
  nmck(docs) {
    const SP = String.raw`[\s\u00a0\u202f]`;
    const NUM = String.raw`(\d{1,3}(?:${SP}\d{3}){1,3}(?:,\d{2})?|\d{1,3}(?:,\d{3})+\.\d{2}|\d+(?:[.,]\d{1,2})?)(?!\d)`;
    // полное название и сокращение («НМЦК составляет 39456 рублей», «Итого НМЦК, Российский рубль 34 860,00»).
    // Не первое упоминание, а первое с суммой: заголовок таблицы «Начальная (максимальная) цена контракта, руб. 1»
    // раньше обрывал поиск (обучение по ЕИС 30.10: 82 пропуска НМЦК, которая в документах есть)
    const full = findAll(docs, new RegExp(String.raw`начальн[а-яё]*\s*\(?максимальн[а-яё]*\)?\s*цен[а-яё]*(?:\s+контракта|\s+договора)?[^0-9\n]{0,120}?${NUM}`, 'i'), 40);
    // «Максимальное значение цены контракта: 108648» — так пишут при закупке по цене единицы
    const maxv = findAll(docs, new RegExp(String.raw`максимальн[а-яё]*\s+значени[а-яё]*\s+цены\s+(?:контракта|договора)[^0-9\n]{0,40}?${NUM}`, 'i'), 20);
    const abbr = findAll(docs, new RegExp(String.raw`(?:итого\s+)?н\s*\(?м\)?\s*ц\s*[кд](?![а-яё])[^0-9\n]{0,60}?${NUM}`, 'i'), 40);
    // «55,570.00» — запятая разделяет тысячи; «57 000,00» — запятая перед копейками
    const num = (raw) => (/,\d{3}\./.test(raw) ? Number(raw.replace(/,/g, '')) : Number(raw.replace(/[\s  ]/g, '').replace(',', '.')));
    // карточка площадки: «… максимальная цена, руб | 13115.00»
    const card = findAll(docs, /максимальная цена[^|\n]{0,20}\|\s*(\d+(?:[.,]\d{1,2})?)/i, 1)[0];
    if (card) return field('nmck', `${num(card.match[1]).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} руб.`, card, sentOf(card));
    // цена закупки — не меньше 100 ₽ и не больше 10 млрд (склеенные числа таблицы); «цена единицы» — не она
    // «обеспечение … 10% от начальной (максимальной) цены контракта, что составляет 9 772,82» — это доля цены, не она
    const share = (x) => /%|процент|обеспечени|аванс/i.test(String(x.text || '').slice(Math.max(0, x.index - 80), x.index));
    // «если НМЦК превышает 15 000 000» — порог из закона, «2026» — год, «№ 450» — номер приказа
    const notPrice = (x) => /превыша|более|менее|свыше|если|№\s*$|от\s*$|г\.\s*$/i.test(x.match[0].slice(0, x.match[0].length - x.match[1].length)) || /^(?:19|20)\d{2}$/.test(x.match[1]);
    const good = (x) => { const v = num(x.match[1]); return v >= 100 && v < 1e10 && !/единиц|за\s+ед|%|процент/i.test(x.match[0]) && !share(x) && !notPrice(x); };
    const said = (x) => /составля|устанавлива|в\s+размере/i.test(x.match[0]);
    // значение сразу за названием: «…цена контракта, руб. | 97 728,21», «НМЦК: 61 000» — между ними только «руб.»,
    // знаки и ячейки таблицы. Обучение по ЕИС 31.10: первое упоминание с числом было ценой единицы или номером строки
    // (58% верно по 343 закупкам)
    const gapOf = (x) => x.match[0].slice(0, x.match[0].length - x.match[1].length).replace(/^[\s\S]*?(?:цен[а-яё]*(?:\s+(?:контракта|договора))?|н\s*\(?м\)?\s*ц\s*[кд])/i, '');
    const direct = (x) => /^(?:[\s,.:;|()\-—–=]|руб[а-я]*\.?|₽|\(?нмц[кд]\)?|российск[а-яё]*|итого|составля[а-яё]*|в\s+размере)*$/i.test(gapOf(x));
    const pool = [...full, ...maxv, ...abbr].filter(good);
    const m = pool.find(said) || pool.find(direct) || full.find(good) || abbr.find(good);
    if (!m) return null;
    return field('nmck', `${num(m.match[1]).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} руб.`, m, sentOf(m));
  },
  currency(docs) {
    const m = findAll(docs, /российск[а-яё]* рубл[ьяей]+|рубл[ьяей]+ российской федерации/i, 1)[0];
    return m ? field('currency', 'российский рубль', m, sentOf(m)) : null;
  },
  bid_deadline(docs) {
    const m = findAll(docs, new RegExp(String.raw`(?:окончани[а-яё]* срока подачи заявок|срок окончания подачи заявок|подача заявок до|окончани[а-яё]* подачи (?:заявок|предложений))[^0-9\n]{0,60}(${DATE})(?:[^0-9\n]{0,10}(\d{1,2}[:.]\d{2}))?`, 'i'), 1)[0];
    return m ? field('bid_deadline', `${m.match[1]}${m.match[2] ? ` ${m.match[2]}` : ''}`, m, sentOf(m)) : null;
  },
  results_date(docs) {
    const m = findAll(docs, new RegExp(String.raw`(?:подведени[а-яё]* итогов|рассмотрени[а-яё]* заявок)[^0-9\n]{0,60}(${DATE})`, 'i'), 1)[0];
    return m ? field('results_date', m.match[1], m, sentOf(m)) : null;
  },
  delivery_term: (docs) => termIn(docs, /срок[а-яё]* (?:поставки|исполнения|выполнения)|период[а-яё]* поставки|поставк[а-яё]* (?:товара )?(?:осуществляется|производится|должна быть)|товар (?:должен быть )?постав[а-яё]+|поставщик (?:обязан )?постав[а-яё]+/i, 'delivery_term', { prefer: /заключени[а-яё]* (?:контракта|договора)|подписани[а-яё]* (?:контракта|договора)|заявк[а-яё]* заказчика|с даты/i }),
  delivery_place(docs) {
    for (const hit of findAll(docs, /мест[а-яё]* (?:поставки|доставки|выполнения)|адрес[а-яё]* (?:поставки|доставки)/i)) {
      const after = hit.text.slice(hit.index + hit.match[0].length, hit.index + hit.match[0].length + 300);
      const m = /^[^:\n]{0,40}[:—-]?\s*([^;\n]{12,250})/.exec(after);
      // адрес — с индексом, «г. Москва», «ул.», «шоссе»; «в соответствии с …» и строка про срок — не адрес
      // «обл. Иркутская, г.о. Ангарский, кв-л 222», «респ. Крым, … д. 58» (обучение по ЕИС 31.10: 80 пропусков места)
      if (m && /\d{6}|г\.\s*[А-ЯЁ]|город\s|ул\.|улиц|област|обл\.|респ\.|республик|край|р-н|район|г\.\s*о\.|кв-л|мкр|пгт|пос\.|д\.\s*\d|просп|пр-кт|шоссе|набережн|переул|проезд/i.test(m[1]) && !/срок|в течени|^в соответствии|^согласно|^а\./i.test(m[1].trim())) {
        return field('delivery_place', m[1].replace(/[.,]\s*$/, ''), hit, `${hit.match[0]}${after.slice(0, m.index + m[0].length)}`);
      }
    }
    return null;
  },
  delivery_mode(docs) {
    const one = findAll(docs, /единовременн[а-яё]*|одной партией|единой партией|в полном объ[её]ме (?:в течение|не позднее)/i, 1)[0];
    const parts = findAll(docs, /партиями|по заявк[а-яё]* заказчика|график[а-яё]* поставки|поэтапн[а-яё]*/i, 1)[0];
    const hit = parts || one;
    if (!hit) return null;
    const s = sentOf(hit);
    const v = parts ? (/по заявк/i.test(s) ? 'партиями по заявкам заказчика' : /график/i.test(s) ? 'по графику поставки' : 'партиями') : 'единовременно, одной партией';
    return field('delivery_mode', v, hit, s);
  },
  delivery_conditions(docs) {
    const hits = findAll(docs, /разгрузк[а-яё]*|погрузочно-разгрузочн[а-яё]*|подъ[её]м[а-яё]* (?:на этаж|товара)|занос[а-яё]* в помещени|сборк[а-яё]* (?:и установк|мебели|товара)|вывоз[а-яё]* (?:упаковки|тары|мусора)/i, 6);
    if (!hits.length) return null;
    const what = [...new Set(hits.map((h) => h.match[0].toLowerCase().replace(/ё/g, 'е').replace(/(разгрузк|погрузочно-разгрузочн|подъем|занос|сборк|вывоз)[а-яё]*/, '$1')))];
    const label = { разгрузк: 'разгрузка', 'погрузочно-разгрузочн': 'погрузочно-разгрузочные работы', подъем: 'подъём', занос: 'занос в помещение', сборк: 'сборка', вывоз: 'вывоз упаковки' };
    const named = [...new Set(what.map((w) => label[w.split(' ')[0]] || w))].slice(0, 4);
    return field('delivery_conditions', `силами поставщика: ${named.join(', ')}`, hits[0], sentOf(hits[0]));
  },
  acceptance_term: (docs) => termIn(docs, /при[её]мк[аиу]|при[её]мочн[а-яё]*|подписыва[а-яё]* документ[а-яё]* о при[её]мке/i, 'acceptance_term', { maxDays: 60, allowRefusal: true, prefer: /осуществля[а-яё]* при[её]мк|подписыва[а-яё]* документ[а-яё]* о при[её]мке|при[её]мк[а-яё]* товара/i }),
  contract_term(docs) {
    // дата важнее «до полного исполнения обязательств»: ищем её первой
    const m = findAll(docs, new RegExp(String.raw`(?:контракт|договор)[^.;\n]{0,120}?действует[^.;\n]{0,60}?(?:до|по)\s+(?:${DATE})`, 'i'), 1)[0]
      || findAll(docs, new RegExp(String.raw`срок[а-яё]* действия (?:контракта|договора)[^.;\n]{0,60}?(?:до|по)\s+(?:${DATE})`, 'i'), 1)[0]
      || findAll(docs, new RegExp(String.raw`срок[а-яё]* исполнения (?:контракта|договора)(?: сторонами)?\s*[:—–-]\s*(?:до\s+)?(?:${DATE})`, 'i'), 1)[0]
      || findAll(docs, /(?:контракт|договор)\s+(?:вступает в силу[^.]{0,80}?\s+и\s+)?действует\s+(?:до|по)\s+полного исполнения[^.;\n]{0,80}/i, 1)[0];
    if (!m) return null;
    const dt = new RegExp(String.raw`(?:(?:до|по)\s+)?(?:${DATE})(?:\s*г(?:ода|\.)?)?`, 'i').exec(m.match[0])?.[0];
    const v = dt ? (/^(до|по)\s/i.test(dt) ? dt : `до ${dt}`) : m.match[0].replace(/^.*?действует\s+/i, '');
    return field('contract_term', v, m, sentOf(m));
  },
  bid_security(docs) {
    for (const hit of findAll(docs, /обеспечени[а-яё]* (?:заявк|участи)[а-яё]*/i, 10)) {
      const s = sentOf(hit);
      if (NOT_REQUIRED.test(s)) return field('bid_security', 'не требуется', hit, s);
      const p = new RegExp(PERCENT, 'i').exec(s);
      if (p) return field('bid_security', `${p[1].replace('.', ',')}% от начальной цены`, hit, s);
    }
    return null;
  },
  contract_security(docs) {
    for (const hit of findAll(docs, /обеспечени[а-яё]* исполнени[а-яё]* (?:контракта|договора)/i, 12)) {
      const s = sentOf(hit);
      // «если цена снижена на 25 % и более — обеспечение в полтора раза больше» — это не размер обеспечения
      if (/снижен|демпинг|стать[а-яё]* 37|ст\. ?37/i.test(s)) continue;
      if (NOT_REQUIRED.test(s)) return field('contract_security', 'не требуется', hit, s);
      const p = new RegExp(String.raw`(?:в размере|составляет|размер[а-яё]*[^.;\n]{0,40}?)\s*${PERCENT}`, 'i').exec(s);
      if (p && Number(p[1].replace(',', '.')) <= 30) return field('contract_security', `${p[1].replace('.', ',')}% от цены контракта`, hit, s);
    }
    return null;
  },
  warranty_security(docs) {
    for (const hit of findAll(docs, /обеспечени[а-яё]* гарантийн[а-яё]* обязательств/i, 8)) {
      const s = sentOf(hit);
      if (NOT_REQUIRED.test(s)) return field('warranty_security', 'не требуется', hit, s);
      const p = new RegExp(String.raw`(?:в размере|составляет)\s*${PERCENT}`, 'i').exec(s);
      if (p) return field('warranty_security', `${p[1].replace('.', ',')}% от начальной цены`, hit, s);
    }
    return null;
  },
  advance(docs) {
    for (const hit of findAll(docs, /аванс[а-яё]*/i, 10)) {
      const s = sentOf(hit);
      if (/не (?:предусмотрен|выплачива|установлен|осуществля)|без (?:выплаты )?аванс|нет аванс|аванс[а-яё]*\s*[:|—-]?\s*(?:нет|отсутству|не предусм)/i.test(s)) return field('advance', 'не предусмотрен', hit, s);
      const p = new RegExp(String.raw`(?:в размере|составляет)\s*${PERCENT}`, 'i').exec(s);
      if (p) return field('advance', `${p[1].replace('.', ',')}%`, hit, s);
    }
    return null;
  },
  payment_terms: (docs) => termIn(docs, /оплат[аыуе](?![а-яё])|срок[а-яё]* оплаты|оплачива[а-яё]*|расч[её]т[а-яё]* (?:с поставщиком|по контракту|за поставленн)/i, 'payment_terms', { maxDays: 120, prefer: /при[её]мк|подписани|акт[а-яё]* |упд|счет[а-яё]*-фактур|документ[а-яё]* о при/i }),
  penalties(docs) {
    const peni = findAll(docs, /одн(?:ой|а)\s+трехсот(?:ой|ая)|1\/300/i, 1)[0];
    const daily = findAll(docs, new RegExp(String.raw`(?:пен[а-яё]*|штраф[а-яё]*)[^.;\n]{0,80}?${PERCENT}[^.;\n]{0,60}?за каждый день`, 'i'), 2);
    const fines = findAll(docs, new RegExp(String.raw`штраф[а-яё]*[^.;\n]{0,160}?${PERCENT}\s*цены (?:контракта|договора)`, 'i'), 6);
    const fixed = findAll(docs, /штраф[а-яё]*[^.;\n]{0,120}?(?<![\d\s])\s(\d{1,3}(?:[\s ]\d{3})+|\d+)(?:[.,]\d{2})?\s*(?:\([а-яё\s]+\)\s*)?руб/i, 3);
    if (!peni && !daily.length && !fines.length && !fixed.length) return null;
    const parts = [];
    if (peni) parts.push('пеня — 1/300 ключевой ставки ЦБ РФ за каждый день просрочки');
    else if (daily.length) parts.push(`${daily[0].match[1].replace('.', ',')}% за каждый день просрочки`);
    const pct = [...new Set(fines.map((f) => `${f.match[1].replace('.', ',')}%`))];
    if (pct.length) parts.push(`штраф — ${pct.join(', ')} цены контракта`);
    else if (fixed.length) parts.push(`штраф — ${[...new Set(fixed.map((f) => `${f.match[1].replace(/[\s ]/g, ' ')} руб.`))].join(', ')}`);
    const hit = peni || daily[0] || fines[0] || fixed[0];
    return field('penalties', parts.join('; '), hit, sentOf(hit));
  },
  termination(docs) {
    const m = findAll(docs, /односторонн[а-яё]* отказ[а-яё]* (?:от исполнения )?(?:контракта|договора)?|расторжени[а-яё]* (?:контракта|договора)/i, 1)[0];
    return m ? field('termination', 'предусмотрены расторжение и односторонний отказ от исполнения', m, sentOf(m)) : null;
  },
  participant_requirements(docs) {
    const checks = [
      [/(?:только|исключительно)[^.;\n]{0,60}субъект[а-яё]* малого предпринимательства|участниками[^.;\n]{0,40}могут являться только субъект|ограничени[а-яё]* участия[^.;\n]{0,80}(?:СМП|субъект)/i, 'только субъекты малого предпринимательства и СОНКО'],
      [/лицензи[а-яё]*/i, 'лицензия'],
      [/саморегулируем[а-яё]* организаци|членств[а-яё]* в СРО/i, 'членство в СРО'],
      [/опыт[а-яё]* исполнени[а-яё]* (?:контракта|договора)/i, 'опыт исполнения контрактов'],
      [/реестр[а-яё]* недобросовестных поставщиков/i, 'нет в реестре недобросовестных поставщиков'],
      [/регистрационн[а-яё]* удостоверени/i, 'регистрационное удостоверение на товар'],
      [/пункт[а-яё]* 3\s*[-–]\s*5,?\s*7\s*[-–]\s*11|п\.\s*п\.\s*3\s*-\s*5,\s*7\s*-\s*11/i, 'единые требования ст. 31 44-ФЗ (декларация)'],
    ];
    const found = [];
    let first = null;
    for (const [re, label] of checks) {
      const h = findAll(docs, re, 1)[0];
      if (h) { found.push(label); first = first || h; }
    }
    return first ? field('participant_requirements', found.join('; '), first, sentOf(first)) : null;
  },
  application_composition(docs) {
    const checks = [
      [/предложени[а-яё]* участника[^.;\n]{0,60}(?:объекта закупки|в отношении)|характеристик[а-яё]* предлагаем[а-яё]* товара/i, 'предложение участника о товаре (характеристики)'],
      [/наименовани[а-яё]* страны происхождения|страна происхождения товара/i, 'страна происхождения товара'],
      [/деклараци[а-яё]* о соответствии|декларирование/i, 'декларация о соответствии требованиям'],
      [/выписк[а-яё]* из реестр[а-яё]* российской промышленной продукции|номер реестровой записи/i, 'номер реестровой записи (для нацрежима)'],
      [/регистрационн[а-яё]* удостоверени/i, 'регистрационное удостоверение'],
      [/ценов[а-яё]* предложени|предложени[а-яё]* о цене/i, 'ценовое предложение'],
    ];
    const found = [];
    let first = null;
    for (const [re, label] of checks) {
      const h = findAll(docs, re, 1)[0];
      if (h) { found.push(label); first = first || h; }
    }
    return first ? field('application_composition', found.join('; '), first, sentOf(first)) : null;
  },
  national_regime(docs) {
    for (const hit of findAll(docs, /1875|национальн[а-яё]* режим/i, 10)) {
      const s = sentOf(hit);
      const kinds = [/запрет/i.test(s) && 'запрет', /ограничени/i.test(s) && 'ограничение', /преимуществ/i.test(s) && 'преимущество'].filter(Boolean);
      if (kinds.length) return field('national_regime', `${kinds.join(', ')} (ПП РФ № 1875)`, hit, s);
      // «не установлен» — только если отрицание относится к самому нацрежиму
      if (/не (?:установлен|применя|предусмотрен)[а-яё]*[^.;\n]{0,40}(?:национальн|1875)|(?:национальн|1875)[^.;\n]{0,60}не (?:установлен|применя|предусмотрен)/i.test(s)) return field('national_regime', 'не установлен', hit, s);
      if (/предоставля[а-яё]* национальн|национальн[а-яё]* режим[а-яё]* (?:установлен|предоставля|применя)/i.test(s)) return field('national_regime', 'национальный режим (ПП РФ № 1875) — меры по позициям смотрите в извещении', hit, s);
    }
    return null;
  },
  evaluation_criteria(docs) {
    const hits = findAll(docs, new RegExp(String.raw`(цен[а-яё]* (?:контракта|договора)|квалификаци[а-яё]* участник[а-яё]*|качествен[а-яё]*[^.;\n]{0,40}характеристик[а-яё]*)[^.;\n]{0,80}?(?:значимост[а-яё]*|вес)[^0-9\n]{0,30}${PERCENT}`, 'i'), 6);
    if (!hits.length) return null;
    const parts = [...new Set(hits.map((h) => `${clean(h.match[1]).toLowerCase()} — ${h.match[2].replace('.', ',')}%`))];
    return field('evaluation_criteria', parts.join('; '), hits[0], sentOf(hits[0]));
  },
  subject(docs) {
    const m = findAll(docs, /(?:предмет[а-яё]* (?:контракта|договора|закупки)|объект[а-яё]* закупки)\s*[:—–-]?\s*(?:является\s+)?(поставка[^.;\n]{5,200})/i, 1)[0];
    if (m) return field('subject', m.match[1], m, sentOf(m));
    const card = findAll(docs, /наименование закупки(?:\s*\([^)\n]*\))?\s*\|\s*([^\n]{5,200})/i, 1)[0];
    return card ? field('subject', card.match[1], card, sentOf(card)) : null;
  },
  customer(docs) {
    const m = findAll(docs, /заказчик\s*[:—–-]\s*((?:[А-ЯЁ]{2,}[^\n;]{0,10}\s)?[^\n;]{8,200}?)(?:,\s*ИНН\s*(\d{10}))?(?=[\n;]|,\s*ИНН|$)/, 1)[0];
    if (m) return field('customer', `${m.match[1]}${m.match[2] ? `, ИНН ${m.match[2]}` : ''}`, m, sentOf(m));
    const card = findAll(docs, /наименование организации\s*\|\s*([^\n]{3,200})/i, 1)[0];
    if (!card) return null;
    const inn = findAll(docs, /ИНН организации\s*\|\s*(\d{10}|\d{12})/i, 1)[0];
    return field('customer', `${card.match[1].trim()}${inn ? `, ИНН ${inn.match[1]}` : ''}`, card, sentOf(card));
  },
};

// ---------- риски по найденным значениям ----------

const daysOf = (v) => { const m = new RegExp(DAYS, 'i').exec(String(v || '')); return m ? { n: dayNum(m[1]), work: /рабоч/i.test(m[2] || '') } : null; };

/** Риски правилами: короткий срок поставки, долгая оплата, большое обеспечение, запрет иностранного, подъём/сборка. */
function rulesRisks(byKey) {
  const risks = [];
  const add = (type, level, explanation, f) => risks.push({ type, level, explanation, source: f?.source || null });
  const dt = byKey.delivery_term && daysOf(byKey.delivery_term.value);
  if (dt && dt.n <= (dt.work ? 5 : 7)) add('короткий_срок', dt.n <= 3 ? 'high' : 'medium', `Короткий срок поставки: ${byKey.delivery_term.value} — товар должен быть в наличии у поставщика`, byKey.delivery_term);
  const pt = byKey.payment_terms && daysOf(byKey.payment_terms.value);
  if (pt && pt.n > (pt.work ? 10 : 15)) add('долгая_оплата', pt.n > 30 ? 'high' : 'medium', `Оплата не скоро: ${byKey.payment_terms.value} — учтите заморозку денег`, byKey.payment_terms);
  const cs = byKey.contract_security && /(\d+(?:,\d+)?)%/.exec(byKey.contract_security.value);
  if (cs && Number(cs[1].replace(',', '.')) >= 10) add('нестандартное_требование', 'medium', `Обеспечение исполнения контракта ${cs[1]}% — заметная сумма на время исполнения`, byKey.contract_security);
  if (byKey.national_regime && /запрет/.test(byKey.national_regime.value)) add('нестандартное_требование', 'medium', 'Нацрежим: запрет иностранных товаров — нужен товар из реестра российской продукции', byKey.national_regime);
  if (byKey.delivery_conditions && /подъём|сборка|занос/.test(byKey.delivery_conditions.value)) add('другое', 'low', `Дополнительные работы при поставке: ${byKey.delivery_conditions.value.replace(/^силами поставщика: /, '')} — заложите в расходы`, byKey.delivery_conditions);
  return risks;
}

/**
 * Прочитать документы правилами.
 * @param docs [{name, pages: [{page, text}]}] — прочитанные файлы
 * @returns {{fields: [{key, value, source}], risks: [{type, level, explanation, source}], questions: []}} — в том же
 *   виде, что ответ нейросети по фрагменту (analyze/index.js), чтобы дальше всё шло тем же путём
 */
function readByRules(docs) {
  docs = docs.map((d) => ({ ...d, pages: (d.pages || []).map((pg) => ({ ...pg, text: joinLines(pg.text) })) }));
  const fields = [];
  const byKey = {};
  for (const [key, fn] of Object.entries(EXTRACTORS)) {
    let f = null;
    try { f = fn(docs); } catch { f = null; }
    if (f && f.value) { fields.push(f); byKey[key] = f; }
  }
  return { fields, risks: rulesRisks(byKey), questions: [] };
}

module.exports = { readByRules, EXTRACTORS, sentenceAt, joinLines, rulesRisks, dayNum };
