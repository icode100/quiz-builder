'use strict';
// All account sessions, Firestore documents and attempts below are synthetic.
// This suite never reads credentials or creates/removes real user state.
const assert = require('node:assert/strict');
const { createApiHandler, SESSION_MS } = require('../cloud/server/handler.cjs');
const { createStateStore, PAGE_SIZE } = require('../cloud/server/store.cjs');
const { loadCatalog } = require('../cloud/server/catalog.cjs');
const { ApiError, classifyKey, validateValue, canonicalAttempt } = require('../cloud/server/validation.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const now = new Date().toISOString();
const catalog = loadCatalog();
function memoryFirestore() {
  const data = new Map(), batches = []; let queue = Promise.resolve();
  const snapshot = ref => ({ ref, exists: data.has(ref.path), data: () => copy(data.get(ref.path)) });
  const apply = writes => {
    for (const [kind, ref, value, merge] of writes) {
      if (kind === 'delete') data.delete(ref.path);
      else data.set(ref.path, copy(merge ? { ...(data.get(ref.path) || {}), ...value } : value));
    }
  };
  const doc = path => ({ path, id: path.split('/').at(-1), collection: name => collection(`${path}/${name}`), get: async () => snapshot(doc(path)) });
  function collection(path) {
    let field, after = -1, maximum = Infinity;
    const ref = { path, doc: id => doc(`${path}/${id}`), where(name, operator, value) { assert.equal(operator, '>'); field = name; after = value; return ref; }, orderBy(name) { assert.equal(name, field); return ref; }, limit(value) { maximum = value; return ref; }, async get() {
      let docs = [...data.keys()].filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(key => snapshot(doc(key)));
      if (field) docs = docs.filter(item => item.data()[field] > after).sort((a, b) => a.data()[field] - b.data()[field]);
      return { docs: docs.slice(0, maximum) };
    } };
    return ref;
  }
  return { data, batches, collection, getAll: async (...refs) => refs.map(snapshot), batch() { const writes = []; return { set(ref, value) { writes.push(['set', ref, value]); }, delete(ref) { writes.push(['delete', ref]); }, async commit() { batches.push(copy(writes.map(([kind, ref, value]) => [kind, ref.path, value || null]))); apply(writes); } }; }, async runTransaction(fn) {
    const previous = queue; let release; queue = new Promise(resolve => { release = resolve; }); await previous;
    try { const writes = []; const result = await fn({ getAll: async (...refs) => refs.map(snapshot), set(ref, value, options) { writes.push(['set', ref, value, options?.merge]); } }); apply(writes); return result; } finally { release(); }
  } };
}
function attempt(quiz, mode = 'blank', exclusions = []) {
  const answers = Object.fromEntries(quiz.data.questions.map(q => {
    let answer = null;
    if (mode === 'perfect' && !q.marksToAll) answer = (q.type || 'mcq') === 'nat' ? String(q.correctRanges[0].min) : q.type === 'msq' ? [...(q.acceptedAnswerSets?.[0] || q.correctAnswers)] : q.acceptedAnswers?.[0] || q.correctAnswer;
    return [q.id, answer];
  }));
  return { version: 1, quizId: quiz.data.id, quizTitle: 'forged title', quizSignature: quiz.signature, submittedAt: now, updatedAt: now, answers, outOfSyllabus: exclusions, reviewFlags: [], summary: { percentage: 999999, score: 99999 }, results: [{ marksEarned: 999999 }] };
}
(async () => {
  assert.ok(catalog.size >= 27);
  for (const [id, quiz] of catalog) {
    const key = `practice-quiz:${id}`, draft = { signature: quiz.signature, answers: {}, reviewFlags: [], outOfSyllabus: [], currentQuestionId: quiz.data.questions.at(-1).id, timer: { durationMinutes: 180, remainingMs: 1000, endsAt: null }, updatedAt: now };
    const raw = JSON.stringify(draft); assert.equal(validateValue(key, raw, catalog).value, raw, 'Draft bytes retain raw input/position/timer');
    assert.equal(classifyKey(key, catalog).quizId, id);
    const perfect = canonicalAttempt(attempt(quiz, 'perfect'), { ...quiz, quizId: id });
    assert.equal(perfect.summary.percentage, 100, `${id} perfect percentage is recomputed`);
    assert.equal(perfect.summary.score, perfect.summary.maximum);
    assert.equal(perfect.quizTitle, quiz.data.title);
    assert.equal(perfect.results.length, quiz.data.questions.length);
    assert.ok(!JSON.stringify(perfect.summary).includes('999999'));
    const allExcluded = canonicalAttempt(attempt(quiz, 'perfect', quiz.data.questions.map(q => q.id)), { ...quiz, quizId: id });
    assert.equal(allExcluded.summary.score, 0); assert.equal(allExcluded.summary.maximum, 0); assert.equal(allExcluded.summary.percentage, null);
    const nat = quiz.data.questions.find(q => q.type === 'nat');
    if (nat) {
      draft.answers[nat.id] = '-'; assert.equal(validateValue(key, JSON.stringify(draft), catalog).value, JSON.stringify(draft));
      const invalid = attempt(quiz); invalid.answers[nat.id] = '-'; assert.throws(() => canonicalAttempt(invalid, quiz), /numerical/);
    }
    const question = quiz.data.questions[0], roughKey = `${key}:rough:${encodeURIComponent(question.id)}`, annotationKey = `${key}:annotation:${encodeURIComponent(question.id)}`;
    const stroke = { tool: 'pen', color: '#17233b', width: 2, points: [[0.1, 0.2], [0.9, 0.8]] };
    const rough = JSON.stringify({ version: 1, quizId: id, questionId: question.id, updatedAt: now, strokes: [stroke], paperStyle: 'dotted', pageHeight: 1250 });
    assert.equal(validateValue(roughKey, rough, catalog).value, rough);
    const part = question.text.trim() ? 'text' : 'image-0', annotation = { version: 1, quizId: id, questionId: question.id, updatedAt: now, parts: { [part]: [{ ...stroke, width: 1.7 }] } };
    assert.equal(validateValue(annotationKey, JSON.stringify(annotation), catalog).value, JSON.stringify(annotation));
    annotation.parts.foreign = []; assert.throws(() => validateValue(annotationKey, JSON.stringify(annotation), catalog), /part/);
  }
  for (const key of ['another-site:key', 'practice-quiz:unknown', 'practice-quiz:theme:probe', '__proto__', null]) assert.throws(() => classifyKey(key, catalog), ApiError);
  assert.equal(validateValue('practice-quiz:theme', 'dark', catalog).value, 'dark');
  assert.throws(() => validateValue('practice-quiz:theme', 'javascript:evil', catalog), ApiError);
  const linkedQuiz = [...catalog.values()].find(quiz => quiz.data.questions.some(q => q.requiresCorrect));
  const dependent = linkedQuiz.data.questions.find(q => q.requiresCorrect), linked = attempt(linkedQuiz, 'perfect');
  linked.answers[dependent.requiresCorrect] = null;
  assert.equal(canonicalAttempt(linked, linkedQuiz).results.find(r => r.questionId === dependent.id).outcome, 'blocked');
  linked.outOfSyllabus = [dependent.requiresCorrect]; assert.equal(canonicalAttempt(linked, linkedQuiz).results.find(r => r.questionId === dependent.id).outcome, 'correct');

  const db = memoryFirestore(), store = createStateStore(db), key = 'practice-quiz:theme';
  assert.deepEqual(await store.get('A', key), { key, value: null, revision: 0, updatedAt: null, deleted: true });
  const saved = await store.write('A', key, 'dark', 0); assert.equal(saved.revision, 1);
  assert.equal((await store.get('B', key)).value, null, 'Account B never reads A state');
  await assert.rejects(store.write('A', key, 'light', 0), error => error.status === 409 && error.extra.record.value === 'dark');
  assert.equal((await store.get('A', key)).value, 'dark');
  const races = await Promise.allSettled([store.write('A', key, 'light', 1), store.write('A', key, 'dark', 1)]);
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1, 'CAS prevents silent concurrent-device overwrites');
  assert.equal(races.find(result => result.status === 'rejected').reason.status, 409);
  const large = '🙂'.repeat(200000), blobKey = 'practice-quiz:synthetic:rough:Q1';
  const largeRecord = await store.write('A', blobKey, large, 0); assert.equal((await store.get('A', blobKey)).value, large, 'Chunking preserves UTF-8 across byte boundaries');
  const chunks = () => [...db.data.keys()].filter(path => path.includes('/chunks/'));
  assert.ok(chunks().length > 1);
  for (const [, value] of db.data) assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1024 * 1024, 'Every Firestore document remains below 1MiB');
  const count = chunks().length; await assert.rejects(store.write('A', blobKey, large, 0), error => error.status === 409); assert.equal(chunks().length, count, 'Rejected staged blobs are discarded');
  const small = await store.write('A', blobKey, 'small', largeRecord.revision); assert.equal(chunks().length, 0, 'Retired blob chunks are reclaimed');
  await store.write('A', blobKey, null, small.revision); assert.equal((await store.get('A', blobKey)).deleted, true);
  await store.write('B', key, 'light', 0);
  await store.write('A', 'attempt-one', 'saved', 0); await store.write('B', 'attempt-one', 'keep', 0);
  const reset = await store.resetAttempts('A', ['attempt-one']); assert.equal(reset.count, 1); assert.equal((await store.get('A', 'attempt-one')).deleted, true); assert.equal((await store.get('B', 'attempt-one')).value, 'keep');
  assert.equal((await store.get('A', key)).deleted, false, 'Reset leaves draft/theme/drawing state alone');
  for (let i = 0; i < PAGE_SIZE + 3; i++) await store.write('pages', `key-${i}`, String(i), 0);
  const firstPage = await store.list('pages'); assert.equal(firstPage.records.length, PAGE_SIZE); assert.equal(firstPage.hasMore, true);
  const secondPage = await store.list('pages', firstPage.cursor); assert.equal(secondPage.records.length, 3); assert.equal(secondPage.hasMore, false);

  const authCalls = [], auth = { async verifySessionCookie(value, revoked) { authCalls.push(['cookie', value, revoked]); if (!/^session-[AB]$/.test(value)) throw Error('bad'); return { uid: value.slice(-1), email: 'test@example.invalid', name: 'Quiz user' }; }, async verifyIdToken(value, revoked) { authCalls.push(['id', value, revoked]); if (value !== 'synthetic-verified-id-token') throw Error('bad'); return { uid: 'A', email: 'test@example.invalid' }; }, async createSessionCookie(value, options) { assert.equal(options.expiresIn, SESSION_MS); return 'session-A'; } };
  const handler = createApiHandler({ auth, store, catalog });
  async function request(url, { method = 'GET', session = 'A', input, origin = 'https://quiz.example.test', host = 'quiz.example.test', cookieName = '__Host-quiz_session', expectedAccount = session } = {}) {
    const headers = { host, ...(expectedAccount ? { 'x-quiz-account': expectedAccount } : {}), ...(origin ? { origin } : {}), ...(session ? { cookie: `${cookieName}=session-${session}` } : {}), ...(input === undefined ? {} : { 'content-type': 'application/json' }) };
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.json = JSON.parse(value); } };
    await handler({ url, method, headers, ...(input === undefined ? {} : { body: input }) }, response); return response;
  }
  assert.equal((await request('/api/session', { session: null })).json.authenticated, false);
  let response = await request('/api/session', { method: 'POST', session: null, input: { idToken: 'synthetic-verified-id-token' } });
  assert.equal(response.statusCode, 200); assert.match(response.headers['Set-Cookie'], /__Host-quiz_session=session-A; Path=\/; HttpOnly; SameSite=Lax; Max-Age=432000; Secure/);
  response = await request('/api/session', { method: 'POST', input: { idToken: 'synthetic-verified-id-token' }, origin: 'https://other.example.test' }); assert.equal(response.statusCode, 403);
  response = await request('/api/state', { session: null }); assert.equal(response.statusCode, 401);
  response = await request('/api/state', { expectedAccount: 'B' }); assert.equal(response.statusCode, 409); assert.equal(response.json.code, 'account-changed');
  response = await request('/api/state', { expectedAccount: null }); assert.equal(response.statusCode, 409);
  response = await request('/api/state', { method: 'PUT', expectedAccount: 'B', input: { key, value: 'dark', baseRevision: 0 } }); assert.equal(response.statusCode, 409); assert.equal(response.json.code, 'account-changed');
  response = await request('/api/session', { method: 'DELETE', expectedAccount: 'B' }); assert.equal(response.statusCode, 409); assert.equal(response.headers['Set-Cookie'], undefined);
  response = await request('/api/session', { method: 'POST', expectedAccount: 'B', input: { idToken: 'synthetic-verified-id-token' } }); assert.equal(response.statusCode, 409); assert.equal(response.headers['Set-Cookie'], undefined);
  response = await request('/api/state', { method: 'PUT', input: { key, value: 'dark', baseRevision: 0 }, origin: null }); assert.equal(response.statusCode, 403);
  response = await request('/api/state?since=NaN'); assert.equal(response.statusCode, 400);
  response = await request('/api/state', { method: 'PUT', input: { key: 'foreign:key', value: 'x', baseRevision: 0 } }); assert.equal(response.statusCode, 400);
  const beforePreflight = JSON.stringify([...db.data]);
  response = await request('/api/state', { method: 'POST', input: { key, value: 'dark', validateOnly: true } }); assert.equal(response.statusCode, 200); assert.deepEqual(response.json, { key, value: 'dark' });
  response = await request('/api/state', { method: 'POST', input: { key, value: 'invalid-theme', validateOnly: true } }); assert.equal(response.statusCode, 400);
  response = await request('/api/state', { method: 'POST', input: { key: 'foreign:key', value: 'x', validateOnly: true } }); assert.equal(response.statusCode, 400);
  response = await request('/api/state', { method: 'POST', input: { key, value: 'dark' } }); assert.equal(response.statusCode, 400);
  assert.equal(JSON.stringify([...db.data]), beforePreflight, 'Migration preflight validates every record without writing Firestore');
  const quiz = catalog.values().next().value, attemptKey = `practice-quiz:${quiz.data.id}:attempt`;
  response = await request('/api/state', { method: 'PUT', input: { uid: 'B', key: attemptKey, value: JSON.stringify(attempt(quiz, 'perfect')), baseRevision: 0 } });
  assert.equal(response.statusCode, 200); assert.equal(JSON.parse(response.json.value).summary.percentage, 100); assert.equal((await store.get('B', attemptKey)).deleted, true, 'Caller-provided UID cannot select a different account');
  response = await request('/api/state?key=' + encodeURIComponent(attemptKey)); assert.equal(response.statusCode, 200); assert.equal(JSON.parse(response.json.value).quizTitle, quiz.data.title);
  response = await request('/api/state', { method: 'PUT', input: { key: attemptKey, value: JSON.stringify(attempt(quiz)), baseRevision: 0 } }); assert.equal(response.statusCode, 409); assert.equal(JSON.parse(response.json.record.value).summary.percentage, 100);
  response = await request('/api/reset-attempts', { method: 'POST', input: { confirm: false } }); assert.equal(response.statusCode, 400);
  response = await request('/api/reset-attempts', { method: 'POST', input: { confirm: true } }); assert.equal(response.statusCode, 200); assert.equal(response.json.count, 1);
  response = await request('/api/session', { method: 'DELETE' }); assert.match(response.headers['Set-Cookie'], /Max-Age=0/);
  response = await request('/api/session', { method: 'POST', host: '127.0.0.1:8765', origin: 'http://127.0.0.1:8765', session: null, input: { idToken: 'synthetic-verified-id-token' } }); assert.match(response.headers['Set-Cookie'], /^quiz_session=/); assert.doesNotMatch(response.headers['Set-Cookie'], /; Secure/);
  assert.ok(authCalls.filter(([kind]) => kind === 'cookie').every(([, , revoked]) => revoked === true));
  console.log(`Cloud backend checks passed: ${catalog.size} verified papers, server regrading, linked/MTA/excluded/NAT rules, strict note identities, owner-only sessions, CSRF, CAS conflicts, chunk limits/cleanup, pagination and isolated reset. No real account data touched.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
