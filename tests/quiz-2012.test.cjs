const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { load, editResponse, draftKey, attemptUrl, rejectFileDialogs, assertEditable } = require('./helpers/quiz-harness.cjs');

// The independent fixture is transcribed from the supplied Code A key, not
// generated from quiz-data.js. Attempts exist only in memory or temporary files.
const FOLDER = path.resolve(__dirname, '../gate-cse-2012');
const TEMPLATE = path.resolve(__dirname, '../_template');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gate-cse-2012-key.json'), 'utf8'));
const KEY = FIXTURE.questions;
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const index = (h, id) => h.data.questions.findIndex(q => q.id === id);
const card = (h, id) => h.document.getElementById(`question-card-${index(h, id)}`);
const nav = (h, id) => h.document.getElementById(`nav-question-${index(h, id)}`);
const flag = (h, id) => h.document.getElementById(`mark-review-${index(h, id)}`);
const correct = row => row.marksToAll ? 'A' : row.correctAnswer;
const wrong = row => [...'ABCD'].find(option => option !== row.correctAnswer);
const textOf = node => [node.textContent, ...node.children.map(textOf)].join(' ');
const posts = h => h.requests.filter(request => request.method === 'POST');
function reset(h) { Object.keys(h.t.answers).forEach(id => delete h.t.answers[id]); h.t.setSubmitted(''); }
function active(h, expected) {
  same(h.ids.questions.querySelectorAll('fieldset').filter(node => !node.hidden).map(node => node.id), [`question-card-${expected}`], 'One practice question is visible');
  same(h.ids['nav-groups'].querySelectorAll('.nav-question').filter(node => node.attrs['aria-current'] === 'location').map(node => node.id), [`nav-question-${expected}`], 'Exactly one map number identifies the current question');
}
async function mark(h, id) {
  const actions = card(h, id).querySelector('.question-actions');
  assert(actions.children.includes(flag(h, id)) && actions.querySelector('.clear-response'), 'Review toggle remains beside Clear response');
  await flag(h, id).click();
}
function flagged(h, id, value) {
  assert.equal(flag(h, id).attrs['aria-pressed'], String(value));
  assert.equal(nav(h, id).className.split(' ').includes('marked-review'), value);
}
function expected(answers) {
  let score = 0;
  const outcomes = new Map(), counts = { correct: 0, incorrect: 0, unanswered: 0, awarded: 0 };
  for (const q of KEY) {
    const response = answers[q.id];
    let outcome, earned = 0;
    if (q.marksToAll) { outcome = 'awarded'; earned = q.marks; }
    else if (response === undefined || response === null) outcome = 'unanswered';
    else if (q.requiresCorrect && outcomes.get(q.requiresCorrect) !== 'correct') outcome = 'blocked';
    else if (response === q.correctAnswer) { outcome = 'correct'; earned = q.marks; }
    else { outcome = 'incorrect'; earned = q.incorrectMarks; }
    counts[outcome] = (counts[outcome] || 0) + 1; score += earned; outcomes.set(q.id, outcome);
  }
  return { score, counts, outcomes };
}
function checkGrade(h, answers, message) {
  reset(h); Object.assign(h.t.answers, Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== null && value !== undefined)));
  const rows = h.t.grade(), summary = h.t.summarize(rows), wanted = expected(answers);
  close(summary.score, wanted.score, message); assert.equal(summary.maximum, 100); same(summary.counts, wanted.counts, message);
  for (const row of rows) assert.equal(row.outcome, wanted.outcomes.get(row.question.id), `${message}: ${row.question.id}`);
  return summary;
}

async function homeIntegration(data) {
  const fsp = fs.promises, os = require('node:os'), http = require('node:http');
  const { createServer } = require('../server.cjs');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-2012-test-'));
  const folder = path.join(root, 'gate-cse-2012'), server = createServer({ root, port: 0 });
  let listening = false;
  try {
    await fsp.mkdir(folder);
    for (const name of ['index.html', 'quiz-data.js']) await fsp.copyFile(path.join(FOLDER, name), path.join(folder, name));
    await fsp.mkdir(path.join(root, '_template'));
    for (const name of ['styles.css', 'theme.js', 'home.js']) await fsp.copyFile(path.join(TEMPLATE, name), path.join(root, '_template', name));
    for (const year of [2009, 2014]) {
      const other = path.join(root, `gate-cse-${year}`); await fsp.mkdir(other);
      await fsp.writeFile(path.join(other, 'index.html'), `<title>GATE CSE ${year}</title>`);
      await fsp.writeFile(path.join(other, 'quiz-data.js'), `window.QUIZ_DATA = ${JSON.stringify({ ...data, id: `gate-cse-${year}`, title: `GATE CSE ${year}` })};`);
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); listening = true;
    const port = server.address().port, origin = `http://127.0.0.1:${port}`;
    const request = (url, attempt) => new Promise((resolve, reject) => {
      const body = attempt && JSON.stringify(attempt);
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', Origin: origin } : {} }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(4000, () => req.destroy(Error('Temporary 2012 server timed out'))); req.on('error', reject); req.end(body);
    });
    const home = await request('/'); assert.equal(home.status, 200);
    const paperOrder = [...home.body.matchAll(/href="\/(gate-cse-\d+)\/"/g)].map(match => match[1]);
    same(paperOrder, ['gate-cse-2014', 'gate-cse-2012', 'gate-cse-2009'], 'New quiz automatically joins descending year order');
    const readCard = async () => {
      const result = await request('/'); assert.equal(result.status, 200);
      const item = (result.body.match(/<li\b[\s\S]*?<\/li>/g) || []).find(row => row.includes('href="/gate-cse-2012/"'));
      assert(item, 'Home lists 2012'); return item;
    };
    assert.match(await readCard(), /data-attempted="false"/);
    assert.equal((await request('/gate-cse-2012/attempt.json')).status, 404, 'Listing never initializes an attempt');
    const record = answers => ({ version: 1, quizId: data.id, quizTitle: data.title,
      quizSignature: JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }),
      submittedAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
      answers: Object.fromEntries(KEY.map(row => [row.id, answers[row.id] ?? null])), summary: { score: 9999 }, results: [], reviewFlags: ['CS-3', 'CS-53'] });
    const route = '/gate-cse-2012/attempt.json';
    const perfect = Object.fromEntries(KEY.map(row => [row.id, correct(row)]));
    assert.equal((await request(route, record(perfect))).status, 200);
    let item = await readCard(); assert.match(item, /Last score: 100 \/ 100/); assert.match(item, /<progress class="paper-score-bar" value="100" max="100"/); assert(!item.includes('9999'));
    const blank = record({}); assert.equal((await request(route, blank)).status, 200);
    item = await readCard(); assert.match(item, /data-attempted="false"/); assert(!item.includes('Last score: 10'), 'A blank award-only submission remains unsolved');
    const mixed = { 'CS-52': wrong(KEY.find(row => row.id === 'CS-52')), 'CS-53': correct(KEY.find(row => row.id === 'CS-53')), 'CS-54': correct(KEY.find(row => row.id === 'CS-54')), 'CS-55': correct(KEY.find(row => row.id === 'CS-55')) };
    assert.equal((await request(route, record(mixed))).status, 200);
    const label = Number(expected(mixed).score.toFixed(4)); assert((await readCard()).includes(`Last score: ${label} / 100`), 'Server applies actual MTA and linked dependencies');
    const allWrong = Object.fromEntries(KEY.map(row => [row.id, wrong(row)]));
    assert.equal((await request(route, record(allWrong))).status, 200);
    item = await readCard(); assert(item.includes(`Last score: ${Number((-56 / 3).toFixed(4))} / 100`));
    assert.match(item, /<progress class="paper-score-bar" value="0" max="100"/, 'Only the progress bar clamps negative scores');
    const malformed = record({ 'CS-53': 'unknown' }); assert.equal((await request(route, malformed)).status, 200);
    assert.match(await readCard(), /Last score unavailable/, 'Even blocked responses require validation');
    assert.equal((await request(route, { ...record(perfect), quizSignature: 'stale' })).status, 200);
    item = await readCard(); assert.match(item, /data-attempted="true"/); assert.match(item, /Last score unavailable/); assert.match(item, /class="paper-score-bar" hidden/);
  } finally {
    if (listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('quiz-2012-test-'));
    await fsp.rm(root, { recursive: true, force: true });
  }
}

(async () => {
  const h = await load(FOLDER), { data, t, ids } = h, noDialogs = rejectFileDialogs(h);
  h.ctx.setInterval = () => 1; h.ctx.clearInterval = () => {};
  assert.equal(data.id, 'gate-cse-2012'); assert.match(data.title, /GATE CSE 2012/);
  assert.equal(KEY.length, 65); assert.equal(data.questions.length, FIXTURE.questionCount); assert.equal(FIXTURE.totalMarks, 100);
  same(FIXTURE.typeCounts, { MCQ: 65 });
  same(data.questions.map(q => q.id), [...Array.from({ length: 55 }, (_, i) => `CS-${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `GA-${i + 56}`)], 'Original CS then GA paper order');
  assert.equal(new Set(data.questions.map(q => q.id)).size, 65); assert.equal(data.questions.reduce((sum, q) => sum + q.marks, 0), 100);
  t.validate(); assertEditable(h);
  for (const name of ['quiz.js', 'theme.js', 'styles.css']) assert.equal(sha256(path.join(FOLDER, name)), sha256(path.join(TEMPLATE, name)), `${name} inherits current shared runtime`);
  same(data.sourceSha256, FIXTURE.sourceSha256, 'Original source hashes agree with independently read key fixture');
  same(data.sourcePageCounts, { questionPaper: FIXTURE.paperPageCount, answerKey: FIXTURE.keyPageCount });
  assert.equal(data.questionPaper, 'GATE2012.pdf'); assert.equal(data.answerKey, 'Key_CS_2012.pdf'); assert.equal(data.cropDpi, 240);
  assert(!fs.readdirSync(FOLDER).some(name => /\.pdf$/i.test(name)), 'Supplied originals remain external');
  for (const hash of Object.values(data.sourceSha256)) assert.match(hash, /^[a-f0-9]{64}$/);
  let images = 0; const imagePaths = new Set();
  for (let i = 0; i < KEY.length; i++) {
    const q = data.questions[i], key = KEY[i];
    for (const field of ['id', 'section', 'number', 'marks', 'incorrectMarks', 'answerKeyPage']) assert.equal(q[field], key[field], `${q.id} independently verified ${field}`);
    assert.equal(q.type, 'mcq'); assert.equal(q.displayLabel, `${q.section} ${q.number}`); assert.equal(q.text, '');
    assert.equal(Boolean(q.marksToAll), Boolean(key.marksToAll), `${q.id} official award`);
    assert.equal(q.requiresCorrect, key.requiresCorrect, `${q.id} linked prerequisite`);
    assert.equal(q.incorrectMarks, q.marksToAll || q.requiresCorrect ? 0 : -q.marks / 3, `${q.id} full-precision penalty`);
    if (!key.marksToAll) assert.equal(q.correctAnswer, key.correctAnswer, `${q.id} Code A accepted option`);
    assert(!q.acceptedAnswers, `${q.id} no unsupported alternative keys`);
    same(q.options.map(option => option.id), ['A', 'B', 'C', 'D'], `${q.id} original option order`);
    same(q.sourcePages, key.sourcePages, `${q.id} independently checked physical source pages`);
    same(q.sourcePages, [...new Set(q.images.map(image => image.page))]);
    assert(q.images.length > 0); assert.equal(q.images.length, q.sourceRectangles.length);
    for (let part = 0; part < q.images.length; part++) {
      const image = q.images[part], rectangle = q.sourceRectangles[part];
      assert(!path.isAbsolute(image.src) && !image.src.includes('..') && !/^[a-z]+:/i.test(image.src));
      assert(image.src.startsWith('assets/') && image.alt, `${q.id} accessible local crop`);
      assert(Number.isInteger(image.page) && image.page >= 1 && image.page <= FIXTURE.paperPageCount);
      assert.equal(rectangle.page, image.page); assert.equal(rectangle.rect.length, 4); assert(rectangle.rect.every(Number.isFinite));
      const [x0, y0, x1, y1] = rectangle.rect; assert(x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0);
      const pageSize = data.sourcePageSizes.find(page => page.page === image.page); assert(pageSize, `${q.id} original page dimensions`);
      assert(x1 <= pageSize.width && y1 <= pageSize.height, `${q.id} crop remains within original page`);
      const bytes = fs.readFileSync(path.join(FOLDER, image.src)); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert(bytes.readUInt32BE(16) > 100 && bytes.readUInt32BE(20) > 35, `${q.id} legible nonempty PNG`);
      const sx = Math.ceil(pageSize.width * data.cropDpi / 72) / pageSize.width, sy = Math.ceil(pageSize.height * data.cropDpi / 72) / pageSize.height;
      assert.equal(bytes.readUInt32BE(16), Math.ceil(x1 * sx) - Math.floor(x0 * sx), `${q.id} unstretched crop width`);
      assert.equal(bytes.readUInt32BE(20), Math.ceil(y1 * sy) - Math.floor(y0 * sy), `${q.id} unstretched crop height`);
      imagePaths.add(image.src); images++;
    }
  }
  assert.equal(fs.readdirSync(path.join(FOLDER, 'assets')).filter(name => /\.png$/i.test(name)).length, imagePaths.size, 'No orphaned question crops');
  assert.equal(imagePaths.size, 69, '65 question crops plus four shared statements'); assert.equal(images, 73, 'Shared statements appear in both questions of each pair');
  same(data.questions.filter(q => q.marksToAll).map(q => q.id), ['CS-3', 'CS-29', 'CS-38', 'CS-39', 'CS-45', 'GA-60']);
  const html = fs.readFileSync(path.join(FOLDER, 'index.html'), 'utf8');
  assert.match(html, /<a\b[^>]*id="quiz-home"[^>]*href="\/"/);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) if (match[1] !== '/') {
    assert(!path.isAbsolute(match[1]) && !/^[a-z]+:/i.test(match[1])); assert(fs.existsSync(path.join(FOLDER, match[1])), `${match[1]} exists locally`);
  }
  assert(ids['review-attempt'].disabled); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, 'GET'); assert.equal(h.requests[0].cache, 'no-store');
  assert.equal(ids.questions.querySelectorAll('img').length, images); assert.equal(ids['nav-groups'].querySelectorAll('.nav-question').length, 65);
  same(ids['nav-groups'].querySelectorAll('h3').map(node => node.textContent), ['CS', 'GA']);
  active(h, 0); assert.equal(ids['nav-progress'].textContent, '0 attempted · 65 not attempted');

  assert.equal(checkGrade(h, {}, 'Blank paper').score, 10);
  const perfect = Object.fromEntries(KEY.map(row => [row.id, correct(row)]));
  const perfectSummary = checkGrade(h, perfect, 'Perfect paper'); assert.equal(perfectSummary.score, 100); assert.equal(perfectSummary.counts.correct, 59); assert.equal(perfectSummary.counts.awarded, 6);
  const allWrong = Object.fromEntries(KEY.map(row => [row.id, wrong(row)])); close(checkGrade(h, allWrong, 'All wrong').score, -56 / 3, 'Official award and linked penalties');
  const mixed = Object.fromEntries(KEY.filter((row, i) => i % 3 !== 2).map(row => [row.id, KEY.indexOf(row) % 3 === 0 ? correct(row) : wrong(row)])); checkGrade(h, mixed, 'Mixed paper');
  let optionChecks = 0, linkedChecks = 0;
  for (const row of KEY) for (const option of 'ABCD') {
    reset(h); if (row.requiresCorrect) t.answers[row.requiresCorrect] = KEY.find(q => q.id === row.requiresCorrect).correctAnswer;
    t.answers[row.id] = option;
    const graded = t.grade().find(result => result.question.id === row.id);
    assert.equal(graded.outcome, row.marksToAll ? 'awarded' : option === row.correctAnswer ? 'correct' : 'incorrect', `${row.id} option ${option}`);
    assert.equal(graded.earned, row.marksToAll || option === row.correctAnswer ? row.marks : row.incorrectMarks); optionChecks++;
  }
  for (const dependent of KEY.filter(q => q.requiresCorrect)) {
    const first = KEY.find(q => q.id === dependent.requiresCorrect);
    for (const firstState of [null, correct(first), wrong(first)]) for (const secondState of [null, correct(dependent), wrong(dependent)]) {
      const answers = { [first.id]: firstState, [dependent.id]: secondState };
      checkGrade(h, answers, `${first.id}/${dependent.id}: ${firstState}/${secondState}`);
      const row = t.grade().find(result => result.question.id === dependent.id);
      if (row.outcome === 'blocked') assert.match(row.reason, /incorrect or unanswered/);
      linkedChecks++;
    }
  }
  assert.equal(optionChecks, 260); assert.equal(linkedChecks, 18);

  // Carousel navigation saves first; neither navigation nor Home submits.
  reset(h); t.renderQuestions(); active(h, 0);
  await editResponse(h, 'CS-1', correct(KEY[0])); active(h, 1);
  assert.equal(JSON.parse(h.storage.get(draftKey(h))).answers['CS-1'], correct(KEY[0]));
  const beforeNavigation = h.storage.get(draftKey(h));
  await ids['previous-question'].click(); active(h, 0); assert(ids['previous-question'].disabled);
  await nav(h, 'GA-65').click(); active(h, 64); assert(ids['next-question'].disabled);
  await ids.questions.fire('keydown', { key: 'Enter', target: card(h, 'GA-65').querySelector('input') }); assert.equal(posts(h).length, 0); active(h, 64);
  assert.equal(h.storage.get(draftKey(h)), beforeNavigation, 'Navigation preserves the draft byte for byte');
  await mark(h, 'CS-1'); await mark(h, 'CS-3'); flagged(h, 'CS-1', true); flagged(h, 'CS-3', true);
  assert.equal(ids['nav-progress'].textContent, '1 attempted · 64 not attempted', 'Flags and official awards do not count as practice responses');
  await nav(h, 'CS-1').click(); await card(h, 'CS-1').querySelector('.clear-response').click(); flagged(h, 'CS-1', true);
  await editResponse(h, 'CS-1', correct(KEY[0]));
  ids['timer-duration'].value = '30'; await ids['timer-duration'].fire('change');
  await ids['timer-start'].click(); assert.equal(ids['timer-start'].disabled, true); await ids['timer-pause'].click();
  const cached = JSON.parse(h.storage.get(draftKey(h))); assert.equal(cached.timer.durationMinutes, 30); assert.equal(cached.timer.endsAt, null);
  assert(!Object.keys(cached).some(key => /question.*index|slide/i.test(key)), 'Slide navigation is not persisted');
  const restored = await load(FOLDER, { storage: h.storage }); active(restored, 0); flagged(restored, 'CS-1', true); flagged(restored, 'CS-3', true);
  restored.ctx.setInterval = () => 1; restored.ctx.clearInterval = () => {};
  assert.equal(restored.t.answers['CS-1'], correct(KEY[0])); assert.equal(restored.ids['timer-duration'].value, '30');
  assert(restored.ids['review-attempt'].disabled, 'A restored draft never enables saved Review');
  await restored.ids['timer-start'].click(); await restored.ids['quiz-form'].fire('submit');
  assert.equal(restored.ids['timer-display'].textContent, '00:30:00'); assert(restored.ids['quiz-timer'].hidden);
  assert(!restored.storage.has(draftKey(restored))); assert.equal(posts(restored).length, 1); assert(!restored.ids.report.hidden);
  const saved = restored.server.get(attemptUrl(restored)); assert.equal(saved.summary.score, 11); assert.equal(saved.results.length, 65);
  same(saved.reviewFlags, ['CS-1', 'CS-3']); assert(!Object.hasOwn(saved, 'timer')); assert(!Object.hasOwn(saved.answers, 'reviewFlags'));
  assert.equal(restored.ids['report-list'].querySelectorAll('.result-card').length, 65); assert.equal(restored.ids['report-list'].querySelectorAll('img').length, images);
  for (let i = 0; i < KEY.length; i++) {
    const text = textOf(restored.document.getElementById(`result-card-${i}`));
    assert(text.includes('Your answer:') && text.includes('Correct answer:') && text.includes('marks'), `${KEY[i].id} complete report`);
  }
  assert(nav(restored, 'CS-3').className.includes('result-awarded')); assert.equal(nav(restored, 'CS-3').querySelector('.nav-state-icon').textContent, '★');
  const beforeRetry = JSON.stringify(saved); await restored.ids['retry-quiz'].click(); active(restored, 0); assertEditable(restored);
  assert.equal(posts(restored).length, 1); assert.equal(JSON.stringify(restored.server.get(attemptUrl(restored))), beforeRetry); flagged(restored, 'CS-1', false);
  const reopened = await load(FOLDER, { storage: restored.storage, server: restored.server }); assert.equal(Object.keys(reopened.t.answers).length, 0); assert(!reopened.ids['review-attempt'].disabled);

  // Saved review recomputes grading and uses the saved flags, then restores the
  // prior live draft and slide. Stored summaries and results are untrusted.
  const forged = JSON.parse(beforeRetry); forged.summary.score = -999; forged.results = [];
  const review = await load(FOLDER, { server: [[attemptUrl(h), forged]] });
  await editResponse(review, 'CS-2', correct(KEY[1])); await mark(review, 'CS-2'); await nav(review, 'CS-9').click();
  const priorDraft = review.storage.get(draftKey(review)); await review.ids['review-attempt'].click();
  assert.equal(review.ids['retry-quiz'].textContent, 'Back to quiz'); assert.equal(review.t.summarize(review.t.grade()).score, 11);
  assert(nav(review, 'CS-1').className.includes('marked-review')); assert(!nav(review, 'CS-2').className.includes('marked-review'));
  assert.equal(review.storage.get(draftKey(review)), priorDraft); await review.ids['retry-quiz'].click(); active(review, 8);
  assert.equal(review.t.answers['CS-2'], correct(KEY[1])); flagged(review, 'CS-2', true); assert.equal(review.storage.get(draftKey(review)), priorDraft); assert.equal(posts(review).length, 0);
  await review.ids['clear-answers'].click(); active(review, 0); flagged(review, 'CS-2', false); assert.equal(posts(review).length, 0);
  const badSaved = await load(FOLDER, { server: [[attemptUrl(h), { ...forged, reviewFlags: ['CS-1', 'CS-1'] }]] });
  await editResponse(badSaved, 'CS-2', correct(KEY[1])); const validDraft = badSaved.storage.get(draftKey(badSaved));
  await badSaved.ids['review-attempt'].click(); assert(badSaved.ids.report.hidden); assert.equal(badSaved.t.answers['CS-2'], correct(KEY[1])); assert.equal(badSaved.storage.get(draftKey(badSaved)), validDraft, 'Malformed saved flags cannot replace practice');
  const legacySaved = { ...forged }; delete legacySaved.reviewFlags;
  const legacyReview = await load(FOLDER, { server: [[attemptUrl(h), legacySaved]] }); await legacyReview.ids['review-attempt'].click();
  assert(!legacyReview.ids.report.hidden); assert.equal(legacyReview.ids['nav-groups'].querySelectorAll('.marked-review').length, 0, 'Legacy submissions do not invent saved flags');
  const legacy = { ...cached }; delete legacy.reviewFlags; delete legacy.timer;
  const compatible = await load(FOLDER, { storage: [[draftKey(h), JSON.stringify(legacy)]] }); same(compatible.t.answers, cached.answers); assert.equal(compatible.ids['timer-display'].textContent, '03:00:00');
  for (const bad of [
    '{invalid', JSON.stringify({ ...cached, signature: 'wrong paper' }), JSON.stringify({ ...cached, updatedAt: 'invalid' }), JSON.stringify({ ...cached, answers: { 'CS-999': 'A' } }),
    ...[null, 'CS-1', ['CS-1', 'CS-1'], ['CS-999'], [1]].map(reviewFlags => JSON.stringify({ ...cached, reviewFlags }))
  ]) {
    const invalid = await load(FOLDER, { storage: [[draftKey(h), bad]] }); assert.equal(Object.keys(invalid.t.answers).length, 0); assert(!invalid.storage.has(draftKey(invalid))); assertEditable(invalid);
  }
  const unavailable = await load(FOLDER, { storageUnavailable: true }); const noUnavailableDialogs = rejectFileDialogs(unavailable);
  await editResponse(unavailable, 'CS-1', correct(KEY[0])); await mark(unavailable, 'CS-1'); await unavailable.ids['quiz-form'].fire('submit');
  assert(!unavailable.ids.report.hidden); await unavailable.ids['retry-quiz'].click(); assertEditable(unavailable);
  assert.match(unavailable.ids['status-message'].textContent, /Could not cache/); assert(!unavailable.ids['status-message'].hidden);
  const failed = await load(FOLDER, { fetch: (request, perform, response) => request.method === 'POST' ? response(500, { error: 'Test write failure' }) : perform() });
  failed.ctx.setInterval = () => 1; failed.ctx.clearInterval = () => {};
  await editResponse(failed, 'CS-1', correct(KEY[0])); await mark(failed, 'CS-1'); await failed.ids['timer-start'].click(); await failed.ids['quiz-form'].fire('submit');
  assert(!failed.ids.report.hidden); assert(failed.ids['review-attempt'].disabled); assert.equal(failed.server.size, 0);
  const failedCache = JSON.parse(failed.storage.get(draftKey(failed))); same(failedCache.answers, { 'CS-1': correct(KEY[0]) }); same(failedCache.reviewFlags, ['CS-1']);
  same(failedCache.timer, { durationMinutes: 180, remainingMs: 180 * 60000, endsAt: null }, 'A failed save still resets and pauses the selected timer');
  const failedReopen = await load(FOLDER, { storage: failed.storage }); flagged(failedReopen, 'CS-1', true); assert.equal(failedReopen.t.answers['CS-1'], correct(KEY[0]));
  const otherKey = 'practice-quiz:another-paper', otherDraft = JSON.stringify({ answers: { 'CS-1': 'A' } }), storage = new Map([[otherKey, otherDraft]]);
  const themed = await load(FOLDER, { storage }); await editResponse(themed, 'CS-1', correct(KEY[0])); const beforeTheme = storage.get(draftKey(themed));
  vm.runInContext(fs.readFileSync(path.join(FOLDER, 'theme.js'), 'utf8'), themed.ctx); themed.document.DOMContentLoaded(); await themed.ids['theme-toggle'].click();
  assert.equal(storage.get('practice-quiz:theme'), 'dark'); assert.equal(storage.get(draftKey(themed)), beforeTheme);
  await themed.ids['quiz-form'].fire('submit'); assert.equal(storage.get(otherKey), otherDraft); assert.equal(storage.get('practice-quiz:theme'), 'dark');
  noDialogs(); noUnavailableDialogs(); await homeIntegration(data);
  console.log(`PASS: 2012 independent 65-MCQ Code A key, 100 marks, six MTA awards, ${optionChecks} option checks, ${linkedChecks} linked combinations, blank/perfect/mixed/all-wrong scores, ${imagePaths.size} lossless PNG crops/${images} displayed parts/source provenance/no PDF copies/shared runtime, carousel/current map/Home/timer, drafts/reload/flags/reports/retry/review, failed saves/storage isolation, and temporary-server verified scores/negative scores/year order. No real attempts touched.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
