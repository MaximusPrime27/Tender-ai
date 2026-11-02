// Сведение результатов по чанкам (reduce) в одну карточку.

const { GROUPS } = require('./fields');
const { normalize } = require('./verify');

const MAX_CANDIDATES = 8;
const LEVEL_ORDER = { high: 0, medium: 1, low: 2 };

const valueKey = (v) => normalize(v).replace(/[.,;:()№-]/g, '');

/** Группирует найденные значения поля: одинаковые (после нормализации) — в одну группу с общими источниками. */
function groupCandidates(items) {
  const groups = [];
  for (const it of items) {
    const k = valueKey(it.value);
    let g = groups.find((x) => x.key === k);
    if (!g) {
      g = { key: k, value: it.value.trim(), sources: [] };
      groups.push(g);
    }
    g.sources.push(it.source);
  }
  return groups.map(({ value, sources }) => ({ value, sources }));
}

/** Есть ли у значения источник: названный файл или цитата. */
const sourced = (s) => Boolean(s && (String(s.file || '').trim() || String(s.quote || '').trim()));

/**
 * Готовая карточка: убрать из противоречий «значения» без источника (они попадали туда до появления этой проверки).
 * Осталось одно настоящее значение — поле перестаёт быть противоречием; не осталось ни одного — «не найдено».
 * @returns {{card, changed: boolean}}
 */
function dropUnsourced(card) {
  let changed = false;
  const groups = (card.groups || []).map((g) => ({
    ...g,
    fields: g.fields.map((f) => {
      if (!f.conflict || !Array.isArray(f.alternatives)) return f;
      const real = f.alternatives.map((a) => ({ ...a, sources: (a.sources || []).filter(sourced) })).filter((a) => a.sources.length);
      if (real.length === f.alternatives.length) return f;
      changed = true;
      const { conflict, alternatives, review, ...rest } = f;
      if (!real.length) return { ...rest, status: 'not_found', value: null, sources: [] };
      if (real.length === 1) return { ...rest, value: real[0].value, sources: real[0].sources };
      return { ...rest, conflict: true, value: real[0].value, sources: real[0].sources, alternatives: real };
    }),
  }));
  if (!changed) return { card, changed };
  // риск «противоречие в документации» строился по тем же значениям: без источника их не остаётся
  const risks = (card.risks || []).map((r) => {
    if (r.type !== 'противоречие_в_документации' || (r.sources || []).every(sourced)) return r;
    const sources = (r.sources || []).filter(sourced);
    return sources.length > 1 ? { ...r, sources } : null;
  }).filter(Boolean);
  return { card: { ...card, groups, risks }, changed };
}

/**
 * Собирает кандидатов по полям из результатов чанков.
 * @returns {Map<string, Array<{value, sources}>>}
 */
function collectFields(chunkResults) {
  const byKey = new Map();
  for (const r of chunkResults) {
    for (const f of r.fields) {
      // «Значение» без источника (нейросеть написала «не указано» и не назвала ни файла, ни цитаты) — не сведения
      // из документа: в карточку оно не идёт и противоречия с настоящим значением не создаёт.
      if (!sourced(f.source)) continue;
      if (!byKey.has(f.key)) byKey.set(f.key, []);
      byKey.get(f.key).push({ value: f.value, source: f.source });
    }
  }
  const out = new Map();
  for (const [key, items] of byKey) out.set(key, groupCandidates(items).slice(0, MAX_CANDIDATES));
  return out;
}

/** Поля, у которых несколько разных значений — их нужно отдать на разрешение конфликтов. */
function conflictsToResolve(candidates) {
  const labels = new Map(GROUPS.flatMap((g) => g.fields.map(([k, l]) => [k, l])));
  return [...candidates.entries()]
    .filter(([, groups]) => groups.length > 1)
    .map(([key, groups]) => ({
      key,
      label: labels.get(key),
      candidates: groups.map((g, i) => ({ n: i + 1, value: g.value, file: g.sources[0].file, page: g.sources[0].page })),
    }));
}

/**
 * Строит поля карточки.
 * @param candidates Map key → группы значений
 * @param resolutions Map key → {contradiction, value, explanation} (от LLM)
 * @param {boolean} partialFailure часть чанков не разобрана → отсутствующие поля помечаются extraction_failed
 * @returns {{groups, contradictionRisks}}
 */
function buildFieldGroups(candidates, resolutions, partialFailure) {
  const contradictionRisks = [];
  const groups = GROUPS.map((g) => ({
    key: g.key,
    title: g.title,
    fields: g.fields.map(([key, label]) => {
      const cands = candidates.get(key);
      if (!cands || !cands.length) {
        return { key, label, status: partialFailure ? 'extraction_failed' : 'not_found', value: null, sources: [] };
      }
      if (cands.length === 1) {
        return { key, label, status: 'found', value: cands[0].value, sources: cands[0].sources };
      }
      const res = resolutions.get(key);
      if (res && !res.contradiction) {
        return {
          key, label, status: 'found',
          value: res.value || cands[0].value,
          sources: cands.flatMap((c) => c.sources),
        };
      }
      // Противоречие (или разрешение не удалось): не схлопываем молча.
      contradictionRisks.push({
        type: 'противоречие_в_документации',
        level: 'high',
        explanation: res?.explanation
          || `Поле «${label}» указано в документации по-разному: ${cands.map((c) => `«${c.value}»`).join(' / ')}`,
        sources: cands.map((c) => c.sources[0]),
      });
      return {
        key, label, status: 'found', conflict: true,
        value: cands[0].value,
        sources: cands[0].sources,
        alternatives: cands,
      };
    }),
  }));
  return { groups, contradictionRisks };
}

function dedupeRisks(risks) {
  const seen = new Map();
  for (const r of risks) {
    const q = r.sources[0] ? valueKey(r.sources[0].quote).slice(0, 80) : valueKey(r.explanation).slice(0, 80);
    const k = `${r.type}|${q}`;
    const prev = seen.get(k);
    if (!prev || LEVEL_ORDER[r.level] < LEVEL_ORDER[prev.level]) seen.set(k, r);
  }
  return [...seen.values()].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

function dedupeQuestions(questions) {
  const seen = new Map();
  for (const q of questions) {
    const k = valueKey(q.text).slice(0, 80);
    if (!seen.has(k)) seen.set(k, q);
  }
  return [...seen.values()];
}

module.exports = {
  dropUnsourced, sourced, collectFields, conflictsToResolve, buildFieldGroups, dedupeRisks, dedupeQuestions, groupCandidates };
