import { assertNoCaseCollisions, conflictPath, normalizeVaultPath } from "./path.js";
import { headsForPath, headsForVersions, versionsByPath, type VersionNode } from "./graph.js";
import { sha256 } from "./hash.js";
import { PROTOCOL_VERSION, type Conflict, type LocalFile, type LocalVault, type MaterializedFile, type Mutation, type RemoteVault, type StateRepository, type SyncEngineOptions, type SyncOperation, type SyncResult, type SyncState } from "./types.js";

export const MAX_CHANGES_PER_OPERATION = 1_000;
const DEFAULT_REPAIR_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_CHECKPOINT_FILES = 50;
const DEFAULT_CHECKPOINT_MS = 2_000;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/;
const BLOB_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ID_LENGTH = 300;
const MAX_DEVICE_ID_LENGTH = 200;
const MAX_CURSOR_LENGTH = 4_000;
const MAX_PATH_LENGTH = 4_096;

export class DestructiveSyncError extends Error {
  constructor(public readonly count: number) {
    super(`Safety stop: sync would delete ${count} files at once`);
    this.name = "DestructiveSyncError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_ID_LENGTH;
}

export function validateOperation(value: unknown): SyncOperation {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || !isOperationId(value.id)) {
    throw new Error("Remote operation has an unsupported or invalid format");
  }
  const id = value.id;
  if (typeof value.deviceId !== "string" || value.deviceId.length > MAX_DEVICE_ID_LENGTH || typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error(`Remote operation has invalid device metadata: ${id}`);
  }
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.changes) || value.changes.length > 10_000) {
    throw new Error(`Remote operation has invalid change metadata: ${id}`);
  }
  const changes: unknown[] = value.changes;
  const seen = new Set<string>();
  for (const mutation of changes) {
    if (!isRecord(mutation) || (mutation.kind !== "put" && mutation.kind !== "delete") || typeof mutation.path !== "string" || mutation.path.length > MAX_PATH_LENGTH) {
      throw new Error(`Remote operation contains an invalid mutation: ${id}`);
    }
    const normalized = normalizeVaultPath(mutation.path);
    if (normalized !== mutation.path || seen.has(normalized)) throw new Error(`Remote operation contains an invalid or duplicate path: ${id}`);
    seen.add(normalized);
    if (!Array.isArray(mutation.parents)) throw new Error(`Remote operation contains invalid parents: ${id}`);
    const parents: unknown[] = mutation.parents;
    if (new Set(parents).size !== parents.length || parents.includes(id) || parents.some((parent) => !isOperationId(parent))) {
      throw new Error(`Remote operation contains invalid parents: ${id}`);
    }
    if (mutation.kind === "put" && (typeof mutation.blobHash !== "string" || !BLOB_HASH_PATTERN.test(mutation.blobHash) || typeof mutation.size !== "number" || !Number.isSafeInteger(mutation.size) || mutation.size < 0)) {
      throw new Error(`Remote operation contains invalid content metadata: ${id}`);
    }
    // The MIME type is interpolated into multipart upload headers, so reject
    // anything that is not a plain type/subtype token.
    if (mutation.kind === "put" && (typeof mutation.mimeType !== "string" || mutation.mimeType.length > 255 || !MIME_TYPE_PATTERN.test(mutation.mimeType))) {
      throw new Error(`Remote operation contains an invalid MIME type: ${id}`);
    }
  }
  // The checks above cover each field of the type. Thus the value now has the
  // shape that the other functions of the module use.
  return value as unknown as SyncOperation;
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
 * Appends changes to a sync state as a new pending operation. This is the only
 * place that mints an operation id and consumes the next sequence number, so
 * every source of pending work (local capture, conflict resolution) shares the
 * rule. Returns the appended operation.
 */
export function appendChanges(state: SyncState, changes: Mutation[]): SyncOperation {
  const sequence = state.nextSequence;
  const operation: SyncOperation = {
    protocolVersion: PROTOCOL_VERSION,
    id: `${state.deviceId}-${sequence.toString(36)}-${crypto.randomUUID()}`,
    deviceId: state.deviceId,
    sequence,
    createdAt: new Date().toISOString(),
    changes,
  };
  state.pending.push(operation);
  state.nextSequence += 1;
  return operation;
}

/**
 * Makes a sync state from a persisted value. All data on disk is untrusted. A
 * hand-edited or truncated file must not go to the engine. The engine throws if
 * an operation is malformed. Thus a state that does not parse fully becomes an
 * initial state. This costs one bootstrap from the remote store. Only the device
 * identity stays, because the sequence numbers of the device continue from it.
 */
export function parseSyncState(value: unknown): SyncState {
  if (!isRecord(value)) return createInitialState();
  const deviceId = typeof value.deviceId === "string" && value.deviceId.length >= 1 && value.deviceId.length <= MAX_DEVICE_ID_LENGTH ? value.deviceId : undefined;
  const fresh = createInitialState(deviceId);
  if (value.protocolVersion !== PROTOCOL_VERSION) return fresh;
  const operations = parseOperations(value.operations);
  const materialized = parseMaterialized(value.materialized);
  const pending = parsePending(value.pending);
  if (!operations || !materialized || !pending) return fresh;
  const persisted = typeof value.nextSequence === "number" && Number.isSafeInteger(value.nextSequence) && value.nextSequence >= 1 ? value.nextSequence : 1;
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: fresh.deviceId,
    // A rewound counter makes the device use a sequence number a second time.
    // Thus the retained work sets the floor when the persisted counter is bad.
    nextSequence: Math.max(persisted, nextFreeSequence(fresh.deviceId, [...Object.values(operations), ...pending])),
    cursor: typeof value.cursor === "string" && value.cursor.length <= MAX_CURSOR_LENGTH ? value.cursor : null,
    operations,
    materialized,
    pending,
    lastRepairAt: typeof value.lastRepairAt === "number" && Number.isFinite(value.lastRepairAt) ? value.lastRepairAt : null,
  };
}

function nextFreeSequence(deviceId: string, operations: SyncOperation[]): number {
  let highest = 0;
  for (const operation of operations) {
    if (operation.deviceId === deviceId && operation.sequence > highest) highest = operation.sequence;
  }
  return highest + 1;
}

/** Each key of the map is the id of its operation. A different key is corrupt. */
function parseOperations(value: unknown): Record<string, SyncOperation> | null {
  if (!isRecord(value)) return null;
  const operations: Record<string, SyncOperation> = {};
  for (const [id, entry] of Object.entries(value)) {
    const operation = parseOperation(entry);
    if (!operation || operation.id !== id) return null;
    operations[id] = operation;
  }
  return operations;
}

function parsePending(value: unknown): SyncOperation[] | null {
  if (!Array.isArray(value)) return null;
  const pending: SyncOperation[] = [];
  for (const entry of value as unknown[]) {
    const operation = parseOperation(entry);
    if (!operation) return null;
    pending.push(operation);
  }
  return pending;
}

function parseOperation(value: unknown): SyncOperation | null {
  try {
    return validateOperation(value);
  } catch {
    return null;
  }
}

function parseMaterialized(value: unknown): Record<string, MaterializedFile> | null {
  if (!isRecord(value)) return null;
  const materialized: Record<string, MaterializedFile> = {};
  for (const [path, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.hash !== "string" || !BLOB_HASH_PATTERN.test(entry.hash) || !isOperationId(entry.operationId)) return null;
    if (path.length > MAX_PATH_LENGTH || safeVaultPath(path) !== path) return null;
    materialized[path] = { hash: entry.hash, operationId: entry.operationId };
  }
  return materialized;
}

function safeVaultPath(path: string): string | null {
  try {
    return normalizeVaultPath(path);
  } catch {
    return null;
  }
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
      for (let offset = 0; offset < pending.length; offset += MAX_CHANGES_PER_OPERATION) {
        appendChanges(state, pending.slice(offset, offset + MAX_CHANGES_PER_OPERATION));
      }
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
  ): Promise<Mutation[]> {
    const changes: Mutation[] = [];
    const paths = new Set([...files.keys(), ...Object.keys(state.materialized)]);

    for (const path of [...paths].sort()) {
      if (!this.local.isManaged(path) || pendingPaths.has(path)) continue;
      const current = files.get(path);
      const prior = state.materialized[path];
      if (current?.hash === prior?.hash || (!current && !prior)) continue;
      if (!prior && current && bootstrapVersions) {
        const alreadyRemote = headsForPath(bootstrapVersions, path)
          .some((head) => head.mutation.kind === "put" && head.mutation.blobHash === current.hash);
        if (alreadyRemote) continue;
      }
      const parents = headsForPath(knownVersions, path).map((head) => head.operation.id);
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
    return changes;
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
