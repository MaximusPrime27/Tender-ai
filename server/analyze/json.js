// Схемы ответов LLM и вызов с валидацией и одной повторной попыткой.

const { z } = require('zod');
const { RISK_TYPES, RISK_LEVELS, RECOMMENDATIONS, FIELD_KEYS } = require('./fields');

const str = z.coerce.string();
const page = z.coerce.number().int().positive().catch(1);

const ref = { file: str.catch(''), page, quote: str.catch('') };

const ExtractSchema = z.object({
  fields: z.array(z.object({ key: z.string(), value: str, ...ref })).default([]),
  risks: z.array(z.object({
    type: z.enum(RISK_TYPES).catch('другое'),
    level: z.enum(RISK_LEVELS).catch('medium'),
    explanation: str,
    ...ref,
  })).default([]),
  questions: z.array(z.object({ text: str, reference: str.catch(''), ...ref })).default([]),
}).transform((d) => ({ ...d, fields: d.fields.filter((f) => FIELD_KEYS.includes(f.key) && f.value.trim()) }));

const ResolveSchema = z.object({
  results: z.array(z.object({
    key: z.string(),
    contradiction: z.preprocess((v) => v === true || v === 'true' || v === 1, z.boolean()),
    value: str.catch(''),
    explanation: str.catch(''),
  })),
});

const SummarySchema = z.object({
  summary: str,
  recommendation: z.enum(RECOMMENDATIONS),
  reasons: z.array(str).default([]),
});

// Правовая проверка: спорные условия со ссылкой на риск или поле карточки и на норму из перечня (по id).
const LegalSchema = z.object({
  issues: z.array(z.object({
    risk: z.preprocess((v) => (v == null || v === '' ? null : Number(v)), z.number().int().positive().nullable()).catch(null),
    field: z.preprocess((v) => (v == null || v === '' ? null : String(v)), z.string().nullable()).catch(null),
    condition: str.catch(''),
    why: str.catch(''),
    norm_id: z.preprocess((v) => (v == null || v === '' ? null : String(v)), z.string().nullable()).catch(null),
    proposal: str.catch(''),
    fatal: z.preprocess((v) => v === true || v === 'true' || v === 1, z.boolean()).catch(false),
  })).default([]),
  reasons: z.array(str).default([]),
});

/**
 * Ответ нейросети не принят. kind — почему (от этого зависит, что делать дальше):
 *   transport    — нет связи, тайм-аут, ошибка сервиса: можно повторить позже;
 *   quota        — у нейросети закончился оплаченный пакет или доступ закрыт (ответ 402/403): повторять бессмысленно,
 *                  пока пакет не пополнен;
 *   too_large    — запрос не поместился в модель: повторять тот же запрос бессмысленно, вход нужно делить;
 *   truncated    — ответ оборван лимитом токенов: даже если он похож на JSON, он неполный — вход нужно делить;
 *   filtered     — провайдер отказался отвечать (тематические ограничения);
 *   invalid_json — в ответе нет разбираемого JSON;
 *   schema       — JSON не по схеме или без обязательных ключей (в том числе пустой объект `{}`);
 *   unconfirmed  — пустой результат без явного подтверждения, что во фрагменте действительно ничего нет.
 */
class ExtractionFailed extends Error {
  constructor(message, kind = 'schema') { super(message); this.kind = kind; }
}

/** Достаёт JSON из ответа модели: снимает ```-ограды и лишний текст вокруг объекта. */
function parseJsonText(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('в ответе нет JSON-объекта');
  t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/**
 * @param requiredKeys ключи, которые обязаны быть в ответе: схема подставляет значения по умолчанию, и без этой
 *   проверки пустой объект `{}` выглядел бы как «ничего не найдено».
 * @param emptyNeedsConfirm ключи-списки: если все они пусты, ответ принимается только с явным `"result": "nothing_found"`.
 */
function validate(text, schema, { requiredKeys = [], emptyNeedsConfirm = null } = {}) {
  let raw;
  try {
    raw = parseJsonText(text);
  } catch (err) {
    return { error: `Невалидный JSON: ${err.message}`, kind: 'invalid_json' };
  }
  const missing = requiredKeys.filter((k) => !(raw && typeof raw === 'object' && k in raw));
  if (missing.length) return { error: `В ответе нет обязательных ключей: ${missing.join(', ')}`, kind: 'schema' };
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`);
    return { error: `JSON не соответствует схеме: ${issues.join('; ')}`, kind: 'schema' };
  }
  if (emptyNeedsConfirm && emptyNeedsConfirm.every((k) => Array.isArray(raw[k]) && !raw[k].length) && raw.result !== 'nothing_found') {
    return { error: 'Пустой результат без подтверждения: если во фрагменте действительно ничего нет, верни "result": "nothing_found"', kind: 'unconfirmed' };
  }
  return { data: r.data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUOTA = /ответил 40[23]|payment required/i;
const TOO_LARGE = /ответил 4(13|22)|context|too (large|long)|maximum.{0,20}tokens|превыш\S+ (контекст|лимит)/i;

/**
 * Вызывает LLM и принимает ответ, только если он полный и по схеме. При ошибке JSON/схемы — одна повторная попытка
 * с текстом ошибки; при сбое связи — одна повторная попытка после паузы. Оборванный лимитом ответ и не поместившийся
 * запрос не повторяются: бросается ExtractionFailed с kind 'truncated' / 'too_large', вход делит вызывающий код.
 * @returns {Promise<{data, usage: {in, out}, attempts, model}>}
 */
async function callJson(llm, { system, user, schema, task, requiredKeys = [], emptyNeedsConfirm = null, retryDelayMs = 2000 }) {
  const usage = { in: 0, out: 0 };
  const add = (u = {}) => { usage.in += u.in || 0; usage.out += u.out || 0; };
  const fail = (message, kind, attempts) => { const err = new ExtractionFailed(message, kind); err.usage = usage; err.attempts = attempts; return err; };
  const messages = [{ role: 'user', content: user }];
  let attempts = 0;

  /** Один запрос к модели: сбой связи превращается в ExtractionFailed — потеря одного фрагмента не должна ронять весь разбор. */
  const ask = async (args) => {
    for (let n = 0; ; n++) {
      attempts++;
      try {
        const r = await llm.complete(args);
        add(r.usage);
        return r;
      } catch (err) {
        if (err instanceof ExtractionFailed) throw err;
        if (QUOTA.test(err.message)) throw fail('У нейросети закончился оплаченный пакет запросов (ответ «Payment Required»). Пополните пакет у провайдера — после этого нажмите «Повторить непрочитанные части»', 'quota', attempts);
        if (TOO_LARGE.test(err.message)) throw fail(`Запрос не поместился в модель: ${err.message.slice(0, 200)}`, 'too_large', attempts);
        if (n >= 1) throw fail(`Нет ответа от нейросети: ${err.message.slice(0, 200)}`, 'transport', attempts);
        await sleep(llm.retryDelayMs ?? retryDelayMs); // подмена в тестах: llm.retryDelayMs = 0
      }
    }
  };
  /** Ответ оборван лимитом или отклонён провайдером — содержимое не рассматриваем вовсе. */
  const finished = (r) => {
    if (r.finish === 'length') throw fail('Ответ нейросети оборван лимитом длины — он неполный, даже если похож на JSON', 'truncated', attempts);
    if (r.finish === 'filtered') throw fail('Нейросеть отказалась отвечать на этот фрагмент (ограничения провайдера)', 'filtered', attempts);
    return r;
  };

  const first = finished(await ask({ system, messages, json: true, task }));
  let v = validate(first.text, schema, { requiredKeys, emptyNeedsConfirm });
  if (v.data) return { data: v.data, usage, attempts, model: first.model || llm.model };

  const retry = finished(await ask({
    system,
    messages: [
      ...messages,
      { role: 'assistant', content: String(first.text).slice(0, 4000) },
      { role: 'user', content: `Ответ не принят. ${v.error}. Верни только корректный JSON строго по схеме из инструкции, без пояснений и markdown.` },
    ],
    json: true,
    task,
    retry: true,
  }));
  v = validate(retry.text, schema, { requiredKeys, emptyNeedsConfirm });
  if (v.data) return { data: v.data, usage, attempts, model: retry.model || llm.model };
  throw fail(v.error, v.kind, attempts);
}

module.exports = { ExtractSchema, ResolveSchema, SummarySchema, LegalSchema, callJson, parseJsonText, validate, ExtractionFailed };
