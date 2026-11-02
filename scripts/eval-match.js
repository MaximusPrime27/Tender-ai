// Оценка качества подбора «тот же товар» на размеченном наборе реальных пар «позиция ТЗ ↔ товар из контракта».
// Запуск: npm run eval:match            — правила (без нейросети)
//         npm run eval:match -- --llm   — правила + нейросеть из .env для «не ясно» (тратит лимит)
// «До» — как было до этапа 6b: всё под тем же кодом считалось подходящим товаром.

const fs = require('node:fs');
const path = require('node:path');
const { specOf } = require('../server/offers/spec');
const { lineVerdict, lineText, acceptLlmVerdict } = require('../server/tenders/item-benchmark');

const set = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'match-eval.json'), 'utf8'));
const useLlm = process.argv.includes('--llm');

function metrics(pred) {
  let tp = 0; let fp = 0; let fn = 0;
  set.pairs.forEach((p, i) => {
    const same = pred[i] === 'same';
    if (same && p.label === 'same') tp++;
    else if (same) fp++;
    else if (p.label === 'same') fn++;
  });
  return {
    selected: tp + fp,
    wrong_share: tp + fp ? fp / (tp + fp) : 0,
    recall: tp + fn ? tp / (tp + fn) : 0,
  };
}

async function llmVerdicts(pred) {
  const config = require('../server/config');
  const { loadExtraCaCertificates } = require('../server/certs');
  loadExtraCaCertificates(config.EXTRA_CA_DIR, { log() {} });
  const { createLlm } = require('../server/llm');
  const { callJson } = require('../server/analyze/json');
  const { z } = require('zod');
  const system = fs.readFileSync(path.join(__dirname, '..', 'server', 'analyze', 'prompts', 'same-product.md'), 'utf8');
  const schema = z.object({ results: z.array(z.object({ i: z.coerce.number(), same: z.boolean().nullable().catch(null), reason: z.coerce.string().catch('') })) });
  const llm = createLlm();
  const out = pred.slice();
  for (let i = 0; i < set.pairs.length; i++) {
    if (out[i] !== 'unknown') continue;
    const p = set.pairs[i];
    const s = specOf(p.item);
    const text = lineText({ name: p.candidate, chars: p.candidate_chars || '' });
    const { data } = await callJson(llm, { system, schema, task: 'same_product', user: JSON.stringify({ spec: s, candidates: [{ i: 0, name: text }] }) });
    const r = data.results[0];
    out[i] = acceptLlmVerdict(p.item, s, text, r?.same ?? null, r?.reason).verdict;
  }
  return out;
}

(async () => {
  const before = set.pairs.map(() => 'same');
  let after = set.pairs.map((p) => lineVerdict(p.item, specOf(p.item), { name: p.candidate, chars: p.candidate_chars || '' }, p.code).verdict);
  if (useLlm) after = await llmVerdicts(after);
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const show = (name, m) => console.log(`${name.padEnd(28)} выбрано ${String(m.selected).padStart(3)} · из них другой товар ${pct(m.wrong_share).padStart(4)} · найдено того же товара ${pct(m.recall).padStart(4)}`);
  console.log(`Набор: ${set.pairs.length} пар (${set.pairs.filter((p) => p.label === 'same').length} «тот же», ${set.pairs.filter((p) => p.label === 'different').length} «другой»)\n`);
  show('До (только код товара)', metrics(before));
  show(`После (правила${useLlm ? ' + нейросеть' : ''})`, metrics(after));
  const miss = set.pairs.map((p, i) => ({ p, v: after[i] })).filter(({ p, v }) => (v === 'same') !== (p.label === 'same'));
  if (miss.length) {
    console.log('\nРасхождения с разметкой:');
    for (const { p, v } of miss) console.log(` - [${p.label} → ${v}] ${p.item.name} ↔ ${p.candidate}`);
  }
  const m = metrics(after);
  if (process.argv.includes('--strict') && (m.wrong_share > 0.1 || m.recall < 0.7)) process.exitCode = 1;
})();
