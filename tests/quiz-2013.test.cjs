const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const harness = require('./helpers/quiz-harness.cjs');
const { load, editResponse, draftKey, attemptUrl, rejectFileDialogs, assertEditable } = harness;

// The ORS-code-A fixture was audited separately from quiz-data.js. Browser
// submissions stay in memory; HTTP writes use a disposable fixture directory.
const root = path.resolve(__dirname, '..'), folder = path.join(root, 'gate-cse-2013');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gate-cse-2013-key.json'), 'utf8'));
const key = fixture.questions.map(row => ({ ...row, answers: row.acceptedAnswers || (row.correctAnswer ? [row.correctAnswer] : []) }));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const close = (actual, expected, message = 'Marks match') => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const index = id => key.findIndex(row => row.id === id);
const card = (h, id) => h.document.getElementById(`question-card-${index(id)}`);
const nav = (h, id) => h.document.getElementById(`nav-question-${index(id)}`);
const flag = (h, id) => h.document.getElementById(`mark-review-${index(id)}`);
const result = (h, id) => h.t.grade()[index(id)];
const correct = row => row.answers[0] || 'A';
const wrong = row => [...'ABCD'].find(option => !row.answers.includes(option));
const signature = data => JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null });
const allText = node => [node.textContent, ...node.children.map(allText)].join(' ');
const reset = h => { Object.keys(h.t.answers).forEach(id => delete h.t.answers[id]); h.t.setSubmitted(''); };
const attempts = () => Object.fromEntries(fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  .map(entry => path.join(root, entry.name, 'attempt.json')).filter(file => fs.existsSync(file)).map(file => [file, sha(file)]));
const originalAttempts = attempts();
function current(h, id) {
  same(h.ids.questions.querySelectorAll('.question-card').filter(node => !node.hidden).map(node => node.id), [`question-card-${index(id)}`], 'Exactly one practice question is visible');
  same(h.ids['nav-groups'].querySelectorAll('.nav-question').filter(node => node.getAttribute('aria-current') === 'location').map(node => node.id), [`nav-question-${index(id)}`], 'Exactly one map number is current');
}
function assertFlag(h, id, marked) {
  assert.equal(flag(h, id).getAttribute('aria-pressed'), String(marked));
  assert.equal(nav(h, id).className.split(' ').includes('marked-review'), marked);
}

async function checkHome(data) {
  const fsp = fs.promises, os = require('node:os'), http = require('node:http');
  const { createServer } = require('../server.cjs');
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-2013-test-')), quiz = path.join(temp, 'gate-cse-2013');
  const server = createServer({ root: temp, port: 0 });
  try {
    await fsp.mkdir(quiz);
    for (const name of ['index.html', 'quiz-data.js']) await fsp.copyFile(path.join(folder, name), path.join(quiz, name));
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const port = server.address().port, origin = `http://127.0.0.1:${port}`;
    const request = (url, record) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method: record ? 'POST' : 'GET',
        headers: record ? { 'Content-Type': 'application/json', Origin: origin } : {} }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.setTimeout(3000, () => req.destroy(new Error('Temporary server timed out'))); req.on('error', reject); req.end(record && JSON.stringify(record));
    });
    const readCard = async () => {
      const home = await request('/'); assert.equal(home.status, 200);
      const paper = (home.body.match(/<li\b[\s\S]*?<\/li>/g) || []).find(html => html.includes('href="/gate-cse-2013/"'));
      assert(paper, 'New paper automatically appears on home'); return paper;
    };
    assert.match(await readCard(), /data-attempted="false"/); assert.equal((await request('/gate-cse-2013/attempt.json')).status, 404);
    const attempt = { version: 1, quizId: data.id, quizSignature: signature(data), submittedAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
      answers: Object.fromEntries(key.map(row => [row.id, correct(row)])), reviewFlags: ['CS-42', 'CS-53'], summary: { score: 999 }, results: [] };
    const save = async () => assert.equal((await request('/gate-cse-2013/attempt.json', attempt)).status, 200);
    await save(); assert.match(await readCard(), /Last score: 100 \/ 100/, 'Server ignores forged totals and grades the verified key');
    for (const pair of fixture.linkedPairs) attempt.answers[pair.prerequisite] = wrong(key[index(pair.prerequisite)]);
    await save(); assert.match(await readCard(), /Last score: 90\.6667 \/ 100/, 'Wrong prerequisites block both correct linked seconds');
    attempt.answers = Object.fromEntries(key.map(row => [row.id, correct(row)]));
    for (const pair of fixture.linkedPairs) attempt.answers[pair.dependent] = wrong(key[index(pair.dependent)]);
    await save(); assert.match(await readCard(), /Last score: 96 \/ 100/, 'Linked second wrong answers carry no penalty');
    attempt.answers = Object.fromEntries(key.map(row => [row.id, wrong(row)]));
    await save(); const negative = await readCard(); assert.match(negative, /Last score: -26\.6667 \/ 100/);
    assert.match(negative, /<progress class="paper-score-bar" value="0" max="100"/, 'Only visual bar clamps the negative score');
    attempt.answers = { 'CS-49': correct(key[index('CS-49')]), 'CS-51': correct(key[index('CS-51')]) };
    await save(); assert.match(await readCard(), /Last score: 8 \/ 100/, 'Common-data second questions have independent grading');
    attempt.answers = Object.fromEntries(key.map(row => [row.id, null])); await save();
    assert.match(await readCard(), /data-attempted="false"/, 'MTA-only blank submission is unattempted despite four awarded marks');
    attempt.answers = { 'CS-42': 'D' }; await save(); assert.match(await readCard(), /Last score: 4 \/ 100/, 'Any MTA response still receives only the same awards');
    attempt.quizSignature = 'stale'; await save(); const stale = await readCard();
    assert.match(stale, /data-attempted="true"/); assert.match(stale, /Last score unavailable/); assert.match(stale, /class="paper-score-bar" hidden/);
    // Even a blocked dependent's selected option must be validated.
    attempt.quizSignature = signature(data); attempt.answers = { 'CS-53': 'invalid' }; await save();
    assert.match(await readCard(), /Last score unavailable/);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert(path.basename(resolved).startsWith('quiz-2013-test-'));
    await fsp.rm(resolved, { recursive: true, force: true });
  }
}

function clock(at = Date.UTC(2026, 9, 20, 9)) {
  let now = at, next = 0; const ticks = new Map();
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  return { Date: ClockDate, now: () => now, setInterval: callback => { const id = ++next; ticks.set(id, callback); return id; }, clearInterval: id => ticks.delete(id),
    advance(ms, tick = true) { now += ms; if (tick) [...ticks.values()].forEach(callback => callback()); }, count: () => ticks.size };
}
async function checkTimer() {
  // Extend the shared harness only at its context boundary to make elapsed time
  // deterministic; the real quiz runtime and DOM/storage model stay unchanged.
  let source = fs.readFileSync(path.join(__dirname, 'helpers/quiz-harness.cjs'), 'utf8');
  const marker = 'fetch, console, Blob, URL, setTimeout() {}'; assert(source.includes(marker));
  source = source.replace(marker, 'fetch, console, Blob, URL, Date: options.clock.Date, setInterval: options.clock.setInterval, clearInterval: options.clock.clearInterval, setTimeout() {}');
  const timedHarness = new Function('require', 'module', `${source}\nreturn module.exports;`)(require, { exports: {} });
  const timedLoad = async (options = {}) => { const time = options.clock || clock(); return { ...await timedHarness.load(folder, { ...options, clock: time }), clock: time }; };
  const remaining = h => h.ids['timer-display'].textContent.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
  const choose = async (h, value) => { h.ids['timer-duration'].value = String(value); await h.ids['timer-duration'].fire('change'); };
  const h = await timedLoad(); assert.equal(remaining(h), 180 * 60);
  for (const preset of [180, 150, 120, 90, 60, 30]) { await choose(h, preset); assert.equal(remaining(h), preset * 60); assert.equal(h.clock.count(), 0); }
  await choose(h, 45); assert.equal(remaining(h), 30 * 60, 'Unsupported custom duration is rejected');
  await h.ids['timer-start'].click(); h.clock.advance(25_000); assert.equal(remaining(h), 1775);
  await editResponse(h, 'CS-1', correct(key[0])); await flag(h, 'CS-1').click();
  await h.ids['clear-answers'].click(); assert.equal(remaining(h), 1775); assert.equal(h.clock.count(), 1, 'Clear leaves the timer running');
  await editResponse(h, 'CS-1', correct(key[0]));
  const snapshot = h.storage.get(draftKey(h)); h.clock.advance(20_000, false);
  const reopened = await timedLoad({ clock: clock(h.clock.now()), storage: [[draftKey(h), snapshot]] });
  assert.equal(remaining(reopened), 1755, 'Reload accounts for time outside the page');
  await reopened.ids['timer-pause'].click(); assert.equal(reopened.clock.count(), 0);
  reopened.clock.advance(9000); assert.equal(remaining(reopened), 1755);
  await reopened.ids['timer-start'].click(); await reopened.ids['quiz-form'].fire('submit');
  assert.equal(remaining(reopened), 1800); assert.equal(reopened.clock.count(), 0); assert(reopened.ids['quiz-timer'].hidden);
  const saved = reopened.server.get(attemptUrl(reopened)); assert(!Object.hasOwn(saved, 'timer')); assert.equal(saved.quizSignature, signature(reopened.data));
  await reopened.ids['retry-quiz'].click(); await choose(reopened, 30); await reopened.ids['timer-start'].click();
  await editResponse(reopened, 'CS-2', wrong(key[1])); const draft = reopened.storage.get(draftKey(reopened));
  await reopened.ids['review-attempt'].click(); reopened.clock.advance(31 * 60000);
  assert.equal(remaining(reopened), 0); assert.equal(reopened.clock.count(), 0); assert.equal(reopened.storage.get(draftKey(reopened)), draft);
  await reopened.ids['retry-quiz'].click(); assert(!reopened.ids['quiz-form'].hidden); assert.equal(remaining(reopened), 0);
  assert.equal(reopened.requests.filter(request => request.method === 'POST').length, 1, 'Expiry/review do not submit automatically');
  const failed = await timedLoad({ fetch: (request, perform, response) => request.method === 'POST' ? response(503, {}) : perform() });
  await choose(failed, 60); await failed.ids['timer-start'].click(); failed.clock.advance(4000);
  await editResponse(failed, 'CS-1', correct(key[0])); await failed.ids['quiz-form'].fire('submit');
  assert.equal(remaining(failed), 3600); assert.equal(failed.clock.count(), 0);
  assert.equal(JSON.parse(failed.storage.get(draftKey(failed))).timer.endsAt, null, 'Failed Submit still resets the draft timer');
}

(async () => {
  const h = await load(folder), { data, t, ids } = h, noDialogs = rejectFileDialogs(h);
  t.validate(); assert.equal(data.id, fixture.quizId); assert.equal(data.id, 'gate-cse-2013-booklet-a'); assert.equal(data.questions.length, 65); assert.equal(key.length, 65);
  assert.equal(data.title, 'GATE CSE 2013 - Booklet A'); same(data.sourceSha256, fixture.sourceSha256);
  assert.equal(data.questionBookletCode, 'A'); assert.equal(data.answerKeyColumn, 'ORS code A');
  same(data.sourcePageCounts, { questionPaper: fixture.paperPageCount, answerKey: fixture.keyPageCount });
  same(data.questions.map(q => q.id), [...Array.from({ length: 55 }, (_, i) => `CS-${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `GA-${i + 56}`)]);
  assert.equal(data.questions.reduce((sum, q) => sum + q.marks, 0), 100); assert.equal(data.cropDpi, 240);
  assert.match(data.cropRenderer, /PDFium/i, 'Original Symbol-font glyphs use the verified PDFium renderer');
  for (const name of ['quiz.js', 'styles.css', 'theme.js']) assert.equal(sha(path.join(folder, name)), sha(path.join(root, '_template', name)), `${name} matches shared runtime`);
  for (const name of [data.questionPaper, data.answerKey]) {
    assert(Object.hasOwn(fixture.sourceSha256, name)); assert.equal(path.basename(name), name); assert.match(fixture.sourceSha256[name], /^[a-f0-9]{64}$/);
    assert(!fs.existsSync(path.join(folder, name)), 'Sources are recorded as provenance rather than copied');
  }
  assert(!fs.readdirSync(folder).some(name => /\.pdf$/i.test(name)));
  const imageNames = new Set(); let imageCount = 0;
  for (const [i, q] of data.questions.entries()) {
    const expected = key[i]; assert.equal(q.id, expected.id); assert.equal(q.number, i + 1); assert.equal(q.number, expected.number);
    assert.equal(q.type, 'mcq'); assert.equal(q.section, expected.section); assert.equal(q.displayLabel, `${q.section} ${q.number}`);
    assert.equal(q.marks, expected.marks); assert.equal(q.incorrectMarks, expected.incorrectMarks);
    assert.equal(q.marks, q.number <= 25 || (q.number >= 56 && q.number <= 60) ? 1 : 2);
    assert.equal(q.incorrectMarks, expected.marksToAll || expected.requiresCorrect ? 0 : -q.marks / 3);
    assert.equal(Boolean(q.marksToAll), Boolean(expected.marksToAll)); assert.equal(q.requiresCorrect, expected.requiresCorrect);
    if (!q.marksToAll) same(q.acceptedAnswers || [q.correctAnswer], expected.answers, `${q.id} ORS-code-A key`);
    same(q.options.map(option => option.id), ['A', 'B', 'C', 'D']); assert.equal(q.answerKeyPage, expected.answerKeyPage);
    same(q.sourcePages, expected.sourcePages, `${q.id} independently matched source pages`);
    same(q.sourcePages, [...new Set(q.images.map(image => image.page))]); assert(q.images.length && q.sourceRectangles.length === q.images.length);
    for (let part = 0; part < q.images.length; part++) {
      const image = q.images[part], crop = q.sourceRectangles[part];
      assert(image.src.startsWith('assets/') && !path.isAbsolute(image.src) && !image.src.includes('..') && !/^[a-z]+:/i.test(image.src));
      assert(image.alt && Number.isInteger(image.page) && image.page > 0 && image.page <= fixture.paperPageCount);
      assert.equal(crop.sourceDocument, data.questionPaper);
      if (image.sourceDocument !== undefined) assert.equal(image.sourceDocument, crop.sourceDocument);
      assert.equal(crop.page, image.page); assert.equal(crop.rect.length, 4); assert(crop.rect.every(Number.isFinite));
      assert(crop.rect[0] >= 0 && crop.rect[1] >= 0 && crop.rect[2] > crop.rect[0] && crop.rect[3] > crop.rect[1]);
      const page = data.sourcePageSizes.find(row => row.page === image.page); assert(page && page.width > 0 && page.height > 0);
      assert(crop.rect[2] <= page.width && crop.rect[3] <= page.height);
      const bytes = fs.readFileSync(path.join(folder, image.src)); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert(bytes.readUInt32BE(16) > 100 && bytes.readUInt32BE(20) > 30);
      assert.equal(page.renderedWidth, 2040); assert.equal(page.renderedHeight, 2640);
      const scaleX = page.renderedWidth / page.width, scaleY = page.renderedHeight / page.height;
      assert.equal(bytes.readUInt32BE(16), Math.ceil(crop.rect[2] * scaleX) - Math.floor(crop.rect[0] * scaleX), `${q.id} crop width follows original page coordinates`);
      assert.equal(bytes.readUInt32BE(20), Math.ceil(crop.rect[3] * scaleY) - Math.floor(crop.rect[1] * scaleY), `${q.id} crop height follows original page coordinates`);
      imageNames.add(image.src); imageCount++;
    }
  }
  same(data.questions.filter(q => q.marksToAll).map(q => q.id), ['CS-42', 'CS-47']);
  same(data.questions.filter(q => q.requiresCorrect).map(q => [q.requiresCorrect, q.id]), [['CS-52', 'CS-53'], ['CS-54', 'CS-55']]);
  assert.equal(fs.readdirSync(path.join(folder, 'assets')).filter(name => /\.png$/i.test(name)).length, imageNames.size, 'Every original PNG crop is used');
  assert.equal(imageNames.size, 69); assert.equal(imageCount, 73, 'Four shared context crops occur in both questions');
  for (const pair of fixture.commonDataPairs) {
    const [a, b] = pair.questions.map(id => data.questions[index(id)]);
    assert(a.images.some(image => b.images.some(other => other.src === image.src)), 'Both common-data questions preserve their shared passage image');
    assert(!a.requiresCorrect && !b.requiresCorrect, 'Common data creates no scoring dependency');
  }
  const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
  assert.match(html, /<a\b[^>]*id="quiz-home"[^>]*href="\/"/);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) if (match[1] !== '/') {
    assert(!/^[a-z]+:/i.test(match[1]) && !path.isAbsolute(match[1])); assert(fs.existsSync(path.join(folder, match[1])));
  }
  const options = html.match(/<select\b[^>]*id="timer-duration"[^>]*>([\s\S]*?)<\/select>/);
  same([...options[1].matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(match => Number(match[1])), [180, 150, 120, 90, 60, 30]);
  const css = fs.readFileSync(path.join(folder, 'styles.css'), 'utf8');
  assert.match(css, /\[data-theme="dark"\] \.question-image\s*\{\s*filter:\s*invert\(1\)/);
  assert.match(css.slice(css.indexOf('@media print')), /filter:\s*none/);

  let summary = t.summarize(t.grade()); close(summary.score, 4); close(summary.maximum, 100);
  same(summary.counts, { correct: 0, incorrect: 0, unanswered: 63, awarded: 2 }); assert.equal(summary.awardedMarks, 4);
  for (const row of key) t.answers[row.id] = correct(row);
  summary = t.summarize(t.grade()); close(summary.score, 100); same(summary.counts, { correct: 63, incorrect: 0, unanswered: 0, awarded: 2 });
  let optionChecks = 0;
  for (const row of key) for (const option of 'ABCD') {
    reset(h); if (row.requiresCorrect) t.answers[row.requiresCorrect] = correct(key[index(row.requiresCorrect)]);
    t.answers[row.id] = option; const graded = result(h, row.id), accepted = row.answers.includes(option);
    assert.equal(graded.outcome, row.marksToAll ? 'awarded' : accepted ? 'correct' : 'incorrect');
    close(graded.earned, row.marksToAll || accepted ? row.marks : row.incorrectMarks); optionChecks++;
  }
  let linkedChecks = 0;
  for (const pair of fixture.linkedPairs) for (const first of ['blank', 'correct', 'wrong']) for (const second of ['blank', 'correct', 'wrong']) {
    reset(h); const a = key[index(pair.prerequisite)], b = key[index(pair.dependent)];
    if (first !== 'blank') t.answers[a.id] = first === 'correct' ? correct(a) : wrong(a);
    if (second !== 'blank') t.answers[b.id] = second === 'correct' ? correct(b) : wrong(b);
    const graded = result(h, b.id), blocked = first !== 'correct' && second !== 'blank';
    close(t.summarize(t.grade()).score, 4 + (first === 'correct' ? 2 : first === 'wrong' ? -2 / 3 : 0) + (first === 'correct' && second === 'correct' ? 2 : 0));
    assert.equal(graded.outcome, second === 'blank' ? 'unanswered' : blocked ? 'blocked' : second === 'correct' ? 'correct' : 'incorrect');
    if (blocked) assert.match(graded.reason, new RegExp(`CS ${a.number} was incorrect or unanswered`)); linkedChecks++;
  }
  reset(h); for (const row of key) t.answers[row.id] = wrong(row);
  summary = t.summarize(t.grade()); close(summary.score, -80 / 3); assert.equal(summary.counts.blocked, 2); assert.equal(summary.counts.awarded, 2);
  reset(h); t.answers['CS-1'] = correct(key[0]); t.answers['CS-26'] = wrong(key[25]);
  t.answers['CS-52'] = correct(key[51]); t.answers['CS-53'] = correct(key[52]); t.answers['CS-55'] = correct(key[54]);
  close(t.summarize(t.grade()).score, 25 / 3); assert.equal(result(h, 'CS-55').outcome, 'blocked');
  for (const pair of fixture.commonDataPairs) { reset(h); const second = key[index(pair.questions[1])]; t.answers[second.id] = correct(second); assert.equal(result(h, second.id).outcome, 'correct'); }

  reset(h); t.renderQuestions(); current(h, 'CS-1'); assert(ids['previous-question'].disabled);
  assert.equal(ids.questions.querySelectorAll('input').length, 260); assert.equal(ids.questions.querySelectorAll('img').length, imageCount);
  same(ids['nav-groups'].querySelectorAll('h3').map(node => node.textContent), ['CS', 'GA']);
  assert.equal(ids['nav-progress'].textContent, '0 attempted · 65 not attempted'); assert(ids['review-attempt'].disabled);
  assert.equal(ids['review-attempt'].title, 'This paper has not been attempted before.'); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, 'GET'); assert.equal(h.requests[0].cache, 'no-store');
  await editResponse(h, 'CS-1', correct(key[0])); current(h, 'CS-2');
  assert.equal(JSON.parse(h.storage.get(draftKey(h))).answers['CS-1'], correct(key[0]), 'MCQ caches before auto-advance');
  await flag(h, 'CS-1').click(); await flag(h, 'CS-2').click(); assert.equal(ids['nav-progress'].textContent, '1 attempted · 64 not attempted');
  await ids['next-question'].click(); current(h, 'CS-3'); await ids['previous-question'].click(); current(h, 'CS-2');
  const cached = JSON.parse(h.storage.get(draftKey(h))); same(cached.reviewFlags, ['CS-1', 'CS-2']); assert.equal(cached.signature, signature(data)); assert(!Object.hasOwn(cached, 'currentQuestionIndex'));
  const restored = await load(folder, { storage: h.storage }); current(restored, 'CS-1');
  assert.equal(restored.t.answers['CS-1'], correct(key[0])); assertFlag(restored, 'CS-1', true);
  await card(restored, 'CS-1').querySelector('.clear-response').click(); assert.equal(restored.t.answers['CS-1'], undefined); assertFlag(restored, 'CS-1', true);
  await nav(restored, 'GA-65').click(); current(restored, 'GA-65'); assert(restored.ids['next-question'].disabled);
  await restored.ids['quiz-form'].fire('keydown', { key: 'Enter', target: card(restored, 'GA-65').querySelector('input') }); current(restored, 'GA-65'); assert.equal(restored.requests.length, 1, 'Enter on last question does not submit');
  await editResponse(restored, 'CS-1', correct(key[0])); await editResponse(restored, 'CS-2', wrong(key[1])); await editResponse(restored, 'CS-53', correct(key[52]));
  await restored.ids['quiz-form'].fire('submit'); const submission = restored.server.get(attemptUrl(restored));
  close(submission.summary.score, 14 / 3); assert.equal(submission.results[52].outcome, 'blocked'); assert.equal(submission.results[41].outcome, 'awarded');
  same(submission.reviewFlags, ['CS-1', 'CS-2']); assert(!Object.hasOwn(submission, 'timer')); assert(!Object.hasOwn(submission, 'currentQuestionIndex'));
  assert(submission.results.every(row => !Object.hasOwn(row, 'reviewFlags'))); assert(!restored.storage.has(draftKey(restored))); assert(!restored.ids['review-attempt'].disabled);
  assert(restored.ids['quiz-timer'].hidden && restored.ids['question-carousel'].hidden); assert(!restored.ids['nav-review-legend'].hidden);
  assert.equal(restored.ids['report-list'].querySelectorAll('.result-card').length, 65); assert.equal(restored.ids['report-list'].querySelectorAll('img').length, imageCount);
  for (const row of key) {
    const text = allText(restored.document.getElementById(`result-card-${index(row.id)}`)); assert(text.includes('Your answer:') && text.includes('Correct answer:') && text.includes('marks'));
    assert(nav(restored, row.id).className.includes(`result-${submission.results[index(row.id)].outcome}`));
  }
  assert.equal(nav(restored, 'CS-1').querySelector('.nav-state-icon').textContent, '★'); assert(nav(restored, 'CS-1').className.includes('result-correct'));
  assert.equal(nav(restored, 'CS-2').querySelector('.nav-state-icon').textContent, '★'); assert(nav(restored, 'CS-2').className.includes('result-incorrect'), 'Report flag retains the incorrect outcome color');
  assert.equal(nav(restored, 'CS-42').querySelector('.nav-state-icon').textContent, '+'); assert.match(allText(restored.ids['report-list']), /Not evaluated/); assert.match(allText(restored.ids['report-list']), /MTA/);
  await nav(restored, 'CS-53').click(); assert(restored.document.getElementById('result-card-52').focused);
  let reportBlob, prints = 0;
  restored.ctx.URL = class extends URL { static createObjectURL(blob) { reportBlob = blob; return 'blob:2013-report'; } static revokeObjectURL() {} };
  restored.window.print = () => prints++; await restored.ids['download-report'].click(); assert.match(await reportBlob.text(), /Not evaluated/); assert.match(await reportBlob.text(), /MTA/);
  await restored.ids['print-report'].click(); assert.equal(prints, 1);
  const saved = JSON.stringify(submission), reopened = await load(folder, { server: restored.server, storage: restored.storage });
  current(reopened, 'CS-1'); assert(!reopened.ids['review-attempt'].disabled); assert.equal(Object.keys(reopened.t.answers).length, 0);
  await restored.ids['retry-quiz'].click(); current(restored, 'CS-1'); assertFlag(restored, 'CS-1', false); assert.equal(JSON.stringify(restored.server.get(attemptUrl(restored))), saved);
  await editResponse(restored, 'CS-2', wrong(key[1])); await flag(restored, 'CS-2').click(); await nav(restored, 'CS-12').click();
  const draft = restored.storage.get(draftKey(restored)); submission.summary.score = 999; submission.results = [];
  await restored.ids['review-attempt'].click(); close(restored.t.summarize(restored.t.grade()).score, 14 / 3);
  assert.equal(restored.ids['retry-quiz'].textContent, 'Back to quiz'); assert.equal(restored.storage.get(draftKey(restored)), draft);
  same(restored.ids['nav-groups'].querySelectorAll('.marked-review').map(button => key[Number(button.id.replace('nav-question-', ''))].id), ['CS-1', 'CS-2']);
  await restored.ids['retry-quiz'].click(); current(restored, 'CS-12'); assert.equal(restored.t.answers['CS-2'], wrong(key[1])); assertFlag(restored, 'CS-2', true);
  await restored.ids['clear-answers'].click(); current(restored, 'CS-1'); assertFlag(restored, 'CS-2', false); assert.equal(restored.requests.filter(request => request.method === 'POST').length, 1);
  const legacySubmission = JSON.parse(saved); delete legacySubmission.reviewFlags;
  const legacyReview = await load(folder, { server: [[attemptUrl(h), legacySubmission]] });
  await editResponse(legacyReview, 'CS-3', correct(key[2])); await flag(legacyReview, 'CS-3').click();
  await legacyReview.ids['review-attempt'].click(); close(legacyReview.t.summarize(legacyReview.t.grade()).score, 14 / 3);
  assert.equal(legacyReview.ids['nav-groups'].querySelectorAll('.marked-review').length, 0, 'Legacy submission does not borrow current draft flags');
  await legacyReview.ids['retry-quiz'].click(); assertFlag(legacyReview, 'CS-3', true);
  const legacy = { ...cached }; delete legacy.reviewFlags; delete legacy.timer;
  const legacyDraft = await load(folder, { storage: [[draftKey(h), JSON.stringify(legacy)]] }); same(legacyDraft.t.answers, cached.answers);
  for (const bad of [null, 'CS-1', ['CS-1', 'CS-1'], ['GA-1'], [1]]) {
    const invalid = await load(folder, { storage: [[draftKey(h), JSON.stringify({ ...cached, reviewFlags: bad })]] }); assert.equal(Object.keys(invalid.t.answers).length, 0); assertEditable(invalid);
    const invalidReview = await load(folder, { server: [[attemptUrl(h), { ...submission, reviewFlags: bad }]] });
    await editResponse(invalidReview, 'CS-3', correct(key[2])); const before = invalidReview.storage.get(draftKey(invalidReview)); await invalidReview.ids['review-attempt'].click();
    assert(invalidReview.ids.report.hidden); assert.equal(invalidReview.t.answers['CS-3'], correct(key[2])); assert.equal(invalidReview.storage.get(draftKey(invalidReview)), before);
  }
  const failed = await load(folder, { fetch: (request, perform, response) => request.method === 'POST' ? response(503, {}) : perform() });
  await editResponse(failed, 'CS-1', correct(key[0])); await flag(failed, 'CS-1').click(); await failed.ids['quiz-form'].fire('submit');
  assert(!failed.ids.report.hidden); assert(failed.storage.has(draftKey(failed))); assertFlag(failed, 'CS-1', true); assert(failed.ids['review-attempt'].disabled);
  same(JSON.parse(failed.requests.at(-1).body).reviewFlags, ['CS-1']);
  const failedReopen = await load(folder, { storage: failed.storage }); assert.equal(failedReopen.t.answers['CS-1'], correct(key[0])); assertFlag(failedReopen, 'CS-1', true);
  const priorSaved = await load(folder, { server: [[attemptUrl(h), JSON.parse(saved)]], fetch: (request, perform, response) => request.method === 'POST' ? response(503, {}) : perform() });
  await editResponse(priorSaved, 'CS-3', correct(key[2])); await priorSaved.ids['quiz-form'].fire('submit');
  assert(!priorSaved.ids['review-attempt'].disabled, 'Failed save preserves previous Review availability');
  assert.equal(JSON.stringify(priorSaved.server.get(attemptUrl(priorSaved))), saved, 'Failed Submit preserves the previous saved attempt');
  const blank = await load(folder); await blank.ids['quiz-form'].fire('submit'); close(blank.server.get(attemptUrl(blank)).summary.score, 4); assert(blank.ids['review-attempt'].disabled);
  const unavailable = await load(folder, { storageUnavailable: true }), noUnavailableDialogs = rejectFileDialogs(unavailable);
  await editResponse(unavailable, 'CS-1', correct(key[0])); await unavailable.ids['quiz-form'].fire('submit'); await unavailable.ids['retry-quiz'].click();
  assert.match(unavailable.ids['status-message'].textContent, /Could not cache/); assertEditable(unavailable);
  const otherKey = 'practice-quiz:another-paper', otherDraft = '{"answers":{"CS-1":"A"}}'; restored.storage.set(otherKey, otherDraft);
  vm.runInContext(fs.readFileSync(path.join(folder, 'theme.js'), 'utf8'), restored.ctx); restored.document.DOMContentLoaded();
  const beforeTheme = restored.storage.get(draftKey(restored)); await restored.ids['theme-toggle'].click();
  assert.equal(restored.storage.get('practice-quiz:theme'), 'dark'); assert.equal(restored.storage.get(draftKey(restored)), beforeTheme); assert.equal(restored.storage.get(otherKey), otherDraft);
  noDialogs(); noUnavailableDialogs(); await checkTimer(); await checkHome(data);
  console.log(`PASS: GATE 2013 booklet-A independent 65-entry key, ${optionChecks} MCQ choices, ${linkedChecks} linked combinations, 2 MTA/common-data independence, original hash metadata/no PDF copies, ${imageNames.size} PNG crops/${imageCount} image references, blank4/perfect100/mixed/allwrong−80/3 scores, current carousel/maps/report outcomes/stars/save/print, drafts/flags/reload/clear/Submit/review/retry/failure/storage/theme, deterministic fixed timer/pause/reload/expiry/report behavior, disposable-server recomputation/linked gates/awards/negative clamp/stale/blocked-option validation. No real attempt written.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  try { same(attempts(), originalAttempts, 'Real user attempts stay unchanged'); } catch (error) { console.error(error.message); process.exitCode = 1; }
});
