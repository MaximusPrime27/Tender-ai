// Недочёты разбора, которые ссылаются на конкретный файл: противоречия между документами, риски и правовые вопросы.
// В просмотре документа целиком они подсвечиваются отдельным цветом — видно, где именно в тексте проблема,
// и можно дочитать окружающий текст, чтобы понять смысл.

const KIND_TITLE = { conflict: 'Противоречие', risk: 'Риск', legal: 'Правовой вопрос' };

/** Источник относится к этому файлу: по номеру файла, а без номера — по имени (в архиве имя бывает с путём). */
function sameFile(src, fileId, fileName) {
  if (src?.fileId != null) return Number(src.fileId) === Number(fileId);
  const a = String(src?.file || '').split('/').pop().replace(/^\+/, '').trim().toLowerCase();
  const b = String(fileName || '').split('/').pop().replace(/^\+/, '').trim().toLowerCase();
  return Boolean(a) && a === b;
}
const short = (s, n = 220) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * Недочёты для файла: [{page, quote, kind, title, text}] без повторов (одна цитата на странице — одна отметка,
 * описания объединяются).
 */
function docMarks(card, fileId, fileName) {
  if (!card) return [];
  const out = new Map();
  const add = (src, kind, text) => {
    if (!src?.quote || !sameFile(src, fileId, fileName)) return;
    const key = `${src.page}|${short(src.quote, 400)}`;
    const cur = out.get(key);
    if (cur) { if (!cur.text.includes(text)) cur.text += `\n${text}`; if (!cur.kinds.includes(kind)) cur.kinds.push(kind); return; }
    out.set(key, { page: Number(src.page) || 1, quote: String(src.quote), kind, kinds: [kind], title: KIND_TITLE[kind], text });
  };
  for (const f of (card.groups || []).flatMap((g) => g.fields || [])) {
    if (!f.conflict) continue;
    const variants = (f.alternatives || []).map((a) => `«${short(a.value, 90)}»`).join(' / ');
    for (const a of f.alternatives || []) for (const s of a.sources || []) add(s, 'conflict', `«${f.label}» указано в документах по-разному: ${variants}`);
  }
  for (const r of card.risks || []) {
    const text = short(r.explanation || r.text || r.title || 'риск', 300);
    for (const s of [...(r.sources || []), ...(r.source ? [r.source] : [])]) add(s, 'risk', text);
  }
  for (const i of card.legal?.issues || []) {
    const text = short([i.condition, i.why && `Почему: ${i.why}`].filter(Boolean).join('. '), 360);
    for (const s of i.sources || []) add(s, 'legal', text);
  }
  // у места с несколькими замечаниями — все виды в заголовке подсказки
  return [...out.values()].map((m) => ({ ...m, title: m.kinds.map((k) => KIND_TITLE[k]).join(', ') })).sort((a, b) => a.page - b.page);
}

module.exports = { docMarks, sameFile };
