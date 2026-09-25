import { $ } from "bun";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { GitHub, Status } from "../src/github.ts";

const created: string[] = [];

export async function tempDir(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "local-check-test-")));
  created.push(dir);
  return dir;
}

export async function removeTempDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** A new git repo with one commit of `files`. */
export async function createRepo(files: Record<string, string>): Promise<{ dir: string; sha: string }> {
  const dir = await tempDir();
  await $`git init --quiet --initial-branch main`.cwd(dir).quiet();
  await $`git config user.name Test`.cwd(dir).quiet();
  await $`git config user.email test@example.com`.cwd(dir).quiet();
  await $`git config commit.gpgsign false`.cwd(dir).quiet();
  return { dir, sha: await commit(dir, files, "first commit") };
}

export async function commit(dir: string, files: Record<string, string>, subject: string): Promise<string> {
  await writeFiles(dir, files);
  await $`git add --all`.cwd(dir).quiet();
  await $`git commit --quiet -m ${subject}`.cwd(dir).quiet();
  return (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await Bun.write(join(dir, path), contents);
  }
}

/** A config file whose default export is `source`. */
export function configFile(source: string): Record<string, string> {
  return { "local-check.config.ts": `export default ${source};\n` };
}

export class FakeGitHub implements GitHub {
  readonly repo = "badbundle/example";
  readonly posted: Array<Status & { sha: string }> = [];
  private readonly known = new Set<string>();
  /** Commits that appear on GitHub only after this many lookups. */
  appearsAfter = new Map<string, number>();

  push(sha: string): void {
    this.known.add(sha);
  }

  async hasCommit(sha: string): Promise<boolean> {
    const remaining = this.appearsAfter.get(sha);
    if (remaining !== undefined) {
      if (remaining <= 0) {
        this.known.add(sha);
      }
      this.appearsAfter.set(sha, remaining - 1);
    }
    return this.known.has(sha);
  }

  async postStatus(sha: string, status: Status): Promise<void> {
    this.posted.push({ sha, ...status });
  }

  states(): string[] {
    return this.posted.map((status) => status.state);
  }
}

/** Collects everything written, as the terminal would show it. */
export function output(): { write: (text: string) => void; readonly text: string } {
  let text = "";
  return {
    write: (chunk) => {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}
