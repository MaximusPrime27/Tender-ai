// Скрипты интерфейса не проходят через require — проверяем их синтаксис отдельно,
// иначе ошибка в help.js молча ломает все страницы.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pub = path.join(__dirname, '..', 'public');

test('public/*.js и встроенные <script> в index.html без синтаксических ошибок', () => {
  for (const f of fs.readdirSync(pub).filter((n) => n.endsWith('.js'))) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(pub, f), 'utf8'), { filename: f }), f);
  }
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  for (const [, code] of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    assert.doesNotThrow(() => new vm.Script(code, { filename: 'index.html' }), 'index.html');
  }
});
