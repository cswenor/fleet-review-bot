#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function validateRepository(repository) {
  if (typeof repository !== "string" || repository !== repository.trim())
    throw new Error("Invalid GitHub repository identity");
  const parts = repository.split("/");
  if (
    parts.length !== 2 || !OWNER.test(parts[0]) || !NAME.test(parts[1]) ||
    parts[1] === "." || parts[1] === ".."
  ) throw new Error("Invalid GitHub repository identity");
  return parts;
}

function repositoryFromRemote(remote) {
  // Deliberately accept only GitHub clone URL forms. Do not parse/decode arbitrary
  // URLs or include a rejected URL (which may contain credentials) in an error.
  if (typeof remote !== "string" || remote !== remote.trim())
    throw new Error("Invalid GitHub origin remote");
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/.exec(remote);
  if (!match) throw new Error("Invalid GitHub origin remote");
  return match[1].replace(/\.git$/, "");
}

export function repositoryIdentity({ env = process.env, remoteUrl, cwd = process.cwd() } = {}) {
  let repository = env.GITHUB_REPOSITORY;
  if (repository === undefined) {
    if (remoteUrl === undefined) {
      try {
        remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
          cwd,
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 16 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch {
        throw new Error("Cannot resolve GitHub repository identity from origin");
      }
    }
    repository = repositoryFromRemote(remoteUrl);
  }
  const [owner, name] = validateRepository(repository);
  const imageNamespace = repository.toLowerCase();
  const appImage = `ghcr.io/${imageNamespace}`;
  return {
    repository, owner, name, imageNamespace, appImage,
    botImage: `${appImage}-review-bot`,
    mirrorImage: `${appImage}-ci-mirrors`,
  };
}

function main(args) {
  const mode = args[0];
  if (!(args.length === 0 ||
    (args.length === 2 && mode === "--field") ||
    (args.length === 1 && ["--github-output", "--github-env"].includes(mode)))) {
    throw new Error("Usage: repository-identity.mjs [--field <field> | --github-output | --github-env]");
  }
  const identity = repositoryIdentity();
  if (mode === "--field") {
    if (!Object.hasOwn(identity, args[1])) throw new Error("Unknown repository identity field");
    console.log(identity[args[1]]);
  } else if (mode === "--github-output" || mode === "--github-env") {
    const output = mode === "--github-output";
    const file = process.env[output ? "GITHUB_OUTPUT" : "GITHUB_ENV"];
    if (!file) throw new Error(output ? "GITHUB_OUTPUT is required" : "GITHUB_ENV is required");
    const values = output ? {
      repository: identity.repository, owner: identity.owner, name: identity.name,
      image_namespace: identity.imageNamespace, app_image: identity.appImage,
      bot_image: identity.botImage, mirror_image: identity.mirrorImage,
    } : {
      REVIEW_BOT_IMAGE_NAMESPACE: identity.imageNamespace,
      REVIEW_BOT_APP_IMAGE: identity.appImage,
      REVIEW_BOT_BOT_IMAGE: identity.botImage,
      REVIEW_BOT_MIRROR_IMAGE: identity.mirrorImage,
    };
    appendFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
  } else {
    console.log(JSON.stringify(identity));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
