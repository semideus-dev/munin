function lastPathPart(path: string): string | undefined {
  const trimmed = path.trim().replace(/[/\\]+$/, "");
  if (trimmed.length === 0) {
    return undefined;
  }
  const parts = trimmed.split(/[\\/]+/);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : undefined;
}

export function projectLabel(worktree: string | null | undefined, directory: string | null | undefined): string {
  return lastPathPart(worktree ?? "") ?? lastPathPart(directory ?? "") ?? "unknown";
}
