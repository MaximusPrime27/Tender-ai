(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./product-catalog.js'));
  else root.TenderProductImages = factory(root.TenderProductCatalog);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (catalog) {
  'use strict';
  if (!catalog || !Array.isArray(catalog.categories)) throw new Error('Load catalog.js before product-images.js');
  const byId = new Map(catalog.categories.map(c => [c.id, c]));
  const genericId = 'generic_supply_box';
  const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  // Exact words/phrases. Broad or polysemous keywords are deliberately excluded.
  const excluded = new Set(['дисплей','запчасти','изоляция','арматура','фильтры','батарея','муфта','сканер','видеокамера','шкаф','тумба','плитка','вилка','ведро','щетка','капсулы','таблетки','подушка','планшет']);
  const extras = {
    laptop:['ноутбуки','ноутбука','ноутбуков'], desktop:['системные блоки','персональный компьютер'],
    monitor:['мониторы','монитора','мониторов'], printer_mfp:['принтеры','принтера','принтеров'],
    toner:['картриджи','картриджа','картриджей'], network_switch:['коммутаторы','коммутатора','коммутаторов'],
    ip_camera:['камеры видеонаблюдения','ip камеры','ip видеокамера'],
    nvr:['сетевой видеорегистратор','видеорегистраторы'], router_wifi:['маршрутизаторы','роутеры'],
    scanner:['сканер планшетный','сканер протяжный'], storage_cabinet:['шкаф для документов','шкаф офисный','офисный шкаф','шкаф архивный','тумба офисная'],
    office_chair:['кресла офисные','офисные кресла'], office_desk:['столы офисные','офисные столы'],
    school_furniture:['парты'], sheet_material:['лист гипсокартона'], tiles:['плитка керамическая','керамическая плитка','плитка тротуарная'],
    medical_equipment:['монитор медицинский','медицинский монитор','мониторы пациента'],
    medical_consumables:['шприцы','бинты','медицинские перчатки','перчатки нитриловые медицинские'],
    batteries:['аккумуляторы','аккумуляторная батарея'], filters:['воздушный фильтр','масляный фильтр'],
    hand_tool:['ключ гаечный','гаечный ключ','набор ключей'], tableware:['вилка столовая'],
    tablet:['планшетный компьютер','планшет электронный'], kitchen_equipment:['шкаф жарочный','жарочный шкаф','духовой шкаф'],
    mattress_textiles:['подушка спальная','подушка постельная'], pharma:['таблетки лекарственные','капсулы лекарственные'],
    cleaning_equipment:['ведро уборочное','ведро хозяйственное','щетка для уборки']
  };
  // tender-ai, 18.10.2026: частые формулировки из извещений (порядок слов «как в КТРУ»); проверки — в тесте комплекта
  for (const [id, words] of Object.entries({
    desktop:['компьютер персональный','компьютеры персональные','моноблок','моноблоки'],
    office_chair:['стул офисный','стулья офисные','кресло компьютерное'],
    ip_camera:['видеокамера ip','видеокамеры ip','камера ip','видеокамеры видеонаблюдения','видеокамера видеонаблюдения'],
    telephony:['телефон ip','телефонные аппараты'],
    stationery:['тетрадь','тетради','ежедневник','карандаш','карандаши'],
    valves_fittings:['кран шаровый','краны шаровые']
  })) extras[id] = [...(extras[id] || []), ...words];
  const terms = catalog.categories.flatMap(c => [...c.keywords.filter(k => !excluded.has(k)), ...(extras[c.id] || [])]
    .map(term => ({id:c.id, term:normalize(term)})));
  function classify(name) {
    const text = normalize(name);
    if (!text) return {id:genericId, reason:'empty_name', candidates:[]};
    if (/^(оказание услуг|выполнение работ|услуги|работы по|ремонт|техническое обслуживание|монтаж)( |$)/u.test(text))
      return {id:null, reason:'non_product', candidates:[]};
    if (/(^| )(картридж|картриджи)( |$)/u.test(text) && /(фильтр|смесител|водоочист|водян)/u.test(text))
      return {id:genericId, reason:'unsupported_variant', candidates:[]};
    if (/(^| )шин[аы]( |$)/u.test(text) && /(медн|алюмини|заземлен|электр)/u.test(text))
      return {id:genericId, reason:'unsupported_variant', candidates:[]};
    if (/(^| )видеорегистратор( |$)/u.test(text) && /(автомобил|зеркал)/u.test(text))
      return {id:genericId, reason:'unsupported_variant', candidates:[]};
    // Do not classify an accessory by the equipment mentioned after «для».
    const head = text.split(/ (?:для|к|от) /u)[0];
    const padded = ' '+text+' ';
    let hits = terms.filter(t => { const index=padded.indexOf(' '+t.term+' '); return index>=0 && index<=head.length; });
    // A specific phrase absorbs the generic word it contains: «монитор пациента» > «монитор».
    hits = hits.filter(a => !hits.some(b => b.id !== a.id && b.term.length > a.term.length && (' '+b.term+' ').includes(' '+a.term+' ')));
    const candidates = [...new Set(hits.map(h => h.id))];
    if (candidates.length === 1) return {id:candidates[0], reason:'name_match', candidates};
    return {id:genericId, reason:candidates.length ? 'ambiguous_name' : 'no_match', candidates};
  }
  function safePhotoUrl(value, allowHttp) {
    if (typeof value !== 'string' || !value || /[\u0000-\u0020\\]/u.test(value)) return null;
    if (value.startsWith('/') && !value.startsWith('//')) return value;
    try { const u = new URL(value); return (u.protocol === 'https:' || (allowHttp && u.protocol === 'http:')) && !u.username && !u.password ? u.href : null; }
    catch (_) { return null; }
  }
  function categoryImage(id, options) {
    const c = byId.get(id); if (!c) return null;
    const base = String(options.assetBase || '/assets/tender-products').replace(/\/$/, '');
    return {kind:'ai_category_illustration', categoryId:c.id, src:base+'/768/'+c.id+'.webp',
      srcSet:base+'/320/'+c.id+'.webp 320w, '+base+'/768/'+c.id+'.webp 768w',
      sizes:options.sizes || '(max-width: 600px) 45vw, 240px', width:768, height:768,
      alt:c.alt, caption:'Иллюстрация категории', title:c.alt};
  }
  function resolve(item, options) {
    item = item || {}; options = options || {};
    if (['service','work'].includes(item.itemKind)) return {primary:null, fallback:null, selection:{id:null,reason:'non_product',candidates:[]}};
    let selection;
    if (byId.has(item.manualCategoryId)) selection={id:item.manualCategoryId,reason:'manual_category',candidates:[]};
    else if (byId.has(item.categoryId)) selection={id:item.categoryId,reason:'known_category',candidates:[]};
    else selection=classify(item.name);
    const category=categoryImage(selection.id,options);
    const real = (Array.isArray(item.realImages) ? item.realImages : []).find(p =>
      p && ['supplier','manufacturer','tz'].includes(p.kind) && safePhotoUrl(p.url, options.allowHttp === true));
    if (real) return {primary:{kind:real.kind,src:safePhotoUrl(real.url,options.allowHttp === true),
      alt:String(item.name || 'Изображение товара'),caption:real.kind==='tz'?'Изображение из ТЗ':real.kind==='manufacturer'?'Фото производителя':'Фото поставщика'}, fallback:category, selection};
    return {primary:category, fallback:category && category.categoryId!==genericId?categoryImage(genericId,options):null, selection};
  }
  function createFigure(item, options) {
    if (typeof document === 'undefined') throw new Error('createFigure requires a browser DOM');
    const result=resolve(item,options), figure=document.createElement('figure');
    figure.className='tai-product-media';
    if (!result.primary) { const empty=document.createElement('span'); empty.className='tai-product-empty'; empty.textContent='Работа или услуга'; figure.append(empty); return figure; }
    const img=document.createElement('img'), caption=document.createElement('figcaption');
    img.loading='lazy'; img.decoding='async'; img.referrerPolicy='no-referrer'; img.width=768; img.height=768;
    let fallbackIndex=0;
    const fallbacks=[result.fallback, result.selection.id ? categoryImage(genericId,options || {}) : null]
      .filter((s,i,a)=>s && s.src!==result.primary.src && a.findIndex(x=>x && x.src===s.src)===i);
    function apply(source) {
      figure.dataset.imageSource=source.kind;
      figure.dataset.categoryId=source.categoryId || '';
      caption.textContent=source.caption; img.alt=source.alt; img.title=source.title || source.alt;
      img.removeAttribute('srcset'); img.removeAttribute('sizes');
      if (source.srcSet) { img.sizes=source.sizes; img.srcset=source.srcSet; }
      img.src=source.src;
    }
    img.addEventListener('error', function () {
      if (fallbackIndex<fallbacks.length) { apply(fallbacks[fallbackIndex++]); return; }
      img.hidden=true; caption.textContent='Изображение недоступно';
      figure.dataset.imageSource='unavailable';
    });
    figure.append(img,caption); apply(result.primary); return figure;
  }
  return Object.freeze({classify,resolve,createFigure,normalize,safePhotoUrl,version:'1.0.0'});
});
