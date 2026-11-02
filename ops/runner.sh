#!/usr/bin/env bash
# Отчёты с рабочего сервера на GitHub — чтобы Claude видел свежие данные без терминала.
# Запускается cron'ом каждые 10 минут. Отчёт строится, когда изменился ops/request.txt в ветке main
# (Claude меняет его, когда нужны свежие данные), и раз в сутки сам по себе.
# Рабочая база только читается. Код рабочего сервиса (/opt/tender-ai) и ключи не трогаются.
set -uo pipefail
REPO="${REPO:-$HOME/tender-ops}"          # отдельный клон репозитория только для отчётов
DB="${DB:-/var/lib/tender-ai/app.db}"     # рабочая база
LOCK=/tmp/tender-ops.lock
exec 9>"$LOCK"; flock -n 9 || exit 0

cd "$REPO" || exit 1
git fetch -q origin main || exit 1
git checkout -q -B main origin/main

req="$(sha1sum ops/request.txt 2>/dev/null | cut -c1-12)"
day="$(date +%F)"
stamp="$REPO/../.tender-ops-last"
last="$(cat "$stamp" 2>/dev/null)"
[ "$last" = "$req-$day" ] && exit 0

out="$(mktemp -d)"
{
  echo "Отчёт: $(date '+%F %T %Z'), база: $DB"
  echo "Запрос: $(cat ops/request.txt 2>/dev/null)"
  echo "Код рабочего сервиса: $(stat -c %y /opt/tender-ai/server/server.js 2>/dev/null | cut -c1-16)"
} > "$out/README.txt"
node --no-warnings scripts/agents-report.js "$DB" --days "${DAYS:-14}" > "$out/agents.txt" 2>&1
node --no-warnings scripts/pipeline-report.js "$DB" > "$out/pipeline.txt" 2>&1
journalctl -u tender-ai --since "-24h" -p warning --no-pager 2>/dev/null | tail -n 80 > "$out/errors-24h.txt"
if [ -f ops/extra.sql ]; then
  node --no-warnings -e "
    const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});
    for (const q of require('fs').readFileSync('ops/extra.sql','utf8').split(';').map(s=>s.trim()).filter(Boolean)) {
      if (!/^select|^with/i.test(q)) { console.log('пропущено (только SELECT):', q.slice(0,60)); continue; }
      try { console.log('## '+q.slice(0,120)); console.table(db.prepare(q).all().slice(0,200)); } catch (e) { console.log('ошибка:', e.message); }
    }" "$DB" > "$out/extra.txt" 2>&1
fi

git checkout -q -B ops-reports
git rm -rq --cached . >/dev/null 2>&1; find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
mkdir -p reports && cp "$out"/* reports/ && rm -rf "$out"
git add reports
git -c user.name="tender-server" -c user.email="server@tender-ai" commit -qm "Отчёт $(date '+%F %H:%M')" || true
git push -qf origin ops-reports && echo "$req-$day" > "$stamp"
git checkout -qf main
