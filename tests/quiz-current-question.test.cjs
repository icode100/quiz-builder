const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Extend the existing simulated DOM with deterministic layout, focus, and RAF.
// All submissions stay in the harness's in-memory server; no real files/cache.
let source = fs.readFileSync(path.join(__dirname, 'quiz-runtime.test.cjs'), 'utf8');
source = source.slice(0, source.indexOf('\n(async () => {'));
const attachMarker = '  const storage = options.storage instanceof Map';
assert.ok(source.includes(attachMarker));
source = source.replace(attachMarker, '  options.attachGeometry?.(document, body, ids);\n' + attachMarker);
const harness = new Function('require', source + '\nreturn { load, editResponse, reviewButton, draftKey, postRequests, El };')(require);
harness.El.prototype.closest = function (selector) {
  let node = this;
  while (node) {
    if (selector.split(',').some(part => node.matches(part.trim()))) return node;
    node = node.parent;
  }
  return null;
};

async function load(folder = 'gate-cse-2018', options = {}) {
  const frames = [], events = {};
  const view = { scrollY: 0, innerHeight: 900, questionTop: 400, questionHeight: 600, gap: 20, reportTop: 320, reportHeight: 500, timerTop: 12, timerHeight: 150, ...options.view };
  const fire = name => { for (const callback of events[name] || []) callback({ persisted: name === 'pageshow' }); };
  const bounds = node => {
    if (node.rectangle) return node.rectangle();
    const match = node.id?.match(/^(question|result)-card-(\d+)$/);
    if (match) {
      const report = match[1] === 'result', height = report ? view.reportHeight : view.questionHeight;
      const top = (report ? view.reportTop + Number(match[2]) * (height + view.gap) : view.questionTop) - view.scrollY;
      return { top, bottom: top + height, height };
    }
    if (node.id === 'question-carousel') return { top: view.questionTop - 90 - view.scrollY, bottom: view.questionTop - 16 - view.scrollY, height: 74 };
    if (node.id === 'quiz-timer') return { top: view.timerTop, bottom: view.timerTop + view.timerHeight, height: view.timerHeight };
    return { top: 0, bottom: 0, height: 0 };
  };
  const win = {
    get scrollY() { return view.scrollY; },
    get innerHeight() { return view.innerHeight; },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    getComputedStyle: node => ({ scrollMarginTop: node.id?.startsWith('question-card-') || node.id === 'question-carousel' ? '192px' : '16px' }),
    addEventListener: (name, callback) => { (events[name] ||= []).push(callback); }
  };
  // The base harness spreads window overrides; preserve live viewport accessors.
  const h = await harness.load(folder, {
    ...options,
    window: win,
    attachGeometry(document, body, ids) {
      const attach = node => {
        node.getBoundingClientRect = () => bounds(node);
        node.focus = () => { node.focused = true; document.activeElement = node; document.focusin?.({ target: node }); };
        node.scrollIntoView = () => {
          node.scrolled = true;
          if (/^(question|result)-card-\d+$/.test(node.id || '')) {
            view.scrollY += bounds(node).top - parseFloat(win.getComputedStyle(node).scrollMarginTop);
          } else if (node.id === 'question-carousel') {
            view.scrollY += bounds(node).top - parseFloat(win.getComputedStyle(node).scrollMarginTop);
          } else if (node.id === 'report') view.scrollY = 0;
          else if (node.id === 'quiz-form') view.scrollY = view.questionTop - 192;
          fire('scroll');
        };
        for (const child of node.children) attach(child);
        return node;
      };
      attach(body);
      const create = document.createElement;
      document.createElement = tag => attach(create(tag));
      const legend = document.createElement('div'); legend.className = 'nav-legend';
      legend.append(ids['nav-review-legend'], ids['nav-check-legend']);
      ids['question-nav'].append(legend);
    }
  });
  Object.defineProperties(h.window, {
    scrollY: { get: () => view.scrollY },
    innerHeight: { get: () => view.innerHeight }
  });
  const flush = () => { while (frames.length) frames.shift()(); };
  flush();
  return { ...h, view, frames, fire, flush };
}

function current(h, index) {
  const buttons = h.ids['nav-groups'].querySelectorAll('.nav-question');
  assert.deepEqual(buttons.filter(button => button.getAttribute('aria-current') === 'location').map(button => button.id), [`nav-question-${index}`]);
  assert.equal(buttons.length, h.data.questions.length);
}
function move(h, index, top = 200, report = false) {
  h.view.scrollY = (report ? h.view.reportTop : h.view.questionTop) + index * ((report ? h.view.reportHeight : h.view.questionHeight) + h.view.gap) - top;
  h.fire('scroll'); h.flush();
}

function visibleQuestion(h, index) {
  assert.deepEqual(h.ids.questions.querySelectorAll('fieldset').filter(card => !card.hidden).map(card => card.id), [`question-card-${index}`]);
}

(async () => {
  const folders = fs.readdirSync('.').filter(folder => /^gate-cse-/.test(folder) && fs.existsSync(path.join(folder, 'quiz.js'))).sort();
  for (const folder of folders) {
    const h = await load(folder);
    current(h, 0); visibleQuestion(h, 0);
    move(h, 2);
    current(h, 0); visibleQuestion(h, 0);
    await h.document.getElementById('nav-question-5').click();
    current(h, 5); h.flush(); current(h, 5); visibleQuestion(h, 5);
    assert.ok(h.ids['question-carousel'].scrolled, 'Practice jumps align the navigation above the question');
    assert.ok(!h.document.getElementById('question-card-5').scrolled, 'The card must not hide navigation behind the sticky timer');
    assert.ok(h.document.getElementById('question-card-5').focused);
    assert.ok(h.ids['question-carousel'].getBoundingClientRect().top > h.ids['quiz-timer'].getBoundingClientRect().bottom);
    assert.equal(harness.postRequests(h).length, 0);
    assert.equal(h.storage.size, 0, 'Navigation never creates a browser draft');
    assert.equal(h.ids['question-nav'].querySelectorAll('#nav-current-legend').length, 1);
    assert.equal(fs.readFileSync(path.join(folder, 'quiz.js'), 'utf8'), fs.readFileSync('_template/quiz.js', 'utf8'));
    const css = fs.readFileSync(path.join(folder, 'styles.css'), 'utf8');
    assert.equal(css, fs.readFileSync('_template/styles.css', 'utf8'));
    assert.match(css, /\.nav-question\[aria-current="location"\]\s*\{[^}]*box-shadow:/);
    assert.match(css, /\.nav-question\.marked-review\.needs-check\s*\{[^}]*outline: 2px solid #a16207/);
    assert.match(css, /\.question-carousel\s*\{[^}]*scroll-margin-top: 12rem/);
  }

  const h = await load();
  const originalSignature = JSON.stringify({ questions: h.data.questions, scoring: h.data.scoring ?? null });
  await h.document.getElementById('nav-question-2').click();
  h.flush(); current(h, 2); visibleQuestion(h, 2);
  const selected = h.document.getElementById('question-card-2').querySelector('input');
  selected.focus(); current(h, 2);
  h.document.pointerdown({ target: selected }); current(h, 2);

  // The practice carousel owns location: scrolling, image layout, timer height,
  // resize and browser history cannot select a different hidden question.
  h.view.timerHeight = 280;
  h.fire('resize'); h.flush(); current(h, 2);
  h.view.scrollY += 900; h.fire('scroll'); h.flush(); current(h, 2);
  h.fire('pageshow'); h.flush(); current(h, 2);
  h.document.load({ target: selected }); h.flush(); current(h, 2);
  visibleQuestion(h, 2);

  // Rebuilding a card after Clear retains the slide and its independent flag.
  const natIndex = h.data.questions.findIndex(question => question.type === 'nat');
  const nat = h.data.questions[natIndex];
  await h.document.getElementById(`nav-question-${natIndex}`).click();
  await harness.reviewButton(h, nat.id).click();
  await harness.editResponse(h, nat.id, '-');
  current(h, natIndex); visibleQuestion(h, natIndex);
  const invalidMap = h.document.getElementById(`nav-question-${natIndex}`);
  assert.ok(invalidMap.className.includes('marked-review'));
  assert.ok(invalidMap.className.includes('needs-check'));
  assert.equal(invalidMap.querySelector('.nav-state-icon').textContent, '!');
  await h.document.getElementById(`question-card-${natIndex}`).querySelector('.clear-response').click();
  current(h, natIndex); h.flush(); current(h, natIndex); visibleQuestion(h, natIndex);
  assert.ok(h.document.getElementById(`nav-question-${natIndex}`).className.includes('marked-review'));
  assert.equal(h.ids['question-nav'].querySelectorAll('#nav-current-legend').length, 1);
  assert.equal(harness.postRequests(h).length, 0);

  // Reports retain scrolling and map jumps; Review/Back restores the exact slide.
  await harness.editResponse(h, h.data.questions[0].id, h.data.questions[0].options[0].id);
  await h.ids['quiz-form'].fire('submit'); h.flush(); current(h, 0);
  assert.equal(h.ids.report.hidden, false);
  assert.equal(h.ids['quiz-timer'].hidden, true);
  await h.document.getElementById('nav-question-3').click(); h.flush(); current(h, 3);
  assert.ok(h.document.getElementById('result-card-3').scrolled);
  move(h, 5, 20, true); current(h, 5);
  for (let i = 0; i < 10; i++) h.fire('scroll');
  assert.equal(h.frames.length, 1, 'Report viewport work is coalesced into one animation frame');
  h.flush(); current(h, 5);
  await h.ids['retry-quiz'].click(); h.flush(); current(h, 0); visibleQuestion(h, 0);
  assert.equal(h.ids.report.hidden, true);
  await harness.editResponse(h, h.data.questions[1].id, h.data.questions[1].options[0].id);
  await h.document.getElementById('nav-question-1').click();
  await harness.reviewButton(h, h.data.questions[1].id).click();
  await h.document.getElementById('nav-question-4').click(); h.flush(); current(h, 4); visibleQuestion(h, 4);
  const draft = h.storage.get(harness.draftKey(h));
  await h.ids['review-attempt'].click(); h.flush(); current(h, 0);
  await h.document.getElementById('nav-question-6').click(); h.flush(); current(h, 6);
  await h.ids['retry-quiz'].click(); h.flush(); current(h, 4); visibleQuestion(h, 4);
  assert.equal(h.ids.report.hidden, true);
  assert.equal(h.storage.get(harness.draftKey(h)), draft, 'Review/current tracking leaves the draft unchanged');
  assert.equal(JSON.stringify({ questions: h.data.questions, scoring: h.data.scoring ?? null }), originalSignature);
  assert.equal(harness.postRequests(h).length, 1, 'Only the explicit Submit writes an attempt');
  assert.ok(!draft.includes('currentQuestion'), 'Current location is not persisted in the draft');

  const legacy = JSON.parse(draft); delete legacy.reviewFlags; delete legacy.timer;
  const restored = await load('gate-cse-2018', { storage: [[harness.draftKey(h), JSON.stringify(legacy)]] });
  current(restored, 0); visibleQuestion(restored, 0);
  assert.deepEqual(Object.keys(restored.t.answers), [h.data.questions[1].id]);
  assert.deepEqual([...restored.t.reviewFlags], []);
  const blank = await load('_template');
  assert.equal(blank.ids['question-nav'].hidden, true);
  assert.equal(blank.ids['nav-groups'].querySelectorAll('[aria-current="location"]').length, 0);
  console.log(`Current-question checks passed: ${folders.length} quiz carousels, fixed practice location, report scroll/focus/map/resize/history, flags, Review/Back/Retry and legacy drafts.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
