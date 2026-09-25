import { afterEach, beforeEach, expect, test } from "bun:test";
import { postStoredResult } from "../src/post.ts";
import { ResultStore } from "../src/results.ts";
import { FakeGitHub, removeTempDirs, tempDir } from "./helpers.ts";

const sha = "c".repeat(40);
let store: ResultStore;
let github: FakeGitHub;
let sleeps: number[];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

beforeEach(async () => {
  store = new ResultStore(await tempDir());
  github = new FakeGitHub();
  sleeps = [];
});

afterEach(removeTempDirs);

async function storeFailure() {
  await store.write({
    sha,
    context: "Validate (local)",
    state: "failure",
    description: "Tests failed",
    finishedAt: new Date(0).toISOString(),
    durationMs: 5000,
    checks: [],
  });
}

test("posts the stored result once GitHub has the commit", async () => {
  await storeFailure();
  github.appearsAfter.set(sha, 2);

  expect(await postStoredResult({ sha, store, github, sleep })).toBe("posted");

  expect(sleeps).toEqual([2000, 2000]);
  expect(github.posted).toEqual([{ sha, state: "failure", context: "Validate (local)", description: "Tests failed" }]);
});

test("does nothing for a commit that wasn't validated", async () => {
  github.push(sha);

  expect(await postStoredResult({ sha, store, github, sleep })).toBe("no-result");

  expect(github.posted).toEqual([]);
});

test("gives up if GitHub never gets the commit", async () => {
  await storeFailure();

  expect(await postStoredResult({ sha, store, github, sleep, attempts: 3 })).toBe("gave-up");

  expect(sleeps).toHaveLength(2);
  expect(github.posted).toEqual([]);
});
