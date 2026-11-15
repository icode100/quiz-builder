import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAuthController, authErrorMessage } from '../cloud/client/auth-core.mjs';

const config = { enabled: true, firebase: { apiKey: 'test-key', authDomain: 'test.firebaseapp.com', projectId: 'test-project', appId: 'test-app' } };
function fixture(options = {}) {
  const calls = [], events = [], listeners = new Set();
  const user = options.user || null;
  const sdk = {
    browserLocalPersistence: 'local', inMemoryPersistence: 'memory',
    getApps: () => [],
    initializeApp(settings, name) { calls.push(['initialize', settings, name]); return { name }; },
    getAuth: () => ({ useDeviceLanguage() {} }),
    async setPersistence(auth, persistence) { calls.push(['persist', persistence]); if (options.persistenceFails && persistence === 'local') throw Error('storage'); },
    onAuthStateChanged(auth, success, error) { listeners.add(success); sdk.authError = error; queueMicrotask(() => success(user)); return () => listeners.delete(success); },
    getRedirectResult: async () => null,
    GoogleAuthProvider: class { setCustomParameters(value) { calls.push(['google-options', value]); } },
    async signInWithPopup() { calls.push(['popup']); if (options.popupError) throw { code: options.popupError }; return { user }; },
    async signInWithRedirect() { calls.push(['redirect']); },
    async signInWithEmailAndPassword(auth, email, password) { calls.push(['email', email, password]); return { user }; },
    async createUserWithEmailAndPassword(auth, email, password) { calls.push(['create', email, password]); return { user }; },
    async sendPasswordResetEmail(auth, email) { calls.push(['reset', email]); },
    async signOut() { calls.push(['signout']); for (const listener of listeners) listener(null); },
    connectAuthEmulator(auth, url) { calls.push(['emulator', url]); }
  };
  const controller = createAuthController({ sdk, config: options.config || config, hostname: options.hostname || 'example.vercel.app', timeoutMs: 1000,
    eventTarget: { dispatchEvent(event) { events.push(event); } }, makeEvent: (name, detail) => ({ name, detail }) });
  return { controller, calls, events, sdk, emit: value => { for (const listener of listeners) listener(value); } };
}

// All credentials, users and Firebase calls are synthetic; no real account is touched.
const unavailable = fixture({ config: {} });
const unavailableState = await unavailable.controller.ready;
assert.equal(unavailableState.loading, false);
assert.equal(unavailableState.user, null);
assert.match(authErrorMessage(unavailableState.error), /configured/);
await assert.rejects(unavailable.controller.signInEmail('a@example.com', 'not-a-real-password'), /configured/);
assert.equal(unavailable.calls.length, 0);
unavailable.controller.dispose();

const disabled = fixture({ config: { enabled: false } });
assert.equal((await disabled.controller.ready).enabled, false);
assert.equal(disabled.calls.length, 0);
disabled.controller.dispose();

let refresh = null;
const restoredUser = { uid: 'account-one', email: 'a@example.com', async getIdToken(force) { refresh = force; return 'synthetic-token'; } };
const restored = fixture({ user: restoredUser });
const snapshots = [];
const stop = restored.controller.subscribe(state => snapshots.push(state));
assert.equal((await restored.controller.ready).user, restoredUser);
assert.equal(restored.controller.getUser(), restoredUser);
assert.equal(await restored.controller.getToken(true), 'synthetic-token');
assert.equal(refresh, true);
assert.equal(restored.events.length, 1);
assert.equal(restored.events[0].name, 'quiz-auth-changed');
assert.equal(restored.events[0].detail.user.uid, 'account-one');
await restored.controller.signInEmail('  a@example.com  ', 'keep spaces in password ');
assert.deepEqual(restored.calls.at(-1), ['email', 'a@example.com', 'keep spaces in password ']);
await restored.controller.createAccount(' b@example.com ', 'fake-new-password');
assert.deepEqual(restored.calls.at(-1), ['create', 'b@example.com', 'fake-new-password']);
await restored.controller.resetPassword(' b@example.com ');
assert.deepEqual(restored.calls.at(-1), ['reset', 'b@example.com']);
assert.equal(restored.events.length, 1, 'Busy and presentation changes do not masquerade as account changes');
assert.ok(snapshots.some(snapshot => snapshot.working === 'email'));
restored.emit({ uid: 'account-two', email: 'b@example.com' });
assert.equal(restored.controller.getUser().uid, 'account-two');
assert.equal(restored.events.at(-1).detail.user.uid, 'account-two');
await restored.controller.signOut();
assert.equal(restored.controller.getUser(), null);
assert.equal(await restored.controller.getToken(), null);
assert.equal(restored.events.at(-1).detail.user, null);
stop(); restored.controller.dispose();

const popupFallback = fixture({ popupError: 'auth/popup-blocked' });
await popupFallback.controller.ready;
await popupFallback.controller.signInGoogle();
assert.ok(popupFallback.calls.some(call => call[0] === 'popup'));
assert.ok(popupFallback.calls.some(call => call[0] === 'redirect'));
assert.deepEqual(popupFallback.calls.find(call => call[0] === 'google-options'), ['google-options', { prompt: 'select_account' }]);
assert.equal(popupFallback.controller.getState().working, '');
popupFallback.controller.dispose();

const popupCancelled = fixture({ popupError: 'auth/popup-closed-by-user' });
await popupCancelled.controller.ready;
await assert.rejects(popupCancelled.controller.signInGoogle());
assert.equal(popupCancelled.calls.some(call => call[0] === 'redirect'), false, 'Cancelling a popup must not force page navigation');
assert.match(authErrorMessage(popupCancelled.controller.getState().error), /cancelled/);
assert.equal(popupCancelled.controller.getState().working, '');
popupCancelled.controller.dispose();

const memory = fixture({ persistenceFails: true });
assert.equal((await memory.controller.ready).persistence, 'memory');
assert.deepEqual(memory.calls.filter(call => call[0] === 'persist'), [['persist', 'local'], ['persist', 'memory']]);
memory.controller.dispose();

const badEmulator = fixture({ config: { ...config, emulators: { auth: 'http://127.0.0.1:9099' } } });
assert.match(authErrorMessage((await badEmulator.controller.ready).error), /this computer/);
badEmulator.controller.dispose();
const localEmulator = fixture({ config: { ...config, emulators: { auth: 'http://127.0.0.1:9099' } }, hostname: 'localhost' });
await localEmulator.controller.ready;
assert.ok(localEmulator.calls.some(call => call[0] === 'emulator'));
localEmulator.controller.dispose();

const timed = createAuthController({ sdk: { getApps: () => [], initializeApp: () => ({}), getAuth: () => ({}), setPersistence: () => new Promise(() => {}) }, config, timeoutMs: 10 });
assert.match(authErrorMessage((await timed.ready).error), /taking too long/);
assert.equal(timed.getState().loading, false);
timed.dispose();
assert.equal(authErrorMessage({ code: 'auth/wrong-password' }), authErrorMessage({ code: 'auth/user-not-found' }));
assert.equal(authErrorMessage(new Error('private SDK details')), 'Unable to sign in. Please try again.');

const source = readFileSync(new URL('../cloud/client/account-ui.js', import.meta.url), 'utf8');
assert.match(source, /quiz-cloud-before-sign-out/);
assert.match(source, /Promise\.all\(waits\)/);
assert.match(source, /quiz-cloud-import-requested/);
assert.match(source, /data-cloud-protected/);
assert.match(source, /field\.type = show \? 'text' : 'password'/);
assert.equal(source.includes('localStorage'), false, 'Account UI does not read, move or clear quiz data');
console.log('Cloud auth checks passed: startup/config errors, restored and switched accounts, token refresh, email operations, popup/redirect behavior, sign-out, storage fallback, loopback emulators and bounded loading. No real accounts or quiz data touched.');
