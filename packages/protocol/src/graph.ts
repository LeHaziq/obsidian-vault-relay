import type { Mutation, SyncOperation } from "./types.js";

export interface VersionNode {
  operation: SyncOperation;
  mutation: Mutation;
}

export function versionsByPath(operations: Record<string, SyncOperation>): Map<string, Map<string, VersionNode>> {
  const result = new Map<string, Map<string, VersionNode>>();
  for (const operation of Object.values(operations)) {
    for (const mutation of operation.changes) {
      const pathVersions = result.get(mutation.path) ?? new Map<string, VersionNode>();
      pathVersions.set(operation.id, { operation, mutation });
      result.set(mutation.path, pathVersions);
    }
  }
  return result;
}

export function headsForVersions(versions: Map<string, VersionNode>): VersionNode[] {
  assertAcyclic(versions);
  const parentIds = new Set<string>();
  for (const { mutation } of versions.values()) {
    for (const parent of mutation.parents) {
      if (versions.has(parent)) parentIds.add(parent);
    }
  }
  const heads = [...versions.entries()]
    .filter(([id]) => !parentIds.has(id))
    .map(([, node]) => node)
    .sort(compareVersions);
  if (versions.size > 0 && heads.length === 0) throw new Error("Operation graph contains no materializable head");
  return heads;
}

/**
 * Iterative depth-first cycle check. A long single-path history can retain
 * thousands of linked versions, so recursion here risks a stack overflow.
 */
function assertAcyclic(versions: Map<string, VersionNode>): void {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  for (const root of versions.keys()) {
    if (visited.has(root)) continue;
    const stack: Array<{ id: string; entered: boolean }> = [{ id: root, entered: false }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.entered) {
        visiting.delete(frame.id);
        visited.add(frame.id);
        continue;
      }
      if (visited.has(frame.id)) continue;
      if (visiting.has(frame.id)) throw new Error(`Operation graph contains a cycle at ${frame.id}`);
      visiting.add(frame.id);
      stack.push({ id: frame.id, entered: true });
      for (const parent of versions.get(frame.id)?.mutation.parents ?? []) {
        if (versions.has(parent) && !visited.has(parent)) stack.push({ id: parent, entered: false });
      }
    }
  }
}

export function compareVersions(left: VersionNode, right: VersionNode): number {
  const time = left.operation.createdAt.localeCompare(right.operation.createdAt);
  return time || left.operation.id.localeCompare(right.operation.id);
}
