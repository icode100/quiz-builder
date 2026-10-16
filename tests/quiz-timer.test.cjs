const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Reuse only the existing simulated DOM/storage harness, before its test runner.
// This suite uses a deterministic clock and never writes a real attempt.json.
const harnessFile = path.join(__dirname, 'quiz-runtime.test.cjs');
let harnessSource = fs.readFileSync(harnessFile, 'utf8');
const runner = '\n(async () => {';
assert(harnessSource.includes(runner), 'Runtime harness boundary must remain explicit');
harnessSource = harnessSource.slice(0, harnessSource.indexOf(runner));
const clockMarker = 'fetch, console, Blob, URL, setTimeout() {}';
assert(harnessSource.includes(clockMarker), 'Runtime harness clock injection point is missing');
harnessSource = harnessSource.replace(clockMarker,
  'fetch, console, Blob, URL, Date: options.clock.Date, setInterval: options.clock.setInterval, clearInterval: options.clock.clearInterval, setTimeout() {}');
const harness = new Function('require', `${harnessSource}\nreturn { load, editResponse, reviewButton, draftKey, attemptUrl, postRequests };`)(require);

function createClock(at = Date.UTC(2026, 9, 16, 9)) {
  let now = at, nextId = 0;
  const intervals = new Map();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  return {
    Date: ClockDate,
    setInterval: (callback, delay) => { const id = ++nextId; intervals.set(id, { callback, delay }); return id; },
    clearInterval: id => intervals.delete(id),
    advance: (ms, tick = true) => {
      now += ms;
      // Deliberately execute one tick, including after long background periods.
      // Correct countdowns derive elapsed time from the deadline, not tick count.
      if (tick) [...intervals.values()].forEach(({ callback }) => callback());
    },
    now: () => now,
    intervalCount: () => intervals.size
  };
}

async function load(folder = 'gate-cse-2018', options = {}) {
  const clock = options.clock || createClock();
  const h = await harness.load(folder, {
    ...options, clock,
    window: { setInterval: clock.setInterval, clearInterval: clock.clearInterval, ...(options.window || {}) }
  });
  return { ...h, clock };
}
const draftKey = harness.draftKey;
const cache = h => JSON.parse(h.storage.get(draftKey(h)));
const minutes = value => value * 60 * 1000;
function remaining(h) {
  const fields = h.ids['timer-display'].textContent.trim().split(':').map(Number);
  assert(fields.length >= 2 && fields.length <= 3 && fields.every(Number.isFinite), 'Timer uses a readable clock display');
  return fields.reduce((total, field) => total * 60 + field, 0) * 1000;
}
function assertRemaining(h, expected) {
  assert.equal(remaining(h), Math.ceil(expected / 1000) * 1000, `Countdown should show ${expected} ms remaining`);
}
async function choose(h, duration) {
  h.ids['timer-duration'].value = String(duration);
  await h.ids['timer-duration'].fire('change');
}
function assertStopped(h) {
  assert.equal(h.clock.intervalCount(), 0, 'A paused or reset timer has no active interval');
  assert.equal(h.ids['timer-pause'].disabled, true);
  assert.equal(h.ids['timer-start'].disabled, remaining(h) === 0, 'An expired timer can be reset before starting again');
}
function draftWith(h, timer) {
  return JSON.stringify({
    signature: JSON.stringify({ questions: h.data.questions, scoring: h.data.scoring ?? null }),
    answers: { 'GA-1': h.data.questions[0].options[0].id, 'CS-15': '-' },
    reviewFlags: ['GA-1'], updatedAt: new h.clock.Date().toISOString(),
    ...(timer === undefined ? {} : { timer })
  });
}

(async () => {
  const folders = fs.readdirSync('.').filter(name => /^gate-cse-/.test(name) && fs.existsSync(path.join(name, 'quiz.js'))).sort();
  assert(folders.length >= 6, 'Every existing paper must be included');
  const timerIds = ['quiz-timer', 'timer-duration', 'timer-display', 'timer-status', 'timer-start', 'timer-pause', 'timer-reset'];
  for (const folder of ['_template', ...folders]) {
    const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
    for (const id of timerIds) assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, `${folder} supplies ${id} once`);
    const select = html.match(/<select\b[^>]*id="timer-duration"[^>]*>([\s\S]*?)<\/select>/);
    assert(select, `${folder} uses a fixed select for timer duration`);
    assert.deepEqual([...select[1].matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(match => Number(match[1])), [180, 150, 120, 90, 60, 30]);
    assert(html.indexOf('id="quiz-timer"') < html.indexOf('id="quiz-form"'), 'Timer is outside the answer form');
    for (const id of ['timer-start', 'timer-pause', 'timer-reset']) {
      const tag = html.match(new RegExp(`<button\\b[^>]*id="${id}"[^>]*>`));
      assert(tag && /type="button"/.test(tag[0]), `${id} cannot accidentally submit the quiz`);
    }
    const css = fs.readFileSync(path.join(folder, 'styles.css'), 'utf8');
    assert(css.slice(css.indexOf('@media print')).includes('.quiz-timer'), 'Printed reports hide timer controls');
    const h = await load(folder);
    assert.equal(h.ids['quiz-timer'].hidden, folder === '_template', 'Only actual quizzes show a timer');
    if (folder !== '_template') {
      assertRemaining(h, minutes(180)); assertStopped(h);
      await choose(h, 30); await h.ids['timer-start'].click(); h.clock.advance(2000);
      assertRemaining(h, minutes(30) - 2000);
      await h.ids['timer-reset'].click(); assertRemaining(h, minutes(30)); assertStopped(h);
    }
  }

  const h = await load(), originalSignature = JSON.stringify(h.data);
  for (const duration of [180, 150, 120, 90, 60, 30]) {
    await choose(h, duration); assertRemaining(h, minutes(duration)); assertStopped(h);
  }
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 0, 'Timer controls never write submitted attempts');
  await h.ids['timer-start'].click();
  const running = cache(h).timer;
  assert.deepEqual(running, { durationMinutes: 30, remainingMs: minutes(30), endsAt: h.clock.now() + minutes(30) });
  assert.equal(h.clock.intervalCount(), 1);
  await h.ids['timer-start'].click(); assert.equal(h.clock.intervalCount(), 1, 'Repeated Start cannot create competing intervals');
  h.clock.advance(75_250); assertRemaining(h, minutes(30) - 75_250);
  await h.ids['timer-pause'].click(); assertStopped(h);
  assert.equal(cache(h).timer.endsAt, null);
  assert.equal(cache(h).timer.remainingMs, minutes(30) - 75_250);
  h.clock.advance(minutes(90)); assertRemaining(h, minutes(30) - 75_250);
  await h.ids['timer-start'].click(); h.clock.advance(12_750);
  assertRemaining(h, minutes(30) - 88_000);
  await choose(h, 60); assertStopped(h); assertRemaining(h, minutes(60));
  assert.equal(cache(h).timer.durationMinutes, 60);
  assert.equal(cache(h).timer.endsAt, null, 'Changing the preset resets into a paused timer');
  await h.ids['timer-start'].click();
  await harness.editResponse(h, 'GA-1', 'A'); await harness.reviewButton(h, 'GA-1').click();
  h.clock.advance(10_000);
  await h.ids['clear-answers'].click();
  assert.equal(h.clock.intervalCount(), 1); assertRemaining(h, minutes(60) - 10_000);
  assert.deepEqual(cache(h).reviewFlags, []); assert.deepEqual(cache(h).answers, {});
  assert.equal(JSON.stringify(h.data), originalSignature, 'Timer state never changes paper data or answer-key signatures');

  // Running clocks account for time outside the page; paused clocks do not.
  const runningClock = createClock(), runningPage = await load('gate-cse-2018', { clock: runningClock });
  await choose(runningPage, 30); await runningPage.ids['timer-start'].click();
  const snapshot = runningPage.storage.get(draftKey(runningPage));
  runningClock.advance(94_000, false);
  const reopened = await load('gate-cse-2018', { clock: createClock(runningClock.now()), storage: [[draftKey(runningPage), snapshot]] });
  assertRemaining(reopened, minutes(30) - 94_000); assert.equal(reopened.clock.intervalCount(), 1);
  await reopened.ids['timer-pause'].click();
  const pausedSnapshot = reopened.storage.get(draftKey(reopened));
  const paused = await load('gate-cse-2018', { clock: createClock(reopened.clock.now() + minutes(240)), storage: [[draftKey(reopened), pausedSnapshot]] });
  assertRemaining(paused, minutes(30) - 94_000); assertStopped(paused);

  // A malformed optional timer cannot discard valid answers, raw NAT input or flags.
  const seed = await load();
  const malformed = [null, [], {},
    { durationMinutes: 45, remainingMs: minutes(45), endsAt: null },
    { durationMinutes: '30', remainingMs: minutes(30), endsAt: null },
    { durationMinutes: 30, remainingMs: -1, endsAt: null },
    { durationMinutes: 30, remainingMs: minutes(30) + 1, endsAt: null },
    { durationMinutes: 30, remainingMs: '1000', endsAt: null },
    { durationMinutes: 30, remainingMs: 1000, endsAt: 'tomorrow' },
    { durationMinutes: 30, remainingMs: 1000, endsAt: -1 }
  ];
  for (const timer of [undefined, ...malformed]) {
    const restored = await load('gate-cse-2018', { storage: [[draftKey(seed), draftWith(seed, timer)]] });
    assert.equal(restored.t.answers['GA-1'], 'A'); assert.equal(restored.t.answers['CS-15'], '-');
    assert.deepEqual([...restored.t.reviewFlags], ['GA-1']);
    assertRemaining(restored, minutes(180)); assertStopped(restored);
    assert.equal(restored.ids['quiz-form'].hidden, false);
  }
  const expired = await load('gate-cse-2018', {
    clock: createClock(seed.clock.now() + 5000),
    storage: [[draftKey(seed), draftWith(seed, { durationMinutes: 30, remainingMs: 2000, endsAt: seed.clock.now() + 2000 })]]
  });
  assertRemaining(expired, 0); assertStopped(expired);
  assert(/time|finished|expired|complete/i.test(expired.ids['timer-status'].textContent));
  assert.equal(expired.ids['quiz-form'].hidden, false, 'Expiration does not auto-submit');
  assert(expired.ids['quiz-form'].querySelectorAll('input, button').every(node => !node.disabled), 'Expiration leaves answers editable');
  assert.equal(harness.postRequests(expired).length, 0);

  // Clicking Submit resets even when invalid NAT input blocks grading.
  const invalid = await load();
  await choose(invalid, 90); await invalid.ids['timer-start'].click(); invalid.clock.advance(3000);
  await harness.editResponse(invalid, 'CS-15', '-'); await harness.reviewButton(invalid, 'GA-1').click();
  await invalid.ids['quiz-form'].fire('submit');
  assertStopped(invalid); assertRemaining(invalid, minutes(90));
  assert.equal(invalid.t.answers['CS-15'], '-'); assert.deepEqual([...invalid.t.reviewFlags], ['GA-1']);
  assert.equal(cache(invalid).timer.remainingMs, minutes(90)); assert.equal(cache(invalid).timer.endsAt, null);
  assert.equal(invalid.ids.report.hidden, true); assert.equal(harness.postRequests(invalid).length, 0);
  assert.equal(invalid.document.getElementById('answer-24').focused, true, 'Invalid NAT remains focused after resetting the timer');

  const submitted = await load();
  await choose(submitted, 120); await submitted.ids['timer-start'].click(); submitted.clock.advance(9000);
  await harness.editResponse(submitted, 'GA-1', 'A');
  await submitted.ids['quiz-form'].fire('submit');
  assertStopped(submitted); assertRemaining(submitted, minutes(120));
  assert.equal(submitted.ids['quiz-timer'].hidden, true, 'Reports hide the timer');
  const post = harness.postRequests(submitted)[0], saved = JSON.parse(post.body);
  assert(!Object.hasOwn(saved, 'timer'), 'Submitted attempts contain no timer state');
  assert.equal(saved.quizSignature, JSON.stringify({ questions: submitted.data.questions, scoring: submitted.data.scoring ?? null }));
  assert.equal(submitted.storage.has(draftKey(submitted)), false, 'Successful Submit still clears the browser draft');
  await submitted.ids['retry-quiz'].click();
  assert.equal(submitted.ids['quiz-timer'].hidden, false); assertStopped(submitted); assertRemaining(submitted, minutes(120));
  assert.equal(harness.postRequests(submitted).length, 1, 'Retry cannot overwrite the saved attempt');

  const failed = await load('gate-cse-2018', { fetch: (request, perform, response) => request.method === 'POST' ? response(503, {}) : perform() });
  await choose(failed, 150); await failed.ids['timer-start'].click(); failed.clock.advance(4000);
  await harness.editResponse(failed, 'GA-1', 'A'); await harness.reviewButton(failed, 'GA-1').click();
  await failed.ids['quiz-form'].fire('submit');
  assertStopped(failed); assertRemaining(failed, minutes(150));
  assert.equal(cache(failed).answers['GA-1'], 'A'); assert.deepEqual(cache(failed).reviewFlags, ['GA-1']);
  assert.equal(cache(failed).timer.endsAt, null); assert.equal(cache(failed).timer.remainingMs, minutes(150));

  // Reviewing a saved record never caches its responses over a running draft,
  // including when the hidden timer reaches zero during review.
  const review = await load('gate-cse-2018', { server: [[harness.attemptUrl(submitted), saved]] });
  await harness.editResponse(review, 'GA-1', 'B'); await harness.reviewButton(review, 'GA-1').click();
  await choose(review, 30); await review.ids['timer-start'].click();
  const draftBeforeReview = review.storage.get(draftKey(review));
  await review.ids['review-attempt'].click();
  assert.equal(review.ids['quiz-timer'].hidden, true); assert.equal(review.ids['retry-quiz'].textContent, 'Back to quiz');
  review.clock.advance(minutes(31)); assertRemaining(review, 0); assertStopped(review);
  assert.equal(review.storage.get(draftKey(review)), draftBeforeReview, 'Hidden expiry performs no draft write during saved-report review');
  assert.equal(harness.postRequests(review).length, 0);
  await review.ids['retry-quiz'].click();
  assert.equal(review.ids['quiz-timer'].hidden, false); assertRemaining(review, 0);
  assert.equal(review.t.answers['GA-1'], 'B'); assert.deepEqual([...review.t.reviewFlags], ['GA-1']);

  const unavailable = await load('gate-cse-2018', { storageUnavailable: true });
  await choose(unavailable, 30); await unavailable.ids['timer-start'].click(); unavailable.clock.advance(2500);
  assertRemaining(unavailable, minutes(30) - 2500);
  await unavailable.ids['timer-pause'].click(); await unavailable.ids['timer-reset'].click();
  assertStopped(unavailable); assertRemaining(unavailable, minutes(30));
  await harness.editResponse(unavailable, 'GA-1', 'A'); await unavailable.ids['quiz-form'].fire('submit');
  assert.equal(harness.postRequests(unavailable).length, 1, 'Unavailable cache does not prevent grading or saving');

  console.log(`Timer checks passed: ${folders.length} quizzes, six presets, accurate elapsed time, reload, draft validation, Submit, review and unavailable storage.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
