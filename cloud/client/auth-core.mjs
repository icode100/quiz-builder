/* Firebase owns credentials. Quiz data is hydrated separately after account changes. */
const messages = Object.freeze({
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/invalid-credential': 'The email or password is incorrect.',
  'auth/wrong-password': 'The email or password is incorrect.',
  'auth/user-not-found': 'The email or password is incorrect.',
  'auth/weak-password': 'Use a stronger password with at least eight characters.',
  'auth/password-does-not-meet-requirements': 'This password does not meet the account password requirements.',
  'auth/email-already-in-use': 'Unable to create an account with these details. Try signing in or resetting the password.',
  'auth/popup-closed-by-user': 'Sign-in was cancelled. You can try again.',
  'auth/cancelled-popup-request': 'Another sign-in window is already open.',
  'auth/popup-blocked': 'The sign-in window was blocked. Use the Google sign-in button again or sign in with email.',
  'auth/network-request-failed': 'Unable to reach sign-in. Check your connection and try again.',
  'auth/too-many-requests': 'Too many sign-in attempts. Wait a little before trying again.',
  'auth/user-disabled': 'This account is disabled. Contact the app owner.',
  'auth/operation-not-allowed': 'This sign-in method has not been enabled yet.',
  'auth/unauthorized-domain': 'Sign-in is not enabled for this address yet. Contact the app owner.',
  'auth/invalid-api-key': 'The sign-in configuration is incomplete. Contact the app owner.',
  'auth/account-exists-with-different-credential': 'This email uses another sign-in method. Use the method you originally chose.',
  'auth/web-storage-unsupported': 'This browser cannot keep you signed in. Allow site storage and try again.'
});

export function authErrorMessage(error) {
  return messages[error?.code] || (error?.quizAuthMessage ? error.message : 'Unable to sign in. Please try again.');
}

const ownError = message => Object.assign(new Error(message), { quizAuthMessage: true });

export function createAuthController({ sdk, config = {}, eventTarget = null, makeEvent = null, hostname = '', timeoutMs = 20000 }) {
  const enabled = config.enabled !== false;
  const firebase = config.firebase || config.firebaseConfig || config;
  const subscribers = new Set();
  let auth = null, app = null, stopAuth = null, stopped = false, resolved = false;
  let resolveReady;
  let state = { enabled, user: null, loading: enabled, working: '', error: null, persistence: 'local' };
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const snapshot = () => ({ ...state });
  const emit = (authChanged = false) => {
    const current = snapshot();
    for (const listener of subscribers) {
      try { listener(current); } catch { /* One view must not stop other account listeners. */ }
    }
    if (authChanged && eventTarget && makeEvent) eventTarget.dispatchEvent(makeEvent('quiz-auth-changed', current));
  };
  const finishReady = () => {
    if (resolved) return;
    resolved = true;
    clearTimeout(initialTimer);
    resolveReady(snapshot());
  };
  const initialTimer = enabled ? setTimeout(() => {
    if (resolved || stopped) return;
    state = { ...state, loading: false, error: ownError('Sign-in is taking too long. Check your connection, then reload this page.') };
    emit(true); finishReady();
  }, timeoutMs) : null;

  async function initialize() {
    if (!enabled) { state.loading = false; finishReady(); return; }
    try {
      if (!['apiKey', 'authDomain', 'projectId', 'appId'].every(key => typeof firebase[key] === 'string' && firebase[key].trim())) {
        throw ownError('Account sign-in has not been configured for this deployment yet.');
      }
      app = sdk.getApps().find(candidate => candidate.name === 'gate-cse-practice') || sdk.initializeApp(firebase, 'gate-cse-practice');
      auth = sdk.getAuth(app);
      auth.useDeviceLanguage?.();
      const emulator = config.emulators?.auth;
      if (emulator) {
        const parsed = new URL(emulator);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.protocol !== 'http:') {
          throw ownError('Authentication emulators are available on this computer only.');
        }
        sdk.connectAuthEmulator(auth, parsed.href.replace(/\/$/, ''), { disableWarnings: true });
      }
      try { await sdk.setPersistence(auth, sdk.browserLocalPersistence); }
      catch {
        state.persistence = 'memory';
        await sdk.setPersistence(auth, sdk.inMemoryPersistence);
      }
      if (stopped) return;
      stopAuth = sdk.onAuthStateChanged(auth, user => {
        if (stopped) return;
        state = { ...state, user, loading: false, error: null };
        emit(true); finishReady();
      }, error => {
        if (stopped) return;
        state = { ...state, user: null, loading: false, error };
        emit(true); finishReady();
      });
      // The auth-state listener owns the active user; redirect completion only reports errors.
      sdk.getRedirectResult(auth).catch(error => {
        if (stopped) return;
        state = { ...state, loading: false, error };
        emit(); finishReady();
      });
    } catch (error) {
      state = { ...state, loading: false, error };
      emit(true); finishReady();
    }
  }

  async function run(working, action) {
    await ready;
    if (!auth) throw state.error || ownError('Account sign-in is unavailable.');
    if (state.working) throw ownError('Wait for the current account action to finish.');
    state = { ...state, working, error: null }; emit();
    try { return await action(); }
    catch (error) { state = { ...state, error }; emit(); throw error; }
    finally { state = { ...state, working: '' }; emit(); }
  }

  const api = {
    ready,
    getUser: () => state.user,
    getApp: () => app,
    getState: snapshot,
    getToken: async (forceRefresh = false) => { await ready; return state.user ? state.user.getIdToken(forceRefresh) : null; },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('An account listener must be a function.');
      subscribers.add(listener); listener(snapshot());
      return () => subscribers.delete(listener);
    },
    signInGoogle({ redirect = false } = {}) {
      return run('google', async () => {
        const provider = new sdk.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        if (redirect) return sdk.signInWithRedirect(auth, provider);
        try { return await sdk.signInWithPopup(auth, provider); }
        catch (error) {
          if (!['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(error?.code)) throw error;
          return sdk.signInWithRedirect(auth, provider);
        }
      });
    },
    signInEmail(email, password) { return run('email', () => sdk.signInWithEmailAndPassword(auth, email.trim(), password)); },
    createAccount(email, password) { return run('create', () => sdk.createUserWithEmailAndPassword(auth, email.trim(), password)); },
    resetPassword(email) { return run('reset', () => sdk.sendPasswordResetEmail(auth, email.trim())); },
    signOut() { return run('signout', () => sdk.signOut(auth)); },
    errorMessage: authErrorMessage,
    dispose() { stopped = true; clearTimeout(initialTimer); stopAuth?.(); subscribers.clear(); finishReady(); }
  };
  initialize();
  return api;
}
