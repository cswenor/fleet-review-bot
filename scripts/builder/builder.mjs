#!/usr/bin/env node
// Git credential helper and gh wrapper for the per-instance Builder App.
// Credentials come from the trusted caller environment and are never written to disk.
import { execFileSync, spawn } from "node:child_process";
import { createPrivateKey, createSign } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryIdentity } from "../repository-identity.mjs";
const API = "https://api.github.com";
const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "builder",
};

export async function readBuilderSecrets({ env = process.env } = {}) {
  try {
    const clientId = env.BUILDER_GITHUB_APP_CLIENT_ID;
    const encoded = env.BUILDER_GITHUB_APP_PRIVATE_KEY_B64;
    if (typeof clientId !== "string" || !/^Iv[0-9A-Za-z.]+$/.test(clientId)) throw new Error();
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const privateKey = createPrivateKey(Buffer.from(encoded, "base64").toString("utf8"));
    if (privateKey.asymmetricKeyType !== "rsa") throw new Error();
    return { clientId, privateKey };
  } catch {
    throw new Error("builder refused: builder_secret_unavailable");
  }
}

export function appJwt({ clientId, privateKey, now = Date.now }) {
  const seconds = Math.floor(now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: clientId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}

export async function mintInstallationToken({
  clientId, privateKey, fetchImpl = fetch, now = Date.now, timeoutMs = 15000,
  env = process.env, cwd = process.cwd(), remoteUrl,
}) {
  const { repository } = repositoryIdentity({ env, cwd, remoteUrl });
  const headers = { ...HEADERS, Authorization: `Bearer ${appJwt({ clientId, privateKey, now })}` };
  const lookup = await fetchImpl(`${API}/repos/${repository}/installation`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!lookup.ok) throw new Error(`builder refused: GitHub returned HTTP ${lookup.status} for the installation lookup`);
  let installation;
  try {
    installation = await lookup.json();
  } catch {
    throw new Error("builder refused: invalid installation response");
  }
  if (!Number.isSafeInteger(installation?.id) || installation.id < 1) {
    throw new Error("builder refused: invalid installation response");
  }
  const response = await fetchImpl(`${API}/app/installations/${installation.id}/access_tokens`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    redirect: "error",
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`builder refused: GitHub returned HTTP ${response.status} for an installation token`);
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("builder refused: invalid installation token response");
  }
  if (typeof result?.token !== "string" || !/^[A-Za-z0-9_.-]{20,4096}$/.test(result.token)) {
    throw new Error("builder refused: invalid installation token response");
  }
  const expiresAt = Date.parse(result.expires_at);
  if (!(expiresAt > now() + 60000)) throw new Error("builder refused: installation token is already expiring");
  // Repository-filtered tokens fail Git transport; verify the fresh token's
  // complete installation grant before exposing it to either consumer.
  const repositories = await fetchImpl(`${API}/installation/repositories`, {
    headers: { ...HEADERS, Authorization: `Bearer ${result.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!repositories.ok) throw new Error(`builder refused: GitHub returned HTTP ${repositories.status} for installation repository verification`);
  let scope;
  try {
    scope = await repositories.json();
  } catch {
    throw new Error("builder refused: invalid installation repository response");
  }
  if (scope?.total_count !== 1 || !Array.isArray(scope.repositories)
      || scope.repositories.length !== 1 || scope.repositories[0]?.full_name !== repository) {
    throw new Error(`builder refused: installation must grant exactly ${repository}`);
  }
  return { token: result.token, expiresAt };
}

export async function gitCredential(operation, input, { mint }) {
  if (operation === "store" || operation === "erase") return { code: 0, stdout: "" };
  if (operation !== "get") {
    return { code: 2, stdout: "", stderr: "usage: builder.mjs git-credential <get|store|erase>\n" };
  }
  const fields = {};
  for (const line of input.split("\n")) {
    if (!line) break;
    const separator = line.indexOf("=");
    if (separator !== -1) fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  if (fields.protocol !== "https" || fields.host !== "github.com") return { code: 0, stdout: "" };
  try {
    const token = await mint();
    return { code: 0, stdout: `username=x-access-token\npassword=${token}\n` };
  } catch (error) {
    return { code: 1, stdout: "quit=1\n", stderr: `${error.message}\n` };
  }
}

export async function runGh(
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    mint,
    spawnImpl = spawn,
    realGh = env.REVIEW_BOT_BUILDER_REAL_GH ?? join(homedir(), ".local/libexec/gh"),
    self,
  },
) {
  let builder = false;
  try {
    builder =
      execFileSync("git", ["config", "--type=bool", "--get", "review-bot.builder"], {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true";
  } catch (error) {
    if (error.status !== 1) {
      const reason = Number.isInteger(error.status) ? `git config exited ${error.status}` : "git config could not execute";
      process.stderr.write(`builder refused: cannot determine review-bot.builder: ${reason}\n`);
      return 1;
    }
  }
  try {
    if (realpathSync(realGh) === realpathSync(self)) throw new Error("builder refused: real gh resolves to this shim");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  let childEnv = env;
  if (builder) {
    if (args[0] === "auth") {
      process.stderr.write(
        "builder refused: gh auth is disabled in builder worktrees (it could print the App token or change personal gh login)\n",
      );
      return 1;
    }
    try {
      childEnv = { ...env, GH_TOKEN: await mint() };
    } catch (error) {
      process.stderr.write(`builder: refusing to run gh without the builder App token: ${error.message}\n`);
      return 1;
    }
  }
  return new Promise((resolve) => {
    let child;
    const forwardInt = () => child?.kill("SIGINT");
    const forwardQuit = () => child?.kill("SIGQUIT");
    const forwardTerm = () => child?.kill("SIGTERM");
    const forwardHup = () => child?.kill("SIGHUP");
    const cleanup = () => {
      process.removeListener("SIGINT", forwardInt);
      process.removeListener("SIGQUIT", forwardQuit);
      process.removeListener("SIGTERM", forwardTerm);
      process.removeListener("SIGHUP", forwardHup);
    };
    process.on("SIGINT", forwardInt);
    process.on("SIGQUIT", forwardQuit);
    process.on("SIGTERM", forwardTerm);
    process.on("SIGHUP", forwardHup);
    try {
      child = spawnImpl(realGh, args, { cwd, env: childEnv, stdio: "inherit" });
    } catch (error) {
      cleanup();
      process.stderr.write(`${error.message}\n`);
      resolve(1);
      return;
    }
    child.once("error", (error) => {
      cleanup();
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) process.kill(process.pid, signal);
      resolve(code ?? 1);
    });
  });
}

async function main(argv) {
  const mint = async () => (await mintInstallationToken(await readBuilderSecrets())).token;
  if (argv[0] === "git-credential" && argv.length === 2) {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const result = await gitCredential(argv[1], input, { mint });
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
  } else if (argv[0] === "gh" || (argv[0] === "dispatch" && argv.length === 2)) {
    let args = argv.slice(1);
    if (argv[0] === "dispatch") {
      try {
        const { repository } = repositoryIdentity();
        args = ["workflow", "run", argv[1], "--repo", repository, "--ref", "main"];
      } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        return;
      }
    }
    process.exitCode = await runGh(args, { mint, self: fileURLToPath(import.meta.url) });
  } else {
    process.stderr.write("usage: builder.mjs git-credential <get|store|erase> | gh <args> | dispatch <workflow>\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
