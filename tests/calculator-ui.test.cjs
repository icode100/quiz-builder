const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Local DOM simulation only. No server, browser profile, quiz data, saved
// submission, or unfinished draft is read or written by these tests.
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, '_calculator', 'index.html'), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.events = {}; this.dataset = {}; this.attributes = {};
    this.textContent = ''; this.value = ''; this.title = '';
    this.selectionStart = 0; this.selectionEnd = 0; this.maxLength = 1024;
    this.classes = new Set();
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
  }
  get value() { return this._value || ''; }
  set value(value) {
    this._value = value;
    this.selectionStart = Math.min(this.selectionStart || 0, value.length);
    this.selectionEnd = Math.min(this.selectionEnd || 0, value.length);
  }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  fire(name, options = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    for (const callback of this.events[name] || []) callback(event);
    return event;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  closest(selector) { return selector === 'button' && this.tag === 'button' ? this : null; }
  focus() { this.document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  setRangeText(text, start, end) {
    assert.ok(start >= 0 && end >= start && end <= this.value.length, 'valid text selection');
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + text.length;
  }
}

function harness(embedded = true) {
  const ids = Object.fromEntries(['expression', 'result', 'calculation-status', 'memory-indicator', 'more-functions'].map(id => [id, new Element()]));
  ids.expression.tag = 'input'; ids.result.textContent = '0';
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes, text]) => {
    const button = new Element('button');
    button.textContent = text.replace(/<[^>]+>/g, '');
    for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
      button.setAttribute(name, value);
      if (name.startsWith('data-')) button.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      if (name === 'id') ids[value] = button;
      if (name === 'title') button.title = value;
    }
    return button;
  });
  const documentEvents = {}, windowEvents = {}, messages = [];
  const document = {
    documentElement: new Element('html'), activeElement: null,
    getElementById: id => ids[id] || null,
    querySelectorAll(selector) {
      if (selector === '[data-more-label]') return buttons.filter(button => button.dataset.moreLabel);
      if (selector === '[data-angle]') return buttons.filter(button => button.dataset.angle);
      return [];
    },
    addEventListener(name, callback) { (documentEvents[name] ||= []).push(callback); }
  };
  for (const element of [...Object.values(ids), ...buttons]) element.document = document;
  const parent = { postMessage: (data, origin) => messages.push({ data: JSON.parse(JSON.stringify(data)), origin }) };
  const window = {
    location: { origin: 'http://127.0.0.1:8765' },
    parent,
    addEventListener(name, callback) { (windowEvents[name] ||= []).push(callback); }
  };
  if (!embedded) window.parent = window;
  const context = { document, window };
  for (const object of [context, window]) {
    for (const name of ['localStorage', 'sessionStorage', 'fetch']) Object.defineProperty(object, name, { get() { throw new Error(`Calculator UI must not access ${name}.`); } });
  }
  const vmContext = vm.createContext(context);
  for (const filename of ['engine.js', 'calculator.js']) vm.runInContext(fs.readFileSync(path.join(root, '_calculator', filename), 'utf8'), vmContext, { filename });
  const dispatch = (registry, name, options = {}) => {
    const event = { target: document, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    for (const callback of registry[name] || []) callback(event);
    return event;
  };
  return {
    ids, buttons, document, window, parent, messages,
    button: (key, value) => buttons.find(button => button.dataset[key] === value),
    click(key, value) {
      const button = this.button(key, value);
      assert.ok(button, `button ${key}=${value} exists`);
      dispatch(documentEvents, 'pointerdown', { target: button });
      if (document.activeElement === ids.expression) ids.expression.fire('blur');
      button.focus();
      dispatch(documentEvents, 'click', { target: button });
    },
    type(value) {
      ids.expression.value = value;
      ids.expression.focus();
      ids.expression.setSelectionRange(value.length, value.length);
      ids.expression.fire('input');
    },
    select(start, end = start) { ids.expression.setSelectionRange(start, end); ids.expression.fire('select'); },
    message(options) { return dispatch(windowEvents, 'message', options); },
    key(key, options) { return ids.expression.fire('keydown', { key, ...options }); },
    documentKey(key) { return dispatch(documentEvents, 'keydown', { key }); }
  };
}

function numeric(h, expected, tolerance = 0) {
  assert.ok(Math.abs(Number(h.ids.result.textContent) - expected) <= tolerance, `${h.ids.result.textContent} equals ${expected}`);
}

// Repeated = and memory operations use the displayed result rather than
// reevaluating an expression whose Ans or memory constant has since changed.
{
  const h = harness();
  h.type('2'); h.click('action', 'evaluate'); numeric(h, 2);
  h.type('ans+3'); h.click('action', 'evaluate'); numeric(h, 5);
  h.click('action', 'memory-add'); assert.equal(h.ids['memory-indicator'].textContent, 'M: 5');
  h.click('action', 'sign'); assert.equal(h.ids.expression.value, '-(ans)');
  h.click('action', 'evaluate'); numeric(h, -5);
  h.click('action', 'sign'); h.click('action', 'evaluate'); numeric(h, 5);
  h.click('action', 'evaluate'); numeric(h, 5);
  h.click('action', 'memory-subtract'); assert.equal(h.ids['memory-indicator'].textContent, 'M: 0');
  h.click('action', 'memory-add'); assert.equal(h.ids['memory-indicator'].textContent, 'M: 5');
  h.click('action', 'clear'); assert.equal(h.ids.expression.value, ''); numeric(h, 0);
  h.click('insert', 'ans'); assert.equal(h.ids.expression.value, 'ans');
  h.click('action', 'evaluate'); numeric(h, 5);
  h.click('action', 'clear'); h.click('action', 'memory-recall');
  assert.equal(h.ids.expression.value, '5');
  h.click('action', 'memory-clear'); assert.equal(h.ids['memory-indicator'].textContent, 'M: 0');
  h.type('2'); h.click('action', 'memory-add');
  h.type('mem+1'); h.click('action', 'evaluate'); numeric(h, 3);
  h.click('action', 'memory-add'); h.click('action', 'memory-add');
  assert.equal(h.ids['memory-indicator'].textContent, 'M: 8');
}

// Cursor editing and selected function wrapping remain predictable after focus
// moves from the input to an on-screen key.
{
  const h = harness();
  h.click('function', 'sin'); assert.equal(h.ids.expression.value, 'sin()');
  assert.equal(h.ids.expression.selectionStart, 4);
  h.click('insert', '3'); h.click('insert', '0');
  assert.equal(h.ids.expression.value, 'sin(30)');
  h.click('insert', ')'); assert.equal(h.ids.expression.value, 'sin(30)');
  assert.equal(h.ids.expression.selectionStart, 7);
  h.click('action', 'evaluate'); numeric(h, 0.5, 1e-15);
  h.type('2+30'); h.select(2, 4); h.click('function', 'sin');
  assert.equal(h.ids.expression.value, '2+sin(30)');
  h.type('1234'); h.select(2); h.click('insert', '9');
  assert.equal(h.ids.expression.value, '12934');
  h.select(1, 3); h.click('action', 'delete'); assert.equal(h.ids.expression.value, '134');
  h.click('action', 'delete'); assert.equal(h.ids.expression.value, '34');
  h.type('8'); h.click('action', 'evaluate'); h.click('insert', '+');
  assert.equal(h.ids.expression.value, 'ans+');
  h.click('insert', '2'); h.click('action', 'evaluate'); numeric(h, 10);
  h.click('insert', '7'); assert.equal(h.ids.expression.value, '7');
}

// Alternate keys invoke their actual function or unary action. Reciprocals
// wrap the selected text, the full pending expression, or the shown answer.
{
  const h = harness();
  h.click('action', 'more');
  assert.equal(h.ids['more-functions'].getAttribute('aria-pressed'), 'true');
  assert.equal(h.button('function', 'sin').textContent, 'sinh');
  h.click('function', 'sin'); assert.equal(h.ids.expression.value, 'sinh()');
  h.type('5'); h.click('moreAction', 'reciprocal');
  assert.equal(h.ids.expression.value, '1/(5)');
  h.click('action', 'evaluate'); numeric(h, 0.2);
  h.click('moreAction', 'reciprocal'); assert.equal(h.ids.expression.value, '1/(ans)');
  h.click('action', 'evaluate'); numeric(h, 5);
  h.type('2+5'); h.select(2, 3); h.click('moreAction', 'reciprocal');
  assert.equal(h.ids.expression.value, '2+1/(5)');
  h.click('action', 'more');
  assert.equal(h.button('function', 'sin').textContent, 'sin');
  assert.equal(h.ids['more-functions'].getAttribute('aria-pressed'), 'false');
  h.type('2+3'); h.click('action', 'sign'); assert.equal(h.ids.expression.value, '-(2+3)');
  h.click('action', 'evaluate'); numeric(h, -5);
}

// Changing angle units and editing invalidates the previous result. Errors
// preserve Ans and memory, and input remains available for correction.
{
  const h = harness();
  h.type('sin(30)'); h.click('action', 'evaluate'); numeric(h, 0.5, 1e-15);
  h.click('angle', 'RAD');
  assert.equal(h.button('angle', 'RAD').getAttribute('aria-pressed'), 'true');
  assert.equal(h.button('angle', 'DEG').getAttribute('aria-pressed'), 'false');
  h.click('action', 'evaluate'); numeric(h, Math.sin(30));
  h.type('4'); h.click('action', 'evaluate'); h.click('action', 'memory-add');
  h.type('1/0'); h.click('action', 'evaluate');
  assert.equal(h.ids.expression.getAttribute('aria-invalid'), 'true');
  assert.ok(h.ids['calculation-status'].classes.has('error'));
  assert.equal(h.ids.expression.value, '1/0'); numeric(h, 4);
  h.click('action', 'memory-add'); assert.equal(h.ids['memory-indicator'].textContent, 'M: 4');
  h.type('ans+1'); h.click('action', 'evaluate'); numeric(h, 5);
  assert.equal(h.ids.expression.getAttribute('aria-invalid'), 'false');
  h.type(''); h.click('action', 'evaluate');
  assert.match(h.ids['calculation-status'].textContent, /Enter an expression/);
  h.type('3*7'); assert.equal(h.key('Enter').defaultPrevented, true); numeric(h, 21);
  h.type('2^8'); assert.equal(h.key('=').defaultPrevented, true); numeric(h, 256);
  h.type('3'); assert.equal(h.key('Enter', { isComposing: true }).defaultPrevented, false); numeric(h, 256);
}

// Frame controls accept only the actual same-origin parent. Esc can only ask
// that parent to close; standalone use remains available without parent access.
{
  const h = harness();
  h.type('3+4');
  h.document.activeElement = null;
  const theme = { type: 'quiz-calculator-theme', theme: 'dark' };
  h.message({ source: {}, origin: h.window.location.origin, data: theme });
  h.message({ source: h.parent, origin: 'https://example.invalid', data: theme });
  assert.equal(h.document.documentElement.dataset.theme, undefined);
  h.message({ source: h.parent, origin: h.window.location.origin, data: theme });
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  h.message({ source: h.parent, origin: h.window.location.origin, data: { type: theme.type, theme: 'invalid' } });
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  h.message({ source: {}, origin: h.window.location.origin, data: { type: 'quiz-calculator-focus' } });
  assert.equal(h.document.activeElement, null);
  h.message({ source: h.parent, origin: h.window.location.origin, data: { type: 'quiz-calculator-focus' } });
  assert.equal(h.document.activeElement, h.ids.expression);
  assert.equal(h.ids.expression.value, '3+4');
  assert.equal(h.documentKey('Escape').defaultPrevented, true);
  assert.deepEqual(h.messages, [{ data: { type: 'quiz-calculator-close' }, origin: h.window.location.origin }]);
  const standalone = harness(false);
  assert.equal(standalone.documentKey('Escape').defaultPrevented, false);
  assert.deepEqual(standalone.messages, []);
}

assert.match(html, /src="\/_calculator\/engine\.js"/);
assert.match(html, /src="\/_calculator\/calculator\.js"/);
assert.match(html, /href="\/_calculator\/calculator\.css"/);
console.log('Calculator UI tests passed: displayed-result/Ans/memory consistency, expression and cursor editing, functions/reciprocals, angle units, errors, keyboard controls, frame message validation, and no draft/submission storage access.');
