const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { load, editResponse, draftKey, attemptUrl } = require('./helpers/quiz-harness.cjs');

// The DOM, browser storage and server are simulated. No real quiz draft,
// original paper, or submitted attempt is written by this test.
const folders = fs.readdirSync('.').filter(name => /^gate-cse-/.test(name) && fs.existsSync(path.join(name, 'quiz.js'))).sort();
const copy = value => JSON.parse(JSON.stringify(value));
const classes = node => node.className.split(/\s+/);
const posts = h => h.requests.filter(request => request.method === 'POST');
const current = h => h.ids['nav-groups'].querySelectorAll('.nav-question').filter(node => node.getAttribute('aria-current') === 'location').map(node => node.id);
const openingTag = (html, id) => {
  const tag = [...html.matchAll(/<[a-z][^>]*>/g)].find(match => new RegExp(`\\bid="${id}"`).test(match[0]));
  assert.ok(tag, `Missing ${id}`);
  return tag[0];
};
function snapshot(h) {
  return {
    cache: [...h.storage], requests: copy(h.requests), answers: copy(h.t.answers),
    review: [...h.t.reviewFlags], exclusions: [...h.t.outOfSyllabus],
    reportExclusions: [...h.t.reportOutOfSyllabus],
    signature: JSON.stringify({ questions: h.data.questions, scoring: h.data.scoring ?? null }),
    graded: copy(h.t.summarize(h.t.grade())), current: current(h),
    view: { practice: h.ids['quiz-form'].hidden, report: h.ids.report.hidden, timer: h.ids['quiz-timer'].hidden },
    timer: { value: h.ids['timer-display'].textContent, preset: h.ids['timer-duration'].value, startDisabled: h.ids['timer-start'].disabled, pauseDisabled: h.ids['timer-pause'].disabled },
    status: { text: h.ids['status-message'].textContent, hidden: h.ids['status-message'].hidden },
    reviewDisabled: h.ids['review-attempt'].disabled
  };
}
function assertPanel(h, open) {
  assert.equal(h.ids['rough-work-toggle'].hidden, false);
  assert.equal(h.ids['rough-work-panel'].hidden, !open);
  assert.equal(h.ids['rough-work-toggle'].getAttribute('aria-expanded'), String(open));
  assert.equal(h.ids['rough-work-toggle'].title, open ? 'Close rough work' : 'Open rough work');
  assert.equal(classes(h.document.querySelector('.quiz-shell')).includes('rough-work-open'), open);
  assert.equal(h.ids['question-nav'].hidden, false, 'Opening rough work must not change the map runtime availability');
}
async function toggleWithoutSideEffects(h, open) {
  const before = snapshot(h);
  await h.ids['rough-work-toggle'].click();
  assertPanel(h, open);
  assert.deepEqual(snapshot(h), before, 'Opening/closing rough work changes no quiz, timer, cache or server state');
}
async function closeWithoutSideEffects(h) {
  const before = snapshot(h);
  h.ids['rough-work-toggle'].focused = false;
  await h.ids['rough-work-close'].click();
  assertPanel(h, false);
  assert.equal(h.ids['rough-work-toggle'].focused, true, 'Close returns keyboard focus to the pen button');
  assert.deepEqual(snapshot(h), before);
}
async function escapeWithoutSideEffects(h) {
  const before = snapshot(h);
  h.ids['rough-work-toggle'].focused = false;
  let prevented = false;
  await h.ids['rough-work-panel'].fire('keydown', { key: 'Escape', target: h.ids['rough-work-surface'], preventDefault() { prevented = true; } });
  assertPanel(h, false);
  assert.equal(prevented, true);
  assert.equal(h.ids['rough-work-toggle'].focused, true);
  assert.deepEqual(snapshot(h), before, 'Escape restores the map without touching current practice');
}
const correct = question => question.type === 'nat' ? String(question.correctRanges[0].min) : question.type === 'msq' ? [...question.correctAnswers] : question.correctAnswer;

(async () => {
  for (const folder of ['_template', ...folders]) {
    const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
    for (const id of ['rough-work-toggle', 'rough-work-panel', 'rough-work-close', 'rough-work-surface', 'rough-work-canvas', 'rough-work-paper']) {
      assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, `${folder} has exactly one ${id}`);
    }
    const launcher = openingTag(html, 'rough-work-toggle');
    assert.match(launcher, /\btype="button"/);
    assert.match(launcher, /\baria-label="Rough work"/);
    assert.match(launcher, /\baria-expanded="false"/);
    assert.match(launcher, /\baria-controls="rough-work-panel"/);
    assert.match(launcher, /\btitle="Open rough work"/);
    assert.match(launcher, /\shidden(?:\s|>)/);
    assert.match(openingTag(html, 'rough-work-close'), /\btype="button"/);
    assert.match(openingTag(html, 'rough-work-panel'), /\shidden(?:\s|>)/);
    const surface = openingTag(html, 'rough-work-surface');
    assert.match(surface, /\brole="region"/);
    assert.match(surface, /\btabindex="0"/);
    assert.match(surface, /\baria-label="[^"]+"/);
    assert.match(openingTag(html, 'rough-work-canvas'), /<canvas\b/, 'The notebook supplies a dedicated drawing canvas');
    const launcherBody = html.slice(html.indexOf(launcher) + launcher.length, html.indexOf('</button>', html.indexOf(launcher)));
    assert.match(launcherBody, /<svg\b/);
    assert.match(launcherBody, /aria-hidden="true"/);
    assert.match(launcherBody, /focusable="false"/);

    const h = await load(folder);
    if (folder === '_template') {
      assert.equal(h.ids['rough-work-toggle'].hidden, true, 'The blank template has no active rough-work launcher');
      assert.equal(h.ids['rough-work-panel'].hidden, true);
      assert.equal(h.storage.size, 0);
      continue;
    }
    assert.equal(h.ids['rough-work-panel'].hidden, true);
    assert.equal(h.ids['rough-work-toggle'].hidden, false);
    await toggleWithoutSideEffects(h, true);
    assert.equal(h.ids['rough-work-surface'].focused, true, 'Open places keyboard focus in the work area');
    const beforeOtherKey = snapshot(h);
    await h.ids['rough-work-panel'].fire('keydown', { key: 'ArrowRight', target: h.ids['rough-work-surface'] });
    assertPanel(h, true); assert.deepEqual(snapshot(h), beforeOtherKey);
    await closeWithoutSideEffects(h);
    await toggleWithoutSideEffects(h, true);
    await escapeWithoutSideEffects(h);
    await toggleWithoutSideEffects(h, true);
    await toggleWithoutSideEffects(h, false);
    assert.equal(h.storage.size, 0, 'Using the panel alone never creates a draft');
    assert.equal(h.requests.length, 1, 'Only the existing opening saved-attempt check reads the server');

    const css = fs.readFileSync(path.join(folder, 'styles.css'), 'utf8');
    assert.equal(css, fs.readFileSync('_template/styles.css', 'utf8'), 'Shared workspace styles are synchronized');
    const print = css.slice(css.lastIndexOf('@media print'));
    assert.match(print, /rough-work-toggle/);
    assert.match(print, /rough-work-panel/);
    assert.match(print, /display:\s*none/);
  }

  // Keep a live, nonblank draft, numerical input, independent markers and a
  // running timer while exercising the panel. All state stays in memory.
  const operations = [];
  const h = await load('gate-cse-2021-set-1', { storageError: (operation, key) => { operations.push([operation, key]); return false; } });
  const first = h.data.questions[0], nat = h.data.questions.find(question => question.type === 'nat');
  const natIndex = h.data.questions.indexOf(nat);
  await editResponse(h, first.id, correct(first));
  await editResponse(h, nat.id, '-');
  await h.document.getElementById(`mark-review-${natIndex}`).click();
  await h.document.getElementById('out-of-syllabus-0').click();
  h.ids['timer-duration'].value = '30'; await h.ids['timer-duration'].fire('change');
  h.ctx.setInterval = () => 1; h.ctx.clearInterval = () => {};
  await h.ids['timer-start'].click();
  assert.equal(h.ids['timer-start'].disabled, true);
  assert.equal(h.ids['timer-pause'].disabled, false);
  const workingDraft = h.storage.get(draftKey(h));
  operations.length = 0;
  await toggleWithoutSideEffects(h, true);
  await escapeWithoutSideEffects(h);
  await toggleWithoutSideEffects(h, true);
  assert.deepEqual(operations, [], 'Panel controls alone perform no quiz storage reads or writes without notebook drawing');
  assert.equal(h.storage.get(draftKey(h)), workingDraft);
  assert.ok(h.ids['rough-work-canvas'], 'The drawing canvas exists outside rebuilt question controls');
  await h.ids['quiz-form'].fire('submit');
  assert.equal(h.ids.report.hidden, true, 'Invalid numerical input remains blocked normally');
  assertPanel(h, true);
  assert.equal(h.document.getElementById(`answer-${natIndex}`).value, '-');
  const beforeClear = h.ids['rough-work-surface'];
  await h.document.getElementById(`question-card-${natIndex}`).querySelector('.clear-response').click();
  assertPanel(h, true);
  assert.equal(h.ids['rough-work-surface'], beforeClear, 'Question rerendering leaves the work surface in place');
  await editResponse(h, nat.id, correct(nat));
  await h.ids['quiz-form'].fire('submit');
  assert.equal(h.ids.report.hidden, false); assertPanel(h, true);
  assert.equal(posts(h).length, 1);
  const saved = copy(h.server.get(attemptUrl(h)));
  assert.ok(!/rough[-_ ]?work/i.test(JSON.stringify(saved)), 'The workspace never enters the submitted data');
  assert.equal(h.storage.has(draftKey(h)), false);
  await closeWithoutSideEffects(h);
  await toggleWithoutSideEffects(h, true);
  assert.equal(h.storage.has(draftKey(h)), false, 'Report panel controls cannot recreate a cleared draft');
  await h.ids['retry-quiz'].click();
  assert.equal(h.ids.report.hidden, true); assertPanel(h, true);
  assert.deepEqual(current(h), ['nav-question-0']);
  await editResponse(h, first.id, first.options.find(option => option.id !== first.correctAnswer).id);
  await h.document.getElementById('nav-question-4').click();
  await h.document.getElementById('mark-review-4').click();
  const beforeReview = h.storage.get(draftKey(h));
  await h.ids['review-attempt'].click();
  assert.equal(h.ids.report.hidden, false); assertPanel(h, true);
  await closeWithoutSideEffects(h);
  await toggleWithoutSideEffects(h, true);
  await h.ids['retry-quiz'].click();
  assert.equal(h.ids.report.hidden, true); assertPanel(h, true);
  assert.deepEqual(current(h), ['nav-question-4']);
  assert.equal(h.storage.get(draftKey(h)), beforeReview);
  assert.deepEqual(h.server.get(attemptUrl(h)), saved, 'Review and panel controls leave the submitted attempt intact');
  await h.ids['clear-answers'].click();
  assertPanel(h, true); assert.deepEqual(current(h), ['nav-question-0']);
  const reloaded = await load('gate-cse-2021-set-1', { storage: h.storage, server: h.server });
  assert.equal(reloaded.ids['rough-work-panel'].hidden, true, 'Panel visibility is temporary UI state, outside the draft');

  const unavailable = await load('gate-cse-2018', { storageUnavailable: true });
  const warning = unavailable.ids['status-message'].textContent;
  await toggleWithoutSideEffects(unavailable, true);
  await closeWithoutSideEffects(unavailable);
  assert.equal(unavailable.ids['status-message'].textContent, warning, 'Unavailable-cache warnings survive workspace actions');
  assert.equal(unavailable.storage.size, 0);

  const mobile = await load('gate-cse-2018', { window: { matchMedia: () => ({ matches: true, addEventListener() {} }) } });
  await toggleWithoutSideEffects(mobile, true);
  assert.ok(mobile.ids['rough-work-panel'].scrolled || mobile.ids['rough-work-surface'].scrolled, 'The work surface is reachable when it stacks below a narrow test');
  await escapeWithoutSideEffects(mobile);

  console.log(`Rough-work checks passed: ${folders.length} quizzes, pen launcher, blank template, open/close/Escape/focus, unchanged answers/cache/flags/exclusions/timer/submissions, question rerenders, report/Review/Back/Retry, storage failure, mobile reachability and print suppression.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
