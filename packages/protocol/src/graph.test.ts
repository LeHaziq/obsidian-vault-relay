import { describe, expect, it } from "vitest";
import { headsForPath, headsForVersions, versionsByPath, type VersionNode } from "./graph.js";
import type { SyncOperation } from "./types.js";

function node(id: string, parents: string[], createdAt = "2026-01-01T00:00:00.000Z"): VersionNode {
  const operation: SyncOperation = {
    protocolVersion: 1,
    id,
    deviceId: "device",
    sequence: 1,
    createdAt,
    changes: [{ kind: "delete", path: "note.md", parents }],
  };
  return { operation, mutation: operation.changes[0]! };
}

function graph(entries: Array<[string, string[]]>): Map<string, VersionNode> {
  return new Map(entries.map(([id, parents]) => [id, node(id, parents)]));
}

/** One operation whose creation time follows its sequence, so ordering is deterministic. */
function operation(id: string, sequence: number, changes: SyncOperation["changes"]): SyncOperation {
  return {
    protocolVersion: 1,
    id,
    deviceId: "d",
    sequence,
    createdAt: `2026-01-${String(sequence).padStart(2, "0")}T00:00:00.000Z`,
    changes,
  };
}

describe("headsForVersions", () => {
  it("returns the single head of a linear history", () => {
    const heads = headsForVersions(graph([["a", []], ["b", ["a"]], ["c", ["b"]]]));
    expect(heads.map((head) => head.operation.id)).toEqual(["c"]);
  });

  it("returns every concurrent head, ordered deterministically", () => {
    const versions = new Map([
      ["base", node("base", [], "2026-01-01T00:00:00.000Z")],
      ["left", node("left", ["base"], "2026-01-02T00:00:00.000Z")],
      ["right", node("right", ["base"], "2026-01-03T00:00:00.000Z")],
    ]);
    expect(headsForVersions(versions).map((head) => head.operation.id)).toEqual(["left", "right"]);
  });

  it("breaks timestamp ties on operation id", () => {
    const heads = headsForVersions(graph([["b", []], ["a", []]]));
    expect(heads.map((head) => head.operation.id)).toEqual(["a", "b"]);
  });

  it("ignores parents that are no longer retained", () => {
    // Compaction can drop an ancestor; its child must still be the head.
    const heads = headsForVersions(graph([["child", ["evicted-ancestor"]]]));
    expect(heads.map((head) => head.operation.id)).toEqual(["child"]);
  });

  it("accepts a diamond without reporting a cycle", () => {
    const heads = headsForVersions(graph([["a", []], ["b", ["a"]], ["c", ["a"]], ["d", ["b", "c"]]]));
    expect(heads.map((head) => head.operation.id)).toEqual(["d"]);
  });

  it("detects a direct and an indirect cycle", () => {
    expect(() => headsForVersions(graph([["a", ["b"]], ["b", ["a"]]]))).toThrow("cycle");
    expect(() => headsForVersions(graph([["a", ["c"]], ["b", ["a"]], ["c", ["b"]]]))).toThrow("cycle");
  });

  it("walks a very long chain without exhausting the stack", () => {
    // Recursive traversal overflowed here; a first sync against a long remote
    // history retains the full chain before compaction runs.
    const entries: Array<[string, string[]]> = [["v0", []]];
    for (let index = 1; index < 20_000; index += 1) entries.push([`v${index}`, [`v${index - 1}`]]);
    const heads = headsForVersions(graph(entries));
    expect(heads.map((head) => head.operation.id)).toEqual(["v19999"]);
  });

  it("returns nothing for an empty version set", () => {
    expect(headsForVersions(new Map())).toEqual([]);
  });
});

describe("versionsByPath", () => {
  it("groups mutations by path across operations", () => {
    const first = operation("op1", 1, [
      { kind: "delete", path: "a.md", parents: [] },
      { kind: "delete", path: "b.md", parents: [] },
    ]);
    const second = operation("op2", 2, [{ kind: "delete", path: "a.md", parents: ["op1"] }]);
    const byPath = versionsByPath({ op1: first, op2: second });
    expect([...byPath.keys()].sort()).toEqual(["a.md", "b.md"]);
    expect([...byPath.get("a.md")!.keys()]).toEqual(["op1", "op2"]);
    expect([...byPath.get("b.md")!.keys()]).toEqual(["op1"]);
  });
});

describe("headsForPath", () => {
  const first = operation("op1", 1, [{ kind: "delete", path: "a.md", parents: [] }]);
  const second = operation("op2", 2, [{ kind: "delete", path: "a.md", parents: ["op1"] }]);

  it("returns the heads of the given path", () => {
    const byPath = versionsByPath({ op1: first, op2: second });
    expect(headsForPath(byPath, "a.md").map((head) => head.operation.id)).toEqual(["op2"]);
  });

  it("returns no heads for a path with no recorded versions", () => {
    const byPath = versionsByPath({ op1: first });
    expect(headsForPath(byPath, "never-seen.md")).toEqual([]);
  });

  it("returns no heads when no versions are recorded at all", () => {
    expect(headsForPath(new Map(), "a.md")).toEqual([]);
  });
});
