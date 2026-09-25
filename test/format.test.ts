import { describe, expect, test } from "bun:test";
import { describeFailure, describeSuccess, formatDuration, MAX_DESCRIPTION, truncate } from "../src/format.ts";

describe("formatDuration", () => {
  test.each([
    [0, "0s"],
    [59_400, "59s"],
    [60_000, "1m0s"],
    [207_000, "3m27s"],
    [3_720_000, "1h2m"],
  ])("%pms reads as %p", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("descriptions", () => {
  test("name the checks that passed and how long they took", () => {
    expect(describeSuccess(["Lint", "Build", "Tests"], [], 207_000)).toBe("Lint, Build, Tests passed in 3m27s");
  });

  test("name the checks that were skipped", () => {
    expect(describeSuccess(["Lint"], ["Fastlane config"], 6_000)).toBe("Lint passed in 6s (skipped: Fastlane config)");
  });

  test("name the check that failed", () => {
    expect(describeFailure("Tests")).toBe("Tests failed");
  });

  test("fit GitHub's limit", () => {
    const description = describeSuccess(Array.from({ length: 30 }, (_, index) => `Check ${index}`), [], 1_000);
    expect(description).toHaveLength(MAX_DESCRIPTION);
    expect(description).toEndWith("…");
  });

  test("that are short enough are left alone", () => {
    expect(truncate("short")).toBe("short");
  });
});
