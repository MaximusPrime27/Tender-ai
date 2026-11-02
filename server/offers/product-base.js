// Своя база товаров: карточка товара (вид, производитель, модель, характеристики) с источником каждого значения.
//
// Зачем. Характеристики, найденные при поиске поставщиков, раньше оставались в той закупке, где их нашли: в следующей
// закупке на тот же товар всё искалось и сверялось заново. Теперь всё найденное копится в базе, и новое ТЗ сначала
// сверяется с ней — сразу и бесплатно: «эти модели подходят, этим не хватает двух характеристик». Цену потом ищем уже
// по готовому списку моделей.
//
// Первый этап (этот модуль) — база из того, что сервис уже накопил:
//   — модели производителей из реестра (registry-models.js) — для компьютеров;
//   — страницы товаров, открытые при поиске поставщиков: таблица характеристик, цена, дата; плюс значения, найденные
//     при сверке с ТЗ (по каждому — откуда взято).
// Ниши: компьютеры, картриджи и расходные материалы, оргтехника, комплектующие к ПК и оргтехнике, мебель.
// База лежит в рабочей базе (app.db) — попадает в резервные копии перед каждой выкладкой.

const { modelOf, brandOf, furnitureModel } = require('./maker-search');
const { modelName } = require('./registry-models');
const knowledge = require('./knowledge-seed');

const NICHE_LABEL = {
  computers: 'компьютеры',
  cartridges: 'картриджи и расходные материалы',
  office: 'оргтехника',
  components: 'комплектующие к ПК и оргтехнике',
  furniture: 'мебель',
  medical: 'медицинские расходники',
  batteries: 'аккумуляторы и батарейки',
};
// вид товара: [код, ниша, как называется, признак в начале наименования]. Порядок важен: «тонер-картридж» — картридж,
// «Компьютер персональный (моноблок)» — моноблок, «Блок фотобарабана» — фотобарабан, а не блок питания.
const KINDS = [
  ['aio', 'computers', 'моноблок', /моноблок/],
  ['laptop', 'computers', 'ноутбук', /^(ноутбук|портативн\S*\s+компьютер|компьютер\S*\s+портативн|нетбук)/],
  ['monitor', 'computers', 'монитор', /^монитор(?!.{0,40}(пациент|медицин|прикроват))/],
  ['pc', 'computers', 'системный блок (ПК)', /^(системн\S*\s+блок|персональн\S*\s+(электронно-)?(вычислительн|компьютер)|компьютер\S*\s+(персональн|настольн)|пэвм|рабоч\S*\s+станци|неттоп|мини-?пк|тонк\S*\s+клиент|автоматизированн\S*\s+рабоч\S*\s+мест|компьютер(\s|$))/],
  ['drum', 'cartridges', 'фотобарабан', /^((блок|модуль)\s+)?(фото)?барабан|^драм|^drum|^фотобарабан/],
  ['cartridge', 'cartridges', 'картридж', /^(тонер-?)?картридж|^cartridge|^струйн\S*\s+картридж|^лазерн\S*\s+картридж/],
  ['toner', 'cartridges', 'тонер', /^тонер(?!-?картридж)/],
  ['ink', 'cartridges', 'чернила', /^чернил|^контейнер\s+с\s+чернил/],
  ['mfp', 'office', 'МФУ', /^(мфу|многофункциональн\S*\s+(устройств|печатающ))/],
  ['printer', 'office', 'принтер', /^принтер(?!\s+3d)|^(лазерн|струйн)\S*\s+принтер/],
  ['scanner', 'office', 'сканер', /^сканер(?!\s+штрих)/],
  ['copier', 'office', 'копир', /^(копир|копировальн)/],
  ['storage', 'components', 'накопитель (SSD, HDD)', /^(накопител|твердотельн|ssd|жестк\S*\s+диск|hdd)/],
  ['ram', 'components', 'оперативная память', /^(оперативн\S*\s+памят|модул\S*\s+(оперативн\S*\s+)?памят|памят\S*\s+оперативн)/],
  ['keyboard', 'components', 'клавиатура', /^клавиатур/],
  ['mouse', 'components', 'мышь', /^(мышь|мыши|манипулятор\s+(«|")?мышь)/],
  ['kit', 'components', 'комплект клавиатура и мышь', /^(комплект|набор)\s+(клавиатур|беспроводн|проводн)/],
  ['ups', 'components', 'ИБП', /^(ибп|источник\S*\s+бесперебойн)/],
  ['psu', 'components', 'блок питания', /^блок\S*\s+питания/],
  ['gpu', 'components', 'видеокарта', /^(видеокарт|видеоадаптер|графическ\S*\s+(ускорител|адаптер))/],
  ['cpu', 'components', 'процессор', /^процессор/],
  ['motherboard', 'components', 'материнская плата', /^(материнск|системн\S*\s+плат)/],
  ['webcam', 'components', 'веб-камера', /^(веб-?камер|web-?камер)/],
  ['headset', 'components', 'гарнитура', /^(гарнитур|наушник)/],
  // мебель: «Стол для принтера» — стол, «Шкаф телекоммуникационный» и «Кресло-коляска» — не мебель
  ['office_chair', 'furniture', 'кресло', /^кресл(?!\S*-?\s*коляск)/],
  ['chair', 'furniture', 'стул, табурет', /^(стул|табурет)/],
  ['desk', 'furniture', 'стол, парта', /^(стол(?!ов\S*\s+(прибор|посуд|ложк|нож|вилк))|парт[аы]?(\s|$)|конторк)/],
  ['cabinet', 'furniture', 'шкаф', /^(шкаф(?!\S*\s+(телекоммуникац|серверн|коммутац|распредел|управлен|электр|силов|автомат|сушильн|холодильн|морозильн|климат|пожарн))|гардероб)/],
  ['shelving', 'furniture', 'стеллаж', /^стеллаж/],
  ['pedestal', 'furniture', 'тумба', /^тумб/],
  ['bed', 'furniture', 'кровать', /^(кроват|койк)/],
  ['mattress', 'furniture', 'матрас', /^матра[сц]/],
  ['sofa', 'furniture', 'диван, кушетка', /^(диван|кушетк|банкетк|пуф(\s|$))/],
  ['bench', 'furniture', 'скамья', /^(скам(ь|ейк)|лавк)/],
  ['workbench', 'furniture', 'верстак', /^верстак/],
  ['safe', 'furniture', 'сейф', /^сейф/],
  // медицинские расходники (30.10.2026): у многих нет номера модели — модель берётся из артикула страницы
  ['gloves', 'medical', 'перчатки', /^перчат/],
  ['syringe', 'medical', 'шприц', /^шприц/],
  ['needle', 'medical', 'игла', /^игл[аы]\s/],
  ['med_mask', 'medical', 'маска медицинская', /^маск(?!\S*\s+(сварщ|для\s+сна|косметич|карнавал))/],
  ['catheter', 'medical', 'катетер', /^катетер/],
  ['dressing', 'medical', 'бинт, повязка, пластырь', /^(бинт|повязк|пластыр|лейкопластыр)/],
  ['wipes', 'medical', 'салфетки, марля', /^(салфетк\S*\s+(марлев|медицин|спирт|стерил)|марл)/],
  ['urine_bag', 'medical', 'мочеприёмник', /^мочеприемник/],
  ['shoe_covers', 'medical', 'бахилы', /^бахил/],
  ['infusion', 'medical', 'система для инфузий', /^систем\S*\s+(для\s+)?(инфуз|вливан|переливан)/],
  ['diapers', 'medical', 'подгузники, пелёнки', /^(подгузник|пеленк|трусы\s+впитыва)/],
  ['tube', 'medical', 'пробирка, контейнер для анализов', /^(пробирк|контейнер\S*\s+(для\s+)?(сбора|биопроб|биоматер|анализ))/],
  // аккумуляторы и батарейки
  ['car_battery', 'batteries', 'аккумулятор', /^(аккумулятор(?!\S*\s+(для\s+)?(ноутбук|телефон|смартфон|планшет))|акб(\s|$))/],
  ['cell_battery', 'batteries', 'батарейка, элемент питания', /^(батарейк|элемент\S*\s+питани)/],
];
// Ниши, где «модель» не уникальна между производителями: «6СТ-75NR» — обозначение по стандарту у всех заводов,
// артикул мочеприёмника — у каждой фабрики свой. Карточка там — бренд + модель, без бренда не заводится.
const BRANDED = new Set(['medical', 'batteries']);
// размер или величина, а не модель: «90х25мм», «ch18», «22G», «60Ah», «5 мл»
const NOT_MODEL = /^\s*(\d+([.,]\d+)?\s*[хx×*]\s*\d+.*|(ch|fr|g)\s*\d+|\d+\s*(g|ch|fr)|\d+([.,]\d+)?\s*(ah|а\s*ч|ач|a|а|мл|ml|мм|mm|г|см|cm|м|m|шт|pcs|v|в|mah|мач|%)?)\s*$/i;
const badModel = (m) => !m || NOT_MODEL.test(String(m));
// слова, которые пишут латиницей или заглавными, но это не бренд: технология, стандарт, тип, размер
const NOT_BRAND = /^(agm|gel|efb|ca|sla|vrla|hybrid|standard|premium|plus|pro|max|super|power|start|stop|euro|asia|оп|пп|ач|акб|ст|tm|тм|lux|eco|gost|гост|ту|ce|ru|рф|xl|xxl|nitrile|latex|vinyl|sterile)$/i;
/**
 * Бренд для ниш, где он нужен в ключе карточки: из таблицы характеристик («Бренд», «Торговая марка», «Производитель»),
 * иначе по названию — первое латинское слово или слово заглавными (GIVER, INEKTA, «РУССКАЯ ЗВЕЗДА»), не модель и не тип.
 */
function brandGuess(title, specs = [], model = null) {
  const s = (specs || []).find((x) => /бренд|торгов\S*\s+марк|товарн\S*\s+знак|^производитель/i.test(String(x?.name || '')));
  // приписки магазина к ссылке на бренд: «GLADIATOR все товары», «Varta официальный сайт»
  const v = String(s?.value || '').replace(/[«»"?]/g, '').replace(/^(ооо|ао|зао|оао|пао|ип)\s+/i, '').replace(/\s+(все\s+товары|товары\s+бренда|официальн\S*\s+сайт|подробнее).*$/i, '').trim();
  if (v && v.length <= 30 && !/,/.test(v) && !/^(росси|китай|германи|инди|турци)/i.test(v)) return v;
  const m = compact(model || '');
  const words = String(title || '').replace(/[«»"(),]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (compact(w) === m || /\d/.test(w) || NOT_BRAND.test(w) || w.length < 3) continue;
    if (/^[A-Za-z][A-Za-z&-]{2,}$/.test(w)) return w;
    if (/^[А-ЯЁ]{3,}$/.test(w)) return /^[А-ЯЁ]{3,}$/.test(words[i + 1] || '') && !NOT_BRAND.test(words[i + 1]) ? w + ' ' + words[i + 1] : w;
  }
  return null;
}
const KIND = Object.fromEntries(KINDS.map(([id, niche, label]) => [id, { id, niche, label }]));
// не сам товар нужного вида: принадлежности, услуги, запчасти к нему
const NOT_PRODUCT = /^(коврик|чехол|сумк|кабел|подставк|заправк|ремонт|услуг|чип|запчаст|ролик|шестерн|ракел|лезви|вал\b|термоплен|крепл)/;

/** Начало наименования без «Поставка», кавычек и номеров: по нему определяем вид товара. */
const headName = (name) => String(name || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”]/g, '')
  .replace(/^\s*(поставка|приобретение|закупка)\s+/, '').replace(/^\s*\d+[.)]\s*/, '')
  .replace(/^тонер\s*[—–-]\s*картридж/, 'тонер-картридж') // «Тонер — картридж CF226Х» — картридж, а не тонер
  .trim();

/**
 * Вид товара по наименованию (позиции ТЗ или товара на странице).
 * @returns {{id, niche, label}|null} null — не из ниш базы (посуда, услуги) или принадлежность
 */
/** Принадлежность, запчасть или услуга к товару, а не сам товар. */
const isAccessory = (name) => NOT_PRODUCT.test(headName(name));

function kindOf(name, { code = '' } = {}) {
  const head = headName(name);
  if (!head || NOT_PRODUCT.test(head)) return null;
  const hit = KINDS.find(([, , , re]) => re.test(head));
  if (hit) return KIND[hit[0]];
  // наименования во множественном числе («персональных компьютеров») и в одно слово с кодом КТРУ
  if (/^персональн\S*\s+компьютер|^компьютер/.test(head)) return KIND.pc;
  const c = String(code || '');
  if (/^26\.20\.11/.test(c)) return /планшет/.test(head) ? null : KIND.laptop;
  if (/^26\.20\.15/.test(c)) return /моноблок/.test(head) ? KIND.aio : KIND.pc;
  if (/^26\.20\.17/.test(c)) return KIND.monitor;
  if (/^20\.59\.12|^28\.23\.25/.test(c) && /картридж/.test(head)) return KIND.cartridge;
  return null;
}

/** Модель товара по названию: у мебели — своё правило, у техники — номер модели. */
const modelFromTitle = (title, kind = kindOf(title)) => (kind?.niche === 'furniture' ? furnitureModel(title) : modelOf(title));

// «G&amp;G» в названии со страницы — «G&G»
const decodeTitle = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').trim();
const compact = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
const normName = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/[:.]+$/, '').trim();
// «найденное» при сверке, которое значением не является
const NOT_VALUE = /^(на странице нет|не проверено|значение на странице не названо|по конфигурации|не указан|нет данных|\?)/i;

// Числа значения: «1 600 стр.» → [1600], «15,6"» → [15.6]
const numbersOf = (v) => (String(v ?? '').replace(/(\d)[\s\u00a0](?=\d{3}(?!\d))/g, '$1').match(/\d+(?:[.,]\d+)?/g) || []).map((x) => Number(x.replace(',', '.')));
// у этих характеристик разные значения у разных продавцов — не расхождение
const NO_CONFLICT = /артикул|код|штрих|ean|sku|гаранти|цена|стоимост|упаковк|коробк|брутто|наличи|остат|срок|доставк|рейтинг|отзыв/i;

/**
 * Объединить характеристики: новое значение добавляется, если такой характеристики ещё нет. Если есть, но числа
 * в значениях не совпадают ни одним («Ресурс: 3000» и «Ресурс: 2500»), — это расхождение: старое остаётся, а пара
 * уходит в conflicts (решает человек).
 */
function mergeSpecs(old, add, conflicts = null) {
  const out = [...(old || [])];
  const byName = new Map(out.map((s) => [normName(s.name), s]));
  for (const s of add || []) {
    const k = normName(s.name);
    if (!k || s.value == null || !String(s.value).trim()) continue;
    const prev = byName.get(k);
    if (prev) {
      // значение из паспорта производителя и выбранное человеком — главные: продавец с другим числом их не оспаривает
      if (conflicts && !NO_CONFLICT.test(k) && !['паспорт производителя', 'сайт производителя'].includes(prev.from) && prev.by !== 'человек') {
        const a = numbersOf(prev.value);
        const b = numbersOf(s.value);
        if (a.length && b.length && !a.some((x) => b.includes(x))) conflicts.push({ name: prev.name, old_value: String(prev.value), old_src: prev.src || null, new_value: String(s.value), new_src: s.src || null });
      }
      continue;
    }
    byName.set(k, s);
    out.push(s);
  }
  return out.slice(0, 200);
}

/** Объединить источники: один адрес — одна запись, свежая цена заменяет старую. */
function mergeSources(old, add) {
  const map = new Map((old || []).map((s) => [s.url, s]));
  for (const s of add || []) {
    const prev = map.get(s.url);
    map.set(s.url, prev && prev.price_at && s.price_at && prev.price_at > s.price_at ? { ...s, price: prev.price, price_at: prev.price_at } : { ...prev, ...s });
  }
  return [...map.values()].slice(-30);
}

function createProductBase({ db, registry = null, clock = () => new Date(), log = console, knowledgeDir = null }) {
  db.exec(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, niche TEXT NOT NULL, kind TEXT NOT NULL,
    brand TEXT, model TEXT, title TEXT, specs_json TEXT NOT NULL DEFAULT '[]', sources_json TEXT NOT NULL DEFAULT '[]',
    text TEXT, registry_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS products_kind ON products (kind);`);
  const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
  const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

  /**
   * Добавить или дополнить карточку.
   * @param conflicts массив — сюда попадут расхождения со старыми значениями (не передан — не ищутся)
   * @returns {{status: 'new'|'updated'|'same', id, added: number}} added — сколько характеристик добавлено
   */
  function upsert(p) {
    // prefer — источник надёжнее прежних (паспорт производителя): его значения заменяют прежние с тем же названием
    const { kind, brand, model, title: rawTitle, specs = [], sources = [], text = null, registry_note = null, conflicts = null, prefer = false } = p;
    const title = decodeTitle(rawTitle);
    if (BRANDED.has(kind.niche) && (!brand || badModel(model))) return { status: 'same', id: null, added: 0 };
    const key = BRANDED.has(kind.niche) ? `${kind.id}:${compact(brand)}:${compact(model)}` : `${kind.id}:${compact(model)}`;
    const at = clock().toISOString();
    const row = db.prepare('SELECT id, specs_json, sources_json, text, registry_note, brand FROM products WHERE key = ?').get(key);
    if (!row) {
      db.prepare(`INSERT INTO products (key, niche, kind, brand, model, title, specs_json, sources_json, text, registry_note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key, kind.niche, kind.id, brand || null, model, title, JSON.stringify(mergeSpecs([], specs)), JSON.stringify(mergeSources([], sources)), text, registry_note, at, at);
      return { status: 'new', id: Number(db.prepare('SELECT id FROM products WHERE key = ?').get(key).id), added: mergeSpecs([], specs).length };
    }
    const oldSpecs = JSON.parse(row.specs_json || '[]');
    // Старшинство: выбор человека > паспорт производителя > сайт производителя > продавец. Источник «важнее продавца»
    // (prefer) заменяет значения продавца, но не выбранное человеком и не паспорт (паспорт заменяет только новый паспорт).
    const passportOnly = specs.length && specs.every((n) => n.from === 'паспорт производителя');
    const locked = oldSpecs.filter((x) => x.by === 'человек' || (x.from === 'паспорт производителя' && !passportOnly));
    const specsNew = prefer ? mergeSpecs(mergeSpecs(locked, specs), oldSpecs) : mergeSpecs(oldSpecs, specs, conflicts);
    const sourcesNew = mergeSources(JSON.parse(row.sources_json || '[]'), sources);
    // страница производителя — самый полный текст; текст продавца её не заменяет
    const textNew = text && (!row.text || text.length > row.text.length) ? text : row.text;
    db.prepare('UPDATE products SET specs_json = ?, sources_json = ?, text = ?, registry_note = COALESCE(?, registry_note), brand = COALESCE(brand, ?), updated_at = ? WHERE id = ?')
      .run(JSON.stringify(specsNew), JSON.stringify(sourcesNew), textNew, registry_note, brand || null, at, row.id);
    return { status: specsNew.length > oldSpecs.length ? 'updated' : 'same', id: row.id, added: specsNew.length - oldSpecs.length };
  }

  /** Карточка по модели (любого вида той же ниши): есть ли товар в базе. */
  function findModel(model, niche = null) {
    const k = compact(model);
    if (k.length < 3) return null;
    return db.prepare(`SELECT id, kind, niche, model, title FROM products WHERE key LIKE ? ${niche ? 'AND niche = ?' : ''} LIMIT 1`).get(...[`%:${k}`, ...(niche ? [niche] : [])]) || null;
  }
  /** Одна карточка целиком. */
  function get(id) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
    return p ? { ...p, specs: JSON.parse(p.specs_json || '[]'), sources: JSON.parse(p.sources_json || '[]') } : null;
  }
  /** Заменить значение характеристики (решение человека по расхождению). */
  function setSpec(id, name, value, src) {
    const p = get(id);
    if (!p) return false;
    const k = normName(name);
    const specs = p.specs.map((x) => (normName(x.name) === k ? { ...x, value, src, by: 'человек' } : x));
    db.prepare('UPDATE products SET specs_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(specs), clock().toISOString(), p.id);
    return true;
  }

  /** Модели производителей из реестра (компьютеры): страница производителя целиком — источник. */
  function importRegistry() {
    const out = { new: 0, updated: 0, same: 0 };
    if (!registry) return out;
    for (const kindId of ['laptop', 'pc', 'aio', 'monitor']) {
      for (const m of registry.list(kindId)) {
        const { status: r } = upsert({
          kind: KIND[kindId], brand: m.maker_name, model: modelName(m.title), title: m.title,
          specs: m.specs.map((s) => ({ ...s, src: m.url })), text: m.text, registry_note: m.registry_note,
          sources: [{ url: m.url, type: 'maker', name: m.maker_name, at: m.fetched_at }],
        });
        out[r]++;
      }
    }
    return out;
  }

  /**
   * Страницы товаров из поиска поставщиков (кроме прошлых госконтрактов): таблица характеристик, цена и значения,
   * найденные при сверке с ТЗ. Берём только новые предложения — номер последнего разобранного помним.
   */
  function importOffers({ all = false } = {}) {
    const out = { new: 0, updated: 0, same: 0, skipped: 0 };
    const after = all ? 0 : Number(getSetting('pbase:offers_after') || 0);
    const rows = db.prepare(`SELECT o.id, o.title, o.url, o.domain, o.price, o.price_date, o.created_at, o.match, o.specs_json, o.match_checks_json, o.source,
        i.name AS item_name, i.ktru_code, i.okpd2_code
      FROM offers o JOIN tender_items i ON i.id = o.item_id
      WHERE o.id > ? AND o.source NOT IN ('contracts') AND o.url IS NOT NULL AND o.title IS NOT NULL ORDER BY o.id`).all(after);
    let last = after;
    for (const row of rows) {
      last = row.id;
      const o = { ...row, title: decodeTitle(row.title) };
      // вид — по названию товара; если в названии его нет («HP 85A CE285A»), по позиции ТЗ, но только у подошедшего товара
      const kind = kindOf(o.title) || (['соответствует', 'частично'].includes(o.match) ? kindOf(o.item_name, { code: o.ktru_code || o.okpd2_code }) : null);
      const model = badModel(modelFromTitle(o.title, kind)) ? null : modelFromTitle(o.title, kind);
      if (!kind || !model) { out.skipped++; continue; }
      const specs = (() => { try { return JSON.parse(o.specs_json || '[]') || []; } catch { return []; } })().map((s) => ({ name: s.name, value: s.value, src: o.url }));
      // значения со сверки с ТЗ — под названием требования из ТЗ: так их потом и спросят
      let checks = null;
      try { checks = JSON.parse(o.match_checks_json || 'null'); } catch { checks = null; }
      const fromChecks = (checks?.rows || [])
        .filter((r) => (r.verdict === 'yes' || r.verdict === 'no') && r.found && !NOT_VALUE.test(String(r.found)) && !/нейросеть повторила/.test(String(r.found)))
        .map((r) => ({ name: r.name, value: String(r.found).slice(0, 200), src: o.url, from: 'сверка с ТЗ' }));
      if (specs.length + fromChecks.length < 3) { out.skipped++; continue; }
      const { status: r } = upsert({
        kind, brand: BRANDED.has(kind.niche) ? brandGuess(o.title, specs, model) : brandOf(o.title), model, title: o.title, specs: [...specs, ...fromChecks],
        sources: [{ url: o.url, type: 'supplier', name: o.domain, price: o.price ?? null, price_at: o.price_date || o.created_at }],
      });
      out[r]++;
    }
    if (last > after) setSetting('pbase:offers_after', last);
    return out;
  }

  let running = null;
  /** Пополнить базу из накопленного: модели из реестра и новые найденные страницы товаров. */
  /** Готовая база знаний (config/knowledge): загружается один раз на версию пакета. */
  function importKnowledge({ force = false } = {}) {
    const out = { new: 0, updated: 0, same: 0, version: null };
    let version;
    if (!knowledgeDir) return out;
    try { version = knowledge.seedVersion(knowledgeDir); } catch { return out; }
    out.version = version;
    if (!force && getSetting('pbase:kb_version') === version) return out;
    for (const c of knowledge.seedCards(knowledgeDir)) {
      const kind = KIND[c.kindId];
      if (!kind) continue;
      const { status } = upsert({ kind, brand: c.brand, model: c.model, title: c.title, specs: c.specs, sources: c.sources, prefer: true });
      out[status]++;
    }
    setSetting('pbase:kb_version', version);
    return out;
  }

  function refresh({ all = false } = {}) {
    if (running) return running;
    running = Promise.resolve().then(() => {
      db.exec('BEGIN');
      try {
        const knowledgeOut = importKnowledge();
        const registryOut = importRegistry();
        const offersOut = importOffers({ all });
        db.exec('COMMIT');
        const r = { knowledge: knowledgeOut, registry: registryOut, offers: offersOut, at: clock().toISOString() };
        setSetting('pbase:last_refresh', JSON.stringify(r));
        if (knowledgeOut.new + knowledgeOut.updated + registryOut.new + offersOut.new + offersOut.updated) log.log?.(`[products] база товаров: новых ${knowledgeOut.new + registryOut.new + offersOut.new}, дополнено ${knowledgeOut.updated + registryOut.updated + offersOut.updated}${knowledgeOut.version && (knowledgeOut.new + knowledgeOut.updated) ? ` (из базы знаний: ${knowledgeOut.new + knowledgeOut.updated + knowledgeOut.same})` : ""}`);
        return r;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }).finally(() => { running = null; });
    return running;
  }

  /** Карточки одного вида — в том виде, в каком их сверяет pickModels. */
  function list(kindId) {
    return db.prepare('SELECT * FROM products WHERE kind = ? ORDER BY id').all(kindId).map((p) => {
      const sources = JSON.parse(p.sources_json || '[]');
      const maker = sources.find((s) => s.type === 'maker');
      const kb = sources.find((s) => s.type === 'kb');
      const official = sources.find((s) => s.type === 'official');
      const priced = sources.filter((s) => s.price != null).sort((a, b) => String(b.price_at).localeCompare(String(a.price_at)))[0] || null;
      return {
        id: p.id, kind: p.kind, niche: p.niche, title: p.title, model: p.model, brand: p.brand,
        maker: p.brand || maker?.name || sources[0]?.name || '', maker_name: p.brand || maker?.name || sources[0]?.name || '',
        url: maker?.url || kb?.url || official?.url || priced?.url || sources[0]?.url, specs: JSON.parse(p.specs_json || '[]'), text: p.text || '',
        registry_note: p.registry_note, from_registry: Boolean(maker), from_kb: Boolean(kb), from_official: Boolean(official),
        price: priced ? { value: priced.price, at: priced.price_at, url: priced.url, site: priced.name } : null,
        sources: sources.length,
      };
    });
  }

  /** Сколько карточек: по нишам и видам, сколько с ценой и из реестра. */
  function status() {
    const kinds = db.prepare('SELECT kind, COUNT(*) n FROM products GROUP BY kind').all();
    const niches = {};
    for (const k of kinds) { const n = KIND[k.kind]?.niche || 'другое'; niches[n] = (niches[n] || 0) + k.n; }
    let last = null;
    try { last = JSON.parse(getSetting('pbase:last_refresh') || 'null'); } catch { last = null; }
    return {
      total: kinds.reduce((a, k) => a + k.n, 0),
      niches: Object.entries(niches).map(([id, n]) => ({ id, label: NICHE_LABEL[id] || id, n })),
      kinds: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
      last_refresh: last, running: Boolean(running),
    };
  }

  return { refresh, importOffers, importRegistry, importKnowledge, list, status, upsert, findModel, get, setSpec, idle: () => running || Promise.resolve() };
}

module.exports = { BRANDED, badModel, brandGuess, createProductBase, kindOf, isAccessory, mergeSpecs, mergeSources, numbersOf, compact, decodeTitle, furnitureModel, modelFromTitle, KIND, KINDS, NICHE_LABEL };
