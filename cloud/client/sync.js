const PREFIX = 'practice-quiz:';
const validKey = key => typeof key === 'string' && key.startsWith(PREFIX) && !key.endsWith(':probe');
const failure = error => error?.message || 'Could not reach your account storage.';

// Saved attempts are regraded by the server. Their untrusted summaries/results
// may differ byte-for-byte even when a retried submission has identical intent.
function sameValue(key, left, right) {
  if (left === right) return true;
  if (!key.endsWith(':attempt') || typeof left !== 'string' || typeof right !== 'string') return false;
  const identity = raw => {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || typeof value.quizId !== 'string' || typeof value.quizSignature !== 'string' || typeof value.submittedAt !== 'string' || typeof value.updatedAt !== 'string' || !value.answers || typeof value.answers !== 'object' || Array.isArray(value.answers)) return null;
    const answers = Object.fromEntries(Object.keys(value.answers).sort().map(id => [id, Array.isArray(value.answers[id]) ? [...value.answers[id]].sort() : value.answers[id]]));
    const flags = name => value[name] === undefined ? [] : Array.isArray(value[name]) ? [...value[name]].sort() : null;
    const reviewFlags = flags('reviewFlags'), outOfSyllabus = flags('outOfSyllabus');
    if (!reviewFlags || !outOfSyllabus) return null;
    return JSON.stringify([value.version, value.quizId, value.quizSignature, value.submittedAt, value.updatedAt, answers, reviewFlags, outOfSyllabus]);
  };
  try {const a = identity(left), b = identity(right); return a !== null && a === b;} catch {return false;}
}

export function createCloudSync({ uid, request, cache, notify = () => {}, remote = () => {}, delay = 400, shouldHydrate = () => true }) {
  if (!uid) throw new Error('Sign in before opening account storage.');
  const values = new Map(), revisions = new Map(), pending = new Map(), conflicts = new Map(), inflight = new Map(), editing = new Set();
  let cursor = 0, sequence = 0, timer = null, running = null, refreshing = null, initialization = null, closed = false, cacheWrite = Promise.resolve(), cacheError = false;
  const state = (name, message) => { if (!closed) notify({ state: name, message, pending: pending.size, conflicts: conflicts.size }); };
  function snapshot() {
    return { version: 1, uid, values: [...values], revisions: [...revisions], pending: [...pending], cursor, sequence };
  }
  function persistPending() {
    const current = snapshot();
    cacheWrite = cacheWrite.catch(() => {}).then(() => cache.write(uid, current)).then(() => { cacheError = false; }, () => {
      cacheError = true; state('error', 'Offline storage is unavailable. Keep this tab open until everything is synced.');
    });
    return cacheWrite;
  }
  function status() {
    if (conflicts.size) state('conflict', 'This progress was also changed on another device. Choose which version to keep.');
    else if (pending.size) state('syncing', `${pending.size} change${pending.size === 1 ? '' : 's'} waiting to sync`);
    else if (cacheError) state('error', 'Cloud is up to date; offline storage is unavailable.');
    else state('synced', 'Synced to your account');
  }
  function queue(key, value, { force = false } = {}) {
    if (closed) throw new Error('This account is no longer active. Reload and sign in again.');
    if (!validKey(key)) { if (key?.endsWith(':probe')) return; throw new Error('Invalid account storage key.'); }
    if (value !== null && typeof value !== 'string') throw new Error('Account storage values must be text.');
    if (!force && value === (values.get(key) ?? null)) return;
    if (value === null) values.delete(key); else values.set(key, value);
    pending.set(key, { value, baseRevision: pending.get(key)?.baseRevision ?? revisions.get(key) ?? 0, sequence: ++sequence });
    persistPending(); status();
    clearTimeout(timer);
    timer = setTimeout(() => flush().catch(() => {}), delay);
  }
  function checkedRecord(record, key) {
    if (!record || !validKey(record.key) || (key !== undefined && record.key !== key) || !Number.isSafeInteger(record.revision) || record.revision < 0 || (!record.deleted && typeof record.value !== 'string')) throw new Error('Invalid cloud state response.');
    return record;
  }
  const recordValue = record => record.deleted ? null : record.value;
  function merge(record, { local = false } = {}) {
    checkedRecord(record);
    const key = record.key, value = recordValue(record);
    const previous = values.get(key) ?? null;
    revisions.set(key, record.revision);
    if (value === null) values.delete(key); else values.set(key, value);
    if (!local && previous !== value) remote({ key, value, revision: record.revision });
  }
  async function getRemote(key) {
    const result = await request(`/api/state?key=${encodeURIComponent(key)}`);
    return checkedRecord(result.record || result, key);
  }
  async function parallelRead(items, read) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {const index = next++; results[index] = await read(items[index]);}
    }));
    return results;
  }
  async function refresh() {
    if (closed) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      let more = true;
      while (more && !closed) {
        const result = await request(`/api/state?since=${cursor}`);
        if (!Array.isArray(result.records)) throw new Error('Invalid cloud sync manifest.');
        const incoming = result.records.filter(item => {
          if (!validKey(item?.key) || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error('Invalid cloud sync manifest.');
          if (!pending.has(item.key) && !editing.has(item.key) && !shouldHydrate(item.key)) return false;
          return pending.has(item.key) || item.revision > (revisions.get(item.key) || 0) || (!item.deleted && !values.has(item.key));
        });
        const records = await parallelRead(incoming, item => item.deleted ? { ...item, value: null } : getRemote(item.key));
        for (let index = 0; index < incoming.length; index++) {
          const item = incoming[index], record = records[index];
          if (closed) return;
          checkedRecord(record, item.key);
          const waiting = pending.get(item.key), sending = inflight.get(item.key);
          if (editing.has(item.key)) {
            // Visible pointer ink has not reached storage yet. Never repaint it or
            // advance its base revision while another device changes this page.
            conflicts.set(item.key, record); state('conflict', 'Another device changed the drawing you are editing. Finish the stroke, then choose which version to keep.');
          } else if (waiting) {
            if (sameValue(item.key, waiting.value, recordValue(record))) {
              pending.delete(item.key); conflicts.delete(item.key); merge(record, { local: true });
            } else if (sending && sameValue(item.key, sending.value, recordValue(record)) && record.revision > sending.baseRevision) {
              // A poll can observe our earlier save before its HTTP response arrives.
              // Keep newer local ink/answers, but advance their compare-and-set base.
              revisions.set(item.key, Math.max(revisions.get(item.key) || 0, record.revision));
              waiting.baseRevision = Math.max(waiting.baseRevision, record.revision);
              const conflict = conflicts.get(item.key);
              if (conflict && conflict.revision <= record.revision) conflicts.delete(item.key);
            } else if (record.revision !== waiting.baseRevision) {
              conflicts.set(item.key, record); state('conflict', 'Another device saved a different version of this progress.');
            }
          } else merge(record);
        }
        cursor = result.cursor ?? cursor; more = Boolean(result.hasMore);
      }
      await persistPending(); status();
    })().catch(error => { state('offline', `${failure(error)} Your changes stay on this device until a connection returns.`); throw error; }).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function flush() {
    clearTimeout(timer);
    if (closed) return;
    if (running) return running;
    running = (async () => {
      while (!closed) {
        const next = [...pending].find(([key]) => !conflicts.has(key));
        if (!next) break;
        const [key, change] = next;
        inflight.set(key, change);
        try {
          const result = await request('/api/state', { method: 'PUT', body: { key, value: change.value, baseRevision: change.baseRevision } });
          if (closed) return;
          const record = checkedRecord(result.record || result, key), latest = pending.get(key), conflict = conflicts.get(key);
          revisions.set(key, Math.max(revisions.get(key) || 0, record.revision));
          if (conflict && conflict.revision > record.revision) {
            if (latest) latest.baseRevision = record.revision;
          } else {
            conflicts.delete(key);
            if (latest?.sequence === change.sequence) {
              pending.delete(key); merge(record, { local: true });
            } else if (latest) latest.baseRevision = record.revision;
          }
        } catch (error) {
          if (closed) return;
          if (error.status === 409) {
            const record = checkedRecord(error.data?.record || error.data?.current || await getRemote(key), key);
            const latest = pending.get(key);
            if (latest && sameValue(key, latest.value, recordValue(record))) {
              pending.delete(key); conflicts.delete(key); merge(record, { local: true });
            } else if (sameValue(key, recordValue(record), change.value)) {
              // The preceding request may have committed even if its response was lost.
              revisions.set(key, Math.max(revisions.get(key) || 0, record.revision));
              if (latest) latest.baseRevision = record.revision;
              conflicts.delete(key);
            } else if (!latest && (values.get(key) ?? null) === recordValue(record)) {
              conflicts.delete(key); merge(record, { local: true });
            } else {
              conflicts.set(key, record); status();
            }
          } else {
            const rejected = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
            state(rejected ? 'error' : 'offline', `${failure(error)} ${rejected ? 'Your change is kept on this device. Correct it or retry after resolving the error.' : 'Changes are kept on this device and will retry.'}`);
            throw error;
          }
        } finally { inflight.delete(key); await persistPending(); }
      }
      status();
    })().finally(() => { running = null; });
    return running;
  }
  function ready() {
    if (initialization) return initialization;
    initialization = (async () => {
      state('loading', 'Loading your account progress…');
      try {
        const saved = await cache.read(uid);
        if (saved?.version === 1 && saved.uid === uid) {
          for (const [key, value] of saved.values || []) if (validKey(key) && typeof value === 'string') values.set(key, value);
          for (const [key, revision] of saved.revisions || []) if (validKey(key) && Number.isSafeInteger(revision)) revisions.set(key, revision);
          for (const [key, change] of saved.pending || []) if (validKey(key) && change && (change.value === null || typeof change.value === 'string') && Number.isSafeInteger(change.baseRevision) && Number.isSafeInteger(change.sequence)) pending.set(key, change);
          // Rescan metadata for this page scope; a cached cursor may have skipped
          // note payloads that are now needed by the newly opened quiz.
          cursor = 0;
          sequence = Number.isSafeInteger(saved.sequence) ? saved.sequence : 0;
        }
      } catch { cacheError = true; }
      try { await refresh(); await flush(); }
      catch (error) { if (!values.size && !pending.size) throw error; }
      return api;
    })();
    return initialization;
  }
  async function resolveConflict(key, choice) {
    const record = conflicts.get(key);
    if (!record) return;
    if (editing.has(key)) throw new Error('Finish drawing before resolving this conflict.');
    if (choice === 'cloud') {
      pending.delete(key); conflicts.delete(key); merge(record);
    } else if (choice === 'device') {
      const change = pending.get(key);
      if (change) change.baseRevision = record.revision;
      else pending.set(key, {value:values.get(key) ?? null, baseRevision:record.revision, sequence:++sequence});
      conflicts.delete(key);
    } else throw new Error('Choose this device or the cloud version.');
    await persistPending(); await flush(); status();
  }
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => queue(key, String(value)),
    removeItem: key => queue(key, null),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; }
  };
  const api = {
    storage, ready, flush, refresh, persistPending, resolveConflict,
    entries: () => [...values], conflicts: () => [...conflicts],
    beginEdit(key) {
      if (closed) throw new Error('This account is no longer active. Reload and sign in again.');
      if (!validKey(key)) throw new Error('Invalid account storage key.');
      editing.add(key);
    },
    endEdit(key) { editing.delete(key); },
    isEditing: key => key === undefined ? editing.size > 0 : editing.has(key),
    pending: () => pending.size, close() { closed = true; editing.clear(); clearTimeout(timer); },
    async getAttempt(quizId) {
      if (closed) throw new Error('This account is no longer active. Reload and sign in again.');
      const key = `${PREFIX}${quizId}:attempt`, record = await getRemote(key);
      if (closed) throw new Error('This account is no longer active. Reload and sign in again.');
      if (!pending.has(key) && record.revision >= (revisions.get(key) || 0)) {
        merge(record, { local: true }); await persistPending();
      }
      return record.deleted ? null : JSON.parse(record.value);
    },
    async submitAttempt(quizId, attempt) {
      const key = `${PREFIX}${quizId}:attempt`;
      queue(key, JSON.stringify(attempt)); await flush();
      if (pending.has(key) || conflicts.has(key)) throw new Error('The submission has not reached your account. Resolve the sync notice and retry.');
      return JSON.parse(storage.getItem(key));
    },
    async resetAttempts() {
      await flush();
      if (pending.size || conflicts.size) throw new Error('Sync or resolve your pending changes before resetting submitted attempts.');
      await request('/api/reset-attempts', { method: 'POST', body: { confirm: true } });
      await refresh();
    },
    async importEntries(entries) {
      if (!Array.isArray(entries)) throw new Error('Invalid progress backup.');
      if (closed) throw new Error('This account is no longer active. Reload and sign in again.');
      const seen = new Set(), before = new Map();
      for (const pair of entries) {
        if (!Array.isArray(pair) || pair.length !== 2 || !validKey(pair[0]) || typeof pair[1] !== 'string' || seen.has(pair[0])) throw new Error('The backup has invalid or duplicate records.');
        seen.add(pair[0]);
        const existing = values.get(pair[0]);
        if (existing !== undefined && existing !== pair[1]) throw new Error('Your account already has different progress for this paper. Nothing was imported.');
        if (editing.has(pair[0])) throw new Error('Finish drawing before importing this page.');
        before.set(pair[0], {value:existing, sequence:pending.get(pair[0])?.sequence});
      }
      // Some account drawings are intentionally not hydrated on this page. Check
      // every incoming key on the server before creating any import operation.
      const records = await parallelRead(entries, ([key]) => getRemote(key));
      if (closed) throw new Error('This account is no longer active. Reload and sign in again.');
      for (let index = 0; index < entries.length; index++) {
        const [key, value] = entries[index], record = records[index], previous = before.get(key);
        if (editing.has(key) || previous.value !== values.get(key) || previous.sequence !== pending.get(key)?.sequence) throw new Error('Your progress changed during import. Nothing was imported; retry after finishing your edits.');
        if (!record.deleted && !sameValue(key, record.value, value)) throw new Error('Your account already has different progress for this paper. Nothing was imported.');
      }
      const verified = await parallelRead(entries, async ([key, value]) => {
        const result = await request('/api/state', {method:'POST', body:{key, value, validateOnly:true}});
        if (!result || result.key !== key || typeof result.value !== 'string') throw new Error('The imported progress could not be verified.');
        return result.value;
      });
      if (closed) throw new Error('This account is no longer active. Reload and sign in again.');
      for (const [key] of entries) {
        const previous = before.get(key);
        if (editing.has(key) || previous.value !== values.get(key) || previous.sequence !== pending.get(key)?.sequence) throw new Error('Your progress changed during import. Nothing was imported; retry after finishing your edits.');
      }
      for (let index = 0; index < entries.length; index++) {
        const [key] = entries[index], value = verified[index], record = records[index];
        revisions.set(key, record.revision);
        if (!record.deleted) {
          pending.delete(key); conflicts.delete(key); merge(record, {local:true});
        } else {
          const change = pending.get(key);
          if (change) change.baseRevision = record.revision;
          conflicts.delete(key); queue(key, value, {force:true});
        }
      }
      await persistPending(); await flush();
      if (pending.size || conflicts.size) throw new Error('Some imported changes are still waiting to sync. Keep this tab open and check the sync notice.');
    }
  };
  return api;
}
