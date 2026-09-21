import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

export async function startEmotionUiFixture() {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>Windows emotion test</title><link rel="stylesheet" href="/style.css"><main class="main"><h1>Windows 情绪页面 · 合成测试</h1><output id="result">运行中</output><div id="fixture"></div></main><script type="module" src="/scenario.mjs"></script>'); return;
    }
    const file = path === '/scenario.mjs' ? new URL('./emotion-ui-scenario.mjs', import.meta.url)
      : ['/emotion-view.mjs', '/dom.mjs', '/api.mjs', '/style.css'].includes(path) ? new URL('../../management/ui' + path, import.meta.url) : null;
    if (!file || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
    try { res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port + '/', close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
