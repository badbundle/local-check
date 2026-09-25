import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openRepo } from "../src/git.ts";
import { ResultStore } from "../src/results.ts";
import { type RunOptions, runChecks } from "../src/run.ts";
import { commit, configFile, createRepo, FakeGitHub, output, removeTempDirs, tempDir, writeFiles } from "./helpers.ts";

type Globals = { calls: string[]; interrupt?: () => void };
const globals = globalThis as unknown as Globals;

let github: FakeGitHub;
let out: ReturnType<typeof output>;
let cacheDir: string;

beforeEach(async () => {
  github = new FakeGitHub();
  out = output();
  cacheDir = await tempDir();
  globals.calls = [];
});

afterEach(removeTempDirs);

async function validate(dir: string, options: Partial<RunOptions> = {}) {
  return runChecks({ repo: await openRepo(dir), github, cacheDir, write: out.write, ...options });
}

function logOf(dir: string, sha: string): Promise<string> {
  return Bun.file(join(dir, ".git", "local-check", "logs", `${sha}.log`)).text();
}

function storeOf(dir: string): ResultStore {
  return new ResultStore(join(dir, ".git", "local-check", "results"));
}

const passing = `{ checks: [
  { name: "Lint", run: ["sh", "-c", "echo linted"] },
  { name: "Tests", run: ["sh", "-c", "echo tested"] },
] }`;

describe("posting", () => {
  test("posts pending, then success, when GitHub has the commit", async () => {
    const { dir, sha } = await createRepo(configFile(passing));
    github.push(sha);

    const outcome = await validate(dir);

    expect(outcome.exitCode).toBe(0);
    expect(github.states()).toEqual(["pending", "success"]);
    expect(github.posted[1]).toMatchObject({ sha, context: "Validate (local)", description: "Lint, Tests passed in 0s" });
    expect(out.text).toContain('Posted "Validate (local): success"');
    expect(await storeOf(dir).read(sha)).toMatchObject({ state: "success", context: "Validate (local)" });
  });

  test("stores the result for the pre-push hook when GitHub doesn't have the commit", async () => {
    const { dir, sha } = await createRepo(configFile(passing));

    const outcome = await validate(dir);

    expect(outcome.exitCode).toBe(0);
    expect(github.posted).toEqual([]);
    expect(out.text).toContain("the pre-push hook will post the result");
    expect(await storeOf(dir).read(sha)).toMatchObject({ state: "success" });
  });

  test("posts the result if the commit reaches GitHub while the checks run", async () => {
    const { dir, sha } = await createRepo(configFile(passing));
    github.appearsAfter.set(sha, 1);

    await validate(dir);

    expect(github.states()).toEqual(["success"]);
  });

  test("posts under the config's own context", async () => {
    const { dir, sha } = await createRepo(configFile(`{ context: "Checks", checks: [{ name: "Lint", run: ["true"] }] }`));
    github.push(sha);

    await validate(dir);

    expect(github.posted.map((status) => status.context)).toEqual(["Checks", "Checks"]);
  });
});

describe("checks", () => {
  test("stop at the first failure, whose log tail is shown", async () => {
    const { dir, sha } = await createRepo(
      configFile(`{ checks: [
        { name: "Lint", run: ["true"] },
        { name: "Tests", run: ["sh", "-c", "echo 'test_parse failed' >&2; exit 3"] },
        { name: "Never", run: () => { globalThis.calls.push("never"); } },
      ] }`),
    );
    github.push(sha);

    const outcome = await validate(dir);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.result).toMatchObject({ state: "failure", description: "Tests failed" });
    expect(outcome.result?.checks.map((check) => check.outcome)).toEqual(["passed", "failed"]);
    expect(globals.calls).toEqual([]);
    expect(github.states()).toEqual(["pending", "failure"]);
    expect(out.text).toContain("Tests... FAILED");
    expect(out.text).toContain("test_parse failed");
    expect(out.text).toContain(`Full log: ${join(dir, ".git", "local-check", "logs", `${sha}.log`)}`);
  });

  test("log what they run, stdout and stderr together", async () => {
    const { dir, sha } = await createRepo(configFile(`{ checks: [{ name: "Both", run: ["sh", "-c", "echo out; echo err >&2"] }] }`));

    await validate(dir);

    expect(await logOf(dir, sha)).toContain("=== Both\n$ sh -c echo out; echo err >&2\nout\nerr\n");
  });

  test("that are skipped are named in the description", async () => {
    const { dir } = await createRepo(
      configFile(`{ checks: [
        { name: "Lint", run: ["true"] },
        { name: "Fastlane", skip: () => "Ruby 4.0.5 isn't installed", run: ["false"] },
      ] }`),
    );

    const outcome = await validate(dir);

    expect(outcome.result?.description).toBe("Lint passed in 0s (skipped: Fastlane)");
    expect(outcome.result?.checks[1]).toMatchObject({ outcome: "skipped", reason: "Ruby 4.0.5 isn't installed" });
    expect(out.text).toContain("Fastlane... skipped (Ruby 4.0.5 isn't installed)");
  });

  test("fail the run when every one is skipped, so nothing passes by default", async () => {
    const { dir } = await createRepo(configFile(`{ checks: [{ name: "Lint", skip: () => "no", run: ["true"] }] }`));

    const outcome = await validate(dir);

    expect(outcome.result).toMatchObject({ state: "failure", description: "Every check was skipped" });
  });

  test("can wait for something and read command output", async () => {
    const { dir } = await createRepo(
      configFile(`({ waitFor }) => ({ checks: [{
        name: "Server",
        async run(ctx) {
          let attempts = 0;
          await waitFor(() => ++attempts === 3, { interval: 1, signal: ctx.signal });
          const { stdout } = await ctx.capture(["sh", "-c", "echo ready"]);
          if (stdout.trim() !== "ready") throw new Error("not ready");
          globalThis.calls.push(\`ready after \${attempts}\`);
        },
      }] })`),
    );

    const outcome = await validate(dir);

    expect(outcome.result?.state).toBe("success");
    expect(globals.calls).toEqual(["ready after 3"]);
  });
});

describe("the commit", () => {
  test("is validated, not uncommitted changes", async () => {
    const { dir } = await createRepo({
      "value.txt": "committed\n",
      ...configFile(`{ checks: [{ name: "Value", run: ["grep", "-q", "committed", "value.txt"] }] }`),
    });
    await writeFiles(dir, { "value.txt": "uncommitted\n" });

    const outcome = await validate(dir);

    expect(outcome.result?.state).toBe("success");
    expect(out.text).toContain("Note: you have uncommitted changes.");
  });

  test("supplies its own config", async () => {
    const { dir, sha: first } = await createRepo(configFile(`{ checks: [{ name: "Old", run: ["true"] }] }`));
    await commit(dir, configFile(`{ checks: [{ name: "New", run: ["true"] }] }`), "second commit");

    const older = await validate(dir, { rev: first });
    const newer = await validate(dir);

    expect(older.result?.description).toStartWith("Old passed");
    expect(newer.result?.description).toStartWith("New passed");
  });

  test("config can import its own files, and leaves no copy behind", async () => {
    const { dir } = await createRepo({
      "checks/lint.ts": `export const lint = { name: "Lint", run: ["true"] };\n`,
      "local-check.config.ts": `import { lint } from "./checks/lint.ts";\nexport default { checks: [lint] };\n`,
    });

    const outcome = await validate(dir);

    expect(outcome.result?.description).toStartWith("Lint passed");
    const untracked = await Array.fromAsync(new Bun.Glob(".local-check.config.ts.*").scan({ cwd: join(cacheDir, "worktree"), dot: true }));
    expect(untracked).toEqual([]);
  });

  test("fails clearly without a config", async () => {
    const { dir, sha } = await createRepo({ "README.md": "hello\n" });
    github.push(sha);

    const outcome = await validate(dir);

    expect(outcome.result).toMatchObject({ state: "failure", description: "No local-check.config.ts in this commit" });
    expect(github.states()).toEqual(["failure"]);
  });
});

describe("setup", () => {
  test("sets environment for every command, and teardowns run in reverse after a failure", async () => {
    const { dir } = await createRepo(
      configFile(`{
        setup: [
          (ctx) => { ctx.env.GREETING = "hello"; return () => { globalThis.calls.push("teardown one"); }; },
          () => () => { globalThis.calls.push("teardown two"); },
        ],
        checks: [
          { name: "Env", run: ["sh", "-c", 'test "$GREETING" = hello'] },
          { name: "Broken", run: ["false"] },
        ],
      }`),
    );

    const outcome = await validate(dir);

    expect(outcome.result?.checks.map((check) => check.outcome)).toEqual(["passed", "failed"]);
    expect(globals.calls).toEqual(["teardown two", "teardown one"]);
  });

  test("that fails stops the run before any check", async () => {
    const { dir } = await createRepo(
      configFile(`{
        setup: [() => { throw new Error("Xcode isn't installed"); }],
        checks: [{ name: "Lint", run: () => { globalThis.calls.push("lint"); } }],
      }`),
    );

    const outcome = await validate(dir);

    expect(outcome.result).toMatchObject({ state: "failure", description: "Setup failed: Xcode isn't installed" });
    expect(globals.calls).toEqual([]);
  });
});

describe("the worktree", () => {
  // Reports which files survived from the last run, then leaves new ones.
  const cacheCheck = configFile(`{
    worktree: { keep: ["kept"] },
    checks: [{
      name: "Cache",
      run: ["sh", "-c", 'for d in kept dropped; do [ -e "$d/file" ] && echo "$d survived"; done; mkdir -p kept dropped; touch kept/file dropped/file'],
    }],
  }`);

  test("keeps the paths in worktree.keep between runs, and removes other untracked files", async () => {
    const { dir, sha } = await createRepo(cacheCheck);

    await validate(dir);
    await validate(dir);

    const log = await logOf(dir, sha);
    expect(log).toContain("kept survived");
    expect(log).not.toContain("dropped survived");
  });

  test("is emptied by --clean", async () => {
    const { dir, sha } = await createRepo(cacheCheck);

    await validate(dir);
    await validate(dir, { clean: true });

    expect(await logOf(dir, sha)).not.toContain("kept survived");
  });
});

describe("interrupting", () => {
  test("posts error, stores nothing, and still runs teardowns", async () => {
    const { dir, sha } = await createRepo(
      configFile(`{
        setup: [() => () => { globalThis.calls.push("teardown"); }],
        checks: [{ name: "Slow", async run(ctx) { globalThis.interrupt(); await ctx.exec(["sleep", "10"]); } }],
      }`),
    );
    github.push(sha);
    const controller = new AbortController();
    globals.interrupt = () => controller.abort();

    const started = Date.now();
    const outcome = await validate(dir, { signal: controller.signal });

    expect(Date.now() - started).toBeLessThan(5000);
    expect(outcome).toEqual({ exitCode: 130 });
    expect(github.states()).toEqual(["pending", "error"]);
    expect(globals.calls).toEqual(["teardown"]);
    expect(await storeOf(dir).read(sha)).toBeUndefined();
  });
});
