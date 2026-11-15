'use strict';
let services;
const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

function workloadSettings(env, projectId) {
  const names = ['GCP_PROJECT_NUMBER', 'GCP_WORKLOAD_IDENTITY_POOL_ID', 'GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID', 'GCP_SERVICE_ACCOUNT_EMAIL'];
  if (!names.some(name => env[name]) && env.FIREBASE_AUTH_MODE !== 'vercel-oidc') return null;
  const [number, pool, provider, email] = names.map(name => env[name]);
  if (!projectId || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId) || !/^\d{6,20}$/.test(number || '') ||
      !/^[a-z][a-z0-9-]{2,62}$/.test(pool || '') || !/^[a-z][a-z0-9-]{2,62}$/.test(provider || '') ||
      !/^[a-z][a-z0-9-]{4,62}@[a-z][a-z0-9-]{4,61}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(email || '')) {
    throw new Error('The Vercel workload identity configuration is incomplete or invalid.');
  }
  return {
    audience: `//iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`,
    email
  };
}

function createServices({ env = process.env, load = require } = {}) {
  const { getApps, initializeApp, cert, applicationDefault } = load('firebase-admin/app');
  const { getAuth } = load('firebase-admin/auth');
  const { getFirestore } = load('firebase-admin/firestore');
  const projectId = env.FIREBASE_PROJECT_ID || env.GCP_PROJECT_ID || env.GCLOUD_PROJECT;
  let credential, db;
  if (env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST) {
    if (env.VERCEL || !projectId?.startsWith('demo-') || ![env.FIREBASE_AUTH_EMULATOR_HOST, env.FIRESTORE_EMULATOR_HOST].every(host => /^(localhost|127\.0\.0\.1):\d+$/.test(host || ''))) throw new Error('Emulators require a loopback-only demo project.');
    const { generateKeyPairSync } = load('node:crypto');
    credential = cert({ projectId, clientEmail: `emulator@${projectId}.iam.gserviceaccount.com`, privateKey: generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey });
  } else {
    const federation = workloadSettings(env, projectId);
    if (federation) {
      const { IdentityPoolClient, GoogleAuth } = load('google-auth-library');
      const { getVercelOidcToken } = load('@vercel/oidc');
      const { Firestore } = load('@google-cloud/firestore');
      // The supplier runs inside the current Vercel request on refresh. Never
      // capture a deployment token at module initialization or cache it here.
      const authClient = new IdentityPoolClient({
        audience: federation.audience,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        token_url: 'https://sts.googleapis.com/v1/token',
        service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${federation.email}:generateAccessToken`,
        scopes: [CLOUD_SCOPE],
        subject_token_supplier: { getSubjectToken: () => getVercelOidcToken() }
      });
      credential = {
        async getAccessToken() {
          const { token } = await authClient.getAccessToken();
          const expiry = authClient.credentials?.expiry_date;
          if (typeof token !== 'string' || !token || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Google did not return a valid federated access token.');
          return { access_token: token, expires_in: Math.max(1, Math.floor((expiry - Date.now()) / 1000)) };
        }
      };
      // Firebase Admin's Firestore wrapper accepts only certificates/ADC. The
      // official Google client supports this same refreshing GoogleAuth client.
      db = new Firestore({ projectId, auth: new GoogleAuth({ projectId, authClient }) });
    } else if (env.FIREBASE_SERVICE_ACCOUNT_JSON || env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
      credential = cert(account);
    } else if (env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
      credential = cert({ projectId, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') });
    } else credential = applicationDefault();
  }
  const app = getApps()[0] || initializeApp({ ...(projectId ? { projectId } : {}), ...(credential ? { credential } : {}) });
  return { auth: getAuth(app), db: db || getFirestore(app) };
}
function getServices() {
  if (!services) services = createServices();
  return services;
}
module.exports = { getServices, createServices, workloadSettings };
