import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const moduleUrl = new URL("./identity.mjs", import.meta.url).href;
const valid = {
  GITHUB_REPOSITORY: "example-org/example-project",
  GITHUB_APP_ID: "1001",
  REVIEW_BOT_LOGIN: "example-review[bot]",
  REVIEW_BOT_USER_ID: "1002",
  BUILDER_BOT_LOGIN: "builder[bot]",
  BUILDER_BOT_USER_ID: "1003",
  REVIEW_APPROVERS: "example-owner:1004",
};

function load(overrides) {
  const env = { PATH: process.env.PATH, ...valid, ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(m))`],
    { env, encoding: "utf8", cwd: fileURLToPath(new URL(".", import.meta.url)) },
  );
}

test("a valid deployment identity loads and derives the GraphQL login and approver names", () => {
  const result = load({ REVIEW_APPROVERS: "example-owner:1004, second-approver:1005" });
  assert.equal(result.status, 0, result.stderr);
  const identity = JSON.parse(result.stdout);
  assert.equal(identity.REPOSITORY_OWNER, "example-org");
  assert.deepEqual(identity.REVIEW_BOT, { id: 1002, login: "example-review[bot]", graphqlLogin: "example-review" });
  assert.equal(identity.APPROVER_NAMES, "example-owner, second-approver");
});

for (const [name, overrides] of [
  ["REVIEW_APPROVERS", { REVIEW_APPROVERS: "example-owner" }],
  ["REVIEW_APPROVERS", { REVIEW_APPROVERS: "" }],
  ["REVIEW_BOT_LOGIN", { REVIEW_BOT_LOGIN: "example-review" }],
  ["BUILDER_BOT_USER_ID", { BUILDER_BOT_USER_ID: "12x" }],
  ["GITHUB_APP_ID", { GITHUB_APP_ID: "0" }],
  ["GITHUB_REPOSITORY", { GITHUB_REPOSITORY: undefined, REVIEW_APPROVERS: undefined }],
]) {
  test(`startup fails closed on invalid ${name}: ${JSON.stringify(overrides)}`, () => {
    const result = load(overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Invalid ${name}\\b`, "u"));
  });
}
