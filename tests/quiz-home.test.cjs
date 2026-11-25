const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Simulated DOM/fetch only: this suite never accesses a server, user attempts,
// browser drafts, or the user's browser/profile.
class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.events = {};
    this.textContent = ''; this.className = ''; this.hidden = false;
    this.checked = false; this.disabled = false;
    this.classList = {
      remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); },
      toggle: (name, on) => { this.classList.remove(name); if (on) this.className = [this.className, name].filter(Boolean).join(' '); }
    };
  }
  querySelector(selector) { return ({'.paper-status':this.badge,'.paper-score':this.score,'.paper-score-value':this.scoreValue,'.paper-score-bar':this.scoreBar,'.paper-score-marks':this.scoreMarks})[selector] || null; }
  querySelectorAll(selector) { return selector === 'li' ? this.children : []; }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  async fire(name) { for (const callback of this.events[name] || []) await callback({ target: this, preventDefault() {} }); }
  setAttribute(name, value) { this[name] = String(value); }
}

function harness(states = ['true', 'false', 'false'], options = {}) {
  const ids = Object.fromEntries(['home-papers', 'unsolved-only', 'paper-count', 'no-papers', 'reset-attempts', 'home-status'].map(id => [id, new Element()]));
  const cards = states.map((state,index) => {
    const card = new Element(); card.dataset.attempted = state; card.dataset.quizId = `paper-${index + 1}`;
    card.badge = new Element(); card.badge.textContent = state === 'true' ? 'Attempted before' : 'Not attempted';
    card.badge.className = state === 'true' ? 'paper-status attempted' : 'paper-status unattempted';
    card.score = new Element(); card.score.hidden = state !== 'true'; card.score.textContent = 'Last score: 42% 42 / 100 marks';
    card.scoreValue = new Element(); card.scoreBar = new Element(); card.scoreMarks = new Element();
    return card;
  });
  ids['home-papers'].children = cards;
  const requests = [], confirmations = [];
  const windowEvents = {};
  let storageCalls = 0, reloads = 0;
  const window = {
    QuizCloudSync: options.cloud,
    confirm(message) { confirmations.push(message); return options.confirm !== false; },
    addEventListener(name, callback) { (windowEvents[name] ||= []).push(callback); },
    location: { reload() { reloads++; } }
  };
  const document = {
    getElementById: id => ids[id] || null,
    querySelectorAll: selector => selector === '#home-papers li' ? cards : []
  };
  const fetch = (url, init = {}) => {
    requests.push({ url, ...init });
    return options.fetch ? options.fetch(url, init) : Promise.resolve({ ok: true, status: 200, json: async () => ({ reset: cards.length }) });
  };
  const context = { window, document, fetch, console };
  for (const object of [context, window]) Object.defineProperty(object, 'localStorage', { get() { storageCalls++; throw new Error('Home must not access browser drafts.'); } });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '_template', 'home.js'), 'utf8'), context);
  return { ids, cards, requests, confirmations, storageCalls: () => storageCalls, reloads: () => reloads, fireWindow: (name, event) => { for (const callback of windowEvents[name] || []) callback(event); } };
}

const snapshot = h => JSON.stringify({ cards: h.cards.map(card => ({ attempted: card.dataset.attempted, hidden: card.hidden, badge: card.badge.textContent, className: card.badge.className, scoreHidden: card.score.hidden, score: card.score.textContent })), count: h.ids['paper-count'].textContent, empty: h.ids['no-papers'].hidden, notice: h.ids['home-status'].textContent });

async function run() {
  const h = harness();
  assert.ok(h.cards.every(card => !card.hidden));
  assert.ok(h.ids['no-papers'].hidden);
  h.ids['unsolved-only'].checked = true;
  await h.ids['unsolved-only'].fire('change');
  assert.deepEqual(h.cards.map(card => card.hidden), [true, false, false]);
  assert.match(h.ids['paper-count'].textContent, /\b2\b.*\b3\b/);
  h.ids['unsolved-only'].checked = false;
  await h.ids['unsolved-only'].fire('change');
  assert.ok(h.cards.every(card => !card.hidden));
  assert.equal(h.storageCalls(), 0);
  const beforeBack = snapshot(h);
  h.fireWindow('pageshow', { persisted: false });
  assert.equal(h.reloads(), 0);
  h.fireWindow('pageshow', { persisted: true });
  assert.equal(h.reloads(), 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.storageCalls(), 0);
  assert.equal(snapshot(h), beforeBack);

  const allAttempted = harness(['true', 'true']);
  allAttempted.ids['unsolved-only'].checked = true;
  await allAttempted.ids['unsolved-only'].fire('change');
  assert.ok(allAttempted.cards.every(card => card.hidden));
  assert.equal(allAttempted.ids['no-papers'].hidden, false);
  assert.match(allAttempted.ids['paper-count'].textContent, /\b0\b.*\b2\b/);

  const cancelled = harness(undefined, { confirm: false });
  const beforeCancel = snapshot(cancelled);
  await cancelled.ids['reset-attempts'].fire('click');
  assert.equal(cancelled.confirmations.length, 1);
  assert.equal(cancelled.requests.length, 0);
  assert.equal(snapshot(cancelled), beforeCancel);
  assert.equal(cancelled.ids['reset-attempts'].disabled, false);

  let resolveReset;
  const reset = harness(undefined, { fetch: () => new Promise(resolve => { resolveReset = resolve; }) });
  reset.ids['unsolved-only'].checked = true;
  await reset.ids['unsolved-only'].fire('change');
  const pending = reset.ids['reset-attempts'].fire('click');
  assert.equal(reset.ids['reset-attempts'].disabled, true);
  assert.equal(reset.confirmations.length, 1);
  assert.equal(reset.requests.length, 1);
  assert.equal(reset.requests[0].url, '/reset-attempts');
  assert.equal(reset.requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(reset.requests[0].body), { confirm: true });
  const headers = Object.fromEntries(Object.entries(reset.requests[0].headers).map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(headers['content-type'], 'application/json');
  resolveReset({ ok: true, status: 200, json: async () => ({ reset: 1 }) });
  await pending;
  for (const card of reset.cards) {
    assert.equal(card.dataset.attempted, 'false'); assert.equal(card.hidden, false);
    assert.equal(card.badge.textContent, 'Not attempted');
    assert.ok(!card.badge.className.split(' ').includes('attempted'));
    assert.ok(card.badge.className.split(' ').includes('unattempted'));
    assert.equal(card.score.hidden, true);
  }
  assert.equal(reset.ids['unsolved-only'].checked, true);
  assert.ok(reset.ids['no-papers'].hidden);
  assert.ok(reset.ids['home-status'].textContent.trim());
  assert.equal(reset.ids['reset-attempts'].disabled, false);
  assert.equal(reset.storageCalls(), 0);

  for (const fetch of [async () => ({ ok: false, status: 500, text: async () => 'Unable to reset', json: async () => ({ error: 'Unable to reset' }) }), async () => { throw new Error('Server unavailable'); }]) {
    const failure = harness(undefined, { fetch });
    failure.ids['unsolved-only'].checked = true;
    await failure.ids['unsolved-only'].fire('change');
    const cardsBefore = failure.cards.map(card => [card.dataset.attempted, card.hidden, card.badge.textContent, card.badge.className, card.score.hidden, card.score.textContent]);
    await failure.ids['reset-attempts'].fire('click');
    assert.deepEqual(failure.cards.map(card => [card.dataset.attempted, card.hidden, card.badge.textContent, card.badge.className, card.score.hidden, card.score.textContent]), cardsBefore);
    assert.equal(failure.ids['unsolved-only'].checked, true);
    assert.equal(failure.ids['reset-attempts'].disabled, false);
    assert.ok(failure.ids['home-status'].textContent.trim());
    assert.equal(failure.storageCalls(), 0);
  }
  const empty = harness([]);
  assert.equal(empty.ids['no-papers'].hidden, false);
  empty.ids['unsolved-only'].checked = true;
  await empty.ids['unsolved-only'].fire('change');
  assert.equal(empty.ids['no-papers'].hidden, false);
  assert.equal(empty.storageCalls(), 0);

  // Confirmed cached scores render before held network calls; unknown/pending
  // records cannot masquerade as a confirmed submission or forged summary.
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const attempt = score => ({answers:{Q1:'A'},summary:{score,maximum:100,percentage:score}});
  const confirmed = new Map([['paper-1',attempt(65.5)],['paper-2',null]]), gets = [], held = new Map();
  const cloud = {
    entries: () => [['practice-quiz:paper-1:attempt','confirmed'],['practice-quiz:paper-4:attempt','unconfirmed-pending']],
    getCachedAttempt: id => confirmed.get(id),
    getAttempt(id) { gets.push(id); return new Promise(resolve => held.set(id,resolve)); }
  };
  const cached = harness(['false','true','false','false'],{cloud});
  assert.equal(cached.cards[0].dataset.attempted,'true');
  assert.equal(cached.cards[0].scoreValue.textContent,'Last score: 65.5%');
  assert.equal(cached.cards[0].scoreBar.value,65.5);
  assert.equal(cached.cards[0].scoreMarks.textContent,'65.5 / 100 marks');
  assert.equal(cached.cards[1].dataset.attempted,'false','Confirmed absence overrides a stale badge immediately');
  assert.deepEqual(gets,['paper-4'],'Unknown absent cards do not launch requests; pending records use the verified API');
  assert.equal(cached.cards[3].score.hidden,true,'Pending cache is never rendered as a confirmed score');
  confirmed.set('paper-4',attempt(82));
  cached.fireWindow('quiz-cloud-record',{detail:{key:'practice-quiz:paper-4:attempt'}});
  assert.equal(cached.cards[3].scoreValue.textContent,'Last score: 82%');
  assert.deepEqual(gets,['paper-4'],'A confirmed remote event reuses its cache without a duplicate GET');
  held.get('paper-4')(attempt(12)); await tick();
  assert.equal(cached.cards[3].scoreValue.textContent,'Last score: 82%','A late older GET cannot replace the newer confirmed event');
  confirmed.set('paper-1',null);
  cached.fireWindow('quiz-cloud-record',{detail:{key:'practice-quiz:paper-1:attempt'}});
  assert.equal(cached.cards[0].dataset.attempted,'false'); assert.equal(cached.cards[0].score.hidden,true);
  assert.equal(cached.storageCalls(),0);

  let fallbackGets = 0;
  const fallback = harness(['false'],{cloud:{entries:() => [['practice-quiz:paper-1:attempt','legacy-facade']],async getAttempt() { fallbackGets++; return attempt(41); }}});
  await tick();
  assert.equal(fallbackGets,1); assert.equal(fallback.cards[0].scoreValue.textContent,'Last score: 41%','Older facades retain their verified-network fallback');
  console.log('Quiz home tests passed: filtering/counts, reset confirmation/loading/success/failure, cached cloud scores and late-response protection, score visibility, empty library, and browser draft isolation.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
