// Account-scoped offline cache; the server remains the shared source of truth.
export function createAccountCache(indexedDB = globalThis.indexedDB) {
  let database;
  async function open() {
    if (!indexedDB) throw new Error('Offline storage is unavailable in this browser.');
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('gate-practice-cloud', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('accounts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }
  async function operation(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('accounts', mode);
      const request = action(transaction.objectStore('accounts'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || new Error('Offline cache transaction failed.'));
    });
  }
  return { read: uid => operation('readonly', store => store.get(uid)), write: (uid, value) => operation('readwrite', store => store.put(value, uid)) };
}
