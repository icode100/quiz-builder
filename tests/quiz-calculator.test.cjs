const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server.cjs');

const assetTypes = {
  'index.html': 'text/html; charset=utf-8',
  'engine.js': 'text/javascript; charset=utf-8',
  'calculator.js': 'text/javascript; charset=utf-8',
  'calculator.css': 'text/css; charset=utf-8',
  'launcher.js': 'text/javascript; charset=utf-8',
  'launcher.css': 'text/css; charset=utf-8'
};

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quiz-calculator-test-'));
  const calculator = path.join(root, '_calculator');
  const server = createServer({ root, port: 0 });
  const sources = new Map();
  const key = {
    id: 'calculator-fixture', title: 'GATE CSE 2026 fixture',
    questions: [{ id: 'CS-1', type: 'mcq', text: 'Fixture question', options: [{ id: 'A', text: 'One' }, { id: 'B', text: 'Two' }], correctAnswer: 'A', marks: 1, incorrectMarks: -1 / 3 }]
  };
  const keySource = `window.QUIZ_DATA = ${JSON.stringify(key)};\n`;
  const attempt = {
    version: 1, quizId: key.id,
    quizSignature: JSON.stringify({ questions: key.questions, scoring: null }),
    submittedAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z',
    answers: { 'CS-1': 'A' }, summary: { score: 999 }, results: []
  };

  async function fixture(name, savedAttempt) {
    const folder = path.join(root, name);
    await fs.mkdir(folder);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${key.title}</title><script src="quiz-data.js" defer></script></head><body><main><h1>Fixture quiz</h1><form id="quiz-form"></form></main></body></html>\n`;
    for (const [file, content] of [['index.html', html], ['quiz-data.js', keySource], ['notes.html', '<!doctype html><title>Notes</title><p>Original notes</p>\n']]) {
      const filename = path.join(folder, file);
      await fs.writeFile(filename, content);
      sources.set(filename, content);
    }
    if (savedAttempt !== undefined) await fs.writeFile(path.join(folder, 'attempt.json'), savedAttempt);
    return folder;
  }

  function request(url, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method, headers }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(3000, () => req.destroy(new Error(`Request timed out: ${method} ${url}`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  function injectedOnce(html, label) {
    assert.equal((html.match(/href="\/_calculator\/launcher\.css"/g) || []).length, 1, `${label}: one shared launcher stylesheet`);
    assert.equal((html.match(/src="\/_calculator\/launcher\.js"/g) || []).length, 1, `${label}: one shared launcher script`);
    assert.match(html, /<script\b(?=[^>]*\bsrc="\/_calculator\/launcher\.js")(?=[^>]*\bdefer\b)[^>]*>/, `${label}: deferred launcher`);
    assert.doesNotMatch(html, /src="\/_calculator\/(?:engine|calculator)\.js"/, `${label}: calculator loads separately when opened`);
  }

  async function attemptSnapshot() {
    const snapshot = {};
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(root, entry.name, 'attempt.json');
      try {
        const stat = await fs.lstat(target);
        snapshot[entry.name] = { content: await fs.readFile(target, 'utf8'), mtime: stat.mtimeMs, size: stat.size };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        snapshot[entry.name] = null;
      }
    }
    return snapshot;
  }

  try {
    await fs.mkdir(calculator);
    for (const filename of Object.keys(assetTypes)) {
      await fs.copyFile(path.join(__dirname, '..', '_calculator', filename), path.join(calculator, filename));
    }
    const saved = await fixture('gate-saved', JSON.stringify(attempt, null, 2) + '\n');
    await fixture('gate-unsolved');
    await fixture('gate-malformed', '{existing malformed attempt\n');
    const template = await fixture('_template', 'preserve template attempt\n');
    await fs.writeFile(path.join(root, 'secret.txt'), 'private root file\n');
    await fs.writeFile(path.join(calculator, 'not-allowed.txt'), 'not a public calculator asset\n');
    await fs.mkdir(path.join(calculator, 'nested'));
    await fs.writeFile(path.join(calculator, 'nested', 'calculator.js'), 'not a public nested calculator asset\n');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const before = await attemptSnapshot();

    const home = await request('/');
    assert.equal(home.status, 200);
    injectedOnce(home.body, 'Home page');
    assert.doesNotMatch(home.body, /<script[^>]+src="[^\"]*quiz(?:-data)?\.js"/);
    assert.doesNotMatch(home.body, /href="\/_calculator\/"/, 'Calculator assets do not appear as a quiz card');
    for (const route of ['/gate-saved/', '/gate-saved/index.html', '/gate-saved', '/gate-unsolved/', '/gate-malformed/']) {
      const page = await request(route);
      assert.equal(page.status, 200, route);
      injectedOnce(page.body, route);
      assert.match(page.body, /<h1>Fixture quiz<\/h1>/, 'Quiz content survives injection');
      assert.equal((page.body.match(/src="quiz-data\.js"/g) || []).length, 1, 'Existing scripts survive injection');
    }
    for (const route of ['/_template/', '/_template/index.html', '/gate-saved/notes.html', '/gate-saved/quiz-data.js']) {
      const result = await request(route);
      assert.equal(result.status, 200, route);
      assert.doesNotMatch(result.body, /\/_calculator\/launcher\./, `${route}: no launcher injection`);
    }
    assert.equal((await request('/gate-saved/quiz-data.js')).body, keySource, 'Question data is served verbatim');
    assert.equal((await request('/_template/index.html')).body, await fs.readFile(path.join(template, 'index.html'), 'utf8'));

    for (const [filename, type] of Object.entries(assetTypes)) {
      const route = `/_calculator/${filename}`;
      const expected = await fs.readFile(path.join(calculator, filename), 'utf8');
      const get = await request(route);
      assert.equal(get.status, 200, route);
      assert.equal(get.body, expected, `${route}: configured-root contents`);
      assert.equal(get.headers['content-type'], type, `${route}: MIME type`);
      assert.equal(get.headers['x-content-type-options'], 'nosniff');
      assert.equal(Number(get.headers['content-length']), Buffer.byteLength(expected));
      const head = await request(route, { method: 'HEAD' });
      assert.equal(head.status, 200, `${route}: HEAD`);
      assert.equal(head.body, '', `${route}: HEAD has no body`);
      assert.equal(head.headers['content-type'], type);
      assert.equal(head.headers['content-length'], get.headers['content-length']);
    }
    const calculatorPage = await fs.readFile(path.join(calculator, 'index.html'), 'utf8');
    for (const route of ['/_calculator', '/_calculator/', '/_calculator/?from=quiz']) {
      const result = await request(route);
      assert.equal(result.status, 200, route);
      assert.equal(result.body, calculatorPage, 'Directory aliases serve the shared calculator page');
    }
    assert.equal((await request('/_calculator/engine.js?cache=test')).body, await fs.readFile(path.join(calculator, 'engine.js'), 'utf8'));
    assert.doesNotMatch(calculatorPage, /<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["'](?:https?:)?\/\//i, 'Calculator scripts/styles stay local');
    for (const filename of ['engine.js', 'calculator.js', 'launcher.js']) {
      const source = await fs.readFile(path.join(calculator, filename), 'utf8');
      assert.doesNotMatch(source, /\b(?:eval\s*\(|new\s+Function\s*\()/, `${filename}: does not execute arbitrary expressions as JavaScript`);
      assert.doesNotMatch(source, /\b(?:QUIZ_DATA|quizSignature|reviewFlags)\b|practice-quiz:(?:saved|draft)|attempt\.json/, `${filename}: no quiz response or saved-attempt integration`);
    }
    for (const route of ['/_calculator/not-allowed.txt', '/_calculator/nested/calculator.js', '/_calculator/quiz-data.js', '/_calculator/attempt.json', '/_calculator/server.cjs', '/_calculator/missing.js']) {
      assert.equal((await request(route)).status, 404, `${route}: only explicit calculator assets are public`);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const route of ['/_calculator', '/_calculator/', '/_calculator/index.html', '/_calculator/engine.js', '/_calculator/attempt.json']) {
        const result = await request(route, { method, body: JSON.stringify(attempt), headers: { 'Content-Type': 'application/json' } });
        assert.equal(result.status, 405, `${method} ${route}: calculator routes are read-only`);
      }
    }
    for (const route of ['/_calculator/../secret.txt', '/_calculator/%2e%2e/secret.txt', '/_calculator/%2e%2e%2fsecret.txt', '/_calculator/%5c..%5csecret.txt', '/_calculator/%00index.html', '/_calculator/%ZZ']) {
      const result = await request(route);
      assert.ok([400, 403, 404].includes(result.status), `${route}: rejected traversal or invalid path`);
      assert.doesNotMatch(result.body, /private root file/);
    }

    const delayed = await fixture('gate-added-after-start');
    const delayedPage = await request('/gate-added-after-start/');
    assert.equal(delayedPage.status, 200);
    injectedOnce(delayedPage.body, 'Quiz discovered after server start');
    assert.match((await request('/')).body, /href="\/gate-added-after-start\/"/);
    assert.doesNotMatch(await fs.readFile(path.join(delayed, 'index.html'), 'utf8'), /\/_calculator\//, 'Discovery never rewrites quiz files');
    before['gate-added-after-start'] = null;

    // Both in-root and out-of-root symlinks must fail instead of widening the asset allowlist.
    const linkedAsset = path.join(calculator, 'engine.js');
    const ordinaryAsset = `${linkedAsset}.test-backup`;
    await fs.rename(linkedAsset, ordinaryAsset);
    try {
      for (const target of [path.join(root, 'secret.txt'), path.join(saved, 'quiz-data.js')]) {
        try { await fs.symlink(target, linkedAsset); }
        catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') break; throw error; }
        try {
          const result = await request('/_calculator/engine.js');
          assert.equal(result.status, 403, 'Allowed asset filename cannot resolve through a symlink');
          assert.doesNotMatch(result.body, /private root file|window\.QUIZ_DATA/);
        } finally { await fs.unlink(linkedAsset); }
      }
      assert.equal((await request('/_calculator/engine.js')).status, 404, 'A missing allowed file is unavailable');
    } finally { await fs.rename(ordinaryAsset, linkedAsset); }

    const ordinaryDirectory = path.join(root, '_calculator.test-backup');
    await fs.rename(calculator, ordinaryDirectory);
    try {
      let linked = false;
      try { await fs.symlink(ordinaryDirectory, calculator, 'dir'); linked = true; }
      catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
      if (linked) {
        try { assert.equal((await request('/_calculator/engine.js')).status, 403, 'Calculator root must be an ordinary directory'); }
        finally { await fs.unlink(calculator); }
      }
    } finally { await fs.rename(ordinaryDirectory, calculator); }

    assert.deepEqual(await attemptSnapshot(), before, 'Calculator reads, rejected writes and discovery preserve all saved attempts and never create an attempt');
    for (const [filename, content] of sources) assert.equal(await fs.readFile(filename, 'utf8'), content, 'Server injection leaves every quiz/template source file unchanged');
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) assert.equal((await fs.readdir(path.join(root, entry.name))).filter(name => name.startsWith('.attempt-')).length, 0, 'No attempt write intermediates');
    }
    console.log('Shared calculator integration tests passed: dynamic injection, local asset routes/MIME/HEAD, allowlist, read-only methods, traversal/symlink guards, and quiz/attempt isolation.');
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    const relative = path.relative(os.tmpdir(), path.resolve(root));
    assert.ok(relative.startsWith('quiz-calculator-test-') && !relative.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
