// Configs import these as types only (`import type`), which Bun erases, so a
// config loads from a checkout without node_modules. At runtime, the helpers
// come from the `kit` a config function is given.
export type {
  CaptureResult,
  Check,
  Command,
  Config,
  ConfigExport,
  ConfigFunction,
  Context,
  ExecOptions,
  Kit,
  Setup,
  Teardown,
} from "./config.ts";
export type { WaitOptions } from "./wait.ts";
export type { BuildOptions, SimulatorOptions, TestOptions, Xcode, XcodeOptions } from "./xcode.ts";
export type { CheckResult, RunResult } from "./results.ts";

export { CONFIG_FILE, DEFAULT_CONTEXT } from "./config.ts";
export { waitFor } from "./wait.ts";
export { xcode } from "./xcode.ts";
