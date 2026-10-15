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


module.exports = { createHarness, load, editResponse, draftKey, attemptUrl, rejectFileDialogs, assertEditable };
