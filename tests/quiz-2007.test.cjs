const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { load, editResponse, draftKey, attemptUrl, rejectFileDialogs, assertEditable } = require('./helpers/quiz-harness.cjs');

// All submissions use the in-memory harness or a disposable server root.
// The independent fixture is transcribed/audited separately from quiz-data.js.
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'gate-cse-2007');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gate-cse-2007-key.json'), 'utf8'));
const key = fixture.questions.map(row => ({ ...row, id: row.id || `CS-${row.number}`, answers: row.acceptedAnswers || [row.correctAnswer] }));
const linkedSeconds = [77, 79, 81, 83, 85];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
const close = (a, b) => assert(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const card = (h, n) => h.document.getElementById(`question-card-${n - 1}`);
const nav = (h, n) => h.document.getElementById(`nav-question-${n - 1}`);
const flag = (h, n) => h.document.getElementById(`mark-review-${n - 1}`);
const allText = node => [node.textContent, ...node.children.map(allText)].join(' ');
const reset = h => Object.keys(h.t.answers).forEach(id => delete h.t.answers[id]);
const correct = row => row.answers[0];
const wrong = row => [...'ABCD'].find(option => !row.answers.includes(option));
const signature = data => JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null });
const attempts = () => Object.fromEntries(fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name, 'attempt.json')).filter(file => fs.existsSync(file)).map(file => [file, sha(file)]));
const originalAttempts = attempts();

async function checkHome(data) {
  const fsp = fs.promises, os = require('node:os'), http = require('node:http');
  const { createServer } = require('../server.cjs');
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-2007-test-'));
  const quiz = path.join(temp, 'gate-cse-2007');
  const server = createServer({ root: temp, port: 0 });
  try {
    await fsp.mkdir(quiz);
    for (const name of ['index.html', 'quiz-data.js']) await fsp.copyFile(path.join(folder, name), path.join(quiz, name));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const port = server.address().port, origin = `http://127.0.0.1:${port}`;
    const request = (url, record) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method: record ? 'POST' : 'GET', headers: record ? { 'Content-Type': 'application/json', Origin: origin } : {} }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject); req.end(record && JSON.stringify(record));
    });
    const readCard = async () => {
      const home = await request('/'); assert.equal(home.status, 200);
      const result = (home.body.match(/<li\b[\s\S]*?<\/li>/g) || []).find(html => html.includes('href="/gate-cse-2007/"'));
      assert(result, 'New paper automatically appears on the home page'); return result;
    };
    assert.match(await readCard(), /data-attempted="false"/);
    assert.equal((await request('/gate-cse-2007/attempt.json')).status, 404);
    const attempt = { version: 1, quizId: data.id, quizSignature: signature(data), submittedAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z', answers: Object.fromEntries(key.map(row => [row.id, correct(row)])), summary: { score: 999 }, results: [] };
    const save = async () => assert.equal((await request('/gate-cse-2007/attempt.json', attempt)).status, 200);
    await save(); assert.match(await readCard(), /Last score: 150 \/ 150/);
    for (const number of linkedSeconds) attempt.answers[`CS-${number - 1}`] = wrong(key[number - 2]);
    await save(); assert.match(await readCard(), /Last score: 127\.5 \/ 150/, 'Server gates all five dependent answers and ignores forged totals');
    attempt.answers = Object.fromEntries(key.map(row => [row.id, correct(row)]));
    for (const number of linkedSeconds) attempt.answers[`CS-${number}`] = wrong(key[number - 1]);
    await save(); assert.match(await readCard(), /Last score: 140 \/ 150/, 'Wrong linked second answers have zero penalty');
    attempt.answers = Object.fromEntries(key.map(row => [row.id, wrong(row)]));
    await save(); const negative = await readCard();
    assert.match(negative, /Last score: -35 \/ 150/);
    assert.match(negative, /<progress class="paper-score-bar" value="0" max="150"/, 'Clamp only the visual negative score');
    attempt.quizSignature = 'stale'; await fsp.writeFile(path.join(quiz, 'attempt.json'), JSON.stringify(attempt));
    assert.match(await readCard(), /Last score unavailable/);
    attempt.quizSignature = signature(data); attempt.answers = Object.fromEntries(key.map(row => [row.id, null]));
    await save(); assert.match(await readCard(), /data-attempted="false"/);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert(path.basename(temp).startsWith('quiz-2007-test-'));
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

(async () => {
  const h = await load(folder), { data, t, ids } = h;
  const noDialogs = rejectFileDialogs(h);
  t.validate(); assert.equal(data.id, 'gate-cse-2007'); assert.equal(data.questions.length, 85); assert.equal(key.length, 85);
  same(data.sourceSha256, fixture.sourceSha256);
  assert.equal(data.questionPaper, 'CS-2007.pdf'); assert.equal(data.answerKey, 'Gate-2007-Cse-answer-key.pdf');
  for (const [name, hash] of Object.entries(fixture.sourceSha256)) {
    assert.equal(path.basename(name), name); assert.match(hash, /^[a-f0-9]{64}$/);
  }
  for (const name of ['quiz.js', 'styles.css', 'theme.js']) assert.equal(sha(path.join(folder, name)), sha(path.join(root, '_template', name)));
  const imageNames = new Set(); let imageCount = 0;
  for (const [i, q] of data.questions.entries()) {
    const expected = key[i];
    assert.equal(q.number, i + 1); assert.equal(expected.number, i + 1); assert.equal(q.id, expected.id);
    assert.equal(q.type, 'mcq'); assert.equal(q.section, 'CS'); assert.equal(q.marks, q.number <= 20 ? 1 : 2);
    close(q.incorrectMarks, linkedSeconds.includes(q.number) ? 0 : -q.marks / 4);
    same(q.acceptedAnswers || [q.correctAnswer], expected.answers);
    same(q.options.map(option => option.id), ['A', 'B', 'C', 'D']);
    assert.equal(q.requiresCorrect, linkedSeconds.includes(q.number) ? `CS-${q.number - 1}` : undefined);
    assert(!q.marksToAll, 'No unsupported awards');
    assert(q.images.length && q.sourceRectangles.length === q.images.length);
    same(q.sourcePages, [...new Set(q.images.map(image => image.page))]);
    if (expected.sourcePages) same(q.sourcePages, expected.sourcePages);
    if (expected.answerKeyPage !== undefined) assert.equal(q.answerKeyPage, expected.answerKeyPage);
    for (let part = 0; part < q.images.length; part++) {
      const im = q.images[part], crop = q.sourceRectangles[part];
      assert(!path.isAbsolute(im.src) && !im.src.includes('..') && !/^[a-z]+:/i.test(im.src) && im.src.startsWith('assets/'));
      assert(im.alt && im.alt.includes(String(q.number)) && im.alt.includes(String(im.page)));
      const pageCount = im.sourceDocument === data.supplementalSource ? fixture.supplementalPageCount : fixture.paperPageCount;
      assert(Object.hasOwn(data.sourceSha256, im.sourceDocument), `${q.id} identifies its original document`);
      assert(Number.isInteger(im.page) && im.page >= 1 && im.page <= pageCount);
      assert.equal(crop.sourceDocument, im.sourceDocument);
      assert.equal(crop.page, im.page); assert.equal(crop.rect.length, 4); assert(crop.rect.every(Number.isFinite));
      assert(crop.rect[0] >= 0 && crop.rect[1] >= 0 && crop.rect[0] < crop.rect[2] && crop.rect[1] < crop.rect[3]);
      const bytes = fs.readFileSync(path.join(folder, im.src));
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert(bytes.readUInt32BE(16) > 100 && bytes.readUInt32BE(20) > 30);
      imageNames.add(im.src); imageCount++;
    }
  }
  assert.equal(fs.readdirSync(path.join(folder, 'assets')).filter(name => /\.png$/i.test(name)).length, imageNames.size, 'Every crop is used');
  const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert(!/^[a-z]+:/i.test(match[1]) && !path.isAbsolute(match[1])); assert(fs.existsSync(path.join(folder, match[1])));
  }
  close(t.summarize(t.grade()).maximum, 150); close(t.summarize(t.grade()).score, 0);
  for (const row of key) t.answers[row.id] = correct(row);
  close(t.summarize(t.grade()).score, 150); assert.equal(t.summarize(t.grade()).counts.correct, 85);
  let optionChecks = 0;
  for (const row of key) for (const option of 'ABCD') {
    reset(h); const q = data.questions[row.number - 1];
    if (q.requiresCorrect) t.answers[q.requiresCorrect] = correct(key[row.number - 2]);
    t.answers[q.id] = option; const result = t.grade()[row.number - 1], accepted = row.answers.includes(option);
    assert.equal(result.outcome, accepted ? 'correct' : 'incorrect'); close(result.earned, accepted ? q.marks : q.incorrectMarks); optionChecks++;
  }
  let linkedChecks = 0;
  for (const number of linkedSeconds) for (const first of ['blank', 'correct', 'wrong']) for (const second of ['blank', 'correct', 'wrong']) {
    reset(h); const firstKey = key[number - 2], secondKey = key[number - 1];
    if (first !== 'blank') t.answers[firstKey.id] = first === 'correct' ? correct(firstKey) : wrong(firstKey);
    if (second !== 'blank') t.answers[secondKey.id] = second === 'correct' ? correct(secondKey) : wrong(secondKey);
    const results = t.grade(), blocked = first !== 'correct' && second !== 'blank';
    const expected = (first === 'correct' ? 2 : first === 'wrong' ? -0.5 : 0) + (first === 'correct' && second === 'correct' ? 2 : 0);
    close(t.summarize(results).score, expected);
    assert.equal(results[number - 1].outcome, second === 'blank' ? 'unanswered' : blocked ? 'blocked' : second === 'correct' ? 'correct' : 'incorrect');
    if (blocked) assert.match(results[number - 1].reason, new RegExp(`CS ${number - 1} was incorrect or unanswered`));
    linkedChecks++;
  }
  reset(h); for (const row of key) t.answers[row.id] = wrong(row);
  close(t.summarize(t.grade()).score, -35); assert.equal(t.summarize(t.grade()).counts.blocked, 5);
  reset(h); t.answers['CS-1'] = correct(key[0]); t.answers['CS-21'] = wrong(key[20]);
  t.answers['CS-76'] = correct(key[75]); t.answers['CS-77'] = correct(key[76]); t.answers['CS-79'] = correct(key[78]);
  close(t.summarize(t.grade()).score, 4.5); assert.equal(t.grade()[78].outcome, 'blocked');

  reset(h); t.renderQuestions();
  assert.equal(ids.questions.querySelectorAll('input').length, 340);
  assert.equal(ids.questions.querySelectorAll('img').length, imageCount);
  assert.equal(ids['nav-groups'].querySelectorAll('.nav-question').length, 85);
  assert.equal(ids['nav-progress'].textContent, '0 attempted · 85 not attempted');
  assert(ids['review-attempt'].disabled); assert.equal(ids['review-attempt'].title, 'This paper has not been attempted before.');
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, 'GET'); assert.equal(h.requests[0].cache, 'no-store');
  await editResponse(h, 'CS-1', correct(key[0])); await flag(h, 1).click(); await flag(h, 2).click();
  assert.equal(ids['nav-progress'].textContent, '1 attempted · 84 not attempted'); assert(ids['review-attempt'].disabled);
  await nav(h, 1).click(); assert(card(h, 1).focused);
  const cached = JSON.parse(h.storage.get(draftKey(h))); same(cached.reviewFlags, ['CS-1', 'CS-2']); assert.equal(cached.signature, signature(data));
  const restored = await load(folder, { storage: h.storage, server: h.server });
  assert.equal(restored.t.answers['CS-1'], correct(key[0])); assert.equal(flag(restored, 1).attrs['aria-pressed'], 'true');
  assert(card(restored, 1).querySelectorAll('input').find(input => input.value === correct(key[0])).checked);
  await card(restored, 1).querySelector('.clear-response').click();
  assert.equal(restored.t.answers['CS-1'], undefined); assert.equal(flag(restored, 1).attrs['aria-pressed'], 'true');
  await editResponse(restored, 'CS-11', correct(key[10])); await editResponse(restored, 'CS-77', correct(key[76]));
  await restored.ids['quiz-form'].fire('submit');
  const submission = restored.server.get(attemptUrl(restored));
  assert.equal(submission.results.length, 85); assert.equal(Object.keys(submission.answers).length, 85); close(submission.summary.score, 1);
  assert.equal(submission.results[76].outcome, 'blocked'); assert(!restored.storage.has(draftKey(restored)));
  same(submission.reviewFlags, ['CS-1', 'CS-2']); assert(!Object.hasOwn(submission, 'timer'));
  assert(submission.results.every(result => !Object.hasOwn(result, 'reviewFlags')));
  assert(!restored.ids['review-attempt'].disabled); assert(!restored.ids['nav-review-legend'].hidden);
  assert.equal(restored.ids['report-list'].querySelectorAll('.result-card').length, 85);
  assert.equal(restored.ids['report-list'].querySelectorAll('img').length, imageCount);
  for (let i = 0; i < 85; i++) {
    const reportText = allText(restored.document.getElementById(`result-card-${i}`));
    assert(reportText.includes('Your answer:') && reportText.includes('Correct answer:') && reportText.includes('marks'));
  }
  assert.match(allText(restored.ids['report-list']), /Not evaluated/);
  await nav(restored, 77).click(); assert(restored.document.getElementById('result-card-76').focused);
  let reportBlob, prints = 0;
  restored.ctx.URL = class extends URL { static createObjectURL(blob) { reportBlob = blob; return 'blob:2007-report'; } static revokeObjectURL() {} };
  restored.window.print = () => prints++;
  await restored.ids['download-report'].click(); assert.match(await reportBlob.text(), /Not evaluated/);
  await restored.ids['print-report'].click(); assert.equal(prints, 1);
  const saved = JSON.stringify(submission);
  const reopened = await load(folder, { storage: restored.storage, server: restored.server });
  assert.equal(Object.keys(reopened.t.answers).length, 0); assert(!reopened.ids['review-attempt'].disabled); assertEditable(reopened);
  await restored.ids['retry-quiz'].click(); assert.equal(Object.keys(restored.t.answers).length, 0); assert.equal(flag(restored, 1).attrs['aria-pressed'], 'false');
  assert.equal(JSON.stringify(restored.server.get(attemptUrl(restored))), saved); assert.equal(restored.requests.filter(request => request.method === 'POST').length, 1);
  await editResponse(restored, 'CS-2', wrong(key[1])); await flag(restored, 2).click();
  const draft = restored.storage.get(draftKey(restored)); submission.summary.score = 999; submission.results = [];
  await restored.ids['review-attempt'].click(); close(restored.t.summarize(restored.t.grade()).score, 1);
  assert.equal(restored.ids['retry-quiz'].textContent, 'Back to quiz'); assert.equal(restored.storage.get(draftKey(restored)), draft);
  same(restored.ids['nav-groups'].querySelectorAll('.marked-review').map(button => data.questions[Number(button.id.replace('nav-question-', ''))].id), submission.reviewFlags);
  await restored.ids['retry-quiz'].click(); assert.equal(restored.t.answers['CS-2'], wrong(key[1])); assert.equal(flag(restored, 2).attrs['aria-pressed'], 'true');
  await restored.ids['clear-answers'].click(); assert.equal(flag(restored, 2).attrs['aria-pressed'], 'false');
  assert.equal(JSON.stringify(restored.server.get(attemptUrl(restored))), JSON.stringify(submission));

  const legacy = { ...cached }; delete legacy.reviewFlags;
  const legacyDraft = await load(folder, { storage: [[draftKey(h), JSON.stringify(legacy)]] }); same(legacyDraft.t.answers, cached.answers);
  for (const invalid of [null, 'CS-1', ['CS-1', 'CS-1'], ['CS-999'], [1]]) {
    const bad = await load(folder, { storage: [[draftKey(h), JSON.stringify({ ...cached, reviewFlags: invalid })]] });
    assert.equal(Object.keys(bad.t.answers).length, 0); assertEditable(bad);
  }
  const failed = await load(folder, { fetch: (request, perform, response) => request.method === 'POST' ? response(500, { error: 'Fixture failure' }) : perform() });
  await editResponse(failed, 'CS-1', correct(key[0])); await flag(failed, 1).click(); await failed.ids['quiz-form'].fire('submit');
  assert(failed.storage.has(draftKey(failed))); assert(!failed.ids.report.hidden); assert.equal(flag(failed, 1).attrs['aria-pressed'], 'true'); assert(failed.ids['review-attempt'].disabled);
  const failedReopen = await load(folder, { storage: failed.storage }); assert.equal(failedReopen.t.answers['CS-1'], correct(key[0])); assert.equal(flag(failedReopen, 1).attrs['aria-pressed'], 'true');
  const unavailable = await load(folder, { storageUnavailable: true }), noUnavailableDialogs = rejectFileDialogs(unavailable);
  await editResponse(unavailable, 'CS-1', correct(key[0])); await unavailable.ids['quiz-form'].fire('submit'); await unavailable.ids['retry-quiz'].click();
  assert.equal(Object.keys(unavailable.t.answers).length, 0); assert.match(unavailable.ids['status-message'].textContent, /Could not cache/); assertEditable(unavailable);
  const otherKey = 'practice-quiz:another-paper', otherDraft = '{"answers":{"CS-1":"A"}}';
  restored.storage.set(otherKey, otherDraft);
  vm.runInContext(fs.readFileSync(path.join(folder, 'theme.js'), 'utf8'), restored.ctx); restored.document.DOMContentLoaded();
  const beforeTheme = restored.storage.get(draftKey(restored)); await restored.ids['theme-toggle'].click();
  assert.equal(restored.storage.get('practice-quiz:theme'), 'dark'); assert.equal(restored.storage.get(draftKey(restored)), beforeTheme); assert.equal(restored.storage.get(otherKey), otherDraft);
  noDialogs(); noUnavailableDialogs();
  await checkHome(data);
  console.log(`PASS: GATE 2007 independent 85-entry key, ${optionChecks} MCQ choices, ${linkedChecks} linked-pair combinations, provenance metadata, ${imageNames.size} PNG assets/${imageCount} image parts, 150-mark blank/perfect/mixed/−35 scores, question/report maps, complete reports/save/print, draft/flags/reload/clear, Submit/Retry/review, failed save/storage, legacy drafts/theme isolation, disposable-server recomputation/linked gates/negative clamp/stale record. No real attempt written.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  try { same(attempts(), originalAttempts); } catch (error) { console.error('Existing user attempts changed during tests:', error.message); process.exitCode = 1; }
});
