/**
 * Minimal stand-in for the `obsidian` runtime module, which only exists inside
 * the app. Aliased in vitest.config.ts; never bundled (esbuild marks
 * `obsidian` external). Shapes mirror the real classes closely enough that
 * tests still typecheck against the published `obsidian` types.
 */

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "").trim();
}

export class TAbstractFile {
  path = "";
  name = "";
}

export class TFile extends TAbstractFile {
  extension = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export function requestUrl(): never {
  throw new Error("requestUrl is not available in tests");
}
