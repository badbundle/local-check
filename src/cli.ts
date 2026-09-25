#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { message } from "./config.ts";
import { openRepo, resolveCommit } from "./git.ts";
import { gitHubFor } from "./github.ts";
import { handlePrePush } from "./hook.ts";
import { installHook } from "./install.ts";
import { stateDir } from "./paths.ts";
import { postStoredResult } from "./post.ts";
import { ResultStore } from "./results.ts";
import { runChecks } from "./run.ts";

const USAGE = `local-check ${packageJson.version}

Usage:
  local-check [run] [--clean] [<commit>]  Validate a commit (HEAD by default) and post the result
  local-check post <commit>               Post a stored result, once GitHub has the commit
  local-check hook pre-push               Run as git's pre-push hook
  local-check install-hook                Write .githooks/pre-push and point core.hooksPath at it

See https://github.com/badbundle/local-check
`;

class UsageError extends Error {}

const COMMANDS = new Set(["run", "post", "hook", "install-hook", "help", "--help", "-h", "--version"]);

async function main(args: string[]): Promise<number> {
  const [first, ...rest] = args;
  const command = first !== undefined && COMMANDS.has(first) ? first : "run";
  const commandArgs = command === first ? rest : args;
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    case "--version":
      process.stdout.write(`${packageJson.version}\n`);
      return 0;
    case "post":
      return post(commandArgs);
    case "hook":
      return hook(commandArgs);
    case "install-hook":
      await installHook(await openRepo(process.cwd()), (text) => process.stdout.write(text));
      return 0;
    default:
      return run(commandArgs);
  }
}

async function run(args: string[]): Promise<number> {
  let clean = false;
  const revs: string[] = [];
  for (const arg of args) {
    if (arg === "--clean") {
      clean = true;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option ${arg}`);
    } else {
      revs.push(arg);
    }
  }
  if (revs.length > 1) {
    throw new UsageError("Give at most one commit");
  }
  const repo = await openRepo(process.cwd());
  const github = await gitHubFor(repo.root);
  const controller = new AbortController();
  const interrupt = () => {
    if (!controller.signal.aborted) {
      process.stderr.write("\nInterrupted; cleaning up...\n");
      controller.abort(new Error("Interrupted"));
    }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const { exitCode } = await runChecks({ repo, github, rev: revs[0], clean, signal: controller.signal });
  return exitCode;
}

async function post(args: string[]): Promise<number> {
  const [rev] = args;
  if (!rev || args.length > 1) {
    throw new UsageError("post needs one commit");
  }
  const repo = await openRepo(process.cwd());
  const sha = await resolveCommit(repo, rev);
  const outcome = await postStoredResult({
    sha,
    store: new ResultStore(join(stateDir(repo), "results")),
    github: await gitHubFor(repo.root),
  });
  const messages = {
    posted: `Posted the result for ${sha.slice(0, 8)}.\n`,
    "no-result": `${sha.slice(0, 8)} hasn't been validated.\n`,
    "gave-up": `GitHub doesn't have ${sha.slice(0, 8)} yet. Push it, then run local-check post ${sha.slice(0, 8)}.\n`,
  } as const;
  (outcome === "posted" ? process.stdout : process.stderr).write(messages[outcome]);
  return outcome === "posted" ? 0 : 1;
}

/** A hook must never block a push, so it always exits 0. */
async function hook(args: string[]): Promise<number> {
  if (args[0] !== "pre-push") {
    throw new UsageError(`Unknown hook ${args[0] ?? ""}`.trim());
  }
  try {
    const repo = await openRepo(process.cwd());
    const logs = join(stateDir(repo), "logs");
    await handlePrePush({
      input: await Bun.stdin.text(),
      store: new ResultStore(join(stateDir(repo), "results")),
      warn: (text) => process.stderr.write(text),
      schedulePost(sha) {
        // The commit reaches GitHub after this hook exits, so a detached
        // process waits for it and posts the result.
        mkdirSync(logs, { recursive: true });
        const log = openSync(join(logs, "post.log"), "a");
        spawn(process.execPath, [import.meta.path, "post", sha], {
          cwd: repo.root,
          detached: true,
          stdio: ["ignore", log, log],
        }).unref();
      },
    });
  } catch (error) {
    process.stderr.write(`local-check: couldn't post results for this push: ${message(error)}\n`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : `local-check: ${message(error)}\n`);
    process.exit(2);
  },
);
