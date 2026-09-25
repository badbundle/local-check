# Project Guidelines

## Read first

[`README.md`](./README.md) describes what local-check does and the config API that other repos depend on. That API is a contract: a change to it has to be released as a new version, and every repo that uses it has to move to that version deliberately.

## Code

- TypeScript run directly by Bun. There's no build step.
- No runtime dependencies. Bun, Node's built-ins, `git` and `gh` are all there is.
- Use Bun Shell for git and `gh`. Run the commands a check logs through `Bun.spawn`, which streams their output to the log.
- Configs import only types from this package. Never make the config API depend on a runtime import, because configs are loaded from a checkout with no `node_modules`.
- Keep logic testable: GitHub, the command runner and the clock can all be replaced in tests.

## Testing

Run `bun test` and `bun run typecheck` before every commit. Tests use real git repos in temporary directories, and fakes for GitHub.

## Validating a pull request

`main` only accepts a PR whose latest commit has the **Validate (local)** status check. Commit first, then run `bun run validate`, which uses this repo's own local-check to post it. Run it again after every new commit on a PR branch. Never post, edit or fake the status by hand, and don't work around a failing test to get a green check. Tell the user whether it passed, and if it didn't, which check failed and where its log is.

## Committing

Subjects are lowercase, describe the outcome rather than the mechanism, and use a conventional prefix (`feat:`, `fix:`, `refactor:`, `build:`, `docs:`, `test:`). Bodies are prose: the why, and the alternatives rejected. British spelling throughout.

## Releasing

Bump `version` in `package.json` in the PR, then tag the merge commit `v<version>` and push the tag. Repos pin a tag in their `package.json`.
