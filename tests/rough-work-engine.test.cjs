const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('../_template/rough-work-engine.js');

// All vectors and canvas calls are synthetic. No quiz responses, browser
// storage, submitted attempts, original papers or assets are touched.
const copy = value => JSON.parse(JSON.stringify(value));
const stroke = (extra = {}) => ({ tool: 'pen', color: '#17233b', width: 4, points: [[0, 0], [0.5, 0.25], [1, 1]], ...extra });
let checks = 0;
function rejects(value) { assert.throws(() => engine.validateStrokes(value), /rough-work/); checks++; }
function same(actual, expected) { assert.deepEqual(actual, expected); checks++; }

same(engine.colors, ['#17233b', '#4169e1', '#dc2626', '#15803d', '#f59e0b']);
same(engine.widths, [2, 4, 8, 16]);
same(engine.tools, ['pen', 'highlighter', 'eraser']);
same(engine.paperStyles, ['blank', 'dotted', 'ruled', 'grid']);
same(engine.paper, { width: 1000, height: 1250 });
same(engine.limits, { strokes: 1000, pointsPerStroke: 10000, totalPoints: 100000 });
assert.ok(Object.isFrozen(engine) && Object.isFrozen(engine.colors) && Object.isFrozen(engine.widths) && Object.isFrozen(engine.limits)); checks++;
same(engine.validateStrokes([]), []);
for (const tool of engine.tools) for (const color of engine.colors) for (const width of engine.widths) {
  const input = [stroke({ tool, color, width })];
  same(engine.validateStrokes(input), input);
}
const input = [stroke()];
const restored = engine.validateStrokes(input);
assert.notEqual(restored, input); assert.notEqual(restored[0], input[0]);
assert.notEqual(restored[0].points, input[0].points); assert.notEqual(restored[0].points[0], input[0].points[0]);
restored[0].points[0][0] = 0.75; restored[0].color = '#dc2626';
same(input, [stroke()]);
input[0].points[1][1] = 0.9;
assert.equal(restored[0].points[1][1], 0.25); checks++;

for (const value of [undefined, null, {}, '', 1, true, [null], [[]], [1], new Array(1)]) rejects(value);
for (const field of ['tool', 'color', 'width', 'points']) {
  const missing = stroke(); delete missing[field]; rejects([missing]);
}
for (const tool of ['', 'text', 'Pen', null, 1, {}]) rejects([stroke({ tool })]);
for (const color of ['', '#fff', '#FFFFFF', 'red', 'transparent', '#17233B', null, 1, {}]) rejects([stroke({ color })]);
for (const width of [0, -1, 3, 0.5, 32, '4', NaN, Infinity, null, {}]) rejects([stroke({ width })]);
for (const points of [null, {}, '', [], [null], [[]], [[0]], [[0, 0, 0]], [[0, '0']], [['0', 0]], [[0, NaN]], [[Infinity, 0]], [[0, -Infinity]], [[-0.01, 0]], [[0, 1.001]], new Array(1), [new Array(2)]]) rejects([stroke({ points })]);
rejects([stroke({ extra: 'discarding fields would hide malformed data' })]);
rejects([JSON.parse('{"tool":"pen","color":"#17233b","width":4,"points":[[0,0]],"__proto__":{}}')]);
same(engine.validateStrokes([stroke({ points: [[0, 1], [1, 0], [0, 0], [1, 1]] })])[0].points, [[0, 1], [1, 0], [0, 0], [1, 1]]);
same(engine.validateStrokes([stroke({ points: [[0.5, 0.5]] })])[0].points, [[0.5, 0.5]]);
same(engine.validateStrokes([stroke({ points: [[0.1, 0.1], [0.1, 0.1]] })])[0].points, [[0.1, 0.1], [0.1, 0.1]]);

// Each independent cap accepts its boundary and rejects immediately beyond it.
const onePoint = stroke({ points: [[0, 0]] });
assert.equal(engine.validateStrokes(Array.from({ length: engine.limits.strokes }, () => onePoint)).length, engine.limits.strokes); checks++;
rejects(Array.from({ length: engine.limits.strokes + 1 }, () => onePoint));
const maxPoints = Array.from({ length: engine.limits.pointsPerStroke }, (_, index) => [index / engine.limits.pointsPerStroke, 0.5]);
assert.equal(engine.validateStrokes([stroke({ points: maxPoints })])[0].points.length, engine.limits.pointsPerStroke); checks++;
rejects([stroke({ points: [...maxPoints, [1, 1]] })]);
const maxPage = Array.from({ length: engine.limits.totalPoints / engine.limits.pointsPerStroke }, () => stroke({ points: maxPoints }));
assert.equal(engine.validateStrokes(maxPage).flatMap(item => item.points).length, engine.limits.totalPoints); checks++;
rejects([...maxPage, onePoint]);

function canvasContext() {
  let state = { globalAlpha: 0.6, globalCompositeOperation: 'xor', strokeStyle: 'old-stroke', fillStyle: 'old-fill', lineWidth: 99, lineCap: 'square', lineJoin: 'bevel' };
  const stack = [], calls = [], operations = [];
  let path = [];
  const context = {
    save() { stack.push({ ...state }); calls.push(['save']); },
    restore() { state = stack.pop(); calls.push(['restore']); },
    setTransform(...args) { calls.push(['setTransform', ...args]); },
    clearRect(...args) { calls.push(['clearRect', ...args]); },
    beginPath() { path = []; calls.push(['beginPath']); },
    moveTo(...args) { path.push(['moveTo', ...args]); },
    lineTo(...args) { path.push(['lineTo', ...args]); },
    arc(...args) { path.push(['arc', ...args]); },
    fillRect(...args) { operations.push({ method: 'fillRect', args, ...state }); calls.push(['fillRect', ...args]); },
    stroke() { operations.push({ method: 'stroke', path: copy(path), ...state }); calls.push(['stroke']); },
    fill() { operations.push({ method: 'fill', path: copy(path), ...state }); calls.push(['fill']); }
  };
  for (const key of Object.keys(state)) Object.defineProperty(context, key, { get: () => state[key], set: value => { state[key] = value; } });
  return { context, calls, operations, state: () => ({ ...state }), depth: () => stack.length };
}
const drawing = [
  stroke({ color: '#4169e1', width: 2 }),
  stroke({ tool: 'highlighter', color: '#f59e0b', width: 16, points: [[0.1, 0.8], [0.2, 0.8], [0.4, 0.8], [0.3, 0.8]] }),
  stroke({ tool: 'eraser', width: 8, points: [[0, 1], [1, 0]] }),
  stroke({ tool: 'pen', color: '#dc2626', width: 4, points: [[0.5, 0.5]] }),
  stroke({ tool: 'highlighter', color: '#15803d', width: 8, points: [[0.2, 0.3]] }),
  stroke({ tool: 'eraser', width: 16, points: [[1, 1]] })
];
const beforeDrawing = copy(drawing), tracked = canvasContext(), initial = tracked.state();
engine.draw(tracked.context, drawing, 500, 625);
same(drawing, beforeDrawing);
same(tracked.calls[0], ['save']);
same(tracked.calls[1], ['setTransform', 1, 0, 0, 1, 0, 0]);
same(tracked.calls[2], ['clearRect', 0, 0, 500, 625]);
same(tracked.calls.at(-1), ['restore']);
same(tracked.state(), initial); assert.equal(tracked.depth(), 0); checks++;
same(tracked.operations.map(item => item.method), ['stroke', 'stroke', 'stroke', 'fill', 'fill', 'fill']);
same(tracked.operations.map(item => item.globalCompositeOperation), ['source-over', 'source-over', 'destination-out', 'source-over', 'source-over', 'destination-out']);
same(tracked.operations.map(item => item.globalAlpha), [1, 0.25, 1, 1, 0.25, 1]);
same(tracked.operations.map(item => item.lineWidth), [1, 8, 4, 2, 4, 8]);
same(tracked.operations[0].path, [['moveTo', 0, 0], ['lineTo', 250, 156.25], ['lineTo', 500, 625]]);
same(tracked.operations[1].path, [['moveTo', 50, 500], ['lineTo', 100, 500], ['lineTo', 200, 500], ['lineTo', 150, 500]]);
same(tracked.operations[2].path, [['moveTo', 0, 625], ['lineTo', 500, 0]]);
same(tracked.operations[3].path, [['arc', 250, 312.5, 1, 0, Math.PI * 2]]);
assert.ok(tracked.operations.every(item => item.lineCap === 'round' && item.lineJoin === 'round')); checks++;
assert.equal(tracked.operations.filter(item => item.strokeStyle === '#f59e0b').length, 1, 'A highlighter is composited once for its continuous path'); checks++;

// Replaying a page clears the prior image, including an emptied or undone page.
const replay = canvasContext();
engine.draw(replay.context, drawing, 1000, 1250);
engine.draw(replay.context, [], 1000, 1250);
assert.equal(replay.calls.filter(call => call[0] === 'clearRect').length, 2); checks++;
same(replay.operations[0].path, [['moveTo', 0, 0], ['lineTo', 500, 312.5], ['lineTo', 1000, 1250]]);
const noTransform = canvasContext(); delete noTransform.context.setTransform;
engine.draw(noTransform.context, [onePoint], 1000, 1250);
assert.equal(noTransform.operations[0].method, 'fill'); checks++;
for (const [width, height] of [[0, 1], [1, -1], [Infinity, 1], [1, NaN], ['500', 625]]) {
  const invalid = canvasContext();
  assert.throws(() => engine.draw(invalid.context, [], width, height), /canvas/);
  assert.equal(invalid.calls.length, 0); checks++;
}
const invalidVectors = canvasContext();
assert.throws(() => engine.draw(invalidVectors.context, [stroke({ points: [[2, 0]] })], 1000, 1250), /rough-work/);
assert.equal(invalidVectors.calls.length, 0, 'Malformed notes cannot clear the visible page'); checks++;
const failed = canvasContext(), failState = failed.state();
failed.context.stroke = () => { throw new Error('Synthetic renderer failure'); };
assert.throws(() => engine.draw(failed.context, [stroke()], 1000, 1250), /Synthetic/);
same(failed.state(), failState); assert.equal(failed.depth(), 0); checks++;

// Notebook patterns are a separate opaque backdrop. Their operation counts
// depend only on the fixed virtual page, never the supplied canvas dimensions.
for (const style of engine.paperStyles) {
  const trackedPaper = canvasContext(), paperBefore = trackedPaper.state();
  engine.drawPaper(trackedPaper.context, style, 500, 625);
  same(trackedPaper.calls.slice(0, 4), [['save'], ['setTransform', 1, 0, 0, 1, 0, 0], ['clearRect', 0, 0, 500, 625], ['fillRect', 0, 0, 500, 625]]);
  const background = trackedPaper.operations[0];
  assert.equal(background.method, 'fillRect');
  assert.equal(background.fillStyle, '#fff');
  assert.equal(background.globalCompositeOperation, 'source-over');
  assert.equal(background.globalAlpha, 1); checks++;
  same(trackedPaper.state(), paperBefore);
  assert.equal(trackedPaper.depth(), 0); checks++;
  if (style === 'blank') { assert.equal(trackedPaper.operations.length, 1); checks++; continue; }
  const pattern = trackedPaper.operations[1];
  assert.equal(pattern.globalCompositeOperation, 'source-over'); assert.equal(pattern.globalAlpha, 1); checks++;
  if (style === 'dotted') {
    assert.equal(pattern.method, 'fill'); assert.equal(pattern.fillStyle, '#8fa3bd');
    assert.equal(pattern.path.filter(item => item[0] === 'arc').length, 500); checks++;
    same(pattern.path.slice(0, 2), [['moveTo', 14, 12.5], ['arc', 12.5, 12.5, 1.5, 0, Math.PI * 2]]);
    same(pattern.path.at(-1), ['arc', 487.5, 612.5, 1.5, 0, Math.PI * 2]);
  } else {
    assert.equal(pattern.method, 'stroke'); assert.equal(pattern.strokeStyle, '#b0c0d4');
    assert.equal(pattern.lineWidth, 1.25); checks++;
    assert.equal(pattern.path.filter(item => item[0] === 'lineTo').length, style === 'grid' ? 43 : 24); checks++;
    same(pattern.path.slice(0, 2), [['moveTo', 0, 25], ['lineTo', 500, 25]]);
    same(pattern.path.slice(46, 48), [['moveTo', 0, 600], ['lineTo', 500, 600]]);
    if (style === 'grid') same(pattern.path.slice(-2), [['moveTo', 475, 0], ['lineTo', 475, 625]]);
  }
}
const largePaper = canvasContext();
engine.drawPaper(largePaper.context, 'dotted', 100000000, 125000000);
assert.equal(largePaper.operations[1].path.filter(item => item[0] === 'arc').length, 500); checks++;
assert.equal(largePaper.operations[1].path[1][3], 300000); checks++;
for (const style of [undefined, null, '', 'Grid', 'lined', [], {}, 1]) {
  const invalidPaper = canvasContext();
  assert.throws(() => engine.drawPaper(invalidPaper.context, style, 1000, 1250), /paper/);
  assert.equal(invalidPaper.calls.length, 0); checks++;
}
for (const [width, height] of [[0, 1], [1, -1], [Infinity, 1], [1, NaN], ['500', 625]]) {
  const invalidPaper = canvasContext();
  assert.throws(() => engine.drawPaper(invalidPaper.context, 'blank', width, height), /canvas/);
  assert.equal(invalidPaper.calls.length, 0); checks++;
}
const paperFailure = canvasContext(), stateBeforePaperFailure = paperFailure.state();
paperFailure.context.fillRect = () => { throw new Error('Synthetic paper failure'); };
assert.throws(() => engine.drawPaper(paperFailure.context, 'blank', 1000, 1250), /Synthetic paper failure/);
same(paperFailure.state(), stateBeforePaperFailure); assert.equal(paperFailure.depth(), 0); checks++;
const paperWithoutTransform = canvasContext(); delete paperWithoutTransform.context.setTransform;
engine.drawPaper(paperWithoutTransform.context, 'blank', 1000, 1250);
assert.equal(paperWithoutTransform.operations[0].method, 'fillRect'); checks++;

// The same script loads without CommonJS, DOM, canvas or storage globals.
const browser = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../_template/rough-work-engine.js'), 'utf8'), browser);
assert.equal(typeof browser.RoughWorkEngine.validateStrokes, 'function'); checks++;
assert.equal(typeof browser.RoughWorkEngine.drawPaper, 'function'); checks++;
same(copy(browser.RoughWorkEngine.validateStrokes([onePoint])), [onePoint]);
console.log(`Rough-work engine checks passed: ${checks} validation, resource bounds, immutable vectors, scaled rendering, highlighter alpha, transparent erasing, blank/dotted/ruled/grid paper and context restoration. No real data touched.`);
