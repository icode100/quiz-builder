const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, editResponse, draftKey, attemptUrl } = require('./helpers/quiz-harness.cjs');

// Fetch and browser storage remain in memory. These checks never submit to the
// workspace server or alter the user's saved attempts.
const root = path.resolve(__dirname, '..');
const folders = fs.readdirSync(root).filter(folder => /^gate-cse-/.test(folder) && fs.existsSync(path.join(root, folder, 'quiz.js'))).sort();
const indexOf = (h, id) => h.data.questions.findIndex(question => question.id === id);
const nav = (h, id) => h.document.getElementById(`nav-question-${indexOf(h, id)}`);
const flag = (h, id) => h.document.getElementById(`mark-review-${indexOf(h, id)}`);
const hasClass = (element, name) => element.className.split(' ').includes(name);
const markedIds = h => Array.from(h.data.questions).filter(question => hasClass(nav(h, question.id), 'marked-review')).map(question => question.id);
const correct = question => question.type === 'nat' ? String(question.correctRanges[0].min) : question.type === 'msq' ? [...question.correctAnswers] : question.correctAnswer;
const wrong = question => question.type === 'nat' ? String(Math.max(...question.correctRanges.map(range => range.max)) + 10) : question.type === 'msq' ? question.options.map(option => option.id).filter(id => !question.correctAnswers.includes(id)) : question.options.find(option => !(question.acceptedAnswers || [question.correctAnswer]).includes(option.id)).id;
const copy = value => JSON.parse(JSON.stringify(value));

function assertMap(h, question, outcome, marked) {
  const button = nav(h, question.id);
  assert(hasClass(button, 'report-question'), `${question.id} is in report mode`);
  for (const name of ['correct', 'incorrect', 'unanswered', 'awarded', 'blocked']) {
    assert.equal(hasClass(button, `result-${name}`), name === outcome, `${question.id} has only its verified outcome class`);
  }
  assert.equal(hasClass(button, 'marked-review'), marked, `${question.id} report review marker`);
  const icon = button.querySelector('.nav-state-icon').textContent;
  if (marked) assert.equal(icon, '★', `${question.id} star replaces the usual response icon`);
  else assert.notEqual(icon, '★', `${question.id} unmarked response has its usual status icon`);
  assert.equal(button.getAttribute('aria-label').includes('Marked for review'), marked, `${question.id} accessible review marker`);
  assert(button.getAttribute('aria-label').includes({ correct: 'Correct', incorrect: 'Incorrect', unanswered: 'Unanswered', awarded: 'Marks to all', blocked: 'Not evaluated' }[outcome]), `${question.id} accessible verified outcome`);
}

(async () => {
  for (const folder of folders) {
    const h = await load(path.join(root, folder));
    const signature = JSON.stringify({ questions: h.data.questions, scoring: h.data.scoring ?? null });
    const questions = h.data.questions.filter(question => !question.marksToAll && !question.requiresCorrect).slice(0, 6);
    const [rightStar, wrongStar, rightPlain, wrongPlain, blankStar, blankPlain] = questions;
    const savedFlags = [rightStar.id, wrongStar.id, blankStar.id];
    await editResponse(h, rightStar.id, correct(rightStar));
    await editResponse(h, wrongStar.id, wrong(wrongStar));
    await editResponse(h, rightPlain.id, correct(rightPlain));
    await editResponse(h, wrongPlain.id, wrong(wrongPlain));
    for (const id of savedFlags) await flag(h, id).click();
    for (const question of questions) {
      assert.equal(hasClass(nav(h, question.id), 'marked-review'), savedFlags.includes(question.id));
      assert(!hasClass(nav(h, question.id), 'report-question'), 'Practice keeps its existing map styling');
      assert(!/\bresult-(?:correct|incorrect)\b/.test(nav(h, question.id).className), 'Practice never reveals correctness');
    }
    await h.ids['quiz-form'].fire('submit');
    assert(!h.ids.report.hidden); assert(!h.storage.has(draftKey(h)));
    assertMap(h, rightStar, 'correct', true); assertMap(h, wrongStar, 'incorrect', true);
    assertMap(h, rightPlain, 'correct', false); assertMap(h, wrongPlain, 'incorrect', false);
    assertMap(h, blankStar, 'unanswered', true); assertMap(h, blankPlain, 'unanswered', false);
    assert(!h.ids['nav-review-legend'].hidden, 'Reports explain review stars');
    const saved = h.server.get(attemptUrl(h));
    assert.deepEqual(saved.reviewFlags, savedFlags, 'The submitted report keeps its own review marker snapshot');
    assert.equal(saved.quizSignature, signature, 'Review markers never change the verified question signature');
    assert(saved.results.every(result => !Object.hasOwn(result, 'reviewFlags')));
    assert(!Object.hasOwn(saved.answers, 'reviewFlags'));
    for (const id of savedFlags) assert.equal(flag(h, id).getAttribute('aria-pressed'), 'false', 'Successful saving clears the unfinished flags without removing report stars');

    // New practice may have unrelated flags. Saved review restores only the
    // submitted markers, and Back restores the active draft without re-saving.
    const reopened = await load(path.join(root, folder), { server: h.server });
    await editResponse(reopened, blankPlain.id, wrong(blankPlain)); await flag(reopened, blankPlain.id).click();
    const activeDraft = reopened.storage.get(draftKey(reopened)), savedBefore = JSON.stringify(saved);
    await reopened.ids['review-attempt'].click();
    assert.deepEqual(markedIds(reopened), savedFlags);
    assertMap(reopened, rightStar, 'correct', true); assertMap(reopened, wrongStar, 'incorrect', true);
    assertMap(reopened, blankPlain, 'unanswered', false);
    assert.equal(reopened.storage.get(draftKey(reopened)), activeDraft);
    assert.equal(JSON.stringify(reopened.server.get(attemptUrl(reopened))), savedBefore);
    await reopened.ids['retry-quiz'].click();
    assert(reopened.ids.report.hidden); assert.deepEqual(markedIds(reopened), [blankPlain.id]);
    assert.equal(reopened.storage.get(draftKey(reopened)), activeDraft);
    assert.equal(reopened.requests.filter(request => request.method === 'POST').length, 0);

    // Legacy reports have no stars. Invalid optional markers fail the whole
    // review before any draft responses, markers, or cache can be replaced.
    const legacy = copy(saved); delete legacy.reviewFlags;
    reopened.server.set(attemptUrl(reopened), legacy);
    await reopened.ids['review-attempt'].click();
    assert.deepEqual(markedIds(reopened), []); assertMap(reopened, rightStar, 'correct', false);
    await reopened.ids['retry-quiz'].click();
    assert.deepEqual(markedIds(reopened), [blankPlain.id]);
    for (const reviewFlags of [null, rightStar.id, {}, [null], [1], ['unknown-question'], [rightStar.id, rightStar.id]]) {
      reopened.server.set(attemptUrl(reopened), { ...saved, reviewFlags });
      await reopened.ids['review-attempt'].click();
      assert(reopened.ids.report.hidden, 'Invalid report markers cannot replace practice');
      assert.equal(reopened.t.answers[blankPlain.id], wrong(blankPlain));
      assert.deepEqual(markedIds(reopened), [blankPlain.id]);
      assert.equal(reopened.storage.get(draftKey(reopened)), activeDraft);
    }

    const awarded = h.data.questions.find(question => question.marksToAll);
    if (awarded) assertMap(h, awarded, 'awarded', false);
    const dependent = h.data.questions.find(question => question.requiresCorrect);
    if (dependent) {
      const linked = await load(path.join(root, folder));
      await editResponse(linked, dependent.id, correct(dependent)); await flag(linked, dependent.id).click();
      await linked.ids['quiz-form'].fire('submit');
      assertMap(linked, dependent, 'blocked', true);
      assertMap(linked, linked.data.questions.find(question => question.id === dependent.requiresCorrect), 'unanswered', false);
    }

    // A failed save still has its own report markers. Reviewing a prior saved
    // attempt and Back must restore that report's colors and stars together.
    const failed = await load(path.join(root, folder), { server: new Map([[attemptUrl(h), saved]]), fetch: (request, perform, response) => request.method === 'POST' ? response(503, { error: 'Simulated write failure' }) : perform() });
    await editResponse(failed, blankPlain.id, correct(blankPlain)); await flag(failed, blankPlain.id).click();
    await failed.ids['quiz-form'].fire('submit');
    const failedDraft = failed.storage.get(draftKey(failed));
    assertMap(failed, blankPlain, 'correct', true);
    await failed.ids['review-attempt'].click(); assert.deepEqual(markedIds(failed), savedFlags);
    await failed.ids['retry-quiz'].click();
    assert(!failed.ids.report.hidden); assertMap(failed, blankPlain, 'correct', true);
    assert.deepEqual(markedIds(failed), [blankPlain.id]);
    assert.equal(failed.storage.get(draftKey(failed)), failedDraft);
    assert.equal(JSON.stringify(failed.server.get(attemptUrl(failed))), savedBefore);
  }
  console.log(`Report-map checks passed: ${folders.length} quizzes, correct/incorrect/neutral outcomes, stars, submitted snapshots, legacy/invalid flags, Review/Back, failed saves, linked questions and marks to all.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
