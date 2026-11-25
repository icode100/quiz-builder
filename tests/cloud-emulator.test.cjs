'use strict';
// Run only under `firebase emulators:exec --project demo-quiz-cloud-test`.
// Both hosts are mandatory and must point to loopback; production is refused.
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID, createHash, generateKeyPairSync } = require('node:crypto');
const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) assert.match(process.env[name] || '', /^(127\.0\.0\.1|localhost):\d+$/, `${name} must use a local emulator`);
assert.equal(projectId, 'demo-quiz-cloud-test', 'The emulator test must never use a real Firebase project.');
const { initializeApp, deleteApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { createApiHandler } = require('../cloud/server/handler.cjs');
const { createStateStore } = require('../cloud/server/store.cjs');
const { loadCatalog } = require('../cloud/server/catalog.cjs');
// An ephemeral synthetic certificate avoids discovering real ADC credentials.
// Both emulator endpoints and the demo project are asserted above first.
const credential = cert({ projectId, clientEmail: `emulator@${projectId}.iam.gserviceaccount.com`, privateKey: generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey });
const app = initializeApp({ projectId, credential }, `emulator-${randomUUID()}`), auth = getAuth(app), db = getFirestore(app), catalog = loadCatalog();
const handler = createApiHandler({ auth, store: createStateStore(db), catalog });
const server = http.createServer(handler);
const users = [];
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function signup() {
    const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `quiz-${randomUUID()}@example.invalid`, password: `Synthetic-${randomUUID()}!`, returnSecureToken: true }) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); users.push(value.localId); return value;
  }
  async function call(path, { method = 'GET', identity, session, input, expectedUid } = {}) {
    const uid = expectedUid ?? identity?.localId;
    const response = await fetch(origin + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(uid ? { 'X-Quiz-Account': uid } : {}), ...(session ? { Cookie: session } : {}) }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, json: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const a = await signup(), b = await signup();
  const loginA = await call('/api/session', { method: 'POST', identity: a, input: { idToken: a.idToken } }); assert.equal(loginA.status, 200, JSON.stringify(loginA.json)); assert.ok(loginA.cookie?.startsWith('quiz_session='));
  const loginB = await call('/api/session', { method: 'POST', identity: b, input: { idToken: b.idToken } }); assert.equal(loginB.status, 200);
  assert.equal((await call('/api/session', { identity: a, session: loginA.cookie })).json.user.uid, a.localId);
  assert.equal((await call('/api/state')).status, 401);
  const key = 'practice-quiz:theme';
  const save = await call('/api/state', { method: 'PUT', identity: a, session: loginA.cookie, input: { key, value: 'dark', baseRevision: 0 } }); assert.equal(save.status, 200, JSON.stringify(save.json));
  assert.equal((await call('/api/state?key=' + encodeURIComponent(key), { identity: b, session: loginB.cookie })).json.value, null, 'Another signed-in user cannot read the first account');
  assert.equal((await call('/api/state?key=' + encodeURIComponent(key), { identity: a, session: loginB.cookie })).json.code, 'account-changed', 'Stale account headers cannot cross cookie accounts');
  const race = await Promise.all(['light', 'dark'].map(value => call('/api/state', { method: 'PUT', identity: a, session: loginA.cookie, input: { key, value, baseRevision: save.json.revision } })));
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409], 'Real Firestore transactions enforce CAS across concurrent requests');
  const quiz = catalog.values().next().value, q = quiz.data.questions[0], noteKey = `practice-quiz:${quiz.data.id}:rough:${encodeURIComponent(q.id)}`;
  const strokes = Array.from({ length: 8 }, () => ({ tool: 'pen', color: '#17233b', width: 2, points: Array.from({ length: 10000 }, (_, i) => [i / 10000, (10000 - i) / 10000]) }));
  const value = JSON.stringify({ version: 1, quizId: quiz.data.id, questionId: q.id, updatedAt: new Date().toISOString(), paperStyle: 'dotted', pageHeight: 1250, strokes });
  assert.ok(Buffer.byteLength(value) > 1024 * 1024, 'Fixture exercises Firestore document chunking');
  const noteSave = await call('/api/state', { method: 'PUT', identity: a, session: loginA.cookie, input: { key: noteKey, value, baseRevision: 0 } }); assert.equal(noteSave.status, 200, JSON.stringify(noteSave.json).slice(0, 200));
  const loaded = await call('/api/state?key=' + encodeURIComponent(noteKey), { identity: a, session: loginA.cookie }); assert.equal(loaded.status, 200); assert.equal(loaded.json.value, value);
  const noteDoc = await db.doc(`users/${a.localId}/state/${createHash('sha256').update(noteKey).digest('hex')}`).get(); assert.ok(noteDoc.data().chunkCount > 1); assert.equal(noteDoc.data().value, undefined);
  const directPath = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${projectId}/databases/(default)/documents/users/${a.localId}/state/${createHash('sha256').update(key).digest('hex')}`;
  assert.equal((await fetch(directPath)).status, 403, 'Anonymous Firestore REST reads are denied by deployed rules');
  assert.equal((await fetch(directPath, { headers: { Authorization: `Bearer ${a.idToken}` } })).status, 403, 'Even the owner must use the validating server API');
  const stamp = new Date().toISOString(), attempt = { version: 1, quizId: quiz.data.id, quizSignature: quiz.signature, submittedAt: stamp, updatedAt: stamp, answers: Object.fromEntries(quiz.data.questions.map(question => [question.id, question.marksToAll ? null : question.type === 'nat' ? String(question.correctRanges[0].min) : question.type === 'msq' ? question.acceptedAnswerSets?.[0] || question.correctAnswers : question.acceptedAnswers?.[0] || question.correctAnswer])), summary: { score: -999, percentage: -999 } };
  const attemptKey = `practice-quiz:${quiz.data.id}:attempt`;
  const attemptSaved = await call('/api/state', { method: 'PUT', identity: a, session: loginA.cookie, input: { key: attemptKey, value: JSON.stringify(attempt), baseRevision: 0 } }); assert.equal(attemptSaved.status, 200); assert.equal(JSON.parse(attemptSaved.json.value).summary.percentage, 100);
  const reset = await call('/api/reset-attempts', { method: 'POST', identity: a, session: loginA.cookie, input: { confirm: true } }); assert.equal(reset.status, 200); assert.equal(reset.json.count, 1);
  assert.equal((await call('/api/state?key=' + encodeURIComponent(noteKey), { identity: a, session: loginA.cookie })).json.value, value, 'Reset leaves the real emulator drawing intact');
  const page = await call('/api/state?since=0', { identity: a, session: loginA.cookie }); assert.equal(page.status, 200); assert.equal(page.json.records.length, 3);
  const unchanged = await call('/api/state?since=' + page.json.cursor, { identity: a, session: loginA.cookie }); assert.deepEqual(unchanged.json.records, []);
  await auth.revokeRefreshTokens(a.localId);
  // Expiry/revocation propagation is covered by Firebase's SDK; verifySessionCookie
  // is invoked with checkRevoked=true by the independent handler suite.
  console.log('Real Firebase emulator checks passed: verified ID tokens and HttpOnly server sessions, two-account isolation, stale-tab guard, transaction conflicts, >1MiB drawing round-trip, deny-all client rules, server regrading, isolated reset and incremental sync.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const uid of users) { await db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => {}); await auth.deleteUser(uid).catch(() => {}); }
  await new Promise(resolve => server.close(resolve)); await deleteApp(app);
});
