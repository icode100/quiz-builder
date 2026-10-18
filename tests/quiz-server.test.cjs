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
  const options = ['A', 'B', 'C', 'D'].map(id => ({ id, text: `Option ${id}` }));
  const key = { id: 'test-quiz', title: 'Test quiz', questions: [
    { id: 'GA-1', type: 'mcq', text: 'Fixture MCQ', options, acceptedAnswers: ['B', 'D'], marks: 25, incorrectMarks: -25 / 3 },
    { id: 'CS-1', type: 'nat', text: 'Fixture NAT', correctRanges: [{ min: 0, max: 0 }, { min: 12, max: 13 }], marks: 25, incorrectMarks: 0 },
    { id: 'CS-2', type: 'msq', text: 'Fixture MSQ', options, correctAnswers: ['A', 'C'], marks: 25, incorrectMarks: 0 },
    { id: 'CS-3', type: 'mcq', text: 'Fixture award', options, marksToAll: true, marks: 25, incorrectMarks: 0 }
  ] };
  const keySource = `window.QUIZ_DATA = ${JSON.stringify(key)};`;
  const attempt = { version: 1, quizId: key.id, quizSignature: JSON.stringify({ questions: key.questions, scoring: null }), answers: { 'GA-1': 'B' }, submittedAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', summary: { score: 999 }, results: [{ id: 'GA-1', outcome: 'incorrect' }] };
  try {
    await fs.mkdir(quiz);
    await fs.writeFile(path.join(quiz, 'index.html'), '<title>Test quiz</title><h1>Quiz</h1>');
    await fs.writeFile(path.join(quiz, 'quiz-data.js'), keySource);
    await fs.writeFile(path.join(quiz, 'original.pdf'), 'unchanged source PDF fixture');
    await fs.mkdir(path.join(quiz, 'assets'));
    await fs.writeFile(path.join(quiz, 'assets', 'question.png'), 'unchanged question image fixture');
    await fs.writeFile(path.join(root, 'secret.txt'), 'not a quiz asset');
    await fs.mkdir(path.join(root, '_template'));
    await fs.writeFile(path.join(root, '_template', 'index.html'), '<title>Blank template</title>');
    await fs.writeFile(path.join(root, '_template', 'quiz-data.js'), 'window.QUIZ_DATA = {};');
    await fs.writeFile(path.join(root, '_template', 'attempt.json'), 'preserve template attempt');
    await fs.mkdir(path.join(root, 'not-a-quiz'));
    await fs.writeFile(path.join(root, 'not-a-quiz', 'attempt.json'), 'preserve nonquiz attempt');
    for (const filename of ['styles.css', 'theme.js', 'home.js']) await fs.copyFile(path.join(__dirname, '..', '_template', filename), path.join(root, '_template', filename));
    async function fixture(name, answers, title = name) {
      const directory = path.join(root, name);
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, 'index.html'), `<title>${title}</title>`);
      await fs.writeFile(path.join(directory, 'quiz-data.js'), keySource);
      if (answers !== undefined) await fs.writeFile(path.join(directory, 'attempt.json'), JSON.stringify({ ...attempt, answers }));
      return directory;
    }
    const statusFixtures = [
      ['gate-null', { 'GA-1': null, 'GA-2': null }, false],
      ['gate-zero', { 'GA-1': 0 }, true],
      ['gate-string-zero', { 'CS-1': '0' }, true],
      ['gate-array', { 'GA-1': [] }, true],
      ['gate-missing', undefined, false],
      ['gate-invalid', [], false]
    ];
    for (const [name, answers] of statusFixtures) await fixture(name, answers);
    const malformedQuiz = await fixture('gate-malformed');
    await fs.writeFile(path.join(malformedQuiz, 'attempt.json'), '{broken JSON');
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
    const post = (data, url = '/gate-test/attempt.json', headers = {}) => request(url, { method: 'POST', body: typeof data === 'string' ? data : JSON.stringify(data), headers: { 'Content-Type': 'application/json', Origin: origin, ...headers } });
    const reset = (data = { confirm: true }, headers = {}) => post(data, '/reset-attempts', headers);
    function checkStatus(html, name, attempted) {
      const card = (html.match(/<li\b[\s\S]*?<\/li>/g) || []).find(item => item.includes(`href="/${name}/"`));
      assert.ok(card, `Home page includes ${name}`);
      assert.match(card, new RegExp(`data-attempted="${attempted}"`));
      assert.match(card, new RegExp(attempted ? 'Attempted before' : 'Not attempted'));
      assert.match(card, new RegExp(`class="paper-status ${attempted ? 'attempted' : 'unattempted'}"`));
      assert.match(card, /class="paper-details"/);
      assert.match(card, attempted ? /class="paper-score">/ : /class="paper-score" hidden>/);
      return card;
    }
    assert.deepEqual(JSON.parse((await request('/health')).body), { server: MARKER });
    const landing = await request('/'); assert.equal(landing.status, 200); assert.match(landing.body, /Test quiz/); assert.doesNotMatch(landing.body, /Blank template/);
    assert.match(landing.body, /href="\/gate-test\/"/);
    assert.match(landing.body, /href="\/_template\/styles\.css"/);
    assert.match(landing.body, /src="\/_template\/theme\.js"/);
    assert.match(landing.body, /src="\/_template\/home\.js"/);
    assert.match(landing.body, /id="theme-toggle"/);
    assert.match(landing.body, /id="theme-toggle"[^>]*role="switch"[^>]*aria-checked="false"/);
    assert.match(landing.body, /id="unsolved-only"/);
    assert.match(landing.body, /id="unsolved-only"[^>]*type="checkbox"[^>]*role="switch"/);
    assert.match(landing.body, /id="reset-attempts"/);
    checkStatus(landing.body, 'gate-test', false);
    for (const [name, , attempted] of statusFixtures) checkStatus(landing.body, name, attempted);
    const unavailable = checkStatus(landing.body, 'gate-zero', true);
    assert.match(unavailable, /Last score unavailable/);
    assert.match(unavailable, /class="paper-score-bar" hidden/);
    assert.match(checkStatus(landing.body, 'gate-string-zero', true), /Last score: 50 \/ 100/);
    checkStatus(landing.body, 'gate-malformed', false);
    assert.equal(await fs.readFile(path.join(malformedQuiz, 'attempt.json'), 'utf8'), '{broken JSON');
    assert.doesNotMatch(landing.body, /<script[^>]+src="[^"]*quiz(?:-data)?\.js"/);
    for (const filename of ['styles.css', 'theme.js', 'home.js']) {
      const asset = await request(`/_template/${filename}`);
      assert.equal(asset.status, 200);
      assert.equal(asset.body, await fs.readFile(path.join(root, '_template', filename), 'utf8'));
    }
    const orderingFixtures = [
      ['order-set-ten', 'GATE CSE 2021: Set 10'],
      ['order-2022-fallback', 'Computer Science practice'],
      ['order-set-two', 'GATE CSE 2021 - Set 2'],
      ['order-unknown', 'Extra practice'],
      ['order-2099-title-priority', 'GATE CSE 2025'],
      ['order-set-one-copy-10', 'GATE CSE 2021 — Set 1'],
      ['order-set-one-copy-2', 'GATE CSE 2021 — Set 1']
    ];
    const orderingNames = orderingFixtures.map(([name]) => name);
    async function attemptSnapshot() {
      const snapshot = {};
      for (const item of await fs.readdir(root, { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        const file = path.join(root, item.name, 'attempt.json');
        try {
          const stat = await fs.stat(file);
          snapshot[item.name] = { content: await fs.readFile(file, 'utf8'), mtime: stat.mtimeMs, ctime: stat.ctimeMs };
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          snapshot[item.name] = null;
        }
      }
      return snapshot;
    }
    function orderedNames(html) {
      return [...html.matchAll(/<a\b[^>]*class="question-card paper-card"[^>]*href="\/([^"/]+)\/"/g)]
        .map(match => decodeURIComponent(match[1]));
    }
    try {
      for (const [name, title] of orderingFixtures) await fixture(name, name === 'order-set-two' ? { 'GA-1': 'D' } : undefined, title);
      const expected = ['order-2099-title-priority', 'order-2022-fallback', 'order-set-one-copy-2', 'order-set-one-copy-10', 'order-set-two', 'order-set-ten', 'order-unknown'];
      const beforeListing = await attemptSnapshot();
      const firstOrder = orderedNames((await request('/')).body);
      assert.deepEqual(firstOrder.filter(name => orderingNames.includes(name)), expected, 'Home lists newest years first, using title years before folder years and natural title/folder ties');
      const dated = expected.slice(0, -1);
      assert.ok(dated.every(name => firstOrder.indexOf(name) < firstOrder.indexOf('order-unknown')), 'Undated quizzes follow every dated paper');
      assert.deepEqual(orderedNames((await request('/')).body), firstOrder, 'Repeated home requests keep a stable paper order');
      assert.deepEqual(await attemptSnapshot(), beforeListing, 'Listing never creates or rewrites saved attempts');

      const newestName = 'order-new-paper';
      orderingNames.push(newestName);
      await fixture(newestName, undefined, 'GATE CSE 2026');
      const afterAddition = await attemptSnapshot();
      const updatedOrder = orderedNames((await request('/')).body);
      assert.equal(updatedOrder[0], newestName, 'A newly discovered latest-year quiz becomes the first card without restarting');
      assert.deepEqual(updatedOrder.filter(name => orderingNames.includes(name)), [newestName, ...expected]);
      assert.deepEqual(orderedNames((await request('/')).body), updatedOrder, 'The updated order remains stable');
      assert.deepEqual(await attemptSnapshot(), afterAddition, 'Discovering a new quiz leaves every saved attempt untouched');
    } finally {
      for (const name of orderingNames) await fs.rm(path.join(root, name), { recursive: true, force: true });
    }
    assert.match((await request('/gate-test/')).body, /<h1>Quiz/);
    assert.equal((await request('/gate-test/quiz-data.js')).status, 200);
    assert.equal((await request('/gate-test/attempt.json')).status, 404);
    assert.equal((await post(attempt)).status, 200);
    assert.deepEqual(JSON.parse((await request('/gate-test/attempt.json')).body), attempt);
    let card = checkStatus((await request('/')).body, 'gate-test', true);
    assert.match(card, /Last score: 50 \/ 100/);
    assert.match(card, /<progress class="paper-score-bar" value="50" max="100" aria-label="Last score: 50 out of 100 marks">/);
    assert.doesNotMatch(card, /999/);
    const scoreCases = [
      [{ 'GA-1': 'D', 'CS-1': '13', 'CS-2': ['C', 'A'] }, 100],
      [{ 'GA-1': 'A', 'CS-1': '12', 'CS-2': ['A'] }, Number((50 - 25 / 3).toFixed(4))],
      [{ 'CS-1': '13.00001', 'CS-2': ['A', 'C', 'D'] }, 25],
      [{ 'CS-1': '1' }, 25]
    ];
    for (const [answers, expected] of scoreCases) {
      assert.equal((await post({ ...attempt, answers })).status, 200);
      assert.match(checkStatus((await request('/')).body, 'gate-test', true), new RegExp(`Last score: ${String(expected).replace('.', '\\.')} \\/ 100`));
    }
    for (const invalid of [
      { quizId: 'another-paper' }, { quizSignature: 'stale key' }, { version: 2 }, { submittedAt: 'invalid' }, { updatedAt: null },
      { answers: { unknown: null, 'GA-1': 'B' } }, { answers: { 'GA-1': 'unknown' } },
      { answers: { 'CS-2': [] } }, { answers: { 'CS-2': ['A', 'A'] } }, { answers: { 'CS-2': ['A', 'unknown'] } },
      ...['-', ' ', '1e1', 'NaN', 'Infinity', '0x0', '1/2', '1,2'].map(answer => ({ answers: { 'CS-1': answer } }))
    ]) {
      await fs.writeFile(path.join(quiz, 'attempt.json'), JSON.stringify({ ...attempt, ...invalid }));
      const invalidCard = checkStatus((await request('/')).body, 'gate-test', true);
      assert.match(invalidCard, /Last score unavailable/);
      assert.match(invalidCard, /class="paper-score-bar" hidden/);
    }
    const withoutAward = structuredClone(key);
    delete withoutAward.questions[3].marksToAll;
    withoutAward.questions[3].correctAnswer = 'B';
    await fs.writeFile(path.join(quiz, 'quiz-data.js'), `window.QUIZ_DATA = ${JSON.stringify(withoutAward)};`);
    const negativeAttempt = { ...attempt, quizSignature: JSON.stringify({ questions: withoutAward.questions, scoring: null }), answers: { 'GA-1': 'A' } };
    assert.equal((await post(negativeAttempt)).status, 200);
    card = checkStatus((await request('/')).body, 'gate-test', true);
    assert.match(card, /Last score: -8\.3333 \/ 100/);
    assert.match(card, /class="paper-score-bar" value="0" max="100" aria-label="Last score: -8\.3333 out of 100 marks"/);
    await fs.writeFile(path.join(quiz, 'quiz-data.js'), keySource);
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
    assert.equal((await reset({ confirm: true }, { Origin: 'https://foreign.example' })).status, 403);
    for (const method of ['GET', 'PUT']) assert.notEqual((await request('/reset-attempts', { method })).status, 200);
    assert.equal((await request('/reset-attempts', { method: 'POST', body: JSON.stringify({ confirm: true }), headers: { 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await reset({ confirm: true }, { 'Content-Type': 'text/plain' })).status, 415);
    for (const invalid of ['{', [], {}, { confirm: false }, { confirm: 'true' }]) assert.equal((await reset(invalid)).status, 400);
    assert.equal((await reset('x', { 'Content-Length': MAX_BODY + 1 })).status, 413);
    assert.equal((await reset('x'.repeat(MAX_BODY + 1), { 'Transfer-Encoding': 'chunked' })).status, 413);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(quiz, 'attempt.json'), 'utf8')), replacement);
    for (const [name, answers] of statusFixtures) {
      if (answers === undefined) await assert.rejects(fs.access(path.join(root, name, 'attempt.json')), { code: 'ENOENT' });
      else assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, name, 'attempt.json'), 'utf8')), { ...attempt, answers });
    }
    assert.equal(await fs.readFile(path.join(malformedQuiz, 'attempt.json'), 'utf8'), '{broken JSON');
    const cleared = await reset();
    assert.equal(cleared.status, 200);
    assert.equal(JSON.parse(cleared.body).reset, 7);
    for (const name of ['gate-test', 'gate-malformed', ...statusFixtures.map(([name]) => name)]) {
      await assert.rejects(fs.access(path.join(root, name, 'attempt.json')), { code: 'ENOENT' });
      checkStatus((await request('/')).body, name, false);
    }
    assert.equal(JSON.parse((await reset()).body).reset, 0);
    assert.equal(await fs.readFile(path.join(root, '_template', 'attempt.json'), 'utf8'), 'preserve template attempt');
    assert.equal(await fs.readFile(path.join(root, 'not-a-quiz', 'attempt.json'), 'utf8'), 'preserve nonquiz attempt');
    assert.equal(await fs.readFile(path.join(quiz, 'original.pdf'), 'utf8'), 'unchanged source PDF fixture');
    assert.equal(await fs.readFile(path.join(quiz, 'assets', 'question.png'), 'utf8'), 'unchanged question image fixture');
    assert.equal(await fs.readFile(path.join(quiz, 'quiz-data.js'), 'utf8'), keySource);
    assert.equal((await post(replacement)).status, 200);
    const directoryQuiz = await fixture('gate-directory');
    await fs.mkdir(path.join(directoryQuiz, 'attempt.json'));
    checkStatus((await request('/')).body, 'gate-directory', false);
    assert.equal((await reset()).status, 403);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(quiz, 'attempt.json'), 'utf8')), replacement);
    assert.ok((await fs.lstat(path.join(directoryQuiz, 'attempt.json'))).isDirectory());
    await fs.rmdir(path.join(directoryQuiz, 'attempt.json'));
    try {
      await fs.symlink(path.join(root, 'secret.txt'), path.join(quiz, 'outside.txt'));
      assert.equal((await request('/gate-test/outside.txt')).status, 403);
      const linkedQuiz = path.join(root, 'gate-linked');
      await fs.mkdir(linkedQuiz);
      await fs.copyFile(path.join(quiz, 'index.html'), path.join(linkedQuiz, 'index.html'));
      await fs.copyFile(path.join(quiz, 'quiz-data.js'), path.join(linkedQuiz, 'quiz-data.js'));
      await fs.symlink(path.join(root, 'secret.txt'), path.join(linkedQuiz, 'attempt.json'));
      checkStatus((await request('/')).body, 'gate-linked', false);
      assert.equal((await post(attempt, '/gate-linked/attempt.json')).status, 403);
      assert.equal((await reset()).status, 403);
      assert.ok((await fs.lstat(path.join(linkedQuiz, 'attempt.json'))).isSymbolicLink());
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(quiz, 'attempt.json'), 'utf8')), replacement);
      assert.equal(await fs.readFile(path.join(root, 'secret.txt'), 'utf8'), 'not a quiz asset');
    } catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(quiz, 'attempt.json'), 'utf8')), replacement);
    assert.equal((await fs.readdir(quiz)).filter(name => name.startsWith('.attempt-')).length, 0);
    console.log('Quiz server tests passed: newest-year-first discovery and natural ties, verified card scores/bars, attempt badges/toggles/reset controls, reset isolation and guards, themed assets, submitted attempts, validation, and paths.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const relative = path.relative(os.tmpdir(), path.resolve(root));
    assert.ok(relative.startsWith('quiz-server-test-') && !relative.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
