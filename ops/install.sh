#!/usr/bin/env bash
# Однократная установка отчётов с сервера:  bash ~/e2e-app/ops/install.sh
set -euo pipefail
DIR="$HOME/tender-ops"
[ -d "$DIR/.git" ] || git clone -q git@github.com:MaximusPrime27/Tender-ai.git "$DIR"
[ -f /var/lib/tender-ai/app.db ] || echo "ВНИМАНИЕ: нет /var/lib/tender-ai/app.db — пришлите Claude вывод: find / -name app.db 2>/dev/null"
LINE="*/10 * * * * bash $DIR/ops/runner.sh >> /var/log/tender-ops.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'tender-ops/ops/runner.sh'; echo "$LINE" ) | crontab -
bash "$DIR/ops/runner.sh" && echo "Готово: первый отчёт отправлен в ветку ops-reports на GitHub."
