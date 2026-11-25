'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const clone = value => value === undefined ? undefined : structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));

// These controlled IndexedDB events exercise stalled Safari-style operations;
// no real browser database, user state, or cloud account is opened.
function indexedFixture() {
  const accounts = new Map(), opens = [], transactions = [];
  let openBehavior = request => queueMicrotask(() => request.onsuccess?.());
  let transactionBehavior = transaction => queueMicrotask(() => transaction.complete());
  const indexedDB = {
    open() {
      const db = {
        closed: 0,
        createObjectStore() {},
        close() { this.closed++; },
        transaction(name, mode) {
          assert.equal(name, 'accounts');
          if (db.broken) throw new Error('Connection is closed');
          const transaction = {
            aborted: false, mode,
            abort() { this.aborted = true; this.onabort?.(); },
            complete() {
              if (this.aborted) return;
              if (this.write) accounts.set(this.key, clone(this.value));
              this.request.result = this.write ? this.key : clone(accounts.get(this.key));
              this.oncomplete?.();
            },
            objectStore() {
              return {
                get(key) { transaction.key = key; transaction.request = {}; transactionBehavior(transaction); return transaction.request; },
                put(value, key) { transaction.write = true; transaction.key = key; transaction.value = clone(value); transaction.request = {}; transactionBehavior(transaction); return transaction.request; }
              };
            }
          };
          transactions.push(transaction); return transaction;
        }
      };
      const request = { result: db, transaction: { aborts: 0, abort() { this.aborts++; } } };
      opens.push(request); openBehavior(request); return request;
    }
  };
  return { indexedDB, accounts, opens, transactions, onOpen(value) { openBehavior = value; }, onTransaction(value) { transactionBehavior = value; } };
}

(async () => {
  const source = await fs.readFile(path.join(__dirname, '../cloud/client/cache.js'), 'utf8');
  const { createAccountCache } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const fixture = indexedFixture(), cache = createAccountCache(fixture.indexedDB, { timeoutMs: 25 });
  await cache.write('alice', { uid: 'alice', pending: [['draft', '-']] });
  await cache.write('bob', { uid: 'bob', pending: [] });
  assert.deepEqual(await cache.read('alice'), { uid: 'alice', pending: [['draft', '-']] });
  assert.equal((await cache.read('bob')).uid, 'bob');
  assert.equal(fixture.opens.length, 1, 'Normal operations reuse the open connection');

  // A successful request does not count as a durable write until transaction commit.
  fixture.onTransaction(transaction => queueMicrotask(() => { transaction.request.result = transaction.key; transaction.request.onsuccess?.(); }));
  let committed = false;
  const awaitingCommit = cache.write('alice', { uid: 'alice', pending: [] }).then(() => { committed = true; });
  await tick(); assert.equal(committed, false);
  fixture.transactions.at(-1).complete(); await awaitingCommit; assert.equal(committed, true);

  const blocked = indexedFixture();
  blocked.onOpen(request => queueMicrotask(() => request.onblocked?.()));
  const blockedCache = createAccountCache(blocked.indexedDB, { timeoutMs: 1000 });
  await assert.rejects(blockedCache.read('alice'), /blocked.*another tab/i);
  const staleBlocked = blocked.opens[0];
  blocked.onOpen(request => queueMicrotask(() => request.onsuccess?.()));
  await blockedCache.write('alice', { pending: ['preserved'] });
  staleBlocked.onsuccess();
  assert.equal(staleBlocked.result.closed, 1, 'A late blocked connection is closed');
  assert.deepEqual(await blockedCache.read('alice'), { pending: ['preserved'] });
  assert.equal(blocked.opens.length, 2, 'A blocked open does not poison future retries');

  const stalled = indexedFixture(); stalled.onOpen(() => {});
  const stalledCache = createAccountCache(stalled.indexedDB, { timeoutMs: 10 });
  await assert.rejects(stalledCache.read('alice'), /did not respond/);
  const staleOpen = stalled.opens[0]; staleOpen.onupgradeneeded(); staleOpen.onsuccess();
  assert.equal(staleOpen.transaction.aborts, 1, 'A late upgrade is aborted after open timeout');
  assert.equal(staleOpen.result.closed, 1, 'A late open cannot leave a connection behind');
  stalled.onOpen(request => queueMicrotask(() => request.onsuccess?.()));
  await stalledCache.write('alice', { pending: ['recovered'] });
  assert.deepEqual(await stalledCache.read('alice'), { pending: ['recovered'] });

  // A read or write transaction can stall after the database opens successfully.
  fixture.onTransaction(() => {});
  await assert.rejects(cache.read('alice'), /did not respond/);
  const stalledRead = fixture.transactions.at(-1);
  assert.equal(stalledRead.aborted, true);
  assert.equal(fixture.opens[0].result.closed, 1);
  const beforeWrite = clone(fixture.accounts.get('alice'));
  await assert.rejects(cache.write('alice', { pending: ['late overwrite'] }), /did not respond/);
  const stalledWrite = fixture.transactions.at(-1); stalledWrite.complete();
  assert.equal(stalledWrite.aborted, true);
  assert.deepEqual(fixture.accounts.get('alice'), beforeWrite, 'Timed-out writes are aborted before a later operation can overwrite progress');
  fixture.onTransaction(transaction => queueMicrotask(() => transaction.complete()));
  assert.deepEqual(await cache.read('alice'), beforeWrite);

  // Recover stale connections when another tab upgrades/closes the database.
  const current = fixture.opens.at(-1).result; current.onversionchange();
  assert.equal(current.closed, 1);
  await cache.read('bob'); assert.notEqual(fixture.opens.at(-1).result, current);
  const broken = fixture.opens.at(-1).result; broken.broken = true;
  await assert.rejects(cache.read('alice'), /Connection is closed/);
  await cache.read('alice'); assert.notEqual(fixture.opens.at(-1).result, broken);

  const errored = indexedFixture();
  errored.onOpen(request => queueMicrotask(() => { request.error = new Error('Open denied'); request.onerror?.(); }));
  const erroredCache = createAccountCache(errored.indexedDB, { timeoutMs: 25 });
  await assert.rejects(erroredCache.read('alice'), /Open denied/);
  errored.onOpen(request => queueMicrotask(() => request.onsuccess?.()));
  await erroredCache.read('alice'); assert.equal(errored.opens.length, 2);
  const throws = createAccountCache({ open() { throw new Error('Storage denied'); } }, { timeoutMs: 25 });
  await assert.rejects(throws.read('alice'), /Storage denied/);
  await assert.rejects(createAccountCache(null).read('alice'), /unavailable/);
  console.log('Cloud cache checks passed: account isolation, commit completion, bounded blocked/open/read/write stalls, late-event cleanup and connection retries.');
})().catch(error => { console.error(error); process.exitCode = 1; });
