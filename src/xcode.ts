import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Check, Context, Setup } from "./config.ts";

export interface SimulatorOptions {
  /**
   * The simulator's name. It can be the same as one you already have, which
   * matters when tests check the device name: the throwaway simulator is
   * always addressed by its UDID.
   */
  name: string;
  /** For example `com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max` (`xcrun simctl list devicetypes`). */
  deviceType: string;
  /** For example `com.apple.CoreSimulator.SimRuntime.iOS-27-0` (`xcrun simctl list runtimes`). */
  runtime: string;
}

export interface XcodeOptions {
  /** Selects `/Applications/Xcode_<version>.app`, the naming GitHub's runners use. */
  version?: string;
  /** A developer directory to use instead of the one `version` names. */
  developerDir?: string;
  /** A simulator created fresh for each run and deleted afterwards. */
  simulator?: SimulatorOptions;
}

export interface BuildOptions {
  name?: string;
  workspace: string;
  scheme: string;
  testPlan?: string;
  /** Defaults to the throwaway simulator. */
  destination?: string;
  /** Extra arguments, such as `-skipMacroValidation`. */
  flags?: string[];
}

export interface TestOptions {
  name?: string;
  /** Defaults to the throwaway simulator. */
  destination?: string;
  /**
   * Off unless set: parallel testing runs on clones named "Clone 1 of …",
   * which fails any test that checks the device name.
   */
  parallel?: boolean;
  /**
   * Off unless set: after a failure, xcodebuild can spend up to ten minutes
   * collecting diagnostics from the simulator.
   */
  collectDiagnostics?: boolean;
  flags?: string[];
}

export interface Xcode {
  /** Selects Xcode and creates the simulator. Put it in the config's `setup`. */
  readonly setup: Setup;
  /** `id=<udid>` for the throwaway simulator, once setup has run. */
  readonly destination: string;
  /** Where builds go. It's under the cache, so later runs build incrementally. */
  derivedData(ctx: Context): string;
  build(options: BuildOptions): Check;
  buildForTesting(options: BuildOptions): Check;
  testWithoutBuilding(options?: TestOptions): Check;
}

export function xcode(options: XcodeOptions): Xcode {
  const developerDir =
    options.developerDir ?? (options.version ? `/Applications/Xcode_${options.version}.app/Contents/Developer` : undefined);
  let udid: string | undefined;

  const destination = (explicit?: string): string => {
    if (explicit) {
      return explicit;
    }
    if (!udid) {
      throw new Error(
        options.simulator
          ? "The simulator isn't ready: add the xcode setup to the config's setup"
          : "No destination: pass one, or give xcode() a simulator",
      );
    }
    return `id=${udid}`;
  };
  const derivedData = (ctx: Context) => join(ctx.cacheDir, "DerivedData");
  const buildArguments = (ctx: Context, build: BuildOptions) => [
    "-workspace",
    build.workspace,
    "-scheme",
    build.scheme,
    ...(build.testPlan ? ["-testPlan", build.testPlan] : []),
    "-destination",
    destination(build.destination),
    "-derivedDataPath",
    derivedData(ctx),
    ...(build.flags ?? []),
  ];

  const setup: Setup = async (ctx) => {
    if (developerDir) {
      if (!existsSync(developerDir)) {
        throw new Error(`Xcode isn't installed at ${developerDir}`);
      }
      ctx.env.DEVELOPER_DIR = developerDir;
    }
    const simulator = options.simulator;
    if (!simulator) {
      return;
    }
    // Remembered so a run that was killed outright can't leave its simulator behind.
    const marker = join(ctx.stateDir, "simulator");
    const leftover = (await Bun.file(marker).exists()) ? (await Bun.file(marker).text()).trim() : "";
    if (leftover) {
      await deleteSimulator(ctx, leftover);
    }
    const created = await ctx.capture(["xcrun", "simctl", "create", simulator.name, simulator.deviceType, simulator.runtime]);
    const id = created.stdout.trim();
    if (created.exitCode !== 0 || !id) {
      throw new Error(`Couldn't create the ${simulator.name} simulator: ${created.stderr.trim()}`);
    }
    udid = id;
    await Bun.write(marker, id);
    ctx.log(`Created the ${simulator.name} simulator ${id}`);
    return async () => {
      udid = undefined;
      await deleteSimulator(ctx, id);
      await rm(marker, { force: true });
    };
  };

  return {
    setup,
    get destination() {
      return destination();
    },
    derivedData,
    build: (build) => ({
      name: build.name ?? "Build",
      run: (ctx) => ctx.exec(["xcodebuild", "build", ...buildArguments(ctx, build)]),
    }),
    buildForTesting: (build) => ({
      name: build.name ?? "Build tests",
      run: (ctx) => ctx.exec(["xcodebuild", "build-for-testing", ...buildArguments(ctx, build)]),
    }),
    testWithoutBuilding: (test = {}) => ({
      name: test.name ?? "Tests",
      async run(ctx) {
        const products = join(derivedData(ctx), "Build", "Products");
        const xctestrun = newestXctestrun(products);
        if (!xctestrun) {
          throw new Error(`No .xctestrun in ${products}: build for testing first`);
        }
        await ctx.exec([
          "xcodebuild",
          "test-without-building",
          "-xctestrun",
          xctestrun,
          "-destination",
          destination(test.destination),
          "-parallel-testing-enabled",
          test.parallel ? "YES" : "NO",
          ...(test.collectDiagnostics ? [] : ["-collect-test-diagnostics", "never"]),
          ...(test.flags ?? []),
        ]);
      },
    }),
  };
}

async function deleteSimulator(ctx: Context, id: string): Promise<void> {
  await ctx.capture(["xcrun", "simctl", "shutdown", id]);
  await ctx.capture(["xcrun", "simctl", "delete", id]);
  ctx.log(`Deleted the simulator ${id}`);
}

/** The newest, as a changed SDK leaves the previous build's .xctestrun beside it. */
function newestXctestrun(dir: string): string | undefined {
  if (!existsSync(dir)) {
    return undefined;
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".xctestrun"))
    .map((entry) => join(dir, entry))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
