const {test}=require('node:test');
const assert=require('node:assert/strict');
const api=require('../public/product-images.js');
const cases=[
 ['Ноутбук офисный 16 ГБ','laptop'],['IP-камера наружная','ip_camera'],
 ['сетевой коммутатор 24 порта','network_switch'],['Монитор пациента','medical_equipment'],
 ['Картридж для принтера HP','toner'],['Кронштейн для монитора','generic_supply_box'],
 ['Ноутбук и коммутатор','generic_supply_box'],['Столб металлический','generic_supply_box'],
 ['Стол офисный','office_desk'],['Бумага A4 для печати','office_paper'],
 ['Серверный шкаф','server_rack'],['Шкаф для документов','storage_cabinet'],
 ['Картридж для фильтра воды','generic_supply_box'],['Шина медная электрическая','generic_supply_box'],
 ['Батарея отопления','generic_supply_box'],['Видеорегистратор автомобильный','generic_supply_box'],
 ['Сканер штрихкодов','generic_supply_box'],['Сканер документов','scanner'],
 ['Услуги по ремонту ноутбука',null],['Монтаж видеокамеры',null],
 ['Гипсокартон листовой','sheet_material'],['Жарочный шкаф','kitchen_equipment'],
 ['Краска водоэмульсионная','paint'],['Мониторы пациента','medical_equipment'],
 ['Аккумуляторная батарея','batteries'],['Лабораторная посуда','laboratory'],
 ['Крепёж','fasteners'],['Неизвестная позиция 888','generic_supply_box']
];
for(const [name,id] of cases)test(name,()=>assert.equal(api.classify(name).id,id));
test('real image has priority over a manual illustration',()=>{
 const r=api.resolve({name:'Ноутбук',manualCategoryId:'monitor',realImages:[{url:'https://example.org/p.jpg',kind:'supplier'}]});
 assert.equal(r.primary.kind,'supplier');assert.equal(r.fallback.categoryId,'monitor');
});
test('manual category overrides known category',()=>assert.equal(api.resolve({categoryId:'monitor',manualCategoryId:'laptop'}).primary.categoryId,'laptop'));
test('invalid manual category does not become a URL',()=>assert.equal(api.resolve({name:'Ноутбук',manualCategoryId:'../../bad'}).primary.categoryId,'laptop'));
test('category images cannot enter real photo priority',()=>assert.equal(api.resolve({name:'Ноутбук',realImages:[{url:'https://x.test/a.webp',kind:'ai_category_illustration'}]}).primary.kind,'ai_category_illustration'));
test('services never get fake product illustrations',()=>assert.equal(api.resolve({name:'Ноутбук',itemKind:'service',categoryId:'laptop'}).primary,null));
test('unsafe and mixed-content URLs rejected by default',()=>{
 for(const url of ['javascript:alert(1)','data:image/svg+xml,x','//evil.test/a','http://example.org/a','https://user:pass@example.org/a','/\\evil.test/a'])assert.equal(api.safePhotoUrl(url),null);
 assert.equal(api.safePhotoUrl('/photos/1/a.png'),'/photos/1/a.png');
});
test('ambiguous result exposes candidates',()=>{const r=api.classify('Ноутбук и коммутатор');assert.equal(r.reason,'ambiguous_name');assert.equal(r.candidates.length,2)});
test('known category supports unsupported synonyms without guessing',()=>assert.equal(api.resolve({name:'Специализированный объект',categoryId:'laboratory'}).primary.categoryId,'laboratory'));
test('error chain is finite and preserves the figure',()=>{
 const old=global.document;
 global.document={createElement(tag){return {tagName:tag,dataset:{},children:[],handlers:{},append(...nodes){this.children.push(...nodes)},removeAttribute(name){delete this[name]},addEventListener(type,handler){this.handlers[type]=handler}}}};
 try{
  const f=api.createFigure({name:'Ноутбук',realImages:[{url:'https://example.org/photo.jpg',kind:'supplier'}]},{assetBase:'/assets/test'});
  const img=f.children[0],caption=f.children[1];
  assert.equal(f.dataset.imageSource,'supplier');
  img.handlers.error();assert.equal(f.dataset.categoryId,'laptop');assert.equal(caption.textContent,'Иллюстрация категории');
  img.handlers.error();assert.equal(f.dataset.categoryId,'generic_supply_box');
  img.handlers.error();assert.equal(img.hidden,true);assert.equal(f.dataset.imageSource,'unavailable');
  img.handlers.error();assert.equal(f.children.length,2);assert.equal(img.hidden,true);
 }finally{if(old===undefined)delete global.document;else global.document=old}
});

// В проекте: у каждой категории каталога есть обе картинки (320 и 768) в public/assets/tender-products.
test('в проекте лежат картинки всех категорий каталога, 320 и 768', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const catalog = require('../public/product-catalog.js');
  const dir = path.join(__dirname, '..', 'public', 'assets', 'tender-products');
  const missing = catalog.categories.flatMap((c) => ['320', '768'].map((s) => `${s}/${c.id}.webp`)).filter((p) => !fs.existsSync(path.join(dir, p)));
  assert.deepEqual(missing, []);
  assert.equal(catalog.categories.length, 72);
});

// tender-ai: дополнения словаря — частые формулировки из извещений; аксессуары и смешанные наборы по-прежнему нейтральные.
test('дополнения словаря: компьютер персональный, моноблок, стул офисный, видеокамера ip, кран шаровый, тетрадь', () => {
  const cases = [
    ['Компьютер персональный настольный (моноблок)', 'desktop'], ['Моноблок 23,8"', 'desktop'],
    ['Стул офисный на металлокаркасе', 'office_chair'], ['Видеокамера IP купольная', 'ip_camera'],
    ['Телефон IP Yealink', 'telephony'], ['Кран шаровый латунный DN20', 'valves_fittings'], ['Тетрадь 48 листов', 'stationery'],
    ['Подставка для моноблока', 'generic_supply_box'], ['Моноблок и принтер', 'generic_supply_box'], ['Чехол для тетради', 'generic_supply_box'],
  ];
  for (const [name, id] of cases) assert.equal(api.classify(name).id, id, name);
});
