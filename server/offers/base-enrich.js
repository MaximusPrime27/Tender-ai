// Добор характеристик предложения из своей базы товаров — бесплатно, без поиска в интернете.
// Магазин часто не пишет на странице то, что требует ТЗ (ресурс, цвет, интерфейс), и сверка даёт «частично» или
// «не хватает данных». Та же модель в своей базе уже собрана разведчиком из тех же мест (сайт производителя, паспорт,
// реестр, другие магазины), каждое значение — с источником. Здесь значения базы дописываются к предложению, и сверка
// повторяется.
// Чтобы своя база не внесла ошибку:
//   • только точная модель (ключ карточки «вид:модель» совпал), и вид товара тот же;
//   • бренд в названии предложения другой, чем у карточки (совместимый картридж под модель оригинала), — не берём;
//   • не берём то, что у каждого продавца своё: оригинальность, производитель, бренд, страна, цена, наличие, гарантия;
//   • не берём значения с открытым расхождением в базе (разведчик нашёл разные значения, человек ещё не решил);
//   • значение со страницы магазина всегда важнее значения из базы — дописываются только недостающие.

const { kindOf, modelFromTitle, BRANDED, badModel, compact, brandGuess } = require('./product-base');

// «Совместимые модели», «Совместимость» (список принтеров) — берём; «Тип: ориг/совм» и значение «совместимый» — нет
const SELLER_OWN = /ориг|тип[^:]{0,10}совм|производител|бренд|марк|страна|цена|стоимост|налич|склад|гаранти|артикул|код\s*товара|доставк|упаковк|штрих|ean|в\s*корзин/i;
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');

/**
 * @returns {{specs: Array, added: number, product: {id, model, title}}|null} — null, если брать нечего
 */
function baseSpecsFor({ productBase, db, offer, item }) {
  if (!productBase) return null;
  const kind = kindOf(offer.title || '', { code: item?.ktru_code || item?.okpd2_code || '' }) || kindOf(item?.name || '');
  if (!kind) return null;
  const model = modelFromTitle(String(offer.title || ''), kind);
  if (!model || norm(model).length < 4) return null;
  // «60Ah», «100 мл» — величина, а не модель: так совпали бы разные товары
  if (/^\s*\d+([.,]\d+)?\s*(ah|а\s*ч|ач|a|мл|ml|мм|mm|г|g|см|cm|шт|v|в|mah|мач)?\s*$/i.test(model)) return null;
  if (badModel(model)) return null;
  // медицина и аккумуляторы: карточка — бренд + модель; бренд берём из названия предложения
  const brand = BRANDED.has(kind.niche) ? brandGuess(offer.title || '', offer.specs || [], model) : null;
  if (BRANDED.has(kind.niche) && !brand) return null;
  const hit = BRANDED.has(kind.niche)
    ? (db.prepare('SELECT id, kind, niche, model, title FROM products WHERE key = ?').get(`${kind.id}:${compact(brand)}:${compact(model)}`) || null)
    : productBase.findModel(model, kind.niche);
  if (!hit || hit.kind !== kind.id) return null;
  const p = productBase.get(hit.id);
  if (!p) return null;
  // другой бренд в названии предложения — совместимый товар под чужую модель
  if (p.brand && /совмест|аналог|compatible/i.test(offer.title || '') && !norm(offer.title).includes(norm(p.brand))) return null;
  // мебель, медицина, аккумуляторы: модель — часто артикул или серия, не уникальна между фабриками — нужен и тот же бренд
  if (['furniture', 'medical', 'batteries'].includes(kind.niche) && (!p.brand || !norm(offer.title).includes(norm(p.brand)))) return null;
  let open = new Set();
  try { open = new Set(db.prepare("SELECT name FROM product_conflicts WHERE product_id = ? AND status = 'open'").all(p.id).map((r) => norm(r.name))); } catch { /* разведчик выключен */ }
  const have = new Set((offer.specs || []).map((x) => norm(x.name)));
  const add = (p.specs || []).filter((x) => x.name && x.value != null && String(x.value).trim() && !SELLER_OWN.test(x.name) && !/^\s*(совместим\S*|оригинал\S*|аналог)\s*$/i.test(String(x.value)) &&!have.has(norm(x.name)) && !open.has(norm(x.name)))
    .map((x) => ({ name: x.name, value: x.value, src: `своя база: ${x.from || x.src || 'карточка товара'}` }));
  if (!add.length) return null;
  return { specs: [...(offer.specs || []), ...add], added: add.length, product: { id: p.id, model: p.model, title: p.title } };
}

module.exports = { baseSpecsFor, SELLER_OWN };
