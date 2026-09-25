/** GitHub's limit on a commit status description. */
export const MAX_DESCRIPTION = 140;

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function truncate(text: string, max = MAX_DESCRIPTION): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function describeSuccess(passed: string[], skipped: string[], ms: number): string {
  const summary = `${passed.join(", ")} passed in ${formatDuration(ms)}`;
  return truncate(skipped.length > 0 ? `${summary} (skipped: ${skipped.join(", ")})` : summary);
}

export function describeFailure(name: string): string {
  return truncate(`${name} failed`);
}
