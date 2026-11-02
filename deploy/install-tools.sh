#!/usr/bin/env bash
# Программы, которыми сервис читает «трудные» файлы документации. Ставятся один раз на сервере (Ubuntu / Debian):
#   tesseract-ocr + русский язык — распознавание текста на сканах PDF и картинках;
#   poppler-utils (pdftoppm)     — превращает страницу PDF в картинку для распознавания;
#   libarchive-tools (bsdtar)    — распаковка RAR и 7z.
# Без них сервис работает, но сканы и архивы RAR/7z остаются непрочитанными.
# Запуск из Git Bash:  bash deploy/install-tools.sh     (SSH_OPTS — как в deploy-app.sh)
set -euo pipefail
ssh ${SSH_OPTS:-} -i ~/.ssh/tsj_deploy root@213.171.12.208 'set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends tesseract-ocr tesseract-ocr-rus poppler-utils libarchive-tools
  tesseract --version | head -1
  tesseract --list-langs | tr "\n" " "; echo
  pdftoppm -v 2>&1 | head -1
  bsdtar --version'
