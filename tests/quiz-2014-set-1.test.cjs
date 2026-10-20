const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const { load, editResponse, draftKey, attemptUrl, rejectFileDialogs, assertEditable } = require('./helpers/quiz-harness.cjs');

// All browser state is simulated in memory. The independent key fixture is
// tracked under tests, so the build's temporary PDF audit can be deleted.
const path = require('path');
const crypto = require('crypto');
const FOLDER = path.resolve(__dirname, '../gate-cse-2014-set-1');
const TEMPLATE = path.resolve(__dirname, '../_template');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gate-cse-2014-set-1-key.json'), 'utf8'));
const VERIFIED_KEY = FIXTURE.questions.map(row => ({
  ...row, type: row.type.toLowerCase(), ranges: row.correctRanges,
  answer: row.acceptedAnswers || (row.correctAnswer ? [row.correctAnswer] : null)
}));
const same = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const questionIndex = (h, id) => h.data.questions.findIndex(q => q.id === id);
const card = (h, id) => h.document.getElementById(`question-card-${questionIndex(h, id)}`);
const nav = (h, id) => h.document.getElementById(`nav-question-${questionIndex(h, id)}`);
const reviewToggle = (h, id) => h.document.getElementById(`mark-review-${questionIndex(h, id)}`);
async function markReview(h, id) {
  const button = reviewToggle(h, id), actions = card(h, id).querySelector('.question-actions');
  assert(button && button.className.split(' ').includes('mark-review'), `${id} review toggle`);
  assert(actions && actions.children.includes(button) && actions.querySelector('.clear-response'), `${id} toggle beside Clear response`);
  await button.click();
}
function assertReviewMark(h, id, marked, icon = marked ? '★' : null) {
  assert.equal(reviewToggle(h, id).attrs['aria-pressed'], String(marked), `${id} accessible toggle state`);
  if (!h.ids['quiz-form'].hidden) assert.equal(nav(h, id).className.split(' ').includes('marked-review'), marked, `${id} map review marker`);
  if (icon !== null && !h.ids['quiz-form'].hidden) assert.equal(nav(h, id).querySelector('.nav-state-icon').textContent, icon, `${id} map icon`);
}
const result = (h, id) => h.t.grade().find(row => row.question.id === id);
function reset(h) {
  Object.keys(h.t.answers).forEach(id => delete h.t.answers[id]);
  h.t.setSubmitted('');
}
const correctResponse = row => row.type === 'nat' ? String(row.ranges[0].min) : row.answer[0];
const wrongResponse = row => row.type === 'nat'
  ? String(Math.max(...row.ranges.map(range => range.max)) + 1)
  : [...'ABCD'].find(letter => !row.answer.includes(letter));
function allText(node) { return [node.textContent, ...node.children.map(allText)].join(' '); }

async function testHomeIntegration(data) {
  const fsp = fs.promises, os = require('os'), http = require('http');
  const { createServer } = require('../server.cjs');
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-2014-set-1-test-'));
  const quiz = path.join(tempRoot, 'gate-cse-2014-set-1'), server = createServer({ root: tempRoot, port: 0 });
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
      const card = (home.body.match(/<li\b[\s\S]*?<\/li>/g) || []).find(item => item.includes('href="/gate-cse-2014-set-1/"'));
      assert(card, 'Home includes the 2014-set-1 paper'); return card;
    };
    assert.match(await readCard(), /data-attempted="false"/);
    assert.equal((await request('/gate-cse-2014-set-1/attempt.json')).status, 404, 'Opening home creates no attempt');
    const answers = Object.fromEntries(VERIFIED_KEY.map(row => [row.id, correctResponse(row)]));
    answers['CS-2'] = '0.27';
    const attempt = { version: 1, quizId: data.id, quizTitle: data.title,
      quizSignature: JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }),
      submittedAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
      answers, summary: { score: -999 }, results: [] };
    assert.equal((await request('/gate-cse-2014-set-1/attempt.json', attempt)).status, 200);
    let card = await readCard(); assert.match(card, /data-attempted="true"/); assert.match(card, /Last score: 100 \/ 100/);
    assert.match(card, /<progress class="paper-score-bar" value="100" max="100"/); assert(!card.includes('-999'));
    answers['CS-2'] = '0.2701'; assert.equal((await request('/gate-cse-2014-set-1/attempt.json', attempt)).status, 200);
    assert.match(await readCard(), /Last score: 99 \/ 100/, 'Server enforces CS-2 upper boundary');
    const wrong = { ...attempt, answers: Object.fromEntries(VERIFIED_KEY.map(row => [row.id, wrongResponse(row)])) };
    assert.equal((await request('/gate-cse-2014-set-1/attempt.json', wrong)).status, 200);
    card = await readCard(); const wrongScore = Number(VERIFIED_KEY.reduce((sum, row) => sum + row.incorrectMarks, 0).toFixed(4));
    assert(card.includes(`Last score: ${wrongScore} / 100`), 'Home preserves negative 2014-set-1 score');
    assert.match(card, /<progress class="paper-score-bar" value="0" max="100"/, 'Only visual bar clamps at zero');
    assert.equal((await request('/gate-cse-2014-set-1/attempt.json', { ...attempt, quizSignature: 'stale key' })).status, 200);
    card = await readCard(); assert.match(card, /data-attempted="true"/); assert.match(card, /Last score unavailable/);
    assert.match(card, /class="paper-score-bar" hidden/, 'Stale attempted file has no score bar');
  } finally {
    if (listening) await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(tempRoot), parent = path.resolve(os.tmpdir()), relative = path.relative(parent, resolved);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(resolved).startsWith('quiz-2014-set-1-test-'), 'Cleanup stays inside the created temp fixture');
    await fsp.rm(resolved, { recursive: true, force: true });
  }
}

(async () => {
  const h = await load(FOLDER), { t, data, ids } = h;
  const noDialogs = rejectFileDialogs(h);
  assert.equal(data.id, 'gate-cse-2014-set-1-session-7'); assert.equal(data.title, 'GATE CSE 2014 - Set 1');
  assert.equal(data.questions.length, FIXTURE.questionCount); assert.equal(VERIFIED_KEY.length, 65);
  assert.equal(data.cropDpi, 240, 'Crops retain the recorded rendering resolution');
  same(data.questions.reduce((counts, q) => ({ ...counts, [q.type]: (counts[q.type] || 0) + 1 }), {}), { mcq: 40, nat: 25 });
  same(FIXTURE.typeCounts, { MCQ: 40, NAT: 25 });
  t.validate(); assertEditable(h);
  same(data.questions.map(q => q.id), [
    ...Array.from({ length: 10 }, (_, i) => `GA-${i + 1}`),
    ...Array.from({ length: 55 }, (_, i) => `CS-${i + 1}`)
  ], 'Section-aware original question order');
  assert.equal(new Set(data.questions.map(q => q.id)).size, 65);
  assert.equal(data.questions.reduce((sum, q) => sum + q.marks, 0), FIXTURE.totalMarks);
  for (const name of ['quiz.js', 'theme.js', 'styles.css']) {
    assert.equal(sha256(path.join(FOLDER, name)), sha256(path.join(TEMPLATE, name)), `${name} matches shared runtime`);
  }
  same(data.sourceSha256, FIXTURE.sourceSha256, 'Provenance preserves verified original PDF hashes');
  same(data.sourcePageCounts, { questionPaper: 20, answerKey: 1 }, 'Provenance preserves both source page counts');
  assert(data.watermarkRemoval && data.watermarkRemoval.originalsUnchanged === true, 'Watermark removal preserves both supplied originals');
  assert.equal(data.watermarkRemoval.formInvocationsRemoved, 16, 'Only the 16 marked watermark Form invocations were removed');
  same(data.watermarkRemoval.pages, Array.from({ length: 16 }, (_, i) => i + 5), 'Removal covers original question pages 5 through 20');
  same(data.watermarkRemoval.labels, ['GA07 (GATE 2014)', 'CS01 (GATE 2014)'], 'Removal identifies watermark labels, not question text');
  assert.match(data.watermarkRemoval.method, /Form XObject/i);
  assert.match(data.cropMethod, /Form/i, 'Crops record the clean derivative rendering method');
  for (const name of [data.questionPaper, data.answerKey]) {
    assert(name && !path.isAbsolute(name) && !name.includes('..'), 'Original filename provenance is relative');
    assert(!fs.existsSync(path.join(FOLDER, name)), `${name} is not duplicated in the quiz folder`);
  }
  assert.equal(data.questionPaper, 'GATE2014-Set-1.pdf'); assert.equal(data.answerKey, '2014Key_CS_01.pdf');
  assert(!fs.readdirSync(FOLDER).some(name => /\.pdf$/i.test(name)), 'Quiz folder contains crops and provenance without source PDF copies');
  let imageCount = 0; const imagePaths = new Set();
  for (let i = 0; i < data.questions.length; i++) {
    const q = data.questions[i], key = VERIFIED_KEY[i];
    assert.equal(q.id, key.id); assert.equal(q.type, key.type, `${q.id} type`);
    assert.equal(q.marks, key.marks, `${q.id} marks`);
    assert.equal(q.incorrectMarks, key.incorrectMarks, `${q.id} independent penalty`);
    assert.equal(q.incorrectMarks, key.type === 'mcq' ? -key.marks / 3 : 0, `${q.id} full-precision marking rule`);
    assert.equal(q.section, key.section); assert.equal(q.number, key.number);
    assert.equal(q.displayLabel, `${key.section} ${key.number}`);
    assert.equal(q.answerKeyPage, key.answerKeyPage, `${q.id} key source page`);
    assert(q.answerKeyPage >= 1 && q.answerKeyPage <= FIXTURE.keyPageCount);
    assert(!q.marksToAll, `${q.id} has no unverified MTA`);
    assert(!q.requiresCorrect, `${q.id} has no unverified linked dependency`);
    assert.equal(q.text, '', `${q.id} uses original complete crops rather than uncertain OCR`);
    if (key.type === 'nat') same(q.correctRanges, key.ranges, `${q.id} inclusive numerical key`);
    else {
      same(q.options.map(option => option.id), ['A', 'B', 'C', 'D'], `${q.id} original option order`);
      same(q.acceptedAnswers || [q.correctAnswer], key.answer, `${q.id} single-choice official key`);
    }
    assert(q.images.length && q.sourcePages.length, `${q.id} original image content`);
    same(q.sourcePages, key.sourcePages, `${q.id} independently verified source pages`);
    same(q.sourcePages, [...new Set(q.images.map(image => image.page))], `${q.id} paper page metadata`);
    assert.equal(q.sourceRectangles.length, q.images.length, `${q.id} crop metadata matches parts`);
    for (let part = 0; part < q.images.length; part++) {
      const image = q.images[part], crop = q.sourceRectangles[part];
      assert(!path.isAbsolute(image.src) && !image.src.includes('..') && !/^[a-z]+:/i.test(image.src), `${q.id} relative local image`);
      assert(image.src.startsWith('assets/') && !imagePaths.has(image.src), `${q.id} unique crop`);
      assert(image.alt && Number.isInteger(image.page) && image.page >= 1 && image.page <= FIXTURE.paperPageCount, `${q.id} image accessibility/page`);
      assert.equal(crop.page, image.page); assert.equal(crop.rect.length, 4);
      assert(crop.rect.every(Number.isFinite), `${q.id} finite PDF coordinates`);
      assert(crop.rect[0] >= 0 && crop.rect[1] >= 0 && crop.rect[2] > crop.rect[0] && crop.rect[3] > crop.rect[1], `${q.id} nonempty PDF rectangle`);
      const pageWidth = image.page <= 6 ? 595.44 : 612, pageHeight = image.page <= 6 ? 841.68 : 792;
      assert(crop.rect[2] <= pageWidth && crop.rect[3] <= pageHeight, `${q.id} rectangle fits original PDF page`);
      const pageSize = data.sourcePageSizes.find(row => row.page === image.page);
      close(pageSize.width, pageWidth, `${q.id} original page width`);
      close(pageSize.height, pageHeight, `${q.id} original page height`);
      const bytes = fs.readFileSync(path.join(FOLDER, image.src));
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${q.id} lossless PNG`);
      assert(bytes.readUInt32BE(16) > 100 && bytes.readUInt32BE(20) > 40, `${q.id} readable nonempty dimensions`);
      const scaleX = Math.ceil(pageWidth * data.cropDpi / 72) / pageWidth;
      const scaleY = Math.ceil(pageHeight * data.cropDpi / 72) / pageHeight;
      assert.equal(bytes.readUInt32BE(16), Math.ceil(crop.rect[2] * scaleX) - Math.floor(crop.rect[0] * scaleX), `${q.id} crop width matches PDF coordinates without stretching`);
      assert.equal(bytes.readUInt32BE(20), Math.ceil(crop.rect[3] * scaleY) - Math.floor(crop.rect[1] * scaleY), `${q.id} crop height matches PDF coordinates without stretching`);
      imagePaths.add(image.src); imageCount++;
    }
  }
  assert.equal(imageCount, 65, 'All 65 original question blocks are single-page crops');
  assert.equal(fs.readdirSync(path.join(FOLDER, 'assets')).filter(name => /\.png$/i.test(name)).length, imageCount, 'No orphaned PNG crops');
  for (const [id, ranges] of Object.entries({
    'CS-2': [{ min: 0.24, max: 0.27 }], 'CS-26': [{ min: 28, max: 30 }],
    'CS-27': [{ min: 1100, max: 1300 }], 'CS-39': [{ min: 147.1, max: 148.1 }],
    'CS-46': [{ min: -2, max: -2 }], 'CS-49': [{ min: 88.9, max: 89.1 }]
  })) same(data.questions.find(q => q.id === id).correctRanges, ranges, `${id} preserves the supplied inclusive range`);
  const html = fs.readFileSync(path.join(FOLDER, 'index.html'), 'utf8');
  assert.match(html, /<a\b[^>]*\bid="quiz-home"[^>]*\bhref="\/"/, 'Home returns to the stable origin quiz list');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (match[1] === '/') continue;
    assert(!/^[a-z]+:/i.test(match[1]) && !path.isAbsolute(match[1]), 'HTML resources are local');
    assert(fs.existsSync(path.join(FOLDER, match[1])), `Missing ${match[1]}`);
  }
  assert(ids['review-attempt'] && ids['review-attempt'].disabled, 'No saved attempt disables Review');
  assert.equal(ids['review-attempt'].title, 'This paper has not been attempted before.');
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, 'GET');
  assert.equal(h.requests[0].url, attemptUrl(h)); assert.equal(h.requests[0].cache, 'no-store');
  const blankSaved = await load(FOLDER, { server: [[attemptUrl(h), { answers: Object.fromEntries(data.questions.map(q => [q.id, null])) }]] });
  assert(blankSaved.ids['review-attempt'].disabled, 'All-null saved answers disable Review');
  assert.equal(ids.questions.querySelectorAll('fieldset').length, 65);
  assert.equal(ids.questions.querySelectorAll('img').length, imageCount);
  assert.equal(ids['nav-groups'].querySelectorAll('.nav-question').length, 65);
  same(ids['nav-groups'].querySelectorAll('h3').map(node => node.textContent), ['GA', 'CS']);
  assert.equal(ids['nav-progress'].textContent, '0 attempted · 65 not attempted');

  // Scores and outcomes come from the separate verified key.
  let summary = t.summarize(t.grade());
  assert.equal(summary.score, 0); assert.equal(summary.maximum, 100);
  same(summary.counts, { correct: 0, incorrect: 0, unanswered: 65, awarded: 0 });
  for (const row of VERIFIED_KEY) t.answers[row.id] = correctResponse(row);
  summary = t.summarize(t.grade()); assert.equal(summary.score, 100);
  same(summary.counts, { correct: 65, incorrect: 0, unanswered: 0, awarded: 0 });
  for (const row of VERIFIED_KEY) t.answers[row.id] = wrongResponse(row);
  summary = t.summarize(t.grade());
  close(summary.score, VERIFIED_KEY.reduce((sum, row) => sum + row.incorrectMarks, 0), 'All-wrong score');
  close(summary.score, -58 / 3, '2014 full-precision all-wrong total');
  same(summary.counts, { correct: 0, incorrect: 65, unanswered: 0, awarded: 0 });
  reset(h); let mixedScore = 0; const mixedCounts = { correct: 0, incorrect: 0, unanswered: 0, awarded: 0 };
  VERIFIED_KEY.forEach((row, i) => {
    if (i % 3 === 0) { t.answers[row.id] = correctResponse(row); mixedScore += row.marks; mixedCounts.correct++; }
    else if (i % 3 === 1) { t.answers[row.id] = wrongResponse(row); mixedScore += row.incorrectMarks; mixedCounts.incorrect++; }
    else mixedCounts.unanswered++;
  });
  summary = t.summarize(t.grade()); close(summary.score, mixedScore, 'Mixed score'); same(summary.counts, mixedCounts);

  let mcqOptionChecks = 0, natBoundaryChecks = 0;
  for (const row of VERIFIED_KEY) {
    if (row.type === 'nat') {
      for (const range of row.ranges) for (const value of [range.min, range.max, range.min - 0.0001, range.max + 0.0001]) {
        t.answers[row.id] = String(value);
        const correct = row.ranges.some(r => value >= r.min && value <= r.max), graded = result(h, row.id);
        assert.equal(graded.outcome, correct ? 'correct' : 'incorrect', `${row.id} endpoint/outside ${value}`);
        assert.equal(graded.earned, correct ? row.marks : 0); natBoundaryChecks++;
      }
    } else for (const option of 'ABCD') {
      t.answers[row.id] = option; const correct = row.answer.includes(option), graded = result(h, row.id);
      assert.equal(graded.outcome, correct ? 'correct' : 'incorrect', `${row.id} option ${option}`);
      assert.equal(graded.earned, correct ? row.marks : row.incorrectMarks); mcqOptionChecks++;
    }
  }
  for (const [id, values] of Object.entries({
    'CS-2': ['0.23999999999999996', '0.2700000000000001'],
    'CS-26': ['27.999999999999996', '30.000000000000004'],
    'CS-27': ['1099.9999999999998', '1300.0000000000002'],
    'CS-39': ['147.09999999999997', '148.10000000000002'],
    'CS-46': ['-2.0000000000000004', '-1.9999999999999998'],
    'CS-49': ['88.89999999999999', '89.10000000000001']
  })) for (const value of values) {
    t.answers[id] = value; assert.equal(result(h, id).outcome, 'incorrect', `${id} rejects immediately outside ${value}`);
  }
  for (const invalid of ['-', '1/2', '1,000', '1e2', '0x10', 'NaN', 'Infinity']) assert.equal(t.numericValue(invalid), null, `Reject numerical input ${invalid}`);
  for (const [raw, number] of [['.5', 0.5], ['12.', 12], ['-2.5', -2.5], ['+4', 4]]) assert.equal(t.numericValue(raw), number, `Accept decimal ${raw}`);

  // Raw draft, invalid submit, flags, reload, and successful disk-save lifecycle.
  reset(h); t.renderQuestions();
  const mcq = VERIFIED_KEY.find(row => row.type === 'mcq'), nat = VERIFIED_KEY.find(row => row.type === 'nat');
  await editResponse(h, mcq.id, correctResponse(mcq)); await editResponse(h, nat.id, '-');
  await markReview(h, mcq.id); await markReview(h, nat.id); await markReview(h, 'GA-2');
  assertReviewMark(h, mcq.id, true); assertReviewMark(h, 'GA-2', true); assertReviewMark(h, nat.id, true, '!');
  assert(!Object.hasOwn(t.answers, 'GA-2'), 'A flag does not count as an answer');
  assert.equal(ids['nav-progress'].textContent, '2 attempted · 63 not attempted');
  assert(nav(h, nat.id).className.includes('needs-check'));
  await nav(h, nat.id).click(); assert(card(h, nat.id).focused);
  assert.equal(h.requests.length, 1, 'Edits and flags write no saved attempt');
  const cached = JSON.parse(h.storage.get(draftKey(h)));
  same([...cached.reviewFlags].sort(), [mcq.id, nat.id, 'GA-2'].sort(), 'Draft stores active practice flags');
  assert.equal(cached.answers[nat.id], '-'); assert(cached.updatedAt);
  assert.equal(cached.signature, JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }));
  assert(!Object.hasOwn(cached, 'score') && !Object.hasOwn(cached, 'results'));
  const restored = await load(FOLDER, { storage: h.storage });
  same(restored.t.answers, cached.answers); assertReviewMark(restored, mcq.id, true); assertReviewMark(restored, nat.id, true, '!');
  assert.equal(card(restored, nat.id).querySelector('input').value, '-');
  assert.equal(card(restored, nat.id).querySelector('input').attrs['aria-invalid'], 'true');
  assert(card(restored, mcq.id).querySelectorAll('input').find(input => input.value === correctResponse(mcq)).checked);
  const beforeInvalid = restored.storage.get(draftKey(restored));
  await restored.ids['quiz-form'].fire('submit');
  assert(restored.ids.report.hidden); assert(card(restored, nat.id).querySelector('input').focused);
  assert.equal(restored.storage.get(draftKey(restored)), beforeInvalid); assert.equal(restored.requests.length, 1);
  assertReviewMark(restored, nat.id, true, '!');
  await editResponse(restored, nat.id, correctResponse(nat)); await restored.ids['quiz-form'].fire('submit');
  assert(!restored.ids.report.hidden && restored.ids['quiz-form'].hidden);
  assert(!restored.storage.has(draftKey(restored))); assert(!restored.ids['review-attempt'].disabled);
  assert.equal(restored.requests.length, 2); assert.equal(restored.requests[1].method, 'POST');
  assert.equal(restored.requests[1].url, attemptUrl(restored));
  for (const id of [mcq.id, nat.id, 'GA-2']) assertReviewMark(restored, id, false);
  const submission = restored.server.get(attemptUrl(restored));
  same(Object.keys(submission).sort(), ['answers', 'quizId', 'quizSignature', 'quizTitle', 'results', 'reviewFlags', 'submittedAt', 'summary', 'updatedAt', 'version'].sort(), 'Version 1 envelope includes report review markers');
  assert.equal(submission.quizId, data.id); assert.equal(submission.version, 1);
  assert.equal(submission.quizSignature, JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }));
  assert.equal(Object.keys(submission.answers).length, 65); assert.equal(submission.results.length, 65);
  same([...submission.reviewFlags].sort(), [mcq.id, nat.id, 'GA-2'].sort(), 'Submission retains its report review markers');
  assert(!Object.hasOwn(submission.answers, 'reviewFlags'));
  assert(submission.results.every(row => !Object.hasOwn(row, 'reviewFlags')));
  assert.equal(submission.answers[mcq.id], correctResponse(mcq)); assert.equal(submission.answers[nat.id], correctResponse(nat));
  assert.equal(submission.answers['GA-2'], null); assert.equal(submission.summary.score, mcq.marks + nat.marks);
  assert.equal(restored.ids['report-list'].querySelectorAll('.result-card').length, 65);
  assert.equal(restored.ids['report-list'].querySelectorAll('img').length, imageCount);
  assert(!restored.ids['nav-review-legend'].hidden, 'Reports show the review star legend');
  for (let i = 0; i < data.questions.length; i++) {
    const text = allText(restored.document.getElementById(`result-card-${i}`));
    assert(text.includes('Your answer:') && text.includes('Correct answer:') && text.includes('marks'), `${data.questions[i].id} complete report`);
    assert(text.includes(restored.t.plainAnswer(data.questions[i], data.questions[i].correctAnswer, true)), `${data.questions[i].id} answer in report`);
  }
  await nav(restored, nat.id).click(); assert(restored.document.getElementById(`result-card-${questionIndex(restored, nat.id)}`).focused);
  const fresh = await load(FOLDER, { storage: restored.storage, server: restored.server });
  assert.equal(Object.keys(fresh.t.answers).length, 0); assert(fresh.ids.report.hidden); assertEditable(fresh);
  const savedDisk = JSON.stringify(submission);
  await restored.ids['retry-quiz'].click();
  assert.equal(restored.requests.length, 2); assert.equal(JSON.stringify(restored.server.get(attemptUrl(restored))), savedDisk, 'Retry preserves submission');
  assert.equal(Object.keys(restored.t.answers).length, 0); assert(restored.ids.report.hidden); assertEditable(restored);
  assert.equal(restored.ids['nav-progress'].textContent, '0 attempted · 65 not attempted');
  await editResponse(restored, nat.id, '0'); await markReview(restored, nat.id);
  await card(restored, nat.id).querySelector('.clear-response').click();
  assert.equal(Object.keys(restored.t.answers).length, 0); assertReviewMark(restored, nat.id, true);
  same(JSON.parse(restored.storage.get(draftKey(restored))).reviewFlags, [nat.id], 'Clear response preserves flag');
  const markOnly = await load(FOLDER, { storage: restored.storage });
  assert.equal(Object.keys(markOnly.t.answers).length, 0); assertReviewMark(markOnly, nat.id, true);
  assert.equal(markOnly.ids['nav-progress'].textContent, '0 attempted · 65 not attempted');
  await markReview(markOnly, nat.id); assertReviewMark(markOnly, nat.id, false, '·');
  await editResponse(restored, mcq.id, correctResponse(mcq)); await restored.ids['clear-answers'].click();
  assert.equal(restored.requests.length, 2, 'Clear never writes submission'); assertReviewMark(restored, nat.id, false);
  const cleared = await load(FOLDER, { storage: restored.storage }); assert.equal(Object.keys(cleared.t.answers).length, 0);

  // Review reads the submission and recomputes its score while keeping draft.
  const tampered = JSON.parse(savedDisk); tampered.summary.score = -999; tampered.results = [];
  const reviewing = await load(FOLDER, { server: [[attemptUrl(h), tampered]] });
  assert(!reviewing.ids['review-attempt'].disabled);
  await editResponse(reviewing, mcq.id, wrongResponse(mcq)); await editResponse(reviewing, nat.id, '-');
  await markReview(reviewing, mcq.id); await markReview(reviewing, nat.id);
  const activeDraft = reviewing.storage.get(draftKey(reviewing));
  await reviewing.ids['review-attempt'].click();
  assert.equal(reviewing.requests.length, 2); assert.equal(reviewing.requests[1].method, 'GET'); assert.equal(reviewing.requests[1].cache, 'no-store');
  assert(!reviewing.ids.report.hidden); assert.equal(reviewing.ids['retry-quiz'].textContent, 'Back to quiz');
  assert.equal(reviewing.t.answers[mcq.id], correctResponse(mcq));
  assert.equal(reviewing.t.summarize(reviewing.t.grade()).score, mcq.marks + nat.marks, 'Review ignores stored score/results');
  same(reviewing.ids['nav-groups'].querySelectorAll('.marked-review').map(button => data.questions[Number(button.id.replace('nav-question-', ''))].id).sort(), [...submission.reviewFlags].sort(), 'Report uses saved review markers');
  assert.equal(reviewing.storage.get(draftKey(reviewing)), activeDraft);
  await reviewing.ids['retry-quiz'].click();
  assert(reviewing.ids.report.hidden); assert.equal(reviewing.t.answers[mcq.id], wrongResponse(mcq)); assert.equal(reviewing.t.answers[nat.id], '-');
  assert.equal(reviewing.storage.get(draftKey(reviewing)), activeDraft); assert.equal(reviewing.requests.length, 2);
  assertReviewMark(reviewing, mcq.id, true); assertReviewMark(reviewing, nat.id, true, '!'); assertEditable(reviewing);

  // Only compatible valid drafts restore; old drafts without flags still work.
  const legacy = { ...cached }; delete legacy.reviewFlags;
  const legacyDraft = await load(FOLDER, { storage: [[draftKey(h), JSON.stringify(legacy)]] });
  same(legacyDraft.t.answers, cached.answers); assert(!legacyDraft.ids['nav-groups'].querySelectorAll('.marked-review').length);
  for (const bad of [
    '{bad', JSON.stringify({ ...cached, signature: 'another paper' }), JSON.stringify({ ...cached, updatedAt: 'bad date' }),
    JSON.stringify({ ...cached, answers: { 'CS-999': 'A' } }),
    ...[null, 'GA-1', ['GA-1', 'GA-1'], ['CS-999'], [1]].map(reviewFlags => JSON.stringify({ ...cached, reviewFlags }))
  ]) {
    const invalid = await load(FOLDER, { storage: [[draftKey(h), bad]] });
    assert.equal(Object.keys(invalid.t.answers).length, 0); assert(!invalid.storage.has(draftKey(h))); assertEditable(invalid);
  }
  const unavailable = await load(FOLDER, { storageUnavailable: true }), unavailableDialogs = rejectFileDialogs(unavailable);
  await editResponse(unavailable, mcq.id, correctResponse(mcq)); await markReview(unavailable, mcq.id);
  assert(/unavailable|could not|cannot|failed/i.test(unavailable.ids['status-message'].textContent));
  await unavailable.ids['quiz-form'].fire('submit'); assert(!unavailable.ids.report.hidden);
  await unavailable.ids['retry-quiz'].click(); assertEditable(unavailable); assert.equal(Object.keys(unavailable.t.answers).length, 0);
  assertReviewMark(unavailable, mcq.id, false);
  assert.equal(unavailable.ids['status-message'].textContent, 'Could not cache your progress. Keep this tab open to retain your answers.');
  assert(!unavailable.ids['status-message'].hidden && unavailable.ids['status-message'].className.split(' ').includes('error'));
  const failedSave = await load(FOLDER, { fetch: (request, perform, response) => request.method === 'POST' ? response(500, { error: 'Simulated write failure' }) : perform() });
  await editResponse(failedSave, mcq.id, correctResponse(mcq)); await markReview(failedSave, mcq.id);
  const failedCache = JSON.parse(failedSave.storage.get(draftKey(failedSave))); await failedSave.ids['quiz-form'].fire('submit');
  assert(!failedSave.ids.report.hidden);
  const retainedCache = JSON.parse(failedSave.storage.get(draftKey(failedSave)));
  same(retainedCache.answers, failedCache.answers, 'Failed save preserves responses');
  same(retainedCache.reviewFlags, failedCache.reviewFlags, 'Failed save preserves flags');
  assert.equal(retainedCache.signature, failedCache.signature);
  assert.equal(reviewToggle(failedSave, mcq.id).attrs['aria-pressed'], 'true'); assert(!failedSave.server.size);
  same(JSON.parse(failedSave.requests.at(-1).body).reviewFlags, [mcq.id]);
  const failedReopen = await load(FOLDER, { storage: failedSave.storage });
  assertReviewMark(failedReopen, mcq.id, true); assert.equal(failedReopen.t.answers[mcq.id], correctResponse(mcq));
  await failedSave.ids['retry-quiz'].click(); assertReviewMark(failedSave, mcq.id, false); assert(!failedSave.server.size);

  // Separate paper drafts and remembered theme are independent.
  const otherDraftKey = 'practice-quiz:another-paper';
  const otherDraft = JSON.stringify({ answers: { 'GA-1': 'C' }, reviewFlags: ['CS-1'] });
  const shared = new Map([[otherDraftKey, otherDraft]]);
  const current = await load(FOLDER, { storage: shared }); assert.equal(Object.keys(current.t.answers).length, 0);
  await editResponse(current, mcq.id, correctResponse(mcq)); await markReview(current, mcq.id);
  vm.runInContext(fs.readFileSync(path.join(FOLDER, 'theme.js'), 'utf8'), current.ctx); current.document.DOMContentLoaded();
  const beforeTheme = shared.get(draftKey(current)); await current.ids['theme-toggle'].click();
  assert.equal(shared.get('practice-quiz:theme'), 'dark'); assert.equal(shared.get(draftKey(current)), beforeTheme);
  await current.ids['quiz-form'].fire('submit'); assert(!shared.has(draftKey(current)));
  assert.equal(shared.get(otherDraftKey), otherDraft); assert.equal(shared.get('practice-quiz:theme'), 'dark');
  noDialogs(); unavailableDialogs();
  await testHomeIntegration(data);
  console.log(`PASS: 2014 Set 1 independent 65-question key, 40 MCQ/25 NAT, verified original PDF provenance hashes/no duplicated PDFs, scoped vector watermark removal, ${imageCount} PNG crops/source metadata/local paths/shared runtime, blank/perfect/wrong/mixed scores, ${mcqOptionChecks} MCQ options, ${natBoundaryChecks} NAT endpoint/outside checks plus strict outside-range checks, maps/full reports, raw draft/reload/invalid Submit, flags/clear/retry, failed/successful saves, saved review/back and score recomputation, legacy/invalid drafts, storage failures, separate paper/theme state, no native file APIs, temporary-server home score/NAT boundary/negative score/stale record. All attempts simulated or in disposable fixtures.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
