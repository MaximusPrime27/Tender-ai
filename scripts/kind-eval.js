// Режим наблюдения для проверки вида товара: что сказала бы модель про предложения эталона. Ничего не меняет.
//   node scripts/kind-eval.js <app.db> <эталон.json> [сколько примеров]
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { buildKindModel, checkKind } = require('../server/offers/kind-model');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const base = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const n = Number(process.argv[4]) || 40;
const t0 = Date.now();
const model = buildKindModel(db.prepare('SELECT name, ktru_code FROM tender_items').all());
console.log(`Видов ${model.kinds.size}, сборка ${Date.now() - t0} мс`);
const sum = {}; const ex = [];
const nicheOf = new Map(db.prepare("SELECT id, direction FROM tenders WHERE direction IS NOT NULL").all().map((r) => [r.id, r.direction]));
const only = process.argv[5] || null;
for (const o of base.offers) {
  if (only && nicheOf.get(o.tender_id) !== only) continue;
  const r = checkKind(model, { name: o.item_name, ktru_code: o.ktru_code }, o);
  const g = `${o.source === 'contracts' ? 'контракт' : 'поставщик'} · ${o.match || '—'} · ${r.verdict}`;
  sum[g] = (sum[g] || 0) + 1;
  if (r.verdict === 'other') ex.push({ c: o.source === 'contracts', chosen: o.chosen, m: o.match, t: `${o.item_name.slice(0, 45)} => ${o.title.slice(0, 60)} :: ${r.why.slice(0, 90)}` });
}
console.log(Object.entries(sum).sort().map(([k, v]) => `${k}: ${v}`).join('\n'));
const pick = (f, l) => { console.log(`-- ${l}`); ex.filter(f).sort(() => Math.random() - 0.5).slice(0, n).forEach((e) => console.log(`${e.m} | ${e.t}`)); };
pick((e) => e.chosen, 'выбранные агентом');
pick((e) => !e.c && !e.chosen && ['соответствует', 'частично'].includes(e.m), 'подходящие у поставщиков');
pick((e) => e.c, 'контракты (должно быть почти пусто)');

pick((x) => !x.c && x.m === 'не хватает данных', 'не хватает данных у поставщиков');
