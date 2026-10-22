const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// Reuse the current simulated browser. Every submission stays in memory or in
// a disposable HTTP fixture; this suite never submits to the real quiz server.
let harnessSource = fs.readFileSync(path.join(__dirname, 'quiz-runtime.test.cjs'), 'utf8');
harnessSource = harnessSource.slice(0, harnessSource.indexOf('\n(async () => {'));
const { load, editResponse, reviewButton, draftKey, attemptUrl, postRequests, assertFlags, assertReviewAvailability } =
  new Function('require', harnessSource + '\nreturn { load, editResponse, reviewButton, draftKey, attemptUrl, postRequests, assertFlags, assertReviewAvailability };')(require);
const FOLDER = path.resolve(__dirname, '../gate-cse-2025-set-1');
const TEMPLATE = path.resolve(__dirname, '../_template');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gate-cse-2025-set-1-key.json'), 'utf8'));
const KEYS = FIXTURE.questions.map(q => ({ ...q, type: q.type.toLowerCase() }));
const plain = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) => assert.deepEqual(plain(actual), expected, message);
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const indexOf = (h, id) => h.data.questions.findIndex(q => q.id === id);
const card = (h, id) => h.document.getElementById(`question-card-${indexOf(h, id)}`);
const map = (h, id) => h.document.getElementById(`nav-question-${indexOf(h, id)}`);
const grade = (h, id) => h.t.grade().find(result => result.question.id === id);
const correct = key => key.type === 'nat' ? String(key.correctRanges[0].min)
  : key.type === 'msq' ? [...key.correctAnswers] : key.correctAnswer;
const wrong = key => key.type === 'nat' ? String(key.correctRanges.at(-1).max + 1)
  : key.type === 'msq' ? ['A', 'B', 'C', 'D'].filter(id => !key.correctAnswers.includes(id))
    : [...'ABCD'].find(id => id !== key.correctAnswer);
const reset = h => { Object.keys(h.t.answers).forEach(id => delete h.t.answers[id]); h.t.setSubmitted(''); };
const allText = node => [node.textContent, ...node.children.map(allText)].join(' ');

// Adjacent representable IEEE-754 values, serialized as ordinary decimal text.
// They prove ranges are inclusive without hidden rounding or epsilon widening.
function adjacent(value, up) {
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  let bits = view.getBigUint64(0); bits += (value > 0) === up ? 1n : -1n;
  view.setBigUint64(0, bits); return view.getFloat64(0);
}

async function serverChecks(data) {
  const os = require('node:os'), http = require('node:http');
  const { createServer } = require('../server.cjs');
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'quiz-2025-set-1-test-'));
  const folder = path.join(temp, path.basename(FOLDER));
  let server;
  try {
    await fs.promises.mkdir(folder);
    for (const file of ['index.html', 'quiz-data.js']) await fs.promises.copyFile(path.join(FOLDER, file), path.join(folder, file));
    await fs.promises.mkdir(path.join(temp, '_template'));
    for (const file of ['styles.css', 'theme.js', 'home.js']) await fs.promises.copyFile(path.join(TEMPLATE, file), path.join(temp, '_template', file));
    server = createServer({ root: temp, port: 0 });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port, origin = `http://127.0.0.1:${port}`;
    const request = (url, attempt) => new Promise((resolve, reject) => {
      const body = attempt && JSON.stringify(attempt);
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method: body ? 'POST' : 'GET',
        headers: body ? { Origin: origin, 'Content-Type': 'application/json' } : {} }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(5000, () => req.destroy(new Error('Disposable-server timeout')));
      req.on('error', reject); req.end(body);
    });
    const homeCard = async () => {
      const res = await request('/'); assert.equal(res.status, 200);
      const found = (res.body.match(/<li\b[\s\S]*?<\/li>/g) || []).find(item => item.includes(`href="/${path.basename(FOLDER)}/"`));
      assert.ok(found, 'Home discovers the new paper'); return found;
    };
    const route = `/${path.basename(FOLDER)}/attempt.json`;
    assert.match(await homeCard(), /data-attempted="false"/);
    assert.equal((await request(route)).status, 404, 'Opening home never creates an attempt');
    const answers = Object.fromEntries(KEYS.map(key => [key.id, correct(key)]));
    const attempt = { version: 1, quizId: data.id, quizTitle: data.title,
      quizSignature: JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }),
      submittedAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      answers, reviewFlags: ['CS-28', 'CS-65'], summary: { score: -999 }, results: [] };
    assert.equal((await request(route, attempt)).status, 200);
    assert.match(await homeCard(), /Last score: 100 \/ 100/);
    assert.match(await homeCard(), /<progress class="paper-score-bar" value="100" max="100"/);
    const saved = JSON.parse((await request(route)).body);
    same(saved.reviewFlags, attempt.reviewFlags, 'HTTP save round-trips review flags');
    assert.ok(!Object.hasOwn(saved, 'timer'), 'Practice timer never enters saved attempt');
    answers['CS-28'] = ['A', 'D'];
    assert.equal((await request(route, attempt)).status, 200);
    assert.match(await homeCard(), /Last score: 99 \/ 100/, 'Single-correct MSQ still requires exact set');
    answers['CS-28'] = ['D']; answers['CS-31'] = String(adjacent(-1.9, true));
    assert.equal((await request(route, attempt)).status, 200);
    assert.match(await homeCard(), /Last score: 99 \/ 100/, 'Server rejects value immediately outside NAT boundary');
    const allWrong = { ...attempt, answers: Object.fromEntries(KEYS.map(key => [key.id, wrong(key)])) };
    assert.equal((await request(route, allWrong)).status, 200);
    assert.match(await homeCard(), /Last score: -15 \/ 100/);
    assert.match(await homeCard(), /<progress class="paper-score-bar" value="0" max="100"/);
    const stale = { ...attempt, quizSignature: 'stale signature' };
    assert.equal((await request(route, stale)).status, 200);
    assert.match(await homeCard(), /data-attempted="true"/);
    assert.match(await homeCard(), /Last score unavailable/);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    const relative = path.relative(os.tmpdir(), temp);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temp).startsWith('quiz-2025-set-1-test-'));
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
}

(async () => {
  const attemptPath = path.join(FOLDER, 'attempt.json');
  const attemptBefore = fs.existsSync(attemptPath) ? sha256(attemptPath) : null;
  const h = await load(FOLDER), { data, t, ids } = h;
  t.validate(); assert.equal(data.id, 'gate-cse-2025-set-1-session-1');
  assert.match(data.title, /GATE.*2025.*Set 1/i);
  assert.equal(data.questions.length, 65); assert.equal(FIXTURE.questionCount, 65);
  same(data.questions.map(q => q.id), KEYS.map(key => key.id), 'Independent original numbering/order');
  same(data.questions.reduce((counts, q) => ({ ...counts, [q.type]: (counts[q.type] || 0) + 1 }), {}), { mcq: 30, msq: 13, nat: 22 });
  assert.equal(data.questions.reduce((sum, q) => sum + q.marks, 0), 100);
  for (const name of ['quiz.js', 'styles.css', 'theme.js']) assert.equal(sha256(path.join(FOLDER, name)), sha256(path.join(TEMPLATE, name)), `${name} matches shared runtime`);
  same(data.sourceSha256, FIXTURE.sourceSha256, 'Independent original source hashes');
  same(data.sourceDocuments.map(document => [document.filename, document.sha256, document.pages]), [
    ['2025-Set1.pdf', FIXTURE.sourceSha256['2025-Set1.pdf'], 64],
    ['GATE-CS-2025-Set-1-Answer-Key.pdf', FIXTURE.sourceSha256['GATE-CS-2025-Set-1-Answer-Key.pdf'], 2]
  ], 'Both source documents identify the verified page counts');
  assert.equal(data.markingSource, FIXTURE.scoringSource);
  assert.equal(data.answerRulesSource, FIXTURE.answerRulesSource);
  assert.equal(data.cropProvenance.dpi, 240);
  same(data.cropProvenance.pageSize, [595.32, 841.92], 'Independently read paper page dimensions');
  assert.equal(data.questionPaper, '2025-Set1.pdf');
  assert.equal(data.answerKey, 'GATE-CS-2025-Set-1-Answer-Key.pdf');
  assert.ok(!fs.readdirSync(FOLDER).some(name => /\.pdf$/i.test(name)), 'Original PDFs are not copied into quiz');
  for (const [name, hash] of Object.entries(FIXTURE.sourceSha256)) {
    const original = path.join('/Users/icode100/Downloads', name);
    if (fs.existsSync(original)) assert.equal(sha256(original), hash, `Original ${name} remains unchanged`);
  }
  const html = fs.readFileSync(path.join(FOLDER, 'index.html'), 'utf8');
  assert.match(html, /href="\/"[^>]*>Home<\/a>/);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (match[1] === '/') continue;
    assert.ok(!path.isAbsolute(match[1]) && !/^[a-z]+:/i.test(match[1]) && !match[1].includes('..'), 'Local relative HTML resource');
    assert.ok(fs.existsSync(path.join(FOLDER, match[1])), `Resource ${match[1]} exists`);
  }

  let imageCount = 0; const imagePaths = new Set();
  for (let i = 0; i < KEYS.length; i++) {
    const q = data.questions[i], key = KEYS[i];
    for (const name of ['id', 'type', 'section', 'number', 'marks', 'incorrectMarks', 'answerKeyPage']) assert.equal(q[name], key[name], `${key.id} independent ${name}`);
    assert.equal(q.displayLabel, `${key.section} ${key.number}`); assert.equal(q.text, '');
    assert.ok(!q.marksToAll && !q.requiresCorrect && !q.acceptedAnswers, `${q.id} no unverified exception`);
    same(q.sourcePages, key.sourcePages, `${q.id} independently verified paper pages`);
    if (key.type === 'nat') same(q.correctRanges, key.correctRanges, `${q.id} inclusive NAT range`);
    else {
      same(q.options.map(option => option.id), ['A', 'B', 'C', 'D']);
      if (key.type === 'msq') same(q.correctAnswers, key.correctAnswers, `${q.id} exact MSQ set`);
      else assert.equal(q.correctAnswer, key.correctAnswer, `${q.id} MCQ key`);
    }
    assert.equal(q.sourceRectangles.length, q.images.length);
    same([...new Set(q.images.map(image => image.page))], key.sourcePages);
    for (const [part, image] of q.images.entries()) {
      const crop = q.sourceRectangles[part];
      assert.ok(image.src.startsWith('assets/') && !image.src.includes('..') && !path.isAbsolute(image.src));
      assert.ok(!imagePaths.has(image.src), `${q.id} unique original crop`); imagePaths.add(image.src);
      assert.ok(image.alt && image.page >= 1 && image.page <= 64); assert.equal(crop.page, image.page);
      assert.equal(crop.rect.length, 4); assert.ok(crop.rect.every(Number.isFinite));
      const [x0, y0, x1, y1] = crop.rect;
      assert.ok(x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0 && x1 <= 595.32 && y1 <= 841.92, `${q.id} crop inside verified 595.32×841.92 pt page`);
      const filename = path.join(FOLDER, image.src), bytes = fs.readFileSync(filename);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.ok(bytes.readUInt32BE(16) > 100 && bytes.readUInt32BE(20) > 35);
      same(crop.renderSize, [1985, 2807], `${q.id} original 240 DPI rendered dimensions`);
      const [renderWidth, renderHeight] = crop.renderSize;
      const expectedPixels = [Math.floor(x0 * renderWidth / 595.32), Math.floor(y0 * renderHeight / 841.92),
        Math.ceil(x1 * renderWidth / 595.32), Math.ceil(y1 * renderHeight / 841.92)];
      same(crop.pixelRect, expectedPixels, `${q.id} floor/ceil mapping uses actual rendered dimensions`);
      assert.equal(bytes.readUInt32BE(16), crop.pixelRect[2] - crop.pixelRect[0], `${q.id} unchanged crop width`);
      assert.equal(bytes.readUInt32BE(20), crop.pixelRect[3] - crop.pixelRect[1], `${q.id} unchanged crop height`);
      const assetHash = crop.sha256 || image.sha256;
      if (assetHash) assert.equal(sha256(filename), assetHash, `${q.id} recorded asset hash`);
      imageCount++;
    }
  }
  assert.equal(imageCount, 66, '65 questions include the two-part Q11');
  assert.equal(fs.readdirSync(path.join(FOLDER, 'assets')).filter(name => /\.png$/i.test(name)).length, 66, 'No orphan crops');
  assert.equal(ids.questions.querySelectorAll('fieldset').length, 65);
  assert.equal(ids.questions.querySelectorAll('img').length, 66);
  assert.equal(ids.questions.querySelectorAll('input[type="radio"]').length, 120);
  assert.equal(ids.questions.querySelectorAll('input[type="checkbox"]').length, 52);
  assert.equal(ids['nav-groups'].querySelectorAll('.nav-question').length, 65);
  assert.equal(ids['nav-progress'].textContent, '0 attempted · 65 not attempted');
  assertReviewAvailability(h, false); assert.equal(postRequests(h).length, 0);

  let summary = t.summarize(t.grade());
  assert.equal(summary.score, 0); assert.equal(summary.maximum, 100); assert.equal(summary.counts.unanswered, 65);
  KEYS.forEach(key => { t.answers[key.id] = correct(key); });
  summary = t.summarize(t.grade()); assert.equal(summary.score, 100); assert.equal(summary.counts.correct, 65);
  KEYS.forEach(key => { t.answers[key.id] = wrong(key); });
  summary = t.summarize(t.grade()); close(summary.score, -15, 'All-wrong score'); assert.equal(summary.counts.incorrect, 65);
  reset(h); let mixedScore = 0; const mixedCounts = { correct: 0, incorrect: 0, unanswered: 0, awarded: 0 };
  KEYS.forEach((key, i) => {
    if (i % 3 === 0) { t.answers[key.id] = correct(key); mixedScore += key.marks; mixedCounts.correct++; }
    else if (i % 3 === 1) { t.answers[key.id] = wrong(key); mixedScore += key.incorrectMarks; mixedCounts.incorrect++; }
    else mixedCounts.unanswered++;
  });
  summary = t.summarize(t.grade()); close(summary.score, mixedScore, 'Mixed score'); same(summary.counts, mixedCounts);
  let choices = 0, subsets = 0, boundaries = 0, strictOutside = 0;
  for (const key of KEYS) {
    if (key.type === 'mcq') for (const answer of 'ABCD') {
      t.answers[key.id] = answer; const result = grade(h, key.id), isCorrect = answer === key.correctAnswer;
      assert.equal(result.outcome, isCorrect ? 'correct' : 'incorrect', `${key.id} choice ${answer}`);
      assert.equal(result.earned, isCorrect ? key.marks : key.incorrectMarks); choices++;
    } else if (key.type === 'msq') for (let bits = 0; bits < 16; bits++) {
      const answer = [...'ABCD'].filter((_, index) => bits & (1 << index));
      if (answer.length) t.answers[key.id] = answer.reverse(); else delete t.answers[key.id];
      const result = grade(h, key.id), isCorrect = answer.length === key.correctAnswers.length && answer.every(id => key.correctAnswers.includes(id));
      assert.equal(result.outcome, !answer.length ? 'unanswered' : isCorrect ? 'correct' : 'incorrect', `${key.id} subset ${bits}`);
      assert.equal(result.earned, isCorrect ? key.marks : 0); subsets++;
    } else for (const range of key.correctRanges) {
      for (const value of [range.min, range.max, range.min - 0.0001, range.max + 0.0001]) {
        t.answers[key.id] = String(value); const result = grade(h, key.id);
        const isCorrect = key.correctRanges.some(r => value >= r.min && value <= r.max);
        assert.equal(result.outcome, isCorrect ? 'correct' : 'incorrect', `${key.id} NAT endpoint/outside ${value}`);
        assert.equal(result.earned, isCorrect ? key.marks : 0); boundaries++;
      }
      for (const value of [adjacent(range.min, false), adjacent(range.max, true)]) {
        const raw = String(value); assert.ok(!/[eE]/.test(raw), 'Strict boundary is representable in ordinary decimal syntax');
        t.answers[key.id] = raw; assert.equal(grade(h, key.id).outcome, 'incorrect', `${key.id} strictly outside ${raw}`); strictOutside++;
      }
    }
  }
  assert.equal(choices, 120); assert.equal(subsets, 208); assert.equal(boundaries, 88); assert.equal(strictOutside, 44);

  // A raw unfinished NAT and independent flags survive reload and invalid Submit.
  reset(h); t.renderQuestions();
  const mcq = KEYS[0], msq = KEYS.find(key => key.type === 'msq'), nat = KEYS.find(key => key.type === 'nat');
  await editResponse(h, mcq.id, correct(mcq)); await editResponse(h, msq.id, correct(msq)); await editResponse(h, nat.id, '-');
  await reviewButton(h, mcq.id).click(); await reviewButton(h, nat.id).click(); await reviewButton(h, 'GA-2').click();
  assertFlags(h, [mcq.id, nat.id, 'GA-2']); assertReviewAvailability(h, false);
  const cached = JSON.parse(h.storage.get(draftKey(h)));
  assert.equal(cached.answers[nat.id], '-'); same(cached.answers[msq.id], correct(msq));
  assert.equal(cached.signature, JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }));
  const restored = await load(FOLDER, { storage: h.storage });
  same(restored.t.answers, cached.answers); assertFlags(restored, [mcq.id, nat.id, 'GA-2']);
  assert.equal(card(restored, nat.id).querySelector('input').value, '-');
  assert.ok(map(restored, nat.id).className.includes('needs-check'));
  const beforeInvalid = restored.storage.get(draftKey(restored));
  await restored.ids['quiz-form'].fire('submit');
  assert.ok(restored.ids.report.hidden && !card(restored, nat.id).hidden);
  assert.ok(card(restored, nat.id).querySelector('input').focused);
  assert.equal(restored.storage.get(draftKey(restored)), beforeInvalid); assert.equal(postRequests(restored).length, 0);
  await editResponse(restored, nat.id, correct(nat)); await restored.ids['quiz-form'].fire('submit');
  assert.ok(!restored.ids.report.hidden && restored.ids['quiz-form'].hidden);
  assert.ok(!restored.storage.has(draftKey(restored))); assertFlags(restored, []);
  assertReviewAvailability(restored, true); assert.equal(postRequests(restored).length, 1);
  const submission = restored.server.get(attemptUrl(restored)), savedBytes = JSON.stringify(submission);
  assert.equal(submission.version, 1); assert.equal(submission.answers[nat.id], correct(nat));
  same(submission.answers[msq.id], correct(msq)); same([...submission.reviewFlags].sort(), [mcq.id, nat.id, 'GA-2'].sort());
  assert.equal(submission.summary.score, mcq.marks + msq.marks + nat.marks);
  assert.equal(submission.results.length, 65); assert.ok(!Object.hasOwn(submission, 'timer'));
  assert.equal(restored.ids['report-list'].querySelectorAll('.result-card').length, 65);
  assert.equal(restored.ids['report-list'].querySelectorAll('img').length, 66);
  for (let index = 0; index < 65; index++) {
    const text = allText(restored.document.getElementById(`result-card-${index}`));
    assert.ok(text.includes('Your answer:') && text.includes('Correct answer:') && text.includes('marks'), `${KEYS[index].id} complete report`);
  }
  await restored.ids['retry-quiz'].click();
  assert.equal(Object.keys(restored.t.answers).length, 0); assertFlags(restored, []);
  assert.equal(JSON.stringify(restored.server.get(attemptUrl(restored))), savedBytes, 'Retry preserves saved file');
  assert.equal(postRequests(restored).length, 1);

  // Review validates and regrades saved answers, leaving the active draft intact.
  const tampered = JSON.parse(savedBytes); tampered.summary.score = -999; tampered.results = [];
  const reviewing = await load(FOLDER, { server: [[attemptUrl(h), tampered]] });
  await editResponse(reviewing, nat.id, '-'); await reviewButton(reviewing, nat.id).click();
  const draftBeforeReview = reviewing.storage.get(draftKey(reviewing));
  await reviewing.ids['review-attempt'].click();
  assert.equal(reviewing.ids['retry-quiz'].textContent, 'Back to quiz');
  assert.equal(reviewing.t.summarize(reviewing.t.grade()).score, submission.summary.score);
  assert.equal(reviewing.storage.get(draftKey(reviewing)), draftBeforeReview);
  await reviewing.ids['retry-quiz'].click();
  assert.equal(reviewing.t.answers[nat.id], '-'); assertFlags(reviewing, [nat.id]);
  assert.equal(reviewing.storage.get(draftKey(reviewing)), draftBeforeReview); assert.equal(postRequests(reviewing).length, 0);
  await card(reviewing, nat.id).querySelector('.clear-response').click(); assertFlags(reviewing, [nat.id]);
  await reviewing.ids['clear-answers'].click(); assertFlags(reviewing, []);
  assert.equal(JSON.stringify(reviewing.server.get(attemptUrl(reviewing))), JSON.stringify(tampered));

  const failed = await load(FOLDER, { fetch: (request, perform, response) => request.method === 'POST' ? response(500, { error: 'Test save failure' }) : perform() });
  await editResponse(failed, msq.id, correct(msq)); await reviewButton(failed, msq.id).click();
  const failedDraft = JSON.parse(failed.storage.get(draftKey(failed)));
  await failed.ids['quiz-form'].fire('submit');
  assert.ok(!failed.ids.report.hidden); assertFlags(failed, [msq.id]); assertReviewAvailability(failed, false);
  const afterFailure = JSON.parse(failed.storage.get(draftKey(failed)));
  same(afterFailure.answers, failedDraft.answers); same(afterFailure.reviewFlags, failedDraft.reviewFlags);
  assert.match(failed.ids['status-message'].textContent, /restart|reload|could not|failed/i);
  const reopened = await load(FOLDER, { storage: failed.storage }); same(reopened.t.answers, failedDraft.answers); assertFlags(reopened, [msq.id]);
  const legacy = { ...cached }; delete legacy.reviewFlags;
  const oldDraft = await load(FOLDER, { storage: [[draftKey(h), JSON.stringify(legacy)]] }); same(oldDraft.t.answers, cached.answers); assertFlags(oldDraft, []);
  for (const badFlags of [null, ['GA-1', 'GA-1'], ['CS-999'], [1]]) {
    const bad = await load(FOLDER, { storage: [[draftKey(h), JSON.stringify({ ...cached, reviewFlags: badFlags })]] });
    assert.equal(Object.keys(bad.t.answers).length, 0); assertFlags(bad, []);
  }
  const unavailable = await load(FOLDER, { storageUnavailable: true });
  await editResponse(unavailable, mcq.id, correct(mcq)); await unavailable.ids['quiz-form'].fire('submit');
  assert.ok(!unavailable.ids.report.hidden); await unavailable.ids['retry-quiz'].click();
  assert.equal(Object.keys(unavailable.t.answers).length, 0);
  assert.match(unavailable.ids['status-message'].textContent, /Could not cache/);

  await serverChecks(data);
  assert.equal(fs.existsSync(attemptPath) ? sha256(attemptPath) : null, attemptBefore, 'Real saved attempt is never created or changed');
  console.log(`PASS: 2025 Set 1 independent 65-entry key; 100 marks; ${choices} MCQ choices, ${subsets} MSQ subsets, ${boundaries} NAT boundary checks and ${strictOutside} immediately outside values; ${imageCount} original PNGs/provenance/local resources/shared runtime; blank/perfect/wrong/mixed grading; raw drafts/flags/invalid Submit/save failures/Review/Back/Retry/storage failure; disposable HTTP scores and flags. No real attempt modified.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
