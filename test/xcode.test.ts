import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureResult, Command, Context } from "../src/config.ts";
import { xcode } from "../src/xcode.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

const simulator = {
  name: "iPhone 18 Pro Max",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
};

/** A context whose commands are recorded, and whose `simctl create` returns a UDID. */
interface FakeContext extends Context {
  captured: Command[];
  executed: Command[];
}

async function fakeContext(): Promise<FakeContext> {
  const captured: Command[] = [];
  const executed: Command[] = [];
  const cacheDir = await tempDir();
  return {
    sha: "d".repeat(40),
    worktree: join(cacheDir, "worktree"),
    cacheDir,
    stateDir: await tempDir(),
    env: {},
    signal: new AbortController().signal,
    captured,
    executed,
    async exec(command) {
      executed.push(command);
    },
    async capture(command): Promise<CaptureResult> {
      captured.push(command);
      const created = command[2] === "create";
      return { exitCode: 0, stdout: created ? `UDID-${captured.length}\n` : "", stderr: "" };
    },
    get $(): never {
      throw new Error("not used");
    },
    log() {},
  };
}

let ctx: FakeContext;

beforeEach(async () => {
  ctx = await fakeContext();
});

afterEach(removeTempDirs);

describe("setup", () => {
  test("selects Xcode through DEVELOPER_DIR", async () => {
    const developerDir = await tempDir();

    await xcode({ developerDir }).setup(ctx);

    expect(ctx.env.DEVELOPER_DIR).toBe(developerDir);
  });

  test("finds Xcode by version, as GitHub's runners name it", async () => {
    await expect(xcode({ version: "0.0-missing" }).setup(ctx)).rejects.toThrow(
      "Xcode isn't installed at /Applications/Xcode_0.0-missing.app/Contents/Developer",
    );
  });

  test("creates a throwaway simulator, and its teardown deletes it", async () => {
    const ios = xcode({ simulator });

    const teardown = await ios.setup(ctx);

    expect(ctx.captured).toEqual([["xcrun", "simctl", "create", simulator.name, simulator.deviceType, simulator.runtime]]);
    expect(ios.destination).toBe("id=UDID-1");
    expect(await Bun.file(join(ctx.stateDir, "simulator")).text()).toBe("UDID-1");

    await teardown?.();

    expect(ctx.captured.slice(1)).toEqual([
      ["xcrun", "simctl", "shutdown", "UDID-1"],
      ["xcrun", "simctl", "delete", "UDID-1"],
    ]);
    expect(await Bun.file(join(ctx.stateDir, "simulator")).exists()).toBe(false);
    expect(() => ios.destination).toThrow("The simulator isn't ready");
  });

  test("deletes a simulator left behind by a run that was killed", async () => {
    await Bun.write(join(ctx.stateDir, "simulator"), "LEFTOVER\n");

    await xcode({ simulator }).setup(ctx);

    expect(ctx.captured.slice(0, 2)).toEqual([
      ["xcrun", "simctl", "shutdown", "LEFTOVER"],
      ["xcrun", "simctl", "delete", "LEFTOVER"],
    ]);
  });
});

describe("checks", () => {
  test("build for testing with the plan, the simulator and the cache's DerivedData", async () => {
    const ios = xcode({ simulator });
    await ios.setup(ctx);
    const check = ios.buildForTesting({
      workspace: "Vault.xcworkspace",
      scheme: "CI_iOS",
      testPlan: "iOSAllTests",
      flags: ["-skipMacroValidation"],
    });

    expect(check.name).toBe("Build tests");
    await (check.run as (ctx: Context) => Promise<void>)(ctx);

    expect(ctx.executed).toEqual([
      [
        "xcodebuild",
        "build-for-testing",
        "-workspace",
        "Vault.xcworkspace",
        "-scheme",
        "CI_iOS",
        "-testPlan",
        "iOSAllTests",
        "-destination",
        "id=UDID-1",
        "-derivedDataPath",
        join(ctx.cacheDir, "DerivedData"),
        "-skipMacroValidation",
      ],
    ]);
  });

  test("build to an explicit destination without a simulator", async () => {
    const check = xcode({}).build({ workspace: "GPS.xcworkspace", scheme: "GPSApp", destination: "generic/platform=iOS Simulator" });

    await (check.run as (ctx: Context) => Promise<void>)(ctx);

    expect(ctx.executed[0]).toContain("generic/platform=iOS Simulator");
  });

  test("test the newest .xctestrun, one at a time and without collecting diagnostics", async () => {
    const ios = xcode({ simulator });
    await ios.setup(ctx);
    const products = join(ctx.cacheDir, "DerivedData", "Build", "Products");
    await mkdir(products, { recursive: true });
    await Bun.write(join(products, "Old_iphonesimulator26.0.xctestrun"), "");
    await Bun.write(join(products, "New_iphonesimulator27.0.xctestrun"), "");
    utimesSync(join(products, "Old_iphonesimulator26.0.xctestrun"), new Date(1_000), new Date(1_000));

    await (ios.testWithoutBuilding().run as (ctx: Context) => Promise<void>)(ctx);

    expect(ctx.executed).toEqual([
      [
        "xcodebuild",
        "test-without-building",
        "-xctestrun",
        join(products, "New_iphonesimulator27.0.xctestrun"),
        "-destination",
        "id=UDID-1",
        "-parallel-testing-enabled",
        "NO",
        "-collect-test-diagnostics",
        "never",
      ],
    ]);
  });

  test("testing fails clearly before anything was built", async () => {
    const ios = xcode({ simulator });
    await ios.setup(ctx);

    await expect((ios.testWithoutBuilding().run as (ctx: Context) => Promise<void>)(ctx)).rejects.toThrow(
      "No .xctestrun",
    );
  });
});
