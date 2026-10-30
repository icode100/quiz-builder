const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Real notebook code with simulated canvas, pointer events and localStorage.
// These checks never load or write personal browser notes, drafts or attempts.
const root = path.resolve(__dirname, '..');
const questions = [{ id: 'GA-1' }, { id: 'CS-2' }, { id: 'CS:3/special' }];
const quizId = 'ink-fixture';
const key = id => `practice-quiz:${quizId}:rough:${encodeURIComponent(id)}`;
const copy = value => JSON.parse(JSON.stringify(value));
const stroke = (tool = 'pen') => ({ tool, color: '#17233b', width: 4, points: [[0.1, 0.1], [0.2, 0.2]] });
const record = (id, strokes = [stroke()]) => ({ version: 1, quizId, questionId: id, updatedAt: '2026-10-30T00:00:00.000Z', strokes });

function harness(options = {}) {
  const ids = {}, operations = [], frames = new Map(), windowEvents = {}, documentEvents = {}, drawing = [];
  const storage = options.storage instanceof Map ? options.storage : new Map(options.storage || []);
  let nextFrame = 1, canvasCount = 0;
  const document = { activeElement: null, hidden: false, visibilityState: 'visible' };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
      this.attrs = {}; this.events = {}; this.style = {}; this.dataset = {};
      this.hidden = false; this.disabled = false; this.className = ''; this.textContent = ''; this.value = '';
      this.width = 1000; this.height = 1250; this.pointers = new Set();
      this.canvasName = this.tagName === 'CANVAS' ? `canvas-${++canvasCount}` : null;
      this.rect = { left: 20, top: 40, width: 400, height: 500 };
      this.classList = { toggle: (name, enabled) => { const parts = this.className.split(/\s+/).filter(Boolean).filter(part => part !== name); if (enabled) parts.push(name); this.className = parts.join(' '); }, remove: name => this.classList.toggle(name, false), add: name => this.classList.toggle(name, true), contains: name => this.className.split(/\s+/).includes(name) };
    }
    setAttribute(name, value) {
      this.attrs[name] = String(value);
      if (name === 'id') { this.id = String(value); ids[this.id] = this; }
      if (name === 'class') this.className = String(value);
      if (name === 'hidden') this.hidden = true;
      if (name === 'disabled') this.disabled = true;
      if (name === 'value') this.value = String(value);
      if (name === 'width' || name === 'height') this[name] = Number(value);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    addEventListener(name, listener) { (this.events[name] ||= []).push(listener); }
    matches(selector) {
      return selector.split(',').some(value => {
        const part = value.trim();
        const attrs = [...part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
        if (attrs.some(match => match[2] === undefined ? !Object.hasOwn(this.attrs, match[1]) : this.getAttribute(match[1]) !== match[2])) return false;
        const base = part.replace(/\[[^\]]+\]/g, '');
        return !base || base === '*' || (base.startsWith('#') ? this.id === base.slice(1) : base.startsWith('.') ? this.className.split(/\s+/).includes(base.slice(1)) : this.tagName.toLowerCase() === base.toLowerCase());
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
    focus() { document.activeElement = this; }
    setPointerCapture(id) { this.pointers.add(id); }
    hasPointerCapture(id) { return this.pointers.has(id); }
    releasePointerCapture(id) { this.pointers.delete(id); }
    getContext() {
      if (options.noCanvas || (options.noOffscreen && this.id !== 'rough-work-canvas')) return null;
      return this.context ||= canvasContext(this);
    }
    fire(name, values = {}) {
      const event = { target: this, currentTarget: this, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: 60, clientY: 90, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...values };
      for (const listener of this.events[name] || []) listener(event);
      flush();
      return event;
    }
    click() { return this.fire('click'); }
  }
  function canvasContext(canvas) {
    const target = () => canvas.id || canvas.canvasName;
    return {
      save() {}, restore() {}, setTransform() {},
      clearRect() { drawing.push({ type: 'clear', target: target() }); },
      fillRect(x, y, width, height) { drawing.push({ type: 'paper', target: target(), color: this.fillStyle, x, y, width, height }); },
      drawImage(source, ...args) { drawing.push({ type: 'image', target: target(), source: source.id || source.canvasName, sourceTag: source.tagName, args }); },
      beginPath() {}, moveTo() {}, lineTo() {}, arc() {},
      stroke() { drawing.push({ type: 'stroke', target: target(), mode: this.globalCompositeOperation, alpha: this.globalAlpha, width: this.lineWidth, color: this.strokeStyle }); },
      fill() { drawing.push({ type: 'dot', target: target(), mode: this.globalCompositeOperation, alpha: this.globalAlpha, width: this.lineWidth, color: this.fillStyle }); }
    };
  }
  document.body = new Element('body'); document.documentElement = new Element('html');
  document.documentElement.append(document.body);
  document.createElement = tag => new Element(tag);
  document.getElementById = id => ids[id] || null;
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.addEventListener = (name, listener) => { (documentEvents[name] ||= []).push(listener); };
  const html = fs.readFileSync(path.join(root, '_template/index.html'), 'utf8');
  const panelHtml = html.slice(html.indexOf('<aside id="rough-work-panel"'), html.indexOf('<aside id="question-nav"'));
  const stack = [document.body];
  for (const token of panelHtml.match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (!token.startsWith('<')) { stack.at(-1).textContent += token; continue; }
    const tag = token.match(/^<([a-z][\w-]*)/i)?.[1]; if (!tag) continue;
    const node = new Element(tag);
    for (const match of token.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      if (match.index === 1) continue;
      node.setAttribute(match[1], match[2] ?? '');
    }
    stack.at(-1).append(node);
    if (!token.endsWith('/>') && !['input', 'br', 'img', 'link', 'meta'].includes(tag)) stack.push(node);
  }
  for (const select of document.querySelectorAll('select')) {
    const opts = select.querySelectorAll('option'); select.value = (opts.find(option => Object.hasOwn(option.attrs, 'selected')) || opts[0])?.value || '';
  }
  let contextObject;
  function flush() {
    const work = [...frames.values()]; frames.clear(); for (const fn of work) fn();
  }
  contextObject = {
    document, console, Date, Math, JSON, Map, Set,
    requestAnimationFrame: callback => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, listener) => { (windowEvents[name] ||= []).push(listener); },
    localStorage: {
      getItem: storageKey => { operations.push(['get', storageKey]); if (options.fail?.('get', storageKey)) throw Error('Storage read failed'); return storage.get(storageKey) ?? null; },
      setItem: (storageKey, value) => { operations.push(['set', storageKey]); if (options.fail?.('set', storageKey)) throw Error('Storage write failed'); storage.set(storageKey, String(value)); },
      removeItem: storageKey => { operations.push(['remove', storageKey]); if (options.fail?.('remove', storageKey)) throw Error('Storage remove failed'); storage.delete(storageKey); }
    },
    fetch() { throw Error('Notebook must never access the server'); }
  };
  contextObject.window = contextObject;
  vm.createContext(contextObject);
  vm.runInContext(fs.readFileSync(path.join(root, '_template/rough-work-engine.js'), 'utf8'), contextObject);
  if (options.noEngine) vm.runInContext("window.RoughWorkEngine = undefined;", contextObject);
  vm.runInContext(fs.readFileSync(path.join(root, '_template/rough-work.js'), 'utf8'), contextObject);
  const notebook = contextObject.RoughWorkNotebook.create({ quizId, questions: copy(questions) });
  const canvas = ids['rough-work-canvas'], panel = ids['rough-work-panel'];
  const tool = name => ids[`rough-tool-${name}`].click();
  const saved = id => JSON.parse(storage.get(key(id)));
  const event = (name, values = {}) => canvas.fire(name, values);
  const draw = (values = {}) => { event('pointerdown', { clientX: 60, clientY: 90, ...values }); event('pointermove', { clientX: 100, clientY: 140, ...values }); event('pointerup', { clientX: 100, clientY: 140, ...values }); };
  return { notebook, canvas, panel, ids, storage, operations, drawing, tool, saved, event, draw, flush, context: contextObject, windowEvent(name, event = {}) { for (const listener of windowEvents[name] || []) listener(event); flush(); }, documentEvent(name, event = {}) { for (const listener of documentEvents[name] || []) listener(event); flush(); } };
}

(async () => {
  const h = harness();
  assert.deepEqual(h.operations, [], 'Binding notebook controls performs no storage operations');
  h.notebook.show('GA-1', 'GA 1'); h.flush();
  assert.match(h.ids['rough-page-label'].textContent, /GA 1/);
  assert.equal(h.storage.size, 0, 'Opening an empty page does not create a note');
  assert.equal(h.ids['rough-work-paper'].value, 'blank', 'New question pages default to blank paper');
  assert.equal(h.canvas.dataset.paperStyle, 'blank');
  h.draw();
  let saved = h.saved('GA-1');
  assert.equal(saved.version, 1); assert.equal(saved.quizId, quizId); assert.equal(saved.questionId, 'GA-1');
  assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
  assert.equal(saved.strokes.length, 1); assert.equal(saved.strokes[0].tool, 'pen');
  assert.deepEqual(saved.strokes[0].points[0], [0.1, 0.1], 'Pointer coordinates are normalized to the paper rectangle');
  assert.deepEqual(saved.strokes[0].points.at(-1), [0.2, 0.2]);
  assert.ok(h.drawing.some(command => command.target !== 'rough-work-canvas' && command.mode === 'source-over' && command.alpha === 1));
  assert.equal(h.canvas.pointers.size, 0, 'Completed drawing releases its pointer capture');
  const first = copy(saved.strokes);

  h.tool('highlighter'); h.ids['rough-work-color'].value = '#f59e0b'; h.ids['rough-work-color'].fire('change');
  h.ids['rough-work-width'].value = '16'; h.ids['rough-work-width'].fire('change');
  h.draw({ pointerType: 'pen' });
  saved = h.saved('GA-1'); assert.equal(saved.strokes.length, 2);
  assert.equal(saved.strokes[1].tool, 'highlighter'); assert.equal(saved.strokes[1].color, '#f59e0b'); assert.equal(saved.strokes[1].width, 16);
  assert.ok(h.drawing.some(command => command.target !== 'rough-work-canvas' && command.alpha === 0.25));
  h.ids['rough-undo'].click(); assert.deepEqual(h.saved('GA-1').strokes, first);
  h.ids['rough-redo'].click(); assert.equal(h.saved('GA-1').strokes.length, 2);
  h.ids['rough-clear'].click(); assert.deepEqual(h.saved('GA-1').strokes, []);
  h.ids['rough-undo'].click(); assert.equal(h.saved('GA-1').strokes.length, 2, 'Clear page can be undone');
  h.tool('eraser'); h.draw();
  assert.equal(h.saved('GA-1').strokes.at(-1).tool, 'eraser');
  assert.ok(h.drawing.some(command => command.mode === 'destination-out'));
  assert.ok(h.drawing.filter(command => command.mode === 'destination-out').every(command => command.target !== 'rough-work-canvas'), 'Erasing applies only to the separate ink layer');

  const beforeIgnored = h.storage.get(key('GA-1'));
  h.event('pointerdown', { button: 2 }); h.event('pointerup', { button: 2 });
  assert.equal(h.storage.get(key('GA-1')), beforeIgnored, 'Secondary mouse buttons do not draw');
  h.event('pointerdown', { pointerId: 1 }); h.event('pointermove', { pointerId: 2 }); h.event('pointerup', { pointerId: 2 });
  assert.equal(h.storage.get(key('GA-1')), beforeIgnored, 'A second pointer cannot commit another pointer stroke');
  h.event('pointercancel', { pointerId: 1 });
  assert.equal(h.saved('GA-1').strokes.length, 4, 'Pointer cancellation retains visible ink');
  h.event('pointerdown', { pointerType: 'touch' }); h.event('pointermove', { pointerType: 'touch' });
  h.notebook.show('CS-2', 'CS 2'); h.flush();
  assert.equal(h.saved('GA-1').strokes.length, 5, 'Changing questions commits the visible stroke to its original page');
  assert.equal(h.storage.has(key('CS-2')), false);
  h.draw(); assert.equal(h.saved('CS-2').strokes.length, 1);
  const second = h.storage.get(key('CS-2'));
  h.notebook.show('GA-1', 'GA 1'); h.flush(); h.ids['rough-undo'].click();
  assert.equal(h.saved('GA-1').strokes.length, 4); assert.equal(h.storage.get(key('CS-2')), second, 'Undo histories and storage stay separate for each question');
  h.notebook.show('CS:3/special', 'Special question'); h.flush(); h.draw();
  assert.ok(h.storage.has(key('CS:3/special')), 'Question IDs are encoded in the independent storage key');

  const reload = harness({ storage: h.storage }); reload.notebook.show('GA-1', 'GA 1'); reload.flush();
  assert.equal(reload.saved('GA-1').strokes.length, 4);
  assert.equal(reload.ids['rough-redo'].disabled, true, 'Redo history does not persist as browser history');
  assert.ok(reload.drawing.some(command => command.type === 'stroke' || command.type === 'dot'));
  const bytes = reload.storage.get(key('GA-1')); reload.notebook.hide();
  assert.equal(reload.storage.get(key('GA-1')), bytes, 'Hiding a clean restored page does not rewrite it');

  const keyboard = harness(); keyboard.notebook.show('GA-1', 'GA 1'); keyboard.draw();
  let event = keyboard.panel.fire('keydown', { key: 'z', ctrlKey: true, target: keyboard.canvas });
  assert.equal(event.prevented, true); assert.equal(keyboard.saved('GA-1').strokes.length, 0);
  keyboard.panel.fire('keydown', { key: 'z', metaKey: true, shiftKey: true, target: keyboard.canvas });
  assert.equal(keyboard.saved('GA-1').strokes.length, 1);
  keyboard.panel.fire('keydown', { key: 'z', ctrlKey: true, target: keyboard.canvas });
  keyboard.panel.fire('keydown', { key: 'y', ctrlKey: true, target: keyboard.canvas });
  assert.equal(keyboard.saved('GA-1').strokes.length, 1, 'Ctrl+Y is a supported redo shortcut');
  keyboard.panel.fire('keydown', { key: 'z', ctrlKey: true, target: keyboard.ids['rough-work-color'] });
  assert.equal(keyboard.saved('GA-1').strokes.length, 1, 'Native setting controls retain their own keyboard behavior');
  keyboard.event('pointerdown'); keyboard.event('pointermove'); keyboard.windowEvent('pagehide');
  assert.equal(keyboard.saved('GA-1').strokes.length, 2, 'Pagehide commits active visible ink');
  keyboard.event('pointerdown'); keyboard.event('lostpointercapture');
  assert.equal(keyboard.saved('GA-1').strokes.length, 3, 'Losing pointer capture commits the visible stroke once');

  const historyFocus = harness(); historyFocus.notebook.show('GA-1', 'GA 1'); historyFocus.draw();
  historyFocus.ids['rough-clear'].focus(); historyFocus.ids['rough-clear'].click();
  assert.equal(historyFocus.ids['rough-clear'].disabled, true);
  assert.equal(historyFocus.context.document.activeElement, historyFocus.canvas, 'Clear page returns focus to the canvas when its button becomes disabled');
  historyFocus.panel.fire('keydown', { key: 'z', ctrlKey: true, target: historyFocus.context.document.activeElement });
  assert.equal(historyFocus.saved('GA-1').strokes.length, 1, 'The clear action can immediately be undone from the restored canvas focus');
  historyFocus.ids['rough-undo'].focus(); historyFocus.ids['rough-undo'].click();
  assert.equal(historyFocus.ids['rough-undo'].disabled, true);
  assert.equal(historyFocus.context.document.activeElement, historyFocus.canvas, 'The final Undo keeps focus inside the notebook when its button becomes disabled');
  historyFocus.panel.fire('keydown', { key: 'y', ctrlKey: true, target: historyFocus.context.document.activeElement });
  assert.equal(historyFocus.saved('GA-1').strokes.length, 1, 'Keyboard Redo still works after the final Undo disables its button');
  historyFocus.panel.fire('keydown', { key: 'z', ctrlKey: true, target: historyFocus.canvas });
  historyFocus.ids['rough-redo'].focus(); historyFocus.ids['rough-redo'].click();
  assert.equal(historyFocus.saved('GA-1').strokes.length, 1);
  historyFocus.ids['rough-redo'].click(); // The older Clear action is the last remaining redo.
  assert.equal(historyFocus.ids['rough-redo'].disabled, true);
  assert.equal(historyFocus.context.document.activeElement, historyFocus.canvas, 'The final Redo also returns focus to the canvas');

  const branched = harness(); branched.notebook.show('GA-1', 'GA 1'); branched.draw(); branched.draw();
  branched.ids['rough-undo'].click(); assert.equal(branched.ids['rough-redo'].disabled, false);
  branched.draw(); assert.equal(branched.saved('GA-1').strokes.length, 2);
  assert.equal(branched.ids['rough-redo'].disabled, true, 'A new stroke after undo discards the old redo branch');
  const geometry = harness(); geometry.notebook.show('GA-1', 'GA 1');
  geometry.event('pointerdown', { clientX: -100, clientY: -100 });
  geometry.event('pointerup', { clientX: 10000, clientY: 10000 });
  assert.deepEqual(geometry.saved('GA-1').strokes[0].points, [[0, 0], [1, 1]], 'Captured movement outside the page is bounded to the paper');
  geometry.canvas.rect = { left: 20, top: 40, width: 200, height: 250 };
  geometry.event('pointerdown', { clientX: 40, clientY: 65 });
  geometry.event('pointerup', { clientX: 60, clientY: 90 });
  assert.deepEqual(geometry.saved('GA-1').strokes[1].points, [[0.1, 0.1], [0.2, 0.2]], 'Resizing the displayed paper preserves normalized coordinates');
  const fullRecord = JSON.stringify(record('GA-1', Array.from({ length: 1000 }, () => stroke())));
  const full = harness({ storage: [[key('GA-1'), fullRecord]] }); full.notebook.show('GA-1', 'GA 1'); full.draw();
  assert.equal(full.storage.get(key('GA-1')), fullRecord, 'A full page rejects more ink without deleting or rewriting saved strokes');
  assert.match(full.ids['rough-work-status'].textContent, /full|limit/i);
  for (const options of [{ noCanvas: true }, { noOffscreen: true }, { noEngine: true }]) {
    const unavailable = harness(options); unavailable.notebook.show('GA-1', 'GA 1'); unavailable.notebook.hide();
    assert.equal(unavailable.storage.size, 0);
    assert.match(unavailable.ids['rough-work-status'].textContent, /unavailable/i, `Unsupported drawing ${JSON.stringify(options)}: ${unavailable.ids['rough-work-status'].textContent}`);
  }

  let failWrites = true;
  const failing = harness({ fail: operation => failWrites && operation === 'set' });
  failing.notebook.show('GA-1', 'GA 1'); failing.draw();
  assert.equal(failing.storage.has(key('GA-1')), false);
  assert.match(failing.ids['rough-work-status'].textContent, /could not|unavailable|not saved|keep.*open/i);
  failWrites = false; failing.notebook.hide();
  assert.equal(failing.saved('GA-1').strokes.length, 1, 'A later close retries a dirty failed save without losing ink');

  for (const invalid of [
    { ...record('GA-1'), version: 2 }, { ...record('GA-1'), quizId: 'another' }, { ...record('GA-1'), questionId: 'CS-2' },
    { ...record('GA-1'), updatedAt: 'invalid' }, { ...record('GA-1'), strokes: null },
    { ...record('GA-1'), strokes: [{ ...stroke(), points: [[-0.1, 0]] }] },
    { ...record('GA-1'), strokes: [{ ...stroke(), width: 3 }] }, { ...record('GA-1'), strokes: [{ ...stroke(), tool: 'script' }] }
  ]) {
    const original = JSON.stringify(invalid), bad = harness({ storage: [[key('GA-1'), original]] });
    bad.notebook.show('GA-1', 'GA 1'); bad.draw(); bad.notebook.hide();
    assert.equal(bad.storage.get(key('GA-1')), original, 'Malformed existing notes are not silently overwritten');
    assert.match(bad.ids['rough-work-status'].textContent, /could not|invalid|unavailable|not saved|keep.*open/i);
  }
  const unreadable = harness({ storage: [[key('GA-1'), JSON.stringify(record('GA-1'))]], fail: operation => operation === 'get' });
  const originalUnreadable = unreadable.storage.get(key('GA-1'));
  unreadable.notebook.show('GA-1', 'GA 1'); unreadable.draw(); unreadable.notebook.hide();
  assert.equal(unreadable.storage.get(key('GA-1')), originalUnreadable, 'Unreadable existing notes remain untouched');
  assert.match(unreadable.ids['rough-work-status'].textContent, /could not|unavailable|not saved|keep.*open/i);
  const sentinels = new Map([['practice-quiz:ink-fixture', 'quiz-draft'], ['practice-quiz:theme', 'dark'], ['unrelated', 'untouched']]);
  const isolated = harness({ storage: sentinels }); isolated.notebook.show('GA-1', 'GA 1'); isolated.draw(); isolated.ids['rough-clear'].click(); isolated.ids['rough-undo'].click(); isolated.notebook.hide();
  for (const [storageKey, value] of [['practice-quiz:ink-fixture', 'quiz-draft'], ['practice-quiz:theme', 'dark'], ['unrelated', 'untouched']]) assert.equal(sentinels.get(storageKey), value);
  assert.ok(isolated.operations.every(([, storageKey]) => storageKey.startsWith(`practice-quiz:${quizId}:rough:`)), 'Notebook operations use only their dedicated storage namespace');

  const patterned = harness(); patterned.notebook.show('GA-1', 'GA 1'); patterned.draw();
  const originalInk = copy(patterned.saved('GA-1').strokes);
  const choosePaper = (h, value) => { h.ids['rough-work-paper'].value = value; h.ids['rough-work-paper'].fire('change'); };
  choosePaper(patterned, 'dotted');
  assert.equal(patterned.saved('GA-1').paperStyle, 'dotted');
  assert.equal(patterned.canvas.dataset.paperStyle, 'dotted');
  assert.deepEqual(patterned.saved('GA-1').strokes, originalInk, 'Paper selection leaves existing ink unchanged');
  patterned.ids['rough-undo'].click();
  assert.equal(patterned.saved('GA-1').strokes.length, 0, 'Paper selection does not add an ink undo action');
  assert.equal(patterned.saved('GA-1').paperStyle, 'dotted');
  patterned.ids['rough-redo'].click();
  assert.deepEqual(patterned.saved('GA-1').strokes, originalInk);
  assert.equal(patterned.saved('GA-1').paperStyle, 'dotted');
  patterned.ids['rough-clear'].click();
  assert.equal(patterned.saved('GA-1').strokes.length, 0);
  assert.equal(patterned.saved('GA-1').paperStyle, 'dotted', 'Clear page removes ink and retains the selected paper');
  patterned.ids['rough-undo'].click();
  assert.deepEqual(patterned.saved('GA-1').strokes, originalInk);
  assert.equal(patterned.canvas.dataset.paperStyle, 'dotted', 'Undoing Clear does not change paper style');
  patterned.panel.fire('keydown', { key: 'z', ctrlKey: true, target: patterned.ids['rough-work-paper'] });
  assert.deepEqual(patterned.saved('GA-1').strokes, originalInk, 'The native paper selector keeps its own keyboard behavior');
  patterned.notebook.show('CS-2', 'CS 2');
  assert.equal(patterned.ids['rough-work-paper'].value, 'blank');
  choosePaper(patterned, 'ruled');
  assert.deepEqual(patterned.saved('CS-2').strokes, [], 'Paper choice alone is a saved notebook edit without inventing ink');
  patterned.draw();
  const ruledPage = patterned.storage.get(key('CS-2'));
  patterned.notebook.show('GA-1', 'GA 1');
  assert.equal(patterned.ids['rough-work-paper'].value, 'dotted', 'Each question keeps its own paper choice');
  const beforeGridDraw = patterned.drawing.length;
  choosePaper(patterned, 'grid');
  assert.equal(patterned.saved('GA-1').paperStyle, 'grid');
  const composite = patterned.drawing.slice(beforeGridDraw);
  const paperFill = composite.findIndex(command => command.target === 'rough-work-canvas' && command.type === 'paper' && command.width === 1000 && command.height === 1250);
  const gridLines = composite.findIndex(command => command.target === 'rough-work-canvas' && command.type === 'stroke');
  const inkOverlay = composite.findIndex(command => command.target === 'rough-work-canvas' && command.type === 'image');
  assert.ok(paperFill >= 0, 'The visible canvas receives an actual paper backing bitmap');
  assert.match(composite[paperFill].color.toLowerCase(), /^(?:white|#fff(?:fff)?)$/, 'Paper backing stays white in either theme');
  assert.ok(gridLines > paperFill, 'Grid rules are rendered on top of the paper backing');
  assert.ok(inkOverlay > gridLines, 'The separate transparent ink layer is composited after the visible grid');
  assert.equal(composite[inkOverlay].sourceTag, 'CANVAS');
  assert.notEqual(composite[inkOverlay].source, 'rough-work-canvas', 'Compositing reads the separate ink canvas');
  assert.equal(patterned.storage.get(key('CS-2')), ruledPage, 'Changing one question paper leaves other question pages untouched');
  const patternedReload = harness({ storage: patterned.storage }); patternedReload.notebook.show('GA-1', 'GA 1');
  assert.equal(patternedReload.ids['rough-work-paper'].value, 'grid');
  assert.equal(patternedReload.canvas.dataset.paperStyle, 'grid', 'Paper templates restore after reopening');
  assert.deepEqual(patternedReload.saved('GA-1').strokes, originalInk);
  choosePaper(patternedReload, 'blank');
  assert.equal(patternedReload.saved('GA-1').paperStyle, 'blank', 'Blank remains a selectable paper style');
  patternedReload.notebook.show('CS-2', 'CS 2');
  assert.equal(patternedReload.ids['rough-work-paper'].value, 'ruled');
  const legacyPaper = JSON.stringify(record('GA-1'));
  const legacy = harness({ storage: [[key('GA-1'), legacyPaper]] }); legacy.notebook.show('GA-1', 'GA 1');
  assert.equal(legacy.ids['rough-work-paper'].value, 'blank', 'Legacy records with no paperStyle remain compatible');
  assert.equal(legacy.canvas.dataset.paperStyle, 'blank');
  assert.equal(legacy.storage.get(key('GA-1')), legacyPaper, 'Reading legacy paper does not rewrite stored notes');
  const activePaper = harness(); activePaper.notebook.show('GA-1', 'GA 1');
  activePaper.event('pointerdown'); activePaper.event('pointermove');
  choosePaper(activePaper, 'grid');
  assert.equal(activePaper.saved('GA-1').strokes.length, 1, 'Changing paper commits an active visible stroke once');
  assert.equal(activePaper.saved('GA-1').paperStyle, 'grid', 'Finishing an active stroke cannot reset the selected paper option');
  activePaper.event('pointerup');
  assert.equal(activePaper.saved('GA-1').strokes.length, 1);
  activePaper.ids['rough-undo'].click();
  assert.equal(activePaper.ids['rough-redo'].disabled, false);
  choosePaper(activePaper, 'ruled');
  assert.equal(activePaper.ids['rough-redo'].disabled, false, 'Changing paper preserves an existing ink redo branch');
  activePaper.ids['rough-redo'].click();
  assert.equal(activePaper.saved('GA-1').strokes.length, 1);
  assert.equal(activePaper.saved('GA-1').paperStyle, 'ruled');
  for (const paperStyle of [null, [], {}, 1, true, '', 'unknown', 'Grid']) {
    const invalidPaper = JSON.stringify({ ...record('GA-1'), paperStyle });
    const badPaper = harness({ storage: [[key('GA-1'), invalidPaper]] }); badPaper.notebook.show('GA-1', 'GA 1');
    choosePaper(badPaper, 'dotted'); badPaper.draw(); badPaper.notebook.hide();
    assert.equal(badPaper.storage.get(key('GA-1')), invalidPaper, 'Invalid paper style does not overwrite an unreadable original record');
    assert.match(badPaper.ids['rough-work-status'].textContent, /could not|invalid|unavailable|not saved|keep.*open/i);
  }

  // The quiz tells the independent notebook which original question is active.
  // This API stub verifies the real integration without accessing real notes.
  const quizHarness = require('./helpers/quiz-harness.cjs'), notifications = [];
  const integrated = await quizHarness.load('gate-cse-2021-set-1', { window: { RoughWorkNotebook: { create(config) {
    notifications.push(['create', config.quizId, config.questions.map(question => question.id)]);
    return { show(id, label) { notifications.push(['show', id, label]); }, hide() { notifications.push(['hide']); } };
  } } } });
  assert.equal(notifications[0][0], 'create'); assert.equal(notifications[0][1], integrated.data.id);
  assert.deepEqual(copy(notifications[0][2]), copy(integrated.data.questions.map(question => question.id)));
  assert.equal(notifications.some(event => event[0] === 'show'), false, 'Closed notebook pages are not loaded merely by opening a quiz');
  await integrated.ids['rough-work-toggle'].click();
  assert.equal(notifications.at(-1)[1], integrated.data.questions[0].id);
  await integrated.document.getElementById('nav-question-4').click();
  assert.equal(notifications.at(-1)[1], integrated.data.questions[4].id, 'Practice-map changes select the matching notebook page');
  await integrated.ids['next-question'].click();
  assert.equal(notifications.at(-1)[1], integrated.data.questions[5].id, 'Carousel changes select the matching notebook page');
  await integrated.ids['rough-work-close'].click(); assert.deepEqual(notifications.at(-1), ['hide']);
  const closedCount = notifications.length;
  await integrated.document.getElementById('nav-question-7').click();
  assert.equal(notifications.length, closedCount, 'Closed notebook navigation does not read another page');
  await integrated.ids['rough-work-toggle'].click();
  assert.equal(notifications.at(-1)[1], integrated.data.questions[7].id, 'Reopening selects the current quiz question');
  await quizHarness.editResponse(integrated, integrated.data.questions[0].id, integrated.data.questions[0].correctAnswer);
  await integrated.ids['quiz-form'].fire('submit');
  assert.equal(integrated.ids.report.hidden, false);
  assert.equal(notifications.at(-1)[1], integrated.data.questions[0].id, 'A submitted report selects its active original question');
  await integrated.document.getElementById('nav-question-6').click();
  assert.equal(notifications.at(-1)[1], integrated.data.questions[6].id, 'Report-map changes select their matching notebook page');

  // Back and reset assign the quiz index before rebuilding cards. They must
  // still notify the notebook even when the subsequent index is unchanged.
  const notebookPage = (h, calls, index, message) => {
    assert.equal(calls.at(-1)[0], 'show', message);
    assert.equal(calls.at(-1)[1], h.data.questions[index].id, message);
    const active = h.ids['nav-groups'].querySelectorAll('.nav-question').filter(node => node.getAttribute('aria-current') === 'location');
    assert.deepEqual(active.map(node => node.id), [`nav-question-${index}`], 'Notebook and active quiz map stay aligned');
  };
  const originalSubmission = copy(integrated.server.get(quizHarness.attemptUrl(integrated)));
  await integrated.ids['review-attempt'].click();
  notebookPage(integrated, notifications, 0, 'Opening saved Review selects the first report question');
  await integrated.document.getElementById('nav-question-9').click();
  notebookPage(integrated, notifications, 9, 'Review map jumps select their notebook page');
  await integrated.ids['retry-quiz'].click();
  assert.equal(integrated.ids.report.hidden, false, 'Back restores the previous submitted-report view');
  notebookPage(integrated, notifications, 6, 'Back from Review restores the prior report notebook page');
  await integrated.ids['retry-quiz'].click();
  assert.equal(integrated.ids['quiz-form'].hidden, false);
  notebookPage(integrated, notifications, 0, 'Attempt again resets both practice and notebook to the first question');
  await integrated.document.getElementById('nav-question-5').click();
  notebookPage(integrated, notifications, 5, 'New practice can have a different notebook page');
  const priorPracticeDraft = integrated.storage.get(quizHarness.draftKey(integrated));
  await integrated.ids['review-attempt'].click();
  notebookPage(integrated, notifications, 0, 'Saved Review selects its first report page from later practice');
  await integrated.document.getElementById('nav-question-8').click();
  await integrated.ids['retry-quiz'].click();
  assert.equal(integrated.ids['quiz-form'].hidden, false, 'Back restores practice rather than keeping the Review report');
  notebookPage(integrated, notifications, 5, 'Back restores the exact prior practice notebook page');
  assert.equal(integrated.storage.get(quizHarness.draftKey(integrated)), priorPracticeDraft, 'Review/Back preserves the practice draft bytes');
  await integrated.ids['clear-answers'].click();
  notebookPage(integrated, notifications, 0, 'Clear answers resets both practice and notebook to the first question');
  assert.deepEqual(integrated.server.get(quizHarness.attemptUrl(integrated)), originalSubmission);

  const failedCalls = [];
  const failed = await quizHarness.load('gate-cse-2021-set-1', {
    server: new Map([[quizHarness.attemptUrl(integrated), originalSubmission]]),
    fetch: (request, perform, response) => request.method === 'POST' ? response(503, {}) : perform(),
    window: { RoughWorkNotebook: { create() { return { show(id, label) { failedCalls.push(['show', id, label]); }, hide() { failedCalls.push(['hide']); } }; } } }
  });
  await quizHarness.editResponse(failed, failed.data.questions[0].id, failed.data.questions[0].correctAnswer);
  await failed.document.getElementById('nav-question-5').click();
  await failed.ids['rough-work-toggle'].click();
  notebookPage(failed, failedCalls, 5, 'An unfinished attempt opens its current notebook page');
  await failed.ids['quiz-form'].fire('submit');
  assert.equal(failed.ids.report.hidden, false, 'Failed saving keeps the newly graded report');
  notebookPage(failed, failedCalls, 0, 'The failed-save report selects its first question page');
  await failed.document.getElementById('nav-question-7').click();
  notebookPage(failed, failedCalls, 7, 'The failed-save report can select another notebook page');
  const failedDraft = failed.storage.get(quizHarness.draftKey(failed));
  await failed.ids['review-attempt'].click();
  await failed.document.getElementById('nav-question-2').click();
  notebookPage(failed, failedCalls, 2, 'Saved Review uses its own current notebook page');
  await failed.ids['retry-quiz'].click();
  assert.equal(failed.ids.report.hidden, false);
  notebookPage(failed, failedCalls, 7, 'Back restores the prior failed-save report notebook page');
  assert.equal(failed.storage.get(quizHarness.draftKey(failed)), failedDraft);
  assert.deepEqual(failed.server.get(quizHarness.attemptUrl(failed)), originalSubmission);
  await failed.ids['retry-quiz'].click();
  notebookPage(failed, failedCalls, 0, 'Retry after a failed-save report resets to the first notebook page');

  for (const folder of ['_template', ...fs.readdirSync(root).filter(name => /^gate-cse-/.test(name))]) {
    const html = fs.readFileSync(path.join(root, folder, 'index.html'), 'utf8');
    assert.ok(html.indexOf('src="rough-work-engine.js"') < html.indexOf('src="rough-work.js"'));
    assert.ok(html.indexOf('src="rough-work.js"') < html.indexOf('src="quiz.js"'));
    for (const file of ['rough-work-engine.js', 'rough-work.js']) assert.equal(fs.readFileSync(path.join(root, folder, file), 'utf8'), fs.readFileSync(path.join(root, '_template', file), 'utf8'), 'Notebook scripts are synchronized');
  }
  console.log('Notebook checks passed: pointer tools, normalized ink, per-question autosave/restore/isolation, blank/dotted/ruled/grid paper, undo/redo and undoable clear, keyboard shortcuts, pagehide/cancellation/capture, malformed and unavailable storage, and dedicated storage boundaries. No real notes or attempts touched.');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
