import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Repo } from "./git.ts";

/** Where worktrees and build caches live, outside any repo. */
export function cacheRoot(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.LOCAL_CHECK_CACHE_DIR) {
    return env.LOCAL_CHECK_CACHE_DIR;
  }
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "local-check");
  }
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "local-check");
  }
  return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "local-check");
}

/** One cache per clone, so two clones of a repo never share a worktree. */
export function repoCacheDir(repo: Repo, root: string = cacheRoot()): string {
  const id = createHash("sha256").update(repo.commonDir).digest("hex").slice(0, 8);
  return join(root, `${repo.name}-${id}`);
}

/** Per-clone state, such as stored results and logs. */
export function stateDir(repo: Repo): string {
  return join(repo.commonDir, "local-check");
}
