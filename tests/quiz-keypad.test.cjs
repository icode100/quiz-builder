const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { load, editResponse, draftKey, attemptUrl } = require('./helpers/quiz-harness.cjs');

// All answers, browser storage and HTTP writes are simulated. Real drafts,
// notebook/annotation pages, original paper files and attempts stay untouched.
const copy = value => JSON.parse(JSON.stringify(value));
const get = (h, id) => h.document.getElementById(id);
const card = (h, index) => get(h, `question-card-${index}`);
const input = (h, index) => get(h, `answer-${index}`);
const toggle = (h, index) => get(h, `numeric-keypad-toggle-${index}`);
const panel = (h, index) => get(h, `numeric-keypad-${index}`);
const key = (h, index, name) => panel(h, index).querySelectorAll('button').find(button => button.dataset.keypadKey === name);
const visible = node => Boolean(node && !node.hidden && (!node.parent || visible(node.parent)));
const posts = h => h.requests.filter(request => request.method === 'POST');
const selected = h => h.ids['nav-groups'].querySelectorAll('.nav-question').find(node => node.getAttribute('aria-current') === 'location')?.id;
const draft = h => { const saved = JSON.parse(h.storage.get(draftKey(h))); delete saved.updatedAt; return saved; };
function selection(node, start = node.value.length, end = start) { node.selectionStart = start; node.selectionEnd = end; }
async function enter(h, index, value, start = value.length, end = start) {
  await editResponse(h, h.data.questions[index].id, value); selection(input(h, index), start, end);
}
async function tap(h, index, name) {
  const button = key(h, index, name); assert.ok(button, `Missing ${name} key`);
  await button.click();
}
function independentState(h) {
  return { flags: [...h.t.reviewFlags], exclusions: [...h.t.outOfSyllabus], timer: draft(h).timer,
    current: selected(h), requests: copy(h.requests), signature: draft(h).signature,
    reviewDisabled: h.ids['review-attempt'].disabled,
    otherStorage: [...h.storage].filter(([storageKey]) => storageKey !== draftKey(h)) };
}

(async () => {
  const folders = fs.readdirSync('.').filter(name => /^gate-cse-/.test(name) && fs.existsSync(path.join(name, 'quiz.js'))).sort();
  const sharedRuntime = fs.readFileSync('_template/quiz.js', 'utf8'), sharedStyle = fs.readFileSync('_template/styles.css', 'utf8');
  for (const folder of ['_template', ...folders]) {
    assert.equal(fs.readFileSync(path.join(folder, 'quiz.js'), 'utf8'), sharedRuntime, `${folder} uses the shared number-pad runtime`);
    assert.equal(fs.readFileSync(path.join(folder, 'styles.css'), 'utf8'), sharedStyle, `${folder} uses the shared compact styles`);
    const h = await load(folder);
    const numeric = h.data.questions.filter(question => question.type === 'nat').length;
    assert.equal(h.ids.questions.querySelectorAll('.numeric-entry').length, numeric, `${folder} has one entry per numerical question`);
    assert.equal(h.ids.questions.querySelectorAll('.numeric-keypad').length, numeric);
    assert.equal(h.ids.questions.querySelectorAll('.numeric-keypad-toggle').length, numeric);
    h.data.questions.forEach((question, index) => {
      if (question.type !== 'nat') {
        assert.equal(card(h, index).querySelector('.numeric-entry'), null, 'MCQ/MSQ do not gain a numeric pad'); return;
      }
      const control = toggle(h, index), pad = panel(h, index);
      assert.equal(control.type, 'button'); assert.equal(control.getAttribute('aria-expanded'), 'false');
      assert.equal(control.getAttribute('aria-controls'), pad.id);
      assert.match(control.getAttribute('aria-label') || control.textContent, /number pad|numeric|numerical/i);
      assert.equal(pad.hidden, true, 'The compact pad starts closed and takes no permanent question space');
      const buttons = pad.querySelectorAll('button');
      assert.equal(buttons.length, 15, 'Digits, decimal, sign, deletion, clear and Done fit a four-by-four pad');
      assert.ok(buttons.every(button => button.type === 'button'), 'No pad control can submit the test');
      for (const name of ['0','1','2','3','4','5','6','7','8','9','decimal','sign','backspace','clear','done']) assert.ok(key(h, index, name), `${folder} supplies ${name}`);
    });
    if (!h.data.questions.length) assert.equal(h.storage.size, 0, 'Blank template never creates keypad state or drafts');
  }
  assert.match(sharedStyle, /\.numeric-keypad\s*\{[^}]*position:\s*absolute/s, 'The number pad overlays space instead of reducing the question area');
  assert.match(sharedStyle, /\.numeric-keypad[^}]*grid-template-columns:\s*repeat\(4,/s, 'The pad uses four compact columns');
  assert.match(sharedStyle, /\.numeric-keypad[^}]*min-height:\s*44px/s, 'Pen/tablet targets remain at least 44px high');
  assert.match(sharedStyle, /\.numeric-keypad[^}]*var\(--surface/s, 'The pad follows the existing theme');
  assert.match(sharedStyle, /@media screen and \(min-width:\s*901px\)\s*\{\s*:root:not\(\.screen-annotation-active\) \.quiz-shell:not\(\.rough-work-open\) \.numeric-keypad\s*\{[^}]*position:\s*fixed;[^}]*left:\s*auto;[^}]*top:\s*auto;[^}]*right:\s*1\.75rem;[^}]*bottom:\s*5rem;/s,
    'Desktop reuses the map sidebar only when both drawing workspaces are closed; mobile and drawing modes retain the compact input popover');

  const protectedRecords = [['practice-quiz:theme','dark'],['practice-quiz:keypad-sentinel:rough:CS-1','keep rough work'],['practice-quiz:keypad-sentinel:annotation:CS-1','keep annotations']];
  const h = await load('gate-cse-2025-set-1', { storage: protectedRecords });
  const natIndices = h.data.questions.map((question, index) => question.type === 'nat' ? index : -1).filter(index => index >= 0);
  const [index, another] = natIndices, id = h.data.questions[index].id;
  await get(h, `nav-question-${index}`).click();
  const beforeOpen = h.storage.get(draftKey(h)), beforeOpenRequests = copy(h.requests);
  await toggle(h, index).click();
  assert.equal(panel(h, index).hidden, false); assert.equal(toggle(h, index).getAttribute('aria-expanded'), 'true');
  assert.equal(input(h,index).inputMode,'none','The custom pad prevents a native mobile keyboard from taking more space');
  assert.equal(h.storage.get(draftKey(h)), beforeOpen, 'Opening the pad never changes the answer draft');
  assert.deepEqual(h.requests, beforeOpenRequests, 'Opening the pad never writes a submission');
  const unchanged = independentState(h);
  await tap(h, index, 'sign');
  assert.equal(input(h,index).value, '-'); assert.equal(h.t.answers[id], '-');
  assert.equal(input(h,index).getAttribute('aria-invalid'), 'true');
  assert.equal(draft(h).answers[id], '-', 'An unfinished minus caches exactly as typed input does');
  assert.deepEqual(independentState(h), unchanged, 'Pad input leaves flags, exclusions, timer, selection, note data and server state alone');
  await tap(h, index, '1'); await tap(h, index, '2'); await tap(h, index, 'decimal'); await tap(h, index, '5');
  assert.equal(input(h,index).value, '-12.5'); assert.equal(draft(h).answers[id], '-12.5');
  assert.equal(input(h,index).getAttribute('aria-invalid'), 'false');
  const beforeDot = h.storage.get(draftKey(h));
  await tap(h,index,'decimal');
  assert.equal(input(h,index).value, '-12.5'); assert.equal(h.storage.get(draftKey(h)), beforeDot, 'A second decimal is a no-op, including cache bytes');
  selection(input(h,index), 1, 3); await tap(h,index,'7');
  assert.equal(input(h,index).value, '-7.5', 'Digits replace a selected range');
  assert.deepEqual([input(h,index).selectionStart,input(h,index).selectionEnd], [2,2], 'The caret follows inserted ink-tablet digits');
  selection(input(h,index), 2, 3); await tap(h,index,'decimal');
  assert.equal(input(h,index).value, '-7.5', 'Selecting the current decimal permits replacing it');
  selection(input(h,index), 1); await tap(h,index,'9');
  assert.equal(input(h,index).value, '-97.5', 'Tablet taps insert at the existing caret');
  await tap(h,index,'backspace'); assert.equal(input(h,index).value,'-7.5');
  selection(input(h,index),1,3); await tap(h,index,'backspace'); assert.equal(input(h,index).value,'-5', 'Backspace deletes selected text');
  selection(input(h,index),0); const beforeBackspace = h.storage.get(draftKey(h)); await tap(h,index,'backspace');
  assert.equal(input(h,index).value,'-5'); assert.equal(h.storage.get(draftKey(h)),beforeBackspace,'Backspace at the beginning does not rewrite the draft');
  await tap(h,index,'sign'); assert.equal(input(h,index).value,'5'); await tap(h,index,'sign'); assert.equal(input(h,index).value,'-5');
  await enter(h,index,'+12'); await tap(h,index,'sign'); assert.equal(input(h,index).value,'-12', 'Sign toggle handles an existing typed plus');
  await enter(h,index,' -1 '); await tap(h,index,'sign'); assert.equal(input(h,index).value,' 1 ','Sign toggle preserves raw surrounding whitespace');
  await enter(h,index,' +12 '); await tap(h,index,'sign'); assert.equal(input(h,index).value,' -12 ','Sign toggle finds a plus after leading whitespace');

  await get(h,`mark-review-${index}`).click(); await get(h,`out-of-syllabus-${index}`).click();
  const beforeClear = independentState(h); await tap(h,index,'clear');
  assert.equal(input(h,index).value,''); assert.equal(Object.hasOwn(h.t.answers,id),false); assert.equal(input(h,index).getAttribute('aria-invalid'),'false');
  assert.deepEqual(independentState(h),beforeClear,'Keypad Clear removes only this response, preserving review and syllabus flags');
  await tap(h,index,'decimal'); await tap(h,index,'5'); assert.equal(input(h,index).value,'.5');
  assert.equal(input(h,index).getAttribute('aria-invalid'),'false');
  const beforeDone = h.storage.get(draftKey(h)); await tap(h,index,'done');
  assert.equal(panel(h,index).hidden,true); assert.equal(toggle(h,index).getAttribute('aria-expanded'),'false');
  assert.equal(input(h,index).inputMode,'decimal','Closing the custom pad restores normal numerical input behavior');
  assert.equal(h.storage.get(draftKey(h)),beforeDone,'Done changes only keypad visibility');
  await toggle(h,index).click();
  let escaped = false;
  await input(h,index).closest('.numeric-entry').fire('keydown',{target:key(h,index,'7'),key:'Escape',preventDefault(){escaped=true;}});
  assert.equal(escaped,true); assert.equal(panel(h,index).hidden,true); assert.equal(toggle(h,index).focused,true,'Escape returns focus to the number-pad toggle');

  await toggle(h,index).click(); await get(h,'nav-question-0').click();
  assert.equal(h.ids.questions.querySelectorAll('.numeric-keypad').filter(visible).length,0,'MCQ navigation hides every number pad');
  await get(h,`nav-question-${another}`).click();
  assert.equal(panel(h,another).hidden,false,'The in-session choice follows the next numerical question');
  assert.equal(input(h,another).value,'','Following a numerical question does not copy the previous response');
  assert.equal(panel(h,index).hidden,true,'Only the current numerical question can show an open pad');
  const beforeKeys = h.storage.get(draftKey(h));
  for (const shortcut of ['a','m','o','ArrowLeft','ArrowRight']) {
    await h.document.keydown({key:shortcut,target:key(h,another,'7'),preventDefault(){throw Error('Quiz shortcuts must not activate from the number pad');}});
  }
  assert.equal(h.storage.get(draftKey(h)),beforeKeys,'Pad focus keeps quiz letter/arrow shortcuts from editing or navigating');
  await get(h,`nav-question-${index}`).click(); await tap(h,index,'clear'); await tap(h,index,'sign');
  await h.ids['quiz-form'].fire('submit');
  assert.equal(posts(h).length,0,'An invalid unfinished minus still blocks Submit');
  assert.equal(h.ids.report.hidden,true); assert.equal(input(h,index).focused,true); assert.equal(draft(h).answers[id],'-');
  const restored = await load('gate-cse-2025-set-1',{storage:h.storage});
  assert.equal(input(restored,index).value,'-'); assert.equal(input(restored,index).getAttribute('aria-invalid'),'true');
  assert.equal(panel(restored,index).hidden,true,'Pad visibility is temporary; raw numerical answers restore');
  assert.equal(Object.keys(draft(restored)).some(name=>/keypad/i.test(name)),false,'Keypad presentation state never enters the draft');

  await tap(h,index,'clear'); await tap(h,index,'2');
  const cachedBeforeReport = h.storage.get(draftKey(h));
  await h.ids['quiz-form'].fire('submit');
  assert.equal(h.ids.report.hidden,false); assert.equal(h.ids.questions.querySelectorAll('.numeric-keypad').filter(visible).length,0,'Reports hide all practice number pads');
  const saved = h.server.get(attemptUrl(h)); assert.ok(saved); assert.equal(/keypad/i.test(JSON.stringify(saved)),false,'Submitted attempts have no keypad fields');
  const beforeStaleTap=copy(h.t.answers); await tap(h,index,'9'); assert.deepEqual(copy(h.t.answers),beforeStaleTap,'A stale report-side practice control cannot edit submitted answers');
  await h.ids['retry-quiz'].click(); assert.equal(h.ids.report.hidden,true);
  assert.equal(h.ids.questions.querySelectorAll('.numeric-keypad').filter(visible).length,0,'Retry begins at the first question');
  await get(h,`nav-question-${index}`).click();
  if (panel(h,index).hidden) await toggle(h,index).click();
  await enter(h,index,'3');
  const beforeReviewDraft = h.storage.get(draftKey(h));
  await h.ids['review-attempt'].click();
  assert.equal(h.ids.report.hidden,false);
  assert.equal(h.ids.questions.querySelectorAll('.numeric-keypad').filter(visible).length,0,'Saved Review hides numerical entry pads');
  await tap(h,index,'9');
  await h.ids['retry-quiz'].click();
  assert.equal(h.t.answers[id],'3','Back to quiz restores the current pen-tablet answer instead of Review data');
  assert.equal(panel(h,index).hidden,false,'Back to quiz restores the current numerical question and in-session keypad choice');
  assert.equal(h.storage.get(draftKey(h)),beforeReviewDraft,'Review and Back leave the numerical draft byte-identical');
  for (const [storageKey,bytes] of protectedRecords) assert.equal(h.storage.get(storageKey),bytes,'Notes and theme survive keypad use, Submit and Retry');
  assert.ok(cachedBeforeReport,'The ordinary draft remains available before Submit');

  const failing = await load('gate-cse-2025-set-1',{storageUnavailable:true});
  await get(failing,`nav-question-${index}`).click(); await toggle(failing,index).click(); await tap(failing,index,'7');
  assert.equal(failing.t.answers[id],'7'); assert.match(failing.ids['status-message'].textContent,/Could not cache/i,'Unavailable storage leaves pen-tablet input usable with the existing warning');

  let finishSave;
  const busy = await load('gate-cse-2025-set-1',{fetch(request,perform){
    if (request.method === 'POST') return new Promise(resolve => {finishSave=()=>resolve(perform());});
    return perform();
  }});
  await get(busy,`nav-question-${index}`).click(); await toggle(busy,index).click(); await tap(busy,index,'2');
  const ghost = key(busy,index,'9'), ghostToggle=toggle(busy,index);
  const pendingSave = busy.ids['quiz-form'].fire('submit');
  assert.equal(typeof finishSave,'function');
  const whileSaving = copy(busy.t.answers);
  assert.equal(panel(busy,index).hidden,true,'The pad hides while the submission save is in flight');
  assert.equal(ghost.disabled,true,'All pen-tablet controls share the existing busy disabled state');
  await ghost.click(); await ghostToggle.click();
  assert.deepEqual(copy(busy.t.answers),whileSaving,'Synthetic stale control events cannot edit a busy submission');
  assert.equal(panel(busy,index).hidden,true);
  finishSave(); await pendingSave;
  console.log(`Number-pad checks passed: ${folders.length} synchronized quizzes plus template, NAT-only compact controls, caret/selection edits, signs/decimals/backspace/clear, draft validation/reload, focus/navigation/report guards and unchanged flags, timers, annotations, notebook data and submissions.`);
})().catch(error => {console.error(error);process.exitCode=1;});
