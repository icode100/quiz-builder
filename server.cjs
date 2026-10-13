const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PORT = 8765;
const MARKER = 'gate-cse-quiz-server-v1';
const MAX_BODY = 2 * 1024 * 1024;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const escapeHtml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function createServer({ root = __dirname, port = PORT } = {}) {
  root = fs.realpathSync.native(root);
  const reply = (res, status, text, type = 'text/plain; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' }); res.end(text); };
  async function quizFolder(name) {
    if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\')) throw Object.assign(new Error('Invalid quiz folder.'), { status: 404 });
    const directory = path.join(root, name);
    if ((await fsp.lstat(directory)).isSymbolicLink()) throw Object.assign(new Error('Invalid quiz folder.'), { status: 403 });
    const real = await fsp.realpath(directory);
    if (!inside(root, real)) throw Object.assign(new Error('Invalid quiz folder.'), { status: 403 });
    for (const filename of ['index.html', 'quiz-data.js']) {
      const file = await fsp.realpath(path.join(real, filename));
      if (!inside(real, file) || !(await fsp.stat(file)).isFile()) throw Object.assign(new Error('Not a quiz folder.'), { status: 404 });
    }
    return real;
  }
  async function landing() {
    const links = [];
    for (const item of await fsp.readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith('_') || item.name.startsWith('.')) continue;
      try { const folder = await quizFolder(item.name); const html = await fsp.readFile(path.join(folder, 'index.html'), 'utf8'); const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] || item.name; links.push(`<li><a href="/${encodeURIComponent(item.name)}/">${escapeHtml(title)}</a></li>`); } catch { /* Ignore folders that are not quizzes. */ }
    }
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GATE CSE quizzes</title><style>body{font:18px system-ui;max-width:700px;margin:60px auto;padding:0 20px;line-height:1.7}li{margin:12px 0}</style><h1>GATE CSE quizzes</h1><p>Unfinished answers stay in this browser. Submit saves the latest report in the quiz folder.</p><ul>${links.join('')}</ul></html>`;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.host !== origin.slice(7)) return reply(res, 403, 'Use the local quiz address.');
      const pathname = decodeURIComponent(req.url.split('?')[0]);
      if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part === '.')) return reply(res, 400, 'Invalid path.');
      if (req.method === 'GET' && pathname === '/health') return reply(res, 200, JSON.stringify({ server: MARKER }), mime['.json']);
      if (req.method === 'GET' && pathname === '/') return reply(res, 200, await landing(), mime['.html']);
      const [name, ...parts] = pathname.slice(1).split('/');
      const folder = await quizFolder(name);
      const relative = parts.join('/') || 'index.html';
      if (req.method === 'POST') {
        if (name === '_template' || relative !== 'attempt.json') return reply(res, 405, 'Only submitted attempts can be saved.');
        if ((req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin' && req.headers['sec-fetch-site'] !== 'none')) return reply(res, 403, 'Use the local quiz page to submit.');
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(res, 415, 'Send application/json.');
        if (Number(req.headers['content-length']) > MAX_BODY) return reply(res, 413, 'Attempt is too large.');
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return reply(res, 413, 'Attempt is too large.'); chunks.push(chunk); }
        let attempt;
        try { attempt = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, 'Invalid JSON.'); }
        if (!object(attempt) || attempt.version !== 1 || typeof attempt.quizId !== 'string' || !attempt.quizId.trim() || attempt.quizId.length > 200 || !object(attempt.answers) || !object(attempt.summary) || !Array.isArray(attempt.results) || typeof attempt.submittedAt !== 'string' || !Number.isFinite(Date.parse(attempt.submittedAt)) || typeof attempt.updatedAt !== 'string' || !Number.isFinite(Date.parse(attempt.updatedAt))) return reply(res, 400, 'A completed quiz attempt is required.');
        const target = path.join(folder, 'attempt.json');
        try { if ((await fsp.lstat(target)).isSymbolicLink()) return reply(res, 403, 'Attempt file must be a regular file.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const temporary = path.join(folder, `.attempt-${randomUUID()}.tmp`);
        try { await fsp.writeFile(temporary, JSON.stringify(attempt, null, 2) + '\n', { flag: 'wx' }); await fsp.rename(temporary, target); }
        finally { await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        return reply(res, 200, JSON.stringify({ saved: true }), mime['.json']);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Method not allowed.');
      const file = await fsp.realpath(path.resolve(folder, relative));
      if (!inside(folder, file) || !inside(root, file)) return reply(res, 403, 'Invalid file path.');
      const stat = await fsp.stat(file);
      if (!stat.isFile()) return reply(res, 404, 'File not found.');
      res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res);
    } catch (error) { reply(res, error.status || (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : error instanceof URIError ? 400 : 500), error.status || error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'File not found.' : 'Unable to complete this request.'); }
  });
  server.quizPort = port;
  return server;
}

if (require.main === module) {
  const index = process.argv.indexOf('--port');
  const port = index >= 0 ? Number(process.argv[index + 1]) : PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  const server = createServer({ port });
  server.on('error', error => { console.error(`Quiz server: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Quiz server: http://127.0.0.1:${port}/`));
}
module.exports = { createServer, MARKER, MAX_BODY };
