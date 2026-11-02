// Проверка обучения на отложенных случаях: разметка config/kind-cases.json делится по закупкам 70/30. На 70% модель учится,
// на 30% считается, сколько чужих товаров остаётся «подходящими» и сколько верных потеряно. База только читается.
//   node scripts/kind-holdout.js <app.db>
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { buildKindModel, checkKind } = require('../server/offers/kind-model');

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/kind-cases.json'), 'utf8'));
const held = (c) => Number(c.tender_id) % 10 < 3;
const test = cases.filter(held);
const train = cases.filter((c) => !held(c));
// сырьё модели — позиции всех закупок, кроме отложенных случаев: своё название позиции не должно подсказать ответ
const heldNames = new Set(test.map((c) => c.item_name));
const items = db.prepare('SELECT name, ktru_code FROM tender_items').all().filter((r) => !heldNames.has(r.name));
const asExamples = (list) => list.map((c) => ({ item_name: c.item_name, ktru_code: c.ktru_code, title: c.title, verdict: c.truth === 'same' ? 'right' : 'wrong' }));
const contracts = db.prepare(`SELECT i.name item_name, i.ktru_code, o.title, 'right' verdict FROM offers o JOIN tender_items i ON i.id = o.item_id
  WHERE o.source = 'contracts' AND o.match = 'соответствует'`).all().filter((r) => !heldNames.has(r.item_name));

const score = (label, model) => {
  const r = { других: 0, пропущено: 0, верных: 0, потеряно: 0 };
  const miss = [];
  for (const c of test) {
    const v = checkKind(model, { name: c.item_name, ktru_code: c.ktru_code }, c).verdict;
    if (c.truth === 'other') { r.других++; if (v !== 'other') { r.пропущено++; miss.push(`пропущен: ${c.item_name.slice(0, 40)} → ${c.title.slice(0, 50)}`); } } else { r.верных++; if (v === 'other') { r.потеряно++; miss.push(`потерян: ${c.item_name.slice(0, 40)} → ${c.title.slice(0, 50)}`); } }
  }
  console.log(`${label}: чужих ${r.других}, осталось как подходящие ${r.пропущено} (${r.других ? Math.round((r.пропущено / r.других) * 100) : 0}%); верных ${r.верных}, потеряно ${r.потеряно}`);
  for (const m of miss.slice(0, 12)) console.log(`  ${m}`);
};
console.log(`Случаев ${cases.length}: на обучение ${train.length}, отложено ${test.length}`);
score('Без обучения (пустая модель)', buildKindModel([]));
score('Модель по закупкам', buildKindModel(items));
score('Модель с обучением', buildKindModel(items, [...contracts, ...asExamples(train)]));
