const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small simulated DOM only. No real browser storage, quiz data or server writes.
const source = fs.readFileSync(path.join(__dirname, '..', '_calculator', 'launcher.js'), 'utf8');

function harness() {
  const posts = [], observers = [], windowEvents = {}, capturedPointers = [];
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('The launcher must not access quiz data, browser drafts, network requests or timers.'); };
  const document = { activeElement: null };
  class Element {
    constructor(tagName) {
      this.tagName = tagName.toLowerCase(); this.children = []; this.parentElement = null;
      this.attributes = {}; this.events = {}; this.style = {}; this.dataset = {};
      this.hidden = false; this.className = ''; this.textContent = '';
      if (this.tagName === 'iframe') this.contentWindow = { postMessage: (message, origin) => posts.push({ message: JSON.parse(JSON.stringify(message)), origin }) };
    }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); if (name === 'id') this.id = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    fire(name, values = {}) {
      const event = { target: this, prevented: false, preventDefault() { this.prevented = true; }, ...values };
      for (const callback of this.events[name] || []) callback(event);
      return event;
    }
    matches(selector) { return selector.split(',').some(part => { const item = part.trim(); return item.startsWith('.') ? this.className.split(/\s+/).includes(item.slice(1)) : item.startsWith('#') ? this.id === item.slice(1) : this.tagName === item; }); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    focus() { document.activeElement = this; }
    setPointerCapture(id) { capturedPointers.push(id); }
    getBoundingClientRect() { return { left: this.style.left ? parseFloat(this.style.left) : 400, top: this.style.top ? parseFloat(this.style.top) : 100, width: 460, height: 650 }; }
    set innerHTML(html) {
      this.children = [];
      const stack = [this];
      for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
        if (token.startsWith('</')) { stack.pop(); continue; }
        if (token.startsWith('<')) {
          const tag = token.match(/^<([a-z][\w-]*)/i)?.[1];
          if (!tag) continue;
          const child = new Element(tag);
          for (const attribute of token.matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(attribute[1], attribute[2]);
          stack.at(-1).append(child);
          if (!token.endsWith('/>') && !['input', 'br', 'img', 'link', 'meta'].includes(tag)) stack.push(child);
        } else stack.at(-1).textContent += token;
      }
    }
  }
  document.body = new Element('body');
  document.documentElement = new Element('html');
  document.createElement = tag => new Element(tag);
  document.getElementById = id => document.body.querySelector(`#${id}`);
  const window = {
    location: { origin: 'http://127.0.0.1:8765' }, innerWidth: 1200, innerHeight: 1000,
    addEventListener(name, callback) { (windowEvents[name] ||= []).push(callback); }
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, settings) { this.target = target; this.settings = settings; }
  }
  const context = { document, window, MutationObserver, console, fetch: forbidden, setInterval: forbidden, setTimeout: forbidden };
  for (const object of [context, window]) {
    Object.defineProperty(object, 'localStorage', { get: forbidden });
    Object.defineProperty(object, 'QUIZ_DATA', { get: forbidden });
  }
  const run = () => vm.runInNewContext(source, context, { filename: 'launcher.js' });
  run();
  return {
    document, window, posts, observers, capturedPointers, run,
    forbiddenCalls: () => forbiddenCalls,
    fireWindow(name, event) { for (const callback of windowEvents[name] || []) callback(event); },
    theme(value) { document.documentElement.dataset.theme = value; for (const observer of observers) observer.callback([]); }
  };
}

function run() {
  const h = harness();
  const toggle = h.document.getElementById('shared-calculator-toggle');
  const panel = h.document.getElementById('shared-calculator-panel');
  const heading = panel.querySelector('.shared-calculator-heading');
  const close = panel.querySelector('.shared-calculator-close');
  const header = panel.querySelector('.shared-calculator-header');
  const newTab = panel.querySelector('.shared-calculator-new-tab');
  assert.equal(toggle.type, 'button', 'Launcher never submits the quiz form');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), panel.id);
  assert.equal(panel.getAttribute('aria-labelledby'), heading.id);
  assert.equal(panel.hidden, true);
  assert.equal(h.document.body.querySelectorAll('iframe').length, 0, 'Calculator frame is absent until the first open');
  assert.equal(h.posts.length, 0);
  assert.equal(newTab.getAttribute('href'), '/_calculator/');
  assert.equal(newTab.getAttribute('target'), '_blank');
  assert.equal(newTab.getAttribute('rel'), 'noopener');
  h.run();
  assert.equal(h.document.body.children.length, 2, 'Repeated launcher loading does not duplicate controls');
  assert.equal(h.observers.length, 1);
  assert.equal(h.observers[0].target, h.document.documentElement);
  assert.equal(JSON.stringify(h.observers[0].settings.attributeFilter), '["data-theme"]');

  toggle.fire('click');
  assert.equal(panel.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.activeElement, heading, 'Keyboard focus reaches the calculator while the frame loads');
  const frame = panel.querySelector('iframe');
  assert.ok(frame);
  assert.equal(frame.src, '/_calculator/');
  assert.equal(frame.title, 'Scientific calculator');
  assert.equal(h.posts.length, 0, 'Messages wait until the local calculator is loaded');
  frame.fire('load');
  assert.deepEqual(h.posts, [
    { message: { type: 'quiz-calculator-theme', theme: 'light' }, origin: h.window.location.origin },
    { message: { type: 'quiz-calculator-focus' }, origin: h.window.location.origin }
  ]);
  h.theme('dark');
  assert.deepEqual(h.posts.at(-1), { message: { type: 'quiz-calculator-theme', theme: 'dark' }, origin: h.window.location.origin });
  close.fire('click');
  assert.equal(panel.hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.document.activeElement, toggle);
  frame.contentWindow.fixtureMemory = 42;
  toggle.fire('click');
  assert.equal(panel.querySelector('iframe'), frame);
  assert.equal(h.document.body.querySelectorAll('iframe').length, 1, 'Close/reopen retains one calculator instance');
  assert.equal(frame.contentWindow.fixtureMemory, 42, 'Frame state survives close/reopen');
  assert.equal(h.posts.at(-1).message.type, 'quiz-calculator-focus');
  const escape = panel.fire('keydown', { key: 'Escape' });
  assert.equal(escape.prevented, true);
  assert.equal(panel.hidden, true);
  assert.equal(h.document.activeElement, toggle);
  toggle.fire('click');
  for (const event of [
    { origin: 'https://example.test', source: frame.contentWindow, data: { type: 'quiz-calculator-close' } },
    { origin: h.window.location.origin, source: {}, data: { type: 'quiz-calculator-close' } },
    { origin: h.window.location.origin, source: frame.contentWindow, data: { type: 'other' } },
    { origin: h.window.location.origin, source: frame.contentWindow, data: null }
  ]) {
    h.fireWindow('message', event);
    assert.equal(panel.hidden, false, 'Unrelated or untrusted window messages do not control the calculator');
  }
  h.fireWindow('message', { origin: h.window.location.origin, source: frame.contentWindow, data: { type: 'quiz-calculator-close' } });
  assert.equal(panel.hidden, true, 'Only the calculator frame at the same origin can request close');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.fire('click');

  const moveKey = heading.fire('keydown', { key: 'ArrowRight' });
  assert.equal(moveKey.prevented, true);
  assert.equal(panel.style.left, '410px');
  assert.equal(panel.style.top, '100px');
  heading.fire('keydown', { key: 'ArrowDown', shiftKey: true });
  assert.equal(panel.style.top, '140px', 'Shift plus arrow moves the panel farther');
  const ordinaryKey = heading.fire('keydown', { key: 'a' });
  assert.equal(ordinaryKey.prevented, false);
  const beforeIgnoredDrag = JSON.stringify(panel.style);
  header.fire('pointerdown', { button: 0, pointerId: 1, target: close, clientX: 420, clientY: 152 });
  header.fire('pointermove', { pointerId: 1, clientX: 210, clientY: 162 });
  assert.equal(JSON.stringify(panel.style), beforeIgnoredDrag, 'Header buttons do not initiate dragging');
  header.fire('pointerdown', { button: 2, pointerId: 1, target: heading, clientX: 420, clientY: 152 });
  assert.equal(h.capturedPointers.length, 0);
  const down = header.fire('pointerdown', { button: 0, pointerId: 2, target: heading, clientX: 420, clientY: 152 });
  assert.equal(down.prevented, true);
  assert.deepEqual(h.capturedPointers, [2]);
  header.fire('pointermove', { pointerId: 3, clientX: 10, clientY: 10 });
  assert.equal(JSON.stringify(panel.style), beforeIgnoredDrag, 'Only the captured pointer moves the panel');
  header.fire('pointermove', { pointerId: 2, clientX: 210, clientY: 162 });
  assert.equal(panel.style.left, '200px');
  assert.equal(panel.style.top, '150px');
  assert.equal(panel.style.right, 'auto');
  assert.equal(panel.style.bottom, 'auto');
  header.fire('pointerup', { pointerId: 2 });
  header.fire('pointermove', { pointerId: 2, clientX: 100, clientY: 100 });
  assert.equal(panel.style.left, '200px', 'Pointer release ends dragging');
  panel.style.left = '5000px'; panel.style.top = '-100px';
  h.window.innerWidth = 600; h.window.innerHeight = 800;
  h.fireWindow('resize', {});
  assert.equal(panel.style.left, '132px', 'Resize keeps a moved panel inside the right edge');
  assert.equal(panel.style.top, '8px', 'Resize keeps a moved panel below the top edge');
  assert.equal(h.forbiddenCalls(), 0, 'Launcher stays separate from quiz answers, drafts, network calls and timers');

  const css = fs.readFileSync(path.join(__dirname, '..', '_calculator', 'launcher.css'), 'utf8');
  assert.match(css, /@media\s+print\s*\{[\s\S]*?\.shared-calculator-toggle[\s\S]*?\.shared-calculator-panel\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.shared-calculator-panel\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /#4169e1/i);
  assert.match(css, /#3559c7/i);
  assert.match(css, /#5b7ded/i);
  console.log('Calculator launcher tests passed: lazy shared frame, retained state, keyboard/ARIA focus, trusted messaging, theme updates, dragging/resize bounds, print hiding, and quiz-state isolation.');
}

try { run(); } catch (error) { console.error(error); process.exitCode = 1; }
