const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = __dirname;
const types = { '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.cjs': 'text/plain; charset=utf-8' };

http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(root + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const real = await fs.realpath(target);
    if (!real.startsWith(root + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const content = await fs.readFile(real);
    res.writeHead(200, {
      'Content-Type': types[path.extname(real)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    const status = error instanceof URIError ? 400 : 404;
    res.writeHead(status).end(status === 400 ? 'Bad request' : 'Not found');
  }
}).listen(43128, '127.0.0.1', () => {
  console.log('Release checklist: http://127.0.0.1:43128/');
});
