// the single owner of the review bot's deployment identity. Read once from the
// environment at import; any missing or malformed value fails the process at startup.
const env = process.env;

function fail(name) {
  throw new Error(`Invalid ${name}`);
}

function userId(name) {
  const id = Number(env[name]);
  if (!/^[1-9][0-9]*$/.test(env[name] ?? "") || !Number.isSafeInteger(id)) fail(name);
  return id;
}

function botLogin(name) {
  const login = env[name] ?? "";
  if (!/^[A-Za-z0-9-]+\[bot\]$/.test(login)) fail(name);
  return login;
}

const repository = env.GITHUB_REPOSITORY ?? "";
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) fail("GITHUB_REPOSITORY");

export const REPOSITORY = repository;
export const REPOSITORY_OWNER = repository.split("/")[0];
export const REVIEW_APP_ID = userId("GITHUB_APP_ID");

const reviewId = userId("REVIEW_BOT_USER_ID");
const reviewLogin = botLogin("REVIEW_BOT_LOGIN");
export const REVIEW_BOT = Object.freeze({
  id: reviewId,
  login: reviewLogin,
  graphqlLogin: reviewLogin.slice(0, -"[bot]".length),
});

const builderId = userId("BUILDER_BOT_USER_ID");
export const BUILDER_BOT = Object.freeze({ id: builderId, login: botLogin("BUILDER_BOT_LOGIN") });

function approvers() {
  const entries = (env.REVIEW_APPROVERS ?? "").split(",");
  return entries.map((entry) => {
    const match = /^([A-Za-z0-9-]+):([1-9][0-9]*)$/.exec(entry.trim());
    if (!match || !Number.isSafeInteger(Number(match[2]))) fail("REVIEW_APPROVERS");
    return Object.freeze({ id: Number(match[2]), login: match[1] });
  });
}

export const HUMAN_APPROVERS = Object.freeze(approvers());
export const APPROVER_NAMES = HUMAN_APPROVERS.map((user) => user.login).join(", ");
