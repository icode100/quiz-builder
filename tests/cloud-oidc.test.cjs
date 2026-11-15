'use strict';
// Credential wiring is tested with synthetic tokens. No Vercel or Google
// credentials are read, and no real token exchange is performed.
const assert = require('node:assert/strict');
const { createServices, workloadSettings } = require('../cloud/server/admin.cjs');
const env = {
  VERCEL: '1', FIREBASE_PROJECT_ID: 'gate-cse-practice', GCP_PROJECT_NUMBER: '719475848673',
  GCP_WORKLOAD_IDENTITY_POOL_ID: 'vercel', GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: 'vercel',
  GCP_SERVICE_ACCOUNT_EMAIL: 'quiz-vercel@gate-cse-practice.iam.gserviceaccount.com'
};
function fixture(overrides = {}) {
  const calls = [], applications = []; let token = 'request-oidc-one', client, googleAuth;
  const fakeAuth = { provider: 'firebase-admin-auth' }, ordinaryDb = { provider: 'firebase-admin-firestore' };
  const modules = {
    'firebase-admin/app': { getApps: () => applications, initializeApp(options) { const app = { options }; applications.push(app); calls.push(['initialize', options]); return app; }, cert(value) { calls.push(['cert', value]); return { certificate: value }; }, applicationDefault() { calls.push(['adc']); return { adc: true }; } },
    'firebase-admin/auth': { getAuth(app) { calls.push(['auth', app]); return fakeAuth; } },
    'firebase-admin/firestore': { getFirestore(app) { calls.push(['ordinary-firestore', app]); return ordinaryDb; } },
    'google-auth-library': {
      IdentityPoolClient: class { constructor(options) { this.options = options; this.credentials = { expiry_date: Date.now() + 3600000 }; client = this; calls.push(['identity-pool', options]); } async getAccessToken() { calls.push(['access-token']); return { token: 'short-lived-google-token' }; } },
      GoogleAuth: class { constructor(options) { this.options = options; googleAuth = this; calls.push(['google-auth', options]); } }
    },
    '@vercel/oidc': { getVercelOidcToken() { calls.push(['vercel-oidc', token]); return Promise.resolve(token); } },
    '@google-cloud/firestore': { Firestore: class { constructor(options) { this.options = options; calls.push(['federated-firestore', options]); } } },
    'node:crypto': { generateKeyPairSync() { return { privateKey: 'ephemeral-emulator-key' }; } }
  };
  const load = name => { if (!modules[name]) throw Error('Unexpected module: ' + name); return modules[name]; };
  const services = createServices({ env: { ...env, ...overrides }, load });
  return { calls, applications, services, client, googleAuth, rotate(value) { token = value; } };
}
(async () => {
  const f = fixture();
  assert.equal(f.services.auth.provider, 'firebase-admin-auth');
  assert.equal(f.services.db.options.projectId, env.FIREBASE_PROJECT_ID);
  assert.equal(f.services.db.options.auth, f.googleAuth);
  assert.equal(f.googleAuth.options.authClient, f.client, 'Firestore and FirebaseAuth share a refreshing Google credential');
  assert.equal(f.calls.some(([name]) => name === 'cert' || name === 'adc' || name === 'ordinary-firestore'), false, 'Keyless Firestore never enters the Admin wrapper that rejects custom credentials');
  assert.equal(f.calls.some(([name]) => name === 'vercel-oidc'), false, 'Vercel tokens are not captured during module/service initialization');
  assert.equal(f.client.options.audience, '//iam.googleapis.com/projects/719475848673/locations/global/workloadIdentityPools/vercel/providers/vercel');
  assert.equal(f.client.options.token_url, 'https://sts.googleapis.com/v1/token');
  assert.equal(f.client.options.subject_token_type, 'urn:ietf:params:oauth:token-type:jwt');
  assert.equal(f.client.options.service_account_impersonation_url, 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/quiz-vercel@gate-cse-practice.iam.gserviceaccount.com:generateAccessToken');
  assert.deepEqual(f.client.options.scopes, ['https://www.googleapis.com/auth/cloud-platform']);
  const supplier = f.client.options.subject_token_supplier;
  assert.equal(await supplier.getSubjectToken(), 'request-oidc-one'); f.rotate('request-oidc-two'); assert.equal(await supplier.getSubjectToken(), 'request-oidc-two', 'Token refresh asks the official helper for the current request token');
  const credential = f.applications[0].options.credential;
  const result = await credential.getAccessToken();
  assert.equal(result.access_token, 'short-lived-google-token'); assert.ok(result.expires_in >= 3590 && result.expires_in <= 3600);
  f.client.credentials.expiry_date = Date.now() - 1;
  await assert.rejects(credential.getAccessToken(), /valid federated access token/);
  f.client.credentials.expiry_date = undefined;
  await assert.rejects(credential.getAccessToken(), /valid federated access token/);
  for (const variable of ['GCP_PROJECT_NUMBER', 'GCP_WORKLOAD_IDENTITY_POOL_ID', 'GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID', 'GCP_SERVICE_ACCOUNT_EMAIL']) {
    assert.throws(() => fixture({ [variable]: '' }), /configuration/);
    assert.throws(() => fixture({ [variable]: 'https://attacker.invalid/path' }), /configuration/);
  }
  assert.throws(() => fixture({ FIREBASE_PROJECT_ID: '' }), /configuration/);
  assert.equal(workloadSettings({}, 'gate-cse-practice'), null);
  const withoutWif = { GCP_PROJECT_NUMBER: '', GCP_WORKLOAD_IDENTITY_POOL_ID: '', GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: '', GCP_SERVICE_ACCOUNT_EMAIL: '' };
  const legacy = fixture({ ...withoutWif, FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'gate-cse-practice', client_email: 'local@example.invalid', private_key: 'synthetic-local-key' }) });
  assert.equal(legacy.services.db.provider, 'firebase-admin-firestore'); assert.equal(legacy.calls.find(([name]) => name === 'cert')[1].private_key, 'synthetic-local-key');
  const adc = fixture(withoutWif); assert.ok(adc.calls.some(([name]) => name === 'adc'));
  const emulator = fixture({ ...withoutWif, VERCEL: '', FIREBASE_PROJECT_ID: 'demo-quiz-cloud-test', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:18180' });
  assert.equal(emulator.services.db.provider, 'firebase-admin-firestore'); assert.equal(emulator.calls.find(([name]) => name === 'cert')[1].privateKey, 'ephemeral-emulator-key');
  assert.throws(() => fixture({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:18180' }), /loopback-only demo/);

  // Exercise the installed official constructors too; this remains offline.
  const { IdentityPoolClient, GoogleAuth } = require('google-auth-library');
  const { Firestore } = require('@google-cloud/firestore');
  const realClient = new IdentityPoolClient({ ...f.client.options, subject_token_supplier: { getSubjectToken: async () => 'synthetic-oidc-token' } });
  assert.equal(await realClient.retrieveSubjectToken(), 'synthetic-oidc-token');
  realClient.setCredentials({ access_token: 'synthetic-cached-google-token', expiry_date: Date.now() + 3600000 });
  const google = new GoogleAuth({ projectId: env.FIREBASE_PROJECT_ID, authClient: realClient });
  assert.equal(await google.getClient(), realClient);
  const firestore = new Firestore({ projectId: env.FIREBASE_PROJECT_ID, auth: google });
  assert.equal(firestore._settings.auth, google, 'Installed Firestore forwards the official GoogleAuth integration');
  assert.equal((await google.getAccessToken()), 'synthetic-cached-google-token');
  await firestore.terminate();
  // A real Firestore document read goes through GAPIC -> GoogleAuth -> our
  // supplied client. Stub only the final HTTP response, and forbid any ADC
  // fallback so losing the auth bridge fails immediately instead of discovering
  // credentials from the developer's computer.
  const originalAdc = GoogleAuth.prototype.getApplicationDefaultAsync;
  const firestoreRequests = [];
  GoogleAuth.prototype.getApplicationDefaultAsync = async () => { throw new Error('Unexpected ADC discovery in keyless Firestore'); };
  const readDb = new Firestore({ projectId: env.FIREBASE_PROJECT_ID, auth: google, preferRest: true });
  const originalFetch = realClient.fetch;
  realClient.fetch = async (url, init) => {
    firestoreRequests.push(String(url));
    assert.match(String(url), /^https:\/\/firestore\.googleapis\.com\//);
    assert.equal(init.method, 'POST');
    const request = JSON.parse(init.body);
    const document = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/oidc-test/document`;
    assert.deepEqual(request.documents, [document]);
    assert.equal((await realClient.getRequestHeaders(String(url))).get('authorization'), 'Bearer synthetic-cached-google-token');
    return new Response(JSON.stringify([{ found: { name: document, fields: { verified: { booleanValue: true } }, createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z' }, readTime: '2026-01-01T00:00:00Z' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const document = await readDb.doc('oidc-test/document').get();
    assert.equal(document.exists, true); assert.deepEqual(document.data(), { verified: true });
    assert.equal(firestoreRequests.length, 1, 'The installed Firestore client actually uses the supplied federated auth client');
  } finally {
    realClient.fetch = originalFetch;
    GoogleAuth.prototype.getApplicationDefaultAsync = originalAdc;
    await readDb.terminate();
  }
  const exchanges = []; let currentSubject = 'oidc-current-one';
  const exchangeClient = new IdentityPoolClient({ ...f.client.options, subject_token_supplier: { getSubjectToken: async () => currentSubject } });
  const fakeTransport = async options => {
    const url = String(options.url); exchanges.push(url);
    if (url === 'https://sts.googleapis.com/v1/token') {
      assert.equal(options.data.get('subject_token'), currentSubject);
      assert.equal(options.data.get('audience'), f.client.options.audience);
      return { data: { access_token: 'synthetic-sts-token', expires_in: 3600, token_type: 'Bearer', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' } };
    }
    assert.equal(url, f.client.options.service_account_impersonation_url);
    assert.equal(options.headers.authorization, 'Bearer synthetic-sts-token');
    assert.deepEqual(options.data.scope, ['https://www.googleapis.com/auth/cloud-platform']);
    return { data: { accessToken: 'synthetic-impersonated-sa-token', expireTime: new Date(Date.now() + 3600000).toISOString() } };
  };
  exchangeClient.stsCredential.transporter.request = fakeTransport;
  exchangeClient.transporter.request = fakeTransport;
  assert.equal((await exchangeClient.getAccessToken()).token, 'synthetic-impersonated-sa-token');
  await exchangeClient.getAccessToken(); assert.equal(exchanges.length, 2, 'Google caches only its short-lived access token');
  currentSubject = 'oidc-current-two';
  exchangeClient.setCredentials({ access_token: 'expired', expiry_date: Date.now() - 1 });
  await exchangeClient.getAccessToken(); assert.equal(exchanges.length, 4, 'Expired Google credentials trigger a fresh Vercel subject and both exchanges');
  const { initializeApp, deleteApp } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const app = initializeApp({ projectId: env.FIREBASE_PROJECT_ID, credential: { getAccessToken: async () => ({ access_token: 'synthetic-google-token', expires_in: 3600 }) } }, 'offline-keyless-adapter-test');
  assert.equal(getAuth(app).app, app, 'Installed Firebase Auth accepts the supported access-token credential adapter');
  await deleteApp(app);
  console.log('Keyless OIDC checks passed: constrained Google endpoints, fresh request tokens, service-account impersonation, FirebaseAuth token adapter, official Firestore/GoogleAuth constructors, expiry rejection, strict configuration and unchanged local credentials/emulators. No real credentials used.');
})().catch(error => { console.error(error); process.exitCode = 1; });
