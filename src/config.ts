import type { $ } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { waitFor } from "./wait.ts";
import type { Xcode, XcodeOptions } from "./xcode.ts";

/** The file each repo keeps at its root. It's loaded from the commit being validated. */
export const CONFIG_FILE = "local-check.config.ts";

/** The commit status context, unless a config names its own. */
export const DEFAULT_CONTEXT = "Validate (local)";

/** A repo's checks, the default export of `local-check.config.ts`. */
export interface Config {
  /** The commit status context the result is posted under. */
  context?: string;
  /**
   * Run in order before the first check. A setup can return a teardown, which
   * runs after the last check, even if a check fails or the run is interrupted.
   */
  setup?: Setup[];
  /** Run in order. The first one to fail stops the run. */
  checks: Check[];
  worktree?: {
    /**
     * Untracked paths in the worktree to keep between runs, such as a build
     * cache. Everything else untracked is removed first. `--clean` removes these too.
     */
    keep?: string[];
  };
}

export interface Check {
  name: string;
  /** Returns a reason to skip the check, or nothing to run it. */
  skip?: (ctx: Context) => string | undefined | Promise<string | undefined>;
  /**
   * A command to run in the worktree, or a function that can do anything:
   * run several commands, wait for something, read files. It fails by throwing,
   * which `ctx.exec` does when a command exits non-zero.
   */
  run: Command | ((ctx: Context) => void | Promise<void>);
}

/** A command and its arguments. No shell is involved, so nothing needs quoting. */
export type Command = readonly string[];

export type Setup = (ctx: Context) => void | Teardown | Promise<void | Teardown>;
export type Teardown = () => void | Promise<void>;

export interface ExecOptions {
  /** Defaults to the worktree. */
  cwd?: string;
  /** Added to the run's environment for this command only. */
  env?: Record<string, string>;
}

export interface CaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** What setups and checks are given. */
export interface Context {
  /** The commit being validated. */
  readonly sha: string;
  /** A clean checkout of that commit. Commands run here unless told otherwise. */
  readonly worktree: string;
  /** Kept between runs, for build caches such as DerivedData. `--clean` empties it. */
  readonly cacheDir: string;
  /** Per-clone state, inside the repo's git directory. */
  readonly stateDir: string;
  /** Extra environment for every command. Setups can add to it. */
  readonly env: Record<string, string>;
  /** Aborted when the run is interrupted. Pass it to anything that waits. */
  readonly signal: AbortSignal;
  /** Runs a command with its output in the log. Throws if it exits non-zero. */
  exec(command: Command, options?: ExecOptions): Promise<void>;
  /**
   * Runs a command and returns its output. It doesn't log or throw, and an
   * interruption doesn't stop it, so teardowns can use it to clean up.
   */
  capture(command: Command, options?: ExecOptions): Promise<CaptureResult>;
  /** Bun Shell in the worktree, with `env` applied. Its output isn't logged. */
  readonly $: typeof $;
  /** Writes a line to the log. */
  log(message: string): void;
}

/** The helpers a config function is given. */
export interface Kit {
  xcode(options: XcodeOptions): Xcode;
  waitFor: typeof waitFor;
}

export type ConfigFunction = (kit: Kit) => Config | Promise<Config>;

/** What `local-check.config.ts` exports by default. */
export type ConfigExport = Config | ConfigFunction;

export class ConfigError extends Error {
  override name = "ConfigError";
}

let loads = 0;

/**
 * Loads the config from `dir`. Configs import only types from this package,
 * which Bun erases, so a config loads from a bare checkout with no
 * node_modules; the helpers it needs arrive through `kit`.
 */
export async function loadConfig(dir: string, kit: Kit): Promise<Config> {
  const path = join(dir, CONFIG_FILE);
  if (!(await Bun.file(path).exists())) {
    throw new ConfigError(`No ${CONFIG_FILE} in this commit`);
  }
  // Bun caches modules by path, ignoring query strings, so each load imports a
  // copy with a new name. The copy sits beside the original so that relative
  // imports in the config still resolve, and it's removed straight away.
  const copy = join(dir, `.${CONFIG_FILE}.${process.pid}-${++loads}.ts`);
  await Bun.write(copy, Bun.file(path));
  let exported: unknown;
  try {
    exported = (await import(pathToFileURL(copy).href)).default;
  } catch (error) {
    throw new ConfigError(`${CONFIG_FILE} failed to load: ${message(error)}`);
  } finally {
    await rm(copy, { force: true });
  }
  const config = typeof exported === "function" ? await exported(kit) : exported;
  validate(config);
  return config;
}

function validate(config: unknown): asserts config is Config {
  if (typeof config !== "object" || config === null) {
    throw new ConfigError(`${CONFIG_FILE} must export a config object, or a function returning one`);
  }
  const { checks, setup } = config as Partial<Config>;
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new ConfigError(`${CONFIG_FILE} has no checks`);
  }
  for (const [index, check] of checks.entries()) {
    const valid =
      typeof check?.name === "string" &&
      check.name.length > 0 &&
      (typeof check.run === "function" ||
        (Array.isArray(check.run) && check.run.length > 0 && check.run.every((part) => typeof part === "string")));
    if (!valid) {
      throw new ConfigError(`Check ${index + 1} in ${CONFIG_FILE} needs a name and a command or run function`);
    }
  }
  if (setup !== undefined && (!Array.isArray(setup) || !setup.every((entry) => typeof entry === "function"))) {
    throw new ConfigError(`setup in ${CONFIG_FILE} must be a list of functions`);
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
