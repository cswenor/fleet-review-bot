import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const context = new AsyncLocalStorage();
const processId = randomUUID();
let sequence = 0;
const phases = new Set(['reconcile', 'rerequests', 'disarm', 'deliveries', 'openPRs', 'inspect', 'review', 'status', 'lane', 'auth', 'unknown', 'overflow']);
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);
const outcomes = new Set(['success', 'http_error', 'timeout', 'transport_error', 'body_error', 'guard_refused']);
const maxGroups = 256;
const noop = () => {};

function counters() {
  return { logicalCalls: 0, attempts: 0, retries: 0, latencyMs: 0, statusCounts: {}, outcomeCounts: {}, inflight: 0, maxInflight: 0 };
}
function clock(root) {
  try {
    const value = root.now();
    if (Number.isFinite(value)) root.time = Math.max(root.time, value);
  } catch { /* Metrics must not change the operation's outcome. */ }
  return root.time;
}
function emit(root, row) {
  try {
    const result = root.log(row);
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(noop);
  } catch { /* Logging is observational. */ }
}
function snapshot(stats) {
  return { ...stats, statusCounts: { ...stats.statusCounts }, outcomeCounts: { ...stats.outcomeCounts } };
}
function flush(root) {
  if (!root.closed || root.stats.inflight !== 0 || root.flushed) return;
  root.flushed = true;
  const end = clock(root);
  for (const group of root.groups.values()) {
    emit(root, { event: 'reconcile_request_phase', cycleId: root.id, ...group.dimensions, ...snapshot(group.stats), complete: true });
  }
  emit(root, { event: 'reconcile_request_summary', cycleId: root.id, ...snapshot(root.stats), success: root.success,
    durationMs: end - root.start, rootDurationMs: root.end - root.start, tailDurationMs: end - root.end, complete: true });
}
function groupFor(store, appId, method) {
  const root = store.root;
  const dimensions = { phase: store.phase, pr: store.pr,
    appId: Number.isSafeInteger(appId) && appId > 0 ? appId : null, method: methods.has(method) ? method : 'OTHER' };
  let key = JSON.stringify(dimensions);
  if (!root.groups.has(key)) {
    if (root.groups.size >= maxGroups) {
      key = 'overflow';
      Object.assign(dimensions, { phase: 'overflow', pr: null, appId: null, method: 'OTHER' });
    }
    if (!root.groups.has(key)) root.groups.set(key, { dimensions, stats: counters() });
  }
  return root.groups.get(key).stats;
}

// Only this private metrics context is escaped; unrelated AsyncLocalStorage is untouched.
export function withoutRequestMetrics(operation) {
  return context.run(undefined, operation);
}
export function withRequestPhase(phase, pr, operation) {
  const store = context.getStore();
  if (!store) return operation();
  return context.run({ root: store.root, phase: phases.has(phase) ? phase : 'unknown',
    pr: Number.isSafeInteger(pr) && pr > 0 ? pr : null }, operation);
}
export function withReconcileMetrics(log, operation, { now = () => performance.now() } = {}) {
  const root = { id: `${processId}:${++sequence}`, log, now, time: 0, stats: counters(), groups: new Map(),
    closed: false, flushed: false, success: false };
  root.start = clock(root);
  const close = (success) => {
    root.success = success;
    root.end = clock(root);
    root.closed = true;
    flush(root);
  };
  return context.run({ root, phase: 'reconcile', pr: null }, () => {
    try {
      const result = operation();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then((value) => { close(true); return value; }, (error) => { close(false); throw error; });
      }
      close(true);
      return result;
    } catch (error) { close(false); throw error; }
  });
}
export function recordLogicalRequest({ appId, method }) {
  try {
    const store = context.getStore();
    if (!store || store.root.flushed) return;
    const group = groupFor(store, appId, method);
    store.root.stats.logicalCalls++;
    group.logicalCalls++;
  } catch { /* Instrumentation never throws. */ }
}
export function beginRequestAttempt({ appId, method, retry }) {
  try {
    const store = context.getStore();
    if (!store || store.root.flushed) return noop;
    const root = store.root;
    const group = groupFor(store, appId, method);
    const start = clock(root);
    for (const stats of [root.stats, group]) {
      stats.attempts++;
      if (retry) stats.retries++;
      stats.inflight++;
      stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
    }
    let finished = false;
    return ({ status, latencyMs, outcome } = {}) => {
      if (finished) return;
      finished = true;
      try {
        const elapsed = Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : clock(root) - start;
        const code = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : 'none';
        const category = outcomes.has(outcome) ? outcome : 'transport_error';
        for (const stats of [root.stats, group]) {
          stats.latencyMs += elapsed;
          stats.statusCounts[code] = (stats.statusCounts[code] ?? 0) + 1;
          stats.outcomeCounts[category] = (stats.outcomeCounts[category] ?? 0) + 1;
          stats.inflight--;
        }
        flush(root);
      } catch { /* Instrumentation never throws. */ }
    };
  } catch { return noop; }
}
