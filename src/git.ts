import { $ } from "bun";
import { existsSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename } from "node:path";

export interface Repo {
  /** The working tree local-check was run from. */
  root: string;
  /** The git directory shared by every worktree of the clone. */
  commonDir: string;
  /** The repo's directory name, used to name its cache. */
  name: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await $`git -C ${cwd} ${args}`.nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

export async function openRepo(cwd: string): Promise<Repo> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const commonDir = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { root, commonDir, name: basename(root) };
}

export async function resolveCommit(repo: Repo, rev: string): Promise<string> {
  try {
    return await git(repo.root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  } catch {
    throw new Error(`${rev} isn't a commit in this repo`);
  }
}

export function commitSubject(repo: Repo, sha: string): Promise<string> {
  return git(repo.root, ["log", "-1", "--format=%s", sha]);
}

export async function hasUncommittedChanges(repo: Repo): Promise<boolean> {
  return (await git(repo.root, ["status", "--porcelain"])).length > 0;
}

/** Checks `sha` out, detached, in a worktree at `path`, creating the worktree if needed. */
export async function checkoutWorktree(repo: Repo, path: string, sha: string): Promise<void> {
  await git(repo.root, ["worktree", "prune"]);
  if (existsSync(path)) {
    if (await isWorktreeOf(repo, path)) {
      await git(path, ["checkout", "--quiet", "--detach", "--force", sha]);
      return;
    }
    // Something else is in the way, such as a worktree whose repo has gone.
    await rm(path, { recursive: true, force: true });
    await git(repo.root, ["worktree", "prune"]);
  }
  await git(repo.root, ["worktree", "add", "--quiet", "--detach", path, sha]);
}

async function isWorktreeOf(repo: Repo, path: string): Promise<boolean> {
  try {
    const commonDir = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return realpathSync(commonDir) === realpathSync(repo.commonDir);
  } catch {
    return false;
  }
}

/** Removes everything untracked from the worktree, except the paths in `keep`. */
export async function cleanWorktree(path: string, keep: readonly string[]): Promise<void> {
  await git(path, ["clean", "-ffdxq", ...keep.flatMap((entry) => ["-e", entry])]);
}

export async function gitConfig(repo: Repo, key: string): Promise<string | undefined> {
  const result = await $`git -C ${repo.root} config --get ${key}`.nothrow().quiet();
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

export async function setGitConfig(repo: Repo, key: string, value: string): Promise<void> {
  await git(repo.root, ["config", key, value]);
}
