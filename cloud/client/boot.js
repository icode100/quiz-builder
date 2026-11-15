import { auth } from './auth.js';
import { createAccountCache } from './cache.js';
import { createCloudSync } from './sync.js';
import { shouldHydrateOnPage, startupKeysForPage } from './hydration.mjs';
import { createAccountRequester } from './request.mjs';
import { openAccountStorage } from './startup.mjs';

const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
const protectedAreas = () => document.querySelectorAll('[data-cloud-protected]');
let activeUid = null, initialized = false, connecting = false, sync = null, poll = null, connectionError = null;
const accountCache = createAccountCache();
function gate(value) { protectedAreas().forEach(node => { node.inert = value; node.hidden = value; }); }
function notice(message, error = true) { window.QuizAccountUI?.showMessage(message, error); }
const jsonRequest = createAccountRequester({
  getUser: () => auth.getUser(), getToken: force => auth.getToken(force),
  accountChanged: () => { gate(true); sync?.close(); location.reload(); }
});
function loadRuntime() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = document.body.dataset.cloudPage === 'home' ? '/_template/home.js' : 'quiz.js';
    script.onload = resolve; script.onerror = () => reject(new Error('The quiz could not load. Refresh to retry.'));
    document.body.append(script);
  });
}
function conflictPanel() {
  let host = document.getElementById('cloud-conflicts');
  if (!host) {
    host = document.createElement('section'); host.id = 'cloud-conflicts'; host.className = 'cloud-conflicts';
    host.setAttribute('aria-label', 'Resolve progress changed on another device');
    document.getElementById('cloud-account').append(host);
  }
  host.replaceChildren();
  const conflicts = sync?.conflicts() || [];
  host.hidden = !conflicts.length;
  for (const [key] of conflicts) {
    const row = document.createElement('div'), text = document.createElement('p');
    text.textContent = `Another device changed ${key.replace('practice-quiz:', '')}. Your version is kept here until you choose.`;
    row.append(text);
    for (const [choice, label] of [['cloud', 'Use cloud version'], ['device', 'Keep this device’s version']]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'cloud-button cloud-button-quiet'; button.textContent = label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await sync.resolveConflict(key, choice); conflictPanel(); } catch (error) { notice(error.message); button.disabled = false; }
      }); row.append(button);
    }
    host.append(row);
  }
}
function localEntries() {
  try { return Object.keys(localStorage).filter(key => key.startsWith('practice-quiz:') && !key.endsWith(':probe')).map(key => [key, localStorage.getItem(key)]); }
  catch { return []; }
}
function migrationPanel() {
  let panel = document.getElementById('cloud-migration');
  if (panel) { panel.hidden = !panel.hidden; return; }
  panel = document.createElement('section'); panel.id = 'cloud-migration'; panel.className = 'cloud-conflicts';
  const heading = document.createElement('h3'); heading.textContent = 'Bring your existing practice to this account';
  const help = document.createElement('p'); help.textContent = 'Import a quiz browser backup or a submitted attempt JSON file. Existing different account progress is kept; the import will stop if it finds a conflict.';
  panel.append(heading, help);
  async function perform(entries) {
    try { await sync.importEntries(entries); notice('Imported and synced. Refresh the page to load your practice.', false); }
    catch (error) { notice(error.message); }
  }
  const entries = localEntries();
  if (entries.length) {
    const local = document.createElement('button'); local.type = 'button'; local.className = 'cloud-button cloud-button-quiet'; local.textContent = `Import this browser’s ${entries.length} saved records`;
    local.addEventListener('click', () => perform(entries)); panel.append(local);
  }
  const label = document.createElement('label'); label.textContent = 'Choose backup or submitted report JSON files';
  const files = document.createElement('input'); files.type = 'file'; files.accept = '.json,application/json'; files.multiple = true;
  files.addEventListener('change', async () => {
    try {
      const incoming = [];
      for (const file of files.files || []) {
        if (file.size > 20 * 1024 * 1024) throw new Error('This backup is too large. Import smaller paper backups separately.');
        const value = JSON.parse(await file.text());
        if (value?.format === 'practice-quiz-browser-transfer' && value.version === 1 && Array.isArray(value.entries)) incoming.push(...value.entries);
        else if (value?.version === 1 && typeof value.quizId === 'string' && value.answers && value.submittedAt) incoming.push([`practice-quiz:${value.quizId}:attempt`, JSON.stringify(value)]);
        else throw new Error('Select a quiz browser backup or an existing attempt.json report.');
      }
      await perform(incoming);
    } catch (error) { notice(error.message); }
    files.value = '';
  }); label.append(files); panel.append(label);
  document.getElementById('cloud-account').append(panel);
}
async function connect(user) {
  if (!user || connecting || initialized) return;
  connecting = true; activeUid = user.uid; gate(true);
  emit('quiz-cloud-status', { state: 'loading', message: 'Connecting to your account…' });
  const request = (path, options) => jsonRequest(path, options, user.uid);
  try {
    sync = await openAccountStorage({ uid: user.uid, request, cache: accountCache, createSync: createCloudSync,
      getToken: force => auth.getToken(force),
      startupKeys: startupKeysForPage({ page: document.body.dataset.cloudPage, quizId: document.body.dataset.quizId,
        quizIds: Array.from(document.querySelectorAll('#home-papers > [data-quiz-id]'), card => card.dataset.quizId) }),
      shouldHydrate: key => shouldHydrateOnPage(key, { page: document.body.dataset.cloudPage, quizId: document.body.dataset.quizId }),
      notify: status => { emit('quiz-cloud-status', status); if (status.state === 'conflict') conflictPanel(); },
      remote: record => emit('quiz-cloud-record', record) });
    if (auth.getUser()?.uid !== user.uid) { sync.close(); return; }
    window.QuizCloudSync = sync;
    emit('quiz-cloud-record', { key: 'practice-quiz:theme', value: sync.storage.getItem('practice-quiz:theme') });
    gate(false); await loadRuntime(); initialized = true;
    sync.startBackgroundRefresh?.().catch(() => {});
    if (connectionError) { window.QuizAccountUI?.clearMessageIfMatches(connectionError); connectionError = null; }
    document.getElementById('cloud-connect-retry')?.remove();
    window.QuizAccountUI?.setImportAvailable(Math.max(1, localEntries().length));
    const refresh = () => {
      if (document.hidden || auth.getUser()?.uid !== user.uid) return;
      sync.flush().then(() => sync.refresh()).catch(() => {});
    };
    poll = setInterval(refresh, 10000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', () => { if (document.hidden) sync.persistPending(); else refresh(); });
    window.addEventListener('pagehide', () => sync.persistPending());
    window.addEventListener('beforeunload', event => {
      if (!sync.hasUncachedChanges()) return;
      event.preventDefault(); event.returnValue = '';
    });
    document.addEventListener('click', async event => {
      const link = event.target.closest?.('a[href]');
      if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || link.target === '_blank' || !sync.pending()) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || url.hash && url.pathname === location.pathname) return;
      event.preventDefault();
      try { await sync.prepareToLeave(); location.href = url.href; }
      catch (error) { notice(error.message); }
    });
  } catch (error) {
    sync?.close(); sync = null; activeUid = null;
    connectionError = error.message;
    emit('quiz-cloud-status', { state: 'error', message: error.message }); notice(error.message);
    let retry = document.getElementById('cloud-connect-retry');
    if (!retry) { retry = document.createElement('button'); retry.id = 'cloud-connect-retry'; retry.type = 'button'; retry.className = 'cloud-button cloud-button-quiet'; retry.textContent = 'Retry loading practice'; retry.addEventListener('click', () => connect(auth.getUser())); document.getElementById('cloud-account').append(retry); }
  } finally { connecting = false; }
}
export async function boot() {
  gate(true);
  document.addEventListener('quiz-cloud-import-requested', migrationPanel);
  document.addEventListener('quiz-cloud-before-sign-out', event => {
    event.detail.waitUntil((async () => { await sync?.prepareToLeave(); await sync?.endSession().catch(() => {}); })());
  });
  document.addEventListener('quiz-auth-changed', event => {
    const user = event.detail?.user;
    if (activeUid && user?.uid !== activeUid) { gate(true); sync?.close(); clearInterval(poll); location.reload(); return; }
    if (user) connect(user);
  });
  const result = await auth.ready;
  if (result.user) await connect(result.user);
}
