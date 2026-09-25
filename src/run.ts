import { $ } from "bun";
import { appendFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type Config,
  ConfigError,
  type Context,
  DEFAULT_CONTEXT,
  type Kit,
  loadConfig,
  message,
  type Teardown,
} from "./config.ts";
import { processRunner, type Runner } from "./exec.ts";
import { describeFailure, describeSuccess, formatDuration, truncate } from "./format.ts";
import { checkoutWorktree, cleanWorktree, commitSubject, hasUncommittedChanges, type Repo, resolveCommit } from "./git.ts";
import type { GitHub } from "./github.ts";
import { kit as defaultKit } from "./kit.ts";
import { repoCacheDir, stateDir } from "./paths.ts";
import { type CheckResult, ResultStore, type RunResult } from "./results.ts";

export interface RunOptions {
  repo: Repo;
  github: GitHub;
  /** The commit to validate. Defaults to HEAD. */
  rev?: string;
  /** Empties the cache, worktree included, before running. */
  clean?: boolean;
  /** Interrupts the run. The CLI aborts it on SIGINT and SIGTERM. */
  signal?: AbortSignal;
  /** Where progress is written. Defaults to stdout. */
  write?: (text: string) => void;
  runner?: Runner;
  kit?: Kit;
  cacheDir?: string;
  now?: () => number;
}

export interface RunOutcome {
  /** Missing when the run was interrupted, since nothing was validated. */
  result?: RunResult;
  exitCode: number;
}

const FAILURE_TAIL_LINES = 40;
const INTERRUPTED_EXIT_CODE = 130;

/**
 * Validates a commit: checks it out into the worktree, loads that commit's
 * config, runs its setups and checks, then stores the result and posts it to
 * GitHub, if GitHub has the commit.
 */
export async function runChecks(options: RunOptions): Promise<RunOutcome> {
  const { repo, github, runner = processRunner, now = Date.now } = options;
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const signal = options.signal ?? new AbortController().signal;

  const sha = await resolveCommit(repo, options.rev ?? "HEAD");
  const short = sha.slice(0, 8);
  const state = stateDir(repo);
  const cacheDir = options.cacheDir ?? repoCacheDir(repo);
  const worktree = join(cacheDir, "worktree");
  const store = new ResultStore(join(state, "results"));
  const logPath = join(state, "logs", `${sha}.log`);
  await mkdir(join(state, "logs"), { recursive: true });
  await Bun.write(logPath, "");
  const log = (line: string) => appendFileSync(logPath, `${line}\n`);

  write(`Validating ${short} (${await commitSubject(repo, sha)})\n`);
  if (await hasUncommittedChanges(repo)) {
    write(`Note: you have uncommitted changes. Only the commit ${short} is validated.\n`);
  }

  if (options.clean) {
    await rm(cacheDir, { recursive: true, force: true });
  }
  await mkdir(cacheDir, { recursive: true });
  await checkoutWorktree(repo, worktree, sha);

  const started = now();
  let config: Config;
  try {
    config = await loadConfig(worktree, options.kit ?? defaultKit);
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    write(`${error.message}\n`);
    log(error.message);
    return finish({ context: DEFAULT_CONTEXT, failure: truncate(error.message), checks: [] });
  }
  const context = config.context ?? DEFAULT_CONTEXT;
  await cleanWorktree(worktree, options.clean ? [] : (config.worktree?.keep ?? []));

  let postedPending = false;
  if (await github.hasCommit(sha)) {
    await github.postStatus(sha, { state: "pending", context, description: "Validating..." });
    postedPending = true;
  }

  const env: Record<string, string> = {};
  const ctx: Context = {
    sha,
    worktree,
    cacheDir,
    stateDir: state,
    env,
    signal,
    async exec(command, { cwd = worktree, env: extra } = {}) {
      log(`$ ${command.join(" ")}`);
      const code = await runner.exec(command, { cwd, env: { ...env, ...extra }, logPath, signal });
      if (code !== 0) {
        throw new Error(`${command.join(" ")} exited with ${code}`);
      }
    },
    capture: (command, { cwd = worktree, env: extra } = {}) =>
      runner.capture(command, { cwd, env: { ...env, ...extra } }),
    get $() {
      const shell = new $.Shell();
      shell.cwd(worktree);
      shell.env({ ...process.env, ...env });
      return shell;
    },
    log,
  };

  const teardowns: Teardown[] = [];
  const checks: CheckResult[] = [];
  let failure: string | undefined;
  try {
    try {
      for (const setup of config.setup ?? []) {
        const teardown = await setup(ctx);
        if (typeof teardown === "function") {
          teardowns.push(teardown);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        log(`Setup failed: ${detail(error)}`);
        write(`Setup failed: ${message(error)}\n`);
        failure = truncate(`Setup failed: ${message(error)}`);
      }
    }

    for (const check of failure || signal.aborted ? [] : config.checks) {
      write(`${check.name}... `);
      log(`=== ${check.name}`);
      const checkStarted = now();
      try {
        const reason = await check.skip?.(ctx);
        if (reason) {
          write(`skipped (${reason})\n`);
          log(`Skipped: ${reason}`);
          checks.push({ name: check.name, outcome: "skipped", durationMs: 0, reason });
          continue;
        }
        if (typeof check.run === "function") {
          await check.run(ctx);
        } else {
          await ctx.exec(check.run);
        }
        const durationMs = now() - checkStarted;
        write(`done (${formatDuration(durationMs)})\n`);
        checks.push({ name: check.name, outcome: "passed", durationMs });
      } catch (error) {
        if (signal.aborted) {
          write("interrupted\n");
          break;
        }
        log(detail(error));
        write("FAILED\n");
        checks.push({ name: check.name, outcome: "failed", durationMs: now() - checkStarted });
        failure = describeFailure(check.name);
        await showLogTail();
        break;
      }
      if (signal.aborted) {
        break;
      }
    }
  } finally {
    for (const teardown of teardowns.reverse()) {
      try {
        await teardown();
      } catch (error) {
        log(`Teardown failed: ${detail(error)}`);
      }
    }
  }

  if (signal.aborted) {
    write("Interrupted, so no result was stored.\n");
    if (postedPending) {
      await github
        .postStatus(sha, { state: "error", context, description: "Validation was interrupted" })
        .catch((error) => write(`Couldn't mark the check as interrupted: ${message(error)}\n`));
    }
    return { exitCode: INTERRUPTED_EXIT_CODE };
  }
  if (!failure && !checks.some((check) => check.outcome === "passed")) {
    failure = "Every check was skipped";
  }
  return finish({ context, failure, checks });

  async function finish(outcome: { context: string; failure?: string; checks: CheckResult[] }): Promise<RunOutcome> {
    const durationMs = now() - started;
    const passed = outcome.checks.filter((check) => check.outcome === "passed").map((check) => check.name);
    const skipped = outcome.checks.filter((check) => check.outcome === "skipped").map((check) => check.name);
    const result: RunResult = {
      sha,
      context: outcome.context,
      state: outcome.failure ? "failure" : "success",
      description: outcome.failure ?? describeSuccess(passed, skipped, durationMs),
      finishedAt: new Date(now()).toISOString(),
      durationMs,
      checks: outcome.checks,
    };
    await store.write(result);
    // Checked again: the commit may have been pushed while the checks ran.
    if (await github.hasCommit(sha)) {
      await github.postStatus(sha, { state: result.state, context: result.context, description: result.description });
      write(`Posted "${result.context}: ${result.state}" to ${short} on GitHub.\n`);
    } else {
      write(`${short} isn't on GitHub yet; the pre-push hook will post the result when you push it.\n`);
    }
    return { result, exitCode: result.state === "success" ? 0 : 1 };
  }

  async function showLogTail(): Promise<void> {
    const lines = (await Bun.file(logPath).text()).trimEnd().split("\n");
    write(`\n${lines.slice(-FAILURE_TAIL_LINES).join("\n")}\n\nFull log: ${logPath}\n`);
  }
}

function detail(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : String(error);
}
