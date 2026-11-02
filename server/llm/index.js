// Единый интерфейс LLM: complete({system, messages, json, task}) → {text, usage: {in, out}}.
// Код анализа не знает, какой провайдер подключён. `task` нужен только mock-провайдеру.

const config = require('../config');

const PROVIDERS = {
  'openai-compatible': () => require('./openai-compatible'),
  gigachat: () => require('./gigachat'),
  yandexgpt: () => require('./yandexgpt'),
  mock: () => require('./mock'),
};

function createLlm(name = config.LLM_PROVIDER, env = process.env) {
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(`Неизвестный LLM_PROVIDER «${name}». Допустимо: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return factory().create(env, { timeoutMs: config.LLM_TIMEOUT_MS });
}

function requireEnv(env, keys, provider) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Для провайдера ${provider} заполните в .env: ${missing.join(', ')}`);
}

/** fetch с таймаутом и понятной ошибкой без утечки тела запроса в лог. */
async function postJson(url, { headers, body, timeoutMs, form }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : { 'Content-Type': 'application/json' }), Accept: 'application/json', ...headers },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = err.cause?.code || err.cause?.message || err.message;
    throw new Error(`Нет связи с ${new URL(url).host}: ${cause}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).host} ответил ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} вернул не JSON: ${text.slice(0, 200)}`);
  }
}

module.exports = { createLlm, requireEnv, postJson };
