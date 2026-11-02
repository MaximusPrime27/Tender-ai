// Обучение читателя по правилам: извещение ЕИС — учитель.
//   • grade — сверка того, что прочитали правила, с официальными сведениями извещения: совпало / не то / не нашёл;
//   • anchorsFrom — где правила ошиблись или не нашли, а значение из ЕИС есть в документе: запомнить 2–5 слов перед
//     ним («размер обеспечения исполнения контракта составляет») — «опору»;
//   • applyAnchors — в закупках без извещения (коммерческие, с ЕАТ, 223-ФЗ без сведений) по опорам найти поле, которое
//     правила не нашли. Каждая опора проверяется следующими закупками с извещением: верно → hits, неверно → fails;
//     опора в работе, пока hits > fails (server/agents/reader.js).

const { joinLines, sentenceAt } = require('./rules');

// поля, по которым извещение ЕИС — точный ответ, и как их сравнивать
const GRADED = { nmck: 'money', bid_security: 'share', contract_security: 'share', delivery_place: 'text', bid_deadline: 'date' };
const NONE = /не\s*(?:требуется|установлен|предусмотрен|устанавлива|предоставля)/i;

const nums = (s) => (String(s || '').replace(/(\d)[\s ](?=\d{3}\b)/g, '$1').match(/\d+(?:[.,]\d+)?/g) || []).map((x) => Number(x.replace(',', '.')));
const words = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z0-9]{3,}/g) || [];

function same(kind, a, b) {
  if (NONE.test(a) || NONE.test(b)) return NONE.test(a) === NONE.test(b);
  if (kind === 'text') {
    const wb = new Set(words(b));
    const wa = words(a);
    return wb.size > 0 && wa.filter((w) => wb.has(w)).length >= Math.min(wb.size, 3) * 0.6;
  }
  const nb = nums(b);
  const na = nums(a);
  if (!nb.length) return false;
  if (kind === 'date') return nb.slice(0, 3).every((n) => na.includes(n));
  // деньги и доли: главное число извещения (сумма или процент) есть в прочитанном
  const main = kind === 'share' && /%/.test(b) ? Number(/(\d+(?:[.,]\d+)?)\s*%/.exec(b)?.[1]?.replace(',', '.')) : Math.max(...nb);
  return na.some((n) => Math.abs(n - main) < 0.005 * Math.max(1, main));
}

/**
 * docs — документы закупки: «не нашёл» засчитывается, только если значение из ЕИС в них есть; нет в документах
 * (НМЦК и срок подачи часто только в извещении) — 'absent', это не ошибка читателя.
 * @returns {Array<{key, result:'agree'|'mismatch'|'missed'|'absent', rules?, eis}>}
 */
function grade(fields, facts = {}, docs = null) {
  const out = [];
  for (const [key, kind] of Object.entries(GRADED)) {
    const eis = facts[key];
    if (!eis) continue;
    const f = fields.find((x) => x.key === key && x.value);
    if (!f) out.push({ key, result: docs && !inDocs(docs, key, eis) ? 'absent' : 'missed', eis });
    else out.push({ key, result: same(kind, f.value, eis) ? 'agree' : 'mismatch', rules: String(f.value).slice(0, 200), eis, learned: f.learned || null });
  }
  return out;
}

function texts(docs) {
  return docs.flatMap((d) => (d.pages || []).map((p) => ({ file: d.id ?? d.name, name: d.name, page: p.page, text: joinLines(p.text || '') })));
}

function inDocs(docs, key, eis) {
  if (NONE.test(eis)) return false; // «не требуется» в документах ищется плохо — не считаем пропуск ошибкой
  const ns = needles(key, eis);
  if (!ns.length) return true; // сравнить не с чем (место поставки) — считаем, что в документах есть
  return texts(docs).some((t) => ns.some((re) => re.test(t.text)));
}

// смысловые слова поля: опора без них — случайные слова рядом с числом (названия товаров в таблице)
const MEANING = { nmck: /(?:^|\s)(?:цен|нмцк|нмцд|стоимост|сумм)/, bid_security: /(?:^|\s)обеспеч/, contract_security: /(?:^|\s)обеспеч/, bid_deadline: /(?:^|\s)(?:заяв|подач|окончан)/, delivery_place: /(?:^|\s)(?:мест|адрес|поставк|доставк)/ };

/** Образцы, как значение из ЕИС может быть записано в документе. */
function needles(key, eis) {
  const v = String(eis);
  if (GRADED[key] === 'share' && /%/.test(v)) {
    const p = /(\d+(?:[.,]\d+)?)\s*%/.exec(v)[1];
    return [new RegExp(`(?<![\\d.,])${p.replace(/[.,]/, '[.,]')}\\s*(?:\\([а-яё\\s,-]+\\)\\s*)?(?:%|процент)`, 'i')];
  }
  if (GRADED[key] === 'money' || GRADED[key] === 'share') {
    const n = Math.max(...nums(v));
    if (!(n >= 1000)) return [];
    const int = String(Math.floor(n));
    const spaced = int.replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s\\u00a0.]?');
    return [new RegExp(`(?<!\\d)${spaced}(?:[.,]\\d{2})?(?!\\d)`)];
  }
  if (GRADED[key] === 'date') {
    const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(v);
    if (m) return [new RegExp(`(?<!\\d)0?${Number(m[1])}\\s*\\.\\s*0?${Number(m[2])}\\s*\\.\\s*(?:${m[3]}|${m[3].slice(2)})(?!\\d)`)];
  }
  return [];
}

/** Опоры для поля: 2–5 слов перед значением в его предложении (без цифр). */
function anchorsFrom(docs, key, eis, limit = 3) {
  const out = new Set();
  for (const t of texts(docs)) {
    for (const re of needles(key, eis)) {
      const m = re.exec(t.text);
      if (!m) continue;
      const sent = sentenceAt(t.text, m.index, m[0].length);
      const before = sent.slice(0, Math.max(0, sent.indexOf(m[0]))).toLowerCase().replace(/ё/g, 'е');
      const w = before.match(/[а-яa-z]{3,}/g) || [];
      // хвост «в размере», «в сумме», «составляет» — слова формы записи, а не смысла: в другой закупке их может не быть
      while (w.length && /^(размере|сумме|составля[а-я]*|равн[а-я]*|процент[а-я]*|рубл[а-я]*|сумма|итого|под|для|при)$/.test(w[w.length - 1])) w.pop();
      const anchor = w.slice(-5);
      if (anchor.length < 2 || !MEANING[key]?.test(anchor.join(' '))) continue;
      out.add(anchor.join(' '));
      if (out.size >= limit) return [...out];
    }
  }
  return [...out];
}

/** Поля по опорам — только те, что правила не нашли. anchors: [{key, anchor}] */
function applyAnchors(docs, anchors, foundKeys = new Set()) {
  const fields = [];
  const pages = texts(docs);
  for (const a of anchors) {
    if (foundKeys.has(a.key) || fields.some((f) => f.key === a.key)) continue;
    const parts = a.anchor.split(' ');
    const re = new RegExp(parts.map((w) => w.replace(/е/g, '[её]')).join('[^а-яёa-z0-9]+(?:[а-яёa-z]+[^а-яёa-z0-9]+){0,1}'), 'i');
    for (const t of pages) {
      const m = re.exec(t.text);
      if (!m) continue;
      const sent = sentenceAt(t.text, m.index, m[0].length);
      const tail = t.text.slice(m.index + m[0].length, m.index + m[0].length + 80);
      // значение — сразу после опоры: в первых 80 знаках должно быть число (или «не требуется»)
      if (!/\d/.test(tail) && !NONE.test(tail)) continue;
      fields.push({ key: a.key, value: sent.slice(0, 300), status: 'found', learned: a.anchor, source: { file: t.name, page: t.page, quote: sent.slice(0, 300) } });
      break;
    }
  }
  return fields;
}

module.exports = { grade, anchorsFrom, applyAnchors, same, GRADED };
