const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { load, editResponse, draftKey, attemptUrl } = require('./helpers/quiz-harness.cjs');

// This uses only the simulated DOM, localStorage and fetch server. Real paper
// data, image assets, browser drafts and submitted attempt files are untouched.
const card = (h, index) => h.document.getElementById(`question-card-${index}`);
const map = (h, index) => h.document.getElementById(`nav-question-${index}`);
const posts = h => h.requests.filter(request => request.method === 'POST');
const label = question => question.displayLabel || question.id;
const copy = value => JSON.parse(JSON.stringify(value));
const currentIndex = h => Number(h.ids['nav-groups'].querySelectorAll('.nav-question').find(node => node.getAttribute('aria-current') === 'location')?.id.replace('nav-question-', ''));
async function press(h, key, values = {}) {
  const event = { key, target: h.document.body, defaultPrevented: false, prevented: false, preventDefault() { this.defaultPrevented = true; this.prevented = true; }, ...values };
  await h.document.keydown?.(event);
  return event;
}
function draftState(h, ...omit) {
  const state = JSON.parse(h.storage.get(draftKey(h))); delete state.updatedAt;
  for (const field of omit) delete state[field];
  return state;
}
async function ignored(h, key, values = {}, reason = 'Native behavior retains the key') {
  const index = currentIndex(h), draft = h.storage.get(draftKey(h)), answers = JSON.stringify(h.t.answers), flags = [...h.t.reviewFlags], excluded = [...h.t.outOfSyllabus], requests = h.requests.length;
  const event = await press(h, key, values);
  assert.equal(event.prevented, false, reason);
  assert.equal(currentIndex(h), index, reason);
  assert.equal(h.storage.get(draftKey(h)), draft, `${reason}: draft bytes stay unchanged`);
  assert.equal(JSON.stringify(h.t.answers), answers, `${reason}: answers stay unchanged`);
  assert.deepEqual([...h.t.reviewFlags], flags); assert.deepEqual([...h.t.outOfSyllabus], excluded);
  assert.equal(h.requests.length, requests, `${reason}: no server request`);
}
function slide(h, index) {
  assert.deepEqual(h.ids.questions.querySelectorAll('fieldset').filter(node => !node.hidden).map(node => node.id), [`question-card-${index}`]);
  assert.deepEqual(h.ids['nav-groups'].querySelectorAll('.nav-question').filter(node => node.getAttribute('aria-current') === 'location').map(node => node.id), [`nav-question-${index}`]);
  assert.equal(h.ids['carousel-position'].textContent, `${label(h.data.questions[index])} · ${index + 1} of ${h.data.questions.length}`);
  assert.equal(h.ids['previous-question'].disabled, index === 0);
  assert.equal(h.ids['next-question'].disabled, index === h.data.questions.length - 1);
}

(async () => {
  const folders = fs.readdirSync('.').filter(name => /^gate-cse-/.test(name) && fs.existsSync(path.join(name, 'quiz.js'))).sort();
  for (const folder of ['_template', ...folders]) {
    const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
    for (const id of ['quiz-home', 'question-carousel', 'previous-question', 'carousel-position', 'next-question']) {
      assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, `${folder} has one ${id}`);
    }
    assert.match(html, /<a\b[^>]*id="quiz-home"[^>]*href="\/"/, `${folder} links to the server home`);
    for (const id of ['previous-question', 'next-question']) assert.match(html, new RegExp(`<button\\b[^>]*id="${id}"[^>]*type="button"`));
    assert.match(html, /<button\b[^>]*id="previous-question"[^>]*aria-keyshortcuts="ArrowLeft"/);
    assert.match(html, /<button\b[^>]*id="next-question"[^>]*aria-keyshortcuts="ArrowRight"/);
    assert.match(html, /<button\b[^>]*id="previous-question"[^>]*>← Previous<\/button>/);
    const h = await load(folder);
    assert.equal(h.ids['question-carousel'].hidden, folder === '_template');
    if (folder === '_template') {
      for (const key of ['ArrowLeft', 'ArrowRight', 'a', 'D', 'm', 'O']) assert.equal((await press(h, key)).prevented, false);
      assert.equal(h.storage.size, 0, 'Blank template shortcuts never create a draft');
      assert.equal(h.requests.length, 0);
      continue;
    }
    slide(h, 0);
    await ignored(h, 'ArrowLeft', {}, 'Left at the first question does not wrap or consume the key');
    assert.equal((await press(h, 'ArrowRight')).prevented, true); slide(h, 1);
    assert.equal(card(h, 1).focused, true); assert.equal(card(h, 1).scrolled, true, 'Keyboard jumps use the same focus/scroll path as buttons');
    assert.equal((await press(h, 'ArrowLeft')).prevented, true); slide(h, 0);
    assert.equal(h.ids['next-question'].textContent, 'Skip →');
    assert.equal(h.ids['next-question'].getAttribute('aria-label'), 'Skip question');
    await h.ids['previous-question'].click(); slide(h, 0);
    await h.ids['next-question'].click(); slide(h, 1);
    assert.equal(card(h, 1).scrolled, true, 'Skip scrolls to the question above the bottom navigation');
    assert.equal(card(h, 1).focused, true);
    assert.equal(Object.keys(h.t.answers).length, 0, 'Skip does not create an answer');
    await h.ids['previous-question'].click(); slide(h, 0);
    const last = h.data.questions.length - 1;
    await map(h, last).click(); slide(h, last);
    assert.equal(h.ids['next-question'].getAttribute('aria-label'), 'Last question');
    assert.equal(h.ids['next-question'].textContent, 'Last question');
    await h.ids['next-question'].click(); slide(h, last);
    await ignored(h, 'ArrowRight', {}, 'Right at the last question does not wrap or submit');
    let prevented = false;
    await h.ids.questions.fire('keydown', { key: 'Enter', target: card(h, last).querySelector('input'), preventDefault() { prevented = true; } });
    slide(h, last); assert.equal(prevented, true, 'Enter at the last question cannot implicitly submit');
    assert.equal(h.ids.report.hidden, true, 'Last never wraps or auto-submits');
    const navigationDraft = JSON.parse(h.storage.get(draftKey(h)));
    assert.equal(navigationDraft.currentQuestionId, h.data.questions[last].id, 'Pure navigation caches the last viewed question');
    assert.deepEqual(navigationDraft.answers, {}, 'Navigation does not invent answers');
    assert.equal(h.requests.length, 1, 'Pure navigation never adds a server request');
    const reopened = await load(folder, { storage: h.storage }); slide(reopened, last);
    assert.deepEqual(Object.keys(reopened.t.answers), [], 'A keyboard/map-only draft reopens at its last question without inventing responses');
    const numbers = h.ids['nav-groups'].querySelectorAll('.nav-number').map(node => node.textContent);
    assert.deepEqual(numbers, Array.from(h.data.questions, question => String(question.number ?? label(question))));
    const mcqIndex = h.data.questions.findIndex(question => question.type === 'mcq');
    await map(h, mcqIndex).click();
    const option = h.data.questions[mcqIndex].options[0];
    const activation = await press(h, option.id.toLowerCase());
    assert.equal(activation.prevented, true, `${folder}: a letter activates the current MCQ`);
    assert.equal(h.t.answers[h.data.questions[mcqIndex].id], option.id);
    assert.equal(card(h, mcqIndex).querySelectorAll('input').find(input => input.value === option.id).checked, true);
    slide(h, mcqIndex + 1);
    for (const input of card(h, mcqIndex).querySelectorAll('input')) assert.equal(input.getAttribute('aria-keyshortcuts'), input.value.toUpperCase());
    const flagIndex = mcqIndex + 1, flagId = h.data.questions[flagIndex].id, beforeFlags = draftState(h, 'reviewFlags', 'outOfSyllabus');
    assert.equal(h.document.getElementById(`mark-review-${flagIndex}`).getAttribute('aria-keyshortcuts'), 'M');
    assert.equal(h.document.getElementById(`out-of-syllabus-${flagIndex}`).getAttribute('aria-keyshortcuts'), 'O');
    for (const [key, set, style] of [['m', h.t.reviewFlags, 'marked-review'], ['o', h.t.outOfSyllabus, 'syllabus-excluded']]) {
      assert.equal((await press(h, key)).prevented, true); slide(h, flagIndex);
      assert.equal(set.has(flagId), true); assert.equal(map(h, flagIndex).className.split(' ').includes(style), true);
      assert.equal((await press(h, key.toUpperCase(), { shiftKey: true })).prevented, true); slide(h, flagIndex);
      assert.equal(set.has(flagId), false); assert.equal(map(h, flagIndex).className.split(' ').includes(style), false);
    }
    assert.deepEqual(draftState(h, 'reviewFlags', 'outOfSyllabus'), beforeFlags, `${folder}: flag shortcuts preserve responses, timer and position`);
    assert.equal(h.ids['review-attempt'].disabled, true, 'Keyboard flags never create submitted-attempt availability');
    assert.equal(posts(h).length, 0);
  }

  const h = await load('gate-cse-2021-set-1');
  const signature = JSON.stringify({ questions: h.data.questions, scoring: h.data.scoring ?? null });
  const first = h.data.questions[0];
  await editResponse(h, first.id, first.options[0].id); slide(h, 1);
  assert.equal(JSON.parse(h.storage.get(draftKey(h))).currentQuestionId, h.data.questions[1].id, 'MCQ auto-advance also caches the newly viewed question');
  assert.equal(card(h, 1).scrolled, true, 'MCQ auto-advance anchors the next question');
  assert.equal(h.t.answers[first.id], first.options[0].id, 'MCQ change saves before advancing');
  await h.ids['previous-question'].click(); slide(h, 0);
  assert.equal(h.ids['next-question'].getAttribute('aria-label'), 'Next question');
  assert.equal(h.ids['next-question'].textContent, 'Next →');
  assert.equal(card(h, 0).querySelector('input').checked, true);
  await h.document.getElementById('mark-review-0').click(); slide(h, 0);
  const draft = h.storage.get(draftKey(h));
  await h.ids['next-question'].click(); slide(h, 1);
  await h.ids['previous-question'].click(); slide(h, 0);
  const afterMoving = JSON.parse(h.storage.get(draftKey(h))), beforeMoving = JSON.parse(draft);
  delete afterMoving.updatedAt; delete beforeMoving.updatedAt;
  assert.deepEqual(afterMoving, beforeMoving, 'Returning to the same slide preserves answers, flags and timer');
  await card(h, 0).querySelector('.clear-response').click(); slide(h, 0);
  assert.equal(h.t.answers[first.id], undefined);
  assert.deepEqual([...h.t.reviewFlags], [first.id], 'Clear response retains the flag on the current slide');
  assert.equal(h.ids['next-question'].getAttribute('aria-label'), 'Skip question');
  assert.equal(h.ids['next-question'].textContent, 'Skip →');

  const msqIndex = h.data.questions.findIndex(question => question.type === 'msq');
  const msq = h.data.questions[msqIndex];
  await editResponse(h, msq.id, [msq.options[0].id]); slide(h, msqIndex);
  await editResponse(h, msq.id, msq.options.slice(0, 2).map(option => option.id)); slide(h, msqIndex);
  assert.equal(h.ids['next-question'].getAttribute('aria-label'), 'Next question', 'MSQ selection remains open for further choices');
  await h.ids.questions.fire('keydown', { key: 'Enter', target: card(h, msqIndex).querySelector('input') });
  slide(h, msqIndex + 1);
  const natIndex = h.data.questions.findIndex(question => question.type === 'nat');
  const nat = h.data.questions[natIndex];
  await editResponse(h, nat.id, '-'); slide(h, natIndex);
  await h.ids.questions.fire('keydown', { key: 'Enter', target: card(h, natIndex).querySelector('input') });
  slide(h, natIndex); assert.equal(posts(h).length, 0, 'Enter keeps an invalid NAT visible');
  await editResponse(h, nat.id, String(nat.correctRanges[0].min)); slide(h, natIndex);
  await h.ids.questions.fire('keydown', { key: 'Enter', target: card(h, natIndex).querySelector('input') });
  slide(h, natIndex + 1);
  await editResponse(h, nat.id, '-');
  await map(h, h.data.questions.length - 1).click();
  const invalidDraft = h.storage.get(draftKey(h));
  await h.ids['quiz-form'].fire('submit'); slide(h, natIndex);
  assert.equal(card(h, natIndex).querySelector('input').focused, true, 'Submit reveals and focuses a hidden invalid NAT');
  const invalidAfterSubmit = JSON.parse(h.storage.get(draftKey(h))), invalidBeforeSubmit = JSON.parse(invalidDraft);
  assert.equal(invalidAfterSubmit.currentQuestionId, nat.id, 'Revealing an invalid NAT caches its location');
  delete invalidAfterSubmit.currentQuestionId; delete invalidBeforeSubmit.currentQuestionId;
  delete invalidAfterSubmit.updatedAt; delete invalidBeforeSubmit.updatedAt;
  assert.deepEqual(invalidAfterSubmit, invalidBeforeSubmit, 'Invalid Submit preserves the unfinished responses, flags and timer');
  assert.equal(posts(h).length, 0);
  assert.equal(h.ids.report.hidden, true);

  const restored = await load('gate-cse-2021-set-1', { storage: h.storage });
  slide(restored, natIndex);
  assert.equal(restored.t.answers[nat.id], '-', 'Reload restores unfinished input at the last viewed slide');
  assert.deepEqual([...restored.t.reviewFlags], [first.id]);
  await h.ids['clear-answers'].click(); slide(h, 0);
  assert.equal(Object.keys(h.t.answers).length, 0);
  assert.deepEqual([...h.t.reviewFlags], []);
  await editResponse(h, first.id, first.options[0].id);
  await h.ids['quiz-form'].fire('submit');
  assert.equal(h.ids.report.hidden, false);
  assert.equal(h.ids['question-carousel'].hidden, true);
  assert.equal(posts(h).length, 1);
  const submitted = h.server.get(attemptUrl(h));
  assert.equal(submitted.quizSignature, signature);
  assert.equal(JSON.stringify(submitted).includes('currentQuestion'), false);
  assert.equal(h.storage.has(draftKey(h)), false);

  // Reviewing from an existing report preserves that report's map location.
  await map(h, 7).click();
  await h.ids['review-attempt'].click();
  await map(h, 8).click();
  await h.ids['retry-quiz'].click();
  assert.equal(h.ids.report.hidden, false);
  assert.equal(map(h, 7).getAttribute('aria-current'), 'location');
  await h.ids['retry-quiz'].click(); slide(h, 0);
  await editResponse(h, first.id, first.options[1].id);
  await map(h, 4).click();
  await h.document.getElementById('mark-review-4').click();
  h.ids['timer-duration'].value = '30'; await h.ids['timer-duration'].fire('change');
  const workingDraft = h.storage.get(draftKey(h));
  const savedBefore = JSON.stringify(submitted);
  await h.ids['review-attempt'].click();
  assert.equal(h.ids['question-carousel'].hidden, true);
  await map(h, 6).click();
  await h.ids['retry-quiz'].click(); slide(h, 4);
  assert.equal(h.ids['timer-duration'].value, '30');
  assert.equal(h.storage.get(draftKey(h)), workingDraft);
  assert.equal(JSON.stringify(h.server.get(attemptUrl(h))), savedBefore);
  assert.equal(posts(h).length, 1, 'Review, Back, Retry, flags and navigation never write a submission');
  assert.equal(JSON.stringify({ questions: h.data.questions, scoring: h.data.scoring ?? null }), signature);

  const notebookCalls = [];
  let selectedText = false;
  const keys = await load('gate-cse-2021-set-1', { window: {
    getSelection: () => ({ isCollapsed: !selectedText }),
    RoughWorkNotebook: { create() { return { show(id) { notebookCalls.push(id); }, hide() {} }; } }
  } });
  await keys.document.getElementById('mark-review-0').click();
  await keys.document.getElementById('out-of-syllabus-0').click();
  keys.ids['timer-duration'].value = '30'; await keys.ids['timer-duration'].fire('change');
  await keys.ids['rough-work-toggle'].click();
  const keyboardMetadata = draftState(keys, 'answers', 'currentQuestionId');
  for (const [index, letter] of ['a', 'B', 'c', 'D'].entries()) {
    assert.equal(keys.data.questions[index].type, 'mcq');
    const target = index % 2 ? card(keys, index).querySelector('input') : keys.document.body;
    assert.equal((await press(keys, letter, { target, shiftKey: letter === 'B' })).prevented, true);
    assert.equal(keys.t.answers[keys.data.questions[index].id], letter.toUpperCase(), 'A-D are case-insensitive and may act from the current native radio');
    slide(keys, index + 1);
    assert.equal(notebookCalls.at(-1), keys.data.questions[index + 1].id, 'MCQ keyboard advancement updates the open notebook page');
  }
  assert.deepEqual(draftState(keys, 'answers', 'currentQuestionId'), keyboardMetadata, 'Letter selection preserves flags, exclusions, timer and quiz identity');
  await map(keys, 0).click();
  const selectedRadioDraft = keys.storage.get(draftKey(keys));
  assert.equal((await press(keys, 'A', { target: card(keys, 0).querySelector('input') })).prevented, true);
  slide(keys, 0);
  assert.equal(keys.storage.get(draftKey(keys)), selectedRadioDraft, 'Clicking an already-selected MCQ via its key retains native no-change behavior without advancing');

  await editResponse(keys, keys.data.questions[natIndex].id, '-');
  const beforeArrow = draftState(keys, 'currentQuestionId');
  assert.equal((await press(keys, 'ArrowRight')).prevented, true); slide(keys, natIndex + 1);
  assert.deepEqual(draftState(keys, 'currentQuestionId'), beforeArrow, 'Arrow navigation changes only the draft question ID and timestamp');
  assert.equal(keys.t.answers[nat.id], '-', 'Arrows outside the numerical input retain its unfinished invalid text');
  assert.equal(notebookCalls.at(-1), keys.data.questions[natIndex + 1].id, 'Arrow navigation selects the matching rough-work page');
  assert.equal((await press(keys, 'ArrowLeft')).prevented, true); slide(keys, natIndex);
  const keyboardReopen = await load('gate-cse-2021-set-1', { storage: keys.storage }); slide(keyboardReopen, natIndex);
  assert.equal(keyboardReopen.t.answers[nat.id], '-');
  assert.deepEqual([...keyboardReopen.t.reviewFlags], [keys.data.questions[0].id]);
  assert.deepEqual([...keyboardReopen.t.outOfSyllabus], [keys.data.questions[0].id]);
  assert.equal(keyboardReopen.ids['timer-duration'].value, '30');
  for (const key of ['a', 'D', '1', '-']) await ignored(keys, key, {}, 'Numerical questions have no option-letter mapping');
  for (const key of ['ArrowLeft', 'ArrowRight', 'a', 'D']) await ignored(keys, key, { target: card(keys, natIndex).querySelector('input') }, 'Numerical input retains native typing and caret keys');
  assert.equal(card(keys, natIndex).querySelector('input').getAttribute('aria-invalid'), 'true', 'Shortcut guards leave numerical validation intact');

  await map(keys, 4).click();
  for (const values of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }]) {
    for (const key of ['ArrowRight', 'a', 'm', 'O']) await ignored(keys, key, values, 'Modified, repeated, composing or previously handled keys remain native');
  }
  await ignored(keys, 'ArrowRight', { shiftKey: true }, 'Shift+Arrow remains available for selection');
  for (const key of ['ArrowUp', 'ArrowDown', 'Enter', 'e', '1', '.']) await ignored(keys, key, {}, 'Unmapped keys remain native');
  selectedText = true;
  for (const key of ['ArrowLeft', 'ArrowRight', 'a', 'm', 'O']) await ignored(keys, key, {}, 'A noncollapsed text selection retains its keys');
  selectedText = false;
  const makeTarget = (tag, attrs = {}, parent = keys.document.body) => {
    const target = keys.document.createElement(tag); for (const [name, value] of Object.entries(attrs)) { target.setAttribute(name, value); if (name === 'id') target.id = value; } parent.append(target); return target;
  };
  const nativeTargets = [makeTarget('input'), makeTarget('textarea'), makeTarget('select')];
  const editable = makeTarget('span'); editable.isContentEditable = true; nativeTargets.push(editable);
  for (const value of ['', 'true', 'false']) nativeTargets.push(makeTarget('span', {}, makeTarget('div', { contenteditable: value })));
  for (const role of ['textbox', 'combobox', 'slider', 'spinbutton']) nativeTargets.push(makeTarget('span', {}, makeTarget('div', { role })));
  nativeTargets.push(makeTarget('span', {}, keys.ids['rough-work-panel']));
  nativeTargets.push(makeTarget('span', {}, makeTarget('section', { id: 'shared-calculator-panel' })));
  nativeTargets.push(card(keys, 0).querySelector('input'));
  for (const target of nativeTargets) for (const key of ['ArrowLeft', 'ArrowRight', 'a', 'm', 'O']) await ignored(keys, key, { target }, `Native focus retains ${key} on ${target.tagName} inside ${target.parent?.id || target.parent?.tagName}`);
  for (const key of ['ArrowLeft', 'ArrowRight']) await ignored(keys, key, { target: card(keys, 4).querySelector('input') }, 'Focused radio arrows retain native option navigation');
  const image = card(keys, 4).querySelector('.image-link');
  image.scrollWidth = 800; image.clientWidth = 400;
  for (const key of ['ArrowLeft', 'ArrowRight']) await ignored(keys, key, { target: image.querySelector('img') }, 'A horizontally overflowing question image retains arrow-key panning');
  image.scrollWidth = 400;
  assert.equal((await press(keys, 'ArrowRight', { target: image })).prevented, true); slide(keys, 5);
  await map(keys, 4).click(); image.scrollWidth = 800;
  assert.equal((await press(keys, 'a', { target: image })).prevented, true); slide(keys, 5);
  assert.equal(keys.t.answers[keys.data.questions[4].id], 'A', 'Image panning protection does not block option letters');
  keys.ids['quiz-form'].hidden = true;
  for (const key of ['ArrowRight', 'a', 'm', 'O']) await ignored(keys, key, {}, 'A hidden practice form ignores shortcuts');
  keys.ids['quiz-form'].hidden = false;

  await map(keys, msqIndex).click();
  const msqMetadata = draftState(keys, 'answers', 'currentQuestionId');
  const checkbox = card(keys, msqIndex).querySelector('input');
  for (const [letter, expected] of [['a', ['A']], ['B', ['A', 'B']], ['A', ['B']], ['b', []]]) {
    assert.equal((await press(keys, letter, { target: checkbox, shiftKey: letter === 'B' })).prevented, true);
    slide(keys, msqIndex);
    assert.deepEqual(copy(keys.t.answers[msq.id] || []), expected, 'MSQ letter keys independently toggle native checkboxes without auto-advance');
    assert.deepEqual(card(keys, msqIndex).querySelectorAll('input').filter(input => input.checked).map(input => input.value), expected);
  }
  assert.equal(Object.hasOwn(keys.t.answers, msq.id), false, 'Turning off the last selected MSQ option removes its response');
  assert.deepEqual(draftState(keys, 'answers', 'currentQuestionId'), msqMetadata, 'MSQ keyboard changes preserve nonanswer draft state');
  assert.equal(posts(keys).length, 0); assert.equal(JSON.stringify({ questions: keys.data.questions, scoring: keys.data.scoring ?? null }), signature);

  await editResponse(keys, msq.id, ['A']);
  // Track focus locally so programmatic flag-button clicks must leave the
  // focused response input and its caret untouched, including invalid NAT.
  for (const node of [keys.document.body, ...keys.document.body.querySelectorAll('*')]) {
    const focus = node.focus.bind(node);
    node.focus = (...args) => { focus(...args); keys.document.activeElement = node; };
  }
  const assertPracticeCounts = () => {
    const eligible = keys.data.questions.filter(question => !keys.t.outOfSyllabus.has(question.id));
    const answered = eligible.filter(question => Object.hasOwn(keys.t.answers, question.id)).length;
    assert.equal(keys.ids.progress.textContent, `${answered} of ${eligible.length} answered`, 'O immediately updates included-question answer counts');
    assert.equal(keys.ids['test-progress-bar'].value, eligible.length ? answered / eligible.length * 100 : 0);
    assert.equal(keys.ids['quiz-meta'].querySelector('.meta-item').textContent, `Maximum marks: ${eligible.reduce((sum, question) => sum + question.marks, 0)} · Valid questions: ${eligible.length} of ${keys.data.questions.length}`, 'O immediately updates eligible maximum marks and question metadata');
  };
  for (const index of [4, msqIndex, natIndex]) {
    await map(keys, index).click();
    const id = keys.data.questions[index].id, input = card(keys, index).querySelector('input');
    const beforeFlagState = draftState(keys, 'reviewFlags', 'outOfSyllabus'), availability = keys.ids['review-attempt'].disabled, notebookCount = notebookCalls.length;
    const originalProgress = keys.ids.progress.textContent;
    for (const [letter, set, field, buttonId, style] of [
      ['m', keys.t.reviewFlags, 'reviewFlags', 'mark-review', 'marked-review'],
      ['o', keys.t.outOfSyllabus, 'outOfSyllabus', 'out-of-syllabus', 'syllabus-excluded']
    ]) {
      assert.equal(set.has(id), false);
      for (const [key, target, enabled, shiftKey] of [
        [letter, keys.document.body, true, false], [letter.toUpperCase(), input, false, true],
        [letter, input, true, false], [letter.toUpperCase(), card(keys, index), false, true]
      ]) {
        target.focus(); input.selectionStart = 1; input.selectionEnd = 1;
        assert.equal((await press(keys, key, { target, shiftKey })).prevented, true); slide(keys, index);
        assert.equal(set.has(id), enabled, `${keys.data.questions[index].type}: ${letter.toUpperCase()} toggles in either direction without advancing`);
        assert.equal(keys.document.getElementById(`${buttonId}-${index}`).getAttribute('aria-pressed'), String(enabled));
        assert.equal(map(keys, index).className.split(' ').includes(style), enabled, 'Question-map flags follow keyboard changes');
        assert.equal(JSON.parse(keys.storage.get(draftKey(keys)))[field].includes(id), enabled, 'Each flag state is cached immediately');
        assert.deepEqual(draftState(keys, 'reviewFlags', 'outOfSyllabus'), beforeFlagState, 'M/O preserve responses, raw invalid NAT, timer, current position and signature');
        assert.equal(keys.document.activeElement, target, 'Flag shortcuts do not move focus, including from the current response input');
        assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 1], 'Flag shortcuts retain the numerical caret');
        assert.equal(keys.ids['review-attempt'].disabled, availability, 'Flags do not change submitted-attempt availability');
        assertPracticeCounts();
        if (letter === 'm') assert.equal(keys.ids.progress.textContent, originalProgress, 'M does not count as an answer or alter progress');
        if (index === natIndex && target === input) {
          const repeatDraft = keys.storage.get(draftKey(keys));
          assert.equal((await press(keys, key, { target: input, shiftKey, repeat: true })).prevented, true, 'Holding M/O in numerical input consumes repeats without typing letters');
          assert.equal(set.has(id), enabled, 'A repeated numerical flag key does not toggle again');
          assert.equal(keys.storage.get(draftKey(keys)), repeatDraft, 'A repeated numerical flag key leaves the cached draft unchanged');
          assert.equal(input.value, '-'); assert.equal(keys.t.answers[id], '-');
          assert.equal(keys.document.activeElement, input); assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 1]);
          slide(keys, index);
        }
      }
    }
    assert.equal(notebookCalls.length, notebookCount, 'M/O leave the current notebook page unchanged');
    assert.equal(keys.ids.progress.textContent, originalProgress);
  }
  assert.equal(keys.t.answers[nat.id], '-');
  assert.equal(card(keys, natIndex).querySelector('input').value, '-');
  assert.equal(card(keys, natIndex).querySelector('input').getAttribute('aria-invalid'), 'true');
  assert.equal(posts(keys).length, 0);

  const shortData = copy(keys.data); shortData.questions = [{ ...copy(first), options: copy(first.options.slice(0, 2)), correctAnswer: 'A' }];
  const short = await load('gate-cse-2021-set-1', { data: shortData });
  await ignored(short, 'd', {}, 'A letter absent from the actual option list remains native');
  assert.equal((await press(short, 'a')).prevented, true); slide(short, 0);
  assert.equal(short.t.answers[first.id], 'A'); assert.equal(posts(short).length, 0);
  assert.equal(short.ids.report.hidden, true, 'Answering the last question by key never submits or wraps');
  await short.ids['quiz-form'].fire('submit');
  for (const key of ['ArrowLeft', 'ArrowRight', 'a', 'D', 'm', 'O']) await ignored(short, key, {}, 'A submitted report ignores practice shortcuts');

  let holdReview = false, finishReview;
  const busy = await load('gate-cse-2021-set-1', {
    server: new Map([[attemptUrl(h), copy(submitted)]]),
    fetch: (request, perform) => holdReview && request.method === 'GET' ? new Promise(resolve => { finishReview = () => resolve(perform()); }) : perform()
  });
  await map(busy, 4).click(); holdReview = true;
  const openingReview = busy.ids['review-attempt'].click();
  assert.equal(typeof finishReview, 'function');
  assert.equal(busy.ids['quiz-form'].hidden, false, 'The busy Review fetch is tested while practice remains visible');
  for (const key of ['ArrowLeft', 'ArrowRight', 'a', 'm', 'O']) await ignored(busy, key, {}, 'An in-flight server read ignores keyboard actions');
  finishReview(); await openingReview;
  await map(busy, 6).click();
  for (const key of ['ArrowLeft', 'ArrowRight', 'b', 'm', 'O']) await ignored(busy, key, {}, 'Saved Review ignores practice shortcuts');
  await busy.ids['retry-quiz'].click(); slide(busy, 4);
  assert.equal((await press(busy, 'ArrowRight')).prevented, true); slide(busy, 5);
  const priorSavedAttempt = JSON.stringify(busy.server.get(attemptUrl(busy)));
  assert.equal(busy.ids['review-attempt'].disabled, false);
  for (const key of ['m', 'M', 'o', 'O']) {
    assert.equal((await press(busy, key)).prevented, true); slide(busy, 5);
    assert.equal(busy.ids['review-attempt'].disabled, false, 'M/O keep an existing submitted attempt available');
  }
  assert.equal(JSON.stringify(busy.server.get(attemptUrl(busy))), priorSavedAttempt, 'Keyboard flags never replace the saved submission');
  assert.equal(posts(busy).length, 0, 'Busy/Review/Back keyboard checks never save an attempt');

  console.log(`Carousel checks passed: ${folders.length} quizzes, Left/Right navigation, A-D MCQ/MSQ shortcuts, M/O review/syllabus toggles on every question type including focused invalid NAT, native focus/modifier/selection/image-pan guards, keyboard draft reopen and notebook sync, original map numbering, MCQ-only advance, bounds, flags/cache/timer preservation, invalid NAT, busy/reports, Review/Back, Retry and Home links.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
