// Раздаёт демо-версию (demo/standalone/index.html) — для показа по ссылке через Cloudflare Tunnel.
// Сервер только читает один файл: API, база и документы здесь не доступны.
// Запуск: node demo/serve-demo.js  (порт DEMO_PORT, по умолчанию 8860)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'standalone', 'index.html');
const PORT = Number(process.env.DEMO_PORT) || 8860;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  // подложки дизайна «Медь» и картинки товаров: только .webp из public/assets и public/assets/tender-products/320|768
  const asset = /^\/assets\/((?:tender-products\/(?:320|768)\/)?[\w.-]+\.webp)$/.exec(url.pathname);
  if (asset && fs.existsSync(path.join(__dirname, '..', 'public', 'assets', asset[1]))) {
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', asset[1])));
    return;
  }
  if (url.pathname !== '/' && url.pathname !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(FILE));
}).listen(PORT, '127.0.0.1', () => console.log(`demo: http://localhost:${PORT}`));
