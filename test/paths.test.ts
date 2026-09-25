import { expect, test } from "bun:test";
import { cacheRoot, repoCacheDir, stateDir } from "../src/paths.ts";

test("the cache lives in each platform's usual place", () => {
  expect(cacheRoot({}, "darwin", "/Users/me")).toBe("/Users/me/Library/Caches/local-check");
  expect(cacheRoot({}, "linux", "/home/me")).toBe("/home/me/.cache/local-check");
  expect(cacheRoot({ XDG_CACHE_HOME: "/cache" }, "linux", "/home/me")).toBe("/cache/local-check");
  expect(cacheRoot({ LOCALAPPDATA: "C:/Users/me/AppData/Local" }, "win32", "C:/Users/me")).toBe(
    "C:/Users/me/AppData/Local/local-check",
  );
});

test("LOCAL_CHECK_CACHE_DIR overrides the cache location", () => {
  expect(cacheRoot({ LOCAL_CHECK_CACHE_DIR: "/tmp/cache" }, "darwin", "/Users/me")).toBe("/tmp/cache");
});

test("two clones of a repo never share a cache", () => {
  const one = repoCacheDir({ root: "/a/vault-app", commonDir: "/a/vault-app/.git", name: "vault-app" }, "/cache");
  const two = repoCacheDir({ root: "/b/vault-app", commonDir: "/b/vault-app/.git", name: "vault-app" }, "/cache");
  expect(one).toStartWith("/cache/vault-app-");
  expect(one).not.toBe(two);
});

test("state lives in the clone's git directory", () => {
  expect(stateDir({ root: "/a/repo", commonDir: "/a/repo/.git", name: "repo" })).toBe("/a/repo/.git/local-check");
});
