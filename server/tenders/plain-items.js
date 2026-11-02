// Позиции из документов без привычной таблицы — без нейросети (этап 3 пакета «автономность», 31.10.2026).
// Разбор закупок, добавленных вручную: файлы читались, но таблицу старого .doc текст отдаёт через табуляцию, а ячейка
// «Принт-картридж ⏎ (054(Н), Black)» рвёт строку; лист характеристик одного товара вообще не таблица. Правила их не видели,
// дальше шла нейросеть, без оплаты она молчит, и вместо 23 картриджей появлялась заглушка «Закупка из документов».

const QTY = /^кол\s*-?\s*во|^кол\.?$|количеств/i;
const NAME = /^наименован/i;
const NAME_OK = /наименован\S*\s+(?:товар|услуг|объект|продукц|позици|предмет|издели|матер)/i;
const SECTION = /(?:данные|характеристики|параметры|система|измерения|комплектация|сведения)\.?$/i;

const splitTab = (line) => {
  const cells = line.split('\t').map((c) => c.replace(/\s+/g, ' ').trim());
  while (cells.length && !cells.at(-1)) cells.pop();
  return cells;
};
const isHead = (cells) => cells.length >= 3 && cells.some((c) => NAME.test(c)) && cells.some((c) => QTY.test(c) && c.length < 60);
// столбец с названием любого товара подходит: «Наименование картриджа» — это тоже название
const headCells = (cells) => cells.map((c) => (NAME.test(c) && !NAME_OK.test(c) ? 'Наименование товара' : c));

/** Таблица через табуляцию → строки с « | », ячейка с переносом склеивается. Остальной текст не меняется. */
function tabTablesToPipes(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = splitTab(lines[i]);
    if (!isHead(head)) { out.push(lines[i]); continue; }
    const width = head.length;
    out.push('', headCells(head).join(' | '));
    let buf = '';
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || (!buf && !line.includes('\t'))) break;
      buf = buf ? `${buf} ${line}` : line;
      const cells = splitTab(buf);
      if (cells.length >= width) { out.push(cells.join(' | ')); buf = ''; }
    }
    out.push('');
    i = j - 1;
  }
  return out.join('\n');
}
const withTabTables = (doc) => ({ ...doc, pages: (doc.pages || []).map((p) => (String(p.text || '').includes('\t') ? { ...p, text: tabTablesToPipes(p.text) } : p)) });

/** Лист характеристик: подпись на одной строке, значение на следующей, разделы без значения. */
function charsFromLines(lines) {
  const chars = [];
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].trim();
    if (!name || name.includes('|') || SECTION.test(name)) continue;
    const value = (lines[i + 1] || '').trim();
    if (!value || SECTION.test(value) || value.length > 200) continue;
    chars.push({ name: name.slice(0, 120), value });
    i++;
  }
  return chars;
}

const clearName = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '').slice(0, 200);

/**
 * Один товар в закупке: документ «Характеристики X» или карточка площадки с предметом закупки. Количество в таких
 * документах часто не написано: позиция получает название и характеристики, чтобы поиск нашёл именно этот товар.
 * @returns {Array} пусто — если уверенности нет
 */
function singleProduct(docs) {
  let name = null;
  let chars = [];
  let file = null;
  for (const d of docs) {
    const text = (d.pages || []).map((p) => p.text || '').join('\n');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const m = /^(?:технические\s+)?характеристики\s+(.{3,120})$/i.exec(lines[0] || '');
    if (m) { name = clearName(m[1]); chars = charsFromLines(lines.slice(1)); file = d.name; break; }
  }
  if (!name) {
    for (const d of docs) {
      const text = (d.pages || []).map((p) => p.text || '').join('\n');
      const m = /(?:наименование закупки|предмет (?:контракта|договора|закупки))[^|\n]{0,40}[|:]\s*([^\n]{5,200})/i.exec(text);
      if (m) { name = clearName(m[1]).replace(/^(?:закупка|поставка|приобретение)\s+/i, ''); file = d.name; break; }
    }
    // предмет — общие слова: это не один товар
    if (name && /(?:расходн|материал|товар|издели|оборудован|нужд|принадлежност)/i.test(name) && !/[A-Za-z]{2,}\S*\d|\d\S*[A-Za-z]{2,}/.test(name)) return [];
  }
  if (!name) return [];
  const all = docs.map((d) => (d.pages || []).map((p) => p.text || '').join('\n')).join('\n');
  const qty = /(?:^|\n)количество[^|\n]{0,30}\|\s*(\d+(?:[.,]\d+)?)/i.exec(all);
  return [{ name, quantity: qty ? Number(qty[1].replace(',', '.')) : null, unit: null, characteristics: chars.slice(0, 40), source: { file } }];
}

module.exports = { tabTablesToPipes, withTabTables, charsFromLines, singleProduct };
