import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type Outcome = "passed" | "failed" | "skipped";

export interface CheckResult {
  name: string;
  outcome: Outcome;
  durationMs: number;
  /** Why the check was skipped. */
  reason?: string;
}

/** The finished result of validating one commit. */
export interface RunResult {
  sha: string;
  context: string;
  state: "success" | "failure";
  description: string;
  finishedAt: string;
  durationMs: number;
  checks: CheckResult[];
}

/** Results by commit, so one validated before it was pushed can be posted later. */
export class ResultStore {
  constructor(readonly dir: string) {}

  path(sha: string): string {
    return join(this.dir, `${sha}.json`);
  }

  async read(sha: string): Promise<RunResult | undefined> {
    const file = Bun.file(this.path(sha));
    return (await file.exists()) ? ((await file.json()) as RunResult) : undefined;
  }

  async write(result: RunResult): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await Bun.write(this.path(result.sha), `${JSON.stringify(result, null, 2)}\n`);
  }
}
