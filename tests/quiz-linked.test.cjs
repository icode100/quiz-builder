const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createServer } = require('../server.cjs');

// Small DOM for checking the real report and linked instructions. All responses,
// submissions and server files in this test are simulated or disposable.
class Element {
  constructor(tag = 'div') {
    Object.assign(this, { tag, children: [], attrs: {}, className: '', textContent: '', hidden: false });
    this.classList = { toggle: (name, on) => {
      const names = this.className.split(' ').filter(Boolean).filter(value => value !== name);
      if (on) names.push(name);
      this.className = names.join(' ');
    } };
  }
  append(...nodes) { nodes.forEach(node => this.children.push(...(node.tag === '#fragment' ? node.children : [node]))); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener() {}
  focus() {} scrollIntoView() {} click() {} remove() {}
  querySelectorAll(selector) {
    return this.children.flatMap(node => [
      ...(selector.split(',').some(value => value.trim().startsWith('.') ? node.className.split(' ').includes(value.trim().slice(1)) : value.trim() === node.tag) ? [node] : []),
      ...node.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const textOf = node => [node.textContent, ...node.children.map(textOf)].join(' ');
const runtimeSource = fs.readFileSync(path.join(__dirname, '../_template/quiz.js'), 'utf8').replace(/\r\n/g, '\n');
const marker = '  try {\n    validate();';
assert(runtimeSource.includes(marker));
function harness(data) {
  const ids = {}, body = new Element('body'), shell = new Element();
  shell.className = 'quiz-shell'; body.append(shell);
  const html = fs.readFileSync(path.join(__dirname, '../_template/index.html'), 'utf8');
  for (const match of html.matchAll(/<([a-z]+)[^>]*id="([^"]+)"[^>]*>/g)) {
    ids[match[2]] = new Element(match[1]); ids[match[2]].id = match[2]; body.append(ids[match[2]]);
  }
  const find = (node, id) => node.id === id ? node : node.children.map(child => find(child, id)).find(Boolean);
  const document = { body, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('#fragment'),
    getElementById: id => ids[id] || find(body, id), querySelector: selector => selector === '.quiz-shell' ? shell : body.querySelector(selector) };
  let reportBlob;
  const context = { window: { QUIZ_DATA: structuredClone(data) }, document, Blob, console, setTimeout() {},
    URL: class extends URL { static createObjectURL(blob) { reportBlob = blob; return 'blob:test-report'; } static revokeObjectURL() {} } };
  vm.createContext(context);
  vm.runInContext(runtimeSource.slice(0, runtimeSource.indexOf(marker)) + `
    window.test = { validate, grade, summarize, answers, renderQuestions, renderReport, downloadReport, attemptSnapshot,
      prepareSubmission() { submittedAt = updatedAt = '2026-10-15T00:00:00.000Z'; signature = JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }); }
    };
  })();`, context);
  return { ...context.window.test, ids, data: context.window.QUIZ_DATA, document, reportBlob: () => reportBlob };
}
const options = ['A', 'B', 'C', 'D'].map(id => ({ id, text: `Option ${id}` }));
const data = { id: 'linked-test', title: 'Linked answer fixture', questions: [
  { id: 'CS-57', displayLabel: 'CS 57', text: 'First linked question', type: 'mcq', options, correctAnswer: 'D', marks: 2, incorrectMarks: -2 / 3 },
  { id: 'CS-58', displayLabel: 'CS 58', text: 'Second linked question', type: 'mcq', options, correctAnswer: 'A', marks: 2, incorrectMarks: 0, requiresCorrect: 'CS-57' },
  { id: 'CS-59', displayLabel: 'CS 59', text: 'First linked question', type: 'mcq', options, correctAnswer: 'C', marks: 2, incorrectMarks: -2 / 3 },
  { id: 'CS-60', displayLabel: 'CS 60', text: 'Second linked question', type: 'mcq', options, correctAnswer: 'D', marks: 2, incorrectMarks: 0, requiresCorrect: 'CS-59' }
] };
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-linked-test-'));
  const folder = path.join(root, 'gate-linked');
  const server = createServer({ root, port: 0 });
  try {
    await fsp.mkdir(folder);
    await fsp.writeFile(path.join(folder, 'index.html'), '<title>Linked answer fixture</title>');
    const writeData = key => fsp.writeFile(path.join(folder, 'quiz-data.js'), `window.QUIZ_DATA = ${JSON.stringify(key)};`);
    await writeData(data);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const home = () => new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port, path: '/' }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(body));
      }); request.on('error', reject);
    });
    let checks = 0;
    for (const [firstIndex, secondIndex] of [[0, 1], [2, 3]]) {
      const first = data.questions[firstIndex], second = data.questions[secondIndex];
      for (const firstState of ['blank', 'correct', 'wrong']) for (const secondState of ['blank', 'correct', 'wrong']) {
        const h = harness(data); h.validate();
        if (firstState !== 'blank') h.answers[first.id] = firstState === 'correct' ? first.correctAnswer : 'B';
        if (secondState !== 'blank') h.answers[second.id] = secondState === 'correct' ? second.correctAnswer : 'B';
        h.renderQuestions();
        assert.match(textOf(h.document.getElementById(`question-card-${secondIndex}`)), /Evaluated only if question CS (57|59) is correct\. No negative marking/);
        const result = h.grade(), summary = h.summarize(result);
        const blocked = firstState !== 'correct' && secondState !== 'blank';
        const expected = (firstState === 'correct' ? 2 : firstState === 'wrong' ? -2 / 3 : 0) + (firstState === 'correct' && secondState === 'correct' ? 2 : 0);
        close(summary.score, expected); assert.equal(summary.maximum, 8);
        assert.equal(result[secondIndex].outcome, secondState === 'blank' ? 'unanswered' : blocked ? 'blocked' : secondState === 'correct' ? 'correct' : 'incorrect');
        assert.equal(result[secondIndex].earned, firstState === 'correct' && secondState === 'correct' ? 2 : 0);
        assert.equal(summary.counts.blocked || 0, Number(blocked));
        if (blocked) assert.match(result[secondIndex].reason, new RegExp(`question CS ${first.number || first.id.slice(3)} was incorrect or unanswered`));
        else assert.equal(Object.hasOwn(result[secondIndex], 'reason'), false);
        h.prepareSubmission(); h.renderReport(false);
        const report = textOf(h.document.getElementById(`result-card-${secondIndex}`));
        assert.match(report, /Your answer:.*Correct answer:/);
        if (blocked) assert.match(report, /Not evaluated · 0 \/ 2 marks.*was incorrect or unanswered/);
        const attempt = h.attemptSnapshot();
        assert.equal(attempt.results[secondIndex].outcome, result[secondIndex].outcome);
        assert.equal(attempt.results[secondIndex].reason, result[secondIndex].reason);
        h.downloadReport();
        const savedReport = await h.reportBlob().text();
        if (blocked) assert.match(savedReport, /Not evaluated: 1[\s\S]*Not evaluated because question CS (57|59) was incorrect or unanswered\./);
        // Home scores must ignore forged stored totals and result outcomes.
        attempt.summary.score = 999; attempt.results.forEach(item => { item.marksEarned = 999; item.outcome = 'correct'; });
        await fsp.writeFile(path.join(folder, 'attempt.json'), JSON.stringify(attempt));
        const html = await home();
        const formatted = Number(expected.toFixed(4));
        if (Object.keys(h.answers).length) assert(html.includes(`Last score: ${formatted} / 8`), html);
        else assert.match(html, /Not attempted/);
        checks++;
      }
    }
    const invalidRules = [
      key => { key.questions[1].requiresCorrect = 'unknown'; },
      key => { key.questions[1].requiresCorrect = 'CS-58'; },
      key => { key.questions[1].requiresCorrect = 'CS-59'; },
      key => { key.questions[1].requiresCorrect = null; },
      key => { key.questions[1].incorrectMarks = -2 / 3; },
      key => { key.questions[1].marksToAll = true; },
      key => { key.questions[0].marksToAll = true; },
      key => { key.questions[0].type = 'msq'; key.questions[0].correctAnswers = ['D']; },
      key => { key.questions[1].type = 'nat'; key.questions[1].correctRanges = [{ min: 1, max: 1 }]; },
      key => { key.questions[3].requiresCorrect = 'CS-58'; }
    ];
    for (const change of invalidRules) {
      const key = structuredClone(data); change(key);
      assert.throws(() => harness(key).validate(), /linked-answer rules/);
      await writeData(key);
      // No grading needed: an attempted record with a matching signature must
      // still lose its score when the verified key has invalid dependencies.
      const attempt = { version: 1, quizId: key.id, quizSignature: JSON.stringify({ questions: key.questions, scoring: null }), answers: { 'CS-57': 'D' }, submittedAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', summary: {}, results: [] };
      await fsp.writeFile(path.join(folder, 'attempt.json'), JSON.stringify(attempt));
      assert.match(await home(), /Last score unavailable/);
    }
    await writeData(data);
    for (const response of ['unknown', [], 1, {}]) {
      const attempt = { version: 1, quizId: data.id, quizSignature: JSON.stringify({ questions: data.questions, scoring: null }), answers: { 'CS-57': 'B', 'CS-58': response }, submittedAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', summary: {}, results: [] };
      await fsp.writeFile(path.join(folder, 'attempt.json'), JSON.stringify(attempt));
      assert.match(await home(), /Last score unavailable/, 'Blocked responses still require validation');
    }
    console.log(`PASS: ${checks} linked-pair blank/correct/wrong combinations across runtime and temporary server, zero blocked marks/reasons/reports/downloads, no second-answer penalty, forged-score recomputation, dependency validation, malformed blocked responses. No real attempts touched.`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()), 'Cleanup stays in the temporary directory');
    assert(path.basename(root).startsWith('quiz-linked-test-'), 'Cleanup targets only the fixture created by this test');
    await fsp.rm(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
