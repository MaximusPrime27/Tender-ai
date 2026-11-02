// YandexGPT (Yandex Cloud Foundation Models). Документация:
// https://yandex.cloud/ru/docs/foundation-models/text-generation/api-ref/TextGeneration/completion

const API_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

function create(env, { timeoutMs }) {
  const { requireEnv, postJson } = require('./index');
  requireEnv(env, ['YANDEX_API_KEY', 'YANDEX_FOLDER_ID'], 'yandexgpt');
  const model = env.YANDEX_MODEL || 'yandexgpt/latest';

  return {
    provider: 'yandexgpt',
    model,
    async complete({ system, messages, json }) {
      const body = {
        modelUri: `gpt://${env.YANDEX_FOLDER_ID}/${model}`,
        completionOptions: {
          stream: false,
          temperature: Number(env.LLM_TEMPERATURE ?? 0.1),
          maxTokens: String(env.LLM_MAX_TOKENS || 8000),
        },
        messages: [
          { role: 'system', text: system },
          ...messages.map((m) => ({ role: m.role, text: m.content })),
        ],
      };
      // TODO: проверить на реальном ключе — поддержку jsonObject выбранной моделью.
      if (json) body.jsonObject = true;

      const data = await postJson(API_URL, {
        headers: { Authorization: `Api-Key ${env.YANDEX_API_KEY}`, 'x-folder-id': env.YANDEX_FOLDER_ID },
        body,
        timeoutMs,
      });
      const text = data.result?.alternatives?.[0]?.message?.text;
      if (typeof text !== 'string') throw new Error('YandexGPT: пустой ответ модели');
      const u = data.result?.usage || {};
      // status альтернативы: FINAL — ответ полный; TRUNCATED_FINAL — оборван лимитом; CONTENT_FILTER — отфильтрован.
      const st = data.result?.alternatives?.[0]?.status;
      const finish = st === 'ALTERNATIVE_STATUS_FINAL' ? 'stop' : st === 'ALTERNATIVE_STATUS_TRUNCATED_FINAL' ? 'length' : st === 'ALTERNATIVE_STATUS_CONTENT_FILTER' ? 'filtered' : st ? 'other' : 'unknown';
      return { text, finish, finish_raw: st ?? null, model, usage: { in: Number(u.inputTextTokens) || undefined, out: Number(u.completionTokens) || undefined } };
    },
  };
}

module.exports = { create };
