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

// This harness is copied from quiz-runtime.test.cjs. All storage is a temporary
// Map and all DOM nodes are in memory; no real browser or user draft is read.
const path = require('path');
const crypto = require('crypto');
const FOLDER = path.resolve(__dirname, '../gate-cse-2021-set-2');
const TEMPLATE = path.resolve(__dirname, '../_template');

// Independently transcribed from the supplied Session 6 answer key, rather
// than inferred from quiz-data.js. Format: ID | type | marks | official answer.
const VERIFIED_KEY = `
GA-1|mcq|1|A
GA-2|mcq|1|B
GA-3|mcq|1|B
GA-4|mcq|1|B
GA-5|mcq|1|C
GA-6|mcq|2|C
GA-7|mcq|2|A
GA-8|mcq|2|C
GA-9|mcq|2|A
GA-10|mcq|2|C
CS-1|mcq|1|C
CS-2|mcq|1|C
CS-3|mcq|1|C
CS-4|mcq|1|C
CS-5|mcq|1|A
CS-6|mcq|1|D
CS-7|mcq|1|C
CS-8|mcq|1|B
CS-9|mcq|1|C
CS-10|mcq|1|C
CS-11|msq|1|B,C
CS-12|msq|1|B,C,D
CS-13|msq|1|D
CS-14|msq|1|A,C,D
CS-15|msq|1|B,D
CS-16|nat|1|1
CS-17|nat|1|256
CS-18|nat|1|3
CS-19|nat|1|2
CS-20|nat|1|80000
CS-21|nat|1|698
CS-22|nat|1|15:16
CS-23|nat|1|15
CS-24|nat|1|4
CS-25|nat|1|19
CS-26|mcq|2|B
CS-27|mcq|2|A
CS-28|mcq|2|B
CS-29|mcq|2|D
CS-30|mcq|2|D
CS-31|mcq|2|B
CS-32|mcq|2|B
CS-33|mcq|2|A
CS-34|mcq|2|C
CS-35|mcq|2|D
CS-36|mcq|2|C
CS-37|mcq|2|B
CS-38|mcq|2|A
CS-39|mcq|2|C
CS-40|msq|2|A,C,D
CS-41|msq|2|B,C,D
CS-42|msq|2|A,D
CS-43|msq|2|A,B,C
CS-44|msq|2|A,D
CS-45|msq|2|B,C
CS-46|msq|2|A,B
CS-47|msq|2|A,B,C
CS-48|nat|2|4108
CS-49|nat|2|60
CS-50|nat|2|59049
CS-51|nat|2|8
CS-52|nat|2|6
CS-53|nat|2|1.87:1.88
CS-54|nat|2|130:140
CS-55|nat|2|929
`.trim().split('\n').filter(Boolean).map(line => {
  const [id, type, marks, answer] = line.trim().split('|');
  const row = { id, type, marks: Number(marks), answer };
  if (type === 'nat') row.ranges = answer.split(';').map(value => {
    const [min, max = min] = value.split(':').map(Number);
    return { min, max };
  });
  return row;
});

const same = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
const questionIndex = (h, id) => h.data.questions.findIndex(q => q.id === id);
const card = (h, id) => h.document.getElementById(`question-card-${questionIndex(h, id)}`);
const nav = (h, id) => h.document.getElementById(`nav-question-${questionIndex(h, id)}`);
const reviewToggle = (h, id) => h.document.getElementById(`mark-review-${questionIndex(h, id)}`);
async function markReview(h, id) {
  const button = reviewToggle(h, id);
  assert(button && button.className.split(' ').includes('mark-review'), `${id} has a Mark for review toggle`);
  const actions = card(h, id).querySelector('.question-actions');
  assert(actions && actions.children.includes(button) && actions.querySelector('.clear-response'), `${id} review toggle sits beside Clear response`);
  await button.click();
}
function assertReviewMark(h, id, marked, icon = marked ? '★' : null) {
  assert.equal(reviewToggle(h, id).attrs['aria-pressed'], String(marked), `${id} accessible review toggle state`);
  if (!h.ids['quiz-form'].hidden) assert.equal(nav(h, id).className.split(' ').includes('marked-review'), marked, `${id} map review marker`);
  if (icon !== null && !h.ids['quiz-form'].hidden) assert.equal(nav(h, id).querySelector('.nav-state-icon').textContent, icon, `${id} review map icon`);
}
const result = (h, id) => h.t.grade().find(row => row.question.id === id);
function reset(h) {
  Object.keys(h.t.answers).forEach(id => delete h.t.answers[id]);
  h.t.setSubmitted('');
}
function correctResponse(row) {
  return row.type === 'nat' ? String(row.ranges[0].min) : row.type === 'msq' ? row.answer.split(',') : row.answer.split(',')[0];
}
function wrongResponse(row) {
  if (row.type === 'nat') return String(Math.max(...row.ranges.map(range => range.max)) + 1);
  if (row.type === 'msq') return row.answer === 'A' ? ['B'] : ['A'];
  return 'ABCD'.split('').find(letter => !row.answer.split(',').includes(letter));
}
function allText(node) { return [node.textContent, ...node.children.map(allText)].join(' '); }

(async () => {
  const h = await load(FOLDER), { t, data, ids } = h;
  const noDialogs = rejectFileDialogs(h);
  assert.equal(data.id, 'gate-cse-2021-set-2-session-6');
  assert.equal(data.questions.length, 65);
  assert.equal(VERIFIED_KEY.length, 65, 'Independent key must cover every question');
  same(data.questions.reduce((counts, q) => ({ ...counts, [q.type]: (counts[q.type] || 0) + 1 }), {}), { mcq: 34, msq: 13, nat: 18 });
  t.validate(); assertEditable(h);
  same(data.questions.map(q => q.id), [
    ...Array.from({ length: 10 }, (_, i) => `GA-${i + 1}`),
    ...Array.from({ length: 55 }, (_, i) => `CS-${i + 1}`)
  ], 'Section-aware numbering and source order');
  assert.equal(new Set(data.questions.map(q => q.id)).size, 65);
  assert.equal(data.questions.reduce((sum, q) => sum + q.marks, 0), 100);
  for (const name of ['quiz.js', 'theme.js', 'styles.css']) {
    assert.equal(sha256(path.join(FOLDER, name)), sha256(path.join(TEMPLATE, name)), `${name} matches shared runtime`);
  }
  for (const [name, hash] of [
    [data.questionPaper, '413F505A27B48DBA60863120740AAA231AC39909B267938F75D24FEE9F8AF3EA'],
    [data.answerKey, 'B211FBBEF2134BD355DD4D76301D800E83CB4E841EBEF74706A4C55DB1EA24C8']
  ]) {
    assert(name && !path.isAbsolute(name), 'Source PDF path is relative');
    assert.equal(sha256(path.join(FOLDER, name)), hash, `${name} preserves the supplied original`);
  }
  let imageCount = 0;
  for (let i = 0; i < data.questions.length; i++) {
    const q = data.questions[i], key = VERIFIED_KEY[i];
    assert.equal(q.id, key.id); assert.equal(q.type, key.type, q.id);
    assert.equal(q.marks, key.marks, `${q.id} marks`);
    assert.equal(q.incorrectMarks, key.type === 'mcq' ? -key.marks / 3 : 0, `${q.id} penalty`);
    assert.equal(q.section, q.id.split('-')[0]);
    assert.equal(q.number, Number(q.id.split('-')[1]));
    assert(q.displayLabel && Number.isInteger(q.answerKeyPage) && q.answerKeyPage > 0, `${q.id} source labels`);
    assert(!q.marksToAll, `${q.id}: verify any new MTA exception against the independent key`);
    if (key.type === 'nat') same(q.correctRanges, key.ranges, `${q.id} numerical key`);
    else {
      same(q.options.map(option => option.id), ['A', 'B', 'C', 'D'], `${q.id} original option order`);
      if (key.type === 'msq') same(q.correctAnswers, key.answer.split(','), `${q.id} exact-set key`);
      else same(q.acceptedAnswers || [q.correctAnswer], key.answer.split(','), `${q.id} single-choice key`);
    }
    assert(q.images.length && q.sourcePages.length, `${q.id} has original image content`);
    same(q.sourcePages, [...new Set(q.images.map(image => image.page))], `${q.id} source page metadata`);
    for (const image of q.images) {
      assert(!path.isAbsolute(image.src) && !image.src.includes('..') && !/^[a-z]+:/i.test(image.src), `${q.id} uses a relative local image`);
      assert(image.alt && Number.isInteger(image.page) && image.page > 0, `${q.id} image accessibility/source page`);
      const bytes = fs.readFileSync(path.join(FOLDER, image.src));
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${q.id} lossless PNG`);
      assert(bytes.readUInt32BE(16) > 100 && bytes.readUInt32BE(20) > 40, `${q.id} nonempty image dimensions`);
      imageCount++;
    }
  }
  const html = fs.readFileSync(path.join(FOLDER, 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert(!/^[a-z]+:/i.test(match[1]) && !path.isAbsolute(match[1]), 'HTML resources are local');
    assert(fs.existsSync(path.join(FOLDER, match[1])), `Missing ${match[1]}`);
  }
  assert(ids['review-attempt'], 'Review last attempt is the only attempt control');
  assert(ids['review-attempt'].disabled, 'A missing last submission disables Review');
  assert.equal(ids['review-attempt'].title, 'This paper has not been attempted before.');
  assert.equal(h.requests.length, 1, 'Opening a paper checks its saved attempt once');
  assert.equal(h.requests[0].method, 'GET');
  assert.equal(h.requests[0].url, attemptUrl(h));
  assert.equal(h.requests[0].cache, 'no-store');
  const blankSaved = await load(FOLDER, { server: [[attemptUrl(h), { answers: Object.fromEntries(data.questions.map(q => [q.id, null])) }]] });
  assert(blankSaved.ids['review-attempt'].disabled, 'An all-null saved attempt disables Review');
  assert.equal(ids.questions.querySelectorAll('fieldset').length, 65);
  assert.equal(ids.questions.querySelectorAll('img').length, imageCount);
  assert.equal(ids['nav-groups'].querySelectorAll('.nav-question').length, 65);
  same(ids['nav-groups'].querySelectorAll('h3').map(node => node.textContent), ['GA', 'CS']);
  assert.equal(ids['nav-progress'].textContent, '0 attempted · 65 not attempted');

  // Blank, perfect, every-wrong, and mixed attempts use the independent key.
  let summary = t.summarize(t.grade());
  assert.equal(summary.score, 0); assert.equal(summary.maximum, 100);
  same(summary.counts, { correct: 0, incorrect: 0, unanswered: 65, awarded: 0 });
  for (const row of VERIFIED_KEY) t.answers[row.id] = correctResponse(row);
  summary = t.summarize(t.grade()); assert.equal(summary.score, 100);
  same(summary.counts, { correct: 65, incorrect: 0, unanswered: 0, awarded: 0 });
  for (const row of VERIFIED_KEY) t.answers[row.id] = wrongResponse(row);
  summary = t.summarize(t.grade());
  close(summary.score, -VERIFIED_KEY.filter(row => row.type === 'mcq').reduce((sum, row) => sum + row.marks, 0) / 3, 'Every-wrong penalty');
  same(summary.counts, { correct: 0, incorrect: 65, unanswered: 0, awarded: 0 });
  reset(h); let mixedScore = 0, mixedCounts = { correct: 0, incorrect: 0, unanswered: 0, awarded: 0 };
  VERIFIED_KEY.forEach((row, i) => {
    if (i % 3 === 0) { t.answers[row.id] = correctResponse(row); mixedScore += row.marks; mixedCounts.correct++; }
    else if (i % 3 === 1) { t.answers[row.id] = wrongResponse(row); mixedScore += row.type === 'mcq' ? -row.marks / 3 : 0; mixedCounts.incorrect++; }
    else mixedCounts.unanswered++;
  });
  summary = t.summarize(t.grade()); close(summary.score, mixedScore, 'Mixed score'); same(summary.counts, mixedCounts);

  let msqSelections = 0, natBoundaryChecks = 0;
  for (const row of VERIFIED_KEY) {
    if (row.type === 'nat') {
      for (const range of row.ranges) for (const value of [range.min, range.max, range.min - 0.0001, range.max + 0.0001]) {
        t.answers[row.id] = String(value);
        const correct = row.ranges.some(r => value >= r.min && value <= r.max);
        assert.equal(result(h, row.id).outcome, correct ? 'correct' : 'incorrect', `${row.id}: inclusive boundaries ${value}`);
        natBoundaryChecks++;
      }
      const ordered = [...row.ranges].sort((a, b) => a.min - b.min);
      for (let i = 1; i < ordered.length; i++) if (ordered[i - 1].max < ordered[i].min) {
        t.answers[row.id] = String((ordered[i - 1].max + ordered[i].min) / 2);
        assert.equal(result(h, row.id).outcome, 'incorrect', `${row.id} does not widen discrete alternatives`);
      }
    } else if (row.type === 'msq') {
      const expected = row.answer.split(',');
      for (let mask = 0; mask < 16; mask++) {
        const selected = 'ABCD'.split('').filter((_, i) => mask & (1 << i));
        if (selected.length) t.answers[row.id] = selected;
        else delete t.answers[row.id];
        const correct = selected.length === expected.length && selected.every(value => expected.includes(value));
        const outcome = !selected.length ? 'unanswered' : correct ? 'correct' : 'incorrect';
        assert.equal(result(h, row.id).outcome, outcome, `${row.id} subset ${selected}`);
        assert.equal(result(h, row.id).earned, correct ? row.marks : 0);
        msqSelections++;
      }
      t.answers[row.id] = [...expected].reverse();
      assert.equal(result(h, row.id).outcome, 'correct', `${row.id} is order independent`);
    } else {
      for (const option of 'ABCD') {
        t.answers[row.id] = option;
        assert.equal(result(h, row.id).outcome, row.answer.split(',').includes(option) ? 'correct' : 'incorrect', `${row.id} option ${option}`);
      }
    }
  }

  // New paper's local draft restores raw controls/map, survives invalid Submit,
  // then clears on valid Submit while keeping the full report in this page.
  reset(h); t.renderQuestions();
  const mcq = VERIFIED_KEY.find(row => row.type === 'mcq');
  const msq = VERIFIED_KEY.find(row => row.type === 'msq');
  const nat = VERIFIED_KEY.find(row => row.type === 'nat');
  await editResponse(h, mcq.id, correctResponse(mcq));
  await editResponse(h, msq.id, correctResponse(msq));
  await editResponse(h, nat.id, '-');
  await markReview(h, mcq.id); await markReview(h, nat.id); await markReview(h, 'GA-2');
  assertReviewMark(h, mcq.id, true); assertReviewMark(h, 'GA-2', true);
  assertReviewMark(h, nat.id, true, '!');
  assert(!Object.hasOwn(t.answers, 'GA-2'), 'Review marking an unanswered question does not supply an answer');
  assert.equal(h.requests.length, 1, 'Question edits add no requests after the availability check');
  assert.equal(ids['nav-progress'].textContent, '3 attempted · 62 not attempted');
  assert(nav(h, nat.id).className.includes('needs-check'));
  assert.equal(nav(h, nat.id).querySelector('.nav-state-icon').textContent, '!');
  await nav(h, nat.id).click(); assert(card(h, nat.id).focused);
  const cached = JSON.parse(h.storage.get(draftKey(h)));
  assert(Array.isArray(cached.reviewFlags), 'Review flags use a known-question ID array');
  same([...cached.reviewFlags].sort(), [mcq.id, nat.id, 'GA-2'].sort(), 'Review flags match the current practice draft');
  assert.equal(cached.answers[nat.id], '-'); assert(cached.updatedAt);
  assert.equal(cached.signature, JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }));
  assert(!Object.hasOwn(cached, 'score') && !Object.hasOwn(cached, 'results'));
  const restored = await load(FOLDER, { storage: h.storage });
  same(restored.t.answers, JSON.parse(JSON.stringify(h.t.answers)));
  assertReviewMark(restored, mcq.id, true); assertReviewMark(restored, 'GA-2', true);
  assertReviewMark(restored, nat.id, true, '!');
  assert.equal(card(restored, nat.id).querySelector('input').value, '-');
  assert.equal(card(restored, nat.id).querySelector('input').attrs['aria-invalid'], 'true');
  assert(card(restored, mcq.id).querySelectorAll('input').find(input => input.value === correctResponse(mcq)).checked);
  same(card(restored, msq.id).querySelectorAll('input').filter(input => input.checked).map(input => input.value), correctResponse(msq));
  const beforeInvalid = h.storage.get(draftKey(h));
  await restored.ids['quiz-form'].fire('submit');
  assert(restored.ids.report.hidden); assert(card(restored, nat.id).querySelector('input').focused);
  assert.equal(h.storage.get(draftKey(h)), beforeInvalid);
  assertReviewMark(restored, nat.id, true, '!');
  assert.equal(restored.requests.length, 1, 'Invalid NAT adds no requests after the availability check');
  await editResponse(restored, nat.id, correctResponse(nat));
  await restored.ids['quiz-form'].fire('submit');
  assert(!restored.ids.report.hidden); assert(restored.ids['quiz-form'].hidden);
  assert(!h.storage.has(draftKey(h)));
  for (const id of [mcq.id, nat.id, 'GA-2']) assertReviewMark(restored, id, false);
  assert.equal(restored.requests.length, 2); assert.equal(restored.requests[1].method, 'POST');
  assert.equal(restored.requests[1].url, attemptUrl(restored));
  assert(!restored.ids['review-attempt'].disabled, 'Saving non-null responses enables Review');
  const submission = restored.server.get(attemptUrl(restored));
  same([...submission.reviewFlags].sort(), [mcq.id, nat.id, 'GA-2'].sort(), 'Submission retains its report review markers');
  assert.deepStrictEqual(Object.keys(submission).sort(), ['answers', 'quizId', 'quizSignature', 'quizTitle', 'results', 'reviewFlags', 'submittedAt', 'summary', 'updatedAt', 'version'].sort(), 'Version 1 envelope includes report review markers');
  assert(!Object.hasOwn(submission.answers, 'reviewFlags'));
  assert(submission.results.every(row => !Object.hasOwn(row, 'reviewFlags')), 'Per-question stored results omit draft review flags');
  assert.equal(submission.quizId, data.id); assert.equal(submission.version, 1);
  assert.equal(submission.quizSignature, JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }));
  assert.equal(Object.keys(submission.answers).length, 65); assert.equal(submission.results.length, 65);
  assert.equal(submission.answers[mcq.id], correctResponse(mcq));
  same(submission.answers[msq.id], correctResponse(msq)); assert.equal(submission.answers[nat.id], correctResponse(nat));
  assert.equal(submission.answers['GA-2'], null);
  assert.equal(submission.summary.score, mcq.marks + msq.marks + nat.marks); assert.equal(submission.summary.maximum, 100);
  assert.equal(restored.ids['report-list'].querySelectorAll('.result-card').length, 65);
  assert.equal(restored.ids['report-list'].querySelectorAll('img').length, imageCount);
  for (let i = 0; i < data.questions.length; i++) {
    const reportCard = restored.document.getElementById(`result-card-${i}`), text = allText(reportCard);
    assert(text.includes('Your answer:') && text.includes('Correct answer:') && text.includes('marks'), `${data.questions[i].id} full report`);
    assert(text.includes(restored.t.plainAnswer(data.questions[i], data.questions[i].correctAnswer, true)), `${data.questions[i].id} official answer in report`);
  }
  await nav(restored, nat.id).click();
  assert(restored.document.getElementById(`result-card-${questionIndex(restored, nat.id)}`).focused);
  const fresh = await load(FOLDER, { storage: h.storage });
  assert.equal(Object.keys(fresh.t.answers).length, 0); assert(fresh.ids.report.hidden); assertEditable(fresh);
  for (const id of [mcq.id, nat.id, 'GA-2']) assertReviewMark(fresh, id, false);
  await restored.ids['retry-quiz'].click();
  assert.equal(restored.requests.length, 2, 'Retry preserves the server submission');
  assert.equal(restored.ids['status-message'].textContent, 'New attempt started. Progress is cached until Submit.');
  assert(!restored.ids['status-message'].hidden && !restored.ids['status-message'].className.split(' ').includes('error'));
  assert.equal(Object.keys(restored.t.answers).length, 0); assert(restored.ids.report.hidden); assertEditable(restored);
  assert.equal(restored.ids['nav-progress'].textContent, '0 attempted · 65 not attempted');
  await editResponse(restored, nat.id, '0');
  await markReview(restored, nat.id);
  assert.equal(JSON.parse(h.storage.get(draftKey(h))).answers[nat.id], '0');
  await card(restored, nat.id).querySelector('.clear-response').click();
  assert.equal(Object.keys(restored.t.answers).length, 0);
  assertReviewMark(restored, nat.id, true);
  same(JSON.parse(h.storage.get(draftKey(h))).reviewFlags, [nat.id], 'Clear response preserves the review flag');
  const markOnly = await load(FOLDER, { storage: h.storage });
  assert.equal(Object.keys(markOnly.t.answers).length, 0); assertReviewMark(markOnly, nat.id, true);
  assert.equal(markOnly.ids['nav-progress'].textContent, '0 attempted · 65 not attempted');
  await editResponse(restored, mcq.id, correctResponse(mcq));
  await restored.ids['clear-answers'].click();
  assert.equal(restored.requests.length, 2, 'Clearing practice responses does not save to disk');
  const cleared = await load(FOLDER, { storage: h.storage });
  assert.equal(Object.keys(cleared.t.answers).length, 0);
  assertReviewMark(cleared, nat.id, false);

  // A saved Set 2 report can be reviewed while a separate unfinished draft is
  // cached. Its answers are regraded, and returning restores the active draft.
  const reviewing = await load(FOLDER, { server: restored.server });
  assert(!reviewing.ids['review-attempt'].disabled, 'A saved non-null response enables Review on reopening');
  await editResponse(reviewing, mcq.id, wrongResponse(mcq)); await editResponse(reviewing, nat.id, '-');
  await markReview(reviewing, mcq.id); await markReview(reviewing, nat.id);
  const activeDraft = reviewing.storage.get(draftKey(reviewing)), savedDisk = JSON.stringify(submission);
  await reviewing.ids['review-attempt'].click();
  assert.equal(reviewing.requests.length, 2); assert.equal(reviewing.requests[1].method, 'GET');
  assert.equal(reviewing.requests[1].cache, 'no-store'); assert(!reviewing.ids.report.hidden);
  assert.equal(reviewing.t.answers[mcq.id], correctResponse(mcq));
  same(reviewing.ids['nav-groups'].querySelectorAll('.marked-review').map(button => data.questions[Number(button.id.replace('nav-question-', ''))].id).sort(), [...submission.reviewFlags].sort(), 'Report uses saved review markers');
  assert.equal(reviewing.storage.get(draftKey(reviewing)), activeDraft);
  assert.equal(JSON.stringify(reviewing.server.get(attemptUrl(reviewing))), savedDisk);
  assert.equal(reviewing.t.summarize(reviewing.t.grade()).score, mcq.marks + msq.marks + nat.marks);
  await reviewing.ids['retry-quiz'].click();
  assert(reviewing.ids.report.hidden); assert.equal(reviewing.t.answers[mcq.id], wrongResponse(mcq));
  assert.equal(reviewing.t.answers[nat.id], '-'); assert.equal(reviewing.storage.get(draftKey(reviewing)), activeDraft);
  assertReviewMark(reviewing, mcq.id, true); assertReviewMark(reviewing, nat.id, true, '!');
  assert.equal(reviewing.requests.length, 2); assertEditable(reviewing);
  const reopened = await load(FOLDER, { storage: reviewing.storage, server: reviewing.server });
  assert.equal(reopened.t.answers[mcq.id], wrongResponse(mcq)); assert.equal(reopened.t.answers[nat.id], '-');
  assertReviewMark(reopened, mcq.id, true); assertReviewMark(reopened, nat.id, true, '!');

  // Existing paper drafts and independent theme storage are left intact.
  const shared = new Map(), set1 = await load(path.resolve(__dirname, '../gate-cse-2021-set-1'), { storage: shared });
  await editResponse(set1, 'GA-1', 'C'); await markReview(set1, 'CS-1');
  const set1Draft = shared.get(draftKey(set1));
  const set2 = await load(FOLDER, { storage: shared });
  assert.equal(Object.keys(set2.t.answers).length, 0);
  assertReviewMark(set2, 'CS-1', false);
  await editResponse(set2, mcq.id, correctResponse(mcq));
  await markReview(set2, mcq.id);
  vm.runInContext(fs.readFileSync(path.join(FOLDER, 'theme.js'), 'utf8'), set2.ctx);
  set2.document.DOMContentLoaded();
  const beforeTheme = shared.get(draftKey(set2));
  await set2.ids['theme-toggle'].click();
  assert.equal(shared.get('practice-quiz:theme'), 'dark'); assert.equal(shared.get(draftKey(set2)), beforeTheme);
  await set2.ids['quiz-form'].fire('submit');
  assert.equal(shared.get(draftKey(set1)), set1Draft); assert.equal(shared.get('practice-quiz:theme'), 'dark');
  assert(!shared.has(draftKey(set2)));
  assertReviewMark(set1, 'CS-1', true);
  const legacy = { ...cached }; delete legacy.reviewFlags;
  const legacyDraft = await load(FOLDER, { storage: [[draftKey(h), JSON.stringify(legacy)]] });
  same(legacyDraft.t.answers, cached.answers, 'Legacy drafts without review flags still restore their responses');
  assert(!legacyDraft.ids['nav-groups'].querySelectorAll('.marked-review').length);
  for (const bad of ['{bad', JSON.stringify({ ...cached, signature: 'another paper' }), JSON.stringify({ ...cached, answers: { 'CS-999': 'A' } })]) {
    const invalid = await load(FOLDER, { storage: [[draftKey(h), bad]] });
    assert.equal(Object.keys(invalid.t.answers).length, 0); assert(!invalid.storage.has(draftKey(h))); assertEditable(invalid);
  }
  const unavailable = await load(FOLDER, { storageUnavailable: true });
  const unavailableDialogs = rejectFileDialogs(unavailable);
  await editResponse(unavailable, mcq.id, correctResponse(mcq));
  await markReview(unavailable, mcq.id); assertReviewMark(unavailable, mcq.id, true);
  assert(/unavailable|could not|cannot|failed/i.test(unavailable.ids['status-message'].textContent));
  await unavailable.ids['quiz-form'].fire('submit'); assert(!unavailable.ids.report.hidden);
  await unavailable.ids['retry-quiz'].click(); assertEditable(unavailable); assert.equal(Object.keys(unavailable.t.answers).length, 0);
  assertReviewMark(unavailable, mcq.id, false);
  assert.equal(unavailable.ids['status-message'].textContent, 'Could not cache your progress. Keep this tab open to retain your answers.');
  assert(!unavailable.ids['status-message'].hidden && unavailable.ids['status-message'].className.split(' ').includes('error'), 'Retry must preserve the cache-write failure warning');
  const failedSave = await load(FOLDER, { fetch: (request, perform, response) => request.method === 'POST' ? response(500, { error: 'Simulated write failure' }) : perform() });
  await editResponse(failedSave, mcq.id, correctResponse(mcq)); await markReview(failedSave, mcq.id);
  await failedSave.ids['quiz-form'].fire('submit');
  assert(!failedSave.ids.report.hidden, 'A failed server save still displays the grade report');
  same(JSON.parse(failedSave.storage.get(draftKey(failedSave))).reviewFlags, [mcq.id], 'Failed Submit retains cached review flags');
  assert.equal(reviewToggle(failedSave, mcq.id).attrs['aria-pressed'], 'true', 'Failed save retains the draft review toggle');
  assert(nav(failedSave, mcq.id).className.split(' ').includes('marked-review'), 'A failed-save report retains its review star');
  assert(!failedSave.server.size, 'Failed Submit does not create a saved attempt');
  same(JSON.parse(failedSave.requests.at(-1).body).reviewFlags, [mcq.id], 'POST includes report markers even if the save fails');
  const failedReopen = await load(FOLDER, { storage: failedSave.storage });
  assertReviewMark(failedReopen, mcq.id, true);
  await failedSave.ids['retry-quiz'].click(); assertReviewMark(failedSave, mcq.id, false);
  assert(!failedSave.server.size, 'Retry does not write draft review flags to disk');
  noDialogs(); unavailableDialogs();
  console.log(`PASS: Set 2 independent 65-question key, original PDF hashes, source PNGs/local paths/shared runtime, blank/perfect/mixed/wrong scores, ${msqSelections} MSQ subsets, ${natBoundaryChecks} NAT boundary checks, every MCQ option, maps/full reports, raw browser draft and review-flag reopen, invalid/failed Submit retaining flags, submitted report flags/cache clear, saved review/draft flag resume, Retry/clear disk preservation, paper/theme/flag isolation, legacy drafts, storage failures, no file dialogs.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
