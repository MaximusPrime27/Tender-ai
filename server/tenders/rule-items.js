// «Читатель по правилам»: товарные позиции из таблиц документации — без нейросети.
// Таблицы в тексте файлов сохранены построчно (server/extract/tables.js, листы Excel — server/extract/index.js):
// ячейки разделены « | », продолжение объединённой ячейки — «″». Здесь из таких строк собираются таблицы, в них
// находится шапка («Наименование товара», «Кол-во», «Ед. изм.») и читаются позиции с количеством и характеристиками.
//
// Правила берут только то, что в таблице написано однозначно. Нестандартную таблицу они не «угадывают», а
// пропускают: такие документы читает нейросеть. Каждая позиция помнит источник — файл, страницу и строку.

const { SAME, SEP } = require('../extract/tables');

// «Наименование закупаемой услуги…», «Тип товара; ОКПД2/КТРУ» — тоже столбец названия (обучение по ЕИС 30.10)
const NAME_RE = /наименован\S*\s+(?:[а-яё]+\s+){0,2}?(?:товар|услуг|объект|продукц|позици|предмет|издели|материал|оборудовани)|^наименование(?:\s*[,/(]|$)|товар\S*,\s*работ|^товар$|^тип\s+товар|^номенклатура|наименование и (?:описание|характеристик)/i;
const QTY_RE = /^кол\s*-?\s*во|^кол\.?$|^штук$|количеств|^объ[её]м(?!\s*памят)/i;
const UNIT_RE = /ед\.?\s*изм|единиц\S*\s+измерен|^ед\.?$/i;
const CHAR_RE = /характеристик|требовани|описани|показател|параметр|функциональн|техническ/i;
const CHAR_NAME_RE = /наименован\S*\s+(?:характеристик|показател|параметр)|^характеристик[аи]$|^показател[ьи]$|^параметр/i;
const CHAR_VALUE_RE = /значени|требуем/i;
const CHAR_UNIT_RE = /единиц\S*\s+измерен\S*\s+характеристик|^ед\.?\s*изм/i;
const INSTRUCTION_RE = /значение характеристики не может|участник закупки указывает|инструкци\S* по заполнени/i;
const TOTAL_RE =/^(итого|всего|сумма)(?![а-яё])/i; // \b с кириллицей не работает
const CODE_RE = /\b\d{2}\.\d{2}\.\d{2}(?:\.\d{2,3})?(?:-\d{3,12})?\b/g;
const SHEET_HEAD_RE = /^Лист «[^»]*»(?: \(скрытый лист\))?(?:, строки \d+–\d+)?$/;

/** «15.00000000000», «1 000», «2,5» → число; не число — null. */
function parseQty(s) {
  const t = String(s || '').replace(/[\s ]/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n < 1e9 ? Math.round(n * 1000) / 1000 : null;
}

/** Наименование без кодов ОКПД2/КТРУ и служебных хвостов. */
function cleanName(s) {
  return String(s || '').replace(CODE_RE, ' ').replace(/(?:^|[\s;,/(])(?:ОКПД\s*2?|КТРУ|ККН)\s*[:№]?(?=[\s;,/)]|$)/gi, ' ').replace(/\s*[;/]\s*(?=[;/]|$)/g, ' ').replace(/^[\s;,/\-–—]+|[\s;,/\-–—]+$/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Таблицы из текста страниц файла: подряд идущие строки с « | ». Таблица, разрезанная границей фрагмента текста,
 * склеивается; у листов Excel пропускаются подписи «Лист …» и повторённая строка заголовков.
 * @returns {Array<{file, rows: Array<{cells: string[], page: number, text: string}>}>}
 */
function tablesOf(doc) {
  const tables = [];
  let cur = null;
  let lastHead = null;
  const close = () => { if (cur && cur.rows.length >= 2) tables.push(cur); cur = null; };
  for (const p of doc.pages || []) {
    const lines = String(p.text || '').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (SHEET_HEAD_RE.test(t)) { if (!/, строки/.test(t)) { close(); lastHead = null; } return; }
      // таблицу заканчивает любая строка без ячеек — в том числе пустая: между двумя таблицами подряд стоит пустая строка
      if (!t.includes('|')) { close(); return; }
      const cells = t.split('|').map((c) => c.trim());
      if (!cur) { cur = { file: doc.name, fileId: doc.id ?? null, rows: [] }; lastHead = t; }
      else if (t === lastHead) return; // строка заголовков, повторённая в следующем фрагменте листа
      cur.rows.push({ cells, page: p.page, text: t });
    });
  }
  close();
  return tables;
}

const cell = (row, i) => (i == null || i < 0 ? '' : row.cells[i] ?? '');
const isSame = (v) => v === SAME;

/** Шапка таблицы позиций: строка, где есть и «наименование», и «количество». @returns {{at, name, qty, unit, chars, charName, charValue, charUnit}|null} */
function findHeader(table) {
  for (let r = 0; r < Math.min(table.rows.length, 6); r++) {
    const cells = table.rows[r].cells;
    const name = cells.findIndex((c) => NAME_RE.test(c));
    const qty = cells.findIndex((c) => QTY_RE.test(c) && c.length < 60);
    if (name < 0 || qty < 0 || name === qty) continue;
    // единица товара, а не «Единица измерения характеристики» (она бывает левее)
    const unitOf = (i) => i !== name && i !== qty && UNIT_RE.test(cells[i]) && cells[i].length < 40;
    let unit = cells.findIndex((c, i) => unitOf(i) && !/характеристик|показател/i.test(c));
    if (unit < 0) unit = cells.findIndex((c, i) => unitOf(i));
    const chars = cells.findIndex((c, i) => i !== name && i !== qty && i !== unit && CHAR_RE.test(c));
    // вторая строка шапки: «Наименование характеристики | Значение характеристики» под общим «Требования…»
    let charName = -1;
    let charValue = -1;
    let charUnit = -1;
    let at = r;
    const next = table.rows[r + 1];
    // «Наименование товара | Ед. изм. | Кол-во | Наименование показателя | Значение показателя» — всё в одной строке
    const same = cells.findIndex((c, i) => i !== name && CHAR_NAME_RE.test(c));
    if (same >= 0) {
      charName = same;
      charValue = cells.findIndex((c, i) => i !== charName && i !== name && CHAR_VALUE_RE.test(c));
      charUnit = cells.findIndex((c, i) => i !== charName && i !== charValue && i !== unit && CHAR_UNIT_RE.test(c));
    } else if (next && next.cells.some((c) => CHAR_NAME_RE.test(c))) {
      charName = next.cells.findIndex((c) => CHAR_NAME_RE.test(c));
      charValue = next.cells.findIndex((c, i) => i !== charName && CHAR_VALUE_RE.test(c));
      charUnit = next.cells.findIndex((c, i) => i !== charName && i !== charValue && CHAR_UNIT_RE.test(c));
      at = r + 1;
    }
    return { at, name, qty, unit, chars, charName, charValue, charUnit };
  }
  return null;
}

/** Таблица характеристик: шапка «Наименование характеристики | Значение». @returns {{at, name, value, unit}|null} */
function findCharHeader(table) {
  for (let r = 0; r < Math.min(table.rows.length, 3); r++) {
    const cells = table.rows[r].cells;
    const name = cells.findIndex((c) => CHAR_NAME_RE.test(c));
    const value = cells.findIndex((c, i) => i !== name && CHAR_VALUE_RE.test(c));
    if (name < 0 || value < 0) continue;
    return { at: r, name, value, unit: cells.findIndex((c, i) => i !== name && i !== value && /единиц|ед\.?\s*изм/i.test(c)) };
  }
  return null;
}

/** «Тип: Совместимый; Цвет: чёрный» из одной ячейки → [{name, value}]. Не пары — пусто. */
function charsFromCell(text) {
  const parts = String(text || '').split(/;\s+|\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
  // «Напряжение – 12 Вольт», «Пусковой ток -> 600 и ≤ 700 Ампер» — пара через тире, когда двоеточия нет
  const pairs = parts.map((p) => /^([^:]{2,80}):\s*(.{1,200})$/.exec(p) || /^([^:\d–—]{2,80}?)\s+[-–—]\s*(.{1,200})$/.exec(p)).filter(Boolean).map((m) => ({ name: m[1].trim(), value: m[2].trim() }));
  return pairs.length >= 2 || (pairs.length === 1 && parts.length === 1) ? pairs : [];
}

const withUnit = (value, unit) => (unit && !isSame(unit) && !new RegExp(`${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i').test(value) ? `${value} ${unit}` : value);

/**
 * Позиции из таблиц одного набора документов.
 * @param docs [{id, name, pages: [{page, text}]}]
 * @returns {{items: Array, tables: number, itemTables: number}} items: {name, quantity, unit, characteristics, source: {file, page, quote}}
 */
function itemsFromTables(docs) {
  const items = [];
  let tablesCount = 0;
  let itemTables = 0;
  for (const doc of docs) {
    const tables = tablesOf(doc);
    tablesCount += tables.length;
    let lastItem = null; // позиция из маленькой таблицы «товар — количество», за которой идёт таблица характеристик
    for (const table of tables) {
      const h = findHeader(table);
      if (!h) {
        const ch = findCharHeader(table);
        if (ch && lastItem && !lastItem.characteristics.length) {
          for (const row of table.rows.slice(ch.at + 1)) {
            const name = cell(row, ch.name);
            const value = cell(row, ch.value);
            if (!name || isSame(name) || !value || isSame(value)) continue;
            lastItem.characteristics.push({ name, value: withUnit(value, cell(row, ch.unit)), quote: row.text.slice(0, 200), page: row.page });
          }
        }
        lastItem = null;
        continue;
      }
      const found = [];
      let cur = null;
      for (const row of table.rows.slice(h.at + 1)) {
        const rawName = cell(row, h.name);
        const qty = parseQty(cell(row, h.qty));
        const name = isSame(rawName) ? '' : cleanName(rawName);
        if (TOTAL_RE.test(name) || TOTAL_RE.test(row.cells.find(Boolean) || '')) { cur = null; continue; }
        // название — слова, а не номер столбца («1 | 2 | 3 …» под шапкой)
        if (name && /[a-zа-яё]{3}/i.test(name) && qty != null && !isSame(cell(row, h.qty))) {
          cur = {
            name, quantity: qty, unit: (isSame(cell(row, h.unit)) ? '' : cell(row, h.unit)).replace(/\.$/, '') || null,
            // «Тип: X; Цвет: Y» или «Показатель; Значение; …; Адгезив; да; Значение … не может изменяться …»
            characteristics: (charsFromCell(cell(row, h.chars)).length ? charsFromCell(cell(row, h.chars)) : charsFromSegments(cell(row, h.chars))).map((c) => ({ ...c, quote: `${c.name}: ${c.value}`.slice(0, 200), page: row.page })),
            source: { file: doc.name, fileId: doc.id ?? null, page: row.page, quote: rawName.slice(0, 200) },
          };
          // характеристика в той же строке, что и товар («Кювета | … | Количество емкостей | ≥ 9 | штука»), или весь
          // список одной ячейкой через «; » с инструкциями («Вид разделки; Филе без кожи; …; Значение … не может …»)
          if (!cur.characteristics.length && h.charName >= 0) {
            const cn = cell(row, h.charName);
            const cv = cell(row, h.charValue);
            const seg = charsFromSegments(cn);
            if (seg.length) cur.characteristics.push(...seg.map((c) => ({ ...c, quote: `${c.name}: ${c.value}`.slice(0, 200), page: row.page })));
            else if (cn && !isSame(cn) && cv && !isSame(cv) && !INSTRUCTION_RE.test(cv)) cur.characteristics.push({ name: cn.replace(/\s*:\s*$/, ''), value: withUnit(cv, cell(row, h.charUnit)), quote: row.text.slice(0, 200), page: row.page });
          }
          found.push(cur);
          continue;
        }
        // строка-продолжение позиции: характеристика и её значение
        if (cur && h.charName >= 0) {
          const cn = cell(row, h.charName).replace(/\s*:\s*$/, '').trim();
          // Значение — в своём столбце; но в документах объединения ячеек «гуляют» от строки к строке, поэтому, если
          // столбец пуст, берём первую заполненную ячейку правее названия (до столбцов единицы и количества).
          let cv = cell(row, h.charValue);
          if (!cv || isSame(cv)) {
            const stop = Math.min(...[h.unit, h.qty].filter((i) => i > h.charName), row.cells.length);
            cv = row.cells.slice(h.charName + 1, stop).find((c) => c && !isSame(c)) || '';
          }
          // пояснение для участника («значение не может изменяться…») — не значение характеристики
          if (INSTRUCTION_RE.test(cv)) cv = '';
          if (cn && !isSame(cn) && cv && !cur.characteristics.some((x) => x.name === cn)) cur.characteristics.push({ name: cn, value: withUnit(cv, cell(row, h.charUnit)), quote: row.text.slice(0, 200), page: row.page });
        }
      }
      if (found.length) { itemTables++; items.push(...found); }
      lastItem = found.length === 1 ? found[0] : null;
    }
    // одна позиция в таблице без характеристик, а они строкой ниже: «Основные характеристики:; Тип - МФУ; Модель - …»
    const lone = items.filter((x) => x.source.file === doc.name && !x.characteristics.length);
    if (lone.length === 1) {
      for (const p of doc.pages || []) {
        const m = /(?:основные|технические)?\s*характеристики[^:\n|]{0,40}:\s*;?\s*([^\n|]{20,})/i.exec(String(p.text || ''));
        const ch = m ? charsFromCell(m[1]) : [];
        if (ch.length >= 2) { lone[0].characteristics.push(...ch.map((c) => ({ ...c, quote: `${c.name}: ${c.value}`.slice(0, 200), page: p.page }))); break; }
      }
    }
    // таблиц позиций в файле нет — может быть печатная форма ЕИС, вытянутая в строку
    if (!items.some((x) => x.source.file === doc.name)) {
      const form = itemsFromEisForm(doc);
      if (form.length) { itemTables++; items.push(...form); }
    }
  }
  return { items, tables: tablesCount, itemTables };
}

// Печатная форма описания объекта закупки из ЕИС, вытянутая в строку через «; »:
//   «Стойка; Идентификатор: 224762212; 31.01.12.190; Товар; Штука; 1.00000000000
//    Характеристики товара, работы, услуги ( Стойка ); Наименование характеристики; Значение характеристики;
//    Единица измерения характеристики; Инструкция по заполнению характеристики в заявке; Длина; ≥ 2550 и ≤ 2650;
//    Миллиметр; Участник закупки указывает в заявке конкретное значение характеристики; Вид; П-образная; Значение …»
// Характеристика — сегменты до инструкции: название, значение (иногда несколько), единица, если она есть.
const FORM_HEAD = /Характеристики\s+товара,\s*работы,\s*услуги\s*\(\s*([^)]{2,200}?)\s*\)\s*;\s*Наименование характеристики\s*;\s*Значение характеристики\s*;\s*(?:Единица измерения характеристики\s*;\s*)?(?:Инструкция по заполнению характеристики в заявке\s*;\s*)?/gi;
const FORM_INSTR = /^(?:значение характеристики не может|участник закупки (?:указывает|выбирает)|в случае)/i;
const FORM_UNIT = /^(?:(?:милли|санти|деци|кило|мега|гига|тера)?(?:метр|грамм|литр|ватт|вольт|ампер|герц|байт|бит|паскал)\S*|штук\S*|градус\S*|процент\S*|час\S*|сут\S*|год\S*|дн\S*|месяц\S*|лист\S*|страниц\S*|дюйм\S*|пар[аы]?|упаков\S*|комплект\S*|квадратн\S*.*|кубическ\S*.*|децибел\S*|оборот\S*|кадр\S*|мегапиксел\S*|ампер-час\S*|точ\S* на дюйм|люмен\S*|кельвин\S*|ньютон\S*)$/i;

/** Ячейка «название; значение; [единица;] инструкция; название; …» → характеристики. Без инструкций — пусто. */
function charsFromSegments(text) {
  const all = String(text || '').split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean);
  // в начале ячейки бывает своя шапка: «Показатель; Значение; показателя; Единица измерения показателя; Инструкция …»
  while (all.length && /^(?:показател\S*|значени\S*(?:\s+показател\S*|\s+характеристик\S*)?|единиц\S*\s+измерени\S*.*|инструкци\S*.*|наименование характеристик\S*)$/i.test(all[0])) all.shift();
  const segs = all
    // код КТРУ и пометки ЕИС между значением и инструкцией — не часть значения
    .filter((x) => !/^(?:код позиции ктру|отсутствие описания в ктру|\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{8})$/i.test(x));
  const out = [];
  let cur = [];
  for (const sgm of segs) {
    if (FORM_INSTR.test(sgm)) {
      while (cur.length && /^обоснование включения/i.test(cur[0])) cur.shift();
      if (cur.length >= 2) {
        const unit = cur.length >= 3 && FORM_UNIT.test(cur[cur.length - 1]) ? cur.pop() : null;
        const value = cur.slice(1).join('; ');
        out.push({ name: cur[0], value: unit && /\d/.test(value) ? `${value} ${unit}` : value });
      }
      cur = [];
    } else cur.push(sgm);
  }
  return out;
}

function itemsFromEisForm(doc) {
  const text = (doc.pages || []).map((p) => p.text || '').join('\n');
  const heads = [...text.matchAll(FORM_HEAD)];
  const items = [];
  heads.forEach((h, k) => {
    const name = h[1].trim();
    const end = k + 1 < heads.length ? heads[k + 1].index : text.length;
    // характеристики — до следующей позиции («…; Наименование товара, работы, услуги; …» или следующая шапка)
    let body = text.slice(h.index + h[0].length, end);
    const next = /Наименование товара, работы, услуги\s*;|\n\s*\d+\s*[.)]?\s*;?\s*Наименование/i.exec(body);
    if (next) body = body.slice(0, next.index);
    // количество и единица — в строке позиции перед шапкой: «Стойка; Идентификатор: …; Товар; Штука; 1.000»
    const before = text.slice(Math.max(0, h.index - 600), h.index);
    const qm = /;\s*Товар\s*;\s*([^;\n]{1,40})\s*;\s*([\d\s.,]+)\s*$/i.exec(before.trim());
    const segs = body.split(/\s*;\s*|\n+/).map((x) => x.trim()).filter(Boolean);
    const chars = [];
    let cur = [];
    for (const sgm of segs) {
      if (FORM_INSTR.test(sgm)) {
        // «Обоснование включения дополнительной информации в сведения о товаре» — пометка ЕИС перед характеристикой
        while (cur.length && /^обоснование включения/i.test(cur[0])) cur.shift();
        if (cur.length >= 2) {
          const unit = cur.length >= 3 && FORM_UNIT.test(cur[cur.length - 1]) ? cur.pop() : null;
          const value = cur.slice(1).join('; ');
          chars.push({ name: cur[0], value: unit && /\d/.test(value) ? `${value} ${unit}` : value, quote: `${cur[0]}: ${value}`.slice(0, 200), page: null });
        }
        cur = [];
        continue;
      }
      cur.push(sgm);
      if (cur.length > 12) cur = []; // без инструкции так долго — уже не характеристика
    }
    if (!chars.length) return;
    const page = (doc.pages || []).find((p) => String(p.text || '').includes(h[0].slice(0, 60)))?.page ?? 1;
    items.push({ name, quantity: qm ? parseQty(qm[2]) : null, unit: qm ? qm[1].trim() : null,
      characteristics: chars.map((c) => ({ ...c, page })), source: { file: doc.name, fileId: doc.id ?? null, page, quote: h[0].slice(0, 200) } });
  });
  return items;
}

const TZ_FILE =/(^|[^а-яё])(тз|т\.з\.|ооз)([^а-яё]|$)|техническ\S*\s+задан|описани\S*\s+объекта|спецификац/i;
const PRICE_FILE = /обоснован|нмц|расч[её]т\S*\s+цен|коммерческ/i;

/**
 * Один и тот же список товаров повторён в нескольких файлах (описание объекта закупки, обоснование цены, проект
 * контракта). Позиции с одинаковым названием и количеством при этом бывают разными товарами (три картриджа по 80 шт),
 * поэтому списки из разных файлов не смешиваются: берётся один — из самого подходящего файла.
 * Порядок выбора: техническое задание / описание объекта закупки → прочие файлы → обоснование цены (в нём позиция
 * повторяется по числу источников цены, поэтому повторы там склеиваются).
 * @returns {{items: Array, file: string|null, alternatives: Array<{file, count}>}}
 */
function pickItems(items) {
  const byFile = new Map();
  for (const it of items) { if (!byFile.has(it.source.file)) byFile.set(it.source.file, []); byFile.get(it.source.file).push(it); }
  const groups = [...byFile].map(([file, list]) => {
    const base = String(file).split('/').pop();
    const kind = TZ_FILE.test(base) && !PRICE_FILE.test(base) ? 0 : PRICE_FILE.test(base) ? 2 : 1;
    // в обосновании цены одна позиция идёт несколькими строками (по источникам цен) — склеиваем точные повторы
    const seen = new Set();
    const uniq = kind === 2 ? list.filter((x) => { const k = `${x.name.toLowerCase()}|${x.quantity}`; return seen.has(k) ? false : seen.add(k); }) : list;
    return { file, kind, items: uniq, withChars: uniq.filter((x) => x.characteristics.length).length };
  });
  if (!groups.length) return { items: [], file: null, alternatives: [] };
  groups.sort((a, b) => a.kind - b.kind || b.withChars - a.withChars || b.items.length - a.items.length);
  const best = groups[0];
  return { items: best.items, file: best.file, alternatives: groups.slice(1).map((g) => ({ file: g.file, count: g.items.length })) };
}

module.exports = { itemsFromTables, itemsFromEisForm, pickItems, tablesOf, findHeader, parseQty, cleanName, charsFromCell };
