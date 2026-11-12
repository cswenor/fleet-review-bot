// Read-only work only. Authority consumers remain outside these four workers.
export async function* prepareInOrder(items, prepare, allowed = () => true) {
  let next = 0, stopped = false;
  const slots = items.map(() => Promise.withResolvers());
  const worker = async () => {
    while (!stopped && next < items.length && allowed()) {
      const index = next++;
      try { slots[index].resolve({ value: await prepare(items[index], index) }); }
      catch (error) { slots[index].resolve({ error }); }
    }
  };
  const workers = Promise.all(Array.from({ length: Math.min(4, items.length) }, worker)).then(() => {
    while (next < items.length) slots[next++].resolve({ value: { skipped: true } });
  });
  try {
    for (let index = 0; index < items.length; index++) {
      yield { item: items[index], ...await slots[index].promise };
    }
  } finally {
    stopped = true;
    await workers;
  }
}

// Ephemeral discovery hints, never persisted and never usable as admission proof.
// Tokens fence only global/main changes and their bound PR/head; scoped epoch
// storage is independently bounded, with eviction conservatively revoking tokens.
export class CandidateHints {
  #entries = new Map();
  #globalEpoch = Symbol();
  #prEpochs = new Map();
  #headEpochs = new Map();
  constructor(now) { this.now = now; }
  #epoch(scopes, key) {
    if (!scopes.has(key)) {
      scopes.set(key, Symbol());
      // Missing epochs fail closed; new identities cannot revive evicted tokens.
      if (scopes.size > 256) scopes.delete(scopes.keys().next().value);
    }
    return scopes.get(key);
  }
  capture(pr, headSha) {
    return Object.freeze({
      pr, headSha, globalEpoch: this.#globalEpoch,
      prEpoch: this.#epoch(this.#prEpochs, pr),
      headEpoch: this.#epoch(this.#headEpochs, headSha),
    });
  }
  valid(pr, headSha, token) {
    return Boolean(token && token.pr === pr && token.headSha === headSha
      && token.globalEpoch === this.#globalEpoch
      && token.prEpoch !== undefined && this.#prEpochs.get(pr) === token.prEpoch
      && token.headEpoch !== undefined && this.#headEpochs.get(headSha) === token.headEpoch);
  }
  get(pr, key) {
    const entry = this.#entries.get(pr);
    if (!entry || entry.key !== key || this.now() - entry.at >= 300000
      || !this.valid(pr, entry.headSha, entry.token)) {
      this.#entries.delete(pr);
      return null;
    }
    return entry;
  }
  matchesLocal(pr, headSha, localIdentity) {
    const entry = this.#entries.get(pr);
    return Boolean(entry && entry.headSha === headSha && this.now() - entry.at < 300000
      && this.valid(pr, headSha, entry.token) && entry.value.localIdentity === localIdentity);
  }
  put(pr, headSha, key, value, token) {
    if (!this.valid(pr, headSha, token)) return;
    this.#entries.delete(pr);
    this.#entries.set(pr, { headSha, key, token, value: structuredClone(value), at: this.now() });
    while (this.#entries.size > 256) this.#entries.delete(this.#entries.keys().next().value);
  }
  invalidate({ pr, headSha, all } = {}) {
    if (all || (pr === undefined && headSha === undefined)) {
      this.#globalEpoch = Symbol();
      this.#prEpochs.clear();
      this.#headEpochs.clear();
      this.#entries.clear();
      return;
    }
    if (pr !== undefined) this.#prEpochs.delete(pr);
    if (headSha !== undefined) this.#headEpochs.delete(headSha);
    for (const [number, entry] of this.#entries) {
      if ((pr !== undefined && number === pr)
        || (headSha !== undefined && entry.headSha === headSha)) this.#entries.delete(number);
    }
  }
}
