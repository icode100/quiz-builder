import { getAccountToken } from './request.mjs';

// Authenticate server requests without making a trusted account's cached UI
// wait for the session refresh. Cold-cache reads still wait for that refresh.
export async function openAccountStorage({ uid, getToken, request, createSync, ...options }) {
  let sessionReady, force = false, stopping = false;
  const requests = new Set();
  function establishSession() {
    if (!sessionReady) {
      const current = (async () => {
        try { await request('/api/session', { method: 'POST', body: { idToken: await getAccountToken(getToken, { force }) } }); }
        catch (error) { if (error.status) throw error; }
      })();
      sessionReady = current;
      // A warm UI can outlive a failed session refresh. Let later polls/saves
      // retry together instead of permanently retaining a rejected barrier.
      current.catch(error => {
        if (sessionReady === current) sessionReady = null;
        if (error.status === 401) force = true;
      });
    }
    return sessionReady;
  }
  establishSession();
  const sync = createSync({ ...options, uid, request: async (...args) => {
    if (stopping) throw new Error('Account storage is closing. Reload to continue.');
    await establishSession();
    if (stopping) throw new Error('Account storage is closing. Reload to continue.');
    const response = Promise.resolve().then(() => request(...args));
    requests.add(response);
    try { return await response; }
    finally { requests.delete(response); }
  } });
  sync.endSession = async () => {
    stopping = true;
    // Delete last: a still-running POST must not recreate the session cookie
    // after the user has signed out of a cache-first page.
    await sessionReady?.catch(() => {});
    // An existing data request may itself be renewing a 401 session. Its
    // complete promise includes that renewal, so drain it before deleting.
    await Promise.allSettled([...requests]);
    await request('/api/session', { method: 'DELETE' });
  };
  try { await sync.ready(); return sync; }
  catch (error) { sync.close(); throw error; }
}
