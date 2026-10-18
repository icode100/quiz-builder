const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

// Browser storage and DOM are simulated. Never modify the user's attempts or
// automate native browser/file dialogs. The real HTML supplies the control IDs.
class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attrs = {}; this.events = {};
    this.className = ''; this.dataset = {}; this.value = ''; this.textContent = '';
    this.hidden = false; this.disabled = false;
    this.classList = {
      toggle: (name, on) => {
        let names = this.className.split(' ').filter(Boolean);
        if (on === undefined) on = !names.includes(name);
        names = names.filter(value => value !== name); if (on) names.push(name);
        this.className = names.join(' ');
      }, remove: name => this.classList.toggle(name, false)
    };
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#fragment') this.append(...node.children);
      else { node.remove(); this.children.push(node); node.parent = this; }
    }
  }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null; }); this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(name, fn) { (this.events[name] ??= []).push(fn); }
  async fire(name, event = {}) { for (const fn of this.events[name] || []) await fn({ target: this, preventDefault() {}, ...event }); }
  matches(selector) {
    const attr = selector.match(/\[([^=]+)="([^"]+)"\]/);
    if (attr && (this.attrs[attr[1]] ?? this[attr[1]]) !== attr[2]) return false;
    selector = selector.replace(/\[.*?\]/g, '');
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName === selector;
  }
  querySelectorAll(selector) {
    const out = [];
    for (const node of this.children) {
      if (selector.split(',').some(value => node.matches(value.trim()))) out.push(node);
      out.push(...node.querySelectorAll(selector));
    }
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focused = true; } scrollIntoView() { this.scrolled = true; }
  click() { return this.fire('click'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
}

function createHarness(folder, options = {}) {
  const body = new El('body'), ids = {};
  const html = fs.readFileSync(folder + '/index.html', 'utf8');
  for (const match of html.matchAll(/<([a-z]+)[^>]*id="([^"]+)"[^>]*>/g)) {
    const node = new El(match[1]); node.id = match[2]; node.hidden = /\shidden(?:\s|>)/.test(match[0]);
    ids[node.id] = node; body.append(node);
  }
  const shell = new El(); shell.className = 'quiz-shell'; body.append(shell);
  for (const id of ['save-attempt', 'load-attempt', 'connect-attempt', 'practice-without-file', 'download-attempt']) {
    assert(!ids[id], `Extra persistence control ${id} must be absent`);
  }
  ids['quiz-form'].append(ids.questions, ids.progress, ids['clear-answers']);
  const submit = new El('button'); submit.type = 'submit'; ids['quiz-form'].append(submit);
  const document = {
    body, documentElement: new El('html'), createElement: tag => new El(tag),
    createDocumentFragment: () => new El('#fragment'),
    getElementById: id => ids[id] || body.querySelector('#' + id),
    querySelector: selector => body.querySelector(selector),
    addEventListener: (name, fn) => { document[name] = fn; }
  };
  const storage = options.storage instanceof Map ? options.storage : new Map(options.storage || []);
  const window = {
    addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), print() {},
    location: { href: options.url || `http://127.0.0.1:8765/${folder.replace(/\\/g, '/').split('/').pop()}/index.html` }, ...(options.window || {})
  };
  const server = options.server instanceof Map ? options.server : new Map(options.server || []), requests = [];
  const response = (status, payload) => ({ ok: status >= 200 && status < 300, status, async json() { return JSON.parse(JSON.stringify(payload)); } });
  const fetch = async (url, init = {}) => {
    const request = { url: String(url), method: init.method || 'GET', ...init };
    requests.push(request);
    const perform = () => {
      if (request.method === 'POST') { server.set(request.url, JSON.parse(request.body)); return response(200, { saved: true }); }
      return server.has(request.url) ? response(200, server.get(request.url)) : response(404, { error: 'No submitted attempt yet.' });
    };
    return options.fetch ? options.fetch(request, perform, response) : perform();
  };
  const storageError = (operation, key) => options.storageUnavailable || options.storageError?.(operation, key);
  const ctx = {
    window, document, localStorage: {
      getItem: key => { if (storageError('get', key)) throw Error('Browser storage unavailable'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (storageError('set', key)) throw Error('Browser storage unavailable'); storage.set(key, value); },
      removeItem: key => { if (storageError('remove', key)) throw Error('Browser storage unavailable'); storage.delete(key); }
    }, fetch, console, Blob, URL, setTimeout() {}
  };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(folder + '/quiz-data.js', 'utf8'), ctx);
  let source = fs.readFileSync(folder + '/quiz.js', 'utf8').replace(/\r\n/g, '\n');
  for (const api of ['showSaveFilePicker', 'showOpenFilePicker', 'requestPermission', 'QUIZ_FILE_STORE']) {
    assert(!source.includes(api), `Browser-cache attempts must never use ${api}`);
  }
  assert(!ids['attempt-file'], 'Browser cache needs no JSON file input');
  assert(!html.includes('attempt-store.js'), 'Unused file-handle store must not be loaded');
  const marker = '  try {\n    validate();'; assert(source.includes(marker), 'runtime test injection point is missing');
  source = source.replace(marker, `  window.test = {
    validate, grade, summarize,
    renderQuestions, renderReport, clearAttempt, restartAttempt,
    save, numericValue, plainAnswer, answers,
    setSubmitted: value => { submittedAt = value; }
  };
${marker}`);
  const availabilityCheck = '    checkLastAttempt();';
  assert(source.includes(availabilityCheck), 'runtime availability check injection point is missing');
  source = source.replace(availabilityCheck, '    window.test.initialCheck = checkLastAttempt();');
  vm.runInContext(source, ctx);
  assert(!ids['status-message'].textContent.startsWith('Unable'), ids['status-message'].textContent);
  return { ctx, window, document, ids, t: window.test, data: window.QUIZ_DATA, storage, server, requests, submit };
}
async function load(folder = 'gate-cse-2021-set-1', options = {}) {
  const h = createHarness(folder, options);
  // Await the actual startup availability check, without a second GET.
  await h.t.initialCheck;
  return h;
}
function rejectFileDialogs(h) {
  let calls = 0;
  for (const api of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    h.window[api] = () => { calls++; throw Error(`Unexpected ${api}`); };
  }
  return () => assert.equal(calls, 0, 'Automatic draft caching and Submit do not open file dialogs');
}
const draftKey = h => 'practice-quiz:' + h.data.id;
const attemptUrl = h => new URL('attempt.json', h.window.location.href).href;
function assertEditable(h) {
  assert(h.ids['quiz-form'].querySelectorAll('input, button').every(node => !node.disabled), 'practice remains usable without file access');
}

async function editResponse(h, id, value) {
  const index = h.data.questions.findIndex(question => question.id === id);
  assert(index >= 0, `Unknown test question ${id}`);
  const question = h.data.questions[index];
  const inputs = h.document.getElementById(`question-card-${index}`).querySelectorAll('input');
  if (question.type === 'nat') {
    inputs[0].value = value; await inputs[0].fire('input');
  } else if (question.type === 'msq') {
    inputs.forEach(input => { input.checked = value.includes(input.value); });
    await inputs[0].fire('change');
  } else {
    inputs.forEach(input => { input.checked = input.value === value; });
    await inputs.find(input => input.value === value).fire('change');
  }
}

// All browser state is simulated in memory. The independent key fixture is
// tracked under tests, so the build's temporary PDF audit can be deleted.
const path = require('path');
const crypto = require('crypto');
const FOLDER = path.resolve(__dirname, '../gate-cse-2019');
const TEMPLATE = path.resolve(__dirname, '../_template');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gate-cse-2019-key.json'), 'utf8'));
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
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-2019-test-'));
  const quiz = path.join(tempRoot, 'gate-cse-2019'), server = createServer({ root: tempRoot, port: 0 });
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
      const card = (home.body.match(/<li\b[\s\S]*?<\/li>/g) || []).find(item => item.includes('href="/gate-cse-2019/"'));
      assert(card, 'Home includes the 2019 paper'); return card;
    };
    assert.match(await readCard(), /data-attempted="false"/);
    assert.equal((await request('/gate-cse-2019/attempt.json')).status, 404, 'Opening home creates no attempt');
    const answers = Object.fromEntries(VERIFIED_KEY.map(row => [row.id, correctResponse(row)]));
    answers['CS-12'] = 'D'; answers['CS-42'] = '4.1';
    const attempt = { version: 1, quizId: data.id, quizTitle: data.title,
      quizSignature: JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }),
      submittedAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
      answers, summary: { score: -999 }, results: [] };
    assert.equal((await request('/gate-cse-2019/attempt.json', attempt)).status, 200);
    let card = await readCard(); assert.match(card, /data-attempted="true"/); assert.match(card, /Last score: 100 \/ 100/);
    assert.match(card, /<progress class="paper-score-bar" value="100" max="100"/); assert(!card.includes('-999'));
    answers['CS-42'] = '3.9'; assert.equal((await request('/gate-cse-2019/attempt.json', attempt)).status, 200);
    assert.match(await readCard(), /Last score: 98 \/ 100/, 'Server excludes CS-42 gap');
    const wrong = { ...attempt, answers: Object.fromEntries(VERIFIED_KEY.map(row => [row.id, wrongResponse(row)])) };
    assert.equal((await request('/gate-cse-2019/attempt.json', wrong)).status, 200);
    card = await readCard(); const wrongScore = Number(VERIFIED_KEY.reduce((sum, row) => sum + row.incorrectMarks, 0).toFixed(4));
    assert(card.includes(`Last score: ${wrongScore} / 100`), 'Home preserves negative 2019 score');
    assert.match(card, /<progress class="paper-score-bar" value="0" max="100"/, 'Only visual bar clamps at zero');
    assert.equal((await request('/gate-cse-2019/attempt.json', { ...attempt, quizSignature: 'stale key' })).status, 200);
    card = await readCard(); assert.match(card, /data-attempted="true"/); assert.match(card, /Last score unavailable/);
    assert.match(card, /class="paper-score-bar" hidden/, 'Stale attempted file has no score bar');
  } finally {
    if (listening) await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(tempRoot), parent = path.resolve(os.tmpdir()), relative = path.relative(parent, resolved);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(resolved).startsWith('quiz-2019-test-'), 'Cleanup stays inside the created temp fixture');
    await fsp.rm(resolved, { recursive: true, force: true });
  }
}

(async () => {
  const h = await load(FOLDER), { t, data, ids } = h;
  const noDialogs = rejectFileDialogs(h);
  assert.equal(data.id, 'gate-cse-2019'); assert.equal(data.title, 'GATE CSE 2019');
  assert.equal(data.questions.length, FIXTURE.questionCount); assert.equal(VERIFIED_KEY.length, 65);
  same(data.questions.reduce((counts, q) => ({ ...counts, [q.type]: (counts[q.type] || 0) + 1 }), {}), { mcq: 41, nat: 24 });
  same(FIXTURE.typeCounts, { MCQ: 41, NAT: 24 });
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
  for (const name of [data.questionPaper, data.answerKey]) {
    assert(name && !path.isAbsolute(name) && !name.includes('..'), 'Source PDF path is relative');
    assert.equal(sha256(path.join(FOLDER, name)), FIXTURE.sourceSha256[name], `${name} preserves supplied original bytes`);
  }
  assert.equal(data.questionPaper, '2019_CS_Paper1.pdf'); assert.equal(data.answerKey, '2019-Keys1.pdf');
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
    assert.equal(q.text, '', `${q.id} uses original complete crops rather than uncertain OCR`);
    if (key.type === 'nat') same(q.correctRanges, key.ranges, `${q.id} inclusive numerical key`);
    else {
      same(q.options.map(option => option.id), ['A', 'B', 'C', 'D'], `${q.id} original option order`);
      same(q.acceptedAnswers || [q.correctAnswer], key.answer, `${q.id} single-choice official key`);
    }
    assert(q.images.length && q.sourcePages.length, `${q.id} original image content`);
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
      const bytes = fs.readFileSync(path.join(FOLDER, image.src));
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${q.id} lossless PNG`);
      assert(bytes.readUInt32BE(16) > 100 && bytes.readUInt32BE(20) > 40, `${q.id} readable nonempty dimensions`);
      imagePaths.add(image.src); imageCount++;
    }
  }
  assert.equal(imageCount, 65); assert.equal(fs.readdirSync(path.join(FOLDER, 'assets')).filter(name => /\.png$/i.test(name)).length, 65);
  same(data.questions.find(q => q.id === 'CS-12').acceptedAnswers, ['C', 'D'], 'CS-12 accepts either C or D as one response');
  same(data.questions.find(q => q.id === 'CS-42').correctRanges, [{ min: 3.7, max: 3.8 }, { min: 4, max: 4.1 }], 'CS-42 preserves the separate accepted intervals');
  const html = fs.readFileSync(path.join(FOLDER, 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
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
  for (const value of ['3.8000000000000003', '3.9', '3.9999999999999996']) {
    t.answers['CS-42'] = value; assert.equal(result(h, 'CS-42').outcome, 'incorrect', `CS-42 rejects gap ${value}`);
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
  const shared = new Map(), other = await load(path.resolve(__dirname, '../gate-cse-2021-set-1'), { storage: shared });
  await editResponse(other, 'GA-1', 'C'); await markReview(other, 'CS-1'); const otherDraft = shared.get(draftKey(other));
  const current = await load(FOLDER, { storage: shared }); assert.equal(Object.keys(current.t.answers).length, 0);
  await editResponse(current, mcq.id, correctResponse(mcq)); await markReview(current, mcq.id);
  vm.runInContext(fs.readFileSync(path.join(FOLDER, 'theme.js'), 'utf8'), current.ctx); current.document.DOMContentLoaded();
  const beforeTheme = shared.get(draftKey(current)); await current.ids['theme-toggle'].click();
  assert.equal(shared.get('practice-quiz:theme'), 'dark'); assert.equal(shared.get(draftKey(current)), beforeTheme);
  await current.ids['quiz-form'].fire('submit'); assert(!shared.has(draftKey(current)));
  assert.equal(shared.get(draftKey(other)), otherDraft); assert.equal(shared.get('practice-quiz:theme'), 'dark'); assertReviewMark(other, 'CS-1', true);
  noDialogs(); unavailableDialogs();
  await testHomeIntegration(data);
  console.log(`PASS: 2019 independent 65-question key, 41 MCQ/24 NAT, original PDF hashes, 65 PNG crops/source metadata/local paths/shared runtime, blank/perfect/wrong/mixed scores, ${mcqOptionChecks} MCQ options, ${natBoundaryChecks} NAT endpoint/outside checks and disjoint CS-42 gap, maps/full reports, raw draft/reload/invalid Submit, flags/clear/retry, failed/successful saves, saved review/back and score recomputation, legacy/invalid drafts, storage failures, separate paper/theme state, no native file APIs, temporary-server home score/alternate key/disjoint gap/negative score/stale record. All attempts simulated or in disposable fixtures.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
