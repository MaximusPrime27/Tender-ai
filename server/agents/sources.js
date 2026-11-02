// Разведчик поставщиков (этап 4 пакета агентов). Раз в сутки учится по итогам сверки найденных товаров за 60 дней:
//   • какие сайты по каждой нише дают подходящий товар (src_stats) — хорошие уходят в свой каталог
//     (offers:discovered_suppliers): их карта сайта читается каждые сутки, и дальше товар находится бесплатно;
//   • сайты, где за 8+ товаров не подошёл ни один, — «пустые» (scout:weak_domains): из своего каталога они
//     убираются, урок записывается;
//   • слабые ниши — где у открытых закупок чаще всего нет подходящего товара — передаются агенту поиска поставщиков
//     (scout:auto_niches): он тратит свой суточный лимит туда, где товара не хватает, а не только на мебель.

const DAY = 24 * 3600 * 1000;
const GOOD = ['соответствует', 'частично'];
const MARKET = /ozon|wildberries|market\.yandex|avito|aliexpress|megamarket|zakupki\.gov|sbermegamarket|lamoda/;

function createSourcesAgent({ repo, journal, config = {}, clock = () => new Date(), log = console }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS src_stats (
    direction TEXT NOT NULL, domain TEXT NOT NULL, total INTEGER, fit INTEGER, partial INTEGER, nofit INTEGER, updated_at TEXT,
    PRIMARY KEY (direction, domain))`);
  const now = () => clock().toISOString();
  const today = () => new Date(clock().getTime() + 3 * 3600000).toISOString().slice(0, 10);
  const getJson = (k, d) => { try { return JSON.parse(repo.getSetting(k) || ''); } catch { return d; } };

  function run() {
    const since = new Date(clock().getTime() - 60 * DAY).toISOString();
    const rows = db.prepare(`SELECT COALESCE(t.direction, '') direction, replace(o.domain, 'www.', '') domain, COUNT(*) total,
        SUM(o.match = 'соответствует') fit, SUM(o.match = 'частично') partial, SUM(o.match = 'не соответствует') nofit
      FROM offers o JOIN tenders t ON t.id = o.tender_id
      WHERE o.domain IS NOT NULL AND o.source NOT IN ('contracts', 'manual') AND o.created_at >= ? GROUP BY 1, 2`).all(since);
    db.exec('DELETE FROM src_stats');
    const ins = db.prepare('INSERT INTO src_stats (direction, domain, total, fit, partial, nofit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.direction, r.domain, r.total, r.fit || 0, r.partial || 0, r.nofit || 0, now());

    // по сайту в целом (все ниши)
    const site = db.prepare('SELECT domain, SUM(total) total, SUM(fit) fit, SUM(partial) partial FROM src_stats GROUP BY domain').all();
    const retail = (() => { try { return (JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'config', 'stores.json'), 'utf8')).retail || []).filter((s) => !s.open).map((s) => s.site); } catch { return []; } })();
    const isRetail = (d) => retail.some((s) => d === s || d.endsWith(`.${s}`));
    const good = site.filter((s) => s.fit >= 2 && s.fit / s.total >= 0.3 && !MARKET.test(s.domain) && !isRetail(s.domain));
    const weak = site.filter((s) => s.total >= 8 && !s.fit && !s.partial);

    // хорошие — в свой каталог
    const list = getJson('offers:discovered_suppliers', []);
    let added = 0;
    for (const g of good) {
      if (list.some((x) => x.site === g.domain)) continue;
      list.push({ site: g.domain, added_at: now(), by: 'sources_agent' });
      added++;
      journal.lesson('scout', 'good_site', 'Сайт с подходящим товаром — в свой каталог', { scope: g.domain, text: `подошло ${g.fit} из ${g.total}`, source: 'self' });
    }
    // пустые — из каталога вон
    const weakSet = new Set(weak.map((w) => w.domain));
    const kept = list.filter((x) => !weakSet.has(x.site));
    const removed = list.length - kept.length;
    repo.setSetting('offers:discovered_suppliers', JSON.stringify(kept.slice(-400)));
    const prevWeak = new Set(getJson('scout:weak_domains', []));
    for (const w of weak) if (!prevWeak.has(w.domain)) journal.lesson('scout', 'empty_site', 'Сайт без подходящего товара', { scope: w.domain, text: `не подошло ни одного из ${w.total}`, source: 'self' });
    repo.setSetting('scout:weak_domains', JSON.stringify([...weakSet]));

    // слабые ниши: открытые закупки, у которых агент заявок не нашёл товар
    let niches = [];
    try { niches = db.prepare(`SELECT t.direction d, COUNT(*) n, SUM(i.reason LIKE 'нет подходящего товара%') miss
      FROM bid_agent_items i JOIN tenders t ON t.id = i.tender_id
      WHERE i.created_at >= ? AND t.direction IS NOT NULL GROUP BY 1 HAVING n >= 3 ORDER BY miss * 1.0 / n DESC`).all(new Date(clock().getTime() - 14 * DAY).toISOString()); } catch { niches = []; } // агент заявок выключен — таблицы нет
    // слабая — товара нет хотя бы в 5 закупках и в каждой пятой; первыми — где таких закупок больше
    const weakNiches = niches.filter((x) => x.miss >= 5 && x.miss / x.n >= 0.2).sort((p, q) => q.miss - p.miss).slice(0, 3);
    repo.setSetting('scout:auto_niches', JSON.stringify(weakNiches.map((x) => x.d)));
    for (const x of weakNiches) journal.lesson('scout', 'weak_niche', 'Слабая ниша — не хватает товара', { scope: x.d, text: `нет товара в ${x.miss} из ${x.n} закупок за 2 недели`, source: 'self' });

    const st = { sites: site.length, good: good.length, added, weak: weak.length, removed, weak_niches: weakNiches.map((x) => x.d) };
    journal.metric('scout', 'catalog_added', added);
    journal.metric('scout', 'good_sites', good.length, { set: true });
    journal.metric('scout', 'weak_sites', weak.length, { set: true });
    repo.setSetting('sources_agent:last', JSON.stringify({ at: now(), day: today(), ...st }));
    return st;
  }

  /** Раз в сутки (после 3:00 по Москве) из рабочего процесса. */
  function tick() {
    const last = getJson('sources_agent:last', {});
    const h = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23' }).format(clock()));
    if (last.day === today() || h < 3) return null;
    try { return run(); } catch (err) { log.warn?.(`[разведчик поставщиков] ${err.message}`); return null; }
  }

  const status = () => getJson('sources_agent:last', null);
  return { run, tick, status };
}

module.exports = { createSourcesAgent };
