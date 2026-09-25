import type { GitHub } from "./github.ts";
import type { ResultStore } from "./results.ts";
import { sleep as wait } from "./wait.ts";

export interface PostOptions {
  sha: string;
  store: ResultStore;
  github: GitHub;
  /** How many times to look for the commit on GitHub. */
  attempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type PostOutcome = "posted" | "no-result" | "gave-up";

/**
 * Posts a stored result once GitHub has the commit. The pre-push hook starts
 * this just before the push lands, so the commit usually appears within seconds.
 */
export async function postStoredResult(options: PostOptions): Promise<PostOutcome> {
  const { sha, store, github, attempts = 60, intervalMs = 2000, sleep = wait } = options;
  const result = await store.read(sha);
  if (!result) {
    return "no-result";
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await github.hasCommit(sha)) {
      await github.postStatus(sha, { state: result.state, context: result.context, description: result.description });
      return "posted";
    }
    if (attempt < attempts) {
      await sleep(intervalMs);
    }
  }
  return "gave-up";
}
