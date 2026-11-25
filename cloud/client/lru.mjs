const THEME_KEY = 'practice-quiz:theme';
const CACHE_FIELDS = ['values', 'revisions', 'knownKeys', 'lastUsed'];

// This bounds only the persisted read cache. Callers keep their live maps and
// drawing history intact, and explicitly pin every record involved in an edit.
export function pruneCacheSnapshot(snapshot, { pinnedKeys = [], maxBytes = 32 * 1024 * 1024, maxEntries = 256 } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('A cache snapshot is required.');
  if (!Number.isFinite(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new TypeError('Invalid cache limits.');
  const pinned = new Set([THEME_KEY, ...pinnedKeys]);
  for (const entry of snapshot.pending || []) if (typeof entry?.[0] === 'string') pinned.add(entry[0]);

  const records = new Map();
  const remember = key => {
    if (typeof key !== 'string' || records.has(key)) return;
    records.set(key, { key, bytes: 0, used: 0, order: records.size });
  };
  for (const entry of snapshot.values || []) {
    const [key, value] = entry;
    remember(key);
    if (typeof key === 'string' && typeof value === 'string') {
      // JS strings use UTF-16 code units. Avoid allocating encoded copies of
      // large drawings every time an unrelated answer changes.
      records.get(key).bytes += 2 * (key.length + value.length);
    }
  }
  for (const key of snapshot.knownKeys || []) remember(key);
  for (const [key] of snapshot.revisions || []) remember(key);
  for (const [key, used] of snapshot.lastUsed || []) {
    remember(key);
    if (typeof key === 'string' && Number.isFinite(used) && used >= 0) records.get(key).used = used;
  }
  const clean = [...records.values()].filter(record => !pinned.has(record.key));
  let bytes = clean.reduce((sum, record) => sum + record.bytes, 0), count = clean.length;
  const evicted = new Set();
  clean.sort((left, right) => left.used - right.used || left.order - right.order);
  for (const record of clean) {
    if (bytes <= maxBytes && count <= maxEntries) break;
    evicted.add(record.key); bytes -= record.bytes; count--;
  }
  const result = { ...snapshot };
  for (const field of CACHE_FIELDS) {
    if (!Array.isArray(snapshot[field])) continue;
    result[field] = snapshot[field].filter(entry => !evicted.has(field === 'knownKeys' ? entry : entry[0]));
  }
  // Pending edits are never filtered, including deletion tombstones. Copy the
  // array so callers cannot accidentally change the original list by pushing.
  if (Array.isArray(snapshot.pending)) result.pending = [...snapshot.pending];
  return result;
}
