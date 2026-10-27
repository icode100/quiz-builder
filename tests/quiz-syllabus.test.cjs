const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, editResponse, draftKey, attemptUrl, assertEditable } = require('./helpers/quiz-harness.cjs');

// Everything is held in the simulated DOM/storage/server. No real saved
// attempt, browser draft, question data, or original asset is modified.
const options = ['A', 'B', 'C', 'D'].map(id => ({ id, text: `Option ${id}` }));
const mcq = (id, marks = 2, extra = {}) => ({ id, text: id, type: 'mcq', options, correctAnswer: 'A', marks, incorrectMarks: -marks / 3, ...extra });
const fixture = { id: 'syllabus-test', title: 'Syllabus test', questions: [
  mcq('GA-1', 1), mcq('CS-1'),
  { id: 'CS-2', text: 'Decimal question', type: 'nat', correctRanges: [{ min: 4, max: 4 }], marks: 2, incorrectMarks: 0 },
  { id: 'CS-3', text: 'Multiple choice', type: 'msq', options, correctAnswers: ['A', 'C'], marks: 2, incorrectMarks: 0 },
  mcq('CS-4', 1, { marksToAll: true }), mcq('CS-5'), mcq('CS-6', 2, { requiresCorrect: 'CS-5', incorrectMarks: 0 })
] };
const copy = value => JSON.parse(JSON.stringify(value));
const open = options => load('_template', { data: fixture, ...options });
const index = (h, id) => h.data.questions.findIndex(question => question.id === id);
const toggle = (h, id) => h.document.getElementById(`out-of-syllabus-${index(h, id)}`);
const map = (h, id) => h.document.getElementById(`nav-question-${index(h, id)}`);
const cached = h => JSON.parse(h.storage.get(draftKey(h)));
const posts = h => h.requests.filter(request => request.method === 'POST');
const flags = h => [...h.t.outOfSyllabus];
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const answered = (h, count, valid) => {
  assert.equal(h.ids.progress.textContent, `${count} of ${valid} answered`);
  const percent = valid ? count / valid * 100 : 0;
  const label = valid ? `${Math.round(percent * 10) / 10}%` : '—';
  const bar = h.ids['test-progress-bar'];
  close(Number(bar.value), percent);
  assert.equal(h.ids['test-progress-fill'].getAttribute('style'), `width: ${percent}%;`, 'The visible fill matches the accessible native progress value');
  assert(Number.isFinite(Number(bar.value)) && Number(bar.value) >= 0 && Number(bar.value) <= 100);
  assert.equal(h.ids['test-progress-value'].textContent, label);
  assert.equal(h.ids['test-progress-detail'].textContent, valid ? `${count} of ${valid} in-syllabus questions answered` : 'No in-syllabus questions');
  const accessible = bar.getAttribute('aria-valuetext');
  if (valid) {
    assert(accessible.includes(`${count} of ${valid}`), 'The progress bar exposes its response counts');
    assert(accessible.includes(label), 'The progress bar exposes its percentage');
  }
  else assert.match(accessible, /unavailable/i, 'No eligible questions produces an explicit unavailable state');
  assert.equal(h.ids['test-progress'].hidden, !h.ids.report.hidden, 'The completion meter appears only during practice');
  assert.equal(h.ids['progress-panel'].hidden, h.ids['test-progress'].hidden && h.ids['status-message'].hidden, 'Progress or a status message keeps its shared panel visible');
};
const totals = (h, maximum, valid) => {
  assert.equal(h.ids['quiz-meta'].hidden, false, 'Current test totals are visible');
  const text = h.ids['quiz-meta'].children.map(node => node.textContent).join('');
  assert.equal(text, `Maximum marks: ${maximum} · Valid questions: ${valid} of ${h.data.questions.length}`);
};
const current = (h, id) => {
  assert.equal(map(h, id).getAttribute('aria-current'), 'location');
  assert.deepEqual(h.ids.questions.querySelectorAll('fieldset').filter(node => !node.hidden).map(node => node.id), [`question-card-${index(h, id)}`]);
};

(async () => {
  const folders = fs.readdirSync('.').filter(folder => /^gate-cse-/.test(folder) && fs.existsSync(path.join(folder, 'quiz.js')));
  for (const folder of ['_template', ...folders]) {
    const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
    const meta = html.match(/<[^>]+\bid="quiz-meta"[^>]*>/g);
    assert.equal(meta?.length, 1, `${folder} supplies one current-total line`);
    assert.match(meta[0], /\baria-live="polite"/);
    assert.match(html, /<\/h1>\s*<[^>]+\bid="quiz-meta"[^>]*>[\s\S]*?<\/div>\s*<details\b/, `${folder} places totals beneath the title and outside the disclosure`);
    assert.match(html, /<progress\b[^>]*\bid="test-progress-bar"[^>]*\bmax="100"/, `${folder} uses a native percentage progress bar`);
    assert.match(html, /<(?:span|div)\b(?=[^>]*\bclass="[^"]*\btest-progress-track\b[^"]*")(?=[^>]*\baria-hidden="true")[^>]*>[\s\S]*?\bid="test-progress-fill"/, `${folder} keeps the decorative fill separate from accessible progress`);
    assert.match(html, /<section\b[^>]*\bid="progress-panel"[^>]*>[\s\S]*?\bid="test-progress"[\s\S]*?\bid="status-message"[\s\S]*?<\/section>/, `${folder} retains status messages alongside progress`);
    for (const details of html.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)) assert(!details[0].includes('id="quiz-meta"'));
  }
  const blank = await load('_template');
  assert.equal(blank.ids['quiz-meta'].hidden, true, 'The blank template has no test totals');
  assert.equal(blank.ids['test-progress'].hidden, true, 'The blank template hides completion progress');
  assert.equal(blank.ids['progress-panel'].hidden, blank.ids['status-message'].hidden);
  for (const folder of folders) {
    const h = await load(folder), question = h.data.questions[0];
    const maximum = folder === 'gate-cse-2007' ? 150 : 100;
    totals(h, maximum, h.data.questions.length);
    answered(h, 0, h.data.questions.length);
    assert.equal(h.ids.questions.querySelectorAll('.out-of-syllabus-toggle').length, h.data.questions.length, `${folder} offers the toggle on every question`);
    assert.equal(toggle(h, question.id).getAttribute('aria-pressed'), 'false');
    await toggle(h, question.id).click();
    assert.equal(toggle(h, question.id).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(cached(h).outOfSyllabus, [question.id]);
    totals(h, maximum - question.marks, h.data.questions.length - 1);
    answered(h, 0, h.data.questions.length - 1);
    const twoMark = h.data.questions.find(item => item.marks === 2);
    await toggle(h, twoMark.id).click();
    totals(h, maximum - question.marks - 2, h.data.questions.length - 2);
    answered(h, 0, h.data.questions.length - 2);
    await toggle(h, question.id).click();
    totals(h, maximum - 2, h.data.questions.length - 1);
    answered(h, 0, h.data.questions.length - 1);
    await toggle(h, twoMark.id).click();
    totals(h, maximum, h.data.questions.length);
    answered(h, 0, h.data.questions.length);
    assert.equal(Object.keys(h.t.answers).length, 0, 'Excluding a blank question is independent of answering');
    assert.equal(posts(h).length, 0);
  }

  const h = await open();
  totals(h, 12, 7);
  answered(h, 0, 7);
  await map(h, 'CS-3').click(); answered(h, 0, 7);
  const signature = JSON.stringify({ questions: h.data.questions, scoring: h.data.scoring ?? null });
  await editResponse(h, 'GA-1', 'A'); await editResponse(h, 'CS-1', 'B');
  await editResponse(h, 'CS-2', '4'); await editResponse(h, 'CS-3', ['A', 'C']);
  await editResponse(h, 'CS-5', 'B'); await editResponse(h, 'CS-6', 'A');
  answered(h, 6, 7);
  let summary = h.t.summarize(h.t.grade());
  close(summary.score, 14 / 3); assert.equal(summary.maximum, 12); close(summary.percentage, 350 / 9);
  assert(!Object.hasOwn(summary.counts, 'excluded'), 'Older reports retain compatible counts when no questions are excluded');
  await toggle(h, 'CS-1').click(); await toggle(h, 'CS-5').click();
  totals(h, 8, 5);
  answered(h, 4, 5);
  assert.equal(h.t.answers['CS-1'], 'B', 'Excluding an answered question preserves its response');
  assert.equal(h.t.answers['CS-5'], 'B');
  assert.match(h.ids['nav-progress'].textContent, /^6 attempted · 1 not attempted/, 'The question map retains physical paper totals');
  summary = h.t.summarize(h.t.grade());
  assert.equal(summary.score, 8); assert.equal(summary.maximum, 8); assert.equal(summary.percentage, 100); assert.equal(summary.counts.excluded, 2);
  assert.equal(h.t.grade()[6].outcome, 'correct', 'An excluded prerequisite allows its dependent to grade independently');
  assert.equal(h.t.grade()[1].outcome, 'excluded'); assert.equal(h.t.grade()[1].earned, 0);
  await toggle(h, 'CS-5').click();
  totals(h, 10, 6);
  answered(h, 5, 6);
  assert.equal(h.t.grade()[6].outcome, 'blocked', 'Restoring the prerequisite restores linked grading');
  await toggle(h, 'CS-5').click();
  await toggle(h, 'CS-4').click();
  totals(h, 7, 4);
  answered(h, 4, 4);
  summary = h.t.summarize(h.t.grade());
  assert.equal(summary.maximum, 7); assert.equal(summary.score, 7); assert.equal(summary.awardedMarks, 0, 'Excluded MTA contributes no automatic marks');
  assert.equal(summary.counts.awarded, 0);
  await h.document.getElementById(`mark-review-${index(h, 'CS-1')}`).click();
  await h.document.getElementById(`question-card-${index(h, 'CS-1')}`).querySelector('.clear-response').click();
  assert(flags(h).includes('CS-1'), 'Clear response preserves exclusion');
  assert([...h.t.reviewFlags].includes('CS-1'), 'Review flags coexist with exclusions');
  totals(h, 7, 4);
  answered(h, 4, 4);
  assert.equal(cached(h).signature, signature);
  await map(h, 'CS-3').click();
  assert.equal(cached(h).currentQuestionId, 'CS-3');
  const reopened = await open({ storage: h.storage });
  current(reopened, 'CS-3'); assert.deepEqual(flags(reopened), flags(h));
  assert.equal(toggle(reopened, 'CS-1').getAttribute('aria-pressed'), 'true');
  assert.deepEqual([...reopened.t.reviewFlags], ['CS-1']);
  totals(reopened, 7, 4);
  answered(reopened, 4, 4);

  await reopened.ids['quiz-form'].fire('submit');
  assert.equal(reopened.ids['score-value'].textContent, '100%');
  assert.match(reopened.ids['score-detail'].textContent, /^Marks: 7 \/ 7/);
  const saved = reopened.server.get(attemptUrl(reopened));
  assert.deepEqual(saved.outOfSyllabus, ['CS-1', 'CS-5', 'CS-4']);
  assert.equal(saved.summary.percentage, 100); assert.equal(saved.summary.maximum, 7);
  assert.equal(saved.results[1].outcome, 'excluded'); assert.equal(saved.results[1].marksEarned, 0);
  assert.equal(saved.quizSignature, signature); assert(!Object.hasOwn(saved, 'currentQuestionId')); assert(!Object.hasOwn(saved, 'timer'));
  assert.equal(reopened.storage.has(draftKey(reopened)), false);
  assert.deepEqual(flags(reopened), []); assert.deepEqual([...reopened.t.reportOutOfSyllabus], saved.outOfSyllabus);
  totals(reopened, 7, 4);
  answered(reopened, 4, 4);
  assert.equal(map(reopened, 'CS-1').getAttribute('aria-label').includes('Out of syllabus'), true);
  assert.equal(reopened.ids['report-list'].querySelectorAll('article').length, 7, 'Excluded questions remain in the complete report');
  const savedBytes = JSON.stringify(saved);
  await reopened.ids['retry-quiz'].click();
  current(reopened, 'GA-1'); assert.deepEqual(flags(reopened), []);
  totals(reopened, 12, 7);
  answered(reopened, 0, 7);
  assert.equal(JSON.stringify(reopened.server.get(attemptUrl(reopened))), savedBytes, 'Retry preserves the submitted file');
  await toggle(reopened, 'CS-2').click(); await map(reopened, 'CS-6').click();
  totals(reopened, 10, 6);
  answered(reopened, 0, 6);
  const activeDraft = reopened.storage.get(draftKey(reopened));
  await reopened.ids['review-attempt'].click();
  assert.equal(reopened.ids['score-value'].textContent, '100%');
  assert.deepEqual([...reopened.t.reportOutOfSyllabus], saved.outOfSyllabus);
  totals(reopened, 7, 4);
  answered(reopened, 4, 4);
  await map(reopened, 'GA-1').click();
  assert.equal(reopened.storage.get(draftKey(reopened)), activeDraft, 'Review navigation cannot overwrite the cached practice question');
  await reopened.ids['retry-quiz'].click();
  current(reopened, 'CS-6'); assert.deepEqual(flags(reopened), ['CS-2']);
  totals(reopened, 10, 6);
  answered(reopened, 0, 6);
  assert.equal(reopened.storage.get(draftKey(reopened)), activeDraft, 'Back restores practice without replacing its draft');

  // Saved summary/results are display artifacts; review must regrade the key,
  // including the saved exclusions. Legacy records without exclusions work.
  reopened.server.set(attemptUrl(reopened), { ...saved, summary: { score: 999, maximum: 999, percentage: 999 }, results: [] });
  await reopened.ids['review-attempt'].click();
  assert.equal(reopened.ids['score-value'].textContent, '100%');
  assert.match(reopened.ids['score-detail'].textContent, /^Marks: 7 \/ 7/);
  await reopened.ids['retry-quiz'].click();
  const legacy = copy(saved); delete legacy.outOfSyllabus;
  reopened.server.set(attemptUrl(reopened), legacy);
  await reopened.ids['review-attempt'].click();
  assert.deepEqual([...reopened.t.reportOutOfSyllabus], []);
  totals(reopened, 12, 7);
  answered(reopened, 5, 7);
  assert.match(reopened.ids['score-detail'].textContent, /^Marks: 5\.3333 \/ 12/);
  await reopened.ids['retry-quiz'].click();
  for (const outOfSyllabus of [null, 'CS-1', {}, [null], [1], ['unknown'], ['CS-1', 'CS-1']]) {
    reopened.server.set(attemptUrl(reopened), { ...saved, outOfSyllabus });
    await reopened.ids['review-attempt'].click();
    assert.equal(reopened.ids.report.hidden, true, 'Malformed submission exclusion lists cannot replace practice');
    assert.equal(reopened.storage.get(draftKey(reopened)), activeDraft);
    assert.deepEqual(flags(reopened), ['CS-2']); current(reopened, 'CS-6');
  }

  const validDraft = cached(reopened);
  const invalidDrafts = [
    ...[null, 'CS-1', {}, [null], [1], ['unknown'], ['CS-1', 'CS-1']].map(outOfSyllabus => ({ ...validDraft, outOfSyllabus })),
    ...[null, 1, [], {}, '', 'unknown'].map(currentQuestionId => ({ ...validDraft, currentQuestionId }))
  ];
  for (const damaged of invalidDrafts) {
    const invalid = await open({ storage: [[draftKey(reopened), JSON.stringify(damaged)]] });
    current(invalid, 'GA-1'); assert.deepEqual(flags(invalid), []); assert.deepEqual(Object.keys(invalid.t.answers), []);
    assert.equal(invalid.storage.has(draftKey(invalid)), false, 'A malformed draft is rejected before any partial restoration');
  }
  const oldDraft = copy(validDraft); delete oldDraft.outOfSyllabus; delete oldDraft.currentQuestionId;
  const legacyDraft = await open({ storage: [[draftKey(reopened), JSON.stringify(oldDraft)]] });
  current(legacyDraft, 'GA-1'); assert.deepEqual(flags(legacyDraft), []);

  const invalidNat = await open();
  await editResponse(invalidNat, 'CS-2', '-'); answered(invalidNat, 1, 7);
  await toggle(invalidNat, 'CS-2').click();
  await map(invalidNat, 'CS-6').click(); await invalidNat.ids['quiz-form'].fire('submit');
  current(invalidNat, 'CS-2'); assert.equal(posts(invalidNat).length, 0); assert.equal(invalidNat.ids.report.hidden, true);
  assert.deepEqual(flags(invalidNat), ['CS-2']); assert.equal(cached(invalidNat).answers['CS-2'], '-');
  totals(invalidNat, 10, 6);
  answered(invalidNat, 0, 6);
  assert.equal(cached(invalidNat).currentQuestionId, 'CS-2', 'Invalid Submit remembers the question it reveals');

  const failed = await open({ server: [[attemptUrl(reopened), saved]], fetch: (request, perform, response) => request.method === 'POST' ? response(503, {}) : perform() });
  await editResponse(failed, 'CS-2', '4'); await toggle(failed, 'CS-1').click(); await map(failed, 'CS-3').click();
  await failed.ids['quiz-form'].fire('submit');
  assert.equal(failed.ids.report.hidden, false); assert.deepEqual(flags(failed), ['CS-1']);
  totals(failed, 10, 6);
  answered(failed, 1, 6);
  assert.deepEqual(cached(failed).outOfSyllabus, ['CS-1']); assert.equal(cached(failed).currentQuestionId, 'CS-3');
  assert.equal(JSON.stringify(failed.server.get(attemptUrl(failed))), savedBytes);
  const failedCache = failed.storage.get(draftKey(failed)), failedScore = failed.ids['score-value'].textContent;
  await failed.ids['review-attempt'].click(); await failed.ids['retry-quiz'].click();
  assert.equal(failed.ids.report.hidden, false); assert.equal(failed.ids['score-value'].textContent, failedScore);
  assert.deepEqual([...failed.t.reportOutOfSyllabus], ['CS-1']); assert.equal(failed.storage.get(draftKey(failed)), failedCache);
  totals(failed, 10, 6);
  answered(failed, 1, 6);

  const allExcluded = await open();
  await editResponse(allExcluded, 'GA-1', 'A');
  for (const question of allExcluded.data.questions) await toggle(allExcluded, question.id).click();
  totals(allExcluded, 0, 0);
  answered(allExcluded, 0, 0);
  await allExcluded.ids['quiz-form'].fire('submit');
  totals(allExcluded, 0, 0);
  answered(allExcluded, 0, 0);
  assert.equal(allExcluded.ids['score-value'].textContent, 'Percentage unavailable');
  assert.match(allExcluded.ids['score-detail'].textContent, /^Marks: 0 \/ 0/);
  const allSaved = allExcluded.server.get(attemptUrl(allExcluded));
  assert.equal(allSaved.summary.percentage, null); assert.equal(allSaved.summary.excluded, 7);
  assert.equal(allSaved.summary.maximum, 0); assert.equal(allSaved.summary.score, 0);
  assert(allSaved.results.every(result => result.outcome === 'excluded' && result.marksEarned === 0));

  const negative = await open(); await editResponse(negative, 'GA-1', 'B'); await toggle(negative, 'CS-4').click();
  await negative.ids['quiz-form'].fire('submit');
  assert.equal(negative.ids['score-value'].textContent, '-3.0303%');
  assert.match(negative.ids['score-detail'].textContent, /^Marks: -0\.3333 \/ 11/);
  const unavailable = await open({ storageUnavailable: true });
  answered(unavailable, 0, 7);
  assert.equal(unavailable.ids['status-message'].hidden, false, 'Cache errors remain visible with the completion meter');
  await toggle(unavailable, 'CS-1').click(); await map(unavailable, 'CS-6').click(); current(unavailable, 'CS-6');
  await editResponse(unavailable, 'GA-1', 'A'); assertEditable(unavailable);
  await unavailable.ids['quiz-form'].fire('submit'); assert.equal(unavailable.ids.report.hidden, false);
  answered(unavailable, 1, 6);
  assert.equal(unavailable.ids['status-message'].hidden, false, 'Saved-result and cache status remain visible when the meter is hidden');
  await unavailable.ids['retry-quiz'].click(); current(unavailable, 'GA-1'); assert.deepEqual(flags(unavailable), []);
  assert.match(unavailable.ids['status-message'].textContent, /Could not cache/);
  await toggle(unavailable, 'CS-1').click(); await unavailable.ids['clear-answers'].click();
  assert.deepEqual(flags(unavailable), []); current(unavailable, 'GA-1');
  totals(unavailable, 12, 7);
  answered(unavailable, 0, 7);
  console.log(`PASS: ${folders.length} quiz exclusion controls; included-question completion meter/labels/accessible state, report/blank visibility and retained status messages; percentage, adjusted denominator, linked/MTA exclusions, draft/navigation restore and strict validation, saved review recomputation, Submit success/failure, all-excluded/negative scores, storage failures and fresh Retry. No real attempts changed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
