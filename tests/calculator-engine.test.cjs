const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { evaluate } = require('../_calculator/engine.js');

// Numerical tests only: no requests, browser storage, or submitted attempts.
let checks = 0;
function exact(expression, expected, options) {
  assert.equal(evaluate(expression, options), expected, expression);
  checks += 1;
}
function close(expression, expected, options) {
  const actual = evaluate(expression, options);
  assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${expression}: ${actual} ≈ ${expected}`);
  checks += 1;
}
function rejects(expression, message, options) {
  assert.throws(() => evaluate(expression, options), message, String(expression));
  checks += 1;
}

exact('2 + 3 * 4 - 8 / 2', 10);
exact('(2 + 3) * (4 - 8 / 2)', 0);
exact('2^3^2', 512);
exact('-2^2', -4);
exact('(-2)^2', 4);
exact('2^-2', 0.25);
exact('2^-2^2', 0.0625);
exact('---2', -2);
exact('2--3', 5);
exact('-3!', -6);
exact('2^3!', 64);
exact('3!!', 720);
exact('0!', 1);
exact('1!', 1);
close('170!', 7.257415615307999e306);
exact('17%5', 2);
exact('-17%5', -2);
exact('17%-5', 2);
exact('2(3+4)', 14);
exact('(2+3)(4+1)', 25);
close('2pi', 2 * Math.PI);
close('2π', 2 * Math.PI);
close('2e', 2 * Math.E);
close('2sin(30)', 1);
close('sin(30)cos(60)', 0.25);
close('2/3(2+1)', 2); // Implicit multiplication has normal left-to-right precedence.
exact('1e3 + 2.5e-2 + .5', 1000.525);
exact('.5E+2', 50);
exact('12. + .25', 12.25);
close('PI+E', Math.PI + Math.E);
exact('ans+mem', 12, { ans: 8, memory: 4 });
exact('ans+mem', 0);
exact('ans^2+mem', 7, { ans: -3, memory: -2 });

exact('sqrt(81)', 9);
exact('sqrt(0)', 0);
exact('cbrt(-27)', -3);
exact('abs(-4)', 4);
exact('ln(1)', 0);
close('ln(e)', 1);
exact('log(1000)', 3);
exact('log2(1024)', 10);
exact('exp(0)', 1);
close('exp(1)', Math.E);
close('sin(30)', 0.5);
close('cos(60)', 0.5);
close('tan(45)', 1);
close('sin(-30)', -0.5);
close('sin(390)', 0.5);
close('asin(0.5)', 30);
close('acos(0.5)', 60);
close('atan(1)', 45);
close('asin(-1)', -90);
close('acos(-1)', 180);
close('sin(pi/6)', 0.5, { angleMode: 'RAD' });
close('cos(pi/3)', 0.5, { angleMode: 'RAD' });
close('tan(pi/4)', 1, { angleMode: 'RAD' });
close('asin(0.5)', Math.PI / 6, { angleMode: 'RAD' });
close('acos(0.5)', Math.PI / 3, { angleMode: 'RAD' });
close('atan(1)', Math.PI / 4, { angleMode: 'RAD' });
close('sin(1e16)', 0.7796880066069788, { angleMode: 'RAD' });
close('cos(1e16)', -0.6261681981330862, { angleMode: 'RAD' });
close('tan(89.999999)', 57295779.81445014);
close('sinh(1)', 1.1752011936438014);
close('cosh(1)', 1.5430806348152437);
close('tanh(1)', 0.7615941559557649);
exact('floor(-2.1)', -3);
exact('ceil(-2.1)', -2);
exact('pow(2,10)', 1024);
exact('pow(-2,3)', -8);
exact('root(81,4)', 3);
exact('root(-8,3)', -2);
exact('root(-8,-3)', -0.5);
exact('root(0,3)', 0);
exact('root(4,0.5)', 16);
exact('ncr(5,2)', 10);
exact('ncr(11,5)', 462);
exact('ncr(56,28)', 7648690600760440);
exact('ncr(63,19)', 6131164307078475);
exact('ncr(52,5)', 2598960);
exact('ncr(0,0)', 1);
exact('ncr(10000,9999)', 10000);
exact('npr(5,2)', 20);
exact('npr(0,0)', 1);
exact('npr(10000,0)', 1);
exact('npr(10000,1)', 10000);
close('ncr(100,50)', 1.008913445455642e29);
exact('sqrt(pow(3,2)+pow(4,2))', 5);
exact('ncr(3+2,1+1)', 10);

for (const expression of ['1/0', '0/0', '1/-0', '1%0', '1%(2-2)']) rejects(expression, /zero/);
for (const expression of ['0^0', '0^-1', 'pow(0,0)', 'pow(0,-1)']) rejects(expression, /positive exponent/);
for (const expression of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'log2(-1)', 'asin(1.01)', 'acos(-1.01)', '(-2)^0.5', 'pow(-2,.5)', 'root(-2,2)', 'root(-2,2.5)', 'root(1,0)', 'root(0,-1)']) rejects(expression, /needs|degree/);
for (const expression of ['171!', '(-1)!', '2.5!']) rejects(expression, /Factorial/);
for (const expression of ['ncr(2,3)', 'ncr(-1,0)', 'ncr(2,-1)', 'ncr(2.5,1)', 'npr(3,1.5)', 'npr(10001,0)']) rejects(expression, /integers/);
for (const expression of ['tan(90)', 'tan(-90)', 'tan(270)', 'tan(450)']) rejects(expression, /undefined/);
for (const expression of ['tan(pi/2)', 'tan(-pi/2)', 'tan(3*pi/2)']) rejects(expression, /undefined/, { angleMode: 'RAD' });
for (const expression of ['1e309', '10^1000', 'exp(1000)', 'cosh(1000)', 'ncr(10000,5000)', 'npr(10000,10000)', '1e308+1e308', '1e308*2']) rejects(expression, /finite/);

for (const expression of ['', ' ', '.', '1..2', '1 2', '1e+', '1e--3', '2+', '2**3', '2//3', '()', '(2', '2)', '1,2', 'sin 30', 'sin()', 'sin(1,2)', 'pow(2)', 'pow(2,3,4)', 'log2()', 'unknown(1)', 'NaN', 'Infinity', '0xff', '2&1', '2|1', '[1]', '{1}', '1=2', '1;2', 'alert(1)', 'constructor(1)', 'toString(1)', '__proto__', 'Math.sin(1)', 'window.location', 'ans.valueOf()', 'this', '`1`', '"1"', '<script>']) rejects(expression, /./);
rejects(null, /Enter/);
rejects(1, /Enter/);
rejects('1', /settings/, null);
rejects('1', /settings/, []);
rejects('1', /Angle mode/, { angleMode: 'rad' });
rejects('ans', /finite numbers/, { ans: Infinity });
rejects('mem', /finite numbers/, { memory: '1' });
rejects('1', /finite numbers/, { ans: NaN });
rejects(' '.repeat(1025), /too long/);
rejects(Array(258).fill('1').join('+'), /too many terms/);
rejects('('.repeat(65) + '1' + ')'.repeat(65), /nested too deeply/);
rejects('-'.repeat(65) + '1', /nested too deeply/);
rejects(Array(65).fill('1').join('^'), /nested too deeply/);
exact(Array(256).fill('1').join('+'), 256);
exact('('.repeat(63) + '1' + ')'.repeat(63), 1);
exact(Array(64).fill('1').join('^'), 1);
assert.equal(Object.is(evaluate('-0'), -0), false);
checks += 1;

// The exact same file supplies the browser API without dynamic code execution.
const source = fs.readFileSync(path.join(__dirname, '..', '_calculator', 'engine.js'), 'utf8');
assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\b/);
const window = {};
vm.runInNewContext(source, { window }, { timeout: 1000 });
assert.equal(window.QuizCalculatorEngine.evaluate('2^3^2'), 512);
assert.ok(Object.isFrozen(window.QuizCalculatorEngine));
checks += 3;

console.log(`Scientific calculator engine: ${checks} checks passed.`);
