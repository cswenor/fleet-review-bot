import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { Scheduler } from "./scheduler.mjs";
import { Publisher } from "./publish.mjs";
import { createWebhookServer } from "./server.mjs";

async function fixture(t, initialHead = "c".repeat(40)) {
  const root = await mkdtemp(join(tmpdir(), "publication-health-"));
  let store = new Store(join(root, "state.sqlite"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true });
  });
  let now = 1000000,
    rejectPublication = true,
    reviewPosts = 0,
    checkPosts = 0;
  const secret = "fixture-private-publication-value";
  const events = [];
  const head = "c".repeat(40);
  let rejectionMessage = `${secret} ${"x".repeat(4000)}`;
  const github = {
    repo: "example-org/example-project",
    appId: 1001,
    paginate: async () => [],
    request: async (method, path, body) => {
      if (method === "GET" && path.endsWith("/pulls/1")) {
        return {
          state: "open",
          draft: false,
          head: { sha: head, repo: { full_name: github.repo } },
          base: { ref: "main" },
        };
      }
      if (method === "POST" && path.endsWith("/reviews")) {
        reviewPosts++;
        return { id: 42 };
      }
      if (method === "PATCH" && path.includes("/check-runs/")) {
        if (body.status !== "completed") return {};
        checkPosts++;
        if (rejectPublication) {
          // The historical first HTTP error is unknown. Inject a transport failure,
          // not a claim that this was its status, text or cause.
          const error = new Error(rejectionMessage);
          error.name = "FixturePublicationFailure";
          error.code = "EFIXTURE";
          throw error;
        }
        return {};
      }
      assert.fail(`Unexpected fixture GitHub request: ${method} ${path}`);
    },
  };
  const makeScheduler = () => {
    const scheduler = new Scheduler({
      store,
      github,
      now: () => now,
      log: (event) => events.push(event),
      publisher: new Publisher({ github, store, secrets: [secret] }),
      mirror: { result: () => assert.fail("A durable completed result must not rerun its model") },
      verdict: { evaluate: () => assert.fail("The frozen blocking verdict must not be replaced") },
      fetchImpl: () => assert.fail("A durable completed result must not poll or restart a runner"),
    });
    scheduler.lastReconcileAt = now;
    scheduler.lastReconcileOkAt = now;
    return scheduler;
  };
  const serve = async (scheduler) => {
    const server = createWebhookServer({
      store,
      scheduler,
      secret: "fixture-webhook-secret",
      now: () => now,
      fetchImpl: async () => ({ ok: true }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
      return { status: response.status, body: await response.json() };
    };
  };
  const row = store.enqueue(
    { base_ref: "main", pr: 1, head_sha: initialHead, due: 0, reason: "opened" },
    now,
  );
  store.update(row.id, { status: "running", check_run_id: 10 });
  store.publicationIntent(row, {
    repo: github.repo,
    pr: 1,
    head_sha: initialHead,
    base_sha: "d".repeat(40),
    policy: {},
    priorFindingIds: [],
    findings: [
      {
        id: null,
        severity: "P2",
        status: "new",
        file: "src/file.mjs",
        line: 1,
        title: "Contract failure",
        scenario: "A shipped consumer fails",
      },
    ],
    suggestions: [],
    diff: "diff --git a/src/file.mjs b/src/file.mjs\n--- a/src/file.mjs\n+++ b/src/file.mjs\n@@ -1 +1 @@\n-old\n+new\n",
    result: { pass: true, reasons: [], evidence: {} },
    verdict: { decision: "block", model: "fixture", request_ids: ["fixture-verdict"] },
  });
  return {
    get store() {
      return store;
    },
    row,
    events,
    secret,
    makeScheduler,
    serve,
    reopenStore: () => {
      store.close();
      store = new Store(join(root, "state.sqlite"));
    },
    advance: () => {
      now += 1000;
    },
    allowPublication: () => {
      rejectPublication = false;
    },
    timeoutPublication: () => {
      rejectionMessage = "github_timeout";
    },
    calls: () => ({ reviewPosts, checkPosts }),
    result: () => JSON.parse(store.review(row.id).result_json),
  };
}

test("completed publication failures degrade HTTP health across restart and retry without losing the posted receipt", async (t) => {
  const f = await fixture(t),
    scheduler = f.makeScheduler();
  const health = await f.serve(scheduler);
  await scheduler.tick();
  assert.equal((await health()).status, 503);
  assert.equal(f.result().postedReviewId, 42);
  const first = f.result().publication_failure;
  assert.equal(first.attempts, 1);
  assert.equal(first.first_failed_at, first.last_failed_at);
  assert.ok(first.cause.message.includes("[redacted]"));
  assert.ok(first.cause.message.length <= 1000);
  assert.equal(JSON.stringify(f.events).includes(f.secret), false);
  assert.equal(f.store.review(f.row.id).result_json.includes(f.secret), false);
  const logged = f.events.find((event) => event.event === "review_poll_failed");
  assert.equal(logged.cause.code, "EFIXTURE");
  assert.ok(logged.cause.message.includes("[redacted]"));
  assert.ok(logged.cause.message.length <= 1000);

  f.reopenStore();
  const restarted = f.makeScheduler(),
    restartedHealth = await f.serve(restarted);
  assert.equal(
    (await restartedHealth()).status,
    503,
    "Restart does not erase a pending publication failure",
  );
  f.advance();
  await restarted.recover();
  const second = f.result().publication_failure;
  assert.equal(second.attempts, 2);
  assert.equal(second.first_failed_at, first.first_failed_at);
  assert.ok(second.last_failed_at > first.last_failed_at);
  assert.equal(f.result().postedReviewId, 42);
  assert.equal((await restartedHealth()).status, 503);

  f.allowPublication();
  f.advance();
  await restarted.tick();
  const recovered = await restartedHealth();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.ok, true);
  assert.deepEqual(recovered.body.publicationFailures, []);
  assert.equal(f.store.review(f.row.id).status, "completed");
  assert.equal(
    f.store.review(f.row.id).conclusion,
    "failure",
    "Publishing must retain the blocking verdict",
  );
  assert.equal(f.result().publication_failure, undefined);
  assert.equal(f.result().postedReviewId, 42);
  assert.deepEqual(f.calls(), { reviewPosts: 1, checkPosts: 3 });
});

test("a terminal review clears publication-health degradation without publishing or approving its frozen verdict", async (t) => {
  const f = await fixture(t),
    scheduler = f.makeScheduler();
  const health = await f.serve(scheduler);
  await scheduler.tick();
  assert.equal((await health()).status, 503);
  const calls = f.calls();
  f.allowPublication();
  await scheduler.cancel(f.row.pr, "superseded");
  const terminal = await health();
  assert.equal(terminal.status, 200);
  assert.deepEqual(terminal.body.publicationFailures, []);
  assert.equal(f.store.review(f.row.id).status, "cancelled");
  assert.equal(f.store.review(f.row.id).reason, "superseded");
  assert.equal(
    f.calls().reviewPosts,
    calls.reviewPosts,
    "Cancellation does not publish another review",
  );
  assert.equal(
    f.result().publication_failure.attempts,
    1,
    "The terminal receipt retains its diagnostic history",
  );
});

test("a carried-result start timeout records the first publication failure without changing its retry outcome", async (t) => {
  const oldHead = "a".repeat(40),
    f = await fixture(t, oldHead),
    scheduler = f.makeScheduler();
  const previous = {
    ...f.result(),
    head_sha: oldHead,
    reportText: "A blocking consumer contract remains open",
    publication_state: "completed",
  };
  f.store.update(f.row.id, {
    status: "completed",
    base_sha: previous.base_sha,
    conclusion: "failure",
    result_json: JSON.stringify(previous),
    finished_at: 1000000,
  });
  let row = f.store.enqueue(
    { base_ref: "main", pr: 1, head_sha: "c".repeat(40), due: 0, reason: "synchronize" },
    1000000,
  );
  row = f.store.update(row.id, { check_run_id: 11 });
  scheduler.mirror.carry = async () => ({
    ...previous,
    head_sha: row.head_sha,
    diff: "",
    carried_forward_from: oldHead,
    carry: { main_sha: "d".repeat(40) },
    publication_state: "pending",
  });
  scheduler.verdict.carry = async () => previous.verdict;
  f.timeoutPublication();
  const health = await f.serve(scheduler);
  await scheduler.start(row);
  const failed = f.store.review(row.id);
  assert.equal(failed.reason, "github_timeout");
  assert.equal(failed.conclusion, "neutral", "The existing timeout retry outcome is unchanged");
  const unhealthy = await health();
  assert.equal(unhealthy.status, 503);
  assert.equal(unhealthy.body.publicationFailures[0].review, row.id);
  const failure = JSON.parse(failed.result_json).publication_failure;
  assert.equal(failure.attempts, 1);
  assert.equal(failure.first_failed_at, failure.last_failed_at);
  assert.ok(
    f.events.some(
      (event) =>
        event.event === "publication_start_failed" &&
        event.review === row.id &&
        event.cause.message === "github_timeout",
    ),
  );

  f.allowPublication();
  f.advance();
  await scheduler.tick();
  assert.equal((await health()).status, 200);
  assert.equal(f.store.review(row.id).status, "completed");
  assert.equal(f.store.review(row.id).conclusion, "failure");
  assert.equal(
    f.calls().reviewPosts,
    0,
    "Carried evidence still does not submit another review comment",
  );
});

test("startup HTTP and execution refill do not wait for a recovered publication", async t => {
  const f = await fixture(t), scheduler = f.makeScheduler();
  const blocked = Promise.withResolvers(), release = Promise.withResolvers();
  const secondStarted = Promise.withResolvers(), thirdStarted = Promise.withResolvers();
  t.after(() => release.resolve());
  scheduler.concurrency = 1;
  scheduler.publisher.completed = async row => {
    if (row.id === f.row.id) { blocked.resolve(); await release.promise; }
    return "failure";
  };
  const request = scheduler.github.request;
  scheduler.github.request = async (method, path, body, guard) => {
    if (method === "GET" && /\/pulls\/[23]$/u.test(path)) return {
      state: "open", draft: false, head: { sha: "c".repeat(40), repo: { full_name: scheduler.github.repo } }, base: { ref: "main" },
    };
    return request(method, path, body, guard);
  };
  scheduler.mirror.prepare = async () => ({ base_sha: "d".repeat(40) });
  scheduler.mirror.result = async row => ({
    ...f.result(), pr: row.pr, findings: [], result: { pass: false, reasons: ["controlled exit"], evidence: {} },
  });
  let secondExited = false;
  scheduler.fetch = async (url, { method }) => {
    const id = Number(url.split("/").at(-1).split("-")[0]), row = f.store.review(id);
    if (method === "POST") {
      (row.pr === 2 ? secondStarted : thirdStarted).resolve();
      return { status: 202, ok: true };
    }
    if (method === "GET") return {
      status: 200, ok: true, json: async () => ({ state: secondExited ? "exited" : "running", exitCode: 0 }),
    };
    return { status: 200, ok: true };
  };
  for (const pr of [2, 3]) {
    const row = f.store.enqueue({ pr, head_sha: "c".repeat(40), base_ref: "main", due: 0, reason: "opened" }, pr);
    f.store.update(row.id, { check_run_id: pr * 10 });
  }
  // Same ordering as production: bounded initialization, HTTP, then timer ticks.
  await scheduler.recover({ waitForPublications: false });
  const health = await f.serve(scheduler);
  await Promise.all([blocked.promise, secondStarted.promise]);
  assert.equal((await health()).status, 200);
  await scheduler.starting.get(f.store.active(2).id);
  secondExited = true;
  const tick = scheduler.tick();
  await thirdStarted.promise;
  assert.equal(f.store.review(f.row.id).status, "publishing");
  assert.equal(JSON.parse(f.store.active(2).execution_exit_json).state, "exited");
  release.resolve();
  await tick;
  await scheduler.operations;
});
