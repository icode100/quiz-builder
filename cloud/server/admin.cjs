'use strict';
let services;
function getServices() {
  if (services) return services;
  const { getApps, initializeApp, cert, applicationDefault } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const { getFirestore } = require('firebase-admin/firestore');
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  let credential;
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST) {
    if (process.env.VERCEL || !projectId?.startsWith('demo-') || ![process.env.FIREBASE_AUTH_EMULATOR_HOST, process.env.FIRESTORE_EMULATOR_HOST].every(host => /^(localhost|127\.0\.0\.1):\d+$/.test(host || ''))) throw new Error('Emulators require a loopback-only demo project.');
    const { generateKeyPairSync } = require('node:crypto');
    credential = cert({ projectId, clientEmail: `emulator@${projectId}.iam.gserviceaccount.com`, privateKey: generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey });
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
    credential = cert(account);
  } else if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    credential = cert({ projectId, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') });
  } else if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST) {
    credential = applicationDefault();
  }
  const app = getApps()[0] || initializeApp({ ...(projectId ? { projectId } : {}), ...(credential ? { credential } : {}) });
  services = { auth: getAuth(app), db: getFirestore(app) };
  return services;
}
module.exports = { getServices };
