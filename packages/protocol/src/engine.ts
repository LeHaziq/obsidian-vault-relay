import { assertNoCaseCollisions, conflictPath, normalizeVaultPath } from "./path.js";
import { headsForVersions, versionsByPath, type VersionNode } from "./graph.js";
import { sha256 } from "./hash.js";
import { PROTOCOL_VERSION, type Conflict, type LocalFile, type LocalVault, type Mutation, type RemoteVault, type StateRepository, type SyncEngineOptions, type SyncOperation, type SyncResult, type SyncState } from "./types.js";

export const MAX_CHANGES_PER_OPERATION = 1_000;

export class DestructiveSyncError extends Error {
  constructor(public readonly count: number) {
    super(`Safety stop: sync would delete ${count} files at once`);
    this.name = "DestructiveSyncError";
  }
}

export function validateOperation(value: SyncOperation): SyncOperation {
  if (!value || value.protocolVersion !== PROTOCOL_VERSION || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 300) {
    throw new Error("Remote operation has an unsupported or invalid format");
  }
  if (typeof value.deviceId !== "string" || value.deviceId.length > 200 || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error(`Remote operation has invalid device metadata: ${value.id}`);
  }
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.changes) || value.changes.length > 10_000) {
    throw new Error(`Remote operation has invalid change metadata: ${value.id}`);
  }
  const seen = new Set<string>();
  for (const mutation of value.changes) {
    if (!mutation || (mutation.kind !== "put" && mutation.kind !== "delete") || typeof mutation.path !== "string" || mutation.path.length > 4096) {
      throw new Error(`Remote operation contains an invalid mutation: ${value.id}`);
    }
    const normalized = normalizeVaultPath(mutation.path);
    if (normalized !== mutation.path || seen.has(normalized)) throw new Error(`Remote operation contains an invalid or duplicate path: ${value.id}`);
    seen.add(normalized);
    if (!Array.isArray(mutation.parents) || new Set(mutation.parents).size !== mutation.parents.length || mutation.parents.includes(value.id) || mutation.parents.some((parent) => typeof parent !== "string" || parent.length < 1 || parent.length > 300)) {
      throw new Error(`Remote operation contains invalid parents: ${value.id}`);
    }
    if (mutation.kind === "put" && (!/^[a-f0-9]{64}$/.test(mutation.blobHash) || !Number.isSafeInteger(mutation.size) || mutation.size < 0 || typeof mutation.mimeType !== "string")) {
      throw new Error(`Remote operation contains invalid content metadata: ${value.id}`);
    }
  }
  return value;
}

export function createInitialState(deviceId: string = crypto.randomUUID()): SyncState {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    nextSequence: 1,
    cursor: null,
    operations: {},
    materialized: {},
    pending: [],
  };
}

export class SyncEngine {
  private running: Promise<SyncResult> | null = null;

  constructor(
    private readonly local: LocalVault,
    private readonly remote: RemoteVault,
    private readonly states: StateRepository,
    private readonly options: SyncEngineOptions = {},
  ) {}

  sync(): Promise<SyncResult> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<SyncResult> {
    const state = await this.states.load();
    for (const operation of Object.values(state.operations)) validateOperation(operation);
    for (const operation of state.pending) validateOperation(operation);
    const localFiles = await this.local.scan();
    assertNoCaseCollisions(localFiles.map((file) => file.path));
    const localByPath = new Map(localFiles.map((file) => [normalizeVaultPath(file.path), file]));

    state.pending = state.pending.filter((operation) => operation.changes.every((mutation) => {
      if (mutation.kind === "delete") return !localByPath.has(mutation.path);
      return localByPath.get(mutation.path)?.hash === mutation.blobHash;
    }));
    const pendingPaths = new Set(state.pending.flatMap((operation) => operation.changes.map((mutation) => mutation.path)));
    const pending = await this.captureLocalChanges(state, localByPath, pendingPaths);
    if (pending.length > 0) {
      state.pending.push(...pending);
      state.nextSequence += pending.length;
      await this.states.save(state);
    }

    const pulled = await this.remote.pullOperations(state.cursor);
    for (const operation of pulled.operations) {
      validateOperation(operation);
      const existing = state.operations[operation.id];
      if (existing && JSON.stringify(existing) !== JSON.stringify(operation)) throw new Error(`Remote operation ID was reused with different content: ${operation.id}`);
      state.operations[operation.id] = operation;
    }
    state.cursor = pulled.cursor;
    await this.remote.ensureOperations(Object.values(state.operations));
    await this.states.save(state);

    let uploadedOperations = 0;
    for (const operation of [...state.pending]) {
      await this.uploadOperation(operation, localByPath);
      state.operations[operation.id] = operation;
      state.pending = state.pending.filter((candidate) => candidate.id !== operation.id);
      uploadedOperations += 1;
      await this.states.save(state);
    }

    const materialized = await this.materialize(state, localByPath, () => this.states.save(state));
    compactOperations(state, this.options.retainedVersionsPerPath ?? 20);
    await this.states.save(state);
    return {
      uploadedOperations,
      downloadedOperations: pulled.operations.length,
      writtenFiles: materialized.written,
      removedFiles: materialized.removed,
      conflicts: materialized.conflicts,
    };
  }

  private async captureLocalChanges(state: SyncState, files: Map<string, LocalFile>, pendingPaths: Set<string>): Promise<SyncOperation[]> {
    const changes: Mutation[] = [];
    const knownVersions = versionsByPath(state.operations);
    const paths = new Set([...files.keys(), ...Object.keys(state.materialized)]);

    for (const path of [...paths].sort()) {
      if (!this.local.isManaged(path) || pendingPaths.has(path)) continue;
      const current = files.get(path);
      const prior = state.materialized[path];
      if (current?.hash === prior?.hash || (!current && !prior)) continue;
      const parents = headsForVersions(knownVersions.get(path) ?? new Map()).map((head) => head.operation.id);
      if (current) {
        changes.push({
          kind: "put",
          path,
          parents,
          blobHash: current.hash,
          size: current.size,
          mimeType: current.mimeType,
        });
      } else {
        changes.push({ kind: "delete", path, parents });
      }
    }

    const operations: SyncOperation[] = [];
    for (let offset = 0; offset < changes.length; offset += MAX_CHANGES_PER_OPERATION) {
      const sequence = state.nextSequence + operations.length;
      operations.push({
        protocolVersion: PROTOCOL_VERSION,
        id: `${state.deviceId}-${sequence.toString(36)}-${crypto.randomUUID()}`,
        deviceId: state.deviceId,
        sequence,
        createdAt: new Date().toISOString(),
        changes: changes.slice(offset, offset + MAX_CHANGES_PER_OPERATION),
      });
    }
    return operations;
  }

  private async uploadOperation(operation: SyncOperation, files: Map<string, LocalFile>): Promise<void> {
    for (const mutation of operation.changes) {
      if (mutation.kind !== "put" || await this.remote.hasBlob(mutation.blobHash)) continue;
      const file = files.get(mutation.path);
      if (!file || file.hash !== mutation.blobHash) {
        throw new Error(`Local file changed before upload completed: ${mutation.path}`);
      }
      const content = await this.local.read(mutation.path);
      if (await sha256(content) !== mutation.blobHash) throw new Error(`Local file changed while it was being uploaded: ${mutation.path}`);
      await this.remote.putBlob(mutation.blobHash, content, mutation.mimeType);
    }
    await this.remote.putOperation(operation);
  }

  private async materialize(state: SyncState, localFiles: Map<string, LocalFile>, checkpoint: () => Promise<void>): Promise<{ written: number; removed: number; conflicts: Conflict[] }> {
    const paths = versionsByPath(state.operations);
    const desired = new Map<string, VersionNode>();
    const conflicts: Conflict[] = [];

    for (const [path, versions] of paths) {
      if (!this.local.isManaged(path)) continue;
      const heads = headsForVersions(versions);
      const primary = heads.at(-1);
      if (!primary) continue;
      desired.set(path, primary);
      const alternatives = heads.slice(0, -1).filter((head) => head.mutation.kind === "put");
      const conflictPaths: string[] = [];
      for (const alternative of alternatives) {
        let pathForConflict = conflictPath(path, alternative.operation.id);
        let collision = 1;
        while (desired.has(pathForConflict) || paths.has(pathForConflict)) {
          pathForConflict = conflictPath(path, `${alternative.operation.id}-${collision}`);
          collision += 1;
        }
        desired.set(pathForConflict, alternative);
        conflictPaths.push(pathForConflict);
      }
      if (heads.length > 1) {
        conflicts.push({ path, heads: heads.map((head) => head.operation.id), conflictPaths });
      }
    }

    assertNoCaseCollisions([...desired.keys()]);
    const plannedRemovals = [...desired].filter(([path, node]) => node.mutation.kind === "delete" && localFiles.has(path)).length
      + Object.keys(state.materialized).filter((path) => this.local.isManaged(path) && !desired.has(path) && localFiles.has(path)).length;
    const destructiveLimit = Math.max(25, Math.ceil(localFiles.size * 0.25));
    if (plannedRemovals > destructiveLimit && !this.options.allowLargeDeletes) throw new DestructiveSyncError(plannedRemovals);

    let written = 0;
    let removed = 0;
    const nextMaterialized: SyncState["materialized"] = {};

    for (const [path, node] of desired) {
      if (node.mutation.kind === "delete") {
        if (localFiles.has(path)) {
          await this.local.remove(path);
          localFiles.delete(path);
          removed += 1;
        }
        delete state.materialized[path];
        await checkpoint();
        continue;
      }
      const current = localFiles.get(path);
      if (current?.hash !== node.mutation.blobHash) {
        const content = await this.remote.getBlob(node.mutation.blobHash);
        if (content.byteLength !== node.mutation.size || await sha256(content) !== node.mutation.blobHash) {
          throw new Error(`Remote content failed integrity verification: ${path}`);
        }
        await this.local.write(path, content);
        written += 1;
      }
      nextMaterialized[path] = { hash: node.mutation.blobHash, operationId: node.operation.id };
      state.materialized[path] = nextMaterialized[path];
      await checkpoint();
    }

    for (const path of Object.keys(state.materialized)) {
      if (!this.local.isManaged(path)) {
        const prior = state.materialized[path];
        if (prior) nextMaterialized[path] = prior;
      } else if (!desired.has(path) && localFiles.has(path)) {
        await this.local.remove(path);
        delete state.materialized[path];
        await checkpoint();
        removed += 1;
      }
    }
    state.materialized = nextMaterialized;
    return { written, removed, conflicts };
  }
}

export function compactOperations(state: SyncState, retainedVersionsPerPath: number): void {
  if (retainedVersionsPerPath < 1) return;
  const keep = new Set(state.pending.map((operation) => operation.id));
  for (const versions of versionsByPath(state.operations).values()) {
    const recent = [...versions.values()]
      .sort((left, right) => right.operation.createdAt.localeCompare(left.operation.createdAt) || right.operation.id.localeCompare(left.operation.id))
      .slice(0, retainedVersionsPerPath);
    for (const version of recent) keep.add(version.operation.id);
    for (const head of headsForVersions(versions)) keep.add(head.operation.id);
  }
  for (const id of Object.keys(state.operations)) {
    if (!keep.has(id)) delete state.operations[id];
  }
}
