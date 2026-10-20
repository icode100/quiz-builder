const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load, editResponse, draftKey, attemptUrl, rejectFileDialogs, assertEditable } = require('./helpers/quiz-harness.cjs');

// This key is transcribed independently from the supplied Code-A key. Browser
// state is simulated; every server write below uses a disposable directory.
const FOLDER = path.resolve(__dirname, '../gate-cse-2011');
const TEMPLATE = path.resolve(__dirname, '../_template');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gate-cse-2011-key.json'), 'utf8'));
const KEY = FIXTURE.questions.map(row => ({ ...row, type: row.type.toLowerCase() }));
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const close = (actual, expected, message = 'Score') => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const sha = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const accepted = row => row.acceptedAnswers || [row.correctAnswer];
const correct = row => accepted(row)[0];
const wrong = row => [...'ABCD'].find(value => !accepted(row).includes(value));
const indexOf = (h, id) => h.data.questions.findIndex(question => question.id === id);
const card = (h, id) => h.document.getElementById(`question-card-${indexOf(h, id)}`);
const nav = (h, id) => h.document.getElementById(`nav-question-${indexOf(h, id)}`);
const flag = (h, id) => h.document.getElementById(`mark-review-${indexOf(h, id)}`);
const textOf = node => [node.textContent, ...node.children.map(textOf)].join(' ');
const posts = h => h.requests.filter(request => request.method === 'POST');
const reset = h => { Object.keys(h.t.answers).forEach(id => delete h.t.answers[id]); h.t.setSubmitted(''); };
function slide(h, id) {
  same(h.ids.questions.querySelectorAll('fieldset').filter(node => !node.hidden).map(node => node.id), [`question-card-${indexOf(h, id)}`]);
  assert.equal(nav(h, id).getAttribute('aria-current'), 'location');
  assert.match(h.ids['carousel-position'].textContent, new RegExp(`^${id.replace('-', ' ')} · `));
}
function independentGrade(answers) {
  return KEY.map(row => {
    const value = answers[row.id];
    const outcome = value == null ? 'unanswered' : row.requiresCorrect && !accepted(KEY.find(first => first.id === row.requiresCorrect)).includes(answers[row.requiresCorrect]) ? 'blocked' : accepted(row).includes(value) ? 'correct' : 'incorrect';
    return { outcome, earned: outcome === 'correct' ? row.marks : outcome === 'incorrect' ? row.incorrectMarks : 0 };
  });
}
function checkGrade(h, answers) {
  reset(h); Object.assign(h.t.answers, answers);
  const expected = independentGrade(answers), actual = h.t.grade();
  expected.forEach((row, index) => {
    assert.equal(actual[index].outcome, row.outcome, `${KEY[index].id} independent outcome`);
    close(actual[index].earned, row.earned, `${KEY[index].id} independent marks`);
  });
  close(h.t.summarize(actual).score, expected.reduce((sum, row) => sum + row.earned, 0));
  return h.t.summarize(actual);
}

async function checkServer(data) {
  const os = require('node:os'), http = require('node:http'), fsp = fs.promises;
  const { createServer } = require('../server.cjs');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-2011-test-'));
  const quiz = path.join(root, 'gate-cse-2011'), server = createServer({ root, port: 0 });
  let listening = false;
  try {
    await fsp.mkdir(quiz);
    for (const filename of ['index.html', 'quiz-data.js']) await fsp.copyFile(path.join(FOLDER, filename), path.join(quiz, filename));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    listening = true;
    const port = server.address().port;
    const request = (url, record) => new Promise((resolve, reject) => {
      const body = record && JSON.stringify(record);
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method: record ? 'POST' : 'GET',
        headers: record ? { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` } : {} }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(3000, () => req.destroy(new Error('Temporary server timed out')));
      req.on('error', reject); req.end(body);
    });
    const url = '/gate-cse-2011/attempt.json';
    assert.equal((await request(url)).status, 404, 'Opening a new quiz creates no attempt');
    assert.match((await request('/')).body, /data-attempted="false"/);
    const attempt = { version: 1, quizId: data.id, quizTitle: data.title,
      quizSignature: JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }),
      submittedAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
      answers: Object.fromEntries(KEY.map(row => [row.id, correct(row)])), summary: { score: 999 }, results: [] };
    const checkScore = async answers => {
      attempt.answers = Object.fromEntries(KEY.map(row => [row.id, answers[row.id] ?? null]));
      assert.equal((await request(url, attempt)).status, 200);
      const home = await request('/'); assert.equal(home.status, 200);
      const score = independentGrade(answers).reduce((sum, row) => sum + row.earned, 0);
      assert(home.body.includes(`Last score: ${Number(score.toFixed(4))} / 100`), 'Home recomputes verified marks rather than stored summary/results');
      assert(!home.body.includes('Last score: 999'));
      return home.body;
    };
    await checkScore(attempt.answers);
    for (const second of KEY.filter(row => row.requiresCorrect)) {
      const first = KEY.find(row => row.id === second.requiresCorrect);
      for (const firstState of ['blank', 'correct', 'wrong']) for (const secondState of ['blank', 'correct', 'wrong']) {
        const answers = { 'CS-1': correct(KEY[0]) };
        if (firstState !== 'blank') answers[first.id] = firstState === 'correct' ? correct(first) : wrong(first);
        if (secondState !== 'blank') answers[second.id] = secondState === 'correct' ? correct(second) : wrong(second);
        await checkScore(answers);
      }
    }
    const home = await checkScore(Object.fromEntries(KEY.map(row => [row.id, wrong(row)])));
    assert.match(home, /Last score: -32 \/ 100/);
    assert.match(home, /<progress class="paper-score-bar" value="0" max="100"/, 'Clamp only the negative-score bar');
    attempt.quizSignature = 'stale';
    assert.equal((await request(url, attempt)).status, 200);
    assert.match((await request('/')).body, /Last score unavailable/);
  } finally {
    if (listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('quiz-2011-test-'));
    await fsp.rm(root, { recursive: true, force: true });
  }
}

(async () => {
  const h = await load(FOLDER), { data, t, ids } = h;
  const noDialogs = rejectFileDialogs(h); t.validate(); assertEditable(h);
  assert.equal(data.id, 'gate-cse-2011-code-a'); assert.equal(data.title, 'GATE CSE 2011 - Code A');
  assert.equal(FIXTURE.questionCount, 65); assert.equal(data.questions.length, 65);
  assert.equal(FIXTURE.totalMarks, 100); assert.equal(data.cropDpi, 240);
  assert.equal(FIXTURE.bookletCode, 'A');
  same(FIXTURE.expectedScores, { blank: 0, perfect: 100, allWrong: -32 });
  same(data.questions.map(row => row.id), [...Array.from({ length: 55 }, (_, index) => `CS-${index + 1}`), ...Array.from({ length: 10 }, (_, index) => `GA-${index + 56}`)], 'Preserve printed CS 1–55 then GA 56–65');
  same(data.questions.reduce((counts, row) => ({ ...counts, [row.type.toUpperCase()]: (counts[row.type.toUpperCase()] || 0) + 1 }), {}), { MCQ: 65 });
  same(FIXTURE.typeCounts, { MCQ: 65 });
  assert.equal(data.questions.reduce((total, row) => total + row.marks, 0), 100);
  assert.equal(data.questionPaper, 'GATE2011.pdf'); assert.equal(data.answerKey, 'Key2011.pdf');
  same(data.sourceSha256, FIXTURE.sourceSha256);
  for (const digest of Object.values(data.sourceSha256)) assert.match(digest, /^[a-f0-9]{64}$/);
  same(data.sourcePageCounts, { questionPaper: 17, answerKey: 2 });
  assert.equal(FIXTURE.paperPageCount, 17); assert.equal(FIXTURE.keyPageCount, 2);
  for (const filename of ['quiz.js', 'theme.js', 'styles.css']) assert.equal(sha(path.join(FOLDER, filename)), sha(path.join(TEMPLATE, filename)), `${filename} inherits current shared behavior`);
  assert(!fs.readdirSync(FOLDER).some(filename => /\.pdf$/i.test(filename)), 'Do not duplicate the external originals');
  const html = fs.readFileSync(path.join(FOLDER, 'index.html'), 'utf8');
  assert.match(html, /id="quiz-home"[^>]*href="\/"/);
  for (const [, resource] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (resource === '/') continue;
    assert(!/^[a-z]+:/i.test(resource) && !path.isAbsolute(resource) && !resource.includes('..'));
    assert(fs.existsSync(path.join(FOLDER, resource)), `Missing local resource ${resource}`);
  }
  let imageCount = 0; const assets = new Set();
  for (let index = 0; index < KEY.length; index++) {
    const row = KEY[index], question = data.questions[index];
    for (const field of ['id', 'section', 'number', 'type', 'marks', 'incorrectMarks', 'answerKeyPage']) assert.equal(question[field], row[field], `${row.id} ${field}`);
    assert.equal(question.displayLabel, `${row.section} ${row.number}`);
    assert.equal(question.marks, row.section === 'CS' && row.number <= 25 || row.section === 'GA' && row.number <= 60 ? 1 : 2);
    assert.equal(question.incorrectMarks, [53, 55].includes(row.number) ? 0 : -row.marks / 3);
    assert.equal(question.requiresCorrect, row.number === 53 ? 'CS-52' : row.number === 55 ? 'CS-54' : undefined);
    assert.equal(question.requiresCorrect, row.requiresCorrect);
    assert(!question.marksToAll, 'The supplied key has no MTA');
    same(question.options.map(option => option.id), ['A', 'B', 'C', 'D']);
    same(question.acceptedAnswers || [question.correctAnswer], accepted(row), `${row.id} independent key`);
    assert.equal(question.text, '', 'Keep complete original question content in lossless crops');
    same(question.sourcePages, row.sourcePages, `${row.id} independently matched source pages`);
    same(question.sourcePages, [...new Set(question.images.map(image => image.page))]);
    assert(question.images.length && question.images.length === question.sourceRectangles.length);
    for (let part = 0; part < question.images.length; part++) {
      const image = question.images[part], crop = question.sourceRectangles[part];
      assert(image.src.startsWith('assets/') && !image.src.includes('..') && !path.isAbsolute(image.src));
      assert(image.alt && Number.isInteger(image.page) && image.page > 0 && image.page <= FIXTURE.paperPageCount);
      assert.equal(crop.page, image.page); assert.equal(crop.rect.length, 4); assert(crop.rect.every(Number.isFinite));
      const [left, top, right, bottom] = crop.rect;
      const size = data.sourcePageSizes.find(row => row.page === image.page);
      assert(size && size.width > 0 && size.height > 0);
      assert(left >= 0 && top >= 0 && right > left && bottom > top && right <= size.width && bottom <= size.height, `${row.id} crop fits source page`);
      const bytes = fs.readFileSync(path.join(FOLDER, image.src));
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const scaleX = Math.ceil(size.width * data.cropDpi / 72) / size.width;
      const scaleY = Math.ceil(size.height * data.cropDpi / 72) / size.height;
      assert.equal(bytes.readUInt32BE(16), Math.ceil(right * scaleX) - Math.floor(left * scaleX), `${row.id} unscaled crop width`);
      assert.equal(bytes.readUInt32BE(20), Math.ceil(bottom * scaleY) - Math.floor(top * scaleY), `${row.id} unscaled crop height`);
      assets.add(image.src); imageCount++;
    }
  }
  assert.equal(imageCount, 73, 'Retain shared context in both members of each common-data or linked pair');
  assert.equal(assets.size, 69, '65 question bodies and four unchanged shared-context crops');
  for (const [firstId, secondId] of [...FIXTURE.commonDataPairs, ...FIXTURE.linkedAnswerPairs]) {
    const first = data.questions.find(row => row.id === firstId), second = data.questions.find(row => row.id === secondId);
    assert(first.images.some(image => second.images.some(other => other.src === image.src)), `${firstId}/${secondId} both display their shared statement`);
  }
  assert.equal(fs.readdirSync(path.join(FOLDER, 'assets')).filter(filename => /\.png$/i.test(filename)).length, assets.size, 'No orphan crops');
  assert.equal(ids.questions.querySelectorAll('img').length, imageCount);
  assert.equal(ids['nav-groups'].querySelectorAll('.nav-question').length, 65);
  same(ids['nav-groups'].querySelectorAll('h3').map(node => node.textContent), ['CS', 'GA']);
  same(ids['nav-groups'].querySelectorAll('.nav-number').map(node => node.textContent), KEY.map(row => String(row.number)));
  same(data.questions.filter(row => row.requiresCorrect).map(row => [row.requiresCorrect, row.id]), [['CS-52', 'CS-53'], ['CS-54', 'CS-55']]);
  for (const id of ['CS-48', 'CS-49', 'CS-50', 'CS-51']) assert(!data.questions.find(row => row.id === id).requiresCorrect, 'Common-data questions are independent');
  const blank = checkGrade(h, {}); assert.equal(blank.score, 0); assert.equal(blank.maximum, 100); assert.equal(blank.counts.unanswered, 65);
  const perfect = checkGrade(h, Object.fromEntries(KEY.map(row => [row.id, correct(row)]))); assert.equal(perfect.score, 100); assert.equal(perfect.counts.correct, 65);
  const allWrong = checkGrade(h, Object.fromEntries(KEY.map(row => [row.id, wrong(row)]))); close(allWrong.score, -32); assert.equal(allWrong.counts.blocked, 2);
  checkGrade(h, Object.fromEntries(KEY.filter((row, index) => index % 3 !== 2).map(row => [row.id, KEY.indexOf(row) % 3 === 0 ? correct(row) : wrong(row)])));
  let optionChecks = 0, linkedChecks = 0;
  for (const row of KEY) for (const option of 'ABCD') {
    const answers = { [row.id]: option };
    if (row.requiresCorrect) answers[row.requiresCorrect] = correct(KEY.find(first => first.id === row.requiresCorrect));
    checkGrade(h, answers); optionChecks++;
  }
  for (const second of KEY.filter(row => row.requiresCorrect)) {
    const first = KEY.find(row => row.id === second.requiresCorrect);
    for (const firstState of ['blank', 'correct', 'wrong']) for (const secondState of ['blank', 'correct', 'wrong']) {
      const answers = {};
      if (firstState !== 'blank') answers[first.id] = firstState === 'correct' ? correct(first) : wrong(first);
      if (secondState !== 'blank') answers[second.id] = secondState === 'correct' ? correct(second) : wrong(second);
      checkGrade(h, answers); linkedChecks++;
    }
  }

  // Exercise the real shared carousel/cache/report lifecycle for this paper.
  reset(h); t.renderQuestions(); slide(h, 'CS-1');
  assert(ids['review-attempt'].disabled); assert.equal(ids['review-attempt'].title, 'This paper has not been attempted before.');
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, 'GET');
  await editResponse(h, 'CS-1', correct(KEY[0])); slide(h, 'CS-2');
  await nav(h, 'CS-1').click(); await flag(h, 'CS-1').click();
  await card(h, 'CS-1').querySelector('.clear-response').click();
  assert.equal(t.answers['CS-1'], undefined); assert.equal(flag(h, 'CS-1').getAttribute('aria-pressed'), 'true');
  await editResponse(h, 'CS-1', correct(KEY[0]));
  ids['timer-duration'].value = '30'; await ids['timer-duration'].fire('change');
  const cached = JSON.parse(h.storage.get(draftKey(h)));
  assert.equal(cached.answers['CS-1'], correct(KEY[0])); same(cached.reviewFlags, ['CS-1']); assert.equal(cached.timer.durationMinutes, 30);
  assert(!Object.hasOwn(cached, 'currentQuestionIndex'));
  await nav(h, 'GA-65').click(); slide(h, 'GA-65'); assert(ids['next-question'].disabled);
  const restored = await load(FOLDER, { storage: h.storage }); slide(restored, 'CS-1');
  assert.equal(restored.t.answers['CS-1'], correct(KEY[0])); same([...restored.t.reviewFlags], ['CS-1']);
  await editResponse(restored, 'CS-53', correct(KEY[52]));
  await restored.ids['quiz-form'].fire('submit');
  assert.equal(posts(restored).length, 1); assert(!restored.storage.has(draftKey(restored)));
  const saved = restored.server.get(attemptUrl(restored));
  assert.equal(saved.version, 1); assert.equal(saved.quizId, data.id); assert.equal(saved.results.length, 65); assert.equal(Object.keys(saved.answers).length, 65);
  close(saved.summary.score, 1); same(saved.reviewFlags, ['CS-1']); assert(!Object.hasOwn(saved, 'timer'));
  assert.equal(saved.results.find(row => row.questionId === 'CS-53').outcome, 'blocked');
  assert.equal(restored.ids['report-list'].querySelectorAll('.result-card').length, 65);
  assert.equal(restored.ids['report-list'].querySelectorAll('img').length, imageCount);
  assert(restored.ids['question-carousel'].hidden);
  assert.match(textOf(restored.ids['report-list']), /Not evaluated.*Correct answer:.*Your answer:|Your answer:.*Correct answer:.*Not evaluated/);
  await nav(restored, 'CS-53').click(); assert(restored.document.getElementById('result-card-52').focused);
  const savedJson = JSON.stringify(saved);
  await restored.ids['retry-quiz'].click(); slide(restored, 'CS-1'); assertEditable(restored);
  assert.equal(Object.keys(restored.t.answers).length, 0); same([...restored.t.reviewFlags], []);
  assert.equal(JSON.stringify(restored.server.get(attemptUrl(restored))), savedJson, 'Retry never rewrites the last submission');
  await editResponse(restored, 'GA-65', wrong(KEY[64])); await flag(restored, 'GA-65').click();
  const draft = restored.storage.get(draftKey(restored));
  saved.summary.score = 999; saved.results = [];
  await restored.ids['review-attempt'].click(); close(restored.t.summarize(restored.t.grade()).score, 1);
  assert.equal(restored.storage.get(draftKey(restored)), draft, 'Review keeps the unfinished draft');
  await restored.ids['retry-quiz'].click(); slide(restored, 'GA-65');
  assert.equal(restored.t.answers['GA-65'], wrong(KEY[64])); assert.equal(restored.storage.get(draftKey(restored)), draft);
  assert.equal(posts(restored).length, 1, 'Review, Back and Retry are read-only');
  const failed = await load(FOLDER, { fetch: (request, perform, response) => request.method === 'POST' ? response(500, { error: 'Fixture failure' }) : perform() });
  await editResponse(failed, 'CS-1', correct(KEY[0])); await flag(failed, 'CS-1').click(); await failed.ids['quiz-form'].fire('submit');
  assert(failed.storage.has(draftKey(failed))); assert(!failed.ids.report.hidden); same([...failed.t.reviewFlags], ['CS-1']);
  const unavailable = await load(FOLDER, { storageUnavailable: true });
  await editResponse(unavailable, 'CS-1', correct(KEY[0])); await unavailable.ids['quiz-form'].fire('submit'); await unavailable.ids['retry-quiz'].click();
  assertEditable(unavailable); assert.match(unavailable.ids['status-message'].textContent, /Could not cache/);
  noDialogs(); await checkServer(data);
  console.log(`PASS: GATE 2011 independent Code-A 65-MCQ key, original CS/GA numbering, ${assets.size} lossless crops/${imageCount} displayed parts with source provenance and shared runtime, blank/perfect/mixed/-32 wrong scores, ${optionChecks} choices, ${linkedChecks} linked combinations in browser and temporary server, common-data independence, cache/carousel/flags/timer, full reports, saved Review/Back/Retry, failed saves/storage, and verified home scores. No real attempts or browser state changed.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
