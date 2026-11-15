'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApiHandler } = require('./server/handler.cjs');
// Deliberately serves only the built public allowlist, never the workspace root.
const root = path.resolve(__dirname, '../.cloud-dist');
const port = Number(process.env.CLOUD_PORT || 8766);
const api = createApiHandler();
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await api(req,res);
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch { res.writeHead(400); res.end('Invalid request'); }
}).listen(port,'127.0.0.1',()=>console.log(`Cloud app preview: http://127.0.0.1:${port}/`));
