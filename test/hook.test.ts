import { afterEach, expect, test } from "bun:test";
import { branchPushes, handlePrePush, parsePrePushInput } from "../src/hook.ts";
import { ResultStore } from "../src/results.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

afterEach(removeTempDirs);

const validated = "a".repeat(40);
const unvalidated = "b".repeat(40);
const zero = "0".repeat(40);

test("parses git's pre-push input, ignoring blank lines", () => {
  expect(parsePrePushInput(`refs/heads/feat ${validated} refs/heads/feat ${zero}\n\n`)).toEqual([
    { localRef: "refs/heads/feat", localSha: validated, remoteRef: "refs/heads/feat", remoteSha: zero },
  ]);
});

test("only branch pushes get statuses: not tags, and not deleted branches", () => {
  const updates = parsePrePushInput(
    [
      `refs/heads/feat ${validated} refs/heads/feat ${zero}`,
      `refs/tags/v1 ${validated} refs/tags/v1 ${zero}`,
      `(delete) ${zero} refs/heads/old ${unvalidated}`,
    ].join("\n"),
  );
  expect(branchPushes(updates).map((update) => update.remoteRef)).toEqual(["refs/heads/feat"]);
});

test("schedules a post for validated commits and warns about the rest", async () => {
  const store = new ResultStore(await tempDir());
  await store.write({
    sha: validated,
    context: "Validate (local)",
    state: "success",
    description: "Lint passed in 1s",
    finishedAt: new Date(0).toISOString(),
    durationMs: 1000,
    checks: [],
  });
  const scheduled: string[] = [];
  let warnings = "";

  await handlePrePush({
    input: `refs/heads/a ${validated} refs/heads/a ${zero}\nrefs/heads/b ${unvalidated} refs/heads/b ${zero}\n`,
    store,
    schedulePost: (sha) => scheduled.push(sha),
    warn: (text) => {
      warnings += text;
    },
  });

  expect(scheduled).toEqual([validated]);
  expect(warnings).toBe("local-check: bbbbbbbb (b) hasn't been validated, so it won't get the green check.\n");
});
