const FORBIDDEN_SEGMENTS = new Set(["", ".", ".."]);

export function normalizeVaultPath(input: string): string {
  const normalized = input.replaceAll("\\", "/").normalize("NFC").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => FORBIDDEN_SEGMENTS.has(part) || part.includes("\0"))) {
    throw new Error(`Unsafe vault path: ${input}`);
  }
  return parts.join("/");
}

export function conflictPath(path: string, operationId: string): string {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf(".");
  const suffix = operationId.replace(/[^a-zA-Z0-9]/g, "").slice(-32);
  if (dot <= 0) return `${directory}${filename}.conflict-${suffix}`;
  return `${directory}${filename.slice(0, dot)}.conflict-${suffix}${filename.slice(dot)}`;
}

// The check normalizes the two sides before it compares them. Thus callers can
// give raw paths. Only a difference in letter case is a collision. The error
// message keeps the raw paths, because these are the names in the vault.
export function assertNoCaseCollisions(paths: string[]): void {
  const seen = new Map<string, { normalized: string; raw: string }>();
  for (const path of paths) {
    const normalized = normalizeVaultPath(path);
    const key = normalized.toLocaleLowerCase("en-US");
    const previous = seen.get(key);
    if (previous && previous.normalized !== normalized) throw new Error(`Case-colliding paths: ${previous.raw} and ${path}`);
    seen.set(key, { normalized, raw: path });
  }
}
