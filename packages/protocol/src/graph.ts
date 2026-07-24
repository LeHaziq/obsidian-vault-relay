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

function assertAcyclic(versions: Map<string, VersionNode>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Operation graph contains a cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const node = versions.get(id);
    for (const parent of node?.mutation.parents ?? []) {
      if (versions.has(parent)) visit(parent);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of versions.keys()) visit(id);
}

export function compareVersions(left: VersionNode, right: VersionNode): number {
  const time = left.operation.createdAt.localeCompare(right.operation.createdAt);
  return time || left.operation.id.localeCompare(right.operation.id);
}
