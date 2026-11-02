const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { downloadAttachments, eisGate } = require('../server/tenders/attachments');

test('файлы ЕИС — не чаще раза в минуту, после 434 — пауза', async () => {
  eisGate.next = 0; eisGate.blockedUntil = 0;
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let calls = 0;
  const fetchImpl = async () => { calls++; return calls === 2 ? { ok: false, status: 434, headers: new Map() } : { ok: true, status: 200, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => new ArrayBuffer(4) }; };
  const dir = path.join(os.tmpdir(), 'eis-gate-' + process.pid);
  const files = [1, 2, 3].map((n) => ({ fileName: `f${n}.pdf`, url: `https://zakupki.gov.ru/f${n}` }));
  const r = await downloadAttachments(files, dir, { fetchImpl, sleep });
  assert.equal(r.downloaded.length, 1);
  assert.equal(calls, 2, 'после 434 третий файл не запрашивается');
  assert.ok(waits[0] > 50_000, 'второй запрос ждёт около минуты');
  assert.match(r.failed[1].message, /пауза/);
  eisGate.next = 0; eisGate.blockedUntil = 0;
});
