const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer, MARKER, MAX_BODY } = require('../server.cjs');

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quiz-server-test-'));
  const quiz = path.join(root, 'gate-test');
  const server = createServer({ root, port: 0 });
  try {
    await fs.mkdir(quiz);
    await fs.writeFile(path.join(quiz, 'index.html'), '<title>Test quiz</title><h1>Quiz</h1>');
    await fs.writeFile(path.join(quiz, 'quiz-data.js'), 'window.QUIZ_DATA = {};');
    await fs.writeFile(path.join(root, 'secret.txt'), 'not a quiz asset');
    await fs.mkdir(path.join(root, '_template'));
    await fs.writeFile(path.join(root, '_template', 'index.html'), '<title>Blank template</title>');
    await fs.writeFile(path.join(root, '_template', 'quiz-data.js'), 'window.QUIZ_DATA = {};');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    function request(url, { method = 'GET', body, headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.setTimeout(3000, () => req.destroy(new Error(`Request timed out: ${method} ${url}`)));
        req.on('error', reject); req.end(body);
      });
    }
    const attempt = { version: 1, quizId: 'test-quiz', answers: { 'GA-1': 'B' }, submittedAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', summary: { score: 1 }, results: [{ id: 'GA-1', outcome: 'correct' }] };
    const post = (data, url = '/gate-test/attempt.json', headers = {}) => request(url, { method: 'POST', body: typeof data === 'string' ? data : JSON.stringify(data), headers: { 'Content-Type': 'application/json', Origin: origin, ...headers } });
    assert.deepEqual(JSON.parse((await request('/health')).body), { server: MARKER });
    const landing = await request('/'); assert.equal(landing.status, 200); assert.match(landing.body, /Test quiz/); assert.doesNotMatch(landing.body, /Blank template/);
    assert.match((await request('/gate-test/')).body, /<h1>Quiz/);
    assert.equal((await request('/gate-test/quiz-data.js')).status, 200);
    assert.equal((await request('/gate-test/attempt.json')).status, 404);
    assert.equal((await post(attempt)).status, 200);
    assert.deepEqual(JSON.parse((await request('/gate-test/attempt.json')).body), attempt);
    const replacement = { ...attempt, answers: { 'GA-1': 'D' } };
    assert.equal((await post(replacement)).status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(quiz, 'attempt.json'), 'utf8')), replacement);
    for (const invalid of ['{', [], { ...attempt, submittedAt: null }, { ...attempt, version: 0 }, { ...attempt, answers: [] }, { ...attempt, summary: null }, { ...attempt, results: {} }]) assert.equal((await post(invalid)).status, 400);
    assert.equal((await post(attempt, '/gate-test/quiz-data.js')).status, 405);
    assert.equal((await post(attempt, '/_template/attempt.json')).status, 405);
    assert.equal((await post(attempt, '/gate-test/attempt.json', { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await post(attempt, '/gate-test/attempt.json', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post('x', '/gate-test/attempt.json', { 'Content-Length': MAX_BODY + 1 })).status, 413);
    assert.equal((await post('x'.repeat(MAX_BODY + 1), '/gate-test/attempt.json', { 'Transfer-Encoding': 'chunked' })).status, 413);
    assert.equal((await request('/health', { headers: { Host: 'evil.example' } })).status, 403);
    for (const url of ['/gate-test/../secret.txt', '/gate-test/%2e%2e/secret.txt', '/gate-test/%5c..%5csecret.txt', '/gate-test/%00', '/secret.txt']) assert.notEqual((await request(url)).status, 200);
    try {
      await fs.symlink(path.join(root, 'secret.txt'), path.join(quiz, 'outside.txt'));
      assert.equal((await request('/gate-test/outside.txt')).status, 403);
      const linkedQuiz = path.join(root, 'gate-linked');
      await fs.mkdir(linkedQuiz);
      await fs.copyFile(path.join(quiz, 'index.html'), path.join(linkedQuiz, 'index.html'));
      await fs.copyFile(path.join(quiz, 'quiz-data.js'), path.join(linkedQuiz, 'quiz-data.js'));
      await fs.symlink(path.join(root, 'secret.txt'), path.join(linkedQuiz, 'attempt.json'));
      assert.equal((await post(attempt, '/gate-linked/attempt.json')).status, 403);
      assert.equal(await fs.readFile(path.join(root, 'secret.txt'), 'utf8'), 'not a quiz asset');
    } catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(quiz, 'attempt.json'), 'utf8')), replacement);
    assert.equal((await fs.readdir(quiz)).filter(name => name.startsWith('.attempt-')).length, 0);
    console.log('Quiz server tests passed: static files, submitted attempts, validation, origin/host guards, and paths.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const relative = path.relative(os.tmpdir(), path.resolve(root));
    assert.ok(relative.startsWith('quiz-server-test-') && !relative.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
