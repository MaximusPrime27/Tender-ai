const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');

const CERTS = path.join(__dirname, '..', 'certs');

test('сертификаты НУЦ Минцифры в certs/ — корневой и выпускающий, подписаны корневым', () => {
  const root = new X509Certificate(fs.readFileSync(path.join(CERTS, 'russian_trusted_root_ca.pem')));
  const sub = new X509Certificate(fs.readFileSync(path.join(CERTS, 'russian_trusted_sub_ca.pem')));
  assert.match(root.subject, /CN=Russian Trusted Root CA/);
  assert.equal(root.ca, true);
  assert.ok(sub.checkIssued(root));
  assert.ok(sub.verify(root.publicKey));
  assert.ok(new Date(sub.validTo) > new Date(), 'выпускающий сертификат не истёк');
});

test('сертификаты добавляются к стандартному хранилищу, а не заменяют его', () => {
  // отдельный процесс: хранилище CA глобальное
  const { execFileSync } = require('node:child_process');
  // Хранилище по умолчанию содержит дубликаты — сравниваем множества отпечатков, а не количество.
  const out = execFileSync(process.execPath, ['-e', `
    const tls = require('node:tls');
    const { X509Certificate } = require('node:crypto');
    const fps = () => new Set(tls.getCACertificates('default').map((p) => new X509Certificate(p).fingerprint256));
    const before = fps();
    const names = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'certs.js'))}).loadExtraCaCertificates(${JSON.stringify(CERTS)}, {});
    const after = fps();
    console.log(JSON.stringify({ lost: [...before].filter((f) => !after.has(f)).length, added: [...after].filter((f) => !before.has(f)), names }));
  `], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.lost, 0, 'стандартные сертификаты не пропадают');
  assert.equal(r.added.length, 2);
  assert.ok(r.added.includes('D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31'), 'отпечаток Russian Trusted Root CA');
  assert.deepEqual(r.names, ['Russian Trusted Root CA', 'Russian Trusted Sub CA']);
  assert.ok(typeof tls.setDefaultCACertificates === 'function');
});
