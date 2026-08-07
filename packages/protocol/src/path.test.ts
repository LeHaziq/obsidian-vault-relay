import { describe, expect, it } from "vitest";
import { assertNoCaseCollisions, conflictPath, normalizeVaultPath } from "./path.js";

describe("vault paths", () => {
  it("normalizes separators and Unicode", () => {
    expect(normalizeVaultPath("/folder\\note.md/")).toBe("folder/note.md");
  });

  it("rejects traversal", () => {
    expect(() => normalizeVaultPath("../secret")) .toThrow("Unsafe vault path");
  });

  it("detects case collisions", () => {
    expect(() => assertNoCaseCollisions(["Note.md", "note.md"])).toThrow("Case-colliding");
  });

  it("accepts raw and normalized spellings of one path", () => {
    expect(() => assertNoCaseCollisions(["/folder\\note.md", "folder/note.md"])).not.toThrow();
  });

  it("reports collisions with the raw vault spelling", () => {
    expect(() => assertNoCaseCollisions(["/folder\\Note.md", "folder/note.md"])).toThrow("/folder\\Note.md");
  });

  it("keeps the extension on conflict copies", () => {
    expect(conflictPath("folder/note.md", "abc-123")).toBe("folder/note.conflict-abc123.md");
  });
});
