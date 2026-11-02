// Читатель документов — обучение (этап 2 пакета агентов). Разбор правилами сверяется с извещением ЕИС
// (analyze/learn.js), здесь итог сверки копится:
//   • показатели по дням: сколько полей прочитано верно, не то, не найдено — точность читателя и её динамика;
//   • уроки по площадке: «на ЭТП ГПБ не находит обеспечение контракта» — видно, где правила слабее;
//   • опоры (reader_anchors): слова перед верным значением; опора работает в разборах, пока подтверждается чаще, чем
//     ошибается, и выбывает, когда ошибается на 2 раза больше, чем верна.

const FIELD = { nmck: 'НМЦК', bid_security: 'обеспечение заявки', contract_security: 'обеспечение контракта', delivery_place: 'место поставки', bid_deadline: 'срок подачи заявок' };

function createReaderLearner({ repo, journal, clock = () => new Date() }) {
  const db = repo.db;
  db.exec(`CREATE TABLE IF NOT EXISTS reader_anchors (
    key TEXT NOT NULL, anchor TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 1, scope TEXT, created_at TEXT NOT NULL, last_at TEXT, PRIMARY KEY (key, anchor))`);
  const now = () => clock().toISOString();

  /** Опоры в работе: подтверждённые или новые, найденные хотя бы в 2 закупках; лучшие первыми. */
  function active() {
    return db.prepare('SELECT key, anchor FROM reader_anchors WHERE fails < hits + 2 AND (hits > 0 OR seen >= 2) ORDER BY hits - fails DESC, seen DESC LIMIT 200').all();
  }

  /** Итог сверки одного разбора (card.meta.reader_check). */
  function record(check, { platform = '', tenderId = null } = {}) {
    if (!check) return null;
    const tally = { agree: 0, mismatch: 0, missed: 0, absent: 0 };
    for (const g of check.grades || []) {
      tally[g.result]++;
      journal.metric('reader', g.result, 1);
      if (g.learned) {
        db.prepare(`UPDATE reader_anchors SET ${g.result === 'agree' ? 'hits = hits + 1' : 'fails = fails + 1'}, last_at = ? WHERE key = ? AND anchor = ?`).run(now(), g.key, g.learned);
        journal.metric('reader', g.result === 'agree' ? 'anchor_hit' : 'anchor_fail', 1);
      }
      if (g.result === 'mismatch' || g.result === 'missed') {
        journal.lesson('reader', `${g.result}_${g.key}`, `${g.result === 'missed' ? 'Не нашёл' : 'Прочитал не то'}: ${FIELD[g.key] || g.key}`,
          { scope: platform || '', tenderId, text: `${g.rules ? `прочитано «${g.rules.slice(0, 120)}», ` : ''}в ЕИС «${String(g.eis).slice(0, 120)}»`, source: 'self' });
      }
    }
    for (const c of check.candidates || []) {
      db.prepare(`INSERT INTO reader_anchors (key, anchor, scope, created_at, last_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key, anchor) DO UPDATE SET seen = seen + 1, last_at = excluded.last_at`).run(c.key, c.anchor, platform || '', now(), now());
    }
    if (check.candidates?.length) journal.metric('reader', 'anchors_learned', check.candidates.length);
    for (const u of check.used || []) journal.metric('reader', 'anchor_used', 1);
    return tally;
  }

  /** Точность за сегодня и за неделю — для управляющего. */
  function accuracy() {
    const t = (k) => journal.trend('reader', k);
    const a = t('agree'); const m = t('mismatch'); const s = t('missed');
    const pct = (x, y, z) => (x + y + z ? Math.round((x * 100) / (x + y + z)) : null);
    const anchors = db.prepare('SELECT COUNT(*) n, SUM(fails < hits + 2 AND (hits > 0 OR seen >= 2)) act FROM reader_anchors').get();
    return { today: pct(a.today, m.today, s.today), checked: a.today + m.today + s.today, week: a.avg != null ? pct(a.avg, m.avg || 0, s.avg || 0) : null, anchors: anchors.n || 0, active: anchors.act || 0 };
  }

  return { active, record, accuracy };
}

module.exports = { createReaderLearner, FIELD };
