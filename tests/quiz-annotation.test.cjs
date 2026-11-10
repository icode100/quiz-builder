const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The real annotation controller and ink engine run against a simulated DOM,
// canvas and localStorage. No personal draft, note or attempt is opened.
const root = path.resolve(__dirname, '..');
const quizId = 'annotation-fixture';
const questions = [
  { id: 'GA-1', text: 'A question', images: [{ src: 'first.png' }, { src: 'second.png' }] },
  { id: 'CS:2/special', text: '', images: [{ src: 'third.png' }] }
];
const key = id => `practice-quiz:${quizId}:annotation:${encodeURIComponent(id)}`;
const copy = value => JSON.parse(JSON.stringify(value));
const stroke = (tool = 'pen') => ({ tool, color: '#4169e1', width: 4, points: [[0.1, 0.2], [0.3, 0.4]] });
const record = (id, parts = { 'image-0': [stroke()] }) => ({ version: 1, quizId, questionId: id, updatedAt: '2026-11-09T00:00:00.000Z', parts });

function harness(options = {}) {
  const ids = {}, operations = [], drawing = [], allocations = [], frames = new Map(), windowEvents = {}, documentEvents = {};
  const resizeObservers = [], mutationObservers = [];
  const storage = options.storage instanceof Map ? options.storage : new Map(options.storage || []);
  const document = { activeElement: null, hidden: false, visibilityState: 'visible', fullscreenElement: null };
  let nextFrame = 1, canvasCount = 0;
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
      this.attrs = {}; this.events = {}; this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } }; this.dataset = {};
      this.hidden = false; this.disabled = false; this.className = ''; this.textContent = ''; this.value = ''; this.complete = true;
      this.pointers = new Set(); this._width = 300; this._height = 150;
      this.rect = { left: 20, top: 40, width: 800, height: 400 };
      if (this.tagName === 'CANVAS') this.canvasName = `canvas-${++canvasCount}`;
      this.classList = {
        toggle: (name, enabled) => { const parts = this.className.split(/\s+/).filter(Boolean); const has = parts.includes(name); if (enabled === undefined) enabled = !has; this.className = [...parts.filter(part => part !== name), ...(enabled ? [name] : [])].join(' '); return enabled; },
        add: (...names) => names.forEach(name => this.classList.toggle(name, true)),
        remove: (...names) => names.forEach(name => this.classList.toggle(name, false)),
        contains: name => this.className.split(/\s+/).includes(name)
      };
    }
    setAttribute(name, value) {
      const previous = this.attrs[name]; this.attrs[name] = String(value);
      if (name === 'id') { this.id = String(value); ids[this.id] = this; }
      if (name === 'class') this.className = String(value);
      if (name === 'hidden') this.hidden = true;
      if (name === 'disabled') this.disabled = true;
      if (name === 'value') this.value = String(value);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      if (previous !== String(value)) for (const observer of mutationObservers) {
        const settings = observer.targets.get(this);
        if (settings?.attributes && (!settings.attributeFilter || settings.attributeFilter.includes(name))) observer.records.push({ type: 'attributes', target: this, attributeName: name });
      }
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return name === 'hidden' ? this.hidden : Object.hasOwn(this.attrs, name); }
    removeAttribute(name) { delete this.attrs[name]; if (name === 'hidden') this.hidden = false; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    addEventListener(name, listener) { (this.events[name] ||= []).push(listener); }
    removeEventListener(name, listener) { this.events[name] = (this.events[name] || []).filter(item => item !== listener); }
    matches(selector) {
      return selector.split(',').some(value => {
        const part = value.trim();
        if (part === ':visible') return this.getClientRects().length > 0;
        const attrs = [...part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
        if (attrs.some(match => match[2] === undefined ? !this.hasAttribute(match[1]) : this.getAttribute(match[1]) !== match[2])) return false;
        const base = part.replace(/\[[^\]]+\]/g, '');
        if (!base || base === '*') return true;
        if (base.startsWith('#')) return this.id === base.slice(1);
        if (base.startsWith('.')) return this.className.split(/\s+/).includes(base.slice(1));
        return this.tagName.toLowerCase() === base.toLowerCase();
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    get isConnected() { return document.documentElement.contains(this); }
    get parentNode() { return this.parentElement; }
    get offsetParent() { return this.getClientRects().length ? this.parentElement : null; }
    get width() { return this._width; }
    set width(value) { this._width = Number(value); this.trackAllocation(); }
    get height() { return this._height; }
    set height(value) { this._height = Number(value); this.trackAllocation(); }
    trackAllocation() { if (this.canvasName) allocations.push(this.width * this.height); }
    get clientWidth() { return this.getBoundingClientRect().width; }
    get clientHeight() { return this.getBoundingClientRect().height; }
    getBoundingClientRect() {
      const rect = { ...(this.tagName === 'CANVAS' && this.parentElement ? this.parentElement.rect : this.rect) };
      if (this.id === 'screen-annotation-toolbar') {
        if (this.style.left !== undefined) rect.left = Number.parseFloat(this.style.left);
        if (this.style.top !== undefined) rect.top = Number.parseFloat(this.style.top);
      }
      return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height };
    }
    getClientRects() { if (this.hidden || this.parentElement?.getClientRects().length === 0) return []; return [this.getBoundingClientRect()]; }
    focus() { document.activeElement = this; }
    setPointerCapture(id) { this.pointers.add(id); }
    hasPointerCapture(id) { return this.pointers.has(id); }
    releasePointerCapture(id) { this.pointers.delete(id); }
    getContext() { return options.noCanvas ? null : this.context ||= canvasContext(this); }
    fire(name, values = {}) {
      const event = { target: this, currentTarget: this, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: 100, clientY: 120, prevented: false, defaultPrevented: false, preventDefault() { this.prevented = true; this.defaultPrevented = true; }, stopPropagation() {}, ...values };
      for (const listener of this.events[name] || []) listener(event);
      flush(); return event;
    }
    click() { return this.fire('click'); }
  }
  function canvasContext(canvas) {
    let points = [];
    return {
      save() {}, restore() {}, setTransform() {},
      clearRect() { drawing.push({ type: 'clear', target: canvas.canvasName }); },
      beginPath() { points = []; }, moveTo(x, y) { points.push([x, y]); }, lineTo(x, y) { points.push([x, y]); }, arc() {},
      stroke() { drawing.push({ type: 'stroke', target: canvas.canvasName, mode: this.globalCompositeOperation, alpha: this.globalAlpha, width: this.lineWidth, color: this.strokeStyle, points: copy(points) }); },
      fill() { drawing.push({ type: 'dot', target: canvas.canvasName, mode: this.globalCompositeOperation, color: this.fillStyle }); }
    };
  }
  document.body = new Element('body'); document.documentElement = new Element('html'); document.documentElement.append(document.body);
  document.documentElement.rect = { left: 0, top: 0, width: 1440, height: 900 };
  document.documentElement.setAttribute('data-theme', options.theme || 'light');
  document.createElement = tag => new Element(tag);
  document.getElementById = id => ids[id] || null;
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.addEventListener = (name, listener) => { (documentEvents[name] ||= []).push(listener); };
  const element = (tag, id, parent = document.body) => { const node = new Element(tag); if (id) node.setAttribute('id', id); parent.append(node); return node; };
  const toggle = element('button', 'screen-annotation-toggle'); toggle.hidden = true;
  const toolbar = element('section', 'screen-annotation-toolbar'); toolbar.hidden = true;
  const heading = element('h2', 'annotation-title', toolbar); heading.rect = { left: 20, top: 420, width: 260, height: 30 };
  toolbar.rect = { left: 16, top: 400, width: 720, height: 220 };
  for (const id of ['annotation-tool-pen', 'annotation-tool-highlighter', 'annotation-tool-eraser', 'annotation-undo', 'annotation-redo', 'annotation-clear', 'annotation-done']) element('button', id, toolbar);
  const color = element('select', 'annotation-color', toolbar); for (const value of ['#17233b', '#4169e1', '#dc2626', '#15803d', '#f59e0b']) { const option = element('option', null, color); option.setAttribute('value', value); }
  element('select', 'annotation-width', toolbar);
  element('p', 'annotation-status', toolbar); element('p', 'annotation-question-label', toolbar); element('button', 'theme-toggle');
  function mount(id, parts) {
    const region = element('div'); region.setAttribute('data-annotation-question', id);
    for (const name of parts) {
      const surface = element('div', null, region); surface.setAttribute('data-annotation-part', name);
      if (name.startsWith('image-')) { const image = element('img', null, surface); image.naturalWidth = 1600; image.naturalHeight = 800; }
      else element('p', null, surface).textContent = 'Question text';
    }
    return region;
  }
  const regions = [mount('GA-1', ['text', 'image-0', 'image-1']), mount('CS:2/special', ['image-0'])];
  regions[1].hidden = true;
  function flush() {
    for (const observer of mutationObservers) { const records = observer.takeRecords(); if (records.length) observer.callback(records, observer); }
    let rounds = 0;
    while (frames.size) { if (++rounds > 100) throw Error('Unbounded redraw loop'); const work = [...frames.values()]; frames.clear(); for (const callback of work) callback(); }
  }
  const context = {
    document, console, Date, Math, JSON, Map, Set, Object, Array,
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1, scrollX: 0, scrollY: 0,
    requestAnimationFrame: callback => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, listener) => { (windowEvents[name] ||= []).push(listener); },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: {
      getItem: storageKey => { operations.push(['get', storageKey]); if (options.fail?.('get', storageKey)) throw Error('Read blocked'); return storage.get(storageKey) ?? null; },
      setItem: (storageKey, value) => { operations.push(['set', storageKey]); if (options.fail?.('set', storageKey)) throw Error('Write blocked'); storage.set(storageKey, String(value)); },
      removeItem: storageKey => { operations.push(['remove', storageKey]); if (options.fail?.('remove', storageKey)) throw Error('Remove blocked'); storage.delete(storageKey); }
    },
    fetch() { throw Error('Annotations must never access the server'); }
  };
  context.ResizeObserver = class { constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); } observe(target) { this.targets.add(target); } unobserve(target) { this.targets.delete(target); } disconnect() { this.targets.clear(); } };
  context.MutationObserver = class { constructor(callback) { this.callback = callback; this.targets = new Map(); this.records = []; mutationObservers.push(this); } observe(target, settings) { this.targets.set(target, settings); } takeRecords() { return this.records.splice(0); } disconnect() { this.targets.clear(); this.records = []; } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, '_template/rough-work-engine.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, '_template/question-annotation.js'), 'utf8'), context);
  const controller = context.QuestionAnnotation.create({ quizId, questions: copy(questions) });
  controller.refresh(); controller.setCurrent('GA-1', 'GA 1'); flush();
  const surface = (region = regions[0], part = 'image-0') => region.querySelector(`[data-annotation-part="${part}"]`);
  const canvas = (region = regions[0], part = 'image-0') => surface(region, part).querySelector('canvas');
  const draw = (region = regions[0], part = 'image-0', values = {}) => { const target = canvas(region, part); target.fire('pointerdown', { clientX: 100, clientY: 120, ...values }); target.fire('pointermove', { clientX: 260, clientY: 200, ...values }); target.fire('pointerup', { clientX: 260, clientY: 200, ...values }); };
  const windowEvent = (name, event = {}) => { for (const listener of windowEvents[name] || []) listener(event); flush(); };
  const documentEvent = (name, values = {}) => { const event = { target: document.body, prevented: false, preventDefault() { this.prevented = true; }, ...values }; for (const listener of documentEvents[name] || []) listener(event); flush(); return event; };
  return { controller, ids, document, context, storage, operations, drawing, allocations, regions, mount, surface, canvas, draw, flush, windowEvent, documentEvent,
    saved: id => JSON.parse(storage.get(key(id))),
    resize(target) { for (const observer of resizeObservers) if (observer.targets.has(target)) observer.callback([{ target, contentRect: target.getBoundingClientRect() }], observer); flush(); },
    theme(theme) { document.documentElement.setAttribute('data-theme', theme); flush(); }
  };
}

// Test cases follow the controller's public lifecycle, independent of quiz state.
(() => {
  const protectedRecords = [
    [`practice-quiz:${quizId}`, '{"answers":{"GA-1":"A"},"currentQuestionId":"GA-1"}'],
    [`practice-quiz:${quizId}:rough:GA-1`, '{"strokes":[],"paperStyle":"dotted"}'],
    ['practice-quiz:theme', 'dark']
  ];
  const h = harness({ storage: protectedRecords });
  assert.equal(h.ids['screen-annotation-toggle'].hidden, false);
  assert.equal(h.ids['screen-annotation-toolbar'].hidden, true);
  assert.equal(h.ids['screen-annotation-toggle'].getAttribute('aria-pressed'), 'false');
  assert.ok(h.canvas(), 'Question source images receive independent transparent canvases');
  assert.equal(h.storage.has(key('GA-1')), false, 'Reading a question never creates annotation storage');
  const initialReads = h.operations.length;
  h.ids['screen-annotation-toggle'].click();
  assert.equal(h.ids['screen-annotation-toolbar'].hidden, false);
  assert.equal(h.ids['screen-annotation-toggle'].getAttribute('aria-pressed'), 'true');
  h.ids['annotation-done'].click();
  assert.equal(h.ids['screen-annotation-toolbar'].hidden, true);
  assert.equal(h.document.activeElement, h.ids['screen-annotation-toggle']);
  const passive = h.canvas().fire('pointerdown');
  assert.equal(passive.prevented, false, 'Inactive ink leaves normal image gestures available');
  assert.equal(h.controller.isDrawing(), false);
  assert.equal(h.operations.length, initialReads, 'Opening and closing annotation do not write or reread a loaded note');
  assert.equal(h.storage.has(key('GA-1')), false);

  h.ids['screen-annotation-toggle'].click();
  const canvas = h.canvas();
  assert.equal(canvas.fire('pointerdown').prevented, true, 'Drawing intercepts a question-image gesture');
  assert.equal(h.controller.isDrawing(), true);
  canvas.fire('pointermove', { clientX: 260, clientY: 200 });
  canvas.fire('pointerup', { clientX: 260, clientY: 200 });
  assert.equal(h.controller.isDrawing(), false);
  assert.equal(h.saved('GA-1').parts['image-0'].length, 1);
  const firstStroke = copy(h.saved('GA-1').parts['image-0'][0]);
  assert.equal(firstStroke.tool, 'pen');
  assert.equal(firstStroke.color, '#4169e1');
  assert.equal(firstStroke.width, 4);
  assert.equal(firstStroke.points.length, 2);
  assert.deepEqual(firstStroke.points[0], [0.1, 0.2], 'Coordinates are normalized to the image, not the screen');
  h.draw(h.regions[0], 'image-1');
  assert.equal(h.saved('GA-1').parts['image-1'].length, 1, 'Multipart source images have independent aligned ink');
  h.ids['annotation-tool-highlighter'].click();
  h.draw();
  assert.equal(h.saved('GA-1').parts['image-0'].at(-1).tool, 'highlighter');
  assert.ok(h.drawing.some(command => command.type === 'stroke' && command.alpha === 0.25));
  h.ids['annotation-tool-eraser'].click(); h.draw();
  assert.equal(h.saved('GA-1').parts['image-0'].at(-1).tool, 'eraser');
  assert.ok(h.drawing.some(command => command.type === 'stroke' && command.mode === 'destination-out'), 'Erasing removes only transparent annotation ink');
  h.ids['annotation-undo'].click();
  assert.equal(h.saved('GA-1').parts['image-0'].at(-1).tool, 'highlighter');
  h.ids['annotation-redo'].click();
  assert.equal(h.saved('GA-1').parts['image-0'].at(-1).tool, 'eraser');
  const beforeClear = copy(h.saved('GA-1').parts);
  h.ids['annotation-clear'].click();
  assert.ok(Object.values(h.saved('GA-1').parts).every(strokes => strokes.length === 0), 'Clear removes current question ink from every source part');
  h.ids['annotation-undo'].click();
  assert.deepEqual(h.saved('GA-1').parts, beforeClear, 'Clear is one undoable operation across all image parts');
  const beforeShortcut = h.saved('GA-1').parts['image-0'].length;
  const undoKey = h.documentEvent('keydown', { target: canvas, key: 'z', ctrlKey: true });
  assert.equal(undoKey.prevented, true);
  assert.equal(h.saved('GA-1').parts['image-0'].length, beforeShortcut - 1, 'Ctrl+Z undoes the previous ink operation');
  h.documentEvent('keydown', { target: canvas, key: 'Z', metaKey: true, shiftKey: true });
  assert.equal(h.saved('GA-1').parts['image-0'].length, beforeShortcut, 'Cmd+Shift+Z restores the question annotations');
  for (const [storageKey, bytes] of protectedRecords) assert.equal(h.storage.get(storageKey), bytes, 'Annotations leave draft, rough work and theme records untouched');
  assert.ok(h.operations.filter(([operation]) => operation !== 'get').every(([, storageKey]) => storageKey.startsWith(`practice-quiz:${quizId}:annotation:`)));

  // Saving at cancellation/navigation boundaries retains the visible stroke.
  h.ids['annotation-tool-pen'].click();
  canvas.fire('pointerdown', { pointerId: 10 });
  canvas.fire('pointermove', { pointerId: 11, clientX: 500, clientY: 300 });
  assert.equal(h.controller.isDrawing(), true, 'A second pointer cannot finish the first gesture');
  canvas.fire('pointercancel', { pointerId: 10 });
  assert.equal(h.controller.isDrawing(), false);
  assert.equal(h.saved('GA-1').parts['image-0'].at(-1).points.length, 1);
  canvas.fire('pointerdown', { pointerId: 12 });
  h.controller.flush();
  assert.equal(h.controller.isDrawing(), false);
  assert.equal(h.saved('GA-1').parts['image-0'].at(-1).points.length, 1);
  canvas.fire('pointerdown', { pointerId: 13 });
  canvas.fire('lostpointercapture', { pointerId: 13 });
  assert.equal(h.controller.isDrawing(), false);
  assert.equal(h.saved('GA-1').parts['image-0'].at(-1).points.length, 1);
  const firstSaved = h.storage.get(key('GA-1'));

  h.regions[0].hidden = true; h.regions[1].hidden = false;
  h.controller.setCurrent('CS:2/special', 'CS 2'); h.controller.refresh(); h.flush();
  assert.equal(h.storage.has(key('CS:2/special')), false, 'Navigation alone never creates a blank annotation');
  h.draw(h.regions[1]);
  assert.equal(h.saved('CS:2/special').parts['image-0'].length, 1);
  assert.equal(h.storage.get(key('GA-1')), firstSaved, 'Another question never rewrites the first question');
  h.ids['annotation-undo'].click();
  assert.equal(h.saved('CS:2/special').parts['image-0'].length, 0);
  assert.equal(h.storage.get(key('GA-1')), firstSaved, 'Undo history stays with its question');
  h.regions[1].hidden = true; h.regions[0].hidden = false;
  h.controller.setCurrent('GA-1', 'GA 1'); h.flush();
  assert.equal(h.ids['annotation-undo'].disabled, false, 'Returning to a question restores its in-memory undo history');

  // Rebuilt controls and report surfaces reconnect to the existing question.
  h.regions[0].remove();
  const replacement = h.mount('GA-1', ['text', 'image-0', 'image-1']);
  const beforeReconnect = h.storage.get(key('GA-1'));
  h.controller.refresh(); h.flush();
  assert.ok(h.canvas(replacement));
  assert.equal(h.storage.get(key('GA-1')), beforeReconnect);
  h.draw(replacement);
  assert.equal(h.saved('GA-1').parts['image-0'].length, JSON.parse(beforeReconnect).parts['image-0'].length + 1);

  // Responsive resizes and theme redraws change only presentation.
  const beforePresentation = [...h.storage];
  const beforePresentationWrites = h.operations.filter(([operation]) => operation !== 'get').length;
  const target = h.surface(replacement);
  for (const dimensions of [[360, 180], [1200, 600], [10000, 50000], [800, 400]]) {
    target.rect.width = dimensions[0]; target.rect.height = dimensions[1]; h.resize(target); h.windowEvent('resize');
  }
  h.theme('dark'); h.theme('light');
  assert.deepEqual([...h.storage], beforePresentation, 'Theme and responsive geometry do not rewrite saved normalized ink');
  assert.equal(h.operations.filter(([operation]) => operation !== 'get').length, beforePresentationWrites);
  assert.ok(h.allocations.every(pixels => pixels <= 4000000), 'Every intermediate canvas allocation remains bounded');
  const escape = h.documentEvent('keydown', { target: h.ids['screen-annotation-toolbar'], key: 'Escape' });
  assert.equal(escape.prevented, true);
  assert.equal(h.ids['screen-annotation-toolbar'].hidden, true);
  assert.equal(h.document.activeElement, h.ids['screen-annotation-toggle']);

  const reloaded = harness({ storage: h.storage });
  assert.equal(reloaded.ids['screen-annotation-toolbar'].hidden, true, 'Drawing mode ends at reload');
  assert.equal(reloaded.storage.get(key('GA-1')), h.storage.get(key('GA-1')));
  const beforeReopenedEdit = reloaded.saved('GA-1').parts['image-0'].length;
  reloaded.ids['screen-annotation-toggle'].click(); reloaded.draw();
  assert.equal(reloaded.saved('GA-1').parts['image-0'].length, beforeReopenedEdit + 1, 'Saved ink restores before the next edit');

  // Invalid records are retained byte-for-byte, with usable in-memory drawing.
  const invalidRecords = [
    'not json', JSON.stringify({ ...record('GA-1'), version: 2 }),
    JSON.stringify({ ...record('GA-1'), quizId: 'another-quiz' }),
    JSON.stringify({ ...record('GA-1'), questionId: 'CS:2/special' }),
    JSON.stringify({ ...record('GA-1'), updatedAt: 'not-a-time' }),
    JSON.stringify(record('GA-1', { 'image-999': [stroke()] })),
    JSON.stringify(record('GA-1', { 'image-0': [{ ...stroke(), points: [[Infinity, 0.1]] }] })),
    JSON.stringify(record('GA-1', { 'image-0': [{ ...stroke(), color: 'purple' }] })),
    JSON.stringify(record('GA-1', { 'image-0': [{ ...stroke(), width: 999 }] })),
    JSON.stringify(record('GA-1', { 'image-0': Array.from({ length: 501 }, () => stroke()), 'image-1': Array.from({ length: 500 }, () => stroke()) }))
  ];
  for (const bytes of invalidRecords) {
    const invalid = harness({ storage: [[key('GA-1'), bytes]] });
    invalid.ids['screen-annotation-toggle'].click(); invalid.draw();
    assert.equal(invalid.storage.get(key('GA-1')), bytes, 'Malformed records must not be overwritten');
    assert.match(invalid.ids['annotation-status'].textContent, /load|read|saved/i);
    assert.equal(invalid.ids['annotation-undo'].disabled, false, 'A load failure leaves drawing and undo usable in memory');
    invalid.ids['annotation-undo'].click();
    assert.equal(invalid.storage.get(key('GA-1')), bytes);
  }

  let failWrite = true;
  const failure = harness({ fail: operation => operation === 'set' && failWrite });
  failure.ids['screen-annotation-toggle'].click(); failure.draw();
  assert.equal(failure.storage.has(key('GA-1')), false);
  assert.match(failure.ids['annotation-status'].textContent, /save|storage/i);
  assert.equal(failure.ids['annotation-undo'].disabled, false);
  failWrite = false; failure.draw();
  assert.equal(failure.saved('GA-1').parts['image-0'].length, 2, 'A later successful edit saves ink retained after a write failure');

  const readFailure = harness({ storage: [[key('GA-1'), JSON.stringify(record('GA-1'))]], fail: operation => operation === 'get' });
  const beforeReadFailure = [...readFailure.storage];
  readFailure.ids['screen-annotation-toggle'].click(); readFailure.draw();
  assert.deepEqual([...readFailure.storage], beforeReadFailure, 'Unreadable storage cannot overwrite an existing saved annotation');
  assert.equal(readFailure.ids['annotation-undo'].disabled, false);
  assert.match(readFailure.ids['annotation-status'].textContent, /load|read/i);

  const noCanvas = harness({ noCanvas: true });
  assert.equal(noCanvas.ids['screen-annotation-toggle'].disabled, true);
  assert.equal(noCanvas.storage.size, 0, 'Unavailable canvas support never touches quiz or annotation data');

  const movable = harness();
  movable.ids['screen-annotation-toggle'].click();
  const heading = movable.ids['annotation-title'], toolbar = movable.ids['screen-annotation-toolbar'];
  const beforeMove = [...movable.storage], beforeMoveOperations = copy(movable.operations);
  heading.fire('pointerdown', { clientX: 100, clientY: 420, pointerId: 20 });
  heading.fire('pointermove', { clientX: 400, clientY: 220, pointerId: 21 });
  assert.equal(toolbar.style.top, undefined, 'A second pointer cannot move the annotation tools');
  heading.fire('pointermove', { clientX: 400, clientY: 220, pointerId: 20 });
  heading.fire('pointerup', { pointerId: 20 });
  assert.deepEqual([toolbar.style.left, toolbar.style.top, toolbar.style.bottom], ['316px', '200px', 'auto']);
  assert.equal(heading.fire('keydown', { key: 'ArrowRight' }).prevented, true);
  assert.equal(toolbar.style.left, '326px');
  heading.fire('keydown', { key: 'ArrowUp', shiftKey: true });
  assert.equal(toolbar.style.top, '170px');
  heading.fire('pointerdown', { clientX: 0, clientY: 0, pointerId: 22 });
  heading.fire('pointermove', { clientX: 10000, clientY: 10000, pointerId: 22 });
  heading.fire('pointercancel', { pointerId: 22 });
  assert.deepEqual([toolbar.style.left, toolbar.style.top], ['712px', '672px'], 'Toolbar dragging stays inside the viewport');
  movable.context.innerWidth = 800; movable.context.innerHeight = 500;
  movable.document.documentElement.rect.width = 800; movable.document.documentElement.rect.height = 500; movable.windowEvent('resize');
  assert.deepEqual([toolbar.style.left, toolbar.style.top], ['72px', '272px'], 'A smaller fullscreen/window viewport keeps the tools reachable');
  assert.deepEqual([...movable.storage], beforeMove);
  assert.deepEqual(movable.operations, beforeMoveOperations, 'Moving annotation tools is presentation-only');

  const scrollbar = harness();
  scrollbar.context.innerWidth = 390; scrollbar.context.innerHeight = 715;
  scrollbar.document.documentElement.rect.width = 375; scrollbar.document.documentElement.rect.height = 700;
  scrollbar.ids['screen-annotation-toolbar'].rect.width = 359;
  scrollbar.ids['screen-annotation-toolbar'].rect.height = 220;
  scrollbar.ids['screen-annotation-toggle'].click();
  const mobileHeading = scrollbar.ids['annotation-title'], mobileToolbar = scrollbar.ids['screen-annotation-toolbar'];
  mobileHeading.fire('pointerdown', { clientX: 100, clientY: 420, pointerId: 23 });
  mobileHeading.fire('pointermove', { clientX: 10000, clientY: 10000, pointerId: 23 });
  mobileHeading.fire('pointerup', { pointerId: 23 });
  assert.equal(mobileToolbar.style.left, '8px', 'Mobile toolbar clamps to the root layout viewport, excluding the scrollbar');
  assert.equal(Number.parseFloat(mobileToolbar.style.left) + mobileToolbar.rect.width, 367, 'The 359px toolbar remains inside the 375px usable viewport');
  assert.equal(mobileToolbar.style.right, 'auto', 'Dragging removes the previous right inset');
  assert.equal(Number.parseFloat(mobileToolbar.style.top) + mobileToolbar.rect.height, 692, 'Vertical clamping uses the root viewport height too');
  assert.equal(scrollbar.storage.size, 0);

  const folders = fs.readdirSync(root).filter(name => /^gate-cse-/.test(name) && fs.existsSync(path.join(root, name, 'quiz.js'))).sort();
  const templateModule = fs.readFileSync(path.join(root, '_template/question-annotation.js'), 'utf8');
  const templateStyle = fs.readFileSync(path.join(root, '_template/styles.css'), 'utf8');
  const requiredIds = ['screen-annotation-toggle', 'screen-annotation-toolbar', 'annotation-title', 'annotation-question-label', 'annotation-tool-pen', 'annotation-tool-highlighter', 'annotation-tool-eraser', 'annotation-color', 'annotation-width', 'annotation-undo', 'annotation-redo', 'annotation-clear', 'annotation-done', 'annotation-status'];
  for (const folder of ['_template', ...folders]) {
    assert.equal(fs.readFileSync(path.join(root, folder, 'question-annotation.js'), 'utf8'), templateModule, `${folder} uses the shared annotation controller`);
    assert.equal(fs.readFileSync(path.join(root, folder, 'styles.css'), 'utf8'), templateStyle, `${folder} uses the shared styles`);
    const html = fs.readFileSync(path.join(root, folder, 'index.html'), 'utf8');
    for (const id of requiredIds) assert.equal([...html.matchAll(new RegExp(`\\bid="${id}"`, 'g'))].length, 1, `${folder} has exactly one ${id}`);
    const launcher = html.match(/<button\b[^>]*id="screen-annotation-toggle"[^>]*>/)?.[0];
    assert.ok(launcher);
    assert.match(launcher, /\btype="button"/); assert.match(launcher, /\baria-label="Screen annotation"/);
    assert.match(launcher, /\baria-pressed="false"/); assert.match(launcher, /\baria-expanded="false"/);
    assert.match(launcher, /\baria-controls="screen-annotation-toolbar"/); assert.match(launcher, /\shidden(?:\s|>)/);
    assert.match(html, /<section\b[^>]*id="screen-annotation-toolbar"[^>]*\shidden(?:\s|>)/);
    const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/g)].map(match => match[1]);
    assert.ok(scripts.indexOf('rough-work-engine.js') < scripts.indexOf('question-annotation.js'));
    assert.ok(scripts.indexOf('question-annotation.js') < scripts.indexOf('quiz.js'));
    assert.match(html, /<script\b[^>]*src="question-annotation.js"[^>]*\bdefer\b/);
  }
  assert.match(templateStyle, /\.screen-annotation-toolbar\s*\{[^}]*width:\s*min\(22rem, calc\(100% - 2rem\)\)/);
  assert.match(templateStyle, /\.screen-annotation-toolbar\s*\{[^}]*width:\s*calc\(100% - 1rem\)/, 'Mobile width excludes scrollbar space');
  const print = templateStyle.slice(templateStyle.lastIndexOf('@media print'));
  assert.match(print, /\.screen-annotation-toggle[^}]*\.screen-annotation-toolbar[^}]*\.question-annotation-canvas[^}]*display:\s*none\s*!important/);

  console.log(`Question annotation checks passed: ${folders.length} synchronized quizzes plus template, transparent image layers, mode/focus, pen/highlighter/eraser, multipart undo/redo/clear, per-question persistence and histories, pointer cancellation, rerender/reopen, bounded resize, theme isolation, draggable tools and scrollbar viewport bounds, malformed storage preservation and write recovery.`);
})();

(async () => {
  const { load, editResponse, draftKey, attemptUrl } = require('./helpers/quiz-harness.cjs');
  const calls = [];
  let pointerDrawing = false;
  const api = {
    refresh() { calls.push(['refresh']); }, flush() { calls.push(['flush']); },
    setCurrent(id, label) { calls.push(['current', id, label]); }, isDrawing() { return pointerDrawing; }
  };
  const h = await load('gate-cse-2021-set-1', { window: { QuestionAnnotation: { create(options) { calls.push(['create', options.quizId, options.questions.length]); return api; } } } });
  assert.deepEqual(calls[0], ['create', h.data.id, h.data.questions.length]);
  assert.ok(calls.some(([name]) => name === 'refresh'));
  assert.equal(calls.filter(([name]) => name === 'current').at(-1)[1], h.data.questions[0].id);
  calls.length = 0;
  await h.ids['next-question'].click();
  assert.equal(calls.filter(([name]) => name === 'current').at(-1)[1], h.data.questions[1].id, 'Practice navigation selects the corresponding annotation question');
  calls.length = 0;
  pointerDrawing = true;
  const beforeDrawingShortcut = h.storage.get(draftKey(h));
  await h.document.keydown({ key: 'ArrowRight', target: h.document.body, preventDefault() { throw Error('Quiz shortcut must be ignored while drawing'); } });
  pointerDrawing = false;
  assert.equal(calls.length, 0);
  assert.equal(h.storage.get(draftKey(h)), beforeDrawingShortcut);
  const overlay = h.document.createElement('canvas'); overlay.className = 'question-annotation-canvas'; h.document.body.append(overlay);
  for (const target of [overlay, h.ids['screen-annotation-toolbar']]) for (const shortcut of ['ArrowRight', 'a', 'm', 'o']) {
    await h.document.keydown({ key: shortcut, target, preventDefault() { throw Error('Annotation focus must keep its own keys'); } });
  }
  assert.equal(calls.length, 0, 'Annotation toolbar and canvas focus do not trigger quiz navigation or flags');
  assert.equal(h.storage.get(draftKey(h)), beforeDrawingShortcut);
  const selectedQuestion = h.data.questions[1];
  await editResponse(h, selectedQuestion.id, selectedQuestion.correctAnswer);
  const answerCard = h.document.getElementById('question-card-1');
  calls.length = 0;
  await answerCard.querySelector('.clear-response').click();
  assert.ok(calls.findIndex(([name]) => name === 'flush') < calls.findIndex(([name]) => name === 'refresh'), 'Question rerenders flush visible ink before replacing its surfaces');
  assert.equal(calls.filter(([name]) => name === 'current').at(-1)[1], selectedQuestion.id);
  assert.ok(!/annotation/i.test(h.storage.get(draftKey(h))), 'Annotation lifecycle stays out of browser answer drafts');

  const first = h.data.questions[0];
  await editResponse(h, first.id, first.correctAnswer);
  calls.length = 0;
  await h.ids['quiz-form'].fire('submit');
  assert.equal(h.ids.report.hidden, false);
  assert.ok(calls.some(([name]) => name === 'flush'));
  assert.ok(calls.some(([name]) => name === 'refresh'), 'Report rendering reconnects annotation surfaces');
  assert.ok(!/annotation/i.test(JSON.stringify(h.server.get(attemptUrl(h)))), 'Submissions contain no annotation data');
  calls.length = 0;
  await h.ids['retry-quiz'].click();
  assert.equal(h.ids.report.hidden, true);
  assert.ok(calls.some(([name]) => name === 'refresh'));
  assert.equal(calls.filter(([name]) => name === 'current').at(-1)[1], first.id);
  await h.document.getElementById('nav-question-4').click();
  const beforeReview = h.storage.get(draftKey(h));
  calls.length = 0;
  await h.ids['review-attempt'].click();
  assert.equal(h.ids.report.hidden, false);
  assert.ok(calls.some(([name]) => name === 'refresh'));
  await h.ids['retry-quiz'].click();
  assert.equal(calls.filter(([name]) => name === 'current').at(-1)[1], h.data.questions[4].id);
  assert.equal(h.storage.get(draftKey(h)), beforeReview, 'Saved Review/Back keeps the prior browser draft');
  assert.equal(calls.filter(([name]) => name === 'create').length, 0, 'All practice/report transitions reuse one annotation controller');
  console.log('Question annotation integration checks passed: navigation, flush-before-rerender, Submit/report, Retry, saved Review/Back and isolated draft/submission fields.');
})().catch(error => { console.error(error); process.exitCode = 1; });
