'use strict';
// Run inside Firebase emulators:exec with --project demo-quiz-cloud-test.
// This modifies only the generated public config and restores it on clean exit.
const fs = require('node:fs');
const path = require('node:path');
const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
if (projectId !== 'demo-quiz-cloud-test' || process.env.VERCEL || ![process.env.FIREBASE_AUTH_EMULATOR_HOST, process.env.FIRESTORE_EMULATOR_HOST].every(host => /^(localhost|127\.0\.0\.1):\d+$/.test(host || ''))) throw new Error('Start both loopback emulators with the demo-quiz-cloud-test project first.');
const filename = path.resolve(__dirname, '../.cloud-dist/_cloud/config.js');
if (!fs.existsSync(path.resolve(__dirname, '../.cloud-dist/_cloud/app.js'))) throw new Error('Run npm run build before the emulator browser preview.');
const original = fs.readFileSync(filename, 'utf8');
const preview = 'window.QUIZ_CLOUD_CONFIG = ' + JSON.stringify({ enabled: true, firebase: { apiKey: 'demo-quiz-cloud-test', authDomain: 'localhost', projectId, appId: '1:123:web:emulator-only' }, emulators: { auth: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}` } }) + ';\n';
process.env.FIREBASE_PROJECT_ID = projectId;
process.env.CLOUD_PORT = process.env.CLOUD_PORT || '8766';
// Never use production service-account configuration for a demo preview.
for (const key of ['FIREBASE_SERVICE_ACCOUNT_JSON', 'FIREBASE_SERVICE_ACCOUNT_BASE64', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'APP_ORIGIN']) delete process.env[key];
fs.writeFileSync(filename, preview);
function restore() {
  try { if (fs.readFileSync(filename, 'utf8') === preview) fs.writeFileSync(filename, original); } catch { /* A subsequent build owns its own generated config. */ }
}
process.on('exit', restore);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
console.log('Demo-only cloud preview: Firebase Auth + Firestore are local emulators; no real project data is used.');
require('./dev-server.cjs');
