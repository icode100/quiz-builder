'use strict';
const { createHash } = require('node:crypto');
const { getServices } = require('./admin.cjs');
const { loadCatalog } = require('./catalog.cjs');
const { createStateStore } = require('./store.cjs');
const { ApiError, classifyKey, validateValue } = require('./validation.cjs');
const { reply, sameOrigin, body, cookie, setCookie } = require('./http.cjs');
const SESSION_MS = 5 * 24 * 60 * 60 * 1000;
function createApiHandler(options = {}) {
  let store = options.store, auth = options.auth, catalog = options.catalog;
  const verifyingSessions = new Map();
  function dependencies() {
    if (!store || !auth) { const services = (options.getServices || getServices)(); auth ||= services.auth; store ||= createStateStore(services.db); }
    catalog ||= loadCatalog();
    return { store, auth, catalog };
  }
  async function account(req) {
    const session = cookie(req);
    if (!session) throw new ApiError(401, 'Sign in to sync your quiz.');
    let decoded;
    try {
      const key = createHash('sha256').update(session).digest('hex');
      let verification = verifyingSessions.get(key);
      if (!verification) {
        verification = Promise.resolve().then(() => dependencies().auth.verifySessionCookie(session, true));
        // Hydration reads several records concurrently. Share only a still
        // running check; completed successes/failures are never cached. Every
        // later request checks revocation again, and the UID guard still runs
        // separately for every request.
        if (verifyingSessions.size < 256) {
          verifyingSessions.set(key, verification);
          const clear = () => { if (verifyingSessions.get(key) === verification) verifyingSessions.delete(key); };
          verification.then(clear, clear);
        }
      }
      decoded = await verification;
    } catch { throw new ApiError(401, 'Your session has ended. Sign in again.'); }
    if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid || decoded.uid.includes('/') || decoded.uid.length > 128) throw new ApiError(401, 'Invalid account session.');
    return decoded;
  }
  const publicUser = user => ({ uid: user.uid, email: user.email || null, displayName: user.name || null, photoURL: user.picture || null });
  function matchingAccount(req, uid, required = true) {
    const expected = req.headers['x-quiz-account'];
    if ((required || expected !== undefined) && expected !== uid) throw new ApiError(409, 'The signed-in account changed in another tab. Reload before continuing.', { code: 'account-changed' });
  }
  async function readRecord(uid, key) {
    const { kind } = classifyKey(key, dependencies().catalog);
    const record = await store.get(uid, key);
    if (!record.deleted && kind === 'attempt') record.value = validateValue(key, record.value, catalog).value;
    return record;
  }
  return async function handler(req, res) {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`), route = options.route || url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
      const method = (req.method || 'GET').toUpperCase();
      const allowed = route === 'session' ? ['GET', 'POST', 'DELETE'] : route === 'state' ? ['GET', 'POST', 'PUT', 'DELETE'] : route === 'reset-attempts' ? ['POST'] : [];
      if (!allowed.length) throw new ApiError(404, 'Unknown app API.');
      if (!allowed.includes(method)) { res.setHeader('Allow', allowed.join(', ')); throw new ApiError(405, 'Method not allowed.'); }
      if (method !== 'GET') sameOrigin(req);
      if (route === 'session') {
        if (method === 'GET') {
          try { const user = await account(req); return reply(res, 200, { authenticated: true, user: publicUser(user) }); }
          catch (error) { if (error.status !== 401) throw error; return reply(res, 200, { authenticated: false, user: null }); }
        }
        if (method === 'DELETE') {
          if (req.headers['x-quiz-account'] && cookie(req)) {
            try { const user = await account(req); matchingAccount(req, user.uid); }
            catch (error) { if (error.status === 409) throw error; }
          }
          setCookie(req, res, '', 0); return reply(res, 200, { authenticated: false, user: null });
        }
        const input = await body(req);
        if (typeof input.idToken !== 'string' || input.idToken.length < 20 || input.idToken.length > 20000) throw new ApiError(400, 'A Firebase sign-in token is required.');
        let user, session, signInStage = 'dependencies';
        try {
          const auth = dependencies().auth;
          signInStage = 'verifyIdToken';
          user = await auth.verifyIdToken(input.idToken, true);
          if (!user?.uid || typeof user.uid !== 'string' || user.uid.includes('/') || user.uid.length > 128) throw Error('Invalid identity.');
          matchingAccount(req, user.uid, false);
          signInStage = 'createSessionCookie';
          session = await auth.createSessionCookie(input.idToken, { expiresIn: SESSION_MS });
        } catch (error) {
          if (error instanceof ApiError) throw error;
          // Do not log error messages/objects: upstream exceptions can contain
          // tokens or personal information. Only constrained diagnostic labels.
          const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?$/i.test(error.code) && error.code.length <= 80 ? error.code : 'unknown';
          const name = typeof error?.name === 'string' && /^[a-z][a-z0-9]{0,49}$/i.test(error.name) ? error.name : 'Error';
          console.error('Cloud quiz sign-in failed:', { stage: signInStage, code, name });
          throw new ApiError(401, 'Sign-in could not be verified. Please sign in again.');
        }
        setCookie(req, res, session, SESSION_MS / 1000);
        return reply(res, 200, { authenticated: true, user: publicUser(user), expiresIn: SESSION_MS });
      }
      const user = await account(req);
      matchingAccount(req, user.uid);
      res.setHeader('X-Quiz-Account', user.uid);
      if (route === 'reset-attempts') {
        const input = await body(req);
        if (input.confirm !== true) throw new ApiError(400, 'Confirm resetting your saved attempts.');
        const keys = [...catalog.keys()].map(id => `practice-quiz:${id}:attempt`);
        return reply(res, 200, await store.resetAttempts(user.uid, keys));
      }
      if (method === 'GET') {
        if (url.searchParams.has('key')) return reply(res, 200, await readRecord(user.uid, url.searchParams.get('key')));
        const raw = url.searchParams.get('since') ?? '0';
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ApiError(400, 'Invalid sync cursor.');
        return reply(res, 200, await store.list(user.uid, Number(raw)));
      }
      const input = await body(req), key = input.key;
      classifyKey(key, catalog);
      if (method === 'POST') {
        if (input.validateOnly !== true) throw new ApiError(400, 'POST is only available for migration validation.');
        return reply(res, 200, { key, value: validateValue(key, input.value, catalog).value });
      }
      let value = null;
      // A null PUT is the cache adapter's removeItem; DELETE is equivalent.
      if (method === 'PUT' && input.value !== null) value = validateValue(key, input.value, catalog).value;
      const saved = await store.write(user.uid, key, value, input.baseRevision);
      return reply(res, 200, saved);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 503;
      if (!(error instanceof ApiError)) console.error('Cloud quiz API failed:', error.code || error.name || 'Error');
      return reply(res, status, { error: error instanceof ApiError ? error.message : 'Cloud storage is temporarily unavailable or has not been configured yet.', ...(error instanceof ApiError ? error.extra : {}) });
    }
  };
}
module.exports = { createApiHandler, SESSION_MS };
