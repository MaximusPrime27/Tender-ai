// Прицельный дочит: поля, которые основной проход не нашёл, ищутся ещё раз — по выдержкам вокруг ключевых слов.
// Основной проход отдаёт нейросети куски по ~8 страниц, и она выписывает из куска лишь несколько полей: пени и
// расторжение в 14-страничном проекте контракта терялись (закупка 0372100041126000094, 17.10.2026). Здесь в запрос
// идут только абзацы со словами «пеня», «расторжение», «приёмка»… — короткий текст и вопрос только про эти поля.
// Выдержки — дословный текст страниц с той же разметкой «файл + страница», поэтому цитаты проверяются как обычно.

// Ключевые слова полей. Нет слов в тексте — поле в дочит не идёт: спрашивать не о чем.
const TARGETS = {
  // \b после русской буквы в JavaScript не работает — граница слова через (?![а-яё])
  penalties: /пен[яиюе](?![а-яё])|пеней|неустойк|штраф/i,
  termination: /односторонн[а-яё]* отказ|расторжени|расторгнут/i,
  advance: /аванс/i,
  bid_security: /обеспечени[а-яё]* заявк/i,
  contract_security: /обеспечени[а-яё]* исполнени/i,
  warranty_security: /обеспечени[а-яё]* гарантийн/i,
  payment_terms: /оплат[аыу] .{0,60}(дн|рабоч)|срок оплаты|расч[её]ты между/i,
  delivery_term: /срок поставки|срок исполнени|поставк[аи] .{0,40}(дн|до \d)/i,
  delivery_place: /место поставки|адрес поставки|место доставки/i,
  national_regime: /1875|национальн[а-яё]* режим|происхождени[а-яё]* товар/i,
  evaluation_criteria: /критери[а-яё]* оценк/i,
  acceptance_term: /при[её]мк[аиу]?.{0,80}(дн|рабоч)/i,
  contract_term: /действует до|срок действия контракта|вступает в силу/i,
  delivery_mode: /единоврем|партиями|по заявк[аеам]|график поставк/i,
  delivery_conditions: /разгруз|подъ[её]м|погрузо|лифт|сборк[аи] (и|мебели)|вывоз упаковк/i,
};
const WINDOW_BEFORE = 500;
const WINDOW_AFTER = 1100;
const MAX_CHARS_PER_CALL = 14000;
const MAX_CALLS = 3;

const header = (file, page) => `<<<ФАЙЛ: ${file} | СТРАНИЦА: ${page}>>>`;

/** Выдержки по ключевым словам поля: окна вокруг совпадений, слитые внутри страницы. */
function snippetsFor(re, docs) {
  const out = [];
  const g = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
  for (const d of docs) {
    for (const p of d.pages || []) {
      const text = p.text || '';
      const spans = [];
      for (const m of text.matchAll(g)) {
        const from = Math.max(0, m.index - WINDOW_BEFORE);
        const to = Math.min(text.length, m.index + m[0].length + WINDOW_AFTER);
        const last = spans[spans.length - 1];
        if (last && from <= last.to) last.to = Math.max(last.to, to); else spans.push({ from, to });
        if (spans.length >= 4) break;
      }
      for (const s of spans) out.push({ file: d.name, page: p.page, text: text.slice(s.from, s.to) });
    }
  }
  return out;
}

/**
 * Какие поля дочитать и с какими выдержками.
 * @param missing ключи полей, которые основной проход не нашёл
 * @returns [{keys: string[], text: string}] — до MAX_CALLS запросов
 */
function planTargeted(missing, docs) {
  const items = [];
  for (const key of missing) {
    const re = TARGETS[key];
    if (!re) continue;
    const sn = snippetsFor(re, docs);
    if (sn.length) items.push({ key, sn });
  }
  const calls = [];
  let cur = null;
  for (const it of items) {
    const body = it.sn.map((s) => `${header(s.file, s.page)}\n${s.text}`).join('\n\n').slice(0, MAX_CHARS_PER_CALL);
    if (!cur || cur.text.length + body.length > MAX_CHARS_PER_CALL) {
      if (calls.length >= MAX_CALLS) break;
      cur = { keys: [], text: '' };
      calls.push(cur);
    }
    cur.keys.push(it.key);
    // одинаковые выдержки (одно место отвечает на два поля) второй раз не добавляем
    for (const s of it.sn) { const block = `${header(s.file, s.page)}\n${s.text}`; if (!cur.text.includes(s.text.slice(0, 200))) cur.text += `${cur.text ? '\n\n' : ''}${block}`; }
    cur.text = cur.text.slice(0, MAX_CHARS_PER_CALL);
  }
  return calls;
}

module.exports = { TARGETS, planTargeted, snippetsFor };
