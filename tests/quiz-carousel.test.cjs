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
    const h = await load(folder);
    assert.equal(h.ids['question-carousel'].hidden, folder === '_template');
    if (folder === '_template') continue;
    slide(h, 0);
    assert.equal(h.ids['next-question'].textContent, '→');
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
    await h.ids['next-question'].click(); slide(h, last);
    let prevented = false;
    await h.ids.questions.fire('keydown', { key: 'Enter', target: card(h, last).querySelector('input'), preventDefault() { prevented = true; } });
    slide(h, last); assert.equal(prevented, true, 'Enter at the last question cannot implicitly submit');
    assert.equal(h.ids.report.hidden, true, 'Last never wraps or auto-submits');
    assert.equal(h.storage.size, 0, 'Pure navigation never changes the browser draft');
    assert.equal(h.requests.length, 1, 'Pure navigation never adds a server request');
    const numbers = h.ids['nav-groups'].querySelectorAll('.nav-number').map(node => node.textContent);
    assert.deepEqual(numbers, Array.from(h.data.questions, question => String(question.number ?? label(question))));
  }

  const h = await load('gate-cse-2021-set-1');
  const signature = JSON.stringify({ questions: h.data.questions, scoring: h.data.scoring ?? null });
  const first = h.data.questions[0];
  await editResponse(h, first.id, first.options[0].id); slide(h, 1);
  assert.equal(card(h, 1).scrolled, true, 'MCQ auto-advance anchors the next question');
  assert.equal(h.t.answers[first.id], first.options[0].id, 'MCQ change saves before advancing');
  await h.ids['previous-question'].click(); slide(h, 0);
  assert.equal(h.ids['next-question'].getAttribute('aria-label'), 'Next question');
  assert.equal(card(h, 0).querySelector('input').checked, true);
  await h.document.getElementById('mark-review-0').click(); slide(h, 0);
  const draft = h.storage.get(draftKey(h));
  await h.ids['next-question'].click(); slide(h, 1);
  await h.ids['previous-question'].click(); slide(h, 0);
  assert.equal(h.storage.get(draftKey(h)), draft, 'Moving preserves answers, flags and timer exactly');
  await card(h, 0).querySelector('.clear-response').click(); slide(h, 0);
  assert.equal(h.t.answers[first.id], undefined);
  assert.deepEqual([...h.t.reviewFlags], [first.id], 'Clear response retains the flag on the current slide');
  assert.equal(h.ids['next-question'].getAttribute('aria-label'), 'Skip question');

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
  assert.equal(h.storage.get(draftKey(h)), invalidDraft, 'Invalid Submit preserves the unfinished draft');
  assert.equal(posts(h).length, 0);
  assert.equal(h.ids.report.hidden, true);

  const restored = await load('gate-cse-2021-set-1', { storage: h.storage });
  slide(restored, 0);
  assert.equal(restored.t.answers[nat.id], '-', 'Reload restores input without persisting carousel position');
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

  console.log(`Carousel checks passed: ${folders.length} quizzes, original map numbering, MCQ-only advance, previous/skip/bounds, flags/cache, hidden invalid NAT, reports, Review/Back, Retry and Home links.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
