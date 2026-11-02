// Экспорт карточки в Markdown.

const LEVEL = { high: 'высокий', medium: 'средний', low: 'низкий' };

const src = (s) => `${s.file}, стр. ${s.page}${s.verified ? '' : ' (цитата не подтверждена)'}`;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function toMarkdown(analysis) {
  const { card } = analysis;
  const out = [];
  out.push(`# ${analysis.title}`, '');
  out.push(`Разбор от ${new Date(analysis.created_at).toLocaleString('ru-RU')} · модель: ${analysis.provider}/${analysis.model}` +
    (analysis.duration_ms ? ` · ${(analysis.duration_ms / 1000).toFixed(1)} с` : ''), '');

  const s = card.summary;
  out.push('## Итог', '');
  if (s.status === 'found') {
    out.push(`**Рекомендация: ${s.recommendation.value}** _(подсказка ИИ, решение принимает человек)_`, '', s.text, '');
    s.recommendation.reasons.forEach((r) => out.push(`- ${oneLine(r)}`));
    out.push('');
  } else {
    out.push('_Резюме составить не удалось._', '');
  }

  for (const g of card.groups) {
    out.push(`## ${g.title}`, '', '| Поле | Значение | Источник |', '|---|---|---|');
    for (const f of g.fields) {
      const value = f.status === 'found'
        ? oneLine(f.value) + (f.conflict ? ' ⚠ противоречие: ' + f.alternatives.slice(1).map((a) => `«${oneLine(a.value)}»`).join(', ') : '')
        : f.status === 'not_found' ? '_не найдено_' : '_не удалось извлечь_';
      const sources = (f.sources || []).slice(0, 3).map(src).join('; ');
      out.push(`| ${f.label} | ${value.replace(/\|/g, '\\|')} | ${sources.replace(/\|/g, '\\|')} |`);
    }
    out.push('');
  }

  out.push('## Риски', '');
  if (!card.risks.length) out.push('_Риски не найдены._');
  for (const r of card.risks) {
    out.push(`- **[${LEVEL[r.level]}] ${r.type.replace(/_/g, ' ')}** — ${oneLine(r.explanation)}`);
    for (const x of r.sources) out.push(`  - ${src(x)}: «${oneLine(x.quote)}»`);
  }
  out.push('');

  if (card.legal) {
    const L = card.legal;
    out.push('## Соответствие закону', '', `**${L.verdict}** — ${L.decision}. _Предварительная проверка, не юридическое заключение._`, '');
    (L.reasons || []).forEach((r) => out.push(`- ${oneLine(r)}`));
    (L.issues || []).forEach((x, i) => {
      out.push('', `${i + 1}. ${oneLine(x.condition)}`, `   - В чём вопрос: ${oneLine(x.why)}`,
        `   - Норма: ${x.norm ? `${x.norm.article} — ${oneLine(x.norm.rule)}` : 'требует проверки юристом'}`);
      if (x.proposal) out.push(`   - Предлагаемая редакция: ${oneLine(x.proposal)}`);
      for (const y of x.sources || []) out.push(`   - ${src(y)}: «${oneLine(y.quote)}»`);
    });
    (L.notes || []).forEach((n) => out.push('', `_${oneLine(n)}_`));
    if (L.norms_checked_at) out.push('', `_Нормы сверены ${L.norms_checked_at}${L.norms_source ? ` (${L.norms_source})` : ''}._`);
    out.push('');
  }

  out.push('## Вопросы для запроса разъяснений', '');
  if (!card.questions.length) out.push('_Вопросов нет._');
  card.questions.forEach((q, i) => {
    out.push(`${i + 1}. ${oneLine(q.text)}${q.reference ? ` (${q.reference})` : ''}`);
    for (const x of q.sources) out.push(`   - ${src(x)}: «${oneLine(x.quote)}»`);
  });
  out.push('');

  out.push('## Файлы', '');
  for (const f of card.meta.files) {
    out.push(`- ${f.name} — ${f.status === 'ok' ? `разобран, ${f.pages} стр.` : f.message}`);
  }
  if (card.meta.warnings.length) {
    out.push('', '## Предупреждения', '');
    card.meta.warnings.forEach((w) => out.push(`- ${w}`));
  }
  return out.join('\n') + '\n';
}

module.exports = { toMarkdown };
