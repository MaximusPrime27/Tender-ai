// Просмотр отчёта в браузере: та же страница, что в DOCX и PDF (один список блоков), плюс кнопки
// «Скачать в Word», «Открыть PDF», «Печать». Браузеры не показывают .docx сами — поэтому Word открывается так.

const { blocks } = require('./document');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// адреса в тексте — ссылками (источники и нормы удобно открыть сразу)
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<;]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

/** HTML-страница отчёта. links — адреса для кнопок скачивания. */
function toHtml(report, { freshness, stale_reasons, links = {} } = {}) {
  const body = blocks(report, { freshness, stale_reasons }).map((b) => {
    if (b.h === 1) return `<h1>${esc(b.text)}</h1>`;
    if (b.h) return `<h2>${esc(b.text)}</h2>`;
    if (b.table) {
      const sum = b.table.widths.reduce((a, x) => a + x, 0) || 1;
      return `<div class="tw"><table><colgroup>${b.table.widths.map((w) => `<col style="width:${((w / sum) * 100).toFixed(1)}%">`).join('')}</colgroup>`
        + `<thead><tr>${b.table.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
        + `<tbody>${b.table.rows.map((r) => `<tr>${r.map((c) => `<td>${linkify(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    if (b.p) return `<p class="${b.muted ? 'muted' : ''}${b.bold ? ' b' : ''}">${linkify(b.p)}</p>`;
    return '';
  }).join('\n');
  const title = `Полный анализ закупки ${report.scope.procurement_number}`;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --text: #2b241f; --muted: #6b5e52; --head: #8a4b2a; --line: #bfb2a3; --fill: #ede4da; --bg: #f4f0ea; --paper: #fff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 Arial, "DejaVu Sans", sans-serif; }
  .bar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 16px; background: #2b241f; color: #fff; }
  .bar b { margin-right: auto; font-weight: 600; }
  .bar a, .bar button { display: inline-flex; align-items: center; min-height: 38px; padding: 6px 14px; border: 1px solid #fff6; border-radius: 9px; background: transparent; color: #fff; font: inherit; text-decoration: none; cursor: pointer; }
  .bar a.main { background: #b4552c; border-color: #b4552c; }
  .page { max-width: 1000px; margin: 20px auto; padding: 32px 40px; background: var(--paper); box-shadow: 0 1px 6px #0002; }
  h1 { color: var(--head); font-size: 24px; margin: 0 0 10px; }
  h2 { color: var(--head); font-size: 19px; margin: 28px 0 8px; break-after: avoid; }
  p { margin: 6px 0 10px; } p.muted { color: var(--muted); font-size: 13px; } p.b { font-weight: 700; }
  .tw { overflow-x: auto; margin: 8px 0 14px; }
  table { width: 100%; min-width: 560px; border-collapse: collapse; table-layout: fixed; font-size: 13px; }
  th, td { border: 1px solid var(--line); padding: 5px 7px; vertical-align: top; text-align: left; overflow-wrap: break-word; }
  th { background: var(--fill); }
  tr { break-inside: avoid; }
  a { color: #8a4b2a; overflow-wrap: anywhere; }
  @media (max-width: 700px) { .page { margin: 0; padding: 18px 16px; box-shadow: none; } }
  @media print { .bar { display: none; } body { background: #fff; } .page { margin: 0; padding: 0; max-width: none; box-shadow: none; } .tw { overflow: visible; } table { min-width: 0; } }
</style></head>
<body>
<div class="bar"><b>${esc(title)}</b>
  ${links.docx ? `<a class="main" href="${esc(links.docx)}" download>Скачать в Word (.docx)</a>` : ''}
  ${links.pdf ? `<a href="${esc(links.pdf)}" target="_blank" rel="noopener">Открыть PDF</a>` : ''}
  <button type="button" onclick="window.print()">Печать</button>
</div>
<main class="page">
${body}
</main>
</body></html>`;
}

module.exports = { toHtml };
