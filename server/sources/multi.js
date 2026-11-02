// Несколько источников закупок сразу (TENDER_SOURCES): один и тот же тендер, найденный в разных источниках,
// склеивается по «закон + номер извещения»; пустые поля дополняются данными других источников.
// Документы, контракты и цены берутся у первого источника по порядку, который это умеет и отвечает.

const key = (t) => `${t.law}|${String(t.number).trim()}`;

/** Пустые поля первого источника дополняем данными следующего (первый в списке — главный). */
function merge(a, b) {
  const out = { ...b, ...a };
  for (const [k, v] of Object.entries(a)) if (v == null || (Array.isArray(v) && !v.length)) out[k] = b[k] ?? v;
  out.source_name = [a.source_name, b.source_name].filter(Boolean).join('+');
  return out;
}

function createMultiSource(sources, { log = console } = {}) {
  if (!sources.length) throw new Error('Не задан ни один источник закупок (TENDER_SOURCES)');
  if (sources.length === 1) return sources[0];

  /**
   * Первый источник, у которого метод есть и не бросил ошибку. Если первый аргумент — закупка, спрашиваем только
   * источники её вида (44/223-ФЗ — ГосПлан и ЕИС, коммерческая — площадка), чтобы не ждать заведомо пустых ответов.
   */
  async function first(method, args, { fallback = null } = {}) {
    const law = args[0] && typeof args[0] === 'object' ? args[0].law : null;
    const able = sources.filter((s) => typeof s[method] === 'function' && (!law || !s.laws || s.laws.includes(String(law))));
    let lastErr = null;
    for (const s of able) {
      try {
        const r = await s[method](...args);
        if (r != null && (!Array.isArray(r) || r.length)) return r;
      } catch (err) {
        lastErr = err;
        log.warn?.(`[источники] ${s.name}.${method}: ${err.message}`);
      }
    }
    if (lastErr && fallback === null) throw lastErr;
    return fallback;
  }

  return {
    name: sources.map((s) => s.name).join('+'),

    async fetchNew(opts = {}) {
      const byKey = new Map();
      const errors = [];
      let truncated = false;
      // Источник, у которого нет ни одного вида закупок из профиля, не опрашиваем: выбраны только коммерческие —
      // незачем 12 минут ждать ленту ЕИС (пауза 60 с на запрос), чтобы потом всё отсеять по закону.
      const wanted = opts.profile?.laws?.length ? opts.profile.laws.map(String) : null;
      const active = sources.filter((s) => typeof s.fetchNew === 'function' && (!wanted || !s.laws || s.laws.some((l) => wanted.includes(String(l)))));
      for (const [si, s] of active.entries()) {
        // ход: источники по очереди, внутри источника — его запросы
        const onProgress = ({ done = 0, total = 1, label = '' } = {}) => opts.onProgress?.({ done: si + (total ? Math.min(1, done / total) : 0), total: active.length, label });
        onProgress({ done: 0, total: 1, label: s.title || s.name });
        try {
          const r = await s.fetchNew({ ...opts, onProgress, onPage: (page) => opts.onPage?.(page.map((t) => ({ ...t, source_name: t.source_name || s.name }))), onClosed: (list) => opts.onClosed?.(list) });
          truncated = truncated || Boolean(r.truncated);
          errors.push(...(r.errors || []));
          for (const t of r.items || []) {
            const item = { ...t, source_name: t.source_name || s.name };
            const prev = byKey.get(key(item));
            byKey.set(key(item), prev ? merge(prev, item) : item);
          }
        } catch (err) {
          errors.push(`${s.name}: ${err.message}`);
        }
      }
      return { items: [...byKey.values()], truncated, errors };
    },

    getAttachments: (...a) => first('getAttachments', a, { fallback: [] }),
    getDetailsDoc: (...a) => first('getDetailsDoc', a, { fallback: null }),
    listContracts: (...a) => first('listContracts', a, { fallback: [] }),
    getContract: (...a) => first('getContract', a),
    contractsByPurchase: (...a) => first('contractsByPurchase', a, { fallback: [] }),
    getPurchaseMaxPrice: (...a) => first('getPurchaseMaxPrice', a, { fallback: null }),
    getStage: (...a) => first('getStage', a, { fallback: null }),
  };
}

module.exports = { createMultiSource, merge };
