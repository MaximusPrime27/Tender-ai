// ИИ-скоринг закупок пачками: соответствие профилю 0–100, вердикт, причины, что проверить.

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { callJson, ExtractionFailed } = require('../analyze/json');
const { DAY_MS, positiveKeywords } = require('./filters');

const VERDICTS = ['подходит', 'возможно', 'не подходит'];

const ScoreSchema = z.object({
  results: z.array(z.object({
    number: z.coerce.string(),
    score: z.coerce.number().min(0).max(100).transform((n) => Math.round(n)),
    verdict: z.enum(VERDICTS).optional(),
    reasons: z.array(z.coerce.string()).default([]),
    concerns: z.array(z.coerce.string()).default([]),
  })),
});

const verdictFor = (score) => (score >= 70 ? 'подходит' : score >= 40 ? 'возможно' : 'не подходит');

function loadScorePrompt(name = 'score') {
  return fs.readFileSync(path.join(__dirname, '..', 'analyze', 'prompts', `${name}.md`), 'utf8');
}

/**
 * Отпечаток того, что нейросеть видит в профиле при оценке. Пока он не изменился, старые оценки остаются верными:
 * смена видов закупок (44-ФЗ/223-ФЗ/коммерческие), стоп-слов или минимального срока на оценку не влияет.
 */
function scoreBasis(profile) {
  return require('node:crypto').createHash('sha1').update(JSON.stringify(profileForLlm(profile))).digest('hex').slice(0, 16);
}

function profileForLlm(profile) {
  if (profile.mode === 'resale') {
    // Перепродажа: товар любой, важны регион (логистика) и рамки по цене.
    return {
      mode: 'перепродажа', description: profile.description || '', regions: profile.regions, price_min: profile.price_min, price_max: profile.price_max,
      // Направление: товары каких групп посредник берёт (коды ОКПД2 и слова); пусто — любые.
      focus_codes: profile.codes || [], focus_words: positiveKeywords(profile.keywords), focus_exclude: (profile.keywords || []).filter((w) => String(w).trim().startsWith('-')).map((w) => String(w).trim().slice(1)),
    };
  }
  return {
    description: profile.description || '(описание не заполнено)',
    regions: profile.regions,
    price_min: profile.price_min,
    price_max: profile.price_max,
    codes: profile.codes,
    keywords: profile.keywords,
  };
}

function tenderForLlm(t, now) {
  return {
    number: t.number,
    law: require('./filters').lawLabel(t.law),
    title: t.title,
    price: t.price,
    currency: t.currency,
    region: t.region,
    okpd2: t.okpd2,
    ktru: t.ktru,
    deadline_at: t.deadline_at,
    days_left: t.deadline_at ? Math.floor((new Date(t.deadline_at) - now) / DAY_MS) : null,
  };
}

/**
 * Оценивает закупки пачками. Ошибка одной пачки не останавливает остальные.
 * @param {{tenders: Array, profile, llm, batchSize?: number, now?: Date, onResult?: Function}} opts
 *   onResult(tender, {ok: true, score, verdict, reasons, concerns} | {ok: false, error})
 * @returns {Promise<{scored: number, failed: number, usage: {in, out}}>}
 */
async function scoreTenders({ tenders, profile, llm, batchSize = 10, now = new Date(), onResult = () => {} }) {
  const resale = profile.mode === 'resale';
  const system = loadScorePrompt(resale ? 'resale-score' : 'score');
  const task = resale ? 'resale_score' : 'score';
  const usage = { in: 0, out: 0 };
  let scored = 0;
  let failed = 0;

  // split — пачку можно делить: большая (от 5) или уже часть поделённой.
  async function scoreBatch(batch, split = batch.length > 4) {
    const user = JSON.stringify({ profile: profileForLlm(profile), tenders: batch.map((t) => tenderForLlm(t, now)) }, null, 1);
    try {
      const { data, usage: u } = await callJson(llm, { system, user, schema: ScoreSchema, task });
      usage.in += u.in; usage.out += u.out;
      const byNumber = new Map(data.results.map((r) => [r.number, r]));
      for (const t of batch) {
        const r = byNumber.get(String(t.number));
        if (!r) {
          failed++;
          onResult(t, { ok: false, error: 'Модель не вернула оценку для этой закупки' });
          continue;
        }
        scored++;
        onResult(t, {
          ok: true,
          score: r.score,
          verdict: r.verdict || verdictFor(r.score),
          reasons: r.reasons.slice(0, 4),
          concerns: r.concerns.slice(0, 3),
        });
      }
    } catch (err) {
      usage.in += err.usage?.in || 0; usage.out += err.usage?.out || 0;
      // Битый JSON на большой пачке (от 5 закупок) — обычно из-за одной-двух закупок: делим пополам и пробуем ещё раз.
      if (err instanceof ExtractionFailed && split && batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        await scoreBatch(batch.slice(0, half), true);
        await scoreBatch(batch.slice(half), true);
        return;
      }
      // Сбой провайдера или битый ответ на одну закупку: помечаем только эту пачку.
      const error = err instanceof ExtractionFailed ? `Некорректный ответ модели: ${err.message}` : `Ошибка модели: ${err.message}`;
      for (const t of batch) {
        failed++;
        onResult(t, { ok: false, error });
      }
    }
  }

  for (let i = 0; i < tenders.length; i += batchSize) await scoreBatch(tenders.slice(i, i + batchSize));
  return { scored, failed, usage };
}

module.exports = { scoreBasis, scoreTenders, ScoreSchema, verdictFor };
