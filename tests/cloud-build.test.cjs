'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {build, readCatalog, publicFirebaseConfig, assetPaths} = require('../cloud/build.cjs');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quiz-cloud-build-'));
  const write = async (relative, content) => {const file = path.join(root, relative); await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file, content);};
  try {
    for (const name of ['styles.css', 'theme.js', 'home.js']) await write(`_template/${name}`, `/* ${name} */`);
    for (const name of ['index.html', 'calculator.css', 'calculator.js', 'engine.js', 'launcher.css', 'launcher.js']) await write(`_calculator/${name}`, name);
    await write('cloud/client/account.css', '/* auth */');
    await write('cloud/client/entry.js', 'window.testCloud = true;');
    const original = [];
    for (const [folder, title] of [['paper-2025-set-10', 'GATE 2025 Set 10'], ['paper-2025-set-2', 'GATE 2025 Set 2'], ['paper-2024', 'GATE 2024']]) {
      const data = {id:folder, title, questions:[{id:'CS-1', number:1, text:'Original', type:'mcq', marks:1, incorrectMarks:-1/3, images:[{src:'assets/question.png'}], options:[{id:'A', text:'A'}, {id:'B', text:'B'}], correctAnswer:'A'}]};
      const source = `window.QUIZ_DATA = ${JSON.stringify(data)};`;
      original.push([folder, source]);
      await write(`${folder}/quiz-data.js`, source);
      await write(`${folder}/index.html`, `<!doctype html><html><head><title>${title}</title><script src="theme.js"></script><script src="quiz-data.js" defer></script><script src="rough-work-engine.js" defer></script><script src="rough-work.js" defer></script><script src="question-annotation.js" defer></script><script src="quiz.js" defer></script></head><body><main>Question</main></body></html>`);
      for (const name of ['styles.css', 'theme.js', 'quiz.js', 'rough-work-engine.js', 'rough-work.js', 'question-annotation.js']) await write(`${folder}/${name}`, `/* ${name} */`);
      await write(`${folder}/assets/question.png`, Buffer.from('original PNG bytes'));
      await write(`${folder}/assets/unreferenced.png`, 'not public');
      await write(`${folder}/assets/source-crops/old.png`, 'not public');
      await write(`${folder}/attempt.json`, '{"private":"user attempt"}');
      await write(`${folder}/source.pdf`, 'private original PDF');
    }
    await write('.env', 'PRIVATE_KEY=do-not-copy');
    const environment = {FIREBASE_WEB_CONFIG:JSON.stringify({apiKey:'public-key', authDomain:'example.firebaseapp.com', projectId:'example', private_key:'secret', extra:'secret', appId:'</script><script>alert(1)</script>'}), FIREBASE_PRIVATE_KEY:'server-secret'};
    const result = await build({root, environment, bundleClient:async options => {assert.equal(options.platform, 'browser'); await fs.writeFile(options.outfile, '/* built client */');}});
    assert.equal(result.quizzes, 3);
    assert.equal(result.questionAssets, 3);
    const catalog = await readCatalog(root);
    assert.deepEqual(catalog.map(quiz => quiz.folder), ['paper-2025-set-2', 'paper-2025-set-10', 'paper-2024']);
    const home = await fs.readFile(path.join(root, '.cloud-dist/index.html'), 'utf8');
    assert.ok(home.indexOf('GATE 2025 Set 2') < home.indexOf('GATE 2025 Set 10'));
    assert.match(home, /data-cloud-page="home"/);
    assert.match(home, /data-quiz-id="paper-2024"/);
    assert.doesNotMatch(home, /user attempt|private original/);
    const html = await fs.readFile(path.join(root, '.cloud-dist/paper-2024/index.html'), 'utf8');
    assert.doesNotMatch(html, /<script src="quiz\.js"/);
    assert.match(html, /<script src="quiz-data\.js" defer>/);
    assert.match(html, /<script src="\/_cloud\/app\.js" defer>/);
    assert.match(html, /data-cloud-page="quiz"/);
    assert.match(html, /id="cloud-account"/);
    assert.match(html, /data-cloud-protected/);
    assert.equal((html.match(/_calculator\/launcher.js/g) || []).length, 1);
    assert.equal(await fs.readFile(path.join(root, '.cloud-dist/paper-2024/assets/question.png'), 'utf8'), 'original PNG bytes');
    for (const relative of ['paper-2024/attempt.json', 'paper-2024/source.pdf', 'paper-2024/assets/unreferenced.png', 'paper-2024/assets/source-crops/old.png', '.env', 'cloud/client/entry.js']) await assert.rejects(fs.stat(path.join(root, '.cloud-dist', relative)), {code:'ENOENT'});
    const config = await fs.readFile(path.join(root, '.cloud-dist/_cloud/config.js'), 'utf8');
    assert.doesNotMatch(config, /private_key|server-secret|secret|<\/script>/);
    assert.match(config, /\\u003c/);
    assert.deepEqual(publicFirebaseConfig({FIREBASE_API_KEY:'public'}), {enabled:true, firebase:{apiKey:'public'}});
    const sameOriginConfig = publicFirebaseConfig({FIREBASE_WEB_CONFIG:JSON.stringify({apiKey:'public',projectId:'gate-cse-practice',authDomain:'gate-cse-practice.firebaseapp.com',appId:'app-id'}),FIREBASE_AUTH_DOMAIN:'production-example.vercel.app'});
    assert.deepEqual(sameOriginConfig.firebase,{apiKey:'public',authDomain:'production-example.vercel.app',projectId:'gate-cse-practice',appId:'app-id'},'The explicit same-origin override changes only the auth helper domain');
    assert.throws(()=>publicFirebaseConfig({FIREBASE_AUTH_DOMAIN:'https://production-example.vercel.app'}),/hostname/);
    assert.throws(()=>publicFirebaseConfig({FIREBASE_AUTH_DOMAIN:'production-example.vercel.app/__/auth'}),/hostname/);
    const deployment=JSON.parse(await fs.readFile(path.join(__dirname,'../vercel.json'),'utf8'));
    const helper=deployment.rewrites.find(route=>route.source==='/__/auth/:path*');
    assert.deepEqual(helper,{source:'/__/auth/:path*',destination:'https://gate-cse-practice.firebaseapp.com/__/auth/:path*'},'Firebase auth helpers are reverse-proxied through the app domain');
    assert.equal(Boolean(deployment.redirects?.some(route=>route.source.startsWith('/__/auth'))),false,'Auth helper forwarding must not be a browser redirect');
    assert.ok(deployment.headers.some(route=>route.source==='/__/auth/:path*'&&route.headers.some(header=>header.key==='Cache-Control'&&header.value==='no-store')));
    assert.throws(() => publicFirebaseConfig({FIREBASE_WEB_CONFIG:'not-json'}), /JSON object/);
    assert.throws(() => assetPaths({questions:[{id:'Q', images:[{src:'assets/../../attempt.json'}]}]}), /unsafe/);
    const generated = JSON.parse(await fs.readFile(path.join(root, 'cloud/server/quiz-catalog.json'), 'utf8'));
    assert.equal(generated.version, 1);
    assert.equal(generated.quizzes.length, 3);
    for (const [folder, source] of original) assert.equal(await fs.readFile(path.join(root, folder, 'quiz-data.js'), 'utf8'), source, 'Building never changes source question data');
    const manifest = JSON.parse(await fs.readFile(path.join(root, '.cloud-dist/_cloud/build-manifest.json'), 'utf8'));
    assert.equal(manifest.questionAssets, 3);
    // A symlink must never smuggle a private file into a public image path.
    await fs.unlink(path.join(root, 'paper-2024/assets/question.png'));
    await fs.symlink('../attempt.json', path.join(root, 'paper-2024/assets/question.png'));
    await assert.rejects(build({root, bundleClient:async () => {}}), /Symlink/);
    console.log('Cloud build checks passed: allowlisted assets, private-file exclusion, source preservation, auth boot order, public-config filtering, catalog order/signatures and symlink refusal.');
  } finally {await fs.rm(root, {recursive:true, force:true});}
})().catch(error => {console.error(error); process.exitCode = 1;});
