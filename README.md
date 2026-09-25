# local-check

Local validation for Bad Bundle repos. It runs a repo's checks on the exact commit, on the developer's machine, and posts the result to GitHub as a commit status, so a PR carries a green check without a CI run. Written in TypeScript for [Bun](https://bun.com).

## Why

In these repos every change is built and tested on the developer's Mac before it's pushed, so hosted CI would only repeat that work, and couldn't use the Xcode and simulators the Mac already has. What was missing is proof, on the PR, that the commit being merged passed. local-check provides it, and a ruleset on `main` makes it a requirement for merging.

## How it works

1. It checks the commit out into a worktree kept in a cache outside the repo, and removes any untracked files there, so uncommitted changes and stale build output can't affect the result.
2. It loads `local-check.config.ts` from that commit and runs its setups, then its checks, in order. The first check to fail stops the run.
3. It stores the result in the clone's `.git/local-check/` and posts it to GitHub as a commit status, `Validate (local)` unless the config names another. While the checks run, the status is `pending`. If the run is interrupted, it becomes `error`.
4. If GitHub doesn't have the commit yet, the pre-push hook posts the stored result when you push it. So you can validate before or after pushing.

Statuses are posted with the [`gh` CLI](https://cli.github.com), so they use your own login.

## Adding it to a repo

You'll need Bun 1.4 or later, `gh` logged in with access to the repo, and git 2.31 or later.

1. Add a `package.json`, pinned to a release tag:

   ```json
   {
     "private": true,
     "scripts": {
       "validate": "local-check",
       "prepare": "local-check install-hook"
     },
     "devDependencies": {
       "@badbundle/local-check": "github:badbundle/local-check#v0.1.0"
     }
   }
   ```

2. Run `bun install`, and add `node_modules/` to `.gitignore`. Commit `package.json` and `bun.lock`.

   The `prepare` script runs `local-check install-hook` on every install. It writes `.githooks/pre-push` if the repo doesn't have one (commit it), and points `core.hooksPath` at `.githooks`, unless it already points somewhere else.

3. Write `local-check.config.ts` at the root of the repo. See [Writing a config](#writing-a-config).

4. Require the check on `main`, with a bypass for admins in an emergency:

   ```sh
   gh api -X POST repos/OWNER/REPO/rulesets --input - <<'EOF'
   {
     "name": "Require local validation",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
     "rules": [{
       "type": "required_status_checks",
       "parameters": {
         "strict_required_status_checks_policy": false,
         "required_status_checks": [{ "context": "Validate (local)" }]
       }
     }]
   }
   EOF
   ```

Then, to validate: commit, and run `bun run validate`. Only the committed `HEAD` is validated, and every new commit needs validating again.

## Writing a config

The config is the default export of `local-check.config.ts`. It's loaded from the commit being validated, so a commit carries its own checks.

Import only types from this package (`import type`). Bun erases them, so the config loads from a bare checkout with no `node_modules`. The helpers a config needs come from the kit it's given instead:

```ts
import type { ConfigFunction } from "@badbundle/local-check";

export default (({ xcode }) => {
  const ios = xcode({
    version: "27.0",
    simulator: {
      name: "iPhone 18 Pro Max",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
    },
  });

  return {
    setup: [ios.setup],
    checks: [
      { name: "Lint", run: ["make", "-C", "Vault", "lint"] },
      ios.buildForTesting({ workspace: "Vault.xcworkspace", scheme: "CI_iOS", testPlan: "iOSAllTests" }),
      ios.testWithoutBuilding(),
    ],
  };
}) satisfies ConfigFunction;
```

A config that needs no helpers can export a `Config` object instead.

### Checks

A check has a `name` and a `run`, which is either a command or a function:

- **A command** is an array, such as `["make", "-C", "Vault", "lint"]`. No shell is involved, so nothing needs quoting. It runs in the worktree, its output goes to the log, and the check fails if it exits non-zero.
- **A function** gets the [context](#the-context) and can do anything: run several commands, wait for something, read files, decide what to run. It fails by throwing, which `ctx.exec` does when a command fails.

A check can also have `skip`, a function that returns a reason to skip it, or nothing to run it. A skipped check is named on the status, so a green check can't hide one. If every check is skipped, the run fails.

```ts
{
  name: "Fastlane config",
  async skip(ctx) {
    const wanted = (await Bun.file(`${ctx.worktree}/.ruby-version`).text()).trim();
    const { stdout } = await ctx.capture(["ruby", "-e", "print RUBY_VERSION"]);
    return stdout === wanted ? undefined : `Ruby ${wanted} isn't installed`;
  },
  async run(ctx) {
    await ctx.exec(["bundle", "install", "--quiet"]);
    await ctx.exec(["bundle", "exec", "fastlane", "lanes"]);
  },
}
```

### Setups and teardowns

`setup` is a list of functions that run before the first check. One can add to `ctx.env` for every command that follows, and can return a teardown, which runs after the last check, even if a check fails or the run is interrupted. Teardowns run in reverse order.

### The context

| | |
| --- | --- |
| `sha`, `worktree` | The commit, and the checkout of it where commands run. |
| `cacheDir` | Kept between runs, for build caches such as DerivedData. `--clean` empties it. |
| `stateDir` | Per-clone state in `.git/local-check/`. |
| `env` | Extra environment for every command. Setups can add to it. |
| `exec(command, { cwd, env })` | Runs a command with its output in the log, as it's written. Throws if it exits non-zero. |
| `capture(command, { cwd, env })` | Runs a command and returns `{ exitCode, stdout, stderr }`. It doesn't log or throw, and an interruption doesn't stop it, so teardowns can use it. |
| `$` | [Bun Shell](https://bun.com/docs/runtime/shell) in the worktree, with `env` applied. Its output isn't logged. |
| `log(message)` | Writes a line to the log. |
| `signal` | Aborted when the run is interrupted. Pass it to anything that waits. |

### The kit

- **`waitFor(condition, { timeout, interval, signal, description })`** calls `condition` until it returns something truthy, and returns that.
- **`xcode({ version, developerDir, simulator })`** returns helpers for Xcode projects:
  - `setup` selects Xcode through `DEVELOPER_DIR`, and creates the simulator. `version` finds `/Applications/Xcode_<version>.app`, the naming GitHub's runners use.
  - The simulator is created fresh for each run and deleted afterwards. It can have the same name as one you already have, which matters when tests check the device name, because it's always addressed by UDID.
  - `build(...)` and `buildForTesting(...)` take a workspace, a scheme, an optional test plan and extra flags, and build into DerivedData under `cacheDir`, so later runs build incrementally.
  - `testWithoutBuilding(...)` runs the newest `.xctestrun`. Parallel testing is off unless you turn it on, because its simulator clones are renamed "Clone 1 of …", which fails tests that check the device name. Diagnostics collection is off too, because after a failure `xcodebuild` can spend up to ten minutes collecting it.

### Keeping files between runs

Everything untracked is removed from the worktree before each run. To keep something, such as a build cache that a lint tool writes into the repo, list it in `worktree.keep`:

```ts
{ worktree: { keep: ["Vault/.build"] }, checks: [/* ... */] }
```

## Commands

| | |
| --- | --- |
| `local-check [--clean] [<commit>]` | Validates a commit, `HEAD` by default, and posts the result. `--clean` empties the cache first, worktree included. |
| `local-check post <commit>` | Posts a stored result, once GitHub has the commit. |
| `local-check hook pre-push` | Runs as git's pre-push hook. It never blocks a push. |
| `local-check install-hook` | Writes `.githooks/pre-push` if it's missing, and points `core.hooksPath` at it. |

## Where things are kept

- **The worktree and build caches** are in `~/Library/Caches/local-check/` on macOS, `~/.cache/local-check/` (or `$XDG_CACHE_HOME`) on Linux, and `%LOCALAPPDATA%\local-check` on Windows. There's one directory per clone. Set `LOCAL_CHECK_CACHE_DIR` to use somewhere else.
- **Results and logs** are in the clone's `.git/local-check/`: `results/<sha>.json`, `logs/<sha>.log`, and `logs/post.log` for posts made by the hook.

## What the check proves

The check is self-attested. It records that the commit passed on the machine that posted it, rather than on independent CI, and anyone with write access to the repo could post one without running anything. It suits repos where the people who can push are the people who validate.

## Developing

```sh
bun install
bun test
bun run typecheck
bun run validate   # local-check validates itself
```

`bun run validate` runs the local-check in your checkout against the commit being validated, using this repo's own `local-check.config.ts`.

To release, bump `version` in `package.json`, merge, and tag the merge commit `v<version>`. Repos pin a tag, and move to a new one when they're ready.

## Licence

BSD 3-Clause. See [LICENSE](./LICENSE).
