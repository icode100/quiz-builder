const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { load, editResponse, draftKey, attemptUrl, rejectFileDialogs, assertEditable } = require('./helpers/quiz-harness.cjs');

// All practice/report requests use in-memory browser state or an isolated
// temporary server. The user's real attempt is never opened or submitted.
const FOLDER = path.resolve(__dirname, '../gate-cse-2010');
const TEMPLATE = path.resolve(__dirname, '../_template');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gate-cse-2010-key.json'), 'utf8'));
const KEY = new Map(FIXTURE.questions.map(row => [row.id, row]));
const ORDER = [...Array.from({ length: 62 }, (_, i) => i + 1), 64, 63, 65];
const ID = number => `${number <= 55 ? 'CS' : 'GA'}-${number}`;
const answersFor = row => row.acceptedAnswers || [row.correctAnswer];
const right = id => answersFor(KEY.get(id))[0];
const wrong = id => [...'ABCD'].find(option => !answersFor(KEY.get(id)).includes(option));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const close = (actual, expected, message = '') => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const index = (h, id) => h.data.questions.findIndex(q => q.id === id);
const card = (h, id) => h.document.getElementById(`question-card-${index(h, id)}`);
const nav = (h, id) => h.document.getElementById(`nav-question-${index(h, id)}`);
const flag = (h, id) => h.document.getElementById(`mark-review-${index(h, id)}`);
const result = (h, id) => h.t.grade().find(row => row.question.id === id);
const allText = node => [node.textContent, ...node.children.map(allText)].join(' ');
const clear = h => {
  Object.keys(h.t.answers).forEach(id => delete h.t.answers[id]);
  h.t.setSubmitted('');
};

async function testHomeIntegration(data) {
  const fsp = fs.promises, os = require('node:os'), http = require('node:http');
  const { createServer } = require('../server.cjs');
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-2010-test-'));
  const quiz = path.join(tempRoot, 'gate-cse-2010'), server = createServer({ root: tempRoot, port: 0 });
  let listening = false;
  try {
    await fsp.mkdir(quiz);
    for (const name of ['index.html', 'quiz-data.js']) await fsp.copyFile(path.join(FOLDER, name), path.join(quiz, name));
    await fsp.mkdir(path.join(tempRoot, '_template'));
    for (const name of ['styles.css', 'theme.js', 'home.js']) await fsp.copyFile(path.join(TEMPLATE, name), path.join(tempRoot, '_template', name));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); listening = true;
    const port = server.address().port, origin = `http://127.0.0.1:${port}`;
    const request = (url, attempt) => new Promise((resolve, reject) => {
      const body = attempt && JSON.stringify(attempt);
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json', Origin: origin } : {} }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(3000, () => req.destroy(new Error('Temporary-server request timed out')));
      req.on('error', reject); req.end(body);
    });
    const readCard = async () => {
      const home = await request('/'); assert.equal(home.status, 200);
      const item = (home.body.match(/<li\b[\s\S]*?<\/li>/g) || []).find(item => item.includes('href="/gate-cse-2010/"'));
      assert(item, 'Home discovers the 2010 paper'); return item;
    };
    assert.match(await readCard(), /data-attempted="false"/);
    assert.equal((await request('/gate-cse-2010/attempt.json')).status, 404, 'Opening creates no attempt');
    const answers = Object.fromEntries(FIXTURE.questions.map(row => [row.id, right(row.id)]));
    const attempt = { version: 1, quizId: data.id, quizTitle: data.title,
      quizSignature: JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }),
      submittedAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
      answers, summary: { score: -999 }, results: [], reviewFlags: ['CS-53'] };
    assert.equal((await request('/gate-cse-2010/attempt.json', attempt)).status, 200);
    let item = await readCard(); assert.match(item, /Last score: 100 \/ 100/);
    assert.match(item, /<progress class="paper-score-bar" value="100" max="100"/);
    answers['CS-52'] = wrong('CS-52'); answers['CS-54'] = null;
    assert.equal((await request('/gate-cse-2010/attempt.json', attempt)).status, 200);
    assert.match(await readCard(), /Last score: 91\.3333 \/ 100/, 'Server gates both answered dependents');
    answers['CS-52'] = right('CS-52'); answers['CS-54'] = right('CS-54');
    answers['CS-53'] = wrong('CS-53'); answers['CS-55'] = wrong('CS-55');
    assert.equal((await request('/gate-cse-2010/attempt.json', attempt)).status, 200);
    assert.match(await readCard(), /Last score: 96 \/ 100/, 'Wrong linked second answers have zero penalty');
    attempt.answers = Object.fromEntries(FIXTURE.questions.map(row => [row.id, wrong(row.id)]));
    assert.equal((await request('/gate-cse-2010/attempt.json', attempt)).status, 200);
    item = await readCard(); assert.match(item, /Last score: -32 \/ 100/);
    assert.match(item, /<progress class="paper-score-bar" value="0" max="100"/, 'Only the visual bar clamps the negative score');
    attempt.answers['CS-53'] = 'not an option';
    assert.equal((await request('/gate-cse-2010/attempt.json', attempt)).status, 200);
    item = await readCard(); assert.match(item, /data-attempted="true"/); assert.match(item, /Last score unavailable/, 'Blocked linked response is still validated');
    attempt.answers = answers; attempt.quizSignature = 'stale key';
    assert.equal((await request('/gate-cse-2010/attempt.json', attempt)).status, 200);
    item = await readCard(); assert.match(item, /data-attempted="true"/); assert.match(item, /Last score unavailable/);
  } finally {
    if (listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir()));
    assert(path.basename(tempRoot).startsWith('quiz-2010-test-'));
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

(async () => {
  const h = await load(FOLDER), { data, t, ids } = h, noDialogs = rejectFileDialogs(h);
  assert.equal(data.id, 'gate-cse-2010'); assert.equal(data.title, 'GATE CSE 2010');
  t.validate(); assert.equal(data.questions.length, 65); assert.equal(KEY.size, 65);
  same(data.questions.map(q => q.number), ORDER, 'Preserve supplied printed order, including GA64 before GA63');
  same(data.questions.map(q => q.id), ORDER.map(ID), 'Section-aware IDs preserve printed 1-65 numbering');
  same(data.sourceSha256, FIXTURE.sourceSha256, 'Source hashes match the independent fixture');
  same(data.sourcePageCounts, { questionPaper: 14, answerKey: 1, originalExam: 24 });
  assert.equal(data.questionPaper, 'CS-2010.pdf');
  assert.equal(data.referenceSource.name, 'GATE2010-original-exam-reference.pdf');
  assert.equal(data.referenceSource.pageCount, 24); assert.match(data.referenceSource.url, /^https:\/\//);
  assert.equal(data.referenceSource.sha256, FIXTURE.sourceSha256[data.referenceSource.name]);
  assert.equal(data.cropDpi, 240);
  for (const value of Object.values(data.sourceSha256)) assert.match(value, /^[a-f0-9]{64}$/);
  for (const name of [data.questionPaper, data.answerKey, data.referenceSource.name]) {
    assert(name && !path.isAbsolute(name) && !name.includes('..'));
    assert(!fs.existsSync(path.join(FOLDER, name)), 'Supplied sources remain external; only crops are in the quiz');
  }
  assert(!fs.readdirSync(FOLDER).some(name => /\.pdf$/i.test(name)), 'No source PDF copies in the quiz');
  for (const name of ['quiz.js', 'styles.css', 'theme.js']) assert.equal(sha256(path.join(FOLDER, name)), sha256(path.join(TEMPLATE, name)), `${name} matches the shared template`);

  const imagePaths = new Set(), originalQuestions = new Set(); let imageCount = 0;
  for (const q of data.questions) {
    const expected = KEY.get(q.id); assert(expected, `${q.id} independent fixture`);
    assert.equal(q.section, q.number <= 55 ? 'CS' : 'GA'); assert.equal(q.type, 'mcq');
    assert.equal(q.displayLabel, `${q.section} ${q.number}`);
    assert.equal(q.marks, q.number <= 25 || (q.number >= 56 && q.number <= 60) ? 1 : 2);
    assert.equal(q.marks, expected.marks); assert.equal(q.incorrectMarks, expected.incorrectMarks);
    close(q.incorrectMarks, [53, 55].includes(q.number) ? 0 : -q.marks / 3);
    assert.equal(q.requiresCorrect, q.number === 53 ? 'CS-52' : q.number === 55 ? 'CS-54' : undefined);
    assert(!q.marksToAll); assert.equal(q.answerKeyPage, 1);
    assert.equal(q.text, '', 'Complete original image blocks avoid uncertain OCR');
    same(q.acceptedAnswers || [q.correctAnswer], answersFor(expected), `${q.id} reconciled key`);
    same(q.options.map(option => option.id), ['A', 'B', 'C', 'D'], `${q.id} original option order`);
    assert(q.images.length && q.sourcePages.length); assert.equal(q.sourceRectangles.length, q.images.length);
    if (expected.sourcePages) same(q.sourcePages, expected.sourcePages, `${q.id} displayed source-page provenance`);
    if (expected.suppliedSourcePages) same(q.suppliedSourcePages, expected.suppliedSourcePages, `${q.id} supplied reproduction-page provenance`);
    same(q.sourcePages, [...new Set(q.images.map(image => image.page))], `${q.id} displayed image pages`);
    for (let part = 0; part < q.images.length; part++) {
      const image = q.images[part], crop = q.sourceRectangles[part];
      assert(!path.isAbsolute(image.src) && !image.src.includes('..') && !/^[a-z]+:/i.test(image.src));
      assert(image.src.startsWith('assets/'), 'Local question crop');
      assert(image.alt && image.alt.includes(`page ${image.page}`), `${q.id} useful image alt text with source page`); assert(Number.isInteger(image.page));
      assert.equal(crop.page, image.page); assert(['questionPaper', 'originalExam'].includes(crop.source));
      if (image.source) assert.equal(image.source, crop.source);
      assert(image.page >= 1 && image.page <= (crop.source === 'originalExam' ? 24 : 14));
      if (crop.source === 'originalExam') originalQuestions.add(q.number);
      assert.equal(crop.rect.length, 4); assert(crop.rect.every(Number.isFinite));
      assert(crop.rect[0] >= 0 && crop.rect[1] >= 0 && crop.rect[2] > crop.rect[0] && crop.rect[3] > crop.rect[1]);
      const bytes = fs.readFileSync(path.join(FOLDER, image.src));
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert(bytes.readUInt32BE(16) > 100 && bytes.readUInt32BE(20) > 30, `${q.id} readable PNG dimensions`);
      const pageSize = crop.source === 'originalExam' ? data.referenceSource : data.sourcePageSizes.find(row => row.page === image.page);
      assert(pageSize && pageSize.width > 0 && pageSize.height > 0, `${q.id} source dimensions are recorded`);
      assert(crop.rect[2] <= pageSize.width && crop.rect[3] <= pageSize.height, `${q.id} crop fits its PDF page`);
      const scaleX = Math.ceil(pageSize.width * data.cropDpi / 72) / pageSize.width;
      const scaleY = Math.ceil(pageSize.height * data.cropDpi / 72) / pageSize.height;
      assert.equal(bytes.readUInt32BE(16), Math.ceil(crop.rect[2] * scaleX) - Math.floor(crop.rect[0] * scaleX), `${q.id} crop width preserves source pixels`);
      assert.equal(bytes.readUInt32BE(20), Math.ceil(crop.rect[3] * scaleY) - Math.floor(crop.rect[1] * scaleY), `${q.id} crop height preserves source pixels`);
      imagePaths.add(image.src); imageCount++;
    }
  }
  same([...originalQuestions].sort((a, b) => a - b), [9, 11, 34, 36, 38, 65], 'All six damaged reproduction blocks restored from the original scan');
  assert.equal(imagePaths.size, 72, 'Complete set of distinct verified crops');
  assert.equal(imageCount, 77, 'All split blocks and repeated shared contexts are displayed');
  assert.equal(fs.readdirSync(path.join(FOLDER, 'assets')).filter(name => /\.png$/i.test(name)).length, imagePaths.size, 'No orphaned question crops');
  for (const [number, answer] of [[7, 'B'], [18, 'B'], [30, 'B'], [34, 'B'], [37, 'B'], [53, 'C']]) assert.equal(right(ID(number)), answer, `Reconciled Q${number}`);
  const html = fs.readFileSync(path.join(FOLDER, 'index.html'), 'utf8');
  assert.match(html, /<a\b[^>]*\bid="quiz-home"[^>]*\bhref="\/"/);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (match[1] === '/') continue;
    assert(!/^[a-z]+:/i.test(match[1]) && !path.isAbsolute(match[1]));
    assert(fs.existsSync(path.join(FOLDER, match[1])), `Missing local resource ${match[1]}`);
  }

  close(t.summarize(t.grade()).maximum, 100); close(t.summarize(t.grade()).score, 0);
  for (const row of FIXTURE.questions) t.answers[row.id] = right(row.id);
  close(t.summarize(t.grade()).score, 100); assert.equal(t.summarize(t.grade()).counts.correct, 65);
  let optionChecks = 0; clear(h);
  for (const q of data.questions) for (const option of 'ABCD') {
    clear(h); if (q.requiresCorrect) t.answers[q.requiresCorrect] = right(q.requiresCorrect);
    t.answers[q.id] = option; const actual = result(h, q.id), correct = answersFor(KEY.get(q.id)).includes(option);
    assert.equal(actual.outcome, correct ? 'correct' : 'incorrect', `${q.id} ${option}`);
    close(actual.earned, correct ? q.marks : q.incorrectMarks); optionChecks++;
  }
  assert.equal(optionChecks, 260);
  clear(h); for (const row of FIXTURE.questions) t.answers[row.id] = wrong(row.id);
  close(t.summarize(t.grade()).score, -32); assert.equal(t.summarize(t.grade()).counts.blocked, 2);
  for (const [first, second] of [['CS-52', 'CS-53'], ['CS-54', 'CS-55']]) {
    for (const prerequisite of [null, right(first), wrong(first)]) for (const answer of [null, right(second), wrong(second)]) {
      clear(h); if (prerequisite !== null) t.answers[first] = prerequisite; if (answer !== null) t.answers[second] = answer;
      const actual = result(h, second), evaluated = prerequisite === right(first);
      const expected = answer === null ? 'unanswered' : !evaluated ? 'blocked' : answer === right(second) ? 'correct' : 'incorrect';
      assert.equal(actual.outcome, expected, `${second}: prerequisite=${prerequisite}, answer=${answer}`);
      close(actual.earned, expected === 'correct' ? 2 : 0);
      if (expected === 'blocked') assert(actual.reason, 'Blocked response explains its prerequisite');
    }
  }
  for (const [first, second] of [['CS-48', 'CS-49'], ['CS-50', 'CS-51']]) {
    clear(h); t.answers[first] = wrong(first); t.answers[second] = right(second);
    assert.equal(result(h, first).outcome, 'incorrect'); assert.equal(result(h, second).outcome, 'correct', 'Common-data questions remain independent');
    close(result(h, second).earned, 2);
  }

  // Draft restoration, flags, full reports, retry and review use simulated storage.
  clear(h); t.renderQuestions();
  assert(ids['review-attempt'].disabled); assert.equal(ids['review-attempt'].title, 'This paper has not been attempted before.');
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, 'GET'); assert.equal(h.requests[0].cache, 'no-store');
  assert.equal(ids.questions.querySelectorAll('input').length, 260);
  assert.equal(ids['nav-groups'].querySelectorAll('.nav-question').length, 65);
  same(ids['nav-groups'].querySelectorAll('h3').map(node => node.textContent), ['CS', 'GA']);
  await editResponse(h, 'CS-1', right('CS-1')); await flag(h, 'CS-1').click();
  assert.equal(ids['nav-progress'].textContent, '1 attempted · 64 not attempted'); assert(ids['review-attempt'].disabled);
  const restored = await load(FOLDER, { storage: h.storage, server: h.server });
  assert.equal(restored.t.answers['CS-1'], right('CS-1')); assert.equal(flag(restored, 'CS-1').attrs['aria-pressed'], 'true');
  assert(card(restored, 'CS-1').querySelectorAll('input').find(input => input.value === right('CS-1')).checked);
  await card(restored, 'CS-1').querySelector('.clear-response').click();
  assert.equal(restored.t.answers['CS-1'], undefined); assert.equal(flag(restored, 'CS-1').attrs['aria-pressed'], 'true');
  await editResponse(restored, 'CS-11', right('CS-11')); await editResponse(restored, 'CS-53', right('CS-53'));
  await restored.ids['quiz-form'].fire('submit');
  const submission = restored.server.get(attemptUrl(restored));
  assert.equal(submission.results.length, 65); assert.equal(Object.keys(submission.answers).length, 65);
  assert(!restored.storage.has(draftKey(restored))); same(submission.reviewFlags, ['CS-1']);
  close(submission.summary.score, 1); assert.equal(submission.results.find(row => row.questionId === 'CS-53' || row.id === 'CS-53')?.outcome ?? submission.results[index(restored, 'CS-53')].outcome, 'blocked');
  assert(!restored.ids['review-attempt'].disabled); assert.equal(flag(restored, 'CS-1').attrs['aria-pressed'], 'false');
  const reportText = allText(restored.ids['report-list']);
  assert(reportText.includes('Not evaluated') && reportText.includes('Correct answer:') && reportText.includes('Your answer:'));
  assert.equal(restored.ids['report-list'].querySelectorAll('.result-card').length, 65);
  assert.equal(restored.ids['report-list'].querySelectorAll('img').length, imageCount);
  await nav(restored, 'GA-63').click(); assert(restored.document.getElementById(`result-card-${index(restored, 'GA-63')}`).focused);
  const savedDisk = JSON.stringify(submission);
  await restored.ids['retry-quiz'].click(); assert.equal(Object.keys(restored.t.answers).length, 0); assertEditable(restored);
  assert.equal(JSON.stringify(restored.server.get(attemptUrl(restored))), savedDisk); assert.equal(flag(restored, 'CS-1').attrs['aria-pressed'], 'false');
  await editResponse(restored, 'GA-64', right('GA-64')); await flag(restored, 'GA-64').click();
  const activeDraft = restored.storage.get(draftKey(restored)); submission.summary.score = 999; submission.results = [];
  await restored.ids['review-attempt'].click(); close(restored.t.summarize(restored.t.grade()).score, 1);
  assert.equal(restored.storage.get(draftKey(restored)), activeDraft); assert.equal(restored.ids['retry-quiz'].textContent, 'Back to quiz');
  await restored.ids['retry-quiz'].click(); assert.equal(restored.t.answers['GA-64'], right('GA-64'));
  assert.equal(flag(restored, 'GA-64').attrs['aria-pressed'], 'true'); assert.equal(restored.storage.get(draftKey(restored)), activeDraft);
  await restored.ids['clear-answers'].click(); assert.equal(flag(restored, 'GA-64').attrs['aria-pressed'], 'false');
  const failed = await load(FOLDER, { fetch: (request, perform, response) => request.method === 'POST' ? response(500, { error: 'Simulated write failure' }) : perform() });
  await editResponse(failed, 'CS-1', right('CS-1')); await flag(failed, 'CS-1').click(); await failed.ids['quiz-form'].fire('submit');
  assert(failed.storage.has(draftKey(failed))); assert(!failed.ids.report.hidden); assert.equal(flag(failed, 'CS-1').attrs['aria-pressed'], 'true');
  const unavailable = await load(FOLDER, { storageUnavailable: true });
  await editResponse(unavailable, 'CS-1', right('CS-1')); await unavailable.ids['quiz-form'].fire('submit');
  await unavailable.ids['retry-quiz'].click(); assert.equal(Object.keys(unavailable.t.answers).length, 0); assertEditable(unavailable);
  assert.match(unavailable.ids['status-message'].textContent, /Could not cache/);
  vm.runInContext(fs.readFileSync(path.join(FOLDER, 'theme.js'), 'utf8'), restored.ctx); restored.document.DOMContentLoaded();
  const beforeTheme = restored.storage.get(draftKey(restored)); await restored.ids['theme-toggle'].click();
  assert.equal(restored.storage.get('practice-quiz:theme'), 'dark'); assert.equal(restored.storage.get(draftKey(restored)), beforeTheme);
  noDialogs();
  await testHomeIntegration(data);
  console.log(`PASS: GATE 2010 independent 65-question key, ${optionChecks} MCQ choices, source provenance, ${imagePaths.size} PNG crops (${imageCount} displayed parts) and six original-scan restorations, 100-mark blank/perfect and -32 all-wrong scores, both linked pairs/common-data independence, supplied question order, draft/flags/reports/retry/review, failed save/storage, theme isolation and temporary-server scoring. No real attempt written.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
