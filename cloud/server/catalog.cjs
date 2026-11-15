'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
let cached;
function loadCatalog() {
  if (cached) return cached;
  const built = path.join(__dirname, 'quiz-catalog.json');
  let entries;
  if (fs.existsSync(built)) {
    const saved = JSON.parse(fs.readFileSync(built, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.quizzes)) throw new Error('Invalid bundled quiz catalog.');
    entries = saved.quizzes;
  } else {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && /^gate-cse-/.test(item.name)).map(item => {
      const file = path.join(root, item.name, 'quiz-data.js');
      if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) return null;
      const data = JSON.parse(vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\n;JSON.stringify(window.QUIZ_DATA)', { window: {} }, { timeout: 200, contextCodeGeneration: { strings: false, wasm: false } }));
      return { folder: item.name, data };
    }).filter(Boolean);
  }
  const map = new Map();
  for (const { folder, data } of entries) {
    if (typeof folder !== 'string' || !/^gate-cse-[a-z0-9-]+$/.test(folder) || !data || typeof data.id !== 'string' || map.has(data.id) || !Array.isArray(data.questions) || !data.questions.length) throw new Error('Invalid or duplicate bundled quiz.');
    map.set(data.id, { folder, data, signature: JSON.stringify({ questions: data.questions, scoring: data.scoring ?? null }) });
  }
  if (!map.size) throw new Error('No bundled quiz keys were found.');
  cached = map;
  return map;
}
module.exports = { loadCatalog };
