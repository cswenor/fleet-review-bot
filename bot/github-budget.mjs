import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const priorities = ['presentation', 'review', 'merge'];
const context = new AsyncLocalStorage();
const MINUTE = 60_000;
const WINDOW = 61 * MINUTE;
const DEFAULTS = {
  presentation: { charge: 2000, wire: 4000, floor: 1500 },
  review: { charge: 3200, wire: 8000, floor: 800 },
  merge: { charge: 4000, wire: 10000, floor: 100 },
};
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const validPriority = (priority) => {
  if (!priorities.includes(priority)) throw new TypeError('Unknown GitHub budget priority');
  return priority;
};
export function githubPriority() { return context.getStore(); }
export function withGitHubPriority(priority, callback) {
  return context.run(validPriority(priority), callback);
}
export class GitHubBudgetDeferred extends Error {
  constructor(priority, retryAt, reason) {
    super('GitHub API budget deferred');
    this.code = 'github_budget_deferred';
    this.priority = priority;
    this.retryAt = retryAt;
    this.reason = reason;
  }
}
const emptyCounts = () => Object.fromEntries(priorities.map((p) => [p, { charge: 0, wire: 0 }]));
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
function numericHeader(headers, name) {
  const value = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
  return (typeof value === 'string' && /^\d+$/.test(value)) || typeof value === 'number'
    ? (integer(Number(value)) ? Number(value) : null) : null;
}

// All durable data is accounting only. Each synchronous operation takes the same
// SQLite write lock used by Store; no network operation occurs inside that lock.
export class GitHubBudget {
  constructor({ store, scope, now = Date.now, log = () => {}, limits = {} }) {
    if (!store || typeof store.transaction !== 'function' || typeof scope !== 'string'
      || !/^[A-Za-z0-9_.:/-]{1,256}$/.test(scope) || scope.includes('://')) {
      throw new TypeError('Invalid GitHub budget scope or store');
    }
    if (!keys(limits, Object.keys(limits)) || Object.keys(limits).some((k) => ![...priorities, 'pending'].includes(k))) {
      throw new TypeError('Invalid GitHub budget limits');
    }
    this.limits = Object.fromEntries(priorities.map((p) => {
      const override = limits[p] ?? {};
      if (!keys(override, Object.keys(override)) || Object.keys(override).some((k) => !['charge', 'wire', 'floor'].includes(k))) {
        throw new TypeError('Invalid GitHub budget limits');
      }
      const value = { ...DEFAULTS[p], ...override };
      if (!Object.values(value).every(integer) || value.charge > DEFAULTS[p].charge
        || value.wire > DEFAULTS[p].wire) throw new TypeError('Invalid GitHub budget limits');
      return [p, value];
    }));
    for (let i = 1; i < priorities.length; i++) {
      const low = this.limits[priorities[i - 1]], high = this.limits[priorities[i]];
      if (low.charge > high.charge || low.wire > high.wire || low.floor < high.floor) {
        throw new TypeError('Invalid GitHub budget limit ordering');
      }
    }
    this.maxPending = limits.pending ?? 10000;
    if (!integer(this.maxPending) || !this.maxPending || this.maxPending > 10000) throw new TypeError('Invalid pending limit');
    this.store = store; this.scope = scope; this.now = now; this.log = log;
  }
  clock() {
    const now = this.now();
    if (!integer(now) || now > Number.MAX_SAFE_INTEGER - WINDOW) throw new Error('Invalid accounting clock');
    return now;
  }
  load() {
    const row = this.store.get('SELECT record_json FROM github_budget WHERE scope=?', this.scope);
    if (!row) return { version: 1, scope: this.scope, lastNow: this.clock(), sequence: 0, buckets: [], pending: [], core: null, blockedUntil: 0 };
    if (typeof row.record_json !== 'string' || row.record_json.length > 3_000_000) throw new Error('Invalid accounting record');
    const s = JSON.parse(row.record_json);
    const fail = () => { throw new Error('Invalid accounting record'); };
    if (!keys(s, ['version', 'scope', 'lastNow', 'sequence', 'buckets', 'pending', 'core', 'blockedUntil'])
      || s.version !== 1 || s.scope !== this.scope || !integer(s.lastNow) || s.lastNow > Number.MAX_SAFE_INTEGER - WINDOW || !integer(s.sequence)
      || !integer(s.blockedUntil) || !Array.isArray(s.buckets) || s.buckets.length > 61
      || !Array.isArray(s.pending) || s.pending.length > 10000) fail();
    let previous = -1;
    for (const b of s.buckets) {
      if (!keys(b, ['minute', 'counts']) || !integer(b.minute) || b.minute <= previous
        || b.minute > Math.floor(s.lastNow / MINUTE) || b.minute < Math.floor(s.lastNow / MINUTE) - 60
        || !keys(b.counts, priorities)) fail();
      previous = b.minute;
      for (const p of priorities) {
        const c = b.counts[p];
        if (!keys(c, ['charge', 'wire']) || !integer(c.charge) || !integer(c.wire)
          || c.charge > c.wire || c.wire > 10000) fail();
      }
    }
    const { total } = this.counts(s);
    if (total.charge > 4000 || total.wire > 10000 || total.wire > s.sequence) fail();
    const ids = new Set(), sequences = new Set(), pendingCounts = new Map();
    for (const r of s.pending) {
      if (!keys(r, ['id', 'minute', 'priority', 'sequence']) || typeof r.id !== 'string'
        || !/^[0-9a-f-]{36}$/.test(r.id) || ids.has(r.id) || !priorities.includes(r.priority)
        || !integer(r.sequence) || r.sequence === 0 || r.sequence > s.sequence || sequences.has(r.sequence)
        || !s.buckets.some((b) => b.minute === r.minute)) fail();
      ids.add(r.id); sequences.add(r.sequence);
      const key = `${r.minute}:${r.priority}`;
      pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1);
    }
    for (const b of s.buckets) for (const p of priorities) {
      if ((pendingCounts.get(`${b.minute}:${p}`) ?? 0) > b.counts[p].charge) fail();
    }
    if (s.core !== null && (!keys(s.core, ['remaining', 'reset', 'sequence'])
      || !integer(s.core.remaining) || !integer(s.core.reset) || !integer(s.core.sequence)
      || s.core.sequence > s.sequence)) fail();
    return s;
  }
  prune(s) {
    const now = Math.max(this.clock(), s.lastNow);
    s.lastNow = now;
    const first = Math.floor(now / MINUTE) - 60;
    s.buckets = s.buckets.filter((b) => b.minute >= first);
    s.pending = s.pending.filter((r) => r.minute >= first);
    return now;
  }
  save(s) {
    this.store.run('INSERT INTO github_budget(scope,record_json) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET record_json=excluded.record_json',
      this.scope, JSON.stringify(s));
  }
  counts(s) {
    const classes = emptyCounts(), total = { charge: 0, wire: 0 };
    for (const b of s.buckets) for (const p of priorities) for (const k of ['charge', 'wire']) {
      classes[p][k] += b.counts[p][k]; total[k] += b.counts[p][k];
    }
    return { classes, total };
  }
  reserve(priority = 'review') {
    validPriority(priority);
    try {
      return this.store.transaction(() => {
        const s = this.load(), now = this.prune(s), limit = this.limits[priority];
        const { total } = this.counts(s);
        const constraints = [];
        if (s.blockedUntil > now) constraints.push([s.blockedUntil, 'github_server_backoff']);
        if (s.core && s.core.reset > now && s.core.remaining <= limit.floor) {
          constraints.push([s.core.reset, 'github_core_reserve']);
        }
        for (const k of ['charge', 'wire']) if (total[k] >= limit[k]) {
          let remaining = total[k];
          let expiry = now + WINDOW;
          for (const b of s.buckets) {
            remaining -= priorities.reduce((sum, p) => sum + b.counts[p][k], 0);
            expiry = (b.minute + 61) * MINUTE;
            if (remaining < limit[k]) break;
          }
          constraints.push([expiry, 'github_hourly_budget']);
        }
        if (s.pending.length >= this.maxPending) {
          constraints.push([(Math.min(...s.pending.map((r) => r.minute)) + 61) * MINUTE, 'github_pending_budget']);
        }
        if (constraints.length) {
          const [retryAt, reason] = constraints.reduce((a, b) => b[0] > a[0] ? b : a);
          throw new GitHubBudgetDeferred(priority, Math.max(now + 1, retryAt), reason);
        }
        if (s.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Accounting sequence exhausted');
        const minute = Math.floor(now / MINUTE);
        let bucket = s.buckets.find((b) => b.minute === minute);
        if (!bucket) { bucket = { minute, counts: emptyCounts() }; s.buckets.push(bucket); }
        bucket.counts[priority].charge++; bucket.counts[priority].wire++;
        const reservation = { id: randomUUID(), minute, priority, sequence: ++s.sequence };
        s.pending.push(reservation);
        if (s.core && s.core.reset > now) s.core.remaining = Math.max(0, s.core.remaining - 1);
        this.save(s);
        return Object.freeze({ scope: this.scope, id: reservation.id });
      });
    } catch (error) {
      if (error?.code === 'github_budget_deferred') throw error;
      let retryAt = Date.now() + WINDOW;
      try { retryAt = this.clock() + WINDOW; } catch {}
      throw new GitHubBudgetDeferred(priority, retryAt, 'github_budget_accounting_unavailable');
    }
  }
  settle(receipt, { status, headers } = {}) {
    if (!keys(receipt, ['scope', 'id']) || receipt.scope !== this.scope || typeof receipt.id !== 'string') {
      throw new TypeError('Invalid GitHub budget receipt');
    }
    this.store.transaction(() => {
      const s = this.load(), now = this.prune(s);
      const index = s.pending.findIndex((r) => r.id === receipt.id);
      if (index < 0) return;
      const r = s.pending[index];
      s.pending.splice(index, 1);
      const remaining = numericHeader(headers, 'x-ratelimit-remaining');
      const resetSeconds = numericHeader(headers, 'x-ratelimit-reset');
      const resource = typeof headers?.get === 'function' ? headers.get('x-ratelimit-resource') : headers?.['x-ratelimit-resource'];
      const coreHeaders = resource === 'core' && remaining !== null
        && resetSeconds !== null && resetSeconds <= Math.floor(Number.MAX_SAFE_INTEGER / 1000);
      // Transport calls settlement only for this authenticated wire attempt.
      if (status === 304) s.buckets.find((b) => b.minute === r.minute).counts[r.priority].charge--;
      if (coreHeaders) {
        const reset = resetSeconds * 1000;
        const available = Math.max(0, remaining - s.pending.length);
        if (!s.core || (reset > s.core.reset && r.sequence >= s.core.sequence)) {
          s.core = { reset, remaining: available, sequence: r.sequence };
        } else if (reset === s.core.reset) {
          s.core.remaining = Math.min(s.core.remaining, available);
          s.core.sequence = Math.max(s.core.sequence, r.sequence);
        }
        if (remaining === 0 && reset > now) s.blockedUntil = Math.max(s.blockedUntil, reset);
      }
      const retry = numericHeader(headers, 'retry-after');
      if (retry !== null && retry <= Math.floor((Number.MAX_SAFE_INTEGER - now) / 1000)) {
        s.blockedUntil = Math.max(s.blockedUntil, now + retry * 1000);
      } else {
        const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
        const date = typeof raw === 'string' ? Date.parse(raw) : NaN;
        if (integer(date)) s.blockedUntil = Math.max(s.blockedUntil, date);
      }
      this.save(s);
    });
  }
  snapshot() {
    const s = this.load();
    const now = this.prune(s), { classes, total } = this.counts(s);
    const counters = (c) => ({ primaryCharges: c.charge, wireAttempts: c.wire });
    return {
      state: 'ok', total: counters(total),
      byClass: Object.fromEntries(priorities.map((p) => [p, counters(classes[p])])),
      admissionCeilings: Object.fromEntries(priorities.map((p) => [p, counters(this.limits[p])])),
      pendingReservations: s.pending.length,
      serverCore: s.core && s.core.reset > now ? { remaining: s.core.remaining, reset: s.core.reset } : null,
    };
  }
}
