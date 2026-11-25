'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const key = name => `practice-quiz:${name}`;
const clone = value => JSON.parse(JSON.stringify(value));
const snapshot = (entries, extra = {}) => ({ version: 2, uid: 'synthetic-account-a', values: entries, revisions: entries.map(([name], index) => [name, index + 1]), pending: [], knownKeys: entries.map(([name]) => name), lastUsed: entries.map(([name], index) => [name, index + 1]), cursor: 123, sequence: 456, ...extra });
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
const kept = value => value.values.map(([name]) => name);
(async () => {
  const { pruneCacheSnapshot } = await import(pathToFileURL(path.resolve(__dirname, '../cloud/client/lru.mjs')));

  const a = key('a'), b = key('b'), c = key('c');
  const original = deepFreeze(snapshot([[a, 'first'], [b, 'second'], [c, 'third']], { metadata: { keep: 'unchanged' } }));
  const before = clone(original), first = pruneCacheSnapshot(original, { maxEntries: 2 });
  assert.deepEqual(kept(first), [b, c]); assert.deepEqual(original, before, 'Pruning cannot mutate a frozen source snapshot');
  assert.notEqual(first, original); assert.notEqual(first.values, original.values);
  assert.deepEqual(first.metadata, original.metadata); assert.equal(first.uid, original.uid); assert.equal(first.cursor, 123); assert.equal(first.sequence, 456);
  for (const field of ['values', 'revisions', 'lastUsed']) assert.equal(first[field].some(([name]) => name === a), false);
  assert.equal(first.knownKeys.includes(a), false, 'Eviction removes confirmed markers with payloads and revisions');

  // A read after restoring a snapshot, rather than insertion order, controls
  // the next eviction. Simulate the caller persisting its latest usage record.
  const restored = clone(first); restored.values.push([a, 'reloaded']); restored.revisions.push([a, 4]); restored.knownKeys.push(a); restored.lastUsed = [[b, 100], [c, 3], [a, 4]];
  const reread = pruneCacheSnapshot(restored, { maxEntries: 2 });
  assert.deepEqual(kept(reread), [b, a], 'The recently read older entry survives another reload and prune');
  const tied = snapshot([[c, 'c'], [a, 'a'], [b, 'b']], { lastUsed: [] });
  assert.deepEqual(kept(pruneCacheSnapshot(tied, { maxEntries: 2 })), [a, b], 'Missing usage values are cold; equal ages use stable input order');

  const byteCost = (name, value) => 2 * (name.length + value.length);
  const unicode = snapshot([[a, '🙂'], [b, 'é']]);
  assert.deepEqual(kept(pruneCacheSnapshot(unicode, { maxBytes: byteCost(b, 'é') })), [b], 'Byte estimates count UTF-16 code units including surrogate pairs');
  assert.deepEqual(kept(pruneCacheSnapshot(unicode, { maxBytes: byteCost(a, '🙂') + byteCost(b, 'é') })), [a, b], 'The byte limit is inclusive');
  const enormous = snapshot([[a, 'x'.repeat(17 * 1024 * 1024)]]);
  assert.equal(pruneCacheSnapshot(enormous).values.length, 0, 'The default cache budget is 32MiB of UTF-16 text');
  const many = snapshot(Array.from({ length: 260 }, (_, index) => [key(String(index)), 'small']));
  assert.equal(pruneCacheSnapshot(many).values.length, 256, 'The default clean-entry budget is 256');

  const theme = key('theme'), draft = key('draft'), deletion = key('deleted'), conflict = key('conflict'), inflight = key('inflight'), editing = key('editing');
  const protectedSnapshot = snapshot([[theme, 'dark'], [draft, 'unsent answer'], [a, 'replaceable'], [conflict, 'both versions'], [inflight, 'sending'], [editing, 'active ink']], {
    pending: [[draft, { value: 'unsent answer', baseRevision: 8, sequence: 1 }], [deletion, { value: null, baseRevision: 9, sequence: 2 }]],
    knownKeys: [theme, draft, a, conflict, inflight, editing, deletion],
    revisions: [[theme, 1], [draft, 8], [a, 2], [conflict, 3], [inflight, 4], [editing, 5], [deletion, 9]],
    lastUsed: [[theme, 0], [draft, 0], [a, 99], [conflict, 0], [inflight, 0], [editing, 0], [deletion, 0]]
  });
  const protectedBefore = clone(protectedSnapshot), protectedResult = pruneCacheSnapshot(protectedSnapshot, { maxBytes: 0, maxEntries: 0, pinnedKeys: [conflict, inflight, editing] });
  assert.deepEqual(kept(protectedResult), [theme, draft, conflict, inflight, editing], 'Theme, pending and caller pins are exempt even above both limits');
  assert.deepEqual(protectedResult.pending, protectedBefore.pending, 'Pending saves and deletion tombstones are preserved exactly');
  assert.equal(protectedResult.knownKeys.includes(deletion), true); assert.equal(protectedResult.revisions.find(([name]) => name === deletion)[1], 9);
  assert.deepEqual(protectedSnapshot, protectedBefore, 'Pruning protected work does not modify nested changes');

  const missing = snapshot([], { knownKeys: [a, b, c], revisions: [[a, 0], [b, 0], [c, 0]], lastUsed: [[a, 50], [b, 1], [c, 2]] });
  const missingResult = pruneCacheSnapshot(missing, { maxEntries: 2 });
  assert.deepEqual(missingResult.knownKeys, [a, c], 'Confirmed-missing markers cannot grow outside the entry budget');
  assert.deepEqual(missingResult.revisions, [[a, 0], [c, 0]]); assert.deepEqual(missingResult.lastUsed, [[a, 50], [c, 2]]);
  const orphans = snapshot([], { revisions: [[a, 1], [b, 2]], lastUsed: [[a, 1], [b, 2]] });
  assert.deepEqual(pruneCacheSnapshot(orphans, { maxEntries: 1 }).revisions, [[b, 2]], 'Orphan metadata is bounded as well');

  const legacy = deepFreeze({ version: 1, uid: 'synthetic-account-b', values: [[a, 'legacy A'], [b, 'legacy B']], revisions: [[a, 1], [b, 2]], pending: [[a, { value: 'legacy A', baseRevision: 0 }]], cursor: 9, unknownField: ['retained'] });
  const legacyBefore = clone(legacy), legacyResult = pruneCacheSnapshot(legacy, { maxEntries: 0 });
  assert.deepEqual(kept(legacyResult), [a]); assert.equal(legacyResult.version, 1); assert.equal(legacyResult.uid, 'synthetic-account-b');
  assert.equal(Object.hasOwn(legacyResult, 'knownKeys'), false, 'Legacy absence is not converted into a confirmed-missing marker');
  assert.equal(Object.hasOwn(legacyResult, 'lastUsed'), false); assert.deepEqual(legacyResult.unknownField, ['retained']); assert.deepEqual(legacy, legacyBefore);
  assert.equal(first.uid, 'synthetic-account-a'); assert.deepEqual(original, before, 'Pruning account B cannot change account A or its source');
  for (const limits of [{ maxBytes: -1 }, { maxBytes: NaN }, { maxEntries: -1 }, { maxEntries: 1.5 }]) assert.throws(() => pruneCacheSnapshot(original, limits), /limits/);
  console.log('Persistent cache LRU checks passed: UTF-16 size/count bounds, reload recency, stable ties, protected pending/deletions/theme/editing, bounded missing markers, immutable legacy snapshots and account isolation. Synthetic data only.');
})().catch(error => { console.error(error); process.exitCode = 1; });
