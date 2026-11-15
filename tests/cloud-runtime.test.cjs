const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {load, createHarness, editResponse, draftKey} = require('./helpers/quiz-harness.cjs');
const root = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const protectedLegacy = [['practice-quiz:legacy-paper', '{"answers":{"Q1":"A"}}'], ['practice-quiz:theme', 'light'], ['unrelated-site-data', 'keep']];

function accountStore(initial = [], methods = {}) {
  const records = new Map(initial), operations = [], calls = [];
  const facade = {
    beginEdit(key) { calls.push(['beginEdit', key]); },
    endEdit(key) { calls.push(['endEdit', key]); },
    storage: {
      getItem(key) { operations.push(['get', key]); return records.get(key) ?? null; },
      setItem(key, value) { operations.push(['set', key, value]); records.set(key, String(value)); },
      removeItem(key) { operations.push(['remove', key]); records.delete(key); }
    },
    async getAttempt(quizId) { calls.push(['getAttempt', quizId]); return methods.getAttempt ? methods.getAttempt(quizId) : null; },
    async submitAttempt(quizId, attempt) { calls.push(['submitAttempt', quizId, copy(attempt)]); return methods.submitAttempt ? methods.submitAttempt(quizId, attempt) : copy(attempt); }
  };
  return {facade, records, operations, calls};
}
function windowEvents(facade) {
  const listeners = new Map();
  return { window: {QuizCloudSync: facade, addEventListener(name, listener) { const list = listeners.get(name) || []; list.push(listener); listeners.set(name, list); }},
    async emit(name, detail) { for (const listener of listeners.get(name) || []) await listener({detail}); await tick(); } };
}
function savedAttempt(h, answers = copy(h.t.answers)) {
  const base = h.t.attemptSnapshot(), now = '2026-11-15T01:00:00.000Z';
  return {...copy(base), submittedAt: now, updatedAt: now, answers: Object.fromEntries(h.data.questions.map(question => [question.id, answers[question.id] ?? null]))};
}
function writes(store) { return store.operations.filter(([name]) => name !== 'get'); }
function assertLegacy(h, expected = protectedLegacy) { assert.deepEqual([...h.storage], expected, 'Cloud runtime never changes the original browser storage'); assert.equal(h.requests.length, 0, 'Cloud mode never fetches or writes attempt.json'); }

// Reuse the existing synthetic canvas fixtures without executing their standalone suites.
// The one injection supplies the cloud facade before the real drawing controller starts.
function drawingFixture(name) {
  const filename = path.join(__dirname, name);
  let source = fs.readFileSync(filename, 'utf8');
  const marker = name.includes('notebook') ? '\n(async () => {' : '\n// Test cases follow';
  const boundary = source.indexOf(marker);
  assert.ok(boundary > 0, `Missing drawing-fixture boundary in ${name}`);
  source = source.slice(0, boundary);
  const assignment = name.includes('notebook') ? 'contextObject.window = contextObject;' : 'context.window = context;';
  assert.ok(source.includes(assignment));
  source = source.replace(assignment, assignment + (name.includes('notebook') ? '\n  contextObject.QuizCloudSync = options.cloud;' : '\n  context.QuizCloudSync = options.cloud;'));
  const module = {exports:{}};
  vm.runInNewContext(source + '\nmodule.exports = {harness, quizId, questions, key, record, stroke};', {require: createRequire(filename), module, __dirname, console, Buffer, process, setImmediate}, {filename});
  return module.exports;
}

(async () => {
  const folders = fs.readdirSync(root).filter(name => /^gate-cse-/.test(name) && fs.existsSync(path.join(root, name, 'quiz.js'))).sort();
  const template = fs.readFileSync(path.join(root, '_template/quiz.js'), 'utf8');
  for (const folder of folders) {
    assert.equal(fs.readFileSync(path.join(root, folder, 'quiz.js'), 'utf8'), template, `${folder} has the shared cloud-aware runtime`);
    for (const file of ['rough-work.js', 'question-annotation.js', 'theme.js']) assert.equal(fs.readFileSync(path.join(root, folder, file), 'utf8'), fs.readFileSync(path.join(root, '_template', file), 'utf8'));
  }

  const store = accountStore(), events = windowEvents(store.facade);
  const h = await load('gate-cse-2021-set-1', {storage: protectedLegacy, window: events.window, storageUnavailable: true});
  assert.equal(h.ids['review-attempt'].disabled, true);
  assert.equal(store.calls.filter(([name]) => name === 'getAttempt').length, 1, 'Startup checks only the authenticated attempt API');
  const first = h.data.questions.find(question => question.type !== 'nat'), nat = h.data.questions.find(question => question.type === 'nat');
  await editResponse(h, first.id, first.correctAnswer);
  await editResponse(h, nat.id, '-');
  const natIndex = h.data.questions.indexOf(nat);
  await h.document.getElementById(`mark-review-${natIndex}`).click();
  await h.document.getElementById(`out-of-syllabus-${natIndex}`).click();
  const draft = JSON.parse(store.records.get(draftKey(h)));
  assert.equal(draft.answers[nat.id], '-');
  assert.equal(draft.currentQuestionId, nat.id);
  assert.ok(draft.reviewFlags.includes(nat.id)); assert.ok(draft.outOfSyllabus.includes(nat.id));
  assertLegacy(h);
  const legacyWithOldDraft = [...protectedLegacy, [draftKey(h), '{"answers":{"old-device":"do not load"}}']];
  const restoredStore = accountStore([[draftKey(h), JSON.stringify(draft)]]);
  const restoredEvents = windowEvents(restoredStore.facade);
  const restored = await load('gate-cse-2021-set-1', {storage:legacyWithOldDraft, window:restoredEvents.window});
  assert.equal(restored.t.answers[nat.id], '-', 'Initial account hydration restores unfinished input from another device');
  assert.equal(restored.document.getElementById(`nav-question-${natIndex}`).getAttribute('aria-current'), 'location');
  assert.ok(restored.t.reviewFlags.has(nat.id)); assert.ok(restored.t.outOfSyllabus.has(nat.id));
  assertLegacy(restored, legacyWithOldDraft);
  assert.equal(restoredStore.records.get(draftKey(h)), JSON.stringify(draft), 'Opening another device does not rewrite the hydrated draft');
  await h.ids['quiz-form'].fire('submit');
  assert.equal(store.calls.some(([name]) => name === 'submitAttempt'), false, 'Invalid raw NAT blocks any cloud submission');
  assert.equal(store.records.get(draftKey(h)), JSON.stringify(draft));
  assertLegacy(h);

  // A remote snapshot updates controls and position without echoing writes back to the cloud.
  const remote = {...draft, answers:{[nat.id]:'12.5'}, reviewFlags:[], outOfSyllabus:[], currentQuestionId:nat.id, updatedAt:'2026-11-15T02:00:00.000Z'};
  const input = h.document.getElementById(`answer-${natIndex}`); input.focus(); input.setSelectionRange(1, 1);
  store.records.set(draftKey(h), JSON.stringify(remote));
  store.operations.length = 0;
  await events.emit('quiz-cloud-record', {key:draftKey(h), value:JSON.stringify(remote)});
  assert.equal(h.t.answers[nat.id], '12.5');
  assert.deepEqual([...h.t.reviewFlags], []); assert.deepEqual([...h.t.outOfSyllabus], []);
  assert.equal(h.document.getElementById(`nav-question-${natIndex}`).getAttribute('aria-current'), 'location');
  assert.equal(h.document.activeElement.id, input.id); assert.deepEqual([h.document.activeElement.selectionStart, h.document.activeElement.selectionEnd], [1,1]);
  assert.equal(writes(store).length, 0, 'Applying a remote draft does not cache or rewrite it');
  assertLegacy(h);
  const beforeMalformed = copy(h.t.answers);
  await events.emit('quiz-cloud-record', {key:draftKey(h), value:'{"signature":"wrong"}'});
  assert.deepEqual(copy(h.t.answers), beforeMalformed);
  assert.match(h.ids['status-message'].textContent, /could not be loaded/);
  assert.equal(writes(store).length, 0);
  store.records.delete(draftKey(h));
  await events.emit('quiz-cloud-record', {key:draftKey(h), value:null});
  assert.deepEqual(copy(h.t.answers), {});
  assert.equal(h.ids['timer-display'].textContent, '03:00:00');
  assert.equal(writes(store).length, 0, 'Remote draft deletion resets the visible practice without recreating an empty draft');
  assertLegacy(h);

  // Successful Submit must await the verified account save before deleting the draft.
  let confirmSave, captured;
  const pending = accountStore([], {submitAttempt(id, attempt) { captured = copy(attempt); return new Promise(resolve => { confirmSave = resolve; }); }});
  const pEvents = windowEvents(pending.facade);
  const p = await load('gate-cse-2021-set-1', {storage:protectedLegacy, window:pEvents.window});
  const question = p.data.questions[0];
  await editResponse(p, question.id, question.correctAnswer);
  await p.document.getElementById('mark-review-0').click();
  await p.document.getElementById('out-of-syllabus-1').click();
  const submission = p.ids['quiz-form'].fire('submit'); await tick();
  assert.equal(p.ids.report.hidden, false);
  assert.equal(p.ids['quiz-session'].disabled, true);
  assert.ok(pending.records.has(draftKey(p)), 'Draft remains until the server confirms saving');
  assert.ok(p.t.reviewFlags.has(question.id));
  assert.equal(pending.operations.some(([name,key]) => name === 'remove' && key === draftKey(p)), false);
  assert.equal(captured.quizId, p.data.id); assert.ok(captured.reviewFlags.includes(question.id));
  confirmSave({...captured, summary:{score:987654, percentage:999999}}); await submission;
  assert.equal(pending.records.has(draftKey(p)), false);
  assert.equal(p.ids['review-attempt'].disabled, false);
  assert.equal(p.t.reviewFlags.size, 0); assert.equal(p.t.outOfSyllabus.size, 0);
  assert.notEqual(p.ids['score-value'].textContent, '999999%', 'Displayed grading still comes from the verified question key');
  assertLegacy(p);

  // Failure keeps draft and flags while preserving the report and earlier review availability.
  let earlier;
  const failed = accountStore([], {getAttempt:() => earlier, submitAttempt:async () => {throw Error('Connection lost');}});
  const fEvents = windowEvents(failed.facade);
  const f = await load('gate-cse-2021-set-1', {storage:protectedLegacy, window:fEvents.window});
  await editResponse(f, f.data.questions[0].id, f.data.questions[0].correctAnswer);
  earlier = savedAttempt(f);
  await fEvents.emit('quiz-cloud-record', {key:`practice-quiz:${f.data.id}:attempt`, value:JSON.stringify(earlier)});
  assert.equal(f.ids['review-attempt'].disabled, false);
  await f.document.getElementById('mark-review-0').click();
  await f.ids['quiz-form'].fire('submit');
  assert.ok(failed.records.has(draftKey(f)));
  assert.ok(f.t.reviewFlags.has(f.data.questions[0].id));
  assert.equal(f.ids.report.hidden, false);
  assert.equal(f.ids['review-attempt'].disabled, false);
  assert.match(f.ids['status-message'].textContent, /account save is not confirmed.*draft is kept/);
  assertLegacy(f);

  // Saved Review fetches anew and Back restores account draft bytes, not a legacy local draft.
  await f.ids['retry-quiz'].click();
  await editResponse(f, nat.id, '8.5');
  const practiceBytes = failed.records.get(draftKey(f)), practiceAnswers = copy(f.t.answers);
  const beforeGets = failed.calls.filter(([name]) => name === 'getAttempt').length;
  await f.ids['review-attempt'].click();
  assert.equal(f.ids.report.hidden, false);
  assert.equal(failed.calls.filter(([name]) => name === 'getAttempt').length, beforeGets + 1);
  assert.equal(failed.records.get(draftKey(f)), practiceBytes);
  await fEvents.emit('quiz-cloud-record', {key:draftKey(f), value:null});
  assert.equal(failed.records.get(draftKey(f)), practiceBytes, 'Review does not replace the active practice draft');
  await f.ids['retry-quiz'].click();
  assert.deepEqual(copy(f.t.answers), practiceAnswers);
  assert.equal(failed.records.get(draftKey(f)), practiceBytes);
  assertLegacy(f);

  // Account outbox failures name account sync, never the unrelated legacy browser cache.
  const blocked = accountStore(), setAccount = blocked.facade.storage.setItem;
  blocked.facade.storage.setItem = (key, value) => { if (!key.endsWith(':probe')) throw Error('Account queue closed'); setAccount(key, value); };
  const b = await load('gate-cse-2021-set-1', {storage:protectedLegacy, window:windowEvents(blocked.facade).window});
  await editResponse(b, b.data.questions[0].id, b.data.questions[0].correctAnswer);
  assert.equal(b.ids['status-message'].textContent, 'Could not queue your progress for account sync. Keep this tab open to retain your answers.');
  await b.ids['clear-answers'].click();
  assert.match(b.ids['status-message'].textContent, /Could not queue.*account sync/);
  assertLegacy(b);

  const unreadable = accountStore(); unreadable.facade.storage.getItem = () => { throw Error('Account cache unavailable'); };
  const u = await load('gate-cse-2021-set-1', {storage:protectedLegacy, window:windowEvents(unreadable.facade).window});
  assert.equal(u.ids['status-message'].textContent, 'Account progress storage is unavailable. Keep this tab open to retain your answers.');
  assertLegacy(u);

  const cannotClear = accountStore(), removeAccount = cannotClear.facade.storage.removeItem;
  cannotClear.facade.storage.removeItem = key => { if (!key.endsWith(':probe')) throw Error('Queue closed'); removeAccount(key); };
  const c = await load('gate-cse-2021-set-1', {storage:protectedLegacy, window:windowEvents(cannotClear.facade).window});
  await editResponse(c, c.data.questions[0].id, c.data.questions[0].correctAnswer);
  await c.ids['quiz-form'].fire('submit');
  assert.match(c.ids['status-message'].textContent, /report is saved to your account.*draft could not be queued/);
  assert.ok(cannotClear.records.has(draftKey(c)), 'Failure to queue draft deletion retains the draft');
  assert.equal(c.ids['review-attempt'].disabled, false, 'A confirmed report remains reviewable despite a draft-removal queue failure');
  assertLegacy(c);

  // Both drawing controllers use account storage, and remote notes redraw without writes.
  for (const [filename, kind] of [['rough-work-notebook.test.cjs','rough'], ['quiz-annotation.test.cjs','annotation']]) {
    const fixture = drawingFixture(filename), cloud = accountStore();
    const note = fixture.record(fixture.questions[0].id);
    cloud.records.set(fixture.key(fixture.questions[0].id), JSON.stringify(note));
    const ink = fixture.harness({storage:protectedLegacy, cloud:cloud.facade});
    const statusId = kind === 'rough' ? 'rough-work-status' : 'annotation-status';
    if (kind === 'rough') { ink.notebook.show(fixture.questions[0].id); ink.flush(); ink.draw(); ink.flush(); }
    else { ink.ids['screen-annotation-toggle'].click(); ink.draw(); ink.flush(); }
    assert.match(ink.ids[statusId].textContent, /Autosave on.*Account sync status above/);
    assert.doesNotMatch(ink.ids[statusId].textContent, /Saved in this browser|All changes saved|Synced to your account/,
      `${kind} does not present queued storage as an acknowledged server save`);
    const stored = JSON.parse(cloud.records.get(fixture.key(fixture.questions[0].id)));
    assert.equal(kind === 'rough' ? stored.strokes.length : stored.parts['image-0'].length, 2, `${kind} edits persist in account storage`);
    assert.deepEqual(copy([...ink.storage]), protectedLegacy);
    assert.equal(ink.operations.some(([operation]) => operation !== 'get'), false, `${kind} never writes legacy browser notes`);
    const replacement = fixture.record(fixture.questions[0].id, kind === 'rough' ? [] : {});
    cloud.records.set(fixture.key(fixture.questions[0].id), JSON.stringify(replacement)); cloud.operations.length = 0;
    ink.windowEvent('quiz-cloud-record', {detail:{key:fixture.key(fixture.questions[0].id), value:JSON.stringify(replacement)}});
    assert.equal(writes(cloud).length, 0, `${kind} remote reload leaves note bytes unchanged`);
    if (kind === 'rough') assert.equal(ink.ids['rough-clear'].disabled, true);
    else assert.equal(ink.ids['annotation-clear'].disabled, true);
    assert.deepEqual(copy([...ink.storage]), protectedLegacy);
    const blockedCloud = accountStore();
    blockedCloud.facade.storage.setItem = () => { throw Error('Account queue unavailable'); };
    const blocked = fixture.harness({storage:protectedLegacy, cloud:blockedCloud.facade});
    if (kind === 'rough') { blocked.notebook.show(fixture.questions[0].id); blocked.draw(); blocked.flush(); }
    else { blocked.ids['screen-annotation-toggle'].click(); blocked.draw(); blocked.flush(); }
    assert.match(blocked.ids[statusId].textContent, /Could not queue.*account sync.*Keep this tab open/);
    assert.equal(blocked.ids[kind === 'rough' ? 'rough-undo' : 'annotation-undo'].disabled, false, 'Queue errors keep in-memory ink undoable');
    assert.deepEqual(copy([...blocked.storage]), protectedLegacy);
  }

  // Theme uses the same account facade and remote changes do not create echo writes.
  const themedStore = accountStore([['practice-quiz:theme','dark']]), themedEvents = windowEvents(themedStore.facade);
  const themed = await load('gate-cse-2021-set-1', {storage:protectedLegacy, window:themedEvents.window});
  const themeLabel = themed.document.createElement('span'); themeLabel.className='switch-label'; themed.ids['theme-toggle'].append(themeLabel);
  vm.runInContext(fs.readFileSync(path.join(root,'_template/theme.js'),'utf8'), themed.ctx);
  themed.document.DOMContentLoaded();
  assert.equal(themed.document.documentElement.dataset.theme, 'dark');
  await themed.ids['theme-toggle'].click();
  assert.equal(themedStore.records.get('practice-quiz:theme'), 'light');
  themedStore.records.set('practice-quiz:theme', 'dark'); themedStore.operations.length=0;
  await themedEvents.emit('quiz-cloud-record', {key:'practice-quiz:theme',value:'dark'});
  assert.equal(themed.document.documentElement.dataset.theme,'dark'); assert.equal(writes(themedStore).length,0);
  assertLegacy(themed);
  console.log(`Cloud runtime checks passed: ${folders.length} synchronized quizzes, account-only draft/notes/theme storage, verified attempt API, confirmed/failed submissions, live remote updates without echo writes and Review/Back isolation. No real data touched.`);
})().catch(error => {console.error(error); process.exitCode=1;});
