import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { kit } from "../src/kit.ts";
import { configFile, removeTempDirs, tempDir, writeFiles } from "./helpers.ts";

afterEach(removeTempDirs);

async function load(source: string) {
  const dir = await tempDir();
  await writeFiles(dir, configFile(source));
  return loadConfig(dir, kit);
}

describe("loadConfig", () => {
  test("accepts a config object", async () => {
    expect((await load(`{ checks: [{ name: "Lint", run: ["true"] }] }`)).checks[0]?.name).toBe("Lint");
  });

  test("calls a config function with the kit", async () => {
    const config = await load(`(kit) => ({ checks: [{ name: typeof kit.xcode + " " + typeof kit.waitFor, run: ["true"] }] })`);
    expect(config.checks[0]?.name).toBe("function function");
  });

  test("awaits an async config function", async () => {
    expect((await load(`async () => ({ checks: [{ name: "Later", run: ["true"] }] })`)).checks[0]?.name).toBe("Later");
  });

  test.each([
    [`{ checks: [] }`, "has no checks"],
    [`{ checks: [{ run: ["true"] }] }`, "Check 1 in local-check.config.ts needs a name and a command or run function"],
    [`{ checks: [{ name: "Lint", run: [] }] }`, "needs a name and a command or run function"],
    [`{ checks: [{ name: "Lint", run: ["true"] }], setup: ["nope"] }`, "setup in local-check.config.ts must be a list of functions"],
    [`42`, "must export a config object"],
    [`(() => { throw new Error("boom"); })()`, "failed to load: boom"],
  ])("rejects %s", async (source, error) => {
    await expect(load(source)).rejects.toThrow(error);
  });
});
