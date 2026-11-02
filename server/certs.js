// Дополнительные доверенные корневые сертификаты (НУЦ Минцифры) для zakupki.gov.ru и GigaChat.
// Все *.pem / *.crt из папки добавляются к стандартному хранилищу Node.js при старте —
// NODE_EXTRA_CA_CERTS задавать не нужно. Проверка сертификатов при этом не отключается.

const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');

let loaded = null;

/** @returns {string[]} имена (CN) добавленных сертификатов */
function loadExtraCaCertificates(dir, log = console) {
  if (loaded) return loaded;
  loaded = [];
  if (!dir || !fs.existsSync(dir)) return loaded;
  if (typeof tls.setDefaultCACertificates !== 'function') {
    log.warn?.('[certs] эта версия Node.js не умеет добавлять сертификаты из кода — задайте NODE_EXTRA_CA_CERTS, см. README');
    return loaded;
  }
  const pems = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.(pem|crt)$/i.test(f)).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      const cert = new X509Certificate(text);
      if (!cert.ca) throw new Error('не является сертификатом УЦ');
      pems.push(text);
      loaded.push(/CN=([^\n,]+)/.exec(cert.subject)?.[1] || file);
    } catch (err) {
      log.warn?.(`[certs] ${file} пропущен: ${err.message}`);
    }
  }
  if (pems.length) {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...pems]);
    log.log?.(`[certs] добавлены доверенные сертификаты: ${loaded.join(', ')}`);
  }
  return loaded;
}

module.exports = { loadExtraCaCertificates };
