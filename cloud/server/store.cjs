'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { ApiError } = require('./validation.cjs');
const INLINE_BYTES = 600 * 1024, CHUNK_BYTES = 480 * 1024, PAGE_SIZE = 100;
const digest = value => createHash('sha256').update(value).digest('hex');
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
function createStateStore(db) {
  const user = uid => {
    if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/')) throw new ApiError(401, 'Invalid account.');
    return db.collection('users').doc(uid);
  };
  const recordRef = (uid, key) => user(uid).collection('state').doc(digest(key));
  const publicRecord = saved => ({ key: saved.key, revision: saved.revision, updatedAt: saved.updatedAt, deleted: Boolean(saved.deleted) });
  const chunkRefs = (ref, saved) => Array.from({ length: saved.chunkCount || 0 }, (_, index) => ref.collection('versions').doc(saved.blobId).collection('chunks').doc(String(index).padStart(4, '0')));
  async function discard(refs) {
    if (!refs.length) return;
    const batch = db.batch(); refs.forEach(ref => batch.delete(ref)); await batch.commit();
  }
  async function get(uid, key) {
    const ref = recordRef(uid, key);
    for (let retry = 0; retry < 3; retry++) {
      const snapshot = await ref.get();
      if (!snapshot.exists) return { key, value: null, revision: 0, updatedAt: null, deleted: true };
      const saved = snapshot.data();
      if (saved.key !== key) throw new ApiError(500, 'The saved record identity could not be verified.');
      if (saved.deleted) return { ...publicRecord(saved), value: null };
      if (typeof saved.value === 'string') return { ...publicRecord(saved), value: saved.value };
      const refs = chunkRefs(ref, saved), chunks = refs.length ? await db.getAll(...refs) : [];
      if (chunks.length && chunks.every(chunk => chunk.exists)) {
        const value = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data().data, 'base64'))).toString('utf8');
        if (Buffer.byteLength(value, 'utf8') === saved.bytes && digest(value) === saved.digest) return { ...publicRecord(saved), value };
      }
      // A simultaneous save may have retired this immutable blob; reread its pointer.
    }
    throw new ApiError(503, 'The drawing is changing on another device. Retry in a moment.');
  }
  async function list(uid, since = 0) {
    if (!validRevision(since)) throw new ApiError(400, 'Invalid sync cursor.');
    const owner = user(uid), counter = await owner.get();
    const cursor = counter.exists ? counter.data().cursor || 0 : 0;
    if (!validRevision(cursor)) throw new ApiError(500, 'Invalid account revision.');
    if (since >= cursor) return { records: [], cursor, hasMore: false };
    const snapshots = await owner.collection('state').where('revision', '>', since).orderBy('revision').limit(PAGE_SIZE + 1).get();
    const docs = snapshots.docs.slice(0, PAGE_SIZE), records = docs.map(snapshot => publicRecord(snapshot.data()));
    const hasMore = snapshots.docs.length > PAGE_SIZE;
    return { records, cursor: hasMore ? records.at(-1).revision : Math.max(cursor, records.at(-1)?.revision || 0), hasMore };
  }
  async function write(uid, key, value, baseRevision) {
    if (!validRevision(baseRevision)) throw new ApiError(400, 'A valid base revision is required.');
    const ref = recordRef(uid, key), owner = user(uid), bytes = value === null ? 0 : Buffer.byteLength(value, 'utf8');
    let blob = {}, staged = [], prior;
    if (value !== null && bytes > INLINE_BYTES) {
      const data = Buffer.from(value, 'utf8'), blobId = randomUUID(), chunkCount = Math.ceil(data.length / CHUNK_BYTES);
      blob = { blobId, chunkCount, bytes, digest: digest(value) };
      staged = chunkRefs(ref, blob);
      const batch = db.batch();
      staged.forEach((chunk, index) => batch.set(chunk, { index, data: data.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64') }));
      await batch.commit();
    } else if (value !== null) blob = { value };
    let result;
    try {
      result = await db.runTransaction(async transaction => {
        const [currentSnapshot, ownerSnapshot] = await transaction.getAll(ref, owner);
        prior = currentSnapshot.exists ? currentSnapshot.data() : null;
        const revision = prior?.revision || 0;
        if (revision !== baseRevision) throw new ApiError(409, 'This record changed on another device. Your local changes have been kept.', { key, revision });
        const cursor = ownerSnapshot.exists ? ownerSnapshot.data().cursor || 0 : 0;
        if (!validRevision(cursor) || cursor === Number.MAX_SAFE_INTEGER) throw new ApiError(500, 'Invalid account revision.');
        const saved = { key, revision: cursor + 1, updatedAt: Date.now(), deleted: value === null, ...blob };
        transaction.set(ref, saved);
        transaction.set(owner, { cursor: saved.revision, updatedAt: saved.updatedAt }, { merge: true });
        return { ...publicRecord(saved), value };
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await discard(staged).catch(() => {});
        error.extra.record = await get(uid, key);
      }
      throw error;
    }
    if (prior?.blobId) await discard(chunkRefs(ref, prior)).catch(() => {});
    return result;
  }
  async function resetAttempts(uid, keys) {
    const owner = user(uid), refs = keys.map(key => recordRef(uid, key));
    let old = [];
    const result = await db.runTransaction(async transaction => {
      const [ownerSnapshot, ...snapshots] = await transaction.getAll(owner, ...refs);
      let cursor = ownerSnapshot.exists ? ownerSnapshot.data().cursor || 0 : 0, count = 0;
      if (!validRevision(cursor) || cursor > Number.MAX_SAFE_INTEGER - refs.length) throw new ApiError(500, 'Invalid account revision.');
      old = []; const updatedAt = Date.now();
      snapshots.forEach((snapshot, index) => {
        if (!snapshot.exists || snapshot.data().deleted) return;
        const saved = snapshot.data(); old.push({ ref: refs[index], saved });
        transaction.set(refs[index], { key: keys[index], revision: ++cursor, updatedAt, deleted: true }); count++;
      });
      if (count) transaction.set(owner, { cursor, updatedAt }, { merge: true });
      return { count, cursor };
    });
    for (const { ref, saved } of old) if (saved.blobId) await discard(chunkRefs(ref, saved)).catch(() => {});
    return result;
  }
  return { get, list, write, resetAttempts };
}
module.exports = { createStateStore, INLINE_BYTES, CHUNK_BYTES, PAGE_SIZE };
