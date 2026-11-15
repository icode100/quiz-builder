/* Shared account controls; the sync adapter owns all quiz state and migration. */
import { auth, authErrorMessage } from './auth.js';

export function mountAccountUI(host = document.getElementById('cloud-account')) {
  if (!host) {
    host = document.createElement('div');
    host.id = 'cloud-account';
    document.body.prepend(host);
  }
  if (host.dataset.accountMounted) return window.QuizAccountUI;
  host.dataset.accountMounted = 'true';
  host.innerHTML = `
    <section class="cloud-account" aria-label="Practice account">
      <div class="cloud-account-bar" id="cloud-account-bar" hidden>
        <span class="cloud-avatar" id="cloud-account-avatar" aria-hidden="true"></span>
        <div class="cloud-account-identity"><strong id="cloud-account-name"></strong><span id="cloud-account-email"></span></div>
        <p id="cloud-sync-status" class="cloud-sync-status" role="status" aria-live="polite">Connecting to your saved practice…</p>
        <div class="cloud-account-actions">
          <button id="cloud-import-local" type="button" class="cloud-button cloud-button-quiet" hidden title="Copy practice saved in this browser to your account">Import local practice</button>
          <button id="cloud-sign-out" type="button" class="cloud-button cloud-button-quiet">Sign out</button>
        </div>
      </div>
      <div class="cloud-auth-card" id="cloud-auth-card">
        <p class="cloud-auth-eyebrow">Your practice account</p>
        <h2>Pick up where you left off</h2>
        <p class="cloud-auth-intro">Sign in to keep your answers, timer, rough work and question annotations together across your devices.</p>
        <p id="cloud-auth-loading" class="cloud-auth-loading" role="status">Checking your account…</p>
        <div id="cloud-auth-controls" hidden>
          <button id="cloud-google-sign-in" class="cloud-button cloud-button-google" type="button"><span class="cloud-google-mark" aria-hidden="true">G</span>Continue with Google</button>
          <div class="cloud-auth-divider"><span>or use email</span></div>
          <div class="cloud-auth-mode" role="group" aria-label="Account action">
            <button id="cloud-mode-sign-in" type="button" aria-pressed="true">Sign in</button>
            <button id="cloud-mode-create" type="button" aria-pressed="false">Create account</button>
          </div>
          <form id="cloud-email-form">
            <label for="cloud-auth-email">Email</label>
            <input id="cloud-auth-email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="254">
            <div class="cloud-password-label"><label for="cloud-auth-password">Password</label><button id="cloud-show-password" type="button" aria-pressed="false" aria-controls="cloud-auth-password">Show</button></div>
            <input id="cloud-auth-password" name="password" type="password" autocomplete="current-password" required maxlength="128" aria-describedby="cloud-password-hint">
            <p id="cloud-password-hint" class="cloud-field-hint" hidden>Use at least eight characters.</p>
            <button id="cloud-email-submit" type="submit" class="cloud-button cloud-button-primary">Sign in</button>
          </form>
          <button id="cloud-reset-password" type="button" class="cloud-text-button">Forgot password?</button>
        </div>
        <p id="cloud-auth-message" class="cloud-auth-message" role="alert" hidden></p>
        <button id="cloud-auth-reload" type="button" class="cloud-button cloud-button-quiet" hidden>Reload sign-in</button>
      </div>
      <p id="cloud-account-message" class="cloud-account-message" role="status" aria-live="polite" hidden></p>
    </section>`;

  const byId = id => host.querySelector(`#${id}`);
  let mode = 'signin', current = auth.getState(), availableImports = 0;
  let syncStatus = { state: 'loading', message: 'Connecting to your saved practice…' };
  const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
  const buttons = () => host.querySelectorAll('button, input');
  function showMessage(message, error = false, account = false) {
    const node = byId(account ? 'cloud-account-message' : 'cloud-auth-message');
    node.textContent = message;
    node.hidden = !message;
    node.classList.toggle('cloud-message-error', error);
    node.setAttribute('role', error ? 'alert' : 'status');
  }
  function drawSyncStatus() {
    const node = byId('cloud-sync-status');
    const fallback = {
      synced: 'All changes saved', saved: 'All changes saved',
      syncing: 'Saving your changes…', pending: 'Saving your changes…',
      loading: 'Loading your saved practice…',
      offline: 'Offline. Reconnect to sync your changes.',
      error: 'Your changes have not synced. Try reconnecting.',
      conflict: 'This question changed on another device. Review the sync notice.'
    };
    const selected = offline() ? { state: 'offline' } : syncStatus;
    const message = selected.message || fallback[selected.state] || 'Connecting to your saved practice…';
    if (node.textContent !== message) node.textContent = message;
    node.dataset.state = selected.state;
  }
  function setMode(next) {
    mode = next === 'create' ? 'create' : 'signin';
    byId('cloud-mode-sign-in').setAttribute('aria-pressed', String(mode === 'signin'));
    byId('cloud-mode-create').setAttribute('aria-pressed', String(mode === 'create'));
    byId('cloud-email-submit').textContent = mode === 'create' ? 'Create account' : 'Sign in';
    byId('cloud-auth-password').autocomplete = mode === 'create' ? 'new-password' : 'current-password';
    byId('cloud-auth-password').minLength = mode === 'create' ? 8 : 0;
    byId('cloud-password-hint').hidden = mode !== 'create';
    byId('cloud-reset-password').hidden = mode === 'create';
    showMessage('');
  }
  function render(next) {
    const previousUid = current.user?.uid;
    current = next;
    host.hidden = !next.enabled;
    if (!next.enabled) return;
    const signedIn = Boolean(next.user), busy = next.loading || Boolean(next.working);
    document.documentElement.classList.toggle('cloud-authenticated', signedIn);
    document.documentElement.classList.toggle('cloud-signed-out', !signedIn);
    byId('cloud-account-bar').hidden = !signedIn;
    byId('cloud-auth-card').hidden = signedIn;
    byId('cloud-auth-loading').hidden = !next.loading;
    byId('cloud-auth-controls').hidden = next.loading;
    byId('cloud-auth-reload').hidden = next.loading || Boolean(auth.getApp());
    host.setAttribute('aria-busy', String(next.loading));
    buttons().forEach(button => { button.disabled = busy; });
    if (!next.loading && !auth.getApp()) host.querySelectorAll('#cloud-auth-controls button, #cloud-auth-controls input').forEach(control => { control.disabled = true; });
    if (!signedIn || next.loading) {
      document.querySelectorAll('[data-cloud-protected]').forEach(region => { region.inert = true; });
    }
    byId('cloud-import-local').hidden = !signedIn || availableImports === 0;
    if (signedIn) {
      const user = next.user, name = user.displayName || user.email || 'Your account';
      byId('cloud-account-name').textContent = name;
      byId('cloud-account-email').textContent = user.displayName ? (user.email || '') : '';
      byId('cloud-account-avatar').textContent = name.trim().slice(0, 1).toUpperCase();
      byId('cloud-auth-password').value = '';
      byId('cloud-auth-password').type = 'password';
      byId('cloud-show-password').textContent = 'Show';
      byId('cloud-show-password').setAttribute('aria-pressed', 'false');
      if (previousUid !== user.uid) showMessage('', false, true);
      if (next.persistence === 'memory') showMessage('You are signed in for this tab only because browser storage is unavailable.', false, true);
      if (next.error) showMessage(authErrorMessage(next.error), true, true);
    } else if (next.error) showMessage(authErrorMessage(next.error), true);
    drawSyncStatus();
  }
  async function act(action, successMessage = '') {
    showMessage('', false, Boolean(current.user));
    try {
      await action();
      if (successMessage) showMessage(successMessage);
    } catch (error) { showMessage(authErrorMessage(error), true, Boolean(current.user)); }
  }

  byId('cloud-mode-sign-in').addEventListener('click', () => setMode('signin'));
  byId('cloud-mode-create').addEventListener('click', () => setMode('create'));
  byId('cloud-google-sign-in').addEventListener('click', () => act(() => auth.signInGoogle()));
  byId('cloud-email-form').addEventListener('submit', event => {
    event.preventDefault();
    if (current.loading || current.working || !event.currentTarget.reportValidity()) return;
    const email = byId('cloud-auth-email').value, password = byId('cloud-auth-password').value;
    act(() => mode === 'create' ? auth.createAccount(email, password) : auth.signInEmail(email, password));
  });
  byId('cloud-show-password').addEventListener('click', () => {
    const field = byId('cloud-auth-password'), show = field.type === 'password';
    field.type = show ? 'text' : 'password';
    byId('cloud-show-password').textContent = show ? 'Hide' : 'Show';
    byId('cloud-show-password').setAttribute('aria-pressed', String(show));
  });
  byId('cloud-reset-password').addEventListener('click', () => {
    const email = byId('cloud-auth-email');
    if (!email.reportValidity()) { email.focus(); return; }
    act(() => auth.resetPassword(email.value), 'If an account uses this email, password-reset instructions have been sent.');
  });
  byId('cloud-sign-out').addEventListener('click', async () => {
    if (current.working) return;
    byId('cloud-sign-out').disabled = true;
    const waits = [];
    document.dispatchEvent(new CustomEvent('quiz-cloud-before-sign-out', { detail: { waitUntil: promise => waits.push(Promise.resolve(promise)) } }));
    try { await Promise.all(waits); await auth.signOut(); }
    catch { showMessage('Could not finish signing out. Your account is still signed in; try again.', true, true); }
    finally { byId('cloud-sign-out').disabled = Boolean(current.working); }
  });
  byId('cloud-import-local').addEventListener('click', () => {
    if (!current.user || current.working || availableImports === 0) return;
    document.dispatchEvent(new CustomEvent('quiz-cloud-import-requested', { detail: { uid: current.user.uid } }));
  });
  byId('cloud-auth-reload').addEventListener('click', () => window.location.reload());
  document.addEventListener('quiz-cloud-status', event => {
    syncStatus = { state: event.detail?.state || 'loading', message: event.detail?.message || '' };
    drawSyncStatus();
  });
  function setImportAvailable(count) {
    availableImports = Number.isInteger(count) && count > 0 ? count : 0;
    byId('cloud-import-local').hidden = !current.user || availableImports === 0;
  }
  document.addEventListener('quiz-cloud-import-available', event => setImportAvailable(event.detail?.count));
  window.addEventListener('online', drawSyncStatus);
  window.addEventListener('offline', drawSyncStatus);
  const stop = auth.subscribe(render);
  const api = { setImportAvailable, showMessage: (message, error = false) => showMessage(message, error, Boolean(current.user)), destroy: stop };
  window.QuizAccountUI = api;
  return api;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountAccountUI(), { once: true });
else mountAccountUI();
