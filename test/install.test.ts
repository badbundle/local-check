import { $ } from "bun";
import { afterEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { openRepo } from "../src/git.ts";
import { HOOK_SHIM, installHook } from "../src/install.ts";
import { createRepo, output, removeTempDirs, writeFiles } from "./helpers.ts";

afterEach(removeTempDirs);

async function hooksPath(dir: string): Promise<string> {
  return (await $`git config --get core.hooksPath`.cwd(dir).nothrow().text()).trim();
}

test("writes an executable pre-push hook and points core.hooksPath at it", async () => {
  const { dir } = await createRepo({ "README.md": "hello\n" });
  const out = output();

  await installHook(await openRepo(dir), out.write);

  const hook = join(dir, ".githooks", "pre-push");
  expect(await Bun.file(hook).text()).toBe(HOOK_SHIM);
  expect(statSync(hook).mode & 0o111).not.toBe(0);
  expect(await hooksPath(dir)).toBe(".githooks");
  expect(out.text).toContain("commit it");
});

test("keeps a hook the repo already has", async () => {
  const { dir } = await createRepo({ ".githooks/pre-push": "#!/bin/sh\necho custom\n" });

  await installHook(await openRepo(dir), output().write);

  expect(await Bun.file(join(dir, ".githooks", "pre-push")).text()).toBe("#!/bin/sh\necho custom\n");
});

test("leaves a different core.hooksPath alone, and says so", async () => {
  const { dir } = await createRepo({ "README.md": "hello\n" });
  await $`git config core.hooksPath .husky`.cwd(dir).quiet();
  const out = output();

  await installHook(await openRepo(dir), out.write);

  expect(await hooksPath(dir)).toBe(".husky");
  expect(out.text).toContain("core.hooksPath is already .husky");
});

test("the hook doesn't block a push when local-check isn't installed", async () => {
  const { dir } = await createRepo({ "README.md": "hello\n" });
  await writeFiles(dir, { ".githooks/pre-push": HOOK_SHIM });

  const result = await $`sh .githooks/pre-push`.cwd(dir).nothrow().quiet();

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toContain("local-check isn't installed");
});
