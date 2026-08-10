import { appendChanges, createInitialState, MAX_CHANGES_PER_OPERATION, parseSyncState, SyncEngine } from "./engine.js";
import { headsForVersions, versionsByPath, type VersionNode } from "./graph.js";
import { sha256 } from "./hash.js";
import { conflictPath } from "./path.js";
import type { LocalFile, LocalVault, RemoteVault, StateRepository, SyncEngineOptions, SyncState } from "./types.js";

declare const historicalVersionReference: unique symbol;
declare const conflictReferenceBrand: unique symbol;

export type HistoricalVersionReference = string & { readonly [historicalVersionReference]: true };
export type ConflictReference = string & { readonly [conflictReferenceBrand]: true };

interface HistoricalVersionBase {
  reference: HistoricalVersionReference;
  path: string;
  createdAt: string;
  deviceId?: string;
}

export type HistoricalVersion =
  | (HistoricalVersionBase & { content: "file"; publication: "published"; restorable: true })
  | (HistoricalVersionBase & { content: "file"; publication: "published"; restorable: false })
  | (HistoricalVersionBase & { content: "file"; publication: "pending"; restorable: false })
  | (HistoricalVersionBase & { content: "deletion"; publication: "pending" | "published"; restorable: false });

export interface CurrentConflict {
  reference: ConflictReference;
  path: string;
  conflictPaths: string[];
  current: "file" | "deletion";
}

export interface VersionHistorySnapshot {
  historicalVersions: HistoricalVersion[];
  conflicts: CurrentConflict[];
}

export type ConflictChoice =
  | { reference: ConflictReference; choice: "keep-current-file" }
  | { reference: ConflictReference; choice: "keep-deleted" };

export interface ProtocolBinding {
  readonly remote: RemoteVault;
  readonly states: StateRepository;
}

export interface ProtocolOptions extends Omit<SyncEngineOptions, "allowLargeDeletes"> {
  /** Called exactly once for a genuinely new, bound synchronization run. */
  consumeAllowLargeDeletes?: () => boolean | Promise<boolean>;
}

export interface ProtocolSyncResult {
  uploadedOperations: number;
  downloadedOperations: number;
  writtenFiles: number;
  removedFiles: number;
  conflicts: CurrentConflict[];
}

export interface SyncEngineCapability {
  sync(): Promise<ProtocolSyncResult>;
}

export interface VersionHistoryCapability {
  snapshot(): Promise<VersionHistorySnapshot>;
  restore(reference: HistoricalVersionReference): Promise<{ path: string; reference: HistoricalVersionReference }>;
  resolveBatch(choices: readonly ConflictChoice[]): Promise<{ paths: string[] }>;
}

export interface Protocol {
  syncEngine: SyncEngineCapability;
  versionHistory: VersionHistoryCapability;
  rebind(binding: ProtocolBinding, options?: { resetState?: boolean }): Promise<void>;
  unbind(): Promise<void>;
}

export interface CreateProtocolOptions {
  local: LocalVault;
  binding?: ProtocolBinding;
  options?: ProtocolOptions;
}

/**
 * The sole public composition root for synchronization and Version History.
 * Every operation enters one coordinator and observes one immutable binding.
 */
export function createProtocol({ local, binding, options = {} }: CreateProtocolOptions): Protocol {
  return new ProtocolCoordinator(local, binding, options);
}

/** A deliberately non-representational error intended for Version History callers. */
class VersionHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionHistoryError";
  }
}

function safeHistoryError(error: unknown, fallback: string): VersionHistoryError {
  return error instanceof VersionHistoryError ? error : new VersionHistoryError(fallback);
}

class ProtocolCoordinator implements Protocol {
  readonly syncEngine: SyncEngineCapability = { sync: () => this.sync() };
  readonly versionHistory: VersionHistoryCapability = {
    snapshot: () => this.snapshot(),
    restore: (reference) => this.restore(reference),
    resolveBatch: (choices) => this.resolveBatch(choices),
  };

  private binding: ProtocolBinding | undefined;
  private tail: Promise<void> = Promise.resolve();
  private joinedSync: Promise<ProtocolSyncResult> | null = null;

  constructor(private readonly local: LocalVault, binding: ProtocolBinding | undefined, private readonly options: ProtocolOptions) {
    this.binding = binding && copyBinding(binding);
  }

  sync(): Promise<ProtocolSyncResult> {
    if (this.joinedSync) return this.joinedSync;
    const run = this.enqueue(async () => {
      const binding = this.requireBinding();
      const allowLargeDeletes = this.options.consumeAllowLargeDeletes ? await this.options.consumeAllowLargeDeletes() : false;
      const result = await new SyncEngine(this.local, binding.remote, binding.states, { ...this.options, allowLargeDeletes }).sync();
      const state = await this.loadState(binding);
      return {
        ...result,
        conflicts: await projectConflicts(state, this.local),
      };
    });
    this.joinedSync = run.finally(() => { this.joinedSync = null; });
    return this.joinedSync;
  }

  async rebind(binding: ProtocolBinding, options: { resetState?: boolean } = {}): Promise<void> {
    const immutable = copyBinding(binding);
    await this.enqueue(async () => {
      if (options.resetState) {
        const prior = await this.loadState(immutable);
        await immutable.states.save(createInitialState(prior.deviceId));
      }
      this.binding = immutable;
    });
  }

  async unbind(): Promise<void> {
    await this.enqueue(async () => { this.binding = undefined; });
  }

  private snapshot(): Promise<VersionHistorySnapshot> {
    return this.enqueue(async () => {
      try {
        const binding = this.requireBinding();
        const state = await this.loadState(binding);
        return {
          historicalVersions: await projectHistory(state, this.local),
          conflicts: await projectConflicts(state, this.local),
        };
      } catch (error) {
        throw safeHistoryError(error, "Version History snapshot is unavailable");
      }
    });
  }

  private restore(reference: HistoricalVersionReference): Promise<{ path: string; reference: HistoricalVersionReference }> {
    return this.enqueue(async () => {
      let path: string | undefined;
      try {
        const binding = this.requireBinding();
        const state = await this.loadState(binding);
        const version = await findHistoricalVersion(state, reference);
        if (!version || !version.restorable || version.node.mutation.kind !== "put") throw new VersionHistoryError("Historical Version is unavailable for restoration");
        path = version.node.mutation.path;
        if (hasPendingVersion(state, path)) throw new VersionHistoryError(`Historical Version cannot be restored while publication is pending: ${path}`);
        if (!this.local.isManaged(path)) throw new VersionHistoryError(`Historical Version cannot be restored for unmanaged path: ${path}`);
        const content = await binding.remote.getBlob(version.node.mutation.blobHash);
        if (content.byteLength !== version.node.mutation.size || await sha256(content) !== version.node.mutation.blobHash) {
          throw new VersionHistoryError(`Historical Version failed integrity verification: ${path}`);
        }
        await this.local.write(path, content);
        const versions = allVersions(state);
        appendChanges(state, [{
          kind: "put",
          path,
          parents: headsForVersions(versions.get(path) ?? new Map()).map((head) => head.operation.id),
          blobHash: version.node.mutation.blobHash,
          size: version.node.mutation.size,
          mimeType: version.node.mutation.mimeType,
        }]);
        await binding.states.save(state);
        return { path, reference };
      } catch (error) {
        throw safeHistoryError(error, path ? `Historical Version restoration failed for ${path}` : "Historical Version restoration is unavailable");
      }
    });
  }

  private resolveBatch(choices: readonly ConflictChoice[]): Promise<{ paths: string[] }> {
    return this.enqueue(async () => {
      const paths = new Set<string>();
      try {
        validateChoices(choices);
        const binding = this.requireBinding();
        const state = await this.loadState(binding);
        const files = await scanFiles(this.local);
        const conflicts = await conflictMap(state, this.local, files);
        const conflictsByReference = new Map([...conflicts.values()].map((conflict) => [conflict.reference, conflict]));
        const changes: Array<{ kind: "put"; path: string; parents: string[]; blobHash: string; size: number; mimeType: string } | { kind: "delete"; path: string; parents: string[] }> = [];

        for (const choice of choices) {
          const conflict = conflictsByReference.get(choice.reference);
          if (!conflict) throw new VersionHistoryError("Conflict is unknown or stale");
          if (paths.has(conflict.path)) throw new VersionHistoryError(`Conflict resolution contains duplicate path: ${conflict.path}`);
          if (!this.local.isManaged(conflict.path)) throw new VersionHistoryError(`Conflict path is unmanaged: ${conflict.path}`);
          if (hasPendingVersion(state, conflict.path)) throw new VersionHistoryError(`Conflict cannot be resolved while publication is pending: ${conflict.path}`);
          paths.add(conflict.path);
          if (choice.choice === "keep-current-file") {
            const file = files.get(conflict.path);
            if (!file) throw new VersionHistoryError(`Current file does not exist: ${conflict.path}`);
            const content = await this.local.read(conflict.path);
            changes.push({ kind: "put", path: conflict.path, parents: conflict.heads, blobHash: await sha256(content), size: content.byteLength, mimeType: file.mimeType });
          } else {
            changes.push({ kind: "delete", path: conflict.path, parents: conflict.heads });
          }
        }
        // All references, paths, and retained file content have been validated before effects.
        for (const change of changes) if (change.kind === "delete" && files.has(change.path)) await this.local.remove(change.path);
        appendChanges(state, changes);
        await binding.states.save(state);
        return { paths: [...paths].sort() };
      } catch (error) {
        throw safeHistoryError(error, paths.size ? `Conflict resolution failed for ${[...paths].sort().join(", ")}` : "Conflict resolution failed");
      }
    });
  }

  private requireBinding(): ProtocolBinding {
    if (!this.binding) throw new VersionHistoryError("Protocol is not bound to a remote vault");
    return this.binding;
  }

  private async loadState(binding: ProtocolBinding): Promise<SyncState> {
    return parseSyncState(await binding.states.load());
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

function allOperations(state: SyncState): Record<string, SyncState["operations"][string]> {
  return Object.fromEntries([...Object.values(state.operations), ...state.pending].map((operation) => [operation.id, operation]));
}

function allVersions(state: SyncState): ReturnType<typeof versionsByPath> {
  return versionsByPath(allOperations(state));
}

function hasPendingVersion(state: SyncState, path: string): boolean {
  return state.pending.some((operation) => operation.changes.some((mutation) => mutation.path === path));
}

async function historicalReference(path: string, operationId: string): Promise<HistoricalVersionReference> {
  return `h:${await sha256(`historical-version\u0000${path}\u0000${operationId}`)}` as HistoricalVersionReference;
}

async function makeConflictReference(path: string, heads: string[]): Promise<ConflictReference> {
  return `c:${await sha256(`conflict\u0000${path}\u0000${[...heads].sort().join("\u0000")}`)}` as ConflictReference;
}

async function projectHistory(state: SyncState, local: LocalVault): Promise<HistoricalVersion[]> {
  const entries = await Promise.all(Object.values(allOperations(state)).flatMap((operation) => operation.changes.map(async (mutation): Promise<HistoricalVersion> => {
    const base: HistoricalVersionBase = {
      reference: await historicalReference(mutation.path, versionIdentity(operation, mutation)),
      path: mutation.path,
      createdAt: operation.createdAt,
      ...(operation.deviceId ? { deviceId: operation.deviceId } : {}),
    };
    const publication = state.operations[operation.id] !== undefined ? "published" as const : "pending" as const;
    if (mutation.kind !== "put") return { ...base, content: "deletion", publication, restorable: false };
    return publication === "published" && local.isManaged(mutation.path)
      ? { ...base, content: "file", publication, restorable: true }
      : { ...base, content: "file", publication, restorable: false };
  })));
  return entries.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.reference.localeCompare(left.reference));
}

async function findHistoricalVersion(state: SyncState, reference: HistoricalVersionReference): Promise<{ node: VersionNode; restorable: boolean } | undefined> {
  if (typeof reference !== "string") return undefined;
  for (const versions of allVersions(state).values()) {
    for (const node of versions.values()) {
      if (await historicalReference(node.mutation.path, versionIdentity(node.operation, node.mutation)) === reference) {
        return { node, restorable: node.mutation.kind === "put" && state.operations[node.operation.id] !== undefined };
      }
    }
  }
  return undefined;
}

interface InternalConflict extends CurrentConflict { heads: string[]; }

async function conflictMap(state: SyncState, local: LocalVault, files: Map<string, LocalFile>): Promise<Map<string, InternalConflict>> {
  const result = new Map<string, InternalConflict>();
  const paths = allVersions(state);
  const desired = new Map<string, VersionNode>();
  for (const [path, versions] of paths) {
    if (!local.isManaged(path)) continue;
    const heads = headsForVersions(versions);
    if (heads.length < 2) continue;
    const primary = heads.at(-1)!;
    desired.set(path, primary);
    const conflictPaths: string[] = [];
    for (const alternative of heads.slice(0, -1)) {
      if (alternative.mutation.kind !== "put") continue;
      let candidate = conflictPath(path, alternative.operation.id);
      let collision = 1;
      while (desired.has(candidate) || paths.has(candidate)) candidate = conflictPath(path, `${alternative.operation.id}-${collision++}`);
      desired.set(candidate, alternative);
      conflictPaths.push(candidate);
    }
    const ids = heads.map((head) => head.operation.id).sort();
    const identities = heads.map((head) => versionIdentity(head.operation, head.mutation)).sort();
    const reference = await makeConflictReference(path, identities);
    result.set(path, { reference, path, conflictPaths: conflictPaths.sort(), current: files.has(path) ? "file" : "deletion", heads: ids });
  }
  return result;
}

function copyBinding(binding: ProtocolBinding): ProtocolBinding {
  return Object.freeze({ remote: binding.remote, states: binding.states });
}

function versionIdentity(operation: SyncState["operations"][string], mutation: SyncState["operations"][string]["changes"][number]): string {
  return JSON.stringify({
    id: operation.id,
    deviceId: operation.deviceId,
    sequence: operation.sequence,
    createdAt: operation.createdAt,
    mutation: mutation.kind === "put"
      ? { kind: mutation.kind, path: mutation.path, parents: mutation.parents, blobHash: mutation.blobHash, size: mutation.size, mimeType: mutation.mimeType }
      : { kind: mutation.kind, path: mutation.path, parents: mutation.parents },
  });
}

function validateChoices(choices: unknown): asserts choices is readonly ConflictChoice[] {
  if (!Array.isArray(choices) || choices.length === 0 || choices.length > MAX_CHANGES_PER_OPERATION) throw new VersionHistoryError("Conflict resolution requires a non-empty valid request");
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null
      || typeof (choice as { reference?: unknown }).reference !== "string"
      || ((choice as { choice?: unknown }).choice !== "keep-current-file" && (choice as { choice?: unknown }).choice !== "keep-deleted")) {
      throw new VersionHistoryError("Conflict resolution request is invalid");
    }
  }
}

async function projectConflicts(state: SyncState, local: LocalVault): Promise<CurrentConflict[]> {
  return [...(await conflictMap(state, local, await scanFiles(local))).values()]
    .map(({ heads: _heads, ...conflict }) => conflict)
    .sort((left, right) => left.path.localeCompare(right.path) || left.reference.localeCompare(right.reference));
}

async function scanFiles(local: LocalVault): Promise<Map<string, LocalFile>> {
  return new Map((await local.scan()).map((file) => [file.path, file] as const));
}
