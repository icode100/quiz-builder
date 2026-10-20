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
  // Match the real carousel nesting so busy-state checks include its controls.
  if (ids['question-carousel']) {
    ids['question-carousel'].append(ids['previous-question'], ids['carousel-position'], ids['next-question']);
    ids['quiz-form'].append(ids['question-carousel'], ids.questions, ids.progress, ids['clear-answers']);
  } else ids['quiz-form'].append(ids.questions, ids.progress, ids['clear-answers']);
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
    save, numericValue, plainAnswer, answers, reviewFlags, checkLastAttempt,
    setSubmitted: value => { submittedAt = value; }
  };
${marker}`);
  const initialCheck = '    checkLastAttempt();';
  assert(source.includes(initialCheck), 'last-attempt status check injection point is missing');
  source = source.replace(initialCheck, '    window.test.initialCheck = checkLastAttempt();');
  vm.runInContext(source, ctx);
  assert(!ids['status-message'].textContent.startsWith('Unable'), ids['status-message'].textContent);
  return { ctx, window, document, ids, t: window.test, data: window.QUIZ_DATA, storage, server, requests, submit };
}
async function load(folder = 'gate-cse-2021-set-1', options = {}) {
  const h = createHarness(folder, options);
  if (options.waitForInitialCheck !== false) await h.t.initialCheck;
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
const postRequests = h => h.requests.filter(request => request.method === 'POST');
const getRequests = h => h.requests.filter(request => request.method === 'GET');
function assertReviewAvailability(h, available) {
  assert.equal(h.ids['review-attempt'].disabled, !available);
  const title = available ? '' : 'This paper has not been attempted before.';
  assert.equal(h.ids['review-attempt'].title, title);
  assert.equal(h.ids['review-attempt-wrap'].title, title, 'The disabled button has a hoverable tooltip wrapper');
}
function assertEditable(h) {
  assert(h.ids['quiz-form'].querySelectorAll('input, button').filter(node => !['previous-question', 'next-question'].includes(node.id)).every(node => !node.disabled), 'practice remains usable without file access');
}

async function editResponse(h, id, value) {
  const index = h.data.questions.findIndex(question => question.id === id);
  assert(index >= 0, `Unknown test question ${id}`);
  const question = h.data.questions[index];
  const card = h.document.getElementById(`question-card-${index}`);
  if (card.hidden) await h.document.getElementById(`nav-question-${index}`).click();
  const inputs = card.querySelectorAll('input');
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
function reviewButton(h, id) {
  return h.document.getElementById(`mark-review-${h.data.questions.findIndex(question => question.id === id)}`);
}
function assertFlags(h, expected, visible = !h.ids['quiz-form'].hidden) {
  assert.deepEqual([...h.t.reviewFlags].sort(), [...expected].sort());
  for (const [index, question] of h.data.questions.entries()) {
    const marked = expected.includes(question.id), button = reviewButton(h, question.id);
    assert.equal(button.attrs['aria-pressed'], String(marked));
    assert.equal(button.textContent, marked ? 'Unmark review' : 'Mark for review');
    assert(button.attrs['aria-label'].includes(question.displayLabel || question.id));
    const map = h.document.getElementById(`nav-question-${index}`);
    if (visible) {
      assert.equal(map.className.split(' ').includes('marked-review'), marked);
      assert.equal(map.attrs['aria-label'].includes(', Marked for review'), marked);
    }
  }
  if (visible) assert.equal(h.ids['nav-review-legend'].hidden, false, 'Practice shows the review legend');
}

(async () => {
  const h = await load(), { t, data, ids } = h;
  assert.equal(h.requests.length, 1, 'Opening reads saved availability once without writing');
  assert.equal(h.requests[0].method, 'GET'); assert.equal(h.requests[0].url, attemptUrl(h));
  assert.equal(h.requests[0].cache, 'no-store'); assertReviewAvailability(h, false);
  const statusFixtures = [
    [undefined, false], [null, false], [{}, false], [[], false],
    [{ answers: null }, false], [{ answers: [] }, false], [{ answers: {} }, false],
    [{ answers: { 'GA-1': null, 'CS-16': null } }, false],
    [{ answers: { 'CS-16': 0 } }, true], [{ answers: { 'CS-16': '0' } }, true],
    [{ answers: { 'CS-11': [] } }, true], [{ answers: { 'CS-11': ['A'] } }, true],
    [{ answers: { 'GA-1': 'C', 'GA-2': null } }, true]
  ];
  for (const [saved, available] of statusFixtures) {
    const statusCheck = await load('gate-cse-2021-set-1', { server: saved === undefined ? [] : [[attemptUrl(h), saved]] });
    assertReviewAvailability(statusCheck, available); assertEditable(statusCheck);
    assert.equal(statusCheck.requests.length, 1); assert.equal(postRequests(statusCheck).length, 0);
    assert.equal(Object.keys(statusCheck.t.answers).length, 0, 'Checking saved availability never restores submitted answers into practice');
    if (!available) {
      await statusCheck.ids['review-attempt'].click();
      assert.equal(statusCheck.requests.length, 1, 'Disabled Review does not fetch even when a click is invoked programmatically');
    }
  }

  // Practice review flags belong to the current draft. A flag neither answers a
  // question nor makes a saved report available, and toggling never fetches.
  const marked = await load(), markedSignature = JSON.stringify(marked.data);
  const markedDialogs = rejectFileDialogs(marked);
  assertFlags(marked, []);
  const actionRow = marked.document.getElementById('question-card-0').querySelector('.question-actions');
  assert(actionRow.querySelector('.clear-response') && actionRow.querySelector('.mark-review'), 'Clear and review controls share an action row');
  assert.equal(reviewButton(marked, 'GA-1').type, 'button');
  await reviewButton(marked, 'GA-1').click();
  assertFlags(marked, ['GA-1']); assertReviewAvailability(marked, false);
  assert.equal(Object.keys(marked.t.answers).length, 0);
  assert(marked.ids['nav-progress'].textContent.startsWith('0 attempted'));
  assert.equal(marked.document.getElementById('nav-question-0').querySelector('.nav-state-icon').textContent, '★');
  assert.equal(marked.t.summarize(marked.t.grade()).score, 0);
  const flaggedDraft = JSON.parse(marked.storage.get(draftKey(marked)));
  assert.deepEqual(flaggedDraft.reviewFlags, ['GA-1']);
  await editResponse(marked, 'GA-1', 'C');
  await marked.document.getElementById('question-card-0').querySelector('.clear-response').click();
  assertFlags(marked, ['GA-1']); assert.equal(Object.keys(marked.t.answers).length, 0, 'Clear response preserves the review flag');
  await reviewButton(marked, 'CS-16').click(); await editResponse(marked, 'CS-16', '-');
  assertFlags(marked, ['GA-1', 'CS-16']);
  assert.equal(marked.document.getElementById('nav-question-25').querySelector('.nav-state-icon').textContent, '!', 'Invalid NAT retains its warning icon when flagged');
  const markedCache = marked.storage.get(draftKey(marked));
  await marked.ids['quiz-form'].fire('submit');
  assertFlags(marked, ['GA-1', 'CS-16']); assert.equal(marked.storage.get(draftKey(marked)), markedCache);
  assert.equal(marked.ids.report.hidden, true); assert.equal(marked.requests.length, 1);
  const reopenedFlags = await load('gate-cse-2021-set-1', { storage: marked.storage });
  assertFlags(reopenedFlags, ['GA-1', 'CS-16']); assert.equal(reopenedFlags.t.answers['CS-16'], '-');
  await reviewButton(reopenedFlags, 'GA-1').click(); assertFlags(reopenedFlags, ['CS-16']);
  assert.deepEqual(JSON.parse(marked.storage.get(draftKey(marked))).reviewFlags, ['CS-16']);
  await reopenedFlags.ids['clear-answers'].click(); assertFlags(reopenedFlags, []);
  assert.deepEqual(JSON.parse(marked.storage.get(draftKey(marked))).reviewFlags, []);
  assert.equal(reopenedFlags.requests.length, 1); assert.equal(marked.requests.length, 1);
  assert.equal(JSON.stringify(marked.data), markedSignature, 'Flags do not change question data or its cache signature');
  markedDialogs();
  t.validate(); assert.equal(data.questions.length, 65);
  assert.equal(t.summarize(t.grade()).maximum, 100); assert.equal(t.summarize(t.grade()).score, 0);
  assertEditable(h);
  const counts = {};
  for (const q of data.questions) { counts[q.type] = (counts[q.type] || 0) + 1; assert(fs.existsSync('gate-cse-2021-set-1/' + q.images[0].src)); }
  assert.deepEqual(counts, { mcq: 34, msq: 13, nat: 18 });
  const reset = () => { for (const key of Object.keys(t.answers)) delete t.answers[key]; t.setSubmitted(''); };
  for (const q of data.questions) t.answers[q.id] = q.type === 'nat' ? String(q.correctRanges[0].min) : q.type === 'msq' ? [...q.correctAnswers] : q.correctAnswer;
  assert.equal(t.summarize(t.grade()).score, 100); assert.equal(t.summarize(t.grade()).counts.correct, 65);
  for (const q of data.questions.filter(q => q.type === 'nat')) for (const range of q.correctRanges) {
    for (const value of [range.min, range.max]) { t.answers[q.id] = String(value); assert.equal(t.grade().find(r => r.question.id === q.id).outcome, 'correct'); }
    for (const value of [range.min - .00001, range.max + .00001]) { t.answers[q.id] = String(value); assert.equal(t.grade().find(r => r.question.id === q.id).outcome, 'incorrect'); }
  }
  for (const value of ['205', '819', '819.5', '820']) { t.answers['CS-23'] = value; assert.equal(t.grade().find(r => r.question.id === 'CS-23').outcome, 'correct'); }
  t.answers['CS-23'] = '500'; assert.equal(t.grade().find(r => r.question.id === 'CS-23').outcome, 'incorrect');
  for (const q of data.questions.filter(q => q.type === 'msq')) for (let mask = 1; mask < 16; mask++) {
    const selected = 'ABCD'.split('').filter((_, i) => mask & (1 << i)); t.answers[q.id] = selected;
    const exact = selected.length === q.correctAnswers.length && selected.every(value => q.correctAnswers.includes(value));
    assert.equal(t.grade().find(r => r.question.id === q.id).outcome, exact ? 'correct' : 'incorrect');
  }
  for (const answer of ['C', 'D']) { t.answers['GA-9'] = answer; assert.equal(t.grade()[8].outcome, 'correct'); }
  t.answers['GA-9'] = 'A'; assert.equal(t.grade()[8].outcome, 'incorrect');
  for (const q of data.questions) t.answers[q.id] = q.type === 'nat' ? '999999' : q.type === 'msq' ? ['A', 'B', 'C', 'D'] : q.options.find(o => !(q.acceptedAnswers || [q.correctAnswer]).includes(o.id)).id;
  assert(Math.abs(t.summarize(t.grade()).score + 53 / 3) < 1e-9);
  reset(); t.answers['GA-1'] = 'C'; t.answers['CS-11'] = ['A']; t.answers['CS-16'] = '11'; assert.equal(t.summarize(t.grade()).score, 2);
  for (const value of ['0', '-7.75', '.5', '12.', '+2']) assert.notEqual(t.numericValue(value), null);
  for (const value of ['-', '1e2', '1,000', '1/2', 'NaN', 'Infinity', '0xff']) assert.equal(t.numericValue(value), null);

  // Initial answers are usable without setup. Invalid NAT still blocks Submit.
  reset(); t.renderQuestions(); assertEditable(h);
  const cs11 = h.document.getElementById('question-card-20'), checkboxes = cs11.querySelectorAll('input');
  assert.equal(checkboxes[0].type, 'checkbox');
  checkboxes[0].checked = true; await checkboxes[0].fire('change');
  checkboxes[2].checked = true; await checkboxes[2].fire('change');
  assert.equal(t.answers['CS-11'].join(','), 'A,C'); assert(ids['nav-progress'].textContent.startsWith('1 attempted'));
  checkboxes[0].checked = false; await checkboxes[0].fire('change');
  checkboxes[2].checked = false; await checkboxes[2].fire('change');
  assert(!Object.hasOwn(t.answers, 'CS-11'));
  const nat = h.document.getElementById('question-card-25').querySelector('input');
  nat.value = '-'; await nat.fire('input'); assert.equal(nat.attrs['aria-invalid'], 'true');
  await ids['quiz-form'].fire('submit'); assert(nat.focused); assert.equal(ids.report.hidden, true);
  reset(); t.renderQuestions();

  // Every response caches the active draft, including zero and unfinished NAT.
  const noDialogs = rejectFileDialogs(h);
  await editResponse(h, 'GA-1', 'C'); await editResponse(h, 'CS-11', ['A', 'C']);
  await editResponse(h, 'CS-16', '0');
  assert.equal(postRequests(h).length, 0, 'Editing answers never writes attempt.json');
  assert.equal(getRequests(h).length, 1, 'Editing answers does not repeat the opening availability check');
  let draft = JSON.parse(h.storage.get(draftKey(h)));
  assert.equal(draft.answers['GA-1'], 'C');
  assert.equal(draft.answers['CS-11'].join(','), 'A,C'); assert.equal(draft.answers['CS-16'], '0');
  assert(draft.updatedAt); assert.equal(Object.hasOwn(draft, 'summary'), false);
  assert.equal(Object.hasOwn(draft, 'results'), false);
  await editResponse(h, 'CS-16', '-');
  await reviewButton(h, 'GA-1').click(); await reviewButton(h, 'CS-16').click();
  assertFlags(h, ['GA-1', 'CS-16']);
  draft = JSON.parse(h.storage.get(draftKey(h))); assert.equal(draft.answers['CS-16'], '-');
  const refreshed = await load('gate-cse-2021-set-1', { storage: h.storage });
  const refreshedDialogs = rejectFileDialogs(refreshed);
  assert.equal(refreshed.t.answers['GA-1'], 'C');
  assert.equal(refreshed.t.answers['CS-11'].join(','), 'A,C'); assert.equal(refreshed.t.answers['CS-16'], '-');
  assert.equal(refreshed.document.getElementById('question-card-0').querySelectorAll('input').find(input => input.value === 'C').checked, true);
  assert.equal(refreshed.document.getElementById('question-card-20').querySelectorAll('input').find(input => input.value === 'A').checked, true);
  const refreshedNat = refreshed.document.getElementById('question-card-25').querySelector('input');
  assert.equal(refreshedNat.value, '-'); assert.equal(refreshedNat.attrs['aria-invalid'], 'true');
  assert.equal(refreshed.ids.report.hidden, true); assert(refreshed.ids['nav-progress'].textContent.startsWith('3 attempted'));
  assertFlags(refreshed, ['GA-1', 'CS-16']);
  assertEditable(refreshed);

  // Invalid Submit leaves the draft intact; valid Submit grades and clears it.
  const beforeInvalidSubmit = h.storage.get(draftKey(h));
  await refreshed.ids['quiz-form'].fire('submit');
  assert.equal(refreshed.ids.report.hidden, true); assert(refreshedNat.focused);
  assert.equal(h.storage.get(draftKey(h)), beforeInvalidSubmit);
  assertFlags(refreshed, ['GA-1', 'CS-16']);
  assert.equal(postRequests(refreshed).length, 0, 'Invalid NAT Submit never writes to the server');
  assert.equal(getRequests(refreshed).length, 1, 'Invalid NAT Submit does not repeat the opening check');
  await editResponse(refreshed, 'CS-16', '11'); await refreshed.ids['quiz-form'].fire('submit');
  assert.equal(refreshed.ids.report.hidden, false); assert.equal(refreshed.ids['quiz-form'].hidden, true);
  assert.equal(h.storage.has(draftKey(h)), false, 'Valid Submit removes only the active draft');
  assert.equal(refreshed.ids['report-list'].querySelectorAll('img').length, 65);
  assert.equal(refreshed.t.grade()[20].outcome, 'correct');
  assert.equal(refreshed.ids['retry-quiz'].disabled, false);
  assert.equal(refreshed.requests.length, 2);
  assert.equal(postRequests(refreshed).length, 1); assert.equal(postRequests(refreshed)[0].url, attemptUrl(refreshed));
  assertReviewAvailability(refreshed, true);
  assertFlags(refreshed, []);
  const submittedAttempt = refreshed.server.get(attemptUrl(refreshed));
  assert.deepEqual(submittedAttempt.reviewFlags, ['GA-1', 'CS-16'], 'Submitted attempt keeps the report review markers');
  assert(submittedAttempt.results.every(result => !Object.hasOwn(result, 'reviewFlags')), 'Scored results exclude flags');
  assert.deepEqual(Object.keys(submittedAttempt.answers).sort(), refreshed.data.questions.map(question => question.id).sort());
  assert.equal(submittedAttempt.version, 1); assert(submittedAttempt.submittedAt && submittedAttempt.updatedAt);
  assert.equal(submittedAttempt.quizId, refreshed.data.id); assert.equal(submittedAttempt.quizTitle, refreshed.data.title);
  assert.equal(submittedAttempt.quizSignature, JSON.stringify({ questions: refreshed.data.questions, scoring: refreshed.data.scoring ?? null }));
  assert.equal(Object.keys(submittedAttempt.answers).length, 65, 'Saved submission has a response or null for every question');
  assert.equal(submittedAttempt.answers['GA-1'], 'C'); assert.equal(submittedAttempt.answers['CS-11'].join(','), 'A,C');
  assert.equal(submittedAttempt.answers['CS-16'], '11'); assert.equal(submittedAttempt.answers['GA-2'], null);
  assert.equal(submittedAttempt.results.length, 65); assert.equal(submittedAttempt.summary.score, refreshed.t.summarize(refreshed.t.grade()).score);
  assert.equal(submittedAttempt.summary.maximum, 100);
  for (const [index, result] of submittedAttempt.results.entries()) {
    const grade = refreshed.t.grade()[index]; assert.equal(result.questionId, grade.question.id);
    assert.deepEqual(result.answer, grade.selected === undefined ? null : JSON.parse(JSON.stringify(grade.selected)));
    assert.equal(result.outcome, grade.outcome); assert.equal(result.marksEarned, grade.earned);
    assert.equal(result.maxMarks, grade.question.marks); assert.equal(typeof result.correctAnswer, 'string');
  }
  await refreshed.document.getElementById('nav-question-20').click();
  assert(refreshed.document.getElementById('result-card-20').focused);
  const afterSubmit = await load('gate-cse-2021-set-1', { storage: h.storage });
  assert.equal(Object.keys(afterSubmit.t.answers).length, 0); assert.equal(afterSubmit.ids.report.hidden, true);
  assertFlags(afterSubmit, []);
  assert(afterSubmit.ids['nav-progress'].textContent.startsWith('0 attempted')); assertEditable(afterSubmit);
  await refreshed.ids['retry-quiz'].click();
  assert.equal(postRequests(refreshed).length, 1, 'Retry never overwrites the last submission');
  assert.equal(getRequests(refreshed).length, 1, 'Retry retains saved availability without another read');
  assertReviewAvailability(refreshed, true);
  assert.equal(refreshed.ids['status-message'].textContent, 'New attempt started. Progress is cached until Submit.');
  assert(!refreshed.ids['status-message'].hidden && !refreshed.ids['status-message'].className.split(' ').includes('error'));
  assert.equal(Object.keys(refreshed.t.answers).length, 0); assert.equal(refreshed.ids.report.hidden, true);
  assert.equal(refreshed.ids['quiz-form'].hidden, false);
  assertFlags(refreshed, []);
  assert(refreshed.ids['nav-progress'].textContent.startsWith('0 attempted')); assertEditable(refreshed);
  await editResponse(refreshed, 'GA-1', 'A');
  assert.equal(JSON.parse(h.storage.get(draftKey(h))).answers['GA-1'], 'A');
  noDialogs(); refreshedDialogs();

  // Last-submission review is read-only and leaves the current browser draft
  // intact. Returning from review resumes that draft, including unfinished NAT.
  const review = await load('gate-cse-2021-set-1', { server: refreshed.server });
  assert(review.ids['review-attempt']); assert.equal(review.requests.length, 1, 'Opening checks saved availability without restoring or saving an attempt');
  assertReviewAvailability(review, true);
  await editResponse(review, 'GA-1', 'A'); await editResponse(review, 'CS-16', '-');
  await reviewButton(review, 'GA-1').click(); await reviewButton(review, 'CS-16').click();
  const workingDraft = review.storage.get(draftKey(review)), diskBeforeReview = JSON.stringify(submittedAttempt);
  await review.ids['review-attempt'].click();
  assert.equal(review.requests.length, 2); assert(getRequests(review).every(request => request.url === attemptUrl(review) && request.cache === 'no-store'));
  assert.equal(postRequests(review).length, 0);
  assert.equal(review.ids.report.hidden, false); assert.equal(review.t.answers['GA-1'], 'C');
  assertFlags(review, ['GA-1', 'CS-16']);
  assert(review.ids['nav-progress'].textContent.startsWith('3 attempted'));
  assert.equal(review.storage.get(draftKey(review)), workingDraft, 'Review must not replace an unfinished browser draft');
  assert.equal(JSON.stringify(review.server.get(attemptUrl(review))), diskBeforeReview, 'Review never rewrites attempt.json');
  await review.ids['retry-quiz'].click();
  assert.equal(review.t.answers['GA-1'], 'A'); assert.equal(review.t.answers['CS-16'], '-');
  assert.equal(review.ids.report.hidden, true); assert.equal(review.document.getElementById('question-card-25').querySelector('input').value, '-');
  assertFlags(review, ['GA-1', 'CS-16']);
  assert(review.ids['nav-progress'].textContent.startsWith('2 attempted'));
  assert.equal(review.storage.get(draftKey(review)), workingDraft); assert.equal(review.requests.length, 2);
  const closedAndReopened = await load('gate-cse-2021-set-1', { storage: review.storage, server: review.server, url: review.window.location.href });
  assert.equal(closedAndReopened.t.answers['GA-1'], 'A'); assert.equal(closedAndReopened.t.answers['CS-16'], '-');
  assertFlags(closedAndReopened, ['GA-1', 'CS-16']);

  const forgedScore = JSON.parse(JSON.stringify(submittedAttempt));
  forgedScore.summary = { score: 9999, maximum: 9999, counts: { correct: 9999 } };
  forgedScore.results.forEach(result => { result.outcome = 'correct'; result.marksEarned = 9999; result.maxMarks = 9999; });
  const recomputed = await load('gate-cse-2021-set-1', { server: [[attemptUrl(refreshed), forgedScore]] });
  await recomputed.ids['review-attempt'].click();
  assert.equal(recomputed.ids['score-value'].textContent, refreshed.ids['score-value'].textContent, 'Review recomputes scores from the verified key');
  assert.equal(recomputed.t.grade().find(result => result.question.id === 'GA-2').outcome, 'unanswered');

  const damagedAttempts = [
    { ...submittedAttempt, version: 2 },
    { ...submittedAttempt, id: 'wrong-paper', quizId: 'wrong-paper' },
    { ...submittedAttempt, quizSignature: 'wrong-key' },
    { ...submittedAttempt, submittedAt: '' },
    { ...submittedAttempt, submittedAt: 'invalid' },
    { ...submittedAttempt, updatedAt: 'invalid' },
    { ...submittedAttempt, answers: { ...submittedAttempt.answers, 'unknown-question': 'A' } },
    { ...submittedAttempt, answers: { ...submittedAttempt.answers, 'GA-1': 'Z' } },
    { ...submittedAttempt, answers: { ...submittedAttempt.answers, 'CS-11': ['Z'] } },
    { ...submittedAttempt, answers: { ...submittedAttempt.answers, 'CS-11': ['A', 'A'] } },
    { ...submittedAttempt, answers: { ...submittedAttempt.answers, 'CS-16': '-' } },
    ...[null, 'GA-1', {}, [null], [1], ['unknown-question'], ['GA-1', 'GA-1']].map(reviewFlags => ({ ...submittedAttempt, reviewFlags }))
  ];
  for (const attempt of damagedAttempts) {
    const badReview = await load('gate-cse-2021-set-1', { server: [[attemptUrl(refreshed), attempt]] });
    await editResponse(badReview, 'GA-1', 'A'); const draftBefore = badReview.storage.get(draftKey(badReview));
    await badReview.ids['review-attempt'].click();
    assert.equal(badReview.ids.report.hidden, true); assert.equal(badReview.t.answers['GA-1'], 'A');
    assert.equal(badReview.storage.get(draftKey(badReview)), draftBefore); assertEditable(badReview);
    assert.equal(badReview.requests.filter(request => request.method === 'POST').length, 0);
  }
  for (const fetch of [undefined, async () => { throw Error('Offline'); }, async () => ({ ok: true, status: 200, async json() { throw Error('Invalid JSON'); } })]) {
    const missing = await load('gate-cse-2021-set-1', { fetch }); await editResponse(missing, 'GA-1', 'A');
    assertReviewAvailability(missing, false);
    const missingDraft = missing.storage.get(draftKey(missing)); await missing.ids['review-attempt'].click();
    assert.equal(missing.ids.report.hidden, true); assert.equal(missing.t.answers['GA-1'], 'A');
    assert.equal(missing.storage.get(draftKey(missing)), missingDraft); assertEditable(missing);
    assert.equal(missing.requests.length, 1, 'Missing/unreadable saved attempts leave Review disabled without another request');
  }

  // A new blank submission replaces the saved record and disables Review.
  // Retry/clear retain the availability of that disk record, independently of drafts.
  const blankSubmission = await load('gate-cse-2021-set-1', { server: [[attemptUrl(refreshed), submittedAttempt]] });
  assertReviewAvailability(blankSubmission, true);
  await reviewButton(blankSubmission, 'GA-1').click();
  await blankSubmission.ids['quiz-form'].fire('submit');
  assertFlags(blankSubmission, []);
  assertReviewAvailability(blankSubmission, false);
  assert(Object.values(blankSubmission.server.get(attemptUrl(blankSubmission)).answers).every(answer => answer === null));
  const savedBlank = JSON.stringify(blankSubmission.server.get(attemptUrl(blankSubmission)));
  await blankSubmission.ids['retry-quiz'].click(); await editResponse(blankSubmission, 'GA-1', 'C');
  await blankSubmission.ids['clear-answers'].click(); assertReviewAvailability(blankSubmission, false);
  assert.equal(JSON.stringify(blankSubmission.server.get(attemptUrl(blankSubmission))), savedBlank);
  assert.equal(postRequests(blankSubmission).length, 1); assert.equal(getRequests(blankSubmission).length, 1);
  const reopenedBlank = await load('gate-cse-2021-set-1', { server: blankSubmission.server });
  assertReviewAvailability(reopenedBlank, false);

  // If a saved attempt disappears or becomes all-null after opening, Review
  // refreshes availability and leaves unfinished answers and cache unchanged.
  for (const nextSaved of [undefined, { ...submittedAttempt, answers: Object.fromEntries(data.questions.map(question => [question.id, null])) }]) {
    const changed = await load('gate-cse-2021-set-1', { server: [[attemptUrl(refreshed), submittedAttempt]] });
    assertReviewAvailability(changed, true); await editResponse(changed, 'GA-1', 'A');
    const beforeChangedReview = changed.storage.get(draftKey(changed));
    if (nextSaved === undefined) changed.server.delete(attemptUrl(changed));
    else changed.server.set(attemptUrl(changed), nextSaved);
    await changed.ids['review-attempt'].click(); assertReviewAvailability(changed, false);
    assert.equal(changed.ids.report.hidden, true); assert.equal(changed.t.answers['GA-1'], 'A');
    assert.equal(changed.storage.get(draftKey(changed)), beforeChangedReview);
    assert.equal(postRequests(changed).length, 0);
  }

  // Failure to save must not disable an already-reviewable disk attempt or
  // enable Review for an unsolved paper.
  for (const hadSavedAttempt of [false, true]) {
    const failedAvailability = await load('gate-cse-2021-set-1', {
      server: hadSavedAttempt ? [[attemptUrl(refreshed), submittedAttempt]] : [],
      fetch: (request, perform, response) => request.method === 'POST' ? response(503, { error: 'Disk unavailable' }) : perform()
    });
    assertReviewAvailability(failedAvailability, hadSavedAttempt);
    await editResponse(failedAvailability, 'GA-1', 'C'); await failedAvailability.ids['quiz-form'].fire('submit');
    assertReviewAvailability(failedAvailability, hadSavedAttempt);
    await failedAvailability.ids['retry-quiz'].click(); assertReviewAvailability(failedAvailability, hadSavedAttempt);
    assert.equal(failedAvailability.server.has(attemptUrl(failedAvailability)), hadSavedAttempt);
    if (hadSavedAttempt) assert.equal(JSON.stringify(failedAvailability.server.get(attemptUrl(failedAvailability))), diskBeforeReview);
  }

  // Opening status reads are nonblocking. A late initial response must not
  // override availability derived from a newer successful save.
  for (const savedAnAnswer of [false, true]) {
    let finishInitialCheck;
    const lateStatus = await load('gate-cse-2021-set-1', {
      waitForInitialCheck: false,
      fetch: (request, perform, response) => request.method === 'POST' ? perform() : new Promise(resolve => {
        finishInitialCheck = () => resolve(savedAnAnswer ? response(404, { error: 'No saved attempt' }) : response(200, submittedAttempt));
      })
    });
    assertReviewAvailability(lateStatus, false); assertEditable(lateStatus);
    if (savedAnAnswer) await editResponse(lateStatus, 'GA-1', 'C');
    await lateStatus.ids['quiz-form'].fire('submit'); assertReviewAvailability(lateStatus, savedAnAnswer);
    finishInitialCheck(); await lateStatus.t.initialCheck; assertReviewAvailability(lateStatus, savedAnAnswer);
    assert.equal(postRequests(lateStatus).length, 1); assert.equal(getRequests(lateStatus).length, 1);
    assert.equal(lateStatus.storage.has(draftKey(lateStatus)), false);
  }

  // Submit keeps the draft until the server confirms the folder write. Network
  // and HTTP failures keep both the report and recoverable unfinished answers.
  for (const fetch of [async () => { throw Error('Offline'); }, async (_request, _perform, response) => response(503, { error: 'Disk unavailable' })]) {
    const failed = await load('gate-cse-2021-set-1', { fetch }); await editResponse(failed, 'GA-1', 'C');
    await reviewButton(failed, 'GA-1').click();
    const prior = failed.storage.get(draftKey(failed)); await failed.ids['quiz-form'].fire('submit');
    assert.equal(failed.ids.report.hidden, false);
    assertFlags(failed, ['GA-1']);
    const retainedDraft = JSON.parse(failed.storage.get(draftKey(failed)));
    assert.deepEqual(retainedDraft.answers, JSON.parse(prior).answers); assert(!retainedDraft.submittedAt);
    assert.deepEqual(retainedDraft.reviewFlags, ['GA-1']);
    assert.deepEqual(JSON.parse(postRequests(failed)[0].body).reviewFlags, ['GA-1']);
    assert.equal(failed.server.size, 0); assert.equal(failed.ids['retry-quiz'].disabled, false); assertEditable(failed);
    const recovered = await load('gate-cse-2021-set-1', { storage: failed.storage });
    assert.equal(recovered.t.answers['GA-1'], 'C'); assert.equal(recovered.ids.report.hidden, true);
    assertFlags(recovered, ['GA-1']);
    await failed.ids['retry-quiz'].click(); assertFlags(failed, []);
  }
  // Review preserves the separate markers of a failed-save report and returns
  // to that same report without changing the saved record.
  const failedReport = await load('gate-cse-2021-set-1', {
    server: [[attemptUrl(refreshed), submittedAttempt]],
    fetch: (request, perform, response) => request.method === 'POST' ? response(503, { error: 'Disk unavailable' }) : perform()
  });
  await editResponse(failedReport, 'GA-2', 'A'); await reviewButton(failedReport, 'GA-2').click();
  await failedReport.ids['quiz-form'].fire('submit'); assertFlags(failedReport, ['GA-2']);
  const failedReportDraft = failedReport.storage.get(draftKey(failedReport)), failedReportScore = failedReport.ids['score-value'].textContent;
  await failedReport.ids['review-attempt'].click(); assertFlags(failedReport, ['GA-1', 'CS-16']);
  assert.equal(failedReport.storage.get(draftKey(failedReport)), failedReportDraft);
  await failedReport.ids['retry-quiz'].click(); assertFlags(failedReport, ['GA-2']);
  assert.equal(failedReport.ids.report.hidden, false); assert.equal(failedReport.ids['score-value'].textContent, failedReportScore);
  assert.equal(failedReport.storage.get(draftKey(failedReport)), failedReportDraft);
  assert.equal(JSON.stringify(failedReport.server.get(attemptUrl(failedReport))), diskBeforeReview);
  let finishSubmit;
  const waiting = await load('gate-cse-2021-set-1', {
    fetch: (request, perform) => request.method === 'POST' ? new Promise(resolve => { finishSubmit = () => resolve(perform()); }) : perform()
  });
  await editResponse(waiting, 'GA-1', 'C'); await reviewButton(waiting, 'GA-1').click();
  const waitingDraft = waiting.storage.get(draftKey(waiting));
  const pendingSubmit = waiting.ids['quiz-form'].fire('submit');
  assert.deepEqual(JSON.parse(waiting.storage.get(draftKey(waiting))).answers, JSON.parse(waitingDraft).answers);
  assert(waiting.ids['quiz-form'].querySelectorAll('input, button').every(node => node.disabled));
  assert(waiting.ids['retry-quiz'].disabled && waiting.ids['review-attempt'].disabled);
  await reviewButton(waiting, 'GA-1').click(); assertFlags(waiting, ['GA-1']);
  await waiting.ids['quiz-form'].fire('submit'); await waiting.ids['review-attempt'].click();
  assert.equal(postRequests(waiting).length, 1, 'Busy controls cannot start a second Submit');
  assert.equal(getRequests(waiting).length, 1, 'Busy Review cannot start another read');
  finishSubmit(); await pendingSubmit;
  assertFlags(waiting, []);
  assert.equal(waiting.storage.has(draftKey(waiting)), false); assertEditable(waiting);
  assert.equal(waiting.ids['retry-quiz'].disabled, false); assert.equal(waiting.ids['review-attempt'].disabled, false);
  let finishReview, reviewReads = 0;
  const pendingReview = await load('gate-cse-2021-set-1', {
    server: refreshed.server, fetch: (_request, perform) => ++reviewReads === 1 ? perform() : new Promise(resolve => { finishReview = () => resolve(perform()); })
  });
  await editResponse(pendingReview, 'GA-1', 'A'); await reviewButton(pendingReview, 'GA-1').click();
  const pendingReviewDraft = pendingReview.storage.get(draftKey(pendingReview));
  const reviewingPromise = pendingReview.ids['review-attempt'].click();
  assert(pendingReview.ids['review-attempt'].disabled);
  assert(pendingReview.ids['quiz-form'].querySelectorAll('input, button').every(node => node.disabled));
  assert.equal(pendingReview.storage.get(draftKey(pendingReview)), pendingReviewDraft);
  finishReview(); await reviewingPromise;
  assertFlags(pendingReview, ['GA-1', 'CS-16']);
  assert.equal(pendingReview.ids['review-attempt'].disabled, false); assert.equal(pendingReview.ids['retry-quiz'].disabled, false);
  assert.equal(pendingReview.storage.get(draftKey(pendingReview)), pendingReviewDraft);
  const filePage = await load('gate-cse-2021-set-1', { url: 'file:///test/gate-cse-2021-set-1/index.html' });
  await editResponse(filePage, 'GA-1', 'C'); await filePage.ids['review-attempt'].click(); await filePage.ids['quiz-form'].fire('submit');
  assert.equal(filePage.requests.length, 0, 'file:// pages never make attempt-file requests');
  assert(filePage.storage.has(draftKey(filePage)), 'A file:// submission without disk saving retains the browser draft');

  // Per-question clear and whole-test clear are reflected on the next refresh.
  await editResponse(refreshed, 'CS-11', ['D']);
  await refreshed.document.getElementById('question-card-20').querySelector('button').click();
  const clearedQuestion = await load('gate-cse-2021-set-1', { storage: h.storage });
  assert.equal(clearedQuestion.t.answers['GA-1'], 'A'); assert(!Object.hasOwn(clearedQuestion.t.answers, 'CS-11'));
  await refreshed.ids['clear-answers'].click();
  const clearedAll = await load('gate-cse-2021-set-1', { storage: h.storage });
  assert.equal(Object.keys(clearedAll.t.answers).length, 0); assertEditable(clearedAll);

  // Cache keys isolate papers. Submitting one paper leaves another draft intact.
  const shared = new Map(), paper2021 = await load('gate-cse-2021-set-1', { storage: shared });
  await editResponse(paper2021, 'GA-1', 'C'); await reviewButton(paper2021, 'GA-1').click();
  const paper2020 = await load('gate-cse-2020', { storage: shared }); assert.equal(Object.keys(paper2020.t.answers).length, 0);
  assertFlags(paper2020, []);
  await editResponse(paper2020, 'GA-1', 'A'); await reviewButton(paper2020, 'GA-2').click();
  const otherDraft = shared.get(draftKey(paper2020));
  await paper2021.ids['quiz-form'].fire('submit');
  assert.equal(shared.has(draftKey(paper2021)), false); assert.equal(shared.get(draftKey(paper2020)), otherDraft);
  const oldReload = await load('gate-cse-2020', { storage: shared });
  assert.equal(oldReload.t.answers['GA-1'], 'A'); assert.equal(oldReload.ids.report.hidden, true);
  assertFlags(oldReload, ['GA-2']);

  // Malformed, obsolete and completed legacy caches are ignored and cleared.
  const seed = await load(); await editResponse(seed, 'GA-1', 'C');
  const validDraft = JSON.parse(seed.storage.get(draftKey(seed)));
  const damaged = ['{bad', JSON.stringify({ ...validDraft, signature: 'wrong' }),
    JSON.stringify({ ...validDraft, answers: { 'unknown-question': 'A' } }),
    JSON.stringify({ ...validDraft, answers: { 'CS-11': ['Z'] } }),
    JSON.stringify({ ...validDraft, answers: { 'CS-11': ['A', 'A'] } }),
    JSON.stringify({ ...validDraft, answers: { 'CS-11': 'A' } }),
    ...[null, 'GA-1', {}, [null], [1], ['unknown-question'], ['GA-1', 'GA-1']].map(reviewFlags => JSON.stringify({ ...validDraft, reviewFlags })),
    JSON.stringify({ ...validDraft, updatedAt: 'bad' }),
    JSON.stringify({ ...validDraft, submittedAt: '2026-01-01T00:00:00.000Z' })];
  for (const text of damaged) {
    const invalid = await load('gate-cse-2021-set-1', { storage: [[draftKey(seed), text]] });
    assert.equal(Object.keys(invalid.t.answers).length, 0); assert.equal(invalid.ids.report.hidden, true);
    assertFlags(invalid, []);
    assert.equal(invalid.storage.has(draftKey(invalid)), false); assertEditable(invalid);
  }
  const { reviewFlags: _legacyFlags, ...oldDraft } = validDraft;
  const legacy = await load('gate-cse-2021-set-1', {
    storage: [[draftKey(seed), JSON.stringify({ ...oldDraft, protectSavedAttempt: true, submittedAt: '' })]]
  });
  assert.equal(legacy.t.answers['GA-1'], 'C'); assert.equal(legacy.ids.report.hidden, true); assertEditable(legacy);
  assertFlags(legacy, []);

  // Storage read/quota/clear failures keep practice and reports usable and state
  // the failure instead of opening a file picker or silently downloading data.
  let failWrites = false;
  const writeFailure = await load('gate-cse-2021-set-1', {
    storageError: (operation, key) => failWrites && operation === 'set' && key === draftKey(seed)
  });
  const failureDialogs = rejectFileDialogs(writeFailure);
  await editResponse(writeFailure, 'GA-1', 'A');
  const priorDraft = writeFailure.storage.get(draftKey(writeFailure)); failWrites = true;
  await editResponse(writeFailure, 'GA-1', 'C');
  await reviewButton(writeFailure, 'GA-1').click(); assertFlags(writeFailure, ['GA-1']);
  assert.equal(writeFailure.t.answers['GA-1'], 'C'); assert.equal(writeFailure.storage.get(draftKey(writeFailure)), priorDraft);
  assert(/unavailable|could not|cannot|failed/i.test(writeFailure.ids['status-message'].textContent));
  assertEditable(writeFailure); await writeFailure.ids['quiz-form'].fire('submit');
  assert.equal(writeFailure.ids.report.hidden, false); assert.equal(writeFailure.ids['retry-quiz'].disabled, false);
  assert.equal(writeFailure.storage.has(draftKey(writeFailure)), false);
  await writeFailure.ids['retry-quiz'].click(); assertEditable(writeFailure); failureDialogs();
  assert.equal(writeFailure.ids['status-message'].textContent, 'Could not cache your progress. Keep this tab open to retain your answers.');
  assert(!writeFailure.ids['status-message'].hidden && writeFailure.ids['status-message'].className.split(' ').includes('error'), 'Retry must preserve the cache-write failure warning');
  const readFailure = await load('gate-cse-2021-set-1', {
    storage: seed.storage, storageError: operation => operation === 'get'
  });
  assert.equal(Object.keys(readFailure.t.answers).length, 0); assertEditable(readFailure);
  assert(/unavailable|could not|cannot|failed/i.test(readFailure.ids['status-message'].textContent));
  let failClear = false;
  const clearFailure = await load('gate-cse-2021-set-1', {
    storageError: (operation, key) => failClear && operation === 'remove' && key === draftKey(seed)
  });
  await editResponse(clearFailure, 'GA-1', 'C'); const retained = clearFailure.storage.get(draftKey(clearFailure));
  await reviewButton(clearFailure, 'GA-1').click();
  failClear = true; await clearFailure.ids['quiz-form'].fire('submit');
  assert.equal(clearFailure.ids.report.hidden, false); assert.equal(clearFailure.ids['retry-quiz'].disabled, false);
  assert.equal(clearFailure.t.answers['GA-1'], 'C');
  assertFlags(clearFailure, [], false);
  assert.deepEqual(JSON.parse(clearFailure.storage.get(draftKey(clearFailure))).answers, JSON.parse(retained).answers);
  assert(/clear|remove|failed|unavailable/i.test(clearFailure.ids['status-message'].textContent));
  const unavailable = await load('gate-cse-2021-set-1', { storageUnavailable: true });
  const unavailableDialogs = rejectFileDialogs(unavailable);
  await editResponse(unavailable, 'GA-1', 'C');
  await reviewButton(unavailable, 'GA-1').click(); assertFlags(unavailable, ['GA-1']);
  assert.equal(unavailable.t.answers['GA-1'], 'C'); assertEditable(unavailable);
  await unavailable.ids['quiz-form'].fire('submit'); assert.equal(unavailable.ids.report.hidden, false);
  assert.equal(unavailable.ids['retry-quiz'].disabled, false); unavailableDialogs();
  await unavailable.ids['retry-quiz'].click(); assertEditable(unavailable);
  assertFlags(unavailable, []);
  assert.equal(Object.keys(unavailable.t.answers).length, 0);
  assert.equal(unavailable.ids['status-message'].textContent, 'Could not cache your progress. Keep this tab open to retain your answers.');
  assert(!unavailable.ids['status-message'].hidden && unavailable.ids['status-message'].className.split(' ').includes('error'), 'Retry must not claim progress was cached when storage is unavailable');

  // Theme leaves the draft/key/data intact. Both papers retain scoring/images.
  const theme = await load(); await editResponse(theme, 'GA-1', 'C'); await reviewButton(theme, 'GA-1').click();
  vm.runInContext(fs.readFileSync('gate-cse-2021-set-1/theme.js', 'utf8'), theme.ctx);
  theme.document.DOMContentLoaded();
  const beforeTheme = theme.storage.get(draftKey(theme)), beforeAnswers = JSON.stringify(theme.t.answers);
  await theme.ids['theme-toggle'].click();
  assert.equal(theme.document.documentElement.dataset.theme, 'dark');
  assert.equal(theme.storage.get(draftKey(theme)), beforeTheme); assert.equal(JSON.stringify(theme.t.answers), beforeAnswers);
  assertFlags(theme, ['GA-1']);
  assert.equal(theme.storage.get('practice-quiz:theme'), 'dark');
  const old = await load('gate-cse-2020'); assert.equal(old.t.summarize(old.t.grade()).score, 1);
  for (const q of old.data.questions) old.t.answers[q.id] = q.type === 'nat' ? String(q.correctRanges[0].min) : q.marksToAll ? 'A' : q.correctAnswer;
  assert.equal(old.t.summarize(old.t.grade()).score, 100); assert.equal(old.t.summarize(old.t.grade()).counts.correct, 64);
  old.t.save(); const oldDialogs = rejectFileDialogs(old);
  await old.ids['quiz-form'].fire('submit'); assert.equal(old.storage.has(draftKey(old)), false);
  assert.equal(old.ids['report-list'].querySelectorAll('img').length, 67);
  assert.equal(old.ids['retry-quiz'].disabled, false); await old.ids['retry-quiz'].click(); assertEditable(old); oldDialogs();
  const template = await load('_template'); assert.equal(template.ids['empty-state'].hidden, false);
  console.log('PASS: grading/assets, MSQ/NAT/MCQ/MTA, maps/reports/theme, browser draft reopen/clear/isolation/failures, review flags with toggle/cache/restore/validation/clear and submitted report snapshots, Submit-only server write and success-only cache clearing, saved-answer Review gating/tooltips/blank saves/failures/stale opening reads, read-only last-attempt review/resume/validation/recomputed scores, server failure recovery/busy controls, no file dialogs, blank template.');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
