import type { ResultStore } from "./results.ts";

/** One line of what git gives a pre-push hook on stdin. */
export interface RefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export function parsePrePushInput(input: string): RefUpdate[] {
  return input.split("\n").flatMap((line) => {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    return localRef && localSha && remoteRef && remoteSha ? [{ localRef, localSha, remoteRef, remoteSha }] : [];
  });
}

/** Branch pushes only: tags don't get statuses, and a deleted branch has no commit. */
export function branchPushes(updates: RefUpdate[]): RefUpdate[] {
  return updates.filter((update) => update.remoteRef.startsWith("refs/heads/") && /[^0]/.test(update.localSha));
}

export interface PrePushOptions {
  input: string;
  store: ResultStore;
  /** Posts the stored result in the background, once the push has landed. */
  schedulePost: (sha: string) => void;
  warn: (text: string) => void;
}

/** Never blocks a push: a commit that hasn't been validated just doesn't get the check. */
export async function handlePrePush({ input, store, schedulePost, warn }: PrePushOptions): Promise<void> {
  for (const update of branchPushes(parsePrePushInput(input))) {
    if (await store.read(update.localSha)) {
      schedulePost(update.localSha);
    } else {
      const branch = update.remoteRef.slice("refs/heads/".length);
      warn(`local-check: ${update.localSha.slice(0, 8)} (${branch}) hasn't been validated, so it won't get the green check.\n`);
    }
  }
}
