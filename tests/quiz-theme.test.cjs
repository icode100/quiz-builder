const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Theme-only simulated DOM and storage: no quiz data, browser profile, server,
// or real draft/attempt is read or changed.
const source = fs.readFileSync(path.join(__dirname, '../_template/theme.js'), 'utf8');
const key = 'practice-quiz:theme';
function load({ saved, dark = false, unavailable = false, delayedButton = false, noButton = false } = {}) {
  const root = { dataset: {} }, label = { textContent: 'Theme' }, events = {}, systemEvents = {}, clicks = [];
  const attrs = { role: 'switch', 'aria-label': 'Theme', 'aria-checked': 'false' };
  const button = {
    title: '', setAttribute(name, value) { attrs[name] = String(value); },
    querySelector(selector) { assert.equal(selector, '.switch-label'); return label; },
    addEventListener(name, callback) { assert.equal(name, 'click'); clicks.push(callback); }
  };
  let visibleButton = !delayedButton && !noButton;
  const storage = new Map([['practice-quiz:untouched-paper', 'existing browser draft']]);
  if (saved !== undefined) storage.set(key, saved);
  const operations = [], preference = {
    matches: dark,
    addEventListener(name, callback) { (systemEvents[name] ||= []).push(callback); }
  };
  const document = {
    documentElement: root,
    getElementById(id) { assert.equal(id, 'theme-toggle'); return visibleButton ? button : null; },
    addEventListener(name, callback) { (events[name] ||= []).push(callback); }
  };
  vm.runInNewContext(source, {
    document,
    window: { matchMedia(query) { assert.equal(query, '(prefers-color-scheme: dark)'); return preference; } },
    localStorage: {
      getItem(name) { operations.push(['get', name]); if (unavailable) throw Error('Storage unavailable'); return storage.get(name) ?? null; },
      setItem(name, value) { operations.push(['set', name, value]); if (unavailable) throw Error('Storage unavailable'); storage.set(name, value); }
    }
  });
  return {
    root, label, button, attrs, storage, operations,
    ready() { visibleButton = !noButton; for (const callback of events.DOMContentLoaded || []) callback(); },
    click() { for (const callback of clicks) callback(); },
    system(value) { preference.matches = value; for (const callback of systemEvents.change || []) callback({ matches: value }); }
  };
}
function theme(h, value) {
  assert.equal(h.root.dataset.theme, value);
  assert.equal(h.label.textContent, value === 'dark' ? 'Dark' : 'Light');
  assert.equal(h.button.title, `Switch to ${value === 'dark' ? 'light' : 'dark'} mode`);
  assert.equal(h.attrs['aria-checked'], String(value === 'dark'));
  assert.equal(h.attrs.role, 'switch');
  assert.equal(h.attrs['aria-label'], 'Theme', 'The accessible switch name stays stable');
  assert(h.operations.every(([, name]) => name === key), 'Theme only accesses its own preference key');
  assert.equal(h.storage.get('practice-quiz:untouched-paper'), 'existing browser draft');
}

const basic = load(); basic.ready(); theme(basic, 'light');
assert.equal(basic.storage.has(key), false, 'Automatic system preference does not create a saved choice');
basic.click(); theme(basic, 'dark'); assert.equal(basic.storage.get(key), 'dark');
basic.system(false); theme(basic, 'dark');
basic.click(); theme(basic, 'light'); assert.equal(basic.storage.get(key), 'light');
basic.system(true); theme(basic, 'light');

const automatic = load({ dark: true }); automatic.ready(); theme(automatic, 'dark');
automatic.system(false); theme(automatic, 'light');
automatic.system(true); theme(automatic, 'dark');
assert.equal(automatic.storage.has(key), false);

for (const saved of ['dark', 'light']) {
  const remembered = load({ saved, dark: saved === 'light' }); remembered.ready(); theme(remembered, saved);
  remembered.system(saved === 'light'); theme(remembered, saved);
  assert.equal(remembered.storage.get(key), saved, 'A saved choice takes priority over system changes');
}
const invalid = load({ saved: 'sepia', dark: true }); invalid.ready(); theme(invalid, 'dark');
invalid.system(false); theme(invalid, 'light');
assert.equal(invalid.storage.get(key), 'sepia', 'Opening does not overwrite an invalid optional preference');

const delayed = load({ dark: true, delayedButton: true });
assert.equal(delayed.root.dataset.theme, 'dark', 'The page theme applies before its button exists');
delayed.ready(); theme(delayed, 'dark'); delayed.click(); theme(delayed, 'light');

const unavailable = load({ dark: true, unavailable: true }); unavailable.ready(); theme(unavailable, 'dark');
unavailable.click(); theme(unavailable, 'light');
unavailable.system(true); theme(unavailable, 'light');
assert.equal(unavailable.storage.has(key), false, 'Failed persistence still permits a selected theme for this page');
const missing = load({ noButton: true }); missing.ready(); missing.system(true);
assert.equal(missing.root.dataset.theme, 'dark', 'Pages without the optional button still follow system theme');

console.log('PASS: theme label/title and accessible state, toggle, saved/system preference, delayed/missing button, isolated storage and unavailable storage. No real browser state changed.');
