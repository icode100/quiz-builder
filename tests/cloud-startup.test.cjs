const assert = require('node:assert/strict');

(async () => {
  const { shouldHydrateOnPage, startupKeysForPage } = await import('../cloud/client/hydration.mjs');
  const { createAccountRequester, getAccountToken } = await import('../cloud/client/request.mjs');
  const { openAccountStorage } = await import('../cloud/client/startup.mjs');
  const paper = 'practice-quiz:paper-one';
  const imported = ['practice-quiz:theme', paper, `${paper}:attempt`, 'practice-quiz:paper-two', 'practice-quiz:paper-two:attempt',
    ...Array.from({ length: 500 }, (_, index) => `${paper}:rough:Q${index}`),
    ...Array.from({ length: 500 }, (_, index) => `${paper}:annotation:Q${index}`)];
  assert.deepEqual(imported.filter(key => shouldHydrateOnPage(key, { page: 'quiz', quizId: 'paper-one' })), ['practice-quiz:theme', paper, `${paper}:attempt`], 'An imported drawing library never blocks the first question');
  assert.deepEqual(imported.filter(key => shouldHydrateOnPage(key, { page: 'home' })), ['practice-quiz:theme', `${paper}:attempt`, 'practice-quiz:paper-two:attempt'], 'Home loads report scores without reading drafts or notebooks');
  assert.equal(shouldHydrateOnPage(paper, { page: 'quiz', quizId: 'paper' }), false, 'Similar quiz IDs cannot hydrate each other');
  assert.deepEqual(startupKeysForPage({ page: 'quiz', quizId: 'paper-one' }), ['practice-quiz:theme', paper, `${paper}:attempt`]);
  assert.deepEqual(startupKeysForPage({ page: 'home', quizIds: ['paper-one', 'paper-two', 'paper-one'] }), ['practice-quiz:theme', `${paper}:attempt`, 'practice-quiz:paper-two:attempt']);

  const tick = () => new Promise(resolve => setImmediate(resolve));
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const session = deferred(), warmCalls = [];
  let warmOptions;
  const cachedSync = { ready: async () => {}, close() {} };
  const warm = await openAccountStorage({ uid: 'one', getToken: async () => 'existing-token',
    request: async path => { warmCalls.push(path); if (path === '/api/session') await session.promise; return { ready: true }; },
    createSync: options => { warmOptions = options; return cachedSync; } });
  assert.equal(warm, cachedSync, 'A trusted cached scope opens even while its server-session refresh is held');
  const backgroundRead = warmOptions.request('/api/state');
  await tick(); assert.deepEqual(warmCalls, ['/api/session'], 'Server reads still wait for session establishment');
  session.resolve(); await backgroundRead; assert.deepEqual(warmCalls, ['/api/session', '/api/state']);

  const coldSession = deferred(); let coldReady = false, coldClosed = false;
  const cold = openAccountStorage({ uid: 'one', getToken: async () => 'existing-token',
    request: async path => { if (path === '/api/session') await coldSession.promise; },
    createSync: options => ({ ready: () => options.request('/api/state'), close() { coldClosed = true; } })
  }).then(() => { coldReady = true; });
  await tick(); assert.equal(coldReady, false, 'An unknown scope cannot appear as a blank quiz before cloud restoration');
  coldSession.resolve(); await cold; assert.equal(coldReady, true); assert.equal(coldClosed, false);
  await assert.rejects(openAccountStorage({ uid: 'one', getToken: async () => 'existing-token',
    request: async () => { throw Object.assign(new Error('Session rejected'), { status: 401 }); },
    createSync: options => ({ ready: () => options.request('/api/state'), close() { coldClosed = true; } })
  }), /Session rejected/);
  assert.equal(coldClosed, true, 'Rejected cold connections close their sync instance');

  let recoveringOptions, sessionTries = 0; const forced = [];
  await openAccountStorage({ uid: 'one', getToken: async force => { forced.push(force); return 'existing-token'; },
    request: async path => { if (path === '/api/session' && ++sessionTries === 1) throw Object.assign(new Error('Session expired'), { status: 401 }); return { ready: true }; },
    createSync: options => { recoveringOptions = options; return cachedSync; } });
  await tick();
  await Promise.all([recoveringOptions.request('/api/state'), recoveringOptions.request('/api/state?since=0')]);
  assert.equal(sessionTries, 2, 'A failed warm session is retried once and shared by concurrent background requests');
  assert.deepEqual(forced, [false, true], 'An expired server session retries with a freshly issued Firebase token');

  const closingSession = deferred(), closingCalls = []; let closingOptions;
  const closing = await openAccountStorage({ uid: 'one', getToken: async () => 'existing-token',
    request: async (path, options = {}) => { closingCalls.push([path, options.method || 'GET']); if (options.method === 'POST') await closingSession.promise; },
    createSync: options => { closingOptions = options; return { ready: async () => {}, close() {} }; } });
  await tick();
  const queuedRead = closingOptions.request('/api/state'), ending = closing.endSession();
  const rejectedRead = assert.rejects(queuedRead, /closing/);
  await assert.rejects(closingOptions.request('/api/state?since=0'), /closing/);
  assert.deepEqual(closingCalls, [['/api/session', 'POST']], 'Sign out waits for the in-flight session response');
  closingSession.resolve(); await Promise.all([ending, rejectedRead]);
  assert.deepEqual(closingCalls, [['/api/session', 'POST'], ['/api/session', 'DELETE']], 'The final cookie operation is DELETE and queued reads cannot restart a session');

  const oldRequest = deferred(), renewal = deferred(), drainingCalls = []; let drainingOptions;
  const draining = await openAccountStorage({ uid: 'one', getToken: async () => 'existing-token',
    request: async (path, options = {}) => {
      drainingCalls.push([path, options.method || 'GET']);
      if (path === '/api/state') { await oldRequest.promise; drainingCalls.push(['/api/session', '401 renewal']); await renewal.promise; }
    }, createSync: options => { drainingOptions = options; return { ready: async () => {}, close() {} }; } });
  const issuedRead = drainingOptions.request('/api/state'); await tick();
  const drained = draining.endSession(); oldRequest.resolve(); await tick();
  assert.equal(drainingCalls.some(([, method]) => method === 'DELETE'), false, 'Sign out drains a previously issued request that is still renewing its session');
  renewal.resolve(); await Promise.all([drained, issuedRead]);
  assert.deepEqual(drainingCalls.at(-1), ['/api/session', 'DELETE'], 'No in-flight 401 renewal can recreate the cookie after logout');

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
