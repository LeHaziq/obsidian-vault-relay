import { assertNoCaseCollisions, conflictPath, normalizeVaultPath } from "./path.js";
import { headsForVersions, versionsByPath, type VersionNode } from "./graph.js";
import { sha256 } from "./hash.js";
import { PROTOCOL_VERSION, type Conflict, type LocalFile, type LocalVault, type Mutation, type RemoteVault, type StateRepository, type SyncEngineOptions, type SyncOperation, type SyncResult, type SyncState } from "./types.js";

export const MAX_CHANGES_PER_OPERATION = 1_000;
const DEFAULT_REPAIR_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_CHECKPOINT_FILES = 50;
const DEFAULT_CHECKPOINT_MS = 2_000;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/;

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
    if (mutation.kind === "put" && (!/^[a-f0-9]{64}$/.test(mutation.blobHash) || !Number.isSafeInteger(mutation.size) || mutation.size < 0)) {
      throw new Error(`Remote operation contains invalid content metadata: ${value.id}`);
    }
    // The MIME type is interpolated into multipart upload headers, so reject
    // anything that is not a plain type/subtype token.
    if (mutation.kind === "put" && (typeof mutation.mimeType !== "string" || mutation.mimeType.length > 255 || !MIME_TYPE_PATTERN.test(mutation.mimeType))) {
      throw new Error(`Remote operation contains an invalid MIME type: ${value.id}`);
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
    lastRepairAt: null,
  };
}

/**
 * Coalesces materialization progress writes. Persisting after every file makes
 * a sync quadratic in vault size, because each save serializes the whole state.
 * Losing a batch only costs a redundant no-op operation on the next sync: the
 * content is already on disk, so it is re-recorded rather than re-transferred.
 */
class Checkpointer {
  private dirty = 0;
  private lastFlush = Date.now();

  constructor(
    private readonly save: () => Promise<void>,
    private readonly everyFiles: number,
    private readonly everyMs: number,
  ) {}

  async record(): Promise<void> {
    this.dirty += 1;
    if (this.dirty >= this.everyFiles || Date.now() - this.lastFlush >= this.everyMs) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.dirty === 0) return;
    this.dirty = 0;
    this.lastFlush = Date.now();
    await this.save();
  }
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

  private checkAborted(): void {
    this.options.signal?.throwIfAborted();
  }

  private async run(): Promise<SyncResult> {
    this.checkAborted();
    const state = await this.states.load();
    for (const operation of Object.values(state.operations)) validateOperation(operation);
    for (const operation of state.pending) validateOperation(operation);
    const bootstrapping = state.cursor === null
      && Object.keys(state.operations).length === 0
      && Object.keys(state.materialized).length === 0
      && state.pending.length === 0;
    const knownVersions = versionsByPath(state.operations);
    const localFiles = await this.local.scan();
    assertNoCaseCollisions(localFiles.map((file) => file.path));
    const localByPath = new Map(localFiles.map((file) => [normalizeVaultPath(file.path), file]));

    let pulled: Awaited<ReturnType<RemoteVault["pullOperations"]>> | null = null;
    if (bootstrapping) {
      this.checkAborted();
      pulled = await this.remote.pullOperations(state.cursor);
      mergePulledOperations(state, pulled.operations);
      state.cursor = pulled.cursor;
    }

    state.pending = state.pending.filter((operation) => operation.changes.every((mutation) => {
      if (mutation.kind === "delete") return !localByPath.has(mutation.path);
      return localByPath.get(mutation.path)?.hash === mutation.blobHash;
    }));
    const pendingPaths = new Set(state.pending.flatMap((operation) => operation.changes.map((mutation) => mutation.path)));
    const remoteVersions = bootstrapping ? versionsByPath(state.operations) : null;
    const pending = await this.captureLocalChanges(state, localByPath, pendingPaths, knownVersions, remoteVersions);
    if (pending.length > 0) {
      state.pending.push(...pending);
      state.nextSequence += pending.length;
      await this.states.save(state);
    }

    this.checkAborted();
    if (!pulled) {
      pulled = await this.remote.pullOperations(state.cursor);
      mergePulledOperations(state, pulled.operations);
      state.cursor = pulled.cursor;
    }

    // Re-uploading every locally retained operation requires listing the whole
    // remote operations folder, so run it on a schedule instead of every sync.
    const repairIntervalMs = this.options.repairIntervalMs ?? DEFAULT_REPAIR_INTERVAL_MS;
    const lastRepairAt = state.lastRepairAt ?? null;
    if (lastRepairAt === null || Date.now() - lastRepairAt >= repairIntervalMs) {
      this.checkAborted();
      await this.remote.ensureOperations(Object.values(state.operations));
      state.lastRepairAt = Date.now();
    }
    await this.states.save(state);

    let uploadedOperations = 0;
    for (const operation of [...state.pending]) {
      this.checkAborted();
      await this.uploadOperation(operation, localByPath);
      state.operations[operation.id] = operation;
      state.pending = state.pending.filter((candidate) => candidate.id !== operation.id);
      uploadedOperations += 1;
      await this.states.save(state);
    }

    const checkpoint = new Checkpointer(
      () => this.states.save(state),
      this.options.checkpointEveryFiles ?? DEFAULT_CHECKPOINT_FILES,
      this.options.checkpointEveryMs ?? DEFAULT_CHECKPOINT_MS,
    );
    const materialized = await this.materialize(state, localByPath, checkpoint);
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

  private async captureLocalChanges(
    state: SyncState,
    files: Map<string, LocalFile>,
    pendingPaths: Set<string>,
    knownVersions: Map<string, Map<string, VersionNode>>,
    bootstrapVersions: Map<string, Map<string, VersionNode>> | null,
  ): Promise<SyncOperation[]> {
    const changes: Mutation[] = [];
    const paths = new Set([...files.keys(), ...Object.keys(state.materialized)]);

    for (const path of [...paths].sort()) {
      if (!this.local.isManaged(path) || pendingPaths.has(path)) continue;
      const current = files.get(path);
      const prior = state.materialized[path];
      if (current?.hash === prior?.hash || (!current && !prior)) continue;
      if (!prior && current && bootstrapVersions) {
        const alreadyRemote = headsForVersions(bootstrapVersions.get(path) ?? new Map())
          .some((head) => head.mutation.kind === "put" && head.mutation.blobHash === current.hash);
        if (alreadyRemote) continue;
      }
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
      this.checkAborted();
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

  private async materialize(state: SyncState, localFiles: Map<string, LocalFile>, checkpoint: Checkpointer): Promise<{ written: number; removed: number; conflicts: Conflict[] }> {
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

    try {
      for (const [path, node] of desired) {
        this.checkAborted();
        if (node.mutation.kind === "delete") {
          if (localFiles.has(path)) {
            await this.local.remove(path);
            localFiles.delete(path);
            removed += 1;
          }
          delete state.materialized[path];
          await checkpoint.record();
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
        await checkpoint.record();
      }

      for (const path of Object.keys(state.materialized)) {
        this.checkAborted();
        if (!this.local.isManaged(path)) {
          const prior = state.materialized[path];
          if (prior) nextMaterialized[path] = prior;
        } else if (!desired.has(path) && localFiles.has(path)) {
          await this.local.remove(path);
          delete state.materialized[path];
          await checkpoint.record();
          removed += 1;
        }
      }
      state.materialized = nextMaterialized;
    } finally {
      // Persist whatever progress was made, including on abort or failure.
      await checkpoint.flush();
    }
    return { written, removed, conflicts };
  }
}

function sameOperation(left: SyncOperation, right: SyncOperation): boolean {
  if (left === right) return true;
  if (left.id !== right.id || left.deviceId !== right.deviceId || left.sequence !== right.sequence
    || left.createdAt !== right.createdAt || left.changes.length !== right.changes.length) return false;
  return left.changes.every((mutation, index) => {
    const other = right.changes[index]!;
    if (mutation.kind !== other.kind || mutation.path !== other.path) return false;
    if (mutation.parents.length !== other.parents.length) return false;
    if (!mutation.parents.every((parent, at) => parent === other.parents[at])) return false;
    if (mutation.kind !== "put" || other.kind !== "put") return true;
    return mutation.blobHash === other.blobHash && mutation.size === other.size && mutation.mimeType === other.mimeType;
  });
}

function mergePulledOperations(state: SyncState, operations: SyncOperation[]): void {
  for (const operation of operations) {
    validateOperation(operation);
    const existing = state.operations[operation.id];
    if (existing && !sameOperation(existing, operation)) throw new Error(`Remote operation ID was reused with different content: ${operation.id}`);
    state.operations[operation.id] = operation;
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
