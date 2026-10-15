const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const PORT = 8765;
const MARKER = 'gate-cse-quiz-server-v1';
const MAX_BODY = 2 * 1024 * 1024;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const escapeHtml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const formatMarks = value => Number(value.toFixed(4)).toLocaleString('en-US', { maximumFractionDigits: 4 });

function scoreAttempt(attempt, data) {
  const invalid = () => { throw new Error('The saved score cannot be verified.'); };
  if (!object(data) || typeof data.id !== 'string' || !Array.isArray(data.questions) || !data.questions.length || attempt.version !== 1 || attempt.quizId !== data.id || attempt.quizSignature !== JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null })) invalid();
  for (const key of ['submittedAt', 'updatedAt']) if (typeof attempt[key] !== 'string' || !Number.isFinite(Date.parse(attempt[key]))) invalid();
  const ids = new Set(data.questions.map(question => question?.id));
  if (ids.size !== data.questions.length || [...ids].some(id => typeof id !== 'string' || !id.trim()) || Object.keys(attempt.answers).some(id => !ids.has(id))) invalid();
  let score = 0, maximum = 0;
  const verified = new Map();
  for (const question of data.questions) {
    const type = question.type || 'mcq', answer = attempt.answers[question.id];
    const correctMarks = question.marks ?? data.scoring?.correct ?? 1, incorrectMarks = question.incorrectMarks ?? data.scoring?.incorrect ?? 0;
    if (!Number.isFinite(correctMarks) || correctMarks <= 0 || !Number.isFinite(incorrectMarks) || incorrectMarks > 0 || !['mcq', 'msq', 'nat'].includes(type)) invalid();
    const answered = answer !== null && answer !== undefined;
    let correct = false;
    if (type === 'nat') {
      if (!question.marksToAll && (!Array.isArray(question.correctRanges) || !question.correctRanges.length || question.correctRanges.some(range => !object(range) || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min > range.max))) invalid();
      if (answered && (typeof answer !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(answer.trim()) || !Number.isFinite(Number(answer.trim())))) invalid();
      correct = answered && !question.marksToAll && question.correctRanges.some(({ min, max }) => Number(answer.trim()) >= min && Number(answer.trim()) <= max);
    } else {
      if (!Array.isArray(question.options) || question.options.length < 2) invalid();
      const options = new Set(question.options.map(option => option?.id)), key = type === 'msq' ? question.correctAnswers : question.acceptedAnswers || [question.correctAnswer];
      if (options.size !== question.options.length || [...options].some(id => typeof id !== 'string' || !id.trim()) || (!question.marksToAll && (!Array.isArray(key) || !key.length || new Set(key).size !== key.length || key.some(id => !options.has(id))))) invalid();
      if (answered && (type === 'msq' ? !Array.isArray(answer) || !answer.length || new Set(answer).size !== answer.length || answer.some(id => !options.has(id)) : !options.has(answer))) invalid();
      correct = answered && !question.marksToAll && (type === 'msq' ? answer.length === key.length && answer.every(id => key.includes(id)) : key.includes(answer));
    }
    let eligible = true;
    if (question.requiresCorrect !== undefined) {
      const prerequisite = verified.get(question.requiresCorrect);
      if (typeof question.requiresCorrect !== 'string' || !prerequisite || type !== 'mcq' || question.marksToAll || incorrectMarks !== 0 || (prerequisite.question.type || 'mcq') !== 'mcq' || prerequisite.question.marksToAll || prerequisite.question.requiresCorrect !== undefined) invalid();
      eligible = prerequisite.correct;
    }
    verified.set(question.id, { question, correct: correct && eligible });
    maximum += correctMarks;
    score += !eligible ? 0 : question.marksToAll || correct ? correctMarks : answered ? incorrectMarks : 0;
  }
  if (!Number.isFinite(score) || !Number.isFinite(maximum)) invalid();
  return { score, maximum };
}

function createServer({ root = __dirname, port = PORT } = {}) {
  root = fs.realpathSync.native(root);
  let resetting = false, saving = 0;
  const reply = (res, status, text, type = 'text/plain; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' }); res.end(text); };
  async function jsonBody(req) {
    const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'Send application/json.');
    if (Number(req.headers['content-length']) > MAX_BODY) fail(413, 'Request is too large.');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) fail(413, 'Request is too large.'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON.'); }
  }
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
  async function quizDirectories() {
    const quizzes = [];
    for (const item of await fsp.readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith('_') || item.name.startsWith('.')) continue;
      try { quizzes.push({ name: item.name, folder: await quizFolder(item.name) }); } catch { /* Ignore folders that are not quizzes. */ }
    }
    return quizzes;
  }
  async function lastAttempt(folder) {
    try {
      const file = path.join(folder, 'attempt.json'), stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BODY) return { attempted: false };
      const attempt = JSON.parse(await fsp.readFile(file, 'utf8'));
      const attempted = object(attempt) && object(attempt.answers) && Object.values(attempt.answers).some(answer => answer !== null);
      if (!attempted) return { attempted: false };
      try {
        const source = await fsp.readFile(path.join(folder, 'quiz-data.js'), 'utf8');
        const data = JSON.parse(vm.runInNewContext(source + '\n;JSON.stringify(window.QUIZ_DATA);', { window: {} }, { timeout: 100, contextCodeGeneration: { strings: false, wasm: false } }));
        return { attempted: true, result: scoreAttempt(attempt, data) };
      } catch { return { attempted: true }; }
    } catch { return { attempted: false }; }
  }
  async function landing() {
    const links = [];
    for (const { name, folder } of await quizDirectories()) {
      try {
        const html = await fsp.readFile(path.join(folder, 'index.html'), 'utf8');
        const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] || name;
        const { attempted, result } = await lastAttempt(folder);
        const scoreLabel = result ? `Last score: ${formatMarks(result.score)} / ${formatMarks(result.maximum)}` : 'Last score unavailable';
        const score = `<span class="paper-score"${attempted ? '' : ' hidden'}><span class="paper-score-value">${scoreLabel}</span><progress class="paper-score-bar"${result ? ` value="${Math.max(0, Math.min(result.maximum, result.score))}" max="${result.maximum}" aria-label="Last score: ${formatMarks(result.score)} out of ${formatMarks(result.maximum)} marks"` : ' hidden'}></progress></span>`;
        links.push(`<li data-attempted="${attempted}"><a class="question-card paper-card" href="/${encodeURIComponent(name)}/"><div class="paper-details"><span class="eyebrow">Question paper</span><h2>${escapeHtml(title)}</h2><span class="paper-status ${attempted ? 'attempted' : 'unattempted'}">${attempted ? 'Attempted before' : 'Not attempted'}</span></div>${score}<span class="paper-open">Open quiz <span aria-hidden="true">&rarr;</span></span></a></li>`);
      } catch { /* Ignore folders that are not quizzes. */ }
    }
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GATE CSE quizzes</title>
  <script src="/_template/theme.js"></script>
  <script src="/_template/home.js" defer></script>
  <link rel="stylesheet" href="/_template/styles.css">
</head>
<body>
  <main class="container home-page">
    <header class="page-header">
      <div class="header-top">
        <p class="eyebrow">Your practice library</p>
        <button id="theme-toggle" class="toggle-switch theme-toggle" role="switch" aria-checked="false" aria-label="Theme" type="button"><span class="switch-label">Theme</span><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></button>
      </div>
      <h1>GATE CSE quizzes</h1>
      <p class="subtitle">Choose a paper and practise at your own pace.</p>
    </header>
    <div class="home-tools">
      <label class="toggle-switch home-filter"><input id="unsolved-only" type="checkbox" role="switch"><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span><span class="switch-label">Unsolved only</span></label>
      <button id="reset-attempts" class="button button-secondary" type="button"${links.length ? '' : ' disabled'}>Reset saved attempts</button>
    </div>
    <p id="home-status" class="status-message" role="status" aria-live="polite" hidden></p>
    <p id="paper-count" class="home-count" role="status" aria-live="polite">${links.length} paper${links.length === 1 ? '' : 's'} available</p>
    <ul id="home-papers" class="home-papers" aria-label="Available question papers">${links.join('')}</ul>
    <p id="no-papers" class="empty-state"${links.length ? ' hidden' : ''}>${links.length ? 'No unsolved papers left. Turn off the filter to see all papers.' : 'No papers are ready yet. Add a quiz folder to get started.'}</p>
    <p class="home-note subtitle">Your unfinished answers stay in this browser. Submit saves your latest result for review.</p>
  </main>
</body>
</html>`;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.host !== origin.slice(7)) return reply(res, 403, 'Use the local quiz address.');
      const pathname = decodeURIComponent(req.url.split('?')[0]);
      if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part === '.')) return reply(res, 400, 'Invalid path.');
      if (req.method === 'GET' && pathname === '/health') return reply(res, 200, JSON.stringify({ server: MARKER }), mime['.json']);
      if (req.method === 'GET' && pathname === '/') return reply(res, 200, await landing(), mime['.html']);
      if (pathname === '/reset-attempts') {
        if (req.method !== 'POST') return reply(res, 405, 'Method not allowed.');
        if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return reply(res, 403, 'Use the local home page to reset attempts.');
        const settings = await jsonBody(req);
        if (!object(settings) || settings.confirm !== true) return reply(res, 400, 'Confirm the reset first.');
        if (resetting || saving) return reply(res, 409, 'A save or reset is in progress. Try again.');
        resetting = true;
        try {
          const targets = [];
          for (const { folder } of await quizDirectories()) {
            const target = path.join(folder, 'attempt.json');
            let stat;
            try { stat = await fsp.lstat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (!stat.isFile() || stat.isSymbolicLink()) return reply(res, 403, 'Attempt files must be regular files. No attempts were reset.');
            targets.push(target);
          }
          let reset = 0;
          for (const target of targets) {
            try { await fsp.unlink(target); reset++; } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          return reply(res, 200, JSON.stringify({ reset }), mime['.json']);
        } finally { resetting = false; }
      }
      const [name, ...parts] = pathname.slice(1).split('/');
      const folder = await quizFolder(name);
      const relative = parts.join('/') || 'index.html';
      if (req.method === 'POST') {
        if (name === '_template' || relative !== 'attempt.json') return reply(res, 405, 'Only submitted attempts can be saved.');
        if ((req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin' && req.headers['sec-fetch-site'] !== 'none')) return reply(res, 403, 'Use the local quiz page to submit.');
        const attempt = await jsonBody(req);
        if (!object(attempt) || attempt.version !== 1 || typeof attempt.quizId !== 'string' || !attempt.quizId.trim() || attempt.quizId.length > 200 || !object(attempt.answers) || !object(attempt.summary) || !Array.isArray(attempt.results) || typeof attempt.submittedAt !== 'string' || !Number.isFinite(Date.parse(attempt.submittedAt)) || typeof attempt.updatedAt !== 'string' || !Number.isFinite(Date.parse(attempt.updatedAt))) return reply(res, 400, 'A completed quiz attempt is required.');
        if (resetting) return reply(res, 409, 'A reset is in progress. Try submitting again.');
        saving++;
        try {
          const target = path.join(folder, 'attempt.json');
          try { if ((await fsp.lstat(target)).isSymbolicLink()) return reply(res, 403, 'Attempt file must be a regular file.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          const temporary = path.join(folder, `.attempt-${randomUUID()}.tmp`);
          try { await fsp.writeFile(temporary, JSON.stringify(attempt, null, 2) + '\n', { flag: 'wx' }); await fsp.rename(temporary, target); }
          finally { await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
          return reply(res, 200, JSON.stringify({ saved: true }), mime['.json']);
        } finally { saving--; }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Method not allowed.');
      const file = await fsp.realpath(path.resolve(folder, relative));
      if (!inside(folder, file) || !inside(root, file)) return reply(res, 403, 'Invalid file path.');
      const stat = await fsp.stat(file);
      if (!stat.isFile()) return reply(res, 404, 'File not found.');
      res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res);
    } catch (error) { reply(res, error.status || (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : error instanceof URIError ? 400 : 500), error.status ? error.message : error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'File not found.' : 'Unable to complete this request.'); }
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
