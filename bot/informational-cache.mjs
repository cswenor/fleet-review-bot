// Ephemeral representations only: never an authority or an admission cache.
const owners = new WeakMap();
// A sweep has ~48 PR heads. Each head uses PR/compare/review resources plus
// workflow discovery/detail pages in both display and candidate preparation.
// Reserve 32 representations per head (including pagination/PR-key variants),
// rather than letting one 256-entry FIFO cycle-thrash the entire sweep.
// No head can crowd out another's bytes: at most 64 MiB / 2048 entries total.
const MAX_HEADS = 64;
const MAX_ENTRIES_PER_HEAD = 32;
const MAX_BYTES_PER_HEAD = 1024 * 1024;

export function invalidateInformational(client, { headSha, pr, all } = {}) {
  const owner = owners.get(client);
  if (!owner) return;
  const matches = row => (headSha !== undefined && row.headSha === headSha)
    || (pr !== undefined && row.pr === pr);
  // Invalidate outstanding observations, not validators. A later ticket may use
  // the old body ONLY after its own guarded upstream 304. Matching-head webhook
  // events and main moves must not erase every validator before the next sweep.
  if (all) owner.epoch++;
  else for (const ticket of owner.tickets) {
    if (matches(ticket)) ticket.invalidated = true;
  }
}

function remove(bucket, key) {
  const entry = bucket.entries.get(key);
  if (entry) bucket.bytes -= entry.bytes;
  bucket.entries.delete(key);
}

export function informationalRead(client, { appId, installationId, repo, method, path, accept, apiVersion, headSha, pr }) {
  if (!Number.isSafeInteger(appId) || appId <= 0 || !Number.isSafeInteger(installationId) || installationId <= 0
    || typeof repo !== 'string' || !repo || typeof headSha !== 'string' || !headSha || method !== 'GET') return null;
  let owner = owners.get(client);
  if (!owner) {
    owner = { heads: new Map(), epoch: 0, tickets: new Set() };
    owners.set(client, owner);
  }
  const headKey = JSON.stringify([appId, installationId, repo, headSha]);
  let bucket = owner.heads.get(headKey);
  if (!bucket) bucket = { entries: new Map(), bytes: 0 };
  owner.heads.delete(headKey);
  owner.heads.set(headKey, bucket);
  while (owner.heads.size > MAX_HEADS) owner.heads.delete(owner.heads.keys().next().value);
  const key = JSON.stringify([appId, installationId, repo, method, path, accept, apiVersion, headSha, pr ?? null]);
  const epoch = owner.epoch;
  const entry = bucket.entries.get(key);
  if (entry) {
    bucket.entries.delete(key);
    bucket.entries.set(key, entry);
  }
  const ticket = { headSha, pr, invalidated: false };
  owner.tickets.add(ticket);
  const valid = () => owner.epoch === epoch && !ticket.invalidated && owner.heads.get(headKey) === bucket;
  return {
    release() { owner.tickets.delete(ticket); },
    etag() { return valid() && entry && bucket.entries.get(key) === entry ? entry.etag : null; },
    representation() {
      if (!valid() || !entry || bucket.entries.get(key) !== entry) throw new Error('github_informational_304_without_representation');
      return JSON.parse(entry.json);
    },
    store(etag, value) {
      if (!valid()) throw new Error('github_informational_invalidated');
      remove(bucket, key);
      if (typeof etag !== 'string' || !etag) return;
      const json = JSON.stringify(value);
      const bytes = Buffer.byteLength(key) + Buffer.byteLength(etag) + Buffer.byteLength(json);
      if (bytes > MAX_BYTES_PER_HEAD) return;
      bucket.entries.set(key, { etag, json, bytes });
      bucket.bytes += bytes;
      while (bucket.entries.size > MAX_ENTRIES_PER_HEAD || bucket.bytes > MAX_BYTES_PER_HEAD) {
        remove(bucket, bucket.entries.keys().next().value);
      }
    },
  };
}
