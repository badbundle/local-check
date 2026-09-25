import { $ } from "bun";

export type StatusState = "pending" | "success" | "failure" | "error";

export interface Status {
  state: StatusState;
  context: string;
  description: string;
}

export interface GitHub {
  /** The `owner/name` statuses are posted to. */
  readonly repo: string;
  hasCommit(sha: string): Promise<boolean>;
  postStatus(sha: string, status: Status): Promise<void>;
}

/** GitHub for the repo at `cwd`, through the `gh` CLI, so it uses the developer's own login. */
export async function gitHubFor(cwd: string): Promise<GitHub> {
  const result = await $`gh repo view --json nameWithOwner --jq .nameWithOwner`.cwd(cwd).nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`Couldn't find this repo on GitHub with gh: ${result.stderr.toString().trim()}`);
  }
  return ghClient(result.stdout.toString().trim());
}

export function ghClient(repo: string): GitHub {
  return {
    repo,
    async hasCommit(sha) {
      const result = await $`gh api --silent ${`repos/${repo}/commits/${sha}`}`.nothrow().quiet();
      return result.exitCode === 0;
    },
    async postStatus(sha, { state, context, description }) {
      const fields = ["-f", `state=${state}`, "-f", `context=${context}`, "-f", `description=${description}`];
      const result = await $`gh api --silent -X POST ${`repos/${repo}/statuses/${sha}`} ${fields}`.nothrow().quiet();
      if (result.exitCode !== 0) {
        throw new Error(`Couldn't post the status to ${repo}@${sha}: ${result.stderr.toString().trim()}`);
      }
    },
  };
}
