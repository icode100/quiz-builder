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
      const top = (report ? view.reportTop : view.questionTop) + Number(match[2]) * (height + view.gap) - view.scrollY;
      return { top, bottom: top + height, height };
    }
    if (node.id === 'quiz-timer') return { top: view.timerTop, bottom: view.timerTop + view.timerHeight, height: view.timerHeight };
    return { top: 0, bottom: 0, height: 0 };
  };
  const win = {
    get scrollY() { return view.scrollY; },
    get innerHeight() { return view.innerHeight; },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    getComputedStyle: node => ({ scrollMarginTop: node.id?.startsWith('question-card-') ? '192px' : '16px' }),
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

(async () => {
  const folders = fs.readdirSync('.').filter(folder => /^gate-cse-/.test(folder) && fs.existsSync(path.join(folder, 'quiz.js'))).sort();
  for (const folder of folders) {
    const h = await load(folder);
    current(h, 0);
    move(h, 2);
    current(h, 2);
    await h.document.getElementById('nav-question-5').click();
    current(h, 5); h.flush(); current(h, 5);
    assert.ok(h.document.getElementById('question-card-5').scrolled);
    assert.ok(h.document.getElementById('question-card-5').focused);
    assert.equal(harness.postRequests(h).length, 0);
    assert.equal(h.storage.size, 0, 'Tracking never creates a browser draft');
    assert.equal(h.ids['question-nav'].querySelectorAll('#nav-current-legend').length, 1);
    assert.equal(fs.readFileSync(path.join(folder, 'quiz.js'), 'utf8'), fs.readFileSync('_template/quiz.js', 'utf8'));
    const css = fs.readFileSync(path.join(folder, 'styles.css'), 'utf8');
    assert.equal(css, fs.readFileSync('_template/styles.css', 'utf8'));
    assert.match(css, /\.nav-question\[aria-current="location"\]\s*\{[^}]*box-shadow:/);
    assert.match(css, /\.nav-question\.marked-review\.needs-check\s*\{[^}]*outline: 2px solid #a16207/);
  }

  const h = await load();
  const originalSignature = JSON.stringify({ questions: h.data.questions, scoring: h.data.scoring ?? null });
  for (let i = 0; i < 10; i++) h.fire('scroll');
  assert.equal(h.frames.length, 1, 'Viewport work is coalesced into one animation frame');
  h.flush();

  // Timer height and configured scroll margin both affect the visible reading line.
  h.document.getElementById('question-card-0').rectangle = () => ({ top: 0, bottom: 260 });
  h.document.getElementById('question-card-1').rectangle = () => ({ top: 280, bottom: 700 });
  h.view.timerHeight = 280;
  h.fire('resize'); h.flush(); current(h, 1);
  h.view.timerHeight = 150;
  h.fire('resize'); h.flush(); current(h, 0);
  delete h.document.getElementById('question-card-0').rectangle;
  delete h.document.getElementById('question-card-1').rectangle;
  await h.document.getElementById('nav-question-2').click();
  h.flush(); current(h, 2); // target top 192, just below a previous card ending 172.

  // Focus/pointer select an interacted question; subsequent manual scrolling wins.
  h.view.questionHeight = 240; h.view.scrollY = 300;
  h.fire('scroll'); h.flush(); current(h, 0);
  const secondInput = h.document.getElementById('question-card-1').querySelector('input');
  secondInput.focus(); current(h, 1);
  h.fire('scroll'); h.flush(); current(h, 1);
  h.view.scrollY += 30; h.fire('scroll'); h.flush(); current(h, 0);
  h.document.pointerdown({ target: secondInput }); current(h, 1);
  move(h, 3); current(h, 3);
  h.view.scrollY = h.view.questionTop + 4 * (h.view.questionHeight + h.view.gap) - 200;
  h.fire('pageshow'); h.flush(); current(h, 4);
  h.view.scrollY += h.view.questionHeight + h.view.gap;
  h.document.load({ target: secondInput }); h.flush(); current(h, 5);

  // Rebuilding cards after Clear retains both the current location and its flag.
  const natIndex = h.data.questions.findIndex(question => question.type === 'nat');
  const nat = h.data.questions[natIndex];
  await h.document.getElementById(`nav-question-${natIndex}`).click();
  await harness.reviewButton(h, nat.id).click();
  await harness.editResponse(h, nat.id, '-');
  current(h, natIndex);
  const invalidMap = h.document.getElementById(`nav-question-${natIndex}`);
  assert.ok(invalidMap.className.includes('marked-review'));
  assert.ok(invalidMap.className.includes('needs-check'));
  assert.equal(invalidMap.querySelector('.nav-state-icon').textContent, '!');
  await h.document.getElementById(`question-card-${natIndex}`).querySelector('.clear-response').click();
  current(h, natIndex); h.flush(); current(h, natIndex);
  assert.ok(h.document.getElementById(`nav-question-${natIndex}`).className.includes('marked-review'));
  assert.equal(h.ids['question-nav'].querySelectorAll('#nav-current-legend').length, 1);
  assert.equal(harness.postRequests(h).length, 0);

  // Report entries use the same indicator. Review/Back restores the draft location.
  await harness.editResponse(h, h.data.questions[0].id, h.data.questions[0].options[0].id);
  await h.ids['quiz-form'].fire('submit'); h.flush(); current(h, 0);
  assert.equal(h.ids.report.hidden, false);
  assert.equal(h.ids['quiz-timer'].hidden, true);
  await h.document.getElementById('nav-question-3').click(); h.flush(); current(h, 3);
  assert.ok(h.document.getElementById('result-card-3').scrolled);
  move(h, 5, 20, true); current(h, 5);
  await h.ids['retry-quiz'].click(); h.flush(); current(h, 0);
  assert.equal(h.ids.report.hidden, true);
  await harness.editResponse(h, h.data.questions[1].id, h.data.questions[1].options[0].id);
  await harness.reviewButton(h, h.data.questions[1].id).click();
  await h.document.getElementById('nav-question-4').click(); h.flush(); current(h, 4);
  const draft = h.storage.get(harness.draftKey(h));
  await h.ids['review-attempt'].click(); h.flush(); current(h, 0);
  await h.document.getElementById('nav-question-6').click(); h.flush(); current(h, 6);
  await h.ids['retry-quiz'].click(); h.flush(); current(h, 4);
  assert.equal(h.ids.report.hidden, true);
  assert.equal(h.storage.get(harness.draftKey(h)), draft, 'Review/current tracking leaves the draft unchanged');
  assert.equal(JSON.stringify({ questions: h.data.questions, scoring: h.data.scoring ?? null }), originalSignature);
  assert.equal(harness.postRequests(h).length, 1, 'Only the explicit Submit writes an attempt');
  assert.ok(!draft.includes('currentQuestion'), 'Current location is not persisted in the draft');

  const legacy = JSON.parse(draft); delete legacy.reviewFlags; delete legacy.timer;
  const restored = await load('gate-cse-2018', { storage: [[harness.draftKey(h), JSON.stringify(legacy)]] });
  current(restored, 0);
  assert.deepEqual(Object.keys(restored.t.answers), [h.data.questions[1].id]);
  assert.deepEqual([...restored.t.reviewFlags], []);
  const blank = await load('_template');
  assert.equal(blank.ids['question-nav'].hidden, true);
  assert.equal(blank.ids['nav-groups'].querySelectorAll('[aria-current="location"]').length, 0);
  console.log(`Current-question map checks passed: ${folders.length} quizzes, scroll/focus/map/image/resize/history, flags, reports, Review/Back/Retry and legacy drafts.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
