// OpenAI-совместимый Chat Completions API: Ollama, vLLM, LM Studio, OpenRouter, DeepSeek и др.

function create(env, { timeoutMs }) {
  const { requireEnv, postJson } = require('./index');
  requireEnv(env, ['LLM_BASE_URL', 'LLM_MODEL'], 'openai-compatible');
  const base = env.LLM_BASE_URL.replace(/\/+$/, '');
  const jsonMode = (env.LLM_JSON_MODE || 'json_object').toLowerCase();

  return {
    provider: 'openai-compatible',
    model: env.LLM_MODEL,
    async complete({ system, messages, json }) {
      const body = {
        model: env.LLM_MODEL,
        temperature: Number(env.LLM_TEMPERATURE ?? 0.1),
        messages: [{ role: 'system', content: system }, ...messages],
      };
      if (env.LLM_MAX_TOKENS) body.max_tokens = Number(env.LLM_MAX_TOKENS);
      if (json && jsonMode === 'json_object') body.response_format = { type: 'json_object' };

      const data = await postJson(`${base}/chat/completions`, {
        headers: env.LLM_API_KEY ? { Authorization: `Bearer ${env.LLM_API_KEY}` } : {},
        body,
        timeoutMs,
      });
      const choice = data.choices?.[0];
      const text = choice?.message?.content;
      if (typeof text !== 'string') throw new Error('Пустой ответ модели (choices[0].message.content)');
      const fr = choice.finish_reason;
      const finish = fr === 'stop' ? 'stop' : fr === 'length' ? 'length' : fr === 'content_filter' ? 'filtered' : fr ? 'other' : 'unknown';
      return { text, finish, finish_raw: fr ?? null, model: data.model || env.LLM_MODEL, usage: { in: data.usage?.prompt_tokens, out: data.usage?.completion_tokens } };
    },
  };
}

module.exports = { create };
