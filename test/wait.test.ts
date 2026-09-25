import { expect, test } from "bun:test";
import { waitFor } from "../src/wait.ts";

test("returns the first truthy value", async () => {
  let attempts = 0;
  expect(await waitFor(() => (++attempts === 3 ? "ready" : undefined), { interval: 1 })).toBe("ready");
  expect(attempts).toBe(3);
});

test("waits for async conditions", async () => {
  expect(await waitFor(async () => 42, { interval: 1 })).toBe(42);
});

test("times out, naming what it waited for", async () => {
  await expect(waitFor(() => false, { timeout: 20, interval: 5, description: "the server" })).rejects.toThrow(
    "Timed out after 20ms waiting for the server",
  );
});

test("stops when its signal is aborted", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("Interrupted")), 10);
  await expect(waitFor(() => false, { timeout: 10_000, interval: 5, signal: controller.signal })).rejects.toThrow(
    "Interrupted",
  );
});
