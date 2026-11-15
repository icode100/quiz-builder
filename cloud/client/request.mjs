const TIMEOUT_MESSAGE = 'Loading your account took too long. Your saved work is unchanged. Please retry.';

export async function getAccountToken(getToken, { force = false, timeoutMs = 15000 } = {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => getToken(force)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

// Cover both response headers and the body. A response with stalled JSON must
// not leave the account gate waiting forever (including when abort is ignored).
export function createAccountRequester({ getUser, getToken, accountChanged = () => {}, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  async function request(path, options = {}, uid, renew = true) {
    if (!uid || getUser()?.uid !== uid) throw new Error('Your account changed. Reload before continuing.');
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(TIMEOUT_MESSAGE));
        controller.abort();
      }, timeoutMs);
    });
    const work = (async () => {
      const response = await fetchImpl(path, { method: options.method || 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'X-Quiz-Account': uid, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
      let result;
      try { result = await response.json(); }
      catch { result = { error: 'The server returned an unreadable response.' }; }
      return { response, result };
    })();
    let response, result;
    try { ({ response, result } = await Promise.race([work, expired])); }
    finally { clearTimeout(timer); }
    if (getUser()?.uid !== uid) throw new Error('Your account changed. Reload before continuing.');
    if (response.status === 401 && renew && path !== '/api/session') {
      await request('/api/session', { method: 'POST', body: { idToken: await getAccountToken(getToken, { force: true, timeoutMs }) } }, uid, false);
      return request(path, options, uid, false);
    }
    if (!response.ok) {
      if (result?.code === 'account-changed') accountChanged();
      const error = new Error(result?.error || 'Could not reach account storage.');
      error.status = response.status; error.data = result;
      throw error;
    }
    return result;
  }
  return request;
}
