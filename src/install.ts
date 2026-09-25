import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gitConfig, type Repo, setGitConfig } from "./git.ts";

export const HOOKS_DIR = ".githooks";

/** A committed hook that finds local-check in node_modules, and never blocks a push without it. */
export const HOOK_SHIM = `#!/bin/sh
# Posts local-check results for pushed commits: https://github.com/badbundle/local-check
bin="$(git rev-parse --show-toplevel)/node_modules/.bin/local-check"
if [ -x "$bin" ]; then
  exec "$bin" hook pre-push "$@"
fi
echo "local-check isn't installed, so results won't be posted. Run bun install." >&2
exit 0
`;

/**
 * Writes the pre-push hook if the repo doesn't have one, and points
 * core.hooksPath at it, unless it's already pointing somewhere else.
 */
export async function installHook(repo: Repo, write: (text: string) => void): Promise<void> {
  const hook = join(repo.root, HOOKS_DIR, "pre-push");
  if (!existsSync(hook)) {
    await mkdir(join(repo.root, HOOKS_DIR), { recursive: true });
    await Bun.write(hook, HOOK_SHIM);
    await chmod(hook, 0o755);
    write(`Wrote ${HOOKS_DIR}/pre-push; commit it.\n`);
  }
  const current = await gitConfig(repo, "core.hooksPath");
  if (current === undefined) {
    await setGitConfig(repo, "core.hooksPath", HOOKS_DIR);
    write(`Set core.hooksPath to ${HOOKS_DIR}.\n`);
  } else if (current !== HOOKS_DIR) {
    write(`core.hooksPath is already ${current}, so local-check's pre-push hook won't run. Point it at ${HOOKS_DIR} to use it.\n`);
  }
}
