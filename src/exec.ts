import { closeSync, openSync, writeSync } from "node:fs";
import type { CaptureResult, Command } from "./config.ts";

export interface ProcessOptions {
  cwd: string;
  env: Record<string, string>;
}

/** How commands are run. Tests use a fake. */
export interface Runner {
  /**
   * Runs a command with its output appended to `logPath`, as it's written, and
   * returns its exit code. Aborting `signal` kills it.
   */
  exec(command: Command, options: ProcessOptions & { logPath: string; signal: AbortSignal }): Promise<number>;
  /** Runs a command and returns its output. */
  capture(command: Command, options: ProcessOptions): Promise<CaptureResult>;
}

/** An exit code for a command that couldn't be started, as shells use. */
const NOT_FOUND = 127;

export const processRunner: Runner = {
  async exec(command, { cwd, env, logPath, signal }) {
    const log = openSync(logPath, "a");
    try {
      const child = Bun.spawn([...command], {
        cwd,
        env: { ...process.env, ...env },
        stdin: "ignore",
        stdout: log,
        stderr: log,
        signal,
      });
      return await child.exited;
    } catch (error) {
      writeSync(log, `local-check: couldn't run ${command[0]}: ${error instanceof Error ? error.message : error}\n`);
      return NOT_FOUND;
    } finally {
      closeSync(log);
    }
  },

  async capture(command, { cwd, env }) {
    try {
      const child = Bun.spawn([...command], {
        cwd,
        env: { ...process.env, ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, stdout, stderr };
    } catch (error) {
      return { exitCode: NOT_FOUND, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  },
};
