// Управляющий агентами: следит за всеми агентами по общему журналу и их собственным таблицам, считает расход платного
// поиска и раз в день (MANAGER_REPORT_HOUR по Москве) шлёт в Telegram отчёт: кто работал, что нашёл, чему научился,
// как идут дела против прошлой недели и что сломалось. Свои показатели (отчёты, тревоги) он тоже пишет в журнал.
//
// Агенты (порядок — иерархия запуска, см. docs/agents.md):
//   checker  — проверяющий находки            bid     — агент заявок (поиск и расчёт выгодных)
//   reader   — читатель документов             night   — разведчик базы товаров (ночной агент)
//   scout    — разведчик поставщиков            outcomes — итоги торгов (внутри агента заявок)
//   application — подготовка заявки

const DAY = 24 * 3600 * 1000;
const NAMES = {
  checker: 'Проверяющий находки', bid: 'Агент заявок', reader: 'Читатель документов', night: 'Разведчик базы товаров',
  scout: 'Разведчик поставщиков', outcomes: 'Итоги торгов', application: 'Подготовка заявки', package: 'Итоговый пакет документов', fixer: 'Наладчик', kinds: 'Знаток товара', manager: 'Управляющий',
};
// какие ошибки агенты закрывают сами: кому поручено и что сделать. Остальное — решение или правка кода, это задача владельцу
const REMEDY = {
  other_kind: { whom: 'kinds', what: 'Выучить вид и назначение товара, снять такие заявки, пересобрать карточки' },
  price_suspicious: { whom: 'kinds', what: 'Сверить вид товара с прошлыми контрактами и обновить обычную цену вида' },
  user_changed_offer: { whom: 'kinds', what: 'Взять выбор человека в примеры вида, отвергнутый товар — в ошибки' },
  eis_docs: { whom: 'fixer', what: 'Повторить закупки после паузы ЕИС' },
  no_links: { whom: 'fixer', what: 'Повторить закупки без ссылок на документы' },
};

function createManager({ repo, journal, reader = null, application = null, packager = null, fixer = null, kinds = null, sources = null, outcomes = null, config = {}, notify = null, clock = () => new Date(), log = console }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, cause TEXT NOT NULL, whom TEXT NOT NULL, what TEXT NOT NULL, goal TEXT NOT NULL,
    base_count INTEGER NOT NULL DEFAULT 0, deadline TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', result TEXT, created_at TEXT NOT NULL, closed_at TEXT)`);
  const tz = config.DIGEST_TZ || 'Europe/Moscow';
  const hour = Number.isFinite(config.MANAGER_REPORT_HOUR) ? config.MANAGER_REPORT_HOUR : 20;
  const part = (o, t = clock()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...o }).format(t);
  const today = () => part({ year: 'numeric', month: '2-digit', day: '2-digit' });
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };
  const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };
  const since = () => new Date(clock().getTime() - DAY).toISOString();
  // ниша по-русски: короткое название направления из профиля, а не код
  const niche = (id) => { const d = (repo.getProfile?.()?.directions || []).find((x) => x.id === id); return d ? (d.short || d.title) : id; };

  /** Состояние каждого агента за последние сутки. */
  function status() {
    const from = since();
    const out = [];
    // агент заявок: последний прогон и итог суток
    const run = one('SELECT * FROM bid_agent_runs ORDER BY id DESC LIMIT 1');
    let st = {};
    try { st = JSON.parse(run?.stats_json || '{}'); } catch { st = {}; }
    const stuck = run?.status === 'running' && clock().getTime() - new Date(run.started_at).getTime() > 5 * 3600 * 1000;
    out.push({ id: 'bid', last: run?.started_at || null, state: stuck ? 'stuck' : run?.status || 'never', facts: run ? `кандидатов ${st.candidates || 0}, выгодных ${st.profitable || 0}, отсеяно ${st.rejected || 0}${st.errors ? `, сбоев ${st.errors}` : ''}${st.stopped ? `, остановлен: ${st.stopped}` : ''}` : 'ещё не работал' });
    const ch = ['checked', 'ok', 'hold', 'reject', 'missed'].reduce((o, k) => ({ ...o, [k]: journal.trend('checker', k).today }), {});
    out.push({ id: 'checker', last: null, state: 'done', facts: `проверено ${ch.checked}: верных ${ch.ok}, на проверку человеку ${ch.hold}, отклонено ${ch.reject}${ch.missed ? `, пропустил ошибок ${ch.missed}` : ''}` });
    const rd = one("SELECT COUNT(*) n, SUM(status = 'done') ok, SUM(status = 'error') err, SUM(provider = 'rules') rules FROM analyses WHERE created_at >= ?", from);
    const acc = reader?.accuracy();
    out.push({ id: 'reader', last: null, state: 'done', facts: `разборов ${rd?.n || 0}: готово ${rd?.ok || 0}, ошибок ${rd?.err || 0}, без нейросети ${rd?.rules || 0}${acc?.checked ? `; сверено с ЕИС полей ${acc.checked}, верно ${acc.today}%${acc.week != null ? ` (за неделю ${acc.week}%)` : ''}` : ''}${acc ? `; выучено опор ${acc.anchors}, в работе ${acc.active}` : ''}` });
    const nr = one('SELECT * FROM agent_runs ORDER BY id DESC LIMIT 1');
    let ns = {};
    try { ns = JSON.parse(nr?.stats_json || '{}'); } catch { ns = {}; }
    out.push({ id: 'night', last: nr?.started_at || null, state: nr?.status || 'never', facts: nr ? `карточек товаров ${ns.after ?? '—'} (новых ${ns.products_new || 0}, дополнено ${ns.products_enriched || 0}), характеристик добавлено ${ns.specs_added || 0}, цен ${ns.prices || 0}` : 'ещё не работал' });
    const sc = one("SELECT COUNT(*) n, SUM(found_at >= ?) found FROM scout_tasks WHERE last_at >= ?", from, from);
    out.push({ id: 'scout', last: null, state: 'done', facts: `закупок в работе за сутки ${sc?.n ?? 0}, нашёл поставщиков ${sc?.found || 0}${(() => { const s = sources?.status(); return s ? `; по итогам сверки: хороших сайтов ${s.good} (новых в каталоге ${s.added}), пустых ${s.weak}${s.weak_niches?.length ? `, слабые ниши: ${s.weak_niches.map(niche).join(', ')}` : ''}` : ''; })()}` });
    const ap = application?.stats();
    if (ap) out.push({ id: 'application', last: null, state: 'done', facts: `заявок разобрано ${ap.reviewed.today}, готовых ${ap.ready.today}${ap.prefilled ? `, дописано из памяти правок ${ap.prefilled}` : ''}; в памяти товаров ${ap.memory}${ap.top.length ? `; чаще всего: ${ap.top.map((t) => `${t.title}${t.scope ? ` (${t.scope})` : ''} — ${t.count}`).join('; ')}` : ''}` });
    const oc = one('SELECT COUNT(*) n FROM bid_agent_items WHERE outcome_at >= ?', from);
    const pk = packager?.stats();
    if (pk) out.push({ id: 'package', last: null, state: 'done', facts: `пакетов собрано ${pk.built.today}, готовых к выгрузке ${pk.final_ok.today}${pk.redrafted ? `, пересобрано ${pk.redrafted}` : ''}${pk.chosen ? `, документов поставлено по вашему выбору ${pk.chosen}` : ''}${pk.marks ? `, страна или знак найдены для ${pk.marks} позиций` : ''}${pk.suggest?.length ? `; подсказки страны и знака: ${pk.suggest.map((s) => `${s.kind} — ваших решений ${s.n} из ${s.need}, совпало ${s.share}%${s.ready ? ' (готово к автономной работе)' : ''}`).join('; ')}` : ''}${pk.fixed ? `, исправлено ошибок ${pk.fixed}` : ''}; в памяти выбора документов ${pk.memory}${pk.top.length ? `; чаще всего: ${pk.top.map((t) => `${t.title}${t.scope ? ` (${t.scope})` : ''} — ${t.count}`).join('; ')}` : ''}` });
    const kn = kinds?.stats();
    if (kn) out.push({ id: 'kinds', last: null, state: 'done', facts: `карточек видов ${kn.cards} (новых ${kn.today.cards_new}); примеров ${kn.right} верных и ${kn.wrong} ошибочных, новых ${kn.today.examples_new}; сам снял заявок ${kn.today.removed}, повторов ошибок ${kn.today.repeat}; вне медицины отметил бы ${kn.today.shadow}` });
    const fx = fixer?.stats?.();
    if (fx) out.push({ id: 'fixer', last: null, state: 'done', facts: `повторил сорвавшихся закупок ${fx.retried}, исправлено ${fx.fixed}; ждут повтора ${fx.waiting} из ${fx.open} с ошибкой; сообщений «нужна доработка» ${fx.escalated}` });
    const os = outcomes?.stats();
    out.push({ id: 'outcomes', last: null, state: 'done', facts: os ? `итогов за сутки ${os.today} (запросов ${os.used} из ${os.daily}); всего ${os.total} по ${os.niches} нишам${os.by.length ? `; снижение: ${os.by.map((b) => `${niche(b.direction)} ${b.pct}%`).join(', ')}` : ''}${os.forecast_err != null ? `; ошибка прогноза снижения ${os.forecast_err} п.` : ''}` : `проверено итогов торгов ${oc?.n || 0}` });
    return out.map((a) => ({ ...a, name: NAMES[a.id] }));
  }

  /**
   * Задачи вместо владельца: ошибка повторилась трижды за неделю — ставится задача с причиной, исполнителем, целью и сроком.
   * Цель одна — новых таких ошибок за срок ноль; проверка по числам из журнала, на слово не верим.
   */
  function planTasks() {
    const created = [];
    const week = new Date(clock().getTime() - 7 * DAY).toISOString();
    for (const l of journal.lessonsSince(week)) {
      if (l.count < 3 || l.source === 'human' && !REMEDY[l.code]) continue;
      const key = `${l.agent}:${l.code}:${l.scope || ''}`;
      if (one("SELECT 1 x FROM agent_tasks WHERE key = ? AND status = 'open'", key)) continue;
      const r = REMEDY[l.code] || { whom: 'owner', what: 'Нужно решение владельца или правка кода' };
      const deadline = new Date(clock().getTime() + 7 * DAY).toISOString();
      db.prepare('INSERT INTO agent_tasks (key, cause, whom, what, goal, base_count, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(key, `${l.title}${l.scope ? ` (${l.scope})` : ''}: ${l.count} раз`, r.whom, r.what, 'новых таких ошибок за неделю — 0', l.count, deadline, clock().toISOString());
      created.push(key);
    }
    return created;
  }
  function verifyTasks() {
    const out = [];
    for (const t of all("SELECT * FROM agent_tasks WHERE status = 'open' AND deadline <= ?", clock().toISOString())) {
      const [agent, code, ...scope] = t.key.split(':');
      const now = one('SELECT count FROM agents_lessons WHERE agent = ? AND code = ? AND scope = ?', agent, code, scope.join(':'))?.count ?? t.base_count;
      const extra = now - t.base_count;
      const status = extra === 0 ? 'done' : 'failed';
      db.prepare('UPDATE agent_tasks SET status = ?, result = ?, closed_at = ? WHERE id = ?').run(status, extra === 0 ? 'новых ошибок нет' : `новых ошибок: ${extra}`, clock().toISOString(), t.id);
      out.push({ ...t, status, extra });
    }
    return out;
  }
  const tasks = () => all("SELECT * FROM agent_tasks ORDER BY status = 'open' DESC, id DESC LIMIT 30").map((t) => ({ ...t, whom_name: t.whom === 'owner' ? 'Владелец' : NAMES[t.whom] || t.whom }));

  /** Расход платного поиска сегодня. */
  function spend() {
    const day = new Date(clock().getTime() + 3 * 3600000).toISOString().slice(0, 10);
    const used = (s) => (repo.apiUsage ? repo.apiUsage(s, day) : 0);
    return { yandex: used('yandex'), maker: used('yandex_maker'), limit: config.SEARCH_DAILY_MAX_API_REQUESTS || 0 };
  }

  function view() {
    return {
      agents: status(),
      spend: spend(),
      lessons: journal.lessonsSince(new Date(clock().getTime() - 7 * DAY).toISOString()).slice(0, 30).map((l) => ({ ...l, agent_name: NAMES[l.agent] || l.agent })),
      tasks: tasks(),
      trend: { profitable: journal.trend('bid', 'profitable'), checked: journal.trend('checker', 'checked'), rejected: journal.trend('checker', 'reject') },
      report_hour: hour,
      last_report: repo.getSetting('manager:last_report') || null,
    };
  }

  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function reportText() {
    const v = view();
    const icon = { done: '✅', running: '⏳', stuck: '⚠️', error: '❌', never: '▫️' };
    const fresh = journal.lessonsSince(since());
    const t = v.trend.profitable;
    const lines = ['🧭 <b>Управляющий: итог дня по агентам</b>', ''];
    for (const a of v.agents) lines.push(`${icon[a.state] || '•'} <b>${esc(a.name)}</b>: ${esc(a.facts)}`);
    lines.push('', `Выгодных сегодня ${t.today}${t.avg != null ? ` (в среднем за неделю ${t.avg})` : ''}`);
    lines.push(`Платный поиск: ${v.spend.yandex} из ${v.spend.limit} запросов${v.spend.maker ? `, по модели ${v.spend.maker}` : ''}`);
    if (fresh.length) {
      lines.push('', `<b>Чему научились за сутки (${fresh.length}):</b>`);
      for (const l of fresh.slice(0, 8)) lines.push(`• ${esc(NAMES[l.agent] || l.agent)}: ${esc(l.title)}${l.scope ? ` (${esc(l.scope)})` : ''} — всего ${l.count} раз`);
    }
    const open = v.tasks.filter((t) => t.status === 'open');
    if (open.length) {
      lines.push('', `<b>Задачи агентам (${open.length}):</b>`);
      for (const t of open.slice(0, 6)) lines.push(`• ${esc(t.whom_name)}: ${esc(t.cause)} → ${esc(t.what)}`);
    }
    const bad = v.agents.filter((a) => ['stuck', 'error'].includes(a.state));
    if (bad.length) lines.push('', `⚠️ Требуют внимания: ${bad.map((a) => esc(a.name)).join(', ')}`);
    return lines.join('\n');
  }

  async function sendReport() {
    if (!notify) return false;
    try { verifyTasks(); planTasks(); } catch (err) { log.warn?.(`[manager] задачи: ${err.message}`); }
    const ok = await notify(reportText()).catch((err) => { log.warn?.(`[manager] Telegram: ${err.message}`); return false; });
    journal.metric('manager', 'reports', 1);
    return ok;
  }

  /** Раз в минуту из рабочего процесса: пора ли дневного отчёта. */
  /**
   * Задачи наблюдения: подсказки страны и знака (спорные источники) стали надёжны — один раз сообщить, что агента
   * итогового пакета можно перевести в автономный режим для этого источника.
   */
  async function watch() {
    for (const s of packager?.stats().suggest || []) {
      const key = `manager:announced:marks:${s.kind}`;
      if (!s.ready || repo.getSetting(key)) continue;
      const text = `🤖 <b>Можно включать автономно</b>
Агент «Итоговый пакет документов»: подсказки страны и знака из источника «${esc(s.kind)}» совпали с вашими решениями в ${s.agree} из ${s.n} случаев (${s.share}%). Можно разрешить ему вписывать такие значения без вас — скажите об этом в чате с Claude.`;
      const ok = notify ? await notify(text).catch(() => false) : false;
      journal.lesson('manager', 'ready_auto_marks', 'Источник страны и знака готов к автономной работе', { scope: s.kind, text: `совпало ${s.agree} из ${s.n}`, source: 'self' });
      if (ok || !notify) repo.setSetting(key, new Date(clock()).toISOString());
    }
  }

  async function tick() {
    try { await watch(); } catch (err) { log.warn?.(`[manager] наблюдение: ${err.message}`); }
    const h = Number(part({ hour: '2-digit', hourCycle: 'h23' }));
    if (h < hour || repo.getSetting('manager:last_report') === today()) return false;
    // Telegram с сервера бывает недоступен (30.10 отчёт потерялся): день отмечается только после успешной отправки,
    // повтор — не чаще раза в 10 минут
    const last = Number(repo.getSetting('manager:last_try') || 0);
    if (clock() - last < 10 * 60_000) return false;
    repo.setSetting('manager:last_try', String(clock()));
    const ok = await sendReport();
    if (ok || !notify) repo.setSetting('manager:last_report', today());
    return ok;
  }

  return { status, view, reportText, sendReport, tick, watch, planTasks, verifyTasks, tasks, NAMES };
}

module.exports = { createManager, NAMES };
