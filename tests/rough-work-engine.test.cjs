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
same(engine.limits, { strokes: 1000, pointsPerStroke: 10000, totalPoints: 100000, paperHeight: 50000, canvasPixels: 4000000 });
assert.ok(Object.isFrozen(engine) && Object.isFrozen(engine.colors) && Object.isFrozen(engine.widths) && Object.isFrozen(engine.limits)); checks++;
const darkColors = ['#e8eefb', '#8ba7ff', '#fb7185', '#4ade80', '#fbbf24'];
same(engine.colors.map(color => engine.inkColor(color)), engine.colors);
same(engine.colors.map(color => engine.inkColor(color, 'light')), engine.colors);
same(engine.colors.map(color => engine.inkColor(color, 'dark')), darkColors);
for (const theme of ['light', 'dark']) for (const color of [null, undefined, '', 'red', '#fff', '#17233B', ...darkColors, {}, 1]) {
  assert.throws(() => engine.inkColor(color, theme), /ink color/); checks++;
}
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

// Legacy stroke tokens render in either theme without changing their data,
// geometry, compositing or opacity. Theme changes can be reversed freely.
const themedDrawing = engine.tools.flatMap((tool, toolIndex) => engine.colors.map((color, index) =>
  stroke({ tool, color, width: engine.widths[index % engine.widths.length], points: index % 2 ? [[0.3, 0.7]] : [[0.1, 0.2], [0.8, 0.9]], })));
const originalThemedDrawing = copy(themedDrawing), themeInk = {};
for (const theme of ['light', 'dark']) {
  const canvas = canvasContext(), before = canvas.state();
  engine.draw(canvas.context, themedDrawing, 500, 1250, theme);
  same(canvas.operations.map(item => item.strokeStyle), themedDrawing.map(item => engine.inkColor(item.color, theme)));
  same(canvas.operations.map(item => item.fillStyle), themedDrawing.map(item => engine.inkColor(item.color, theme)));
  same(canvas.operations.map(item => item.globalAlpha), themedDrawing.map(item => item.tool === 'highlighter' ? 0.25 : 1));
  same(canvas.operations.map(item => item.globalCompositeOperation), themedDrawing.map(item => item.tool === 'eraser' ? 'destination-out' : 'source-over'));
  same(canvas.state(), before);
  assert.equal(canvas.depth(), 0); checks++;
  themeInk[theme] = canvas.operations.map(({ strokeStyle, fillStyle, ...geometry }) => geometry);
}
same(themeInk.dark, themeInk.light);
same(themedDrawing, originalThemedDrawing);
same(engine.validateStrokes(themedDrawing), originalThemedDrawing);
const themeReplay = canvasContext();
for (const theme of ['light', 'dark', 'light']) engine.draw(themeReplay.context, themedDrawing, 500, 1250, theme);
same(themeReplay.operations.slice(0, themedDrawing.length), themeReplay.operations.slice(-themedDrawing.length));
same(themedDrawing, originalThemedDrawing);

// Unknown themes must fail before clearing the existing drawing or paper.
for (const theme of [null, '', 'Dark', 'LIGHT', 'system', '__proto__', 'constructor', true, 1, NaN, [], {}]) {
  assert.throws(() => engine.inkColor(engine.colors[0], theme), /theme/); checks++;
  const invalidInk = canvasContext(), beforeInk = invalidInk.state();
  assert.throws(() => engine.draw(invalidInk.context, drawing, 500, 625, theme), /theme/);
  same(invalidInk.calls, []);
  same(invalidInk.state(), beforeInk);
  for (const style of engine.paperStyles) {
    const invalidPaper = canvasContext(), beforePaper = invalidPaper.state();
    assert.throws(() => engine.drawPaper(invalidPaper.context, style, 500, 625, 1250, theme), /theme/);
    same(invalidPaper.calls, []);
    same(invalidPaper.state(), beforePaper);
  }
}

// Notebook patterns are a separate opaque backdrop. Their operation counts
// depend only on the bounded logical page, never the supplied canvas dimensions.
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

// Growing the paper adds rows instead of stretching the original guides. At
// proportional display dimensions, horizontal and vertical gaps stay equal.
for (const style of engine.paperStyles) {
  const tallPaper = canvasContext(), before = tallPaper.state();
  engine.drawPaper(tallPaper.context, style, 500, 1250, 2500);
  same(tallPaper.operations[0].args, [0, 0, 500, 1250]);
  same(tallPaper.state(), before);
  assert.equal(tallPaper.depth(), 0); checks++;
  if (style === 'blank') { assert.equal(tallPaper.operations.length, 1); checks++; continue; }
  const pattern = tallPaper.operations[1];
  if (style === 'dotted') {
    const dots = pattern.path.filter(item => item[0] === 'arc');
    assert.equal(dots.length, 1000); checks++;
    same(dots[0], ['arc', 12.5, 12.5, 1.5, 0, Math.PI * 2]);
    same(dots.at(-1), ['arc', 487.5, 1237.5, 1.5, 0, Math.PI * 2]);
    assert.equal(dots[1][2] - dots[0][2], dots[50][1] - dots[0][1]); checks++;
  } else {
    const lines = pattern.path.filter(item => item[0] === 'lineTo');
    assert.equal(lines.length, style === 'grid' ? 68 : 49); checks++;
    same(pattern.path.slice(0, 4), [['moveTo', 0, 25], ['lineTo', 500, 25], ['moveTo', 0, 50], ['lineTo', 500, 50]]);
    same(pattern.path.slice(96, 98), [['moveTo', 0, 1225], ['lineTo', 500, 1225]]);
    assert.equal(pattern.lineWidth, 1.25); checks++;
    if (style === 'grid') same(pattern.path.slice(-2), [['moveTo', 475, 0], ['lineTo', 475, 1250]]);
  }
}
const maximumPaper = canvasContext();
engine.drawPaper(maximumPaper.context, 'dotted', 100000000, 5000000000, engine.limits.paperHeight);
assert.equal(maximumPaper.operations[1].path.filter(item => item[0] === 'arc').length, 20000); checks++;
const maximumGrid = canvasContext();
engine.drawPaper(maximumGrid.context, 'grid', 1000, 50000, engine.limits.paperHeight);
assert.equal(maximumGrid.operations[1].path.filter(item => item[0] === 'lineTo').length, 1018); checks++;
same(maximumGrid.operations[1].path.slice(1996, 1998), [['moveTo', 0, 49950], ['lineTo', 1000, 49950]]);
const fractionalHeight = canvasContext();
engine.drawPaper(fractionalHeight.context, 'blank', 500, 625.25, 1250.5);
same(fractionalHeight.operations[0].args, [0, 0, 500, 625.25]);
for (const logicalHeight of [null, '', '1250', true, [], {}, NaN, Infinity, -Infinity, 0, 1249.99, engine.limits.paperHeight + 0.01, Number.MAX_VALUE]) {
  for (const style of engine.paperStyles) {
    const invalidHeight = canvasContext();
    assert.throws(() => engine.drawPaper(invalidHeight.context, style, 1000, 1250, logicalHeight), /paper height/);
    assert.equal(invalidHeight.calls.length, 0, 'Invalid logical height cannot clear or repaint existing paper'); checks++;
  }
}
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

// Paper colors follow the theme while guide geometry, sizes and resource
// counts stay identical, including expanded pages and the height boundary.
for (const logicalHeight of [1250, 2500, engine.limits.paperHeight]) for (const style of engine.paperStyles) {
  const light = canvasContext(), dark = canvasContext(), before = dark.state();
  engine.drawPaper(light.context, style, 500, logicalHeight / 2, logicalHeight, 'light');
  engine.drawPaper(dark.context, style, 500, logicalHeight / 2, logicalHeight, 'dark');
  assert.equal(dark.operations[0].fillStyle, '#111827'); checks++;
  same(dark.operations[0].args, light.operations[0].args);
  same(dark.operations.map(item => [item.globalAlpha, item.globalCompositeOperation]), light.operations.map(item => [item.globalAlpha, item.globalCompositeOperation]));
  same(dark.state(), before);
  assert.equal(dark.depth(), 0); checks++;
  if (style === 'blank') { assert.equal(dark.operations.length, 1); checks++; continue; }
  const guides = dark.operations[1], lightGuides = light.operations[1];
  assert.equal(style === 'dotted' ? guides.fillStyle : guides.strokeStyle, style === 'dotted' ? '#64748b' : '#44546c'); checks++;
  same(guides.path, lightGuides.path);
  assert.equal(guides.lineWidth, lightGuides.lineWidth); checks++;
}

// The same script loads without CommonJS, DOM, canvas or storage globals.
const browser = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../_template/rough-work-engine.js'), 'utf8'), browser);
assert.equal(typeof browser.RoughWorkEngine.validateStrokes, 'function'); checks++;
assert.equal(typeof browser.RoughWorkEngine.drawPaper, 'function'); checks++;
assert.equal(browser.RoughWorkEngine.inkColor('#17233b', 'dark'), '#e8eefb'); checks++;
same(copy(browser.RoughWorkEngine.validateStrokes([onePoint])), [onePoint]);
console.log(`Rough-work engine checks passed: ${checks} validation, resource bounds, immutable vectors, theme-aware ink and expandable paper, scaled rendering, highlighter alpha, transparent erasing and context restoration. No real data touched.`);
