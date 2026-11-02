// Скачивание вложений закупки с zakupki.gov.ru.
// Сайт ЕИС использует сертификат НУЦ Минцифры — без NODE_EXTRA_CA_CERTS Node.js не доверяет соединению.

const fs = require('node:fs');
const path = require('node:path');

const TLS_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED',
]);

function explainFetchError(err) {
  const code = err.cause?.code || err.code;
  if (TLS_CODES.has(code)) {
    return `нет доверия к сертификату сайта ЕИС (${code}) — положите сертификаты НУЦ Минцифры в папку certs (или задайте NODE_EXTRA_CA_CERTS) и перезапустите сервер, см. README`;
  }
  if (err.name === 'TimeoutError') return 'превышено время ожидания ответа ЕИС';
  return `ошибка соединения с ЕИС: ${code || err.message}`;
}

const safeName = (name) => String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180);

/**
 * @param attachments [{fileName, url}]
 * @returns {Promise<{downloaded: [{originalname, path}], failed: [{name, message}]}>}
 */
// ЕИС — не чаще одного запроса в минуту (правило владельца; 30.10 файлы качались подряд, 5–8 за секунды, и портал
// ответил 434 на выгрузку файлов). Очередь общая для всех закупок процесса. После 434/429 — пауза EIS_BLOCK_PAUSE_MIN.
const EIS_HOST = /(^|\.)zakupki\.gov\.ru$/i;
const eisGate = { next: 0, blockedUntil: 0 };
const EIS_INTERVAL_MS = Number(process.env.EIS_FILE_INTERVAL_MS ?? 60_000);
const EIS_BLOCK_PAUSE_MS = Number(process.env.EIS_BLOCK_PAUSE_MIN ?? 120) * 60_000;
const isEis = (url) => { try { return EIS_HOST.test(new URL(url).hostname); } catch { return false; } };
async function eisTurn(sleep) {
  if (Date.now() < eisGate.blockedUntil) throw new Error(`ЕИС ответил 434 — пауза до ${new Date(eisGate.blockedUntil).toISOString().slice(11, 16)} UTC, файлы не запрашиваем`);
  const wait = eisGate.next - Date.now();
  eisGate.next = Math.max(Date.now(), eisGate.next) + EIS_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}

async function downloadAttachments(attachments, dir, { maxBytes = 100 * 1024 * 1024, fetchImpl = fetch, onProgress = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const downloaded = [];
  const failed = [];
  const used = new Set();

  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    onProgress(i + 1, attachments.length);
    try {
      let res;
      if (isEis(a.url)) await eisTurn(sleep);
      try {
        res = await fetchImpl(a.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (tender-ai)', Accept: '*/*' },
          signal: AbortSignal.timeout(90_000),
          redirect: 'follow',
        });
      } catch (err) {
        throw new Error(explainFetchError(err));
      }
      if (!res.ok) {
        // ЕИС закрыл выгрузку — пауза для всех закупок, остальные файлы этой не запрашиваем
        if ((res.status === 434 || res.status === 429) && isEis(a.url)) eisGate.blockedUntil = Date.now() + EIS_BLOCK_PAUSE_MS;
        throw new Error(`ЕИС ответил ${res.status}`);
      }
      const type = res.headers.get('content-type') || '';
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > maxBytes) throw new Error(`файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`);
      // Вместо файла ЕИС иногда отдаёт HTML-страницу (ошибка, проверка браузера).
      if (/text\/html/i.test(type) && !/\.html?$/i.test(a.fileName)) {
        throw new Error('ЕИС вернул веб-страницу вместо файла');
      }
      let name = safeName(a.fileName);
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${n}-${safeName(a.fileName)}`;
      used.add(name.toLowerCase());
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, buffer);
      downloaded.push({ originalname: a.fileName, path: filePath });
    } catch (err) {
      failed.push({ name: a.fileName, message: `Не скачан: ${err.message}` });
    }
  }
  return { downloaded, failed };
}

module.exports = { downloadAttachments, explainFetchError, eisGate };
