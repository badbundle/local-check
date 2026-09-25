import type { Config } from "./src/index.ts";

// local-check validates itself: the copy running is the one in your checkout,
// and these checks run against the commit being validated.
export default {
  worktree: { keep: ["node_modules"] },
  checks: [
    { name: "Install", run: ["bun", "install", "--frozen-lockfile"] },
    { name: "Typecheck", run: ["bun", "run", "typecheck"] },
    { name: "Tests", run: ["bun", "test"] },
  ],
} satisfies Config;
