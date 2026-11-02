#!/usr/bin/env bash
# Пересобрать демо-версию и выложить на сервер: https://tender.213-171-12-208.sslip.io
# Запуск из Git Bash:  bash demo/deploy-demo.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/c/devtools/node:$PATH"
node demo/build-demo.js
ssh ${SSH_OPTS:-} -i ~/.ssh/tsj_deploy root@213.171.12.208 'mkdir -p /var/www/tender/assets/tender-products'
scp ${SSH_OPTS:-} -i ~/.ssh/tsj_deploy -q public/assets/*.webp root@213.171.12.208:/var/www/tender/assets/
# картинки товаров: 72 категории × 320 и 768 px (~4 МБ)
scp ${SSH_OPTS:-} -i ~/.ssh/tsj_deploy -q -r public/assets/tender-products/320 public/assets/tender-products/768 root@213.171.12.208:/var/www/tender/assets/tender-products/
scp ${SSH_OPTS:-} -i ~/.ssh/tsj_deploy -q demo/standalone/index.html demo/standalone/keys.html root@213.171.12.208:/var/www/tender/
echo "Готово: https://tender.213-171-12-208.sslip.io"
