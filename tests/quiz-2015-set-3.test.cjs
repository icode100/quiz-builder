const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { load, editResponse, draftKey, attemptUrl, rejectFileDialogs, assertEditable } = require('./helpers/quiz-harness.cjs');

// Keys are independently transcribed from the supplied combined question/key
// PDF. All browser state is simulated; server writes use a disposable directory.
const FOLDER = path.resolve(__dirname, '../gate-cse-2015-set-3');
const TEMPLATE = path.resolve(__dirname, '../_template');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gate-cse-2015-set-3-key.json'), 'utf8'));
const KEY = FIXTURE.questions.map(row => ({ ...row, type: row.type.toLowerCase() }));
const BOUNDARY_KEY = KEY.find(row => row.type === 'nat' && row.correctRanges.some(range => range.min !== range.max)) || KEY.find(row => row.type === 'nat' && row.marks === 2);
const EXCLUSION_KEY = KEY.find(row => row.type === 'nat' && row.marks === 2 && row.correctRanges.some(range => range.min === 0 && range.max === 0));
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const indexOf = (h, id) => h.data.questions.findIndex(question => question.id === id);
const card = (h, id) => h.document.getElementById(`question-card-${indexOf(h, id)}`);
const map = (h, id) => h.document.getElementById(`nav-question-${indexOf(h, id)}`);
const exclude = (h, id) => h.document.getElementById(`out-of-syllabus-${indexOf(h, id)}`).click();
const flag = (h, id) => h.document.getElementById(`mark-review-${indexOf(h, id)}`).click();
const accepted = row => row.acceptedAnswers || [row.correctAnswer];
const correct = row => row.type === 'nat' ? String(row.correctRanges[0].min) : accepted(row)[0];
const wrong = row => row.type === 'nat' ? String(Math.max(...row.correctRanges.map(range => range.max)) + 1) : [...'ABCD'].find(option => !accepted(row).includes(option));
const posts = h => h.requests.filter(request => request.method === 'POST');
const reset = h => { Object.keys(h.t.answers).forEach(id => delete h.t.answers[id]); h.t.setSubmitted(''); };
function slide(h, id) {
  same(h.ids.questions.querySelectorAll('fieldset').filter(node => !node.hidden).map(node => node.id), [`question-card-${indexOf(h, id)}`]);
  assert.equal(map(h, id).getAttribute('aria-current'), 'location');
}

function adjacent(value, up) {
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  let bits = view.getBigUint64(0); bits += (value > 0) === up ? 1n : -1n;
  view.setBigUint64(0, bits); return view.getFloat64(0);
}

// Expand scientific notation for valid ordinary-decimal NAT input, including
// the adjacent finite values on either side of an exact zero answer.
function decimal(value) {
  const raw = String(value);
  if (!/[eE]/.test(raw)) return raw;
  const [mantissa, exponent] = raw.toLowerCase().split('e');
  const sign = mantissa.startsWith('-') ? '-' : '';
  const unsigned = mantissa.replace(/^-/, ''), point = (unsigned.indexOf('.') < 0 ? unsigned.length : unsigned.indexOf('.')) + Number(exponent);
  const digits = unsigned.replace('.', '');
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return sign + digits.slice(0, point) + '.' + digits.slice(point);
}

async function homeScore(data) {
  const os = require('node:os'), http = require('node:http'), fsp = fs.promises;
  const { createServer } = require('../server.cjs');
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-2015-set-3-test-'));
  const quiz = path.join(temporary, 'gate-cse-2015-set-3');
  const server = createServer({ root: temporary, port: 0 });
  let listening = false;
  try {
    await fsp.mkdir(quiz);
    for (const file of ['index.html', 'quiz-data.js']) await fsp.copyFile(path.join(FOLDER, file), path.join(quiz, file));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    listening = true;
    const port = server.address().port;
    const request = (url, attempt) => new Promise((resolve, reject) => {
      const body = attempt && JSON.stringify(attempt);
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` } : {} }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(3000, () => req.destroy(new Error('Temporary server timed out')));
      req.on('error', reject); req.end(body);
    });
    const url = '/gate-cse-2015-set-3/attempt.json';
    assert.equal((await request(url)).status, 404, 'Opening a new quiz creates no attempt');
    const answers = Object.fromEntries(KEY.map(row => [row.id, correct(row)]));
    const attempt = { version: 1, quizId: data.id, quizTitle: data.title,
      quizSignature: JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }),
      submittedAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
      answers, summary: { score: -999 }, results: [] };
    assert.equal((await request(url, attempt)).status, 200);
    let home = await request('/'); assert.equal(home.status, 200);
    assert.match(home.body, /Last score: 100%/, 'Server recomputes the independent perfect key');
    assert(!home.body.includes('-999'), 'Stored summary is untrusted');
    answers[BOUNDARY_KEY.id] = wrong(BOUNDARY_KEY);
    assert.equal((await request(url, attempt)).status, 200);
    assert((await request('/')).body.includes(`Last score: ${100 - BOUNDARY_KEY.marks}%`), 'Server enforces the numerical key');
    attempt.answers = Object.fromEntries(KEY.map(row => [row.id, wrong(row)]));
    assert.equal((await request(url, attempt)).status, 200);
    home = await request('/');
    const score = Number(KEY.reduce((sum, row) => sum + row.incorrectMarks, 0).toFixed(4));
    assert(home.body.includes(`Last score: ${score}%`));
    assert.match(home.body, /<progress class="paper-score-bar" value="0" max="100"/, 'Negative labels retain their score while the bar clamps to zero');
    attempt.answers = { ...answers, [BOUNDARY_KEY.id]: wrong(BOUNDARY_KEY) }; attempt.outOfSyllabus = [BOUNDARY_KEY.id];
    attempt.reviewFlags = ['GA-1'];
    assert.equal((await request(url, attempt)).status, 200);
    home = await request('/');
    assert.match(home.body, /Last score: 100%/, 'Excluded wrong response contributes no marks');
    assert(home.body.includes(`${100 - BOUNDARY_KEY.marks} / ${100 - BOUNDARY_KEY.marks} marks`));
    attempt.outOfSyllabus = KEY.map(row => row.id);
    assert.equal((await request(url, attempt)).status, 200);
    home = await request('/');
    assert.match(home.body, /Percentage unavailable/); assert.match(home.body, /0 \/ 0 marks/);
    attempt.outOfSyllabus = ['CS-999'];
    assert.equal((await request(url, attempt)).status, 400, 'Unknown exclusions are rejected');
    attempt.outOfSyllabus = []; attempt.reviewFlags = ['GA-1', 'GA-1'];
    assert.equal((await request(url, attempt)).status, 400, 'Duplicate review flags are rejected');
    attempt.reviewFlags = []; attempt.quizSignature = 'stale';
    await fsp.writeFile(path.join(quiz, 'attempt.json'), JSON.stringify(attempt));
    assert.match((await request('/')).body, /Last score unavailable/, 'Stale saved identity cannot expose an unverified score');
  } finally {
    if (listening) await new Promise(resolve => server.close(resolve));
    const relative = path.relative(os.tmpdir(), temporary);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temporary).startsWith('quiz-2015-set-3-test-'));
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

(async () => {
  const h = await load(FOLDER), { data, t, ids } = h;
  const noDialogs = rejectFileDialogs(h);
  t.validate(); assertEditable(h);
  assert.equal(data.id, 'gate-cse-2015-set-3-shift-1'); assert.equal(data.title, 'GATE CSE 2015 - Set 3');
  assert.equal(data.questions.length, 65); assert.equal(FIXTURE.questionCount, 65);
  assert.equal(FIXTURE.totalMarks, 100); assert.equal(data.cropDpi, 240);
  same(data.questions.map(question => question.id), [
    ...Array.from({ length: 10 }, (_, index) => `GA-${index + 1}`),
    ...Array.from({ length: 55 }, (_, index) => `CS-${index + 11}`)
  ], 'Use combined-key continuous numbering, not the differently ordered attached paper');
  same(data.questions.reduce((counts, question) => ({ ...counts, [question.type.toUpperCase()]: (counts[question.type.toUpperCase()] || 0) + 1 }), {}), FIXTURE.typeCounts);
  same(FIXTURE.typeCounts, { MCQ: 45, NAT: 20 });
  assert.equal(data.questions.reduce((total, question) => total + question.marks, 0), 100);
  for (const file of ['quiz.js', 'theme.js', 'styles.css', 'rough-work.js', 'rough-work-engine.js']) assert.equal(hash(path.join(FOLDER, file)), hash(path.join(TEMPLATE, file)), `${file} inherits the current shared carousel/runtime`);
  same(data.sourceSha256, FIXTURE.sourceSha256, 'Both unchanged external originals retain independently verified hashes');
  for (const [name, sha256] of Object.entries(FIXTURE.sourceSha256)) {
    const original = path.join('/Users/icode100/Downloads', name);
    if (fs.existsSync(original)) assert.equal(hash(original), sha256, `${name} source bytes`);
  }
  assert.equal(data.answerKey, '2015CS_S07_compressed.pdf');
  assert.equal(data.questionPaper, '2015CS_S07_compressed.pdf');
  assert.equal(data.referenceQuestionPaper, 'GATE2015-Set-3.pdf');
  same(data.sourcePageCounts, { questionPaper: 27, answerKey: 27, referenceQuestionPaper: 22 });
  same(data.referenceQuestionMapping.map(row => row.id), KEY.map(row => row.id), 'Each combined-key question has exactly one clean-paper reference');
  for (const [section, count] of [['GA', 10], ['CS', 55]]) {
    same(data.referenceQuestionMapping.filter(row => row.id.startsWith(`${section}-`)).map(row => row.referenceNumber).sort((a, b) => a - b),
      Array.from({ length: count }, (_, index) => index + 1), `${section} reference numbers cover the clean paper once`);
  }
  for (const row of data.referenceQuestionMapping) assert(row.referencePages.length && new Set(row.referencePages).size === row.referencePages.length &&
    row.referencePages.every(page => Number.isInteger(page) && page > 0 && page <= FIXTURE.paperPageCount), `${row.id} valid clean-paper reference pages`);
  assert(!fs.readdirSync(FOLDER).some(file => /\.pdf$/i.test(file)), 'Do not duplicate supplied PDFs');
  const html = fs.readFileSync(path.join(FOLDER, 'index.html'), 'utf8');
  assert.match(html, /id="quiz-home"[^>]*href="\/"/, 'Home points to the server root');
  for (const [, resource] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (resource === '/') continue;
    assert(!/^[a-z]+:/i.test(resource) && !path.isAbsolute(resource) && !resource.includes('..'), 'HTML resources stay local to the quiz');
    assert(fs.existsSync(path.join(FOLDER, resource)), `Missing local resource ${resource}`);
  }
  assert.equal(ids['review-attempt'].disabled, true);
  assert.equal(ids['review-attempt'].title, 'This paper has not been attempted before.');
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, 'GET');
  assert.equal(h.requests[0].url, attemptUrl(h));
  let imageCount = 0; const assets = new Set();
  for (let index = 0; index < KEY.length; index++) {
    const key = KEY[index], question = data.questions[index];
    for (const field of ['id', 'section', 'number', 'type', 'marks', 'incorrectMarks', 'answerKeyPage']) assert.equal(question[field], key[field], `${key.id} ${field}`);
    assert.equal(question.displayLabel, `${key.section} ${key.number}`);
    assert.equal(question.incorrectMarks, key.type === 'mcq' ? -key.marks / 3 : 0, `${key.id} precise penalty`);
    assert.equal(question.text, '', `${key.id} preserves original question content in crops`);
    assert(!question.marksToAll && !question.requiresCorrect, `${key.id} has no unsupported awards/dependencies`);
    if (key.type === 'nat') same(question.correctRanges, key.correctRanges, `${key.id} independent numerical key`);
    else {
      same(question.options.map(option => option.id), ['A', 'B', 'C', 'D']);
      same(question.acceptedAnswers || [question.correctAnswer], accepted(key), `${key.id} independent option key`);
    }
    same(question.sourcePages, key.sourcePages, `${key.id} primary combined-key question pages`);
    same(question.sourcePages, [...new Set(question.images.map(image => image.page))]);
    assert(question.images.length && question.images.length === question.sourceRectangles.length);
    for (let part = 0; part < question.images.length; part++) {
      const image = question.images[part], crop = question.sourceRectangles[part];
      assert(image.src.startsWith('assets/') && !image.src.includes('..') && !assets.has(image.src), `${key.id} unique local crop`);
      assert(image.alt && Number.isInteger(image.page) && image.page > 0 && image.page <= FIXTURE.keyPageCount);
      assert.equal(crop.page, image.page); assert.equal(crop.rect.length, 4);
      assert(crop.rect.every(Number.isFinite));
      const [left, top, right, bottom] = crop.rect;
      const size = data.sourcePageSizes.find(row => row.page === image.page);
      assert(size && size.width > 0 && size.height > 0);
      assert(left >= 0 && top >= 0 && right > left && bottom > top && right <= size.width && bottom <= size.height, `${key.id} crop fits source page`);
      const bytes = fs.readFileSync(path.join(FOLDER, image.src));
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${key.id} lossless PNG`);
      const provenance = data.cropProvenance.assets.find(asset => asset.src === image.src);
      assert(provenance, `${key.id} retained crop provenance`);
      assert.equal(provenance.sha256, hash(path.join(FOLDER, image.src)), `${key.id} crop pixel file hash`);
      assert.equal(provenance.width, bytes.readUInt32BE(16)); assert.equal(provenance.height, bytes.readUInt32BE(20));
      assert.equal(provenance.page, image.page); same(provenance.rect, crop.rect);
      const scaleX = Math.ceil(size.width * data.cropDpi / 72) / size.width;
      const scaleY = Math.ceil(size.height * data.cropDpi / 72) / size.height;
      assert.equal(bytes.readUInt32BE(16), Math.ceil(right * scaleX) - Math.floor(left * scaleX), `${key.id} unscaled crop width`);
      assert.equal(bytes.readUInt32BE(20), Math.ceil(bottom * scaleY) - Math.floor(top * scaleY), `${key.id} unscaled crop height`);
      assets.add(image.src); imageCount++;
    }
  }
  assert.equal(imageCount, 65, 'All 65 question bodies fit one source crop each');
  assert.equal(fs.readdirSync(path.join(FOLDER, 'assets')).filter(file => /\.png$/i.test(file)).length, imageCount, 'No orphan crops');
  same(data.questions.find(question => question.id === 'CS-17').correctRanges, [{ min: 612, max: 613 }]);
  same(data.questions.find(question => question.id === 'CS-36').correctRanges, [{ min: 308, max: 310 }]);
  same(data.questions.find(question => question.id === 'CS-63').correctRanges, [{ min: 0, max: 0 }]);
  assert.equal(ids.questions.querySelectorAll('img').length, imageCount);
  assert.equal(ids['nav-groups'].querySelectorAll('.nav-question').length, 65);
  same(ids['nav-groups'].querySelectorAll('h3').map(node => node.textContent), ['GA', 'CS']);
  same(ids['nav-groups'].querySelectorAll('.nav-number').map(node => node.textContent), KEY.map(row => String(row.number)));

  let summary = t.summarize(t.grade());
  assert.equal(summary.score, 0); assert.equal(summary.maximum, 100);
  same(summary.counts, { correct: 0, incorrect: 0, unanswered: 65, awarded: 0 });
  for (const key of KEY) t.answers[key.id] = correct(key);
  summary = t.summarize(t.grade()); assert.equal(summary.score, 100);
  same(summary.counts, { correct: 65, incorrect: 0, unanswered: 0, awarded: 0 });
  for (const key of KEY) t.answers[key.id] = wrong(key);
  close(t.summarize(t.grade()).score, KEY.reduce((total, key) => total + key.incorrectMarks, 0), 'All-wrong score');
  close(t.summarize(t.grade()).score, FIXTURE.expectedScores.allWrong, '2015 Set 3 full-precision all-wrong total');
  close(t.summarize(t.grade()).score, -65 / 3, 'Independent sum of MCQ wrong-answer penalties');
  reset(h); let mixed = 0;
  KEY.forEach((key, index) => {
    if (index % 3 === 0) { t.answers[key.id] = correct(key); mixed += key.marks; }
    else if (index % 3 === 1) { t.answers[key.id] = wrong(key); mixed += key.incorrectMarks; }
  });
  close(t.summarize(t.grade()).score, mixed, 'Mixed independent score');
  let optionChecks = 0, boundaryChecks = 0, strictBoundaryChecks = 0;
  for (const key of KEY) {
    const values = key.type === 'mcq' ? [...'ABCD'] : key.correctRanges.flatMap(range => [range.min, range.max, range.min - 0.0001, range.max + 0.0001]);
    for (const value of values) {
      const isCorrect = key.type === 'mcq' ? accepted(key).includes(value) : key.correctRanges.some(range => value >= range.min && value <= range.max);
      t.answers[key.id] = String(value);
      const result = t.grade().find(row => row.question.id === key.id);
      assert.equal(result.outcome, isCorrect ? 'correct' : 'incorrect', `${key.id} answer ${value}`);
      assert.equal(result.earned, isCorrect ? key.marks : key.incorrectMarks);
      if (key.type === 'mcq') optionChecks++; else boundaryChecks++;
    }
    if (key.type === 'nat') for (const range of key.correctRanges) {
      for (const value of [adjacent(range.min, false), adjacent(range.max, true)]) {
        const raw = decimal(value); assert.equal(Number(raw), value); assert(!/[eE]/.test(raw));
        t.answers[key.id] = raw;
        const result = t.grade().find(row => row.question.id === key.id);
        const valid = key.correctRanges.some(item => value >= item.min && value <= item.max);
        assert.equal(result.outcome, valid ? 'correct' : 'incorrect', `${key.id} adjacent value ${raw}`);
        strictBoundaryChecks++;
      }
    }
  }

  // Exercise this paper's carousel, raw draft and submission/report lifecycle.
  reset(h); t.renderQuestions(); slide(h, 'GA-1');
  const mcq = KEY.find(row => row.type === 'mcq'), nat = KEY.find(row => row.type === 'nat');
  await editResponse(h, mcq.id, correct(mcq)); slide(h, KEY[indexOf(h, mcq.id) + 1].id);
  await editResponse(h, nat.id, '-'); slide(h, nat.id);
  await h.document.getElementById(`mark-review-${indexOf(h, nat.id)}`).click();
  ids['timer-duration'].value = '30'; await ids['timer-duration'].fire('change');
  const cached = JSON.parse(h.storage.get(draftKey(h)));
  assert.equal(cached.answers[nat.id], '-'); same(cached.reviewFlags, [nat.id]);
  assert.equal(cached.timer.durationMinutes, 30);
  await map(h, 'CS-65').click(); slide(h, 'CS-65');
  assert.equal(ids['next-question'].disabled, true);
  await ids['quiz-form'].fire('submit'); slide(h, nat.id);
  assert.equal(card(h, nat.id).querySelector('input').focused, true);
  assert.equal(posts(h).length, 0); assert.equal(ids.report.hidden, true);
  assert.equal(JSON.parse(h.storage.get(draftKey(h))).answers[nat.id], '-');
  const restored = await load(FOLDER, { storage: h.storage });
  slide(restored, nat.id); assert.equal(restored.t.answers[nat.id], '-');
  same([...restored.t.reviewFlags], [nat.id]);
  await editResponse(restored, nat.id, correct(nat));
  await restored.ids['quiz-form'].fire('submit');
  assert.equal(posts(restored).length, 1); assert.equal(restored.storage.has(draftKey(restored)), false);
  const saved = restored.server.get(attemptUrl(restored));
  assert.equal(saved.version, 1); assert.equal(saved.quizId, data.id);
  assert.equal(saved.summary.score, mcq.marks + nat.marks);
  assert.equal(Object.keys(saved.answers).length, 65); assert.equal(saved.results.length, 65);
  same(saved.reviewFlags, [nat.id]); assert(!Object.hasOwn(saved, 'timer')); assert(!Object.hasOwn(saved, 'currentQuestionId'));
  assert.equal(restored.ids['report-list'].querySelectorAll('.result-card').length, 65);
  assert.equal(restored.ids['report-list'].querySelectorAll('img').length, imageCount);
  assert.equal(restored.ids['question-carousel'].hidden, true);
  const savedJson = JSON.stringify(saved);
  await restored.ids['retry-quiz'].click(); slide(restored, 'GA-1'); assertEditable(restored);
  assert.equal(Object.keys(restored.t.answers).length, 0); same([...restored.t.reviewFlags], []);
  assert.equal(JSON.stringify(restored.server.get(attemptUrl(restored))), savedJson, 'Retry preserves the last submission');
  await editResponse(restored, nat.id, '-');
  const currentDraft = restored.storage.get(draftKey(restored));
  saved.summary.score = -999; saved.results = [];
  await restored.ids['review-attempt'].click();
  assert.equal(restored.t.summarize(restored.t.grade()).score, mcq.marks + nat.marks, 'Saved Review recomputes from verified key');
  assert.equal(restored.storage.get(draftKey(restored)), currentDraft);
  await restored.ids['retry-quiz'].click(); slide(restored, nat.id);
  assert.equal(restored.t.answers[nat.id], '-'); assert.equal(restored.storage.get(draftKey(restored)), currentDraft);
  assert.equal(posts(restored).length, 1, 'Review, Back and Retry never write an attempt');

  // Exclusions remain independent from responses and the saved score is verified.
  const exclusions = await load(FOLDER);
  await editResponse(exclusions, EXCLUSION_KEY.id, '0');
  assert.equal(exclusions.ids.progress.textContent, '1 of 65 answered', 'A zero NAT is answered');
  await flag(exclusions, EXCLUSION_KEY.id); await exclude(exclusions, EXCLUSION_KEY.id);
  assert.equal(exclusions.t.answers[EXCLUSION_KEY.id], '0');
  assert.equal(exclusions.ids.progress.textContent, '0 of 64 answered');
  let excludedSummary = exclusions.t.summarize(exclusions.t.grade());
  assert.equal(excludedSummary.score, 0); assert.equal(excludedSummary.maximum, 98);
  await map(exclusions, 'CS-65').click();
  const exclusionDraft = exclusions.storage.get(draftKey(exclusions));
  const resumed = await load(FOLDER, { storage: exclusions.storage });
  slide(resumed, 'CS-65'); same([...resumed.t.outOfSyllabus], [EXCLUSION_KEY.id]); same([...resumed.t.reviewFlags], [EXCLUSION_KEY.id]);
  assert.equal(resumed.t.answers[EXCLUSION_KEY.id], '0');
  await card(resumed, EXCLUSION_KEY.id).querySelector('.clear-response').click();
  same([...resumed.t.outOfSyllabus], [EXCLUSION_KEY.id]); same([...resumed.t.reviewFlags], [EXCLUSION_KEY.id]);
  await editResponse(resumed, EXCLUSION_KEY.id, '0'); await editResponse(resumed, mcq.id, correct(mcq));
  await resumed.ids['quiz-form'].fire('submit');
  const excludedSaved = resumed.server.get(attemptUrl(resumed));
  same(excludedSaved.outOfSyllabus, [EXCLUSION_KEY.id]); same(excludedSaved.reviewFlags, [EXCLUSION_KEY.id]);
  assert.equal(excludedSaved.summary.score, 1); assert.equal(excludedSaved.summary.maximum, 98);
  assert.equal(resumed.storage.has(draftKey(resumed)), false);
  same([...resumed.t.outOfSyllabus], []); same([...resumed.t.reviewFlags], []);
  await resumed.ids['retry-quiz'].click();
  await exclude(resumed, mcq.id); await map(resumed, 'CS-65').click();
  const activeDraft = resumed.storage.get(draftKey(resumed));
  excludedSaved.summary = { score: -999 }; excludedSaved.results = [];
  await resumed.ids['review-attempt'].click();
  excludedSummary = resumed.t.summarize(resumed.t.grade());
  assert.equal(excludedSummary.score, 1); assert.equal(excludedSummary.maximum, 98);
  assert.equal(resumed.storage.get(draftKey(resumed)), activeDraft);
  await resumed.ids['retry-quiz'].click();
  slide(resumed, 'CS-65'); same([...resumed.t.outOfSyllabus], [mcq.id]);
  assert.equal(resumed.storage.get(draftKey(resumed)), activeDraft);
  await resumed.ids['clear-answers'].click();
  same([...resumed.t.outOfSyllabus], []); same([...resumed.t.reviewFlags], []); slide(resumed, 'GA-1');
  assert.equal(posts(resumed).length, 1, 'Exclusion and Review controls do not write submissions');
  for (const row of KEY) await exclude(resumed, row.id);
  excludedSummary = resumed.t.summarize(resumed.t.grade());
  assert.equal(excludedSummary.score, 0); assert.equal(excludedSummary.maximum, 0); assert.equal(excludedSummary.percentage, null);
  assert.equal(resumed.ids.progress.textContent, '0 of 0 answered');
  assert.equal(resumed.ids['test-progress-value'].textContent, '—');

  // Navigation-only drafts restore; legacy optional fields remain compatible.
  const navigationOnly = await load(FOLDER);
  await map(navigationOnly, 'CS-65').click();
  const navigationReload = await load(FOLDER, { storage: navigationOnly.storage });
  slide(navigationReload, 'CS-65'); assert.equal(Object.keys(navigationReload.t.answers).length, 0);
  const legacy = JSON.parse(exclusionDraft);
  delete legacy.currentQuestionId; delete legacy.timer; delete legacy.reviewFlags; delete legacy.outOfSyllabus;
  const legacyReload = await load(FOLDER, { storage: [[draftKey(h), JSON.stringify(legacy)]] });
  slide(legacyReload, 'GA-1'); assert.equal(legacyReload.t.answers[EXCLUSION_KEY.id], '0');
  for (const outOfSyllabus of [null, ['CS-999'], [EXCLUSION_KEY.id, EXCLUSION_KEY.id]]) {
    const bad = { ...JSON.parse(exclusionDraft), outOfSyllabus };
    const invalid = await load(FOLDER, { storage: [[draftKey(h), JSON.stringify(bad)]] });
    assert.equal(Object.keys(invalid.t.answers).length, 0); same([...invalid.t.outOfSyllabus], []); assertEditable(invalid);
  }

  // Failed writes retain both the visible report and all unfinished state.
  const failed = await load(FOLDER, { fetch: (request, perform, response) => request.method === 'POST' ? response(500, { error: 'Simulated failure' }) : perform() });
  await editResponse(failed, mcq.id, correct(mcq)); await flag(failed, mcq.id); await exclude(failed, nat.id);
  await failed.ids['quiz-form'].fire('submit');
  assert.equal(failed.ids.report.hidden, false); assert.equal(failed.server.size, 0);
  assert.equal(failed.ids['review-attempt'].disabled, true);
  const failureCache = JSON.parse(failed.storage.get(draftKey(failed)));
  assert.equal(failureCache.answers[mcq.id], correct(mcq)); same(failureCache.reviewFlags, [mcq.id]); same(failureCache.outOfSyllabus, [nat.id]);
  const unavailable = await load(FOLDER, { storageUnavailable: true });
  await editResponse(unavailable, mcq.id, correct(mcq)); await unavailable.ids['quiz-form'].fire('submit');
  assert.equal(unavailable.ids.report.hidden, false);
  await unavailable.ids['retry-quiz'].click(); assertEditable(unavailable);
  assert.equal(unavailable.ids['status-message'].hidden, false);
  assert.match(unavailable.ids['status-message'].textContent, /Could not cache your progress/);
  noDialogs(); await homeScore(data);
  console.log(`PASS: 2015 Set 3 independent 65-question key, continuous numbering, ${imageCount} lossless original crops/provenance, shared runtime, blank/perfect/wrong/mixed grading, ${optionChecks} MCQ options, ${boundaryChecks} NAT boundary checks and ${strictBoundaryChecks} adjacent-value checks, raw draft/reload/invalid Submit, review flags/exclusions, timer/navigation isolation, report/review/retry, legacy/invalid drafts, failed saves/storage, and disposable-server score recomputation. No user attempts or browser state changed.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
