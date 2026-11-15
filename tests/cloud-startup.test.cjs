const assert = require('node:assert/strict');

(async () => {
  const { shouldHydrateOnPage } = await import('../cloud/client/hydration.mjs');
  const { createAccountRequester, getAccountToken } = await import('../cloud/client/request.mjs');
  const paper = 'practice-quiz:paper-one';
  const imported = ['practice-quiz:theme', paper, `${paper}:attempt`, 'practice-quiz:paper-two', 'practice-quiz:paper-two:attempt',
    ...Array.from({ length: 500 }, (_, index) => `${paper}:rough:Q${index}`),
    ...Array.from({ length: 500 }, (_, index) => `${paper}:annotation:Q${index}`)];
  assert.deepEqual(imported.filter(key => shouldHydrateOnPage(key, { page: 'quiz', quizId: 'paper-one' })), ['practice-quiz:theme', paper, `${paper}:attempt`], 'An imported drawing library never blocks the first question');
  assert.deepEqual(imported.filter(key => shouldHydrateOnPage(key, { page: 'home' })), ['practice-quiz:theme', `${paper}:attempt`, 'practice-quiz:paper-two:attempt'], 'Home loads report scores without reading drafts or notebooks');
  assert.equal(shouldHydrateOnPage(paper, { page: 'quiz', quizId: 'paper' }), false, 'Similar quiz IDs cannot hydrate each other');

  let current = { uid: 'one' }, calls = [], changed = 0;
  const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
  const make = fetchImpl => createAccountRequester({ getUser: () => current, getToken: async force => { assert.equal(force, true); return 'test-token'; }, fetchImpl, timeoutMs: 30, accountChanged: () => { changed++; } });
  let signal;
  const stalledHeaders = make(async (_path, options) => { signal = options.signal; return new Promise(() => {}); });
  await assert.rejects(stalledHeaders('/api/state', {}, 'one'), /took too long/);
  assert.equal(signal.aborted, true);
  await assert.rejects(getAccountToken(() => new Promise(() => {}), { timeoutMs: 30 }), /took too long/, 'Initial Firebase token acquisition has a deadline');
  const stalledRenewal = createAccountRequester({ getUser: () => current, getToken: () => new Promise(() => {}), fetchImpl: async () => response(401, {}), timeoutMs: 30 });
  await assert.rejects(stalledRenewal('/api/state', {}, 'one'), /took too long/, 'Session renewal cannot wait indefinitely for Firebase');
  const stalledBody = make(async (_path, options) => { signal = options.signal; return { status: 200, ok: true, json: () => new Promise(() => {}) }; });
  await assert.rejects(stalledBody('/api/state', {}, 'one'), /took too long/, 'The deadline covers JSON, not only response headers');
  assert.equal(signal.aborted, true);

  const recovered = make(async (path, options) => {
    calls.push([path, options]);
    return calls.length === 1 ? response(401, { error: 'Expired' }) : response(200, { ready: true });
  });
  assert.deepEqual(await recovered('/api/state', {}, 'one'), { ready: true });
  assert.deepEqual(calls.map(([path]) => path), ['/api/state', '/api/session', '/api/state']);
  assert.ok(calls.every(([, options]) => options.headers['X-Quiz-Account'] === 'one' && options.credentials === 'same-origin'));
  assert.equal(calls[1][1].body, JSON.stringify({ idToken: 'test-token' }));

  const switched = make(async () => { current = { uid: 'two' }; return response(200, { private: 'old-account' }); });
  await assert.rejects(switched('/api/state', {}, 'one'), /account changed/);
  current = { uid: 'one' };
  const mismatch = make(async () => response(409, { code: 'account-changed', error: 'Reload account' }));
  await assert.rejects(mismatch('/api/state', {}, 'one'), /Reload account/);
  assert.equal(changed, 1);
  console.log('Cloud startup checks passed: scoped imported libraries, bounded headers/JSON, session refresh and account isolation. No real data touched.');
})().catch(error => { console.error(error); process.exitCode = 1; });
