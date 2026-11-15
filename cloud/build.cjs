'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const QUIZ_FILES = ['styles.css', 'theme.js', 'quiz.js', 'quiz-data.js', 'rough-work-engine.js', 'rough-work.js', 'question-annotation.js'];
const CALCULATOR_FILES = ['index.html', 'calculator.css', 'calculator.js', 'engine.js', 'launcher.css', 'launcher.js'];
const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]));
const inside = (directory, target) => { const relative = path.relative(directory, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

async function regularFile(root, relative) {
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw new Error(`Unsafe source path: ${relative}`);
  // Refuse symlinks at every component, including directories.
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink is not deployable: ${relative}`);
  }
  if (!(await fs.stat(target)).isFile()) throw new Error(`Not a source file: ${relative}`);
  return target;
}

function imagesOf(item) {
  return [...(item.image ? [{src: item.image}] : []), ...(item.images || [])];
}

function assetPaths(data) {
  const assets = new Set();
  for (const question of data.questions) {
    for (const item of [question, ...(question.options || [])]) for (const image of imagesOf(item)) {
      const src = image?.src;
      if (typeof src !== 'string' || !/^assets\/[a-zA-Z0-9_./%-]+\.(?:png|jpg|jpeg|svg|webp)$/i.test(src) || src.split('/').some(segment => segment === '..' || segment === '.') || /%2e|%2f|%5c/i.test(src)) {
        throw new Error(`Question ${question.id} has an unsafe or unsupported image path.`);
      }
      assets.add(src);
    }
  }
  return [...assets].sort();
}

async function readCatalog(root = ROOT) {
  const quizzes = [];
  for (const item of await fs.readdir(root, {withFileTypes: true})) {
    if (!item.isDirectory() || item.name.startsWith('.') || item.name.startsWith('_') || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(item.name)) continue;
    let source;
    try { source = await fs.readFile(await regularFile(root, `${item.name}/quiz-data.js`), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const serialized = vm.runInNewContext(source + '\n;JSON.stringify(window.QUIZ_DATA);', {window: {}}, {timeout: 100, contextCodeGeneration: {strings: false, wasm: false}});
    const data = JSON.parse(serialized);
    if (!data || typeof data.id !== 'string' || !data.id || typeof data.title !== 'string' || !Array.isArray(data.questions) || !data.questions.length) throw new Error(`Invalid quiz data in ${item.name}`);
    const html = await fs.readFile(await regularFile(root, `${item.name}/index.html`), 'utf8');
    const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] || data.title;
    const year = Number((title.match(/(?:^|\D)((?:19|20)\d{2})(?!\d)/) || item.name.match(/(?:^|\D)((?:19|20)\d{2})(?!\d)/))?.[1] || 0);
    quizzes.push({folder: item.name, data, html, title, year, assets: assetPaths(data)});
  }
  if (new Set(quizzes.map(quiz => quiz.data.id)).size !== quizzes.length) throw new Error('Quiz IDs must be unique.');
  quizzes.sort((a, b) => b.year - a.year || a.title.localeCompare(b.title, 'en', {numeric: true, sensitivity: 'base', ignorePunctuation: true}) || a.folder.localeCompare(b.folder, 'en', {numeric: true}));
  return quizzes;
}

function publicFirebaseConfig(environment = process.env) {
  let supplied = {};
  if (environment.FIREBASE_WEB_CONFIG) {
    try { supplied = JSON.parse(environment.FIREBASE_WEB_CONFIG); }
    catch { throw new Error('FIREBASE_WEB_CONFIG must be a JSON object.'); }
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('FIREBASE_WEB_CONFIG must be a JSON object.');
  }
  const names = {apiKey:'FIREBASE_API_KEY', authDomain:'FIREBASE_AUTH_DOMAIN', projectId:'FIREBASE_PROJECT_ID', storageBucket:'FIREBASE_STORAGE_BUCKET', messagingSenderId:'FIREBASE_MESSAGING_SENDER_ID', appId:'FIREBASE_APP_ID', measurementId:'FIREBASE_MEASUREMENT_ID'};
  const firebase = {};
  for (const [field, variable] of Object.entries(names)) {
    // Production can use its own transparently proxied auth helper without
    // changing Firebase's generated JSON or any other public project fields.
    const value = field === 'authDomain' && environment.FIREBASE_AUTH_DOMAIN
      ? environment.FIREBASE_AUTH_DOMAIN : supplied[field] ?? environment[variable];
    if (value !== undefined && value !== '') {
      if (typeof value !== 'string') throw new Error(`${field} in Firebase web config must be a string.`);
      if (field === 'authDomain' && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?$/i.test(value)) throw new Error('Firebase authDomain must be a hostname, without https:// or a path.');
      firebase[field] = value;
    }
  }
  return {enabled: true, firebase};
}

function injectCloud(html, {page, quizId, folder} = {}) {
  let result = html.replace(/\s*<script\b(?=[^>]*\bsrc=["'](?:\.\/)?(?:quiz|home)\.js["'])[^>]*>\s*<\/script>/gi, '');
  const styles = '<link rel="stylesheet" href="/_cloud/account.css">\n<link rel="stylesheet" href="/_calculator/launcher.css">';
  // Config is intentionally limited to Firebase's public web configuration.
  result = result.replace(/<head>/i, '<head>\n  <script src="/_cloud/config.js"></script>');
  result = result.replace(/<\/head>/i, `  ${styles}\n  <script src="/_calculator/launcher.js" defer></script>\n  <script src="/_cloud/app.js" defer></script>\n</head>`);
  const attributes = `data-cloud-page="${escape(page || 'quiz')}"${quizId ? ` data-quiz-id="${escape(quizId)}"` : ''}${folder ? ` data-quiz-folder="${escape(folder)}"` : ''}`;
  result = result.replace(/<body\b([^>]*)>/i, `<body$1 ${attributes}>\n  <div id="cloud-account"></div>`);
  result = result.replace(/<main\b([^>]*)>/i, '<main$1 data-cloud-protected>');
  if (page === 'quiz') result = result.replace(/<div\b([^>]*class=["'][^"']*\bquiz-shell\b[^"']*["'][^>]*)>/i, '<div$1 data-cloud-protected>');
  return result;
}

function renderHome(quizzes) {
  const cards = quizzes.map(quiz => `<li data-quiz-id="${escape(quiz.data.id)}" data-quiz-folder="${escape(quiz.folder)}" data-attempted="false"><a class="question-card paper-card" href="/${encodeURIComponent(quiz.folder)}/"><div class="paper-details"><span class="eyebrow">Question paper</span><h2>${escape(quiz.title)}</h2><span class="paper-status unattempted">Not attempted</span></div><span class="paper-score" hidden><span class="paper-score-value"></span><progress class="paper-score-bar" max="100" value="0"></progress><span class="paper-score-marks"></span></span><span class="paper-open">Open quiz <span aria-hidden="true">&rarr;</span></span></a></li>`).join('\n');
  return injectCloud(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GATE CSE quizzes</title><script src="/_template/theme.js"></script><link rel="stylesheet" href="/_template/styles.css"></head>
<body><main class="container home-page"><header class="page-header"><div class="header-top"><p class="eyebrow">Your practice library</p><button id="theme-toggle" class="toggle-switch theme-toggle" role="switch" aria-checked="false" aria-label="Theme" type="button"><span class="switch-label">Theme</span><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></button></div><h1>GATE CSE quizzes</h1><p class="subtitle">Choose a paper and practise at your own pace.</p></header>
<div class="home-tools"><label class="toggle-switch home-filter"><input id="unsolved-only" type="checkbox" role="switch"><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span><span class="switch-label">Unsolved only</span></label><button id="reset-attempts" class="button button-secondary" type="button">Reset saved attempts</button></div>
<p id="home-status" class="status-message" role="status" aria-live="polite" hidden></p><p id="paper-count" class="home-count" role="status" aria-live="polite">${quizzes.length} papers available</p><ul id="home-papers" class="home-papers" aria-label="Available question papers">${cards}</ul><p id="no-papers" class="empty-state" hidden>No unsolved papers left. Turn off the filter to see all papers.</p><p class="home-note subtitle">Your progress and drawing notes sync with your account. Submit saves your latest report.</p></main></body></html>`, {page: 'home'});
}

async function build({root = ROOT, bundleClient, environment = process.env} = {}) {
  root = await fs.realpath(root);
  const output = path.join(root, '.cloud-dist');
  if (!inside(root, output) || path.basename(output) !== '.cloud-dist') throw new Error('Invalid cloud build output.');
  const quizzes = await readCatalog(root);
  if (!quizzes.length) throw new Error('No complete quizzes were found.');
  await fs.rm(output, {recursive: true, force: true});
  await fs.mkdir(output, {recursive: true});
  const copied = [];
  async function copy(source, relative = source) {
    const absolute = await regularFile(root, source), destination = path.join(output, relative);
    if (!inside(output, destination)) throw new Error('Unsafe deployment output path.');
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.copyFile(absolute, destination);
    copied.push(relative);
  }
  for (const name of ['styles.css', 'theme.js', 'home.js']) await copy(`_template/${name}`);
  for (const name of CALCULATOR_FILES) await copy(`_calculator/${name}`);
  for (const quiz of quizzes) {
    await fs.mkdir(path.join(output, quiz.folder), {recursive: true});
    await fs.writeFile(path.join(output, quiz.folder, 'index.html'), injectCloud(quiz.html, {page:'quiz', quizId:quiz.data.id, folder:quiz.folder}));
    for (const name of QUIZ_FILES) await copy(`${quiz.folder}/${name}`);
    for (const asset of quiz.assets) await copy(`${quiz.folder}/${asset}`);
  }
  const cloudDirectory = path.join(output, '_cloud');
  await fs.mkdir(cloudDirectory, {recursive: true});
  const config = publicFirebaseConfig(environment);
  const safeJSON = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  await fs.writeFile(path.join(cloudDirectory, 'config.js'), `window.QUIZ_CLOUD_CONFIG = ${safeJSON(config)};\n`);
  await copy('cloud/client/account.css', '_cloud/account.css');
  const bundle = bundleClient || (async options => require('esbuild').build(options));
  await bundle({entryPoints:[path.join(root, 'cloud/client/entry.js')], outfile:path.join(cloudDirectory, 'app.js'), bundle:true, minify:true, sourcemap:false, platform:'browser', target:['es2020'], format:'iife', logLevel:'info'});
  await fs.writeFile(path.join(output, 'index.html'), renderHome(quizzes));
  const catalog = {version:1, quizzes:quizzes.map(({folder, data}) => ({folder, data}))};
  const serverDirectory = path.join(root, 'cloud/server');
  await fs.mkdir(serverDirectory, {recursive:true});
  await fs.writeFile(path.join(serverDirectory, 'quiz-catalog.json'), JSON.stringify(catalog));
  const metadata = quizzes.map(({folder, data, title, year}) => ({folder, id:data.id, title, year, questionCount:data.questions.length, signatureHash:crypto.createHash('sha256').update(JSON.stringify({questions:data.questions, scoring:data.scoring ?? null})).digest('hex')}));
  await fs.writeFile(path.join(cloudDirectory, 'catalog.json'), JSON.stringify({version:1, quizzes:metadata}));
  const manifest = {version:1, quizzes:quizzes.length, copiedFiles:copied.length, questionAssets:quizzes.reduce((count, quiz) => count + quiz.assets.length, 0)};
  await fs.writeFile(path.join(output, '_cloud/build-manifest.json'), JSON.stringify(manifest));
  return {...manifest, output};
}

if (require.main === module) build().then(result => console.log(`Cloud build: ${result.quizzes} quizzes, ${result.questionAssets} question assets → ${result.output}`)).catch(error => {console.error(`Cloud build failed: ${error.message}`); process.exitCode = 1;});
module.exports = {build, readCatalog, assetPaths, injectCloud, publicFirebaseConfig, renderHome};
