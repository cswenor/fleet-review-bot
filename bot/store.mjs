import { DatabaseSync } from 'node:sqlite';
import { routeEvent } from './webhook.mjs';
import { REVIEW_APP_ID } from './identity.mjs';

const APPROVAL_SCHEMA = `CREATE TABLE IF NOT EXISTS approvals(publication_id INTEGER PRIMARY KEY,
  pr INTEGER NOT NULL,head_sha TEXT NOT NULL,review_id INTEGER NOT NULL,pull_request_id TEXT NOT NULL,
  armed INTEGER NOT NULL DEFAULT 0,github_review_id INTEGER,outcome TEXT NOT NULL,auto_merge_owner TEXT,arm_error TEXT,updated_at INTEGER NOT NULL);`;

const BATCH_SCHEMA = `CREATE TABLE IF NOT EXISTS merge_batches(
  id TEXT NOT NULL,generation INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(id,generation));
  CREATE TABLE IF NOT EXISTS active_merge_batch(
    slot INTEGER PRIMARY KEY CHECK(slot=1),id TEXT NOT NULL,generation INTEGER NOT NULL,
    FOREIGN KEY(id,generation) REFERENCES merge_batches(id,generation));
  CREATE INDEX IF NOT EXISTS rejected_batch_approval ON merge_batches(
    json_extract(record_json,'$.rejected_approval.pr'),
    json_extract(record_json,'$.rejected_approval.head_sha'),
    json_extract(record_json,'$.rejected_approval.review_id'),
    json_extract(record_json,'$.rejected_approval.publication_id'),
    json_extract(record_json,'$.rejected_approval.github_review_id'),
    json_extract(record_json,'$.rejected_approval.pull_request_id'))
    WHERE CASE WHEN json_valid(record_json) THEN
      json_extract(record_json,'$.state')='invalidated'
      AND json_type(record_json,'$.rejected_approval')='object' ELSE 0 END;`;
const SEALED_BATCH_FIELDS = ['base_sha', 'head_sha', 'tree_sha', 'carrier_branch', 'members', 'manifest_digest', 'kind'];
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const sha = (value) => value === null || (typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function jsonCopy(value) {
  const visit = (item) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) {
      throw new Error('Invalid batch JSON');
    }
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return JSON.parse(JSON.stringify(value));
}

function validateBatch(record) {
  if (typeof record.id !== 'string' || !record.id || !positiveInteger(record.generation)
    || !['single', 'batch'].includes(record.kind) || typeof record.state !== 'string' || !record.state
    || !Number.isSafeInteger(record.selected_at) || !Number.isSafeInteger(record.updated_at)
    || !(record.retired_at == null || Number.isSafeInteger(record.retired_at))
    || !Array.isArray(record.members) || record.members.length < 1 || record.members.length > 5
    || (record.kind === 'single' ? record.members.length !== 1 : record.members.length < 2)
    || new Set(record.members.map((member) => member.pr)).size !== record.members.length) {
    throw new Error('Invalid merge batch identity');
  }
  for (const member of record.members) {
    if (!positiveInteger(member.pr) || !sha(member.head_sha)
      || !['review_id', 'publication_id', 'github_review_id', 'ci_run_id', 'ci_attempt'].every(
        (key) => member[key] === null || positiveInteger(member[key]))
      || !(member.pull_request_id === null || typeof member.pull_request_id === 'string')
      || !(member.priority === null || (Number.isSafeInteger(member.priority) && member.priority >= 0))
      || !(member.created_at === null || (typeof member.created_at === 'string' && Number.isFinite(Date.parse(member.created_at))))) {
      throw new Error('Invalid merge batch member');
    }
  }
  if (!['base_sha', 'head_sha', 'tree_sha', 'merged_sha'].every((key) => sha(record[key]))
    || !(record.target_pr === null || positiveInteger(record.target_pr))
    || (record.kind === 'single' && record.target_pr !== record.members[0].pr)
    || !(record.target_node_id === null || typeof record.target_node_id === 'string')
    || !(record.carrier_branch === null || typeof record.carrier_branch === 'string')
    || !(record.manifest_digest === null || /^[0-9a-f]{64}$/i.test(record.manifest_digest))
    || typeof record.sealed !== 'boolean' || typeof record.needs_inspection !== 'boolean'
    || !(record.reason === null || typeof record.reason === 'string')
    || !Array.isArray(record.operations) || !Array.isArray(record.fallback_done)
    || !record.fallback_done.every((pr) => record.members.some((member) => member.pr === pr))
    || !record.member_results || Array.isArray(record.member_results) || typeof record.member_results !== 'object'
    || !(record.fallback_of === null || (typeof record.fallback_of.id === 'string' && positiveInteger(record.fallback_of.generation)))) {
    throw new Error('Invalid merge batch record');
  }
  if (record.ci !== null && (!record.ci || !positiveInteger(record.ci.run_id)
    || !positiveInteger(record.ci.attempt) || !positiveInteger(record.ci.artifact_id)
    || !sha(record.ci.tree_sha) || record.ci.tree_sha === null
    || !(record.ci.image_digest === null || typeof record.ci.image_digest === 'string'))) {
    throw new Error('Invalid merge batch CI receipt');
  }
  if (record.sealed && !record.needs_inspection
    && (!record.base_sha || !record.head_sha || !record.tree_sha || !record.manifest_digest
      || record.members.some((member) => !member.head_sha))) throw new Error('Incomplete sealed batch');
  return record;
}

function newBatch(record) {
  return validateBatch(jsonCopy({
    base_sha: null, head_sha: null, tree_sha: null, target_pr: null, target_node_id: null,
    carrier_branch: null, manifest_digest: null, sealed: false, ci: null, mutation: null,
    operations: [], member_results: {}, fallback_done: [], fallback_of: null,
    needs_inspection: false, reason: null, merged_sha: null, retired_at: null, ...record,
  }));
}

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.transactionDepth = 0;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,event TEXT,received_at INTEGER);
      CREATE TABLE IF NOT EXISTS rerequests(id INTEGER PRIMARY KEY AUTOINCREMENT,delivery_id TEXT UNIQUE NOT NULL,
        head_sha TEXT NOT NULL,received_at INTEGER NOT NULL,pr INTEGER,satisfied_by_review_id INTEGER,moot_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS rerequest_head ON rerequests(head_sha,id);
      CREATE TABLE IF NOT EXISTS github_budget(scope TEXT PRIMARY KEY,record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,pr INTEGER,head_sha TEXT,base_sha TEXT,
        status TEXT CHECK(status IN ('queued','running','publishing','completed','cancelled','failed')),reason TEXT,attempt INTEGER,
        allow_draft INTEGER,due_at INTEGER,check_run_id INTEGER,run_id TEXT,conclusion TEXT,result_json TEXT,verdict_json TEXT,
        created_at INTEGER,started_at INTEGER,finished_at INTEGER,execution_exit_json TEXT);
      CREATE TABLE IF NOT EXISTS check_output_receipts(app_id INTEGER NOT NULL,repo TEXT NOT NULL,check_run_id INTEGER NOT NULL,
        publication_id TEXT NOT NULL,head_sha TEXT NOT NULL,output_sha256 TEXT NOT NULL,PRIMARY KEY(app_id,repo,check_run_id));
      CREATE TABLE IF NOT EXISTS approval_gate_heads(app_id INTEGER NOT NULL,repo TEXT NOT NULL,
        head_sha TEXT NOT NULL,check_run_id INTEGER,conclusion TEXT,PRIMARY KEY(app_id,repo,head_sha));
      CREATE TABLE IF NOT EXISTS findings(pr INTEGER,finding_id TEXT,first_review_id INTEGER,last_review_id INTEGER,
        severity TEXT,file TEXT,line INTEGER,title TEXT,scenario TEXT,status TEXT,comment_id INTEGER,PRIMARY KEY(pr,finding_id));
      CREATE TABLE IF NOT EXISTS shepherd(pr INTEGER PRIMARY KEY,comment_id INTEGER,status_sha256 TEXT,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS update_attempts(pr INTEGER NOT NULL,head_sha TEXT NOT NULL,main_sha TEXT NOT NULL,
        outcome TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(pr,head_sha,main_sha));
      CREATE TABLE IF NOT EXISTS upgrade_rereviews(id INTEGER PRIMARY KEY,pr INTEGER,head_sha TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS comment_rereview_counts(pr INTEGER NOT NULL,head_sha TEXT NOT NULL,used INTEGER NOT NULL,PRIMARY KEY(pr,head_sha));
      CREATE TABLE IF NOT EXISTS native_ci_failures(pr INTEGER NOT NULL,head_sha TEXT NOT NULL,
        run_id INTEGER NOT NULL,run_attempt INTEGER NOT NULL,job_id INTEGER NOT NULL,
        reason TEXT NOT NULL,recorded_at INTEGER NOT NULL,PRIMARY KEY(pr,head_sha));
      ${APPROVAL_SCHEMA}`);
    try { this.migrateReviews(); this.migrateMergeBatch(); }
    catch (error) { this.db.close(); throw error; }
    if (!this.all('PRAGMA table_info(approval_gate_heads)').some((column) => column.name === 'dependencies_json')) {
      this.db.exec('ALTER TABLE approval_gate_heads ADD COLUMN dependencies_json TEXT');
    }
    if (!this.all('PRAGMA table_info(approvals)').some((column) => column.name === 'publication_id')) {
      // Phase 2 never wrote approval receipts. Preserve unexpected legacy data rather than reinterpret it.
      if (this.get('SELECT COUNT(*) AS count FROM approvals').count !== 0) throw new Error('Legacy approval receipts require migration');
      this.db.exec(`DROP TABLE approvals; ${APPROVAL_SCHEMA}`);
    }
    if (!this.all('PRAGMA table_info(approvals)').some((column) => column.name === 'auto_merge_owner')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN auto_merge_owner TEXT');
    }
    if (!this.all('PRAGMA table_info(approvals)').some((column) => column.name === 'arm_error')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN arm_error TEXT');
    }
    if (this.all('PRAGMA table_info(approvals)').some((column) => column.name === 'disarm_reason')) {
      // Old admission-degraded receipts keep their armed state, without restoration authority.
      this.db.exec('ALTER TABLE approvals DROP COLUMN disarm_reason');
    }
    // The former human veto happened before mutation: discard first-approval placeholders.
    // Confirmed legacy receipts remain plain disarmed approvals; there is no restoration.
    this.db.exec(`DELETE FROM approvals WHERE outcome='human_changes_requested' AND armed=0 AND github_review_id IS NULL;
      UPDATE approvals SET outcome='approved'
      WHERE outcome IN ('human_changes_requested','approval_review_blocked') AND github_review_id IS NOT NULL;`);
    const columns = new Set(this.all('PRAGMA table_info(deliveries)').map((column) => column.name));
    for (const [name, definition] of Object.entries({
      state: "TEXT NOT NULL DEFAULT 'received'", payload_json: 'TEXT', attempts: 'INTEGER NOT NULL DEFAULT 0',
      updated_at: 'INTEGER NOT NULL DEFAULT 0',
    })) if (!columns.has(name)) this.db.exec(`ALTER TABLE deliveries ADD COLUMN ${name} ${definition}`);
    if (columns.has('review_floor_id')) this.db.exec('ALTER TABLE deliveries DROP COLUMN review_floor_id');
    if (!this.all('PRAGMA table_info(rerequests)').some((column) => column.name === 'parked')) {
      this.db.exec('ALTER TABLE rerequests ADD COLUMN parked INTEGER NOT NULL DEFAULT 0');
    }
    const findingColumns = new Set(this.all('PRAGMA table_info(findings)').map((column) => column.name));
    for (const [name, type] of Object.entries({ category: 'TEXT', stock_replacement: 'TEXT', introduced_by_pr: 'INTEGER', deferred_to: 'TEXT' })) {
      if (!findingColumns.has(name)) this.db.exec(`ALTER TABLE findings ADD COLUMN ${name} ${type}`);
    }
    if (!this.all('PRAGMA table_info(reviews)').some((column) => column.name === 'rerequest_watermark')) {
      this.db.exec('ALTER TABLE reviews ADD COLUMN rerequest_watermark INTEGER NOT NULL DEFAULT 0');
    }
    if (!this.all('PRAGMA table_info(reviews)').some((column) => column.name === 'publication_id')) {
      this.db.exec('ALTER TABLE reviews ADD COLUMN publication_id INTEGER');
    }
    // Pre-binding receipts cannot establish which target was reviewed; require fresh evidence.
    if (!this.all('PRAGMA table_info(reviews)').some((column) => column.name === 'base_ref')) {
      this.db.exec('ALTER TABLE reviews ADD COLUMN base_ref TEXT');
    }
    if (!this.all('PRAGMA table_info(reviews)').some((column) => column.name === 'bot_revision')) {
      this.db.exec('ALTER TABLE reviews ADD COLUMN bot_revision TEXT');
    }
    this.run('UPDATE reviews SET publication_id=id WHERE publication_id IS NULL');
    if (!this.all('PRAGMA table_info(reviews)').some((column) => column.name === 'ambiguous_rereviews')) {
      this.db.exec('ALTER TABLE reviews ADD COLUMN ambiguous_rereviews INTEGER NOT NULL DEFAULT 0');
      this.run("UPDATE reviews SET ambiguous_rereviews=1 WHERE reason='ambiguous_rereview'");
    }
    // Legacy delivery receipts conservatively require a new review under the monotonic rule.
    for (const delivery of this.all("SELECT * FROM deliveries WHERE event='check_run' AND payload_json IS NOT NULL")) {
      const operation = routeEvent(delivery.event, JSON.parse(delivery.payload_json)).find((op) => op.reason === 'rerequested');
      if (operation) this.recordRerequest(delivery.id, operation.head_sha, delivery.received_at);
    }
  }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  nativeCiFailure(pr, headSha) {
    if (!positiveInteger(pr) || typeof headSha !== 'string' || headSha.length !== 40 || !sha(headSha)) {
      throw new Error('Invalid native CI failure identity');
    }
    return this.get('SELECT * FROM native_ci_failures WHERE pr=? AND head_sha=?', pr, headSha.toLowerCase()) ?? null;
  }
  recordNativeCiFailure({ pr, head_sha, run_id, run_attempt, job_id, reason }, now) {
    if (![pr, run_id, run_attempt, job_id].every(positiveInteger)
      || typeof head_sha !== 'string' || head_sha.length !== 40 || !sha(head_sha)
      || typeof reason !== 'string' || reason.length > 64 || !/^[a-z]/u.test(reason)
      || /[^a-z0-9_]/u.test(reason)
      || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid native CI failure receipt');
    // First failure is permanent for this exact source head; later attempts cannot replace it.
    return this.transaction(() => {
      this.run(`INSERT INTO native_ci_failures(pr,head_sha,run_id,run_attempt,job_id,reason,recorded_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(pr,head_sha) DO NOTHING`,
      pr, head_sha.toLowerCase(), run_id, run_attempt, job_id, reason, now);
      return this.nativeCiFailure(pr, head_sha);
    });
  }
  receiveDelivery(id, event, payload, now, appId = REVIEW_APP_ID) {
    return this.transaction(() => {
      this.run("INSERT OR IGNORE INTO deliveries(id,event,received_at,state,payload_json,attempts,updated_at) VALUES(?,?,?,'received',?,0,?)",
        id, event, now, JSON.stringify(payload), now);
      const delivery = this.get('SELECT * FROM deliveries WHERE id=?', id);
      const operation = routeEvent(delivery.event, JSON.parse(delivery.payload_json), { appId })
        .find((op) => op.reason === 'rerequested');
      if (operation) this.recordRerequest(id, operation.head_sha, delivery.received_at);
      return delivery;
    });
  }
  recordRerequest(deliveryId, head, now) {
    if (!/^[0-9a-f]{40}$/u.test(head ?? '')) throw new Error('Invalid rerequest head');
    this.run('INSERT OR IGNORE INTO rerequests(delivery_id,head_sha,received_at) VALUES(?,?,?)', deliveryId, head, now);
    return this.get('SELECT * FROM rerequests WHERE delivery_id=?', deliveryId);
  }
  satisfyRerequests(row) {
    if (row.status !== 'completed' || !row.result_json) return;
    if (row.base_ref !== 'main') return;
    const review = JSON.parse(row.result_json);
    // A human decision gate keeps the fence but terminates automatic recovery.
    if (row.conclusion === 'neutral' && review.waitingForHuman === true) {
      this.run(`UPDATE rerequests SET parked=1 WHERE pr=? AND head_sha=? AND id<=?
        AND satisfied_by_review_id IS NULL AND moot_at IS NULL`, row.pr, row.head_sha, row.rerequest_watermark);
      return;
    }
    if (!['success', 'failure'].includes(row.conclusion) || review.result?.pass !== true) return;
    this.run(`UPDATE rerequests SET satisfied_by_review_id=? WHERE pr=? AND head_sha=? AND id<=?
      AND satisfied_by_review_id IS NULL AND moot_at IS NULL`, row.id, row.pr, row.head_sha, row.rerequest_watermark);
  }
  bindRerequest(id, pr) {
    this.run('UPDATE rerequests SET pr=? WHERE id=? AND pr IS NULL', pr, id);
    const request = this.get('SELECT * FROM rerequests WHERE id=?', id);
    for (const row of this.all("SELECT * FROM reviews WHERE pr=? AND head_sha=? AND status='completed' ORDER BY id",
      request.pr, request.head_sha)) this.satisfyRerequests(row);
    return this.get('SELECT * FROM rerequests WHERE id=?', id);
  }
  processedDelivery(id, now) { this.run("UPDATE deliveries SET state='processed',updated_at=? WHERE id=?", now, id); }
  transaction(callback) {
    if (this.transactionDepth) return callback();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth--; }
  }
  executionExited(row, exit) {
    if (!exit || Object.getPrototypeOf(exit) !== Object.prototype || exit.state !== 'exited') {
      throw new Error('Invalid execution exit receipt');
    }
    const receipt = JSON.stringify(jsonCopy(exit));
    return this.transaction(() => {
      const current = this.review(row.id);
      if (!current || current.pr !== row.pr || current.head_sha !== row.head_sha || current.run_id !== row.run_id
        || !['running', 'publishing'].includes(current.status)) throw new Error('Invalid execution exit transition');
      if (current.execution_exit_json !== null) {
        if (current.status !== 'publishing' || current.execution_exit_json !== receipt) {
          throw new Error('Incompatible execution exit receipt');
        }
        return current;
      }
      if (current.status !== 'running') throw new Error('Invalid execution exit transition');
      this.run("UPDATE reviews SET status='publishing',execution_exit_json=? WHERE id=?", receipt, current.id);
      return this.review(current.id);
    });
  }
  publicationIntent(row, review) {
    return this.transaction(() => {
      const current = this.review(row.id);
      if (!current || !['running', 'publishing'].includes(current.status)
        || current.pr !== row.pr || current.head_sha !== row.head_sha || current.run_id !== row.run_id) {
        throw new Error('Publication cancelled');
      }
      if (current.result_json) {
        // A retry must use the already assigned findings and publication identity.
        this.update(current.id, { status: 'publishing' });
        for (const key of Object.keys(review)) delete review[key];
        Object.assign(review, JSON.parse(current.result_json));
        return;
      }
      const intent = JSON.parse(JSON.stringify(review));
      if (intent.result.pass && !intent.findingsAssigned) {
        intent.findings = this.saveFindings(current, intent.findings);
        intent.findingsAssigned = true;
      }
      intent.publication_id = current.publication_id ?? current.id;
      intent.publication_state ??= 'pending';
      this.update(current.id, { status: 'publishing', result_json: JSON.stringify(intent) });
      Object.assign(review, intent);
    });
  }
  active(pr) { return this.get("SELECT * FROM reviews WHERE pr=? AND status IN ('queued','running','publishing')", pr); }
  review(id) { return this.get('SELECT * FROM reviews WHERE id=?', id); }
  latest(pr, head = null) {
    return head ? this.get("SELECT * FROM reviews WHERE pr=? AND head_sha=? AND status='completed' ORDER BY id DESC LIMIT 1", pr, head)
      : this.get("SELECT * FROM reviews WHERE pr=? AND status='completed' ORDER BY id DESC LIMIT 1", pr);
  }
  exhaustedFailure(pr, head) {
    return this.get(`SELECT id, reason FROM reviews WHERE pr=? AND head_sha=? AND status='failed'
      AND attempt>=2 ORDER BY id DESC LIMIT 1`, pr, head);
  }
  shepherdState(pr) { return this.get('SELECT * FROM shepherd WHERE pr=?', pr); }
  saveShepherd(pr, values, now) {
    const allowed = new Set(['comment_id', 'status_sha256']);
    const keys = Object.keys(values);
    if (!keys.length || keys.some((key) => !allowed.has(key))) throw new Error('Invalid shepherd update');
    this.run(`INSERT INTO shepherd(pr,${keys.join(',')},updated_at) VALUES(?,${keys.map(() => '?').join(',')},?)
      ON CONFLICT(pr) DO UPDATE SET ${keys.map((key) => `${key}=excluded.${key}`).join(',')},updated_at=excluded.updated_at`,
    pr, ...keys.map((key) => values[key]), now);
    return this.shepherdState(pr);
  }
  migrateReviews() {
    const schema = this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='reviews'").sql;
    const statusCheck = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/iu;
    const check = schema.match(statusCheck);
    if (!check) throw new Error('Unsupported reviews status constraint');
    const foreignKeys = this.get('PRAGMA foreign_keys').foreign_keys;
    // Rebuild from the stored schema, not a historical column list: retain additive
    // columns, constraints, explicit indexes and triggers from every prior version.
    this.db.exec('PRAGMA foreign_keys=OFF');
    try {
      this.transaction(() => {
        if (!check[1].includes("'publishing'")) {
          const dependents = this.all("SELECT name,sql FROM sqlite_master WHERE tbl_name='reviews' AND type IN ('index','trigger') AND sql IS NOT NULL");
          const columns = this.all('PRAGMA table_xinfo(reviews)').filter((column) => !column.hidden)
            .map((column) => `"${column.name.replaceAll('"', '""')}"`).join(',');
          const replacement = schema
            .replace(/^CREATE TABLE(?: IF NOT EXISTS)?\s+(?:"reviews"|`reviews`|\[reviews\]|reviews)/iu, 'CREATE TABLE reviews_migrating')
            .replace(statusCheck, `CHECK(status IN (${check[1]},'publishing'))`);
          this.db.exec(replacement);
          this.db.exec(`INSERT INTO reviews_migrating(${columns}) SELECT ${columns} FROM reviews;
            DROP TABLE reviews;
            ALTER TABLE reviews_migrating RENAME TO reviews;`);
          for (const dependent of dependents) this.db.exec(dependent.sql);
        }
        if (!this.all('PRAGMA table_info(reviews)').some((column) => column.name === 'execution_exit_json')) {
          this.db.exec('ALTER TABLE reviews ADD COLUMN execution_exit_json TEXT');
        }
        const activeIndex = this.get("SELECT sql FROM sqlite_master WHERE type='index' AND name='active_pr'");
        if (!activeIndex?.sql.includes("'publishing'")) {
          this.db.exec(`DROP INDEX IF EXISTS active_pr;
            CREATE UNIQUE INDEX active_pr ON reviews(pr) WHERE status IN ('queued','running','publishing');`);
        }
      });
    } finally {
      this.db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`);
    }
  }
  migrateMergeBatch() {
    this.transaction(() => {
      this.db.exec(BATCH_SCHEMA);
      if (!this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='merge_lane'")) return;
      const rows = this.all('SELECT * FROM merge_lane');
      if (rows.length > 1) throw new Error('Malformed legacy merge lane');
      for (const row of rows) {
        if (row.slot !== 1 || !positiveInteger(row.pr) || !Number.isSafeInteger(row.selected_at)
          || !(row.mutation_kind === null || (typeof row.mutation_kind === 'string' && row.mutation_kind))
          || !sha(row.mutation_head_sha) || !sha(row.mutation_main_sha)
          || (row.mutation_kind === null && (row.mutation_head_sha !== null || row.mutation_main_sha !== null))) {
          throw new Error('Malformed legacy merge lane');
        }
        if (this.get('SELECT id FROM active_merge_batch WHERE slot=1')
          || this.get('SELECT id FROM merge_batches LIMIT 1')) throw new Error('Conflicting legacy merge lane');
        const id = `legacy-merge-${row.pr}`;
        const record = newBatch({
          id, generation: 1, kind: 'single', state: row.mutation_kind ? 'reconciling' : 'selected',
          selected_at: row.selected_at, updated_at: row.selected_at, target_pr: row.pr,
          members: [{ pr: row.pr, head_sha: null, review_id: null, publication_id: null,
            github_review_id: null, pull_request_id: null, ci_run_id: null, ci_attempt: null,
            priority: null, created_at: null }],
          needs_inspection: true,
          reason: 'Legacy merge selection requires read-only inspection; authorization metadata is unknown',
          mutation: row.mutation_kind === null ? null : {
            id: `${id}-1`, kind: row.mutation_kind, head_sha: row.mutation_head_sha,
            main_sha: row.mutation_main_sha, marker: null,
          },
        });
        this.run('INSERT INTO merge_batches(id,generation,record_json) VALUES(?,?,?)', id, 1, JSON.stringify(record));
        this.run('INSERT INTO active_merge_batch(slot,id,generation) VALUES(1,?,?)', id, 1);
      }
      this.db.exec('DROP TABLE merge_lane');
    });
  }
  activeMergeBatch() {
    const row = this.get(`SELECT b.record_json FROM active_merge_batch a
      JOIN merge_batches b ON b.id=a.id AND b.generation=a.generation WHERE a.slot=1`);
    return row ? JSON.parse(row.record_json) : null;
  }
  mergeBatch(id, generation) {
    const row = this.get('SELECT record_json FROM merge_batches WHERE id=? AND generation=?', id, generation);
    return row ? JSON.parse(row.record_json) : null;
  }
  latestMergeBatchForPr(pr) {
    const row = this.get(`SELECT record_json FROM merge_batches
      WHERE json_extract(record_json,'$.target_pr')=? OR EXISTS(
        SELECT 1 FROM json_each(record_json,'$.members') WHERE json_extract(value,'$.pr')=?)
      ORDER BY rowid DESC LIMIT 1`, pr, pr);
    return row ? JSON.parse(row.record_json) : null;
  }
  rejectedBatchApproval(member) {
    return Boolean(this.get(`SELECT 1 FROM merge_batches
      WHERE CASE WHEN json_valid(record_json) THEN
        json_extract(record_json,'$.state')='invalidated'
        AND json_type(record_json,'$.rejected_approval')='object' ELSE 0 END
      AND json_extract(record_json,'$.rejected_approval.pr')=?
      AND json_extract(record_json,'$.rejected_approval.head_sha')=?
      AND json_extract(record_json,'$.rejected_approval.review_id')=?
      AND json_extract(record_json,'$.rejected_approval.publication_id')=?
      AND json_extract(record_json,'$.rejected_approval.github_review_id')=?
      AND json_extract(record_json,'$.rejected_approval.pull_request_id')=? LIMIT 1`,
    member.pr, member.head_sha, member.review_id, member.publication_id, member.github_review_id, member.pull_request_id));
  }
  sealedCarrier(pr) {
    return Boolean(this.get(`SELECT 1 FROM merge_batches WHERE json_extract(record_json,'$.target_pr')=?
      AND json_extract(record_json,'$.kind')='batch' AND json_extract(record_json,'$.sealed')=1 LIMIT 1`, pr));
  }
  lastRetiredBatchAt() {
    return this.get(`SELECT MAX(json_extract(record_json,'$.retired_at')) AS at FROM merge_batches`).at ?? 0;
  }
  selectMergeBatch(record) {
    return this.transaction(() => {
      const batch = newBatch(record);
      if (batch.mutation !== null || batch.operations.length) throw new Error('New batch cannot contain mutation history');
      if (batch.retired_at !== null) throw new Error('New batch cannot contain retirement history');
      if (this.activeMergeBatch()) throw new Error('merge_batch_already_active');
      const previous = this.get('SELECT MAX(generation) AS generation FROM merge_batches WHERE id=?', batch.id).generation;
      if (previous !== null && batch.generation !== previous + 1) throw new Error('Invalid batch generation');
      this.run('INSERT INTO merge_batches(id,generation,record_json) VALUES(?,?,?)', batch.id, batch.generation, JSON.stringify(batch));
      this.run('INSERT INTO active_merge_batch(slot,id,generation) VALUES(1,?,?)', batch.id, batch.generation);
      return batch;
    });
  }
  updateMergeBatch(id, generation, patch) {
    return this.transaction(() => {
      const before = this.mergeBatch(id, generation);
      if (!before) throw new Error('Unknown merge batch');
      const values = jsonCopy(patch);
      if (['id', 'generation', 'selected_at', 'retired_at', 'mutation', 'operations'].some((key) => Object.hasOwn(values, key))) {
        throw new Error('Immutable batch journal field');
      }
      if (before.mutation && Object.keys(values).some((key) => !['updated_at', 'reason', 'needs_inspection'].includes(key))) {
        throw new Error('merge_mutation_pending');
      }
      const after = validateBatch({ ...before, ...values });
      if (before.sealed && (!after.sealed || SEALED_BATCH_FIELDS.some((key) => !same(before[key], after[key])))) {
        throw new Error('Sealed batch identity is immutable');
      }
      for (const key of ['target_pr', 'target_node_id']) {
        if (before[key] !== null && before[key] !== after[key]) throw new Error('Batch target is assign-once');
      }
      this.run('UPDATE merge_batches SET record_json=? WHERE id=? AND generation=?', JSON.stringify(after), id, generation);
      return after;
    });
  }
  retireMergeBatch(id, generation, state, now, reason = null) {
    return this.transaction(() => {
      const batch = this.mergeBatch(id, generation);
      if (!batch) throw new Error('Unknown merge batch');
      if (batch.mutation) throw new Error('merge_mutation_pending');
      const after = this.updateMergeBatch(id, generation, { state, updated_at: now, reason });
      const active = this.activeMergeBatch();
      if (active?.id === id && active.generation === generation && after.retired_at == null) {
        after.retired_at = now;
        this.run('UPDATE merge_batches SET record_json=? WHERE id=? AND generation=?', JSON.stringify(after), id, generation);
      }
      this.run('DELETE FROM active_merge_batch WHERE slot=1 AND id=? AND generation=?', id, generation);
      return after;
    });
  }
  beginBatchMutation(id, generation, intent, now) {
    return this.transaction(() => {
      const batch = this.mergeBatch(id, generation);
      if (!batch) throw new Error('Unknown merge batch');
      if (batch.mutation) throw new Error('merge_mutation_already_pending');
      const active = this.activeMergeBatch();
      if ((active?.id !== id || active?.generation !== generation) && batch.state !== 'publishing') {
        throw new Error('Merge batch is not active');
      }
      const mutation = jsonCopy(intent);
      if (!mutation || typeof mutation.id !== 'string' || !mutation.id || typeof mutation.kind !== 'string' || !mutation.kind
        || !sha(mutation.head_sha) || !sha(mutation.main_sha)
        || !(mutation.marker === null || typeof mutation.marker === 'string')
        || batch.operations.some((operation) => operation.intent.id === mutation.id)) throw new Error('Invalid batch mutation intent');
      for (const [key, expected] of Object.entries({
        head_sha: batch.head_sha, main_sha: batch.base_sha, base_sha: batch.base_sha,
        tree_sha: batch.tree_sha, manifest_digest: batch.manifest_digest,
        target_pr: batch.target_pr, target_node_id: batch.target_node_id, carrier_branch: batch.carrier_branch,
        members: batch.members, generation: batch.generation,
      })) {
        if (Object.hasOwn(mutation, key) && !same(mutation[key], expected)) throw new Error(`Mutation ${key} mismatch`);
      }
      if (!Number.isSafeInteger(now)) throw new Error('Invalid mutation time');
      batch.mutation = mutation;
      batch.updated_at = now;
      this.run('UPDATE merge_batches SET record_json=? WHERE id=? AND generation=?', JSON.stringify(batch), id, generation);
      return batch;
    });
  }
  finishBatchMutation(id, generation, intentId, receipt, now) {
    return this.transaction(() => {
      const batch = this.mergeBatch(id, generation);
      if (!batch?.mutation || batch.mutation.id !== intentId) throw new Error('Batch mutation intent mismatch');
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !Number.isSafeInteger(now)) {
        throw new Error('Invalid batch mutation receipt');
      }
      batch.operations.push({ intent: batch.mutation, receipt: jsonCopy(receipt), finished_at: now });
      batch.mutation = null;
      batch.updated_at = now;
      this.run('UPDATE merge_batches SET record_json=? WHERE id=? AND generation=?', JSON.stringify(batch), id, generation);
      return batch;
    });
  }
  pendingBatchPublications() {
    return this.all("SELECT record_json FROM merge_batches WHERE json_extract(record_json,'$.state')='publishing' ORDER BY rowid").map((row) => JSON.parse(row.record_json));
  }
  pendingBatchFallbacks() {
    return this.all("SELECT record_json FROM merge_batches WHERE json_extract(record_json,'$.state')='fallback' ORDER BY rowid").map((row) => JSON.parse(row.record_json))
      .filter((batch) => batch.state === 'fallback' && batch.members.some((member) => !batch.fallback_done.includes(member.pr)));
  }
  updateAttempt(pr, head, main) {
    return this.get('SELECT * FROM update_attempts WHERE pr=? AND head_sha=? AND main_sha=?', pr, head, main);
  }
  cancelPendingUpdate(pr, head, main) {
    this.run(`DELETE FROM update_attempts WHERE pr=? AND head_sha=? AND main_sha=? AND outcome='pending'`, pr, head, main);
  }
  failedUpdate(pr, head) {
    return this.get(`SELECT * FROM update_attempts WHERE pr=? AND head_sha=? AND outcome LIKE 'failed:%'
      ORDER BY updated_at DESC, main_sha DESC LIMIT 1`, pr, head);
  }
  saveUpdateAttempt(pr, head, main, outcome, now) {
    this.run(`INSERT INTO update_attempts(pr,head_sha,main_sha,outcome,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(pr,head_sha,main_sha) DO UPDATE SET outcome=excluded.outcome,updated_at=excluded.updated_at`,
    pr, head, main, outcome, now);
    return this.updateAttempt(pr, head, main);
  }
  approvalForReview(reviewId) {
    return this.get('SELECT * FROM approvals WHERE review_id=? ORDER BY publication_id DESC LIMIT 1', reviewId);
  }
  upgradeRereviewsSince(since) {
    return this.get('SELECT count(*) AS n FROM upgrade_rereviews WHERE created_at>?', since).n;
  }
  commentRereviews(pr, head) {
    return this.get('SELECT used FROM comment_rereview_counts WHERE pr=? AND head_sha=?', pr, head)?.used ?? 0;
  }
  findingByComment(pr, commentId) {
    return this.get('SELECT finding_id FROM findings WHERE pr=? AND comment_id=?', pr, commentId);
  }
  enqueue({ pr, head_sha, base_ref, due, reason, allowDraft = false, attempt = 1, ambiguousRereviews = 0 }, now) {
    if (base_ref !== 'main') throw new Error('Unsupported review target');
    return this.transaction(() => {
      const result = this.run(`INSERT INTO reviews(pr,head_sha,base_ref,status,reason,attempt,allow_draft,due_at,created_at,ambiguous_rereviews,rerequest_watermark)
        VALUES(?,?,?,'queued',?,?,?,?,?,?,(SELECT COALESCE(MAX(id),0) FROM rerequests))`,
      pr, head_sha, base_ref, reason, attempt, Number(allowDraft), due, now, ambiguousRereviews);
      const id = Number(result.lastInsertRowid);
      this.run('UPDATE reviews SET publication_id=? WHERE id=?', id, id);
      if (reason === 'upgrade_rereview') {
        this.run('INSERT INTO upgrade_rereviews(id,pr,head_sha,created_at) VALUES(?,?,?,?)', id, pr, head_sha, now);
      }
      // Counted in the enqueue transaction and never decremented, so cancelled or failed reviews still count.
      if (reason === 'comment_rereview') {
        this.run(`INSERT INTO comment_rereview_counts(pr,head_sha,used) VALUES(?,?,1)
          ON CONFLICT(pr,head_sha) DO UPDATE SET used=used+1`, pr, head_sha);
      }
      return this.review(id);
    });
  }
  update(id, values) {
    const allowed = new Set(['base_sha','status','reason','check_run_id','run_id','conclusion','result_json','verdict_json','started_at','finished_at','due_at','allow_draft','bot_revision']);
    const keys = Object.keys(values);
    if (!keys.length || keys.some((key) => !allowed.has(key))) throw new Error('Invalid review update');
    return this.transaction(() => {
      this.run(`UPDATE reviews SET ${keys.map((key) => `${key}=?`).join(',')} WHERE id=?`, ...keys.map((key) => values[key]), id);
      const row = this.review(id);
      this.satisfyRerequests(row);
      return row;
    });
  }
  approval(publicationId) { return this.get('SELECT * FROM approvals WHERE publication_id=?', publicationId); }
  armedApproval(pr) {
    return this.get('SELECT * FROM approvals WHERE pr=? AND armed=1 ORDER BY publication_id DESC LIMIT 1', pr);
  }
  clearArmed(pr, now) {
    this.run('UPDATE approvals SET armed=0,updated_at=? WHERE pr=? AND armed=1', now, pr);
  }
  reserveApproval(row, pullRequestId, now) {
    this.run(`INSERT OR IGNORE INTO approvals(publication_id,pr,head_sha,review_id,pull_request_id,outcome,updated_at)
      VALUES(?,?,?,?,?,'reserved',?)`, row.publication_id, row.pr, row.head_sha, row.id, pullRequestId, now);
    return this.approval(row.publication_id);
  }
  updateApproval(publicationId, values, now) {
    const keys = Object.keys(values);
    if (!keys.length || keys.some((key) => !['armed','github_review_id','outcome','auto_merge_owner','arm_error'].includes(key))) {
      throw new Error('Invalid approval update');
    }
    this.run(`UPDATE approvals SET ${keys.map((key) => `${key}=?`).join(',')},updated_at=? WHERE publication_id=?`,
      ...keys.map((key) => values[key]), now, publicationId);
    return this.approval(publicationId);
  }
  releaseUnpostedApproval(publicationId) {
    this.run(`DELETE FROM approvals WHERE publication_id=? AND outcome IN ('approval_review_blocked','failed:preflight')
      AND armed=0 AND github_review_id IS NULL`, publicationId);
  }
  findings(pr, unresolved = false) {
    // Deferred code stays unchanged: carry its prior identity forward rather than rediscovering it as new.
    return this.all(`SELECT * FROM findings WHERE pr=?${unresolved ? " AND status!='resolved'" : ''} ORDER BY first_review_id,finding_id`, pr)
      .map((row) => ({ ...row, id: row.finding_id,
        introduced_by_pr: row.introduced_by_pr === null ? null : Boolean(row.introduced_by_pr) }));
  }
  saveFindings(row, findings) {
    let next = this.all('SELECT finding_id FROM findings WHERE pr=?', row.pr)
      .reduce((highest, finding) => Math.max(highest, Number(finding.finding_id.slice(1))), 0) + 1;
    const known = new Set(this.findings(row.pr).map((finding) => finding.id));
    const seen = new Set();
    const assigned = findings.map((finding) => {
      const id = finding.status === 'new' ? `F${next++}` : finding.id;
      if (finding.status !== 'new' && !known.has(id)) throw new Error('Unknown prior finding');
      if (seen.has(id)) throw new Error('Duplicate finding');
      seen.add(id);
      return { ...finding, id };
    });
    this.transaction(() => {
      for (const finding of assigned) this.run(`INSERT INTO findings(pr,finding_id,first_review_id,last_review_id,severity,file,line,title,scenario,status,category,stock_replacement,introduced_by_pr,deferred_to)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pr,finding_id) DO UPDATE SET last_review_id=excluded.last_review_id,
        severity=excluded.severity,file=excluded.file,line=excluded.line,title=excluded.title,scenario=excluded.scenario,status=excluded.status,
        category=excluded.category,stock_replacement=excluded.stock_replacement,introduced_by_pr=excluded.introduced_by_pr,deferred_to=excluded.deferred_to`,
      row.pr, finding.id, row.id, row.id, finding.severity, finding.file, finding.line, finding.title, finding.scenario,
      finding.status, finding.category ?? null, finding.stock_replacement ?? null,
      typeof finding.introduced_by_pr === 'boolean' ? Number(finding.introduced_by_pr) : null,
      finding.status === 'deferred' ? finding.deferred_to : null);
    });
    return assigned;
  }
  counts({ includeMergeLane = true } = {}) {
    const batch = includeMergeLane ? this.activeMergeBatch() : null;
    return { queued: this.get("SELECT count(*) AS n FROM reviews WHERE status='queued'").n,
      running: this.get("SELECT count(*) AS n FROM reviews WHERE status='running'").n,
      publishing: this.get("SELECT count(*) AS n FROM reviews WHERE status='publishing'").n,
      merge_lane: batch ? {
        id: batch.id, generation: batch.generation, kind: batch.kind, state: batch.state,
        target_pr: batch.target_pr, selected_at: batch.selected_at,
        members: batch.members.map(({ pr, head_sha }) => ({ pr, head_sha })),
        mutation: batch.mutation ? { id: batch.mutation.id, kind: batch.mutation.kind } : null,
      } : null };
  }
  close() { this.db.close(); }
}
