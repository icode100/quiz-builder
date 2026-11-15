'use strict';
// One-time local migration. Never uploaded or included in the public build.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, 'tmp/cloud-migration/submitted-attempts.json');
const entries = [];
for (const item of fs.readdirSync(root, { withFileTypes: true })) {
  if (!item.isDirectory() || !/^gate-cse-/.test(item.name)) continue;
  const folder = path.join(root, item.name), file = path.join(folder, 'attempt.json');
  if (!fs.existsSync(file)) continue;
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error(`Not a regular attempt file: ${item.name}`);
  const source = fs.readFileSync(path.join(folder, 'quiz-data.js'), 'utf8');
  const data = JSON.parse(vm.runInNewContext(source + '\n;JSON.stringify(window.QUIZ_DATA)', { window: {} }, { timeout: 200, contextCodeGeneration: { strings: false, wasm: false } }));
  const value = fs.readFileSync(file, 'utf8'), saved = JSON.parse(value);
  if (saved.version !== 1 || saved.quizId !== data.id || !saved.answers || typeof saved.answers !== 'object' || Array.isArray(saved.answers)) throw new Error(`Unrecognized submitted attempt: ${item.name}`);
  entries.push([`practice-quiz:${data.id}:attempt`, value]);
}
if (!entries.length) { console.log('No submitted attempts found. Nothing was exported.'); process.exit(0); }
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ format: 'practice-quiz-browser-transfer', version: 1, origin: 'http://127.0.0.1:8765', exportedAt: new Date().toISOString(), entries }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(`Exported ${entries.length} submitted reports to ${output}. Import this file after signing in; original attempts are unchanged.`);
