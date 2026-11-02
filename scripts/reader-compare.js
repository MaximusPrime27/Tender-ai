// Сравнение «кто как читает» на настоящих закупках: облегчённая модель против сильной на тех же фрагментах.
//   node scripts/reader-compare.js --data <папка с app.db> --tenders 25575,27740 --models GigaChat-2,GigaChat-2-Pro [--minutes 9] [--report]
// Тексты документов берутся из сохранённых разборов (база только читается). Эталон для позиций — позиции закупки
// из извещения (структурированные данные источника); эталон для условий — прежний разбор сильной моделью.
// Каждый ответ нейросети сохраняется в <папка>/reader-compare.json: повторный запуск продолжает с того же места
// и не тратит токены на уже полученное. --minutes — сколько работать за один запуск; --report — только отчёт.

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { DatabaseSync } = require('node:sqlite');
const config = require('../server/config');
const { loadExtraCaCertificates } = require('../server/certs');
const { buildChunkQueue, sha } = require('../server/analyze/chunk');
const { callJson, ExtractSchema } = require('../server/analyze/json');
const { verifySource } = require('../server/analyze/verify');
const { RISK_TYPES, fieldsForPrompt } = require('../server/analyze/fields');

const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const dir = arg('data');
if (!dir) { console.error('Укажите папку с базой: --data <папка с app.db>'); process.exit(1); }
const tenderIds = String(arg('tenders', '')).split(',').map(Number).filter(Boolean);
const models = String(arg('models', 'GigaChat-2,GigaChat-2-Pro')).split(',');
const deadline = Date.now() + Number(arg('minutes', 9)) * 60000;
const reportOnly = process.argv.includes('--report');
const storeFile = path.join(dir, 'reader-compare.json');
const store = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : {};
const save = () => fs.writeFileSync(storeFile, JSON.stringify(store));

const ItemsSchema = z.object({
  items: z.array(z.object({
    name: z.coerce.string(), quantity: z.coerce.number().nullable().catch(null), unit: z.coerce.string().nullable().catch(null),
    characteristics: z.array(z.object({ name: z.coerce.string(), value: z.coerce.string() })).default([]),
  })).default([]),
});
const prompt = (name) => fs.readFileSync(path.join(__dirname, '..', 'server', 'analyze', 'prompts', `${name}.md`), 'utf8');
const TASKS = {
  items: { system: prompt('items'), schema: ItemsSchema, requiredKeys: ['items'] },
  extract: { system: prompt('extract').replace('{{FIELDS}}', fieldsForPrompt()).replace('{{RISK_TYPES}}', RISK_TYPES.join(', ')), schema: ExtractSchema, requiredKeys: ['fields', 'risks', 'questions'], emptyNeedsConfirm: ['fields', 'risks', 'questions'] },
};

const db = new DatabaseSync(path.join(dir, 'app.db'), { readOnly: true });
function tenderData(id) {
  const t = db.prepare('SELECT id, number, title, law, analysis_id FROM tenders WHERE id = ?').get(id);
  const files = db.prepare("SELECT id, original_name, text_json FROM files WHERE analysis_id = ? AND status = 'ok' ORDER BY id").all(t.analysis_id);
  const docs = files.map((f) => ({ id: f.id, name: f.original_name, status: 'ok', pages: JSON.parse(f.text_json || '[]') })).filter((d) => d.pages.length);
  const items = db.prepare('SELECT name, quantity, unit, characteristics_json FROM tender_items WHERE tender_id = ? ORDER BY idx').all(id);
  const card = JSON.parse(db.prepare('SELECT card_json FROM analyses WHERE id = ?').get(t.analysis_id).card_json);
  return { t, docs, items, card, chunks: buildChunkQueue(docs, config.LLM_MAX_CHARS_PER_CHUNK) };
}

const words = (s) => new Set(String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 2));
const overlap = (a, b) => { const x = words(a); const y = words(b); return [...x].filter((w) => y.has(w)).length / Math.max(1, Math.min(x.size, y.size)); };
/** Сколько позиций эталона нашлось среди извлечённых: то же количество и похожее название (или единственный кандидат с таким количеством). */
function matchItems(reference, found) {
  const used = new Set();
  let matched = 0;
  for (const r of reference) {
    const same = found.map((f, i) => ({ f, i })).filter(({ f, i }) => !used.has(i) && f.quantity != null && Number(f.quantity) === Number(r.quantity));
    const best = same.sort((a, b) => overlap(b.f.name, r.name) - overlap(a.f.name, r.name))[0];
    if (best && (overlap(best.f.name, r.name) >= 0.34 || same.length === 1)) { used.add(best.i); matched++; }
  }
  return { matched, extra: found.length - used.size };
}
/** Объединение позиций из разных фрагментов — как в сервисе: то же количество и почти то же название — одна позиция. */
function mergeItems(lists) {
  const out = [];
  for (const it of lists.flat()) {
    const same = out.find((o) => (o.quantity ?? null) === (it.quantity ?? null) && overlap(o.name, it.name) >= 0.8);
    if (!same) out.push({ ...it });
  }
  return out;
}
const digits = (v) => (String(v ?? '').match(/\d+/g) || []).join('');
const KEY_FIELDS = ['nmck', 'bid_deadline', 'delivery_term', 'delivery_place', 'payment_terms', 'contract_security', 'bid_security', 'customer', 'subject'];
const sameValue = (key, a, b) => (a == null || b == null ? false : ['nmck', 'bid_deadline', 'contract_security', 'bid_security'].includes(key) ? digits(a).slice(0, 8) === digits(b).slice(0, 8) && digits(a).length > 0 : overlap(a, b) >= 0.5);

async function main() {
  if (!reportOnly) {
    loadExtraCaCertificates(config.EXTRA_CA_DIR, { log() {}, warn() {}, error() {} });
    const { create } = require('../server/llm/gigachat');
    for (const model of models) {
      const llm = create({ ...process.env, GIGACHAT_MODEL: model }, { timeoutMs: config.LLM_TIMEOUT_MS });
      for (const id of tenderIds) {
        const { chunks } = tenderData(id);
        for (const task of Object.keys(TASKS)) {
          for (const chunk of chunks) {
            const key = `${model}|${task}|${id}|${sha(TASKS[task].system + chunk.text).slice(0, 24)}`;
            if (store[key]) continue;
            if (Date.now() > deadline) { save(); console.log('время запуска вышло — продолжение следующим запуском'); return report(); }
            const started = Date.now();
            try {
              const r = await callJson(llm, { ...TASKS[task], user: chunk.text, task: `compare_${task}` });
              store[key] = { ok: true, data: r.data, usage: r.usage, attempts: r.attempts, ms: Date.now() - started };
            } catch (err) {
              // закончился пакет — дальше по этой модели идти бессмысленно; остальные сбои запоминаем как результат
              if (err.kind === 'quota') { console.log(`${model}: пакет запросов закончился`); break; }
              store[key] = { ok: false, kind: err.kind || 'error', error: String(err.message).slice(0, 200), usage: err.usage, attempts: err.attempts, ms: Date.now() - started };
            }
            save();
            process.stdout.write('.');
          }
        }
      }
    }
    console.log('\nвсе запросы выполнены');
  }
  report();
}

function report() {
  const total = {};
  for (const model of models) total[model] = { calls: 0, done: 0, failed: {}, tokensIn: 0, tokensOut: 0, ms: 0, itemsRef: 0, itemsMatched: 0, itemsExtra: 0, fields: 0, verified: 0, keyRef: 0, keyAgree: 0, keyFound: 0, retries: 0 };
  for (const id of tenderIds) {
    const { t, docs, items, card, chunks } = tenderData(id);
    console.log(`\nЗакупка ${id} (${t.law}) — ${String(t.title).slice(0, 60)} | файлов ${docs.length}, фрагментов ${chunks.length}, позиций в извещении ${items.length}`);
    const maxFields = Object.fromEntries(card.groups.flatMap((g) => g.fields).filter((f) => f.status === 'found').map((f) => [f.key, f.value]));
    for (const model of models) {
      const T = total[model];
      const res = (task) => chunks.map((c) => store[`${model}|${task}|${id}|${sha(TASKS[task].system + c.text).slice(0, 24)}`]);
      const all = [...res('items'), ...res('extract')];
      T.calls += all.length;
      for (const r of all.filter(Boolean)) {
        T.done++; T.tokensIn += r.usage?.in || 0; T.tokensOut += r.usage?.out || 0; T.ms += r.ms || 0; T.retries += Math.max(0, (r.attempts || 1) - 1);
        if (!r.ok) T.failed[r.kind] = (T.failed[r.kind] || 0) + 1;
      }
      if (all.some((r) => !r)) { console.log(`  ${model}: ещё не готово (${all.filter(Boolean).length} из ${all.length} запросов)`); continue; }
      const found = mergeItems(res('items').filter((r) => r.ok).map((r) => r.data.items));
      const m = matchItems(items, found);
      T.itemsRef += items.length; T.itemsMatched += m.matched; T.itemsExtra += m.extra;
      const fields = res('extract').filter((r) => r.ok).flatMap((r) => r.data.fields.map((f) => ({ ...f, source: verifySource(f, docs) })));
      const byKey = new Map();
      for (const f of fields) if (!byKey.has(f.key)) byKey.set(f.key, f);
      T.fields += fields.length; T.verified += fields.filter((f) => f.source.verified).length;
      let agree = 0;
      let ref = 0;
      let got = 0;
      for (const k of KEY_FIELDS) {
        if (maxFields[k] == null) continue;
        ref++;
        const mine = fields.filter((f) => f.key === k);
        if (mine.length) got++;
        if (mine.some((f) => sameValue(k, f.value, maxFields[k]))) agree++;
      }
      T.keyRef += ref; T.keyAgree += agree; T.keyFound += got;
      const fails = all.filter((r) => !r.ok).length;
      console.log(`  ${model}: позиций найдено ${m.matched} из ${items.length} (лишних ${m.extra}); полей ${byKey.size}, цитаты подтверждены у ${fields.filter((f) => f.source.verified).length} из ${fields.length}; ключевых условий совпало с прежним разбором ${agree} из ${ref} (найдено ${got})${fails ? `; сбоев ${fails}` : ''}`);
    }
  }
  console.log('\nИтого:');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  for (const model of models) {
    const T = total[model];
    console.log(`  ${model}: запросов ${T.done} из ${T.calls}; позиции ${T.itemsMatched}/${T.itemsRef} (${pct(T.itemsMatched, T.itemsRef)}), лишних ${T.itemsExtra}; цитаты ${pct(T.verified, T.fields)}; ключевые условия ${T.keyAgree}/${T.keyRef} (${pct(T.keyAgree, T.keyRef)}); сбои ${JSON.stringify(T.failed)}; повторов ${T.retries}; токены ${T.tokensIn} + ${T.tokensOut}; среднее время ${T.done ? Math.round(T.ms / T.done / 1000) : 0} с`);
  }
}

main().catch((err) => { save(); console.error('ошибка:', err.message); process.exit(1); });
