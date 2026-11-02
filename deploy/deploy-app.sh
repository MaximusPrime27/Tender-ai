#!/usr/bin/env bash
# Обновить рабочую версию на сервере: https://tender-app.213-171-12-208.sslip.io (вход по паролю).
# Меняется только код: база (/var/lib/tender-ai) и ключи (/opt/tender-ai/.env) на сервере остаются как есть.
# SSH_OPTS — дополнительные параметры ssh/scp, например в обход VPN: SSH_OPTS="-o BindAddress=10.203.7.60" bash deploy/deploy-app.sh
# Запуск из Git Bash:  bash deploy/deploy-app.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/c/devtools/node:$PATH"
npm test
mkdir -p ../_deploy
tar --exclude=./.git --exclude=./node_modules --exclude=./data --exclude=./.env --exclude=./demo/tender-ai-demo.html --exclude=./_preview -czf ../_deploy/tender-code.tgz .
scp ${SSH_OPTS:-} -i ~/.ssh/tsj_deploy -q ../_deploy/tender-code.tgz root@213.171.12.208:/tmp/tender-code.tgz
ssh ${SSH_OPTS:-} -i ~/.ssh/tsj_deploy root@213.171.12.208 'set -e
  cd /opt/tender-ai
  cp .env /tmp/tender.env.keep
  tar -xzf /tmp/tender-code.tgz -C /opt/tender-ai
  install -m 600 /tmp/tender.env.keep /opt/tender-ai/.env
  npm ci --omit=dev --no-audit --no-fund >/dev/null
  chown -R tender:tender /opt/tender-ai
  rm -f /tmp/tender-code.tgz /tmp/tender.env.keep
  systemctl restart tender-ai
  sleep 3
  systemctl is-active tender-ai
  curl -s http://127.0.0.1:8870/api/health'
rm -f ../_deploy/tender-code.tgz
echo
echo "Готово: https://tender-app.213-171-12-208.sslip.io"
