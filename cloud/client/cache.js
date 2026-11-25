// Account-scoped offline cache; the server remains the shared source of truth.
export function createAccountCache(indexedDB = globalThis.indexedDB, { timeoutMs = 5000 } = {}) {
  let database, connection;
  const timeoutError = () => new Error('Offline storage did not respond. Close other tabs for this app and reload to retry.');
  function disconnect(db) {
    if (connection === db) { connection = undefined; database = undefined; }
    db.onversionchange = null; db.onclose = null;
    try { db.close?.(); } catch {}
  }
  async function open() {
    if (!indexedDB) throw new Error('Offline storage is unavailable in this browser.');
    if (!database) {
      const opening = new Promise((resolve, reject) => {
        let request, finished = false;
        const deadline = setTimeout(() => finish(timeoutError()), timeoutMs);
        function finish(error, db) {
          if (finished) { if (db) disconnect(db); return; }
          finished = true; clearTimeout(deadline);
          if (error) reject(error);
          else {
            connection = db;
            db.onversionchange = () => disconnect(db);
            db.onclose = () => disconnect(db);
            resolve(db);
          }
        }
        try {
          request = indexedDB.open('gate-practice-cloud', 1);
          request.onupgradeneeded = () => {
            // An open request cannot be cancelled. Abort a late upgrade and close
            // a late connection so a timed-out request cannot hold future tabs up.
            if (finished) { try { request.transaction?.abort(); } catch {} return; }
            try { request.result.createObjectStore('accounts'); }
            catch (error) { finish(error); try { request.transaction?.abort(); } catch {} }
          };
          request.onsuccess = () => finish(null, request.result);
          request.onerror = () => finish(request.error || new Error('Offline storage could not open.'));
          request.onblocked = () => finish(new Error('Offline storage is blocked by another tab. Close other tabs for this app and reload to retry.'));
        } catch (error) { finish(error); }
      });
      database = opening;
      opening.catch(() => { if (database === opening) database = undefined; });
    }
    return database;
  }
  async function operation(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let transaction, request, finished = false;
      function finish(error) {
        if (finished) return;
        finished = true; clearTimeout(deadline);
        if (error) reject(error); else resolve(request.result);
      }
      const deadline = setTimeout(() => {
        finish(timeoutError());
        try { transaction?.abort(); } catch {}
        disconnect(db);
      }, timeoutMs);
      try {
        transaction = db.transaction('accounts', mode);
        transaction.oncomplete = () => finish();
        transaction.onerror = () => finish(transaction.error || request?.error || new Error('Offline cache transaction failed.'));
        transaction.onabort = () => finish(transaction.error || new Error('Offline cache transaction failed.'));
        request = action(transaction.objectStore('accounts'));
      } catch (error) {
        finish(error);
        try { transaction?.abort(); } catch {}
        disconnect(db);
      }
    });
  }
  return { read: uid => operation('readonly', store => store.get(uid)), write: (uid, value) => operation('readwrite', store => store.put(value, uid)) };
}
