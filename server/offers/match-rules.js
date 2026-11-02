// Правила сверки по видам оборудования — без нейросети (Этап 1, design-kit/stage1-search).
// Нейросеть и числа говорят «да», а правила проверяют, не ложное ли это совпадение: «до 64 ГБ» — не установленная
// память, зарядка по USB-C — не видеовыход, двусторонняя печать — не двустороннее сканирование, восемь портов —
// не восемь PoE. Правило может только понизить «да» до «не подтверждено», поставить «нет» при явном доказательстве
// на странице или «противоречие», если страница говорит и то и другое. Повысить «не подтверждено» до «да» правило
// не может — для этого нужен источник (страница, вкладка характеристик, паспорт).

const low = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');
const near = (text, a, b, span = 80) => new RegExp(`(?:${a})[^]{0,${span}}?(?:${b})|(?:${b})[^]{0,${span}}?(?:${a})`, 'i').test(text);
/** Короткая цитата вокруг совпадения — для доказательства в таблице сверки. */
function quoteAround(text, re, span = 70) {
  const t = String(text ?? '');
  const m = re.exec(t);
  if (!m) return null;
  const from = Math.max(0, m.index - span);
  const to = Math.min(t.length, m.index + m[0].length + span);
  return `${from > 0 ? '…' : ''}${t.slice(from, to).replace(/\s+/g, ' ').trim()}${to < t.length ? '…' : ''}`;
}

const intOf = (s) => { const n = Number(String(s).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const needNumber = (value) => { const m = /(\d+(?:[.,]\d+)?)/.exec(String(value)); return m ? intOf(m[1]) : null; };
const minOf = (value) => {
  const v = low(value);
  if (/(?:^|[^а-я])(?:не менее|от|≥|>=|более)\s*(\d+)/.test(v)) return intOf(/(?:не менее|от|≥|>=|более)\s*(\d+(?:[.,]\d+)?)/.exec(v)[1]);
  return /^\s*\d+(?:[.,]\d+)?\s*(?:шт|порт|вт)?\.?\s*$/.test(v) ? needNumber(v) : null;
};

/**
 * Правила: applies(name, value, itemName) — относится ли требование; check(text, row, req) — поправка к строке
 * сверки или null (правило ничего не меняет). Поправка: {verdict, found, reason, quote}.
 */
// Бренды, которые делают только совместимые расходники: сам бренд в названии — доказательство «не оригинал».
const COMPAT_BRANDS = /hi-?black|nv\s?print|(?<![a-z])nvp(?![a-z])|cactus|g&g|easy\s?print|sakura|(?<![a-z0-9])t2(?![a-z0-9])|булат|bulat|net\s?product|(?<![a-z])elp(?![a-z])|copyrite|mytoner|integra|profiline|katun|colortek|uniton|(?<![a-z])bion(?![a-z])|retech|grafit|графит|galaprint|gala-?print|(?<![a-z])sprint(?![a-z])|aquamarine|white\s?cartridge|static\s?control|gravitone|(?<![a-z])ekc(?![a-z])/i;

// Название начинается с бренда производителя печатающей техники («Тонер-картридж Kyocera TK-5450K») — так называют
// оригинал; совместимые называют «Картридж NV Print … для Kyocera».
const OEM_TITLE = /^(?:\*\s*)?(?:оригинальн\S*\s+)?(?:ч[её]рн\S*\s+)?(?:тонер-?)?(?:картридж\S*|тонер\S*|фотобарабан\S*|драм-?картридж\S*|чернил\S*)?\s*(?:лазерн\S*\s+|струйн\S*\s+)?(kyocera|hp|hewlett|canon|xerox|brother|ricoh|samsung|pantum|lexmark|epson|konica|minolta|sharp|oki|катюша|katusha|sindoh|toshiba|panasonic|avision|f\+)(?![a-zа-я])/i;
/** Оригинальный расходник по названию: «оригинальный», «Original» или бренд производителя первым; не совместимый. */
function originalByTitle(title) {
  const t = low(title);
  if (!t || COMPAT_BRANDS.test(t) || /совместим|аналог|восстановлен|неоригинал|compatible|remanufactur/.test(t)) return false;
  return /(?<!не)оригинальн|original|genuine/.test(t) || OEM_TITLE.test(t);
}

const RULES = [
  {
    id: 'base-frequency',
    title: 'максимальная (turbo) частота — не базовая',
    applies: (n) => /базов/i.test(n) && /частот/i.test(n),
    check(text, row) {
      if (row.verdict !== 'yes') return null;
      const t = String(text);
      // базовая частота названа на странице прямо — сравниваем с ней
      const base = /базов\S*\s+(?:тактов\S*\s+)?частот\S*[^\d]{0,30}(\d+(?:[.,]\d+)?)/i.exec(t);
      const need = minOf(row.need);
      if (base) {
        const v = intOf(base[1]);
        if (need != null && v != null && v < need) return { verdict: 'no', found: `базовая частота ${base[1]}`, reason: this.title, quote: quoteAround(t, new RegExp(base[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) };
        return null;
      }
      const n = needNumber(row.found);
      if (n == null) return null;
      const num = String(n).replace('.', '[.,]');
      // диапазон «2.1 GHz - 4.6 GHz», «от 2.1 до 4.6 ГГц»: базовая — левое число
      const range = new RegExp(`(?:от\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(?:ghz|ггц)?\\s*(?:[-–—]|до)\\s*${num}(?![\\d])`, 'i').exec(t);
      if (range) {
        const lo = intOf(range[1]);
        if (lo != null && lo < n) {
          if (need != null && lo < need) return { verdict: 'no', found: `базовая ${range[1]} (диапазон ${range[0].trim()})`, reason: this.title, quote: quoteAround(t, new RegExp(range[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) };
          return { verdict: 'yes', found: `базовая ${range[1]}`, reason: this.title };
        }
      }
      const all = [...t.matchAll(new RegExp(`(?<![\\d.,])${num}(?![\\d])`, 'g'))];
      const isMax = (m) => /(?:макс\S*|max\S*|turbo|boost|до)[^\d]{0,25}$/i.test(t.slice(Math.max(0, m.index - 40), m.index));
      if (!all.length || !all.every(isMax)) return null;
      return { verdict: 'unknown', found: `на странице ${row.found} — это максимальная частота, базовая не указана`, reason: this.title, quote: quoteAround(t, new RegExp(`(?:макс\\S*|max\\S*|turbo|boost|до)[^\\d]{0,25}${num}`, 'i')) };
    },
  },
  {
    id: 'supported-max',
    title: 'установленное — не максимальное поддерживаемое',
    // «Максимальный поддерживаемый объём памяти не менее 32 ГБ»: 16 ГБ установленной памяти этого не опровергают
    applies: (n) => /максимальн|поддерживаем/i.test(n) && /памят|озу|\bram\b|объ[её]м|накопител/i.test(n),
    check(text, row) {
      if (row.verdict !== 'no') return null;
      if (/макс\S*|max\S*|поддерж\S*|до\s*\d|up to|расширени/i.test(`${row.found} ${row.quote || ''}`)) return null;
      return { verdict: 'unknown', found: `на странице «${row.found}» — это установленное значение, а нужно максимальное поддерживаемое`, reason: this.title };
    },
  },
  {
    id: 'height-adjust',
    title: 'наклон и поворот — не регулировка по высоте',
    applies: (n) => /высот/i.test(n) && /регулир/i.test(n),
    check(text, row) {
      if (row.verdict !== 'yes' || /высот|height|подъ[её]м|лифт/i.test(`${row.found} ${row.quote || ''}`)) return null;
      if (/нет$|^нет/i.test(row.need)) return null;
      return { verdict: 'unknown', found: `на странице «${row.found}» — регулировка по высоте не названа`, reason: this.title };
    },
  },
  {
    id: 'qualified-max',
    title: '«до N» — максимум, а не установленное значение',
    applies: (n, v) => /установл|оператив|озу|\bram\b|памят|накопител|ssd|hdd|ядер|поток/i.test(`${n} ${v}`) && !/максимальн|поддерживаем|до\s*\d/i.test(`${n} ${v}`),
    check(text, row) {
      if (row.verdict !== 'yes') return null;
      const n = needNumber(row.found);
      if (n == null) return null;
      const num = String(n).replace('.', '[.,]');
      const all = [...String(text).matchAll(new RegExp(`(?<![\\d.,])${num}(?![\\d])`, 'g'))];
      if (!all.length) return null;
      const qualified = (m) => /(?:до|up to|макс\S*|max\S*|не более|расширени\S* до|опционально|по выбору)\s*$/i.test(String(text).slice(Math.max(0, m.index - 24), m.index));
      if (!all.every(qualified)) return null;
      const quote = quoteAround(text, new RegExp(`(?:до|up to|макс\\S*|max\\S*|расширени\\S* до)\\s*${num}`, 'i'));
      return { verdict: 'unknown', found: `на странице «${(quote || '').replace(/^…|…$/g, '').slice(0, 60)}» — это максимум, а не установленное значение`, reason: this.title, quote };
    },
  },
  {
    id: 'usb-c-video',
    title: 'USB-C: видеовыход нужно подтвердить отдельно, зарядка (PD) его не доказывает',
    applies: (n, v) => /usb[\s-]*c|type[\s-]*c/i.test(`${n} ${v}`) && /displayport|\bdp\b|видео|изображен|монитор|alt\s*mode|thunderbolt/i.test(`${n} ${v}`),
    check(text, row) {
      if (row.verdict !== 'yes') return null;
      if (near(text, 'usb[\\s-]*c|type[\\s-]*c|thunderbolt', 'displayport|\\bdp\\b|dp alt|видеовыход|вывод изображен|подключени\\S* монитор', 90)) return null;
      const pd = /power delivery|\bpd\b|зарядк/i.test(text);
      return { verdict: 'unknown', found: pd ? 'у USB-C на странице указана только зарядка (PD) — видеовыход не подтверждён' : 'у USB-C на странице не указан видеовыход (DisplayPort)', reason: this.title, quote: quoteAround(text, /usb[\s-]*c|type[\s-]*c/i) };
    },
  },
  {
    id: 'separate-audio',
    title: 'Комбинированный аудиоразъём — один физический разъём',
    applies: (n, v) => /раздельн|отдельн|два\s+разъем|2\s*(?:x|х)\s*3[.,]5/i.test(low(`${n} ${v}`)) && /аудио|микрофон|наушник|3[.,]5/i.test(`${n} ${v}`),
    check(text, row) {
      const combo = /комбинированн\S*\s+(?:аудио|разъем|гнезд)|combo\s*(?:audio|jack)|гарнитурн\S*\s+разъем|audio\s*combo/i;
      const separate = /раздельн\S*\s+(?:аудио|разъем)|отдельн\S*\s+разъем\S*\s+(?:для\s+)?(?:микрофон|наушник)/i;
      if (combo.test(low(text)) && !separate.test(low(text))) return { verdict: 'no', found: 'на странице один комбинированный аудиоразъём', reason: this.title, quote: quoteAround(text, combo) };
      if (row.verdict === 'yes' && !separate.test(low(text))) return { verdict: 'unknown', found: 'раздельные разъёмы на странице не подтверждены', reason: this.title };
      return null;
    },
  },
  {
    id: 'hdmi-adapter',
    title: 'Переходник или док-станция не создают встроенный разъём',
    applies: (n, v) => /hdmi|displayport|vga/i.test(`${n} ${v}`) && !/переходник|адаптер|док-?станц/i.test(`${n} ${v}`),
    check(text, row) {
      if (row.verdict !== 'yes') return null;
      const port = /hdmi|displayport|vga/i.exec(`${row.name} ${row.need}`)?.[0] || 'hdmi';
      const viaAdapter = near(text, 'переходник|адаптер|док-?станц|dongle', port, 40);
      const builtIn = new RegExp(`(?:встроенн\\S*|разъем\\S*|порт\\S*|выход\\S*)[^.]{0,30}${port}|${port}[^.]{0,15}(?:выход|разъем|порт|1\\.4|2\\.0|2\\.1)`, 'i').test(low(text));
      if (viaAdapter && !builtIn) return { verdict: 'unknown', found: `${port.toUpperCase()} на странице упомянут только через переходник или док-станцию`, reason: this.title, quote: quoteAround(text, /переходник|адаптер|док-?станц/i) };
      return null;
    },
  },
  {
    id: 'duplex-scan',
    title: 'Двусторонняя печать не означает двустороннее сканирование',
    applies: (n, v) => /двусторонн\S*\s+сканир|дуплексн\S*\s+сканир|dadf|двусторонн\S*\s+автоподатч|сканировани\S*[^.]{0,20}двусторонн/i.test(low(`${n} ${v}`)) && !/^\s*нет\s*$/i.test(v),
    check(text, row) {
      const scan = /двусторонн\S*\s+(?:однопроходн\S*\s+)?сканир|дуплексн\S*\s+сканир|сканировани\S*[^.]{0,25}двусторонн|dadf|duplex\s*scan|однопроходн\S*\s+(?:дуплекс|сканир)|rapdf|двусторонн\S*\s+(?:автоподатчик|автоподач|устройств\S*\s+автоподач)|(?:автоподатчик|автоподач\S*|апд)[^.]{0,40}двусторон/i;
      if (scan.test(low(text))) return null;
      if (row.verdict !== 'yes') return null;
      return { verdict: 'unknown', found: /двусторонн\S*\s+печат|duplex\s*print|автоматическ\S*\s+двусторонн/i.test(low(text)) ? 'на странице есть двусторонняя печать, но двустороннее сканирование не подтверждено' : 'двустороннее сканирование на странице не подтверждено', reason: this.title, quote: quoteAround(text, /двусторонн\S*\s+печат|duplex/i) };
    },
  },
  {
    id: 'poe-ports',
    title: 'Число PoE-портов считается отдельно от общего числа портов',
    applies: (n, v) => /poe/i.test(n) && /порт|кол|числ/i.test(n) && !/бюджет|мощност/i.test(n),
    check(text, row, req) {
      const need = minOf(req.value);
      const m = /(\d+)\s*(?:x\s*)?(?:порт\S*\s*)?(?:с\s+)?(?:поддержк\S*\s+)?poe\+?|poe\+?\S*\s*(?:порт\S*)?\s*[:—-]?\s*(\d+)|из\s+них\s+(\d+)\s+(?:с\s+)?poe/i.exec(low(text));
      const got = m ? intOf(m[1] || m[2] || m[3]) : null;
      if (got == null) return row.verdict === 'yes' ? { verdict: 'unknown', found: 'число портов с PoE на странице не указано отдельно', reason: this.title } : null;
      if (need != null && got < need) return { verdict: 'no', found: `портов с PoE: ${got}`, reason: this.title, quote: quoteAround(text, /poe/i) };
      return need != null ? { verdict: 'yes', found: `портов с PoE: ${got}`, reason: this.title, quote: quoteAround(text, /poe/i) } : null;
    },
  },
  {
    id: 'poe-budget',
    title: 'Бюджет PoE — общий на устройство, мощность порта на число портов не умножается',
    applies: (n, v) => /poe/i.test(`${n} ${v}`) && /бюджет|суммарн|общ\S*\s+мощност/i.test(low(n)),
    check(text, row, req) {
      const need = minOf(req.value);
      const m = /(?:бюджет\S*\s*(?:poe\+?)?|poe\+?\s*бюджет\S*|суммарн\S*\s+мощност\S*(?:\s+poe)?|poe\s*budget)\s*[:—-]?\s*(?:до\s*)?(\d+(?:[.,]\d+)?)\s*(?:вт|w)/i.exec(low(text));
      if (!m) return row.verdict === 'yes' ? { verdict: 'unknown', found: 'общий бюджет PoE на странице не указан (мощность на порт его не заменяет)', reason: this.title } : null;
      const got = intOf(m[1]);
      if (need != null && got < need) return { verdict: 'no', found: `бюджет PoE ${got} Вт`, reason: this.title, quote: quoteAround(text, /бюджет|budget|суммарн/i) };
      return { verdict: 'yes', found: `бюджет PoE ${got} Вт`, reason: this.title, quote: quoteAround(text, /бюджет|budget|суммарн/i) };
    },
  },
  {
    id: 'combo-ports',
    title: 'Комбинированные порты (RJ45/SFP) одновременно не работают — их число не складывается',
    applies: (n) => /sfp|rj-?45|порт/i.test(n) && /кол|числ/i.test(n) && !/poe/i.test(n),
    check(text, row) {
      if (row.verdict !== 'yes') return null;
      // комбинированные порты должны быть того же типа, что в требовании (SFP или RJ45), а не любые на странице
      const kind = /sfp/i.test(row.name) ? 'sfp' : /rj-?45|1000base-t|медн/i.test(row.name) ? 'rj-?45|1000base-t' : 'sfp|rj-?45';
      const combo = new RegExp(`(?:combo|комбинированн\\S*|shared|разделяем\\S*)[^.]{0,40}(?:${kind})|(?:${kind})[^.]{0,30}(?:combo|комбинированн\\S*|shared)`, 'i');
      return combo.test(low(text)) ? { verdict: 'unknown', found: 'часть портов комбинированные (RJ45/SFP) — одновременно доступно меньше портов', reason: this.title, quote: quoteAround(text, combo) } : null;
    },
  },
  {
    id: 'cartridge-chip',
    title: 'Чип картриджа',
    applies: (n, v) => /чип/i.test(n) && !/^\s*(нет|не требуется)\s*$/i.test(v),
    check(text, row, req, ctx = {}) {
      const without = /без\s+чип|чип\s+не\s+(?:входит|установлен|предусмотрен)|чип\s+в\s+комплект\S*\s+не|no\s+chip|without\s+chip|чип\s+(?:нужно|необходимо)\s+(?:переставить|купить)/i;
      const withChip = /(?<!без\s)с\s+чипом|чип\s+(?:в\s+комплекте|установлен|есть)|наличие\s+чипа\s*[:—-]?\s*да|with\s+chip|chip\s*:\s*yes/i;
      const neg = without.test(low(text));
      const pos = withChip.test(low(text));
      // Оригинальный картридж производителя (по названию) всегда с чипом — магазины этого не пишут. «Без чипа» на странице
      // оригинала — обычно про соседние совместимые товары.
      if (!pos && originalByTitle(ctx.title)) return { verdict: 'yes', found: 'оригинальный картридж производителя — с чипом', reason: this.title, quote: ctx.title };
      if (neg && pos) return { verdict: 'conflict', found: 'на странице сказано и «с чипом», и «без чипа»', reason: this.title, quote: quoteAround(text, without) };
      if (neg) return { verdict: 'no', found: 'на странице: без чипа', reason: this.title, quote: quoteAround(text, without) };
      if (pos) return { verdict: 'yes', found: 'с чипом', reason: this.title, quote: quoteAround(text, withChip) };
      return { verdict: 'unknown', found: 'наличие чипа на странице не указано', reason: this.title };
    },
  },
  {
    id: 'original-cartridge',
    title: 'Оригинальный расходник: совместимый или восстановленный не подходит',
    applies: (n, v) => /оригинал/i.test(low(v)) || (/оригинал/i.test(low(n)) && /^\s*да\s*$/i.test(v)),
    check(text, row, req, ctx) {
      const full = `${ctx.title || ''}\n${text}`;
      const t = low(full);
      const original = /(?<!не)оригинальн\S*|original(?!\s*equivalent)|genuine|oem/i;
      // тип товара: «совместимый картридж», «аналог», «восстановленный». «Совместим с принтерами …» и
      // «Совместимые модели: …» у оригинала — список совместимости, а не тип товара.
      // только прилагательные («совместимый картридж»); «Совместимость: …» — список принтеров, а не тип товара
      const notOriginal = /(?:совместим(?:ый|ая|ое|ые|ого|ую|ых)|аналог(?:ичн\S*)?|compatible|неоригинал[а-я]*|восстановлен[а-я]*|refill[a-z]*|remanufactur[a-z]*)(?![а-яa-z])(?!\s+(?:с|со|with|модел[а-я]*|принтер[а-я]*|устройств[а-я]*|мфу|для)(?![а-яa-z]))/i;
      // Сначала название товара: оно про сам товар. На странице оригинала «совместимый» встречается в чужих блоках
      // («Совместимые картриджи», «Аналоги», рекомендации) — по одному такому слову оригинал не отклоняем.
      const title = low(ctx.title || '');
      const titleNot = notOriginal.exec(title);
      if (titleNot) return { verdict: 'no', found: `в названии: «${titleNot[0].trim()}»`, reason: this.title, quote: ctx.title };
      // бренд, который делает только совместимые расходники (Hi-Black, NV Print, Cactus, G&G…), — не оригинал
      const compat = COMPAT_BRANDS.exec(title);
      if (compat) return { verdict: 'no', found: `бренд совместимых расходников: ${compat[0]}`, reason: this.title, quote: ctx.title };
      // название начинается с бренда производителя печатающей техники («Тонер-картридж Kyocera TK-5450K»), без «для …»
      // перед брендом — так называют оригинал; совместимые называют «Картридж NV Print … для Kyocera»
      const OEM = OEM_TITLE;
      const oem = OEM.exec(title);
      if (oem && !/для\s+\S+\s*$/.test(title.slice(0, oem.index + oem[0].length))) return row.verdict === 'yes' ? null : { verdict: 'yes', found: `в названии бренд производителя: ${oem[1]}`, reason: this.title, quote: ctx.title };
      if (original.test(title)) return row.verdict === 'yes' ? null : { verdict: 'yes', found: 'в названии: «оригинальный»', reason: this.title, quote: ctx.title };
      const hit = notOriginal.exec(t);
      // на странице есть и «оригинальный», и «совместимый» — не отклоняем, а просим проверить
      if (hit && original.test(t)) return { verdict: 'conflict', found: `на странице и «оригинальный», и «${hit[0].trim()}»`, reason: this.title, quote: quoteAround(full, notOriginal) };
      if (hit) return { verdict: 'no', found: `на странице: «${hit[0].trim()}»`, reason: this.title, quote: quoteAround(full, notOriginal) };
      if (row.verdict === 'yes' && !original.test(t)) return { verdict: 'unknown', found: 'на странице не сказано, что это оригинал', reason: this.title };
      return null;
    },
  },
  {
    id: 'keyboard-layout',
    title: 'Раскладка клавиатуры',
    // только сама раскладка; «отличие цвета русских букв» и т. п. — другие требования
    applies: (n, v) => (/раскладк/i.test(low(n)) || /кириллиц|йцукен/i.test(low(v))) && !/^\s*нет\s*$/i.test(v),
    check(text, row) {
      const ru = /русск\S*|кирилл\S*|йцукен|rus\b|ru\/en|en\/ru|двуязычн/i;
      const enOnly = /(?:английск\S*|en|us)\s+раскладк\S*|раскладк\S*\s*[:—-]?\s*(?:английск\S*|en|us)(?![\/\w])|без\s+кириллиц/i;
      if (enOnly.test(low(text)) && !ru.test(low(text))) return { verdict: 'no', found: 'на странице только английская раскладка', reason: this.title, quote: quoteAround(text, enOnly) };
      if (row.verdict === 'yes' && !ru.test(low(text))) return { verdict: 'unknown', found: 'русская раскладка на странице не подтверждена', reason: this.title };
      return null;
    },
  },
  {
    id: 'kit-license',
    title: 'Комплект и лицензии нужно подтвердить: поддержка протокола их не заменяет',
    // только лицензии и программы: «кабель в комплекте» страница магазина подтверждает и без этого правила
    applies: (n, v) => /лицензи|программн\S*\s+обеспечени/i.test(low(`${n} ${v}`)) && !/^\s*нет\s*$/i.test(v),
    check(text, row) {
      if (row.verdict !== 'yes') return null;
      return /в\s+комплект\S*|комплект\S*\s+поставк|лицензи\S*\s+(?:в\s+комплект|включен)|включен\S*\s+лицензи/i.test(low(text)) ? null
        : { verdict: 'unknown', found: 'на странице не сказано, что это входит в комплект поставки', reason: this.title };
    },
  },
];

/**
 * Применить правила к строкам сверки. Строки меняются на месте; у каждой изменённой — rule и reason.
 * @param rows [{name, need, verdict, found}]
 * @param text текст страницы (с названием)
 * @param ctx {title}
 * @returns {Array<{row, rule}>} что изменилось
 */
function applyRules(rows, text, ctx = {}) {
  const changed = [];
  for (const row of rows) {
    for (const rule of RULES) {
      if (!rule.applies(row.name, row.need, ctx.itemName)) continue;
      const fix = rule.check(String(text ?? ''), row, { name: row.name, value: row.need }, ctx);
      if (!fix) continue;
      // правило не повышает «не подтверждено» до «да» без своего доказательства (цитаты)
      if (fix.verdict === 'yes' && row.verdict !== 'yes' && !fix.quote) continue;
      // тот же итог без нового доказательства — только пояснение, если его не было
      if (fix.verdict === row.verdict && !fix.quote) { if (!row.found && fix.found) Object.assign(row, { found: String(fix.found).slice(0, 160), rule: rule.id, reason: fix.reason }); continue; }
      Object.assign(row, { verdict: fix.verdict, found: String(fix.found || '').slice(0, 160), rule: rule.id, reason: fix.reason, ...(fix.quote ? { quote: fix.quote } : {}) });
      changed.push({ row, rule: rule.id });
      if (row.verdict === 'no' || row.verdict === 'conflict') break;
    }
  }
  return changed;
}

module.exports = { applyRules, quoteAround, RULES, COMPAT_BRANDS };
