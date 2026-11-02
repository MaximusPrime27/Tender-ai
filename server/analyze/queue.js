// Очередь фрагментов одной задачи (общий разбор, извлечение позиций, чтение ТЗ): каждый фрагмент либо принят,
// либо не разобран с названной причиной, либо отложен (исчерпан бюджет прохода). Ничего не пропадает молча.
// Принятые раньше результаты берутся из хранилища по ключу — повторный проход отправляет только несостоявшееся.

const { ExtractionFailed } = require('./json');
const { halveChunk, sha } = require('./chunk');

// Сколько раз подряд можно делить фрагмент, с объёмом которого модель не справилась.
const MAX_SPLIT_DEPTH = 3;
const SPLIT_KINDS = new Set(['truncated', 'too_large', 'filtered']);

/** Ключ результата: задача + версия промпта и схемы + текст фрагмента (в тексте — имена файлов, страницы и само содержимое). */
const cacheKey = (task, version, text) => sha(`${task}\n${version}\n${text}`);

/**
 * @param chunks  фрагменты из buildChunkQueue: [{id, text, ranges}]
 * @param docs    прочитанные файлы (нужны, чтобы делить слишком большой фрагмент)
 * @param task    имя задачи
 * @param version отпечаток промпта и схемы: изменились — прежние результаты не годятся
 * @param callOne async (text) => {data, attempts, model}; бросает ExtractionFailed
 * @param cache   (key) => {result, model} | null — принятый раньше результат
 * @param budget  сколько фрагментов можно отправить нейросети за этот проход
 * @returns {Promise<Array<{id, cache_key, status, attempts, error_kind, error, model, duration_ms, ranges, result, cached}>>}
 */
async function runQueue({ chunks, docs, task, version, callOne, cache = () => null, budget = Infinity, onProgress = () => {}, onUsage = () => {} }) {
  const queue = chunks.map((c) => ({ ...c, depth: 0 }));
  const records = [];
  let sent = 0;
  let done = 0;
  let quota = null;
  while (queue.length) {
    const chunk = queue.shift();
    done++;
    onProgress({ current: Math.min(done, done + queue.length), total: done + queue.length });
    const key = cacheKey(task, version, chunk.text);
    const base = { id: chunk.id, cache_key: key, ranges: chunk.ranges };
    const hit = cache(key);
    if (hit?.result) { records.push({ ...base, status: 'ok', attempts: 0, model: hit.model || null, duration_ms: 0, result: hit.result, cached: true }); continue; }
    if (quota) { records.push({ ...base, status: 'skipped', attempts: 0, error_kind: 'quota', error: quota }); continue; }
    if (sent >= budget) { records.push({ ...base, status: 'skipped', attempts: 0, error_kind: 'budget', error: 'исчерпан лимит фрагментов за один проход' }); continue; }
    sent++;
    const started = Date.now();
    try {
      const r = await callOne(chunk.text);
      onUsage(r.usage);
      records.push({ ...base, status: 'ok', attempts: r.attempts ?? 1, model: r.model || null, duration_ms: Date.now() - started, result: r.data });
    } catch (err) {
      onUsage(err.usage);
      if (!(err instanceof ExtractionFailed)) throw err;
      // С объёмом модель не справилась — повтор того же запроса ничего не даст: делим фрагмент и ставим части в очередь.
      // Так же — когда нейросеть отказалась отвечать (фильтр провайдера срабатывает на отдельные слова): после деления
      // непрочитанным остаётся только маленький кусок с этим местом, а не весь фрагмент.
      if (SPLIT_KINDS.has(err.kind) && chunk.depth < MAX_SPLIT_DEPTH) {
        const halves = halveChunk(chunk, docs);
        if (halves.length) { queue.unshift(...halves.map((h) => ({ ...h, depth: chunk.depth + 1 }))); done--; continue; }
      }
      // Пакет запросов у провайдера закончился — остальные фрагменты не отправляем: каждый получил бы тот же отказ.
      if (err.kind === 'quota') quota = String(err.message).slice(0, 300);
      records.push({ ...base, status: 'failed', attempts: err.attempts ?? 1, error_kind: err.kind || 'schema', error: String(err.message).slice(0, 300), duration_ms: Date.now() - started });
    }
  }
  return records;
}

module.exports = { runQueue, cacheKey, MAX_SPLIT_DEPTH };
