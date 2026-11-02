// GigaChat API (Сбер). Документация: https://developers.sber.ru/docs/ru/gigachat/api/overview
// Сертификат НУЦ Минцифры не входит в стандартное хранилище Node — см. README (NODE_EXTRA_CA_CERTS).

const crypto = require('node:crypto');

const AUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const API_URL = 'https://gigachat.devices.sberbank.ru/api/v1';

// Бесплатный тариф GigaChat обслуживает один запрос за раз: запросы всего процесса идут по очереди,
// а на ответ 429 (занято / лимит) — пауза и повтор.
// Массовые короткие задачи — облегчённой моделью, чтобы беречь бесплатный пакет Max.
const LITE_TASKS = new Set(['score', 'resale_score', 'same_product']);
// Чем закончился ответ — в общих для всех провайдеров словах (см. server/analyze/json.js).
const FINISH = { stop: 'stop', length: 'length', blacklist: 'filtered', error: 'error', function_call: 'other' };
let queue = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}
async function withRetry(fn, { attempts = 5, baseMs = 3000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!/ответил 429/.test(err.message) || i >= attempts) throw err;
      await sleep(baseMs * i);
    }
  }
}

function create(env, { timeoutMs }) {
  const { requireEnv, postJson } = require('./index');
  // Ключ авторизации — это base64(Client ID:Client Secret): можно указать его или пару ID + Secret.
  const authKey = env.GIGACHAT_AUTH_KEY
    || (env.GIGACHAT_CLIENT_ID && env.GIGACHAT_CLIENT_SECRET
      ? Buffer.from(`${env.GIGACHAT_CLIENT_ID.trim()}:${env.GIGACHAT_CLIENT_SECRET.trim()}`).toString('base64') : '');
  if (!authKey) requireEnv(env, ['GIGACHAT_AUTH_KEY'], 'gigachat (или GIGACHAT_CLIENT_ID + GIGACHAT_CLIENT_SECRET)');
  const model = env.GIGACHAT_MODEL || 'GigaChat-2-Max';
  // Массовая оценка ленты — облегчённой моделью: у неё бесплатный лимит больше, а задача простая.
  const scoreModel = env.GIGACHAT_SCORE_MODEL || 'GigaChat-2';
  const scope = env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
  // Какие задачи идут облегчённой моделью (GIGACHAT_LITE_TASKS — список через запятую). У бесплатного тарифа запас
  // токенов у каждой модели свой: массовое чтение — облегчённой, выводы — сильной.
  const lite = env.GIGACHAT_LITE_TASKS != null ? new Set(String(env.GIGACHAT_LITE_TASKS).split(',').map((s) => s.trim()).filter(Boolean)) : LITE_TASKS;
  const modelFor = (task) => (lite.has(task) ? scoreModel : model);
  let token = null; // {value, expiresAt}

  async function getToken() {
    // Обновляем заранее, за минуту до истечения.
    if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
    const data = await postJson(env.GIGACHAT_AUTH_URL || AUTH_URL, {
      form: true,
      headers: { Authorization: `Basic ${authKey.trim()}`, RqUID: crypto.randomUUID() },
      body: { scope },
      timeoutMs: 30_000,
    });
    if (!data.access_token) throw new Error('GigaChat: в ответе OAuth нет access_token');
    // TODO: проверить на реальном ключе — expires_at приходит в миллисекундах (по документации).
    const expiresAt = Number(data.expires_at) > 1e12 ? Number(data.expires_at) : Number(data.expires_at) * 1000;
    token = { value: data.access_token, expiresAt: expiresAt || Date.now() + 25 * 60_000 };
    return token.value;
  }

  return {
    provider: 'gigachat',
    model,
    modelFor,
    async complete({ system, messages, task }) {
      return serial(() => withRetry(() => request({ system, messages, model: modelFor(task) })));
    },
  };

  async function request({ system, messages, model }) {
      const access = await getToken();
      const data = await postJson(`${env.GIGACHAT_API_URL || API_URL}/chat/completions`, {
        headers: { Authorization: `Bearer ${access}` },
        body: {
          model,
          temperature: Number(env.LLM_TEMPERATURE ?? 0.1),
          // TODO: проверить на реальном ключе — лимит max_tokens для выбранной модели.
          max_tokens: Number(env.LLM_MAX_TOKENS || 8000),
          messages: [{ role: 'system', content: system }, ...messages],
        },
        timeoutMs,
      });
      const choice = data.choices?.[0];
      const text = choice?.message?.content;
      if (typeof text !== 'string') throw new Error('GigaChat: пустой ответ модели');
      // finish_reason по документации API: stop — ответ полный; length — оборван лимитом токенов;
      // blacklist — запрос попал под тематические ограничения; error, function_call — к нашим запросам не относятся.
      return { text, finish: FINISH[choice.finish_reason] || (choice.finish_reason ? 'other' : 'unknown'), finish_raw: choice.finish_reason ?? null,
        model: data.model || model, usage: { in: data.usage?.prompt_tokens, out: data.usage?.completion_tokens } };
  }
}

module.exports = { create };
