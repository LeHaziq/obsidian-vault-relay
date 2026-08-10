export const PROTOCOL_VERSION = 1 as const;

export interface VaultDescriptor {
  protocolVersion: typeof PROTOCOL_VERSION;
  vaultId: string;
  createdAt: string;
  name: string;
  encryption: null | { codec: string; keyVersion: number };
}

export interface PutMutation {
  kind: "put";
  path: string;
  parents: string[];
  blobHash: string;
  size: number;
  mimeType: string;
}

export interface DeleteMutation {
  kind: "delete";
  path: string;
  parents: string[];
}

export type Mutation = PutMutation | DeleteMutation;

export interface SyncOperation {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  deviceId: string;
  sequence: number;
  createdAt: string;
  changes: Mutation[];
}

export interface MaterializedFile {
  hash: string;
  operationId: string;
}

export interface SyncState {
  protocolVersion: typeof PROTOCOL_VERSION;
  deviceId: string;
  nextSequence: number;
  cursor: string | null;
  operations: Record<string, SyncOperation>;
  materialized: Record<string, MaterializedFile>;
  pending: SyncOperation[];
  /**
   * Timestamp of the last full remote-operation repair pass. Optional so states
   * written by earlier versions still load; absent means "repair on next sync".
   */
  lastRepairAt?: number | null;
}

export interface LocalFile {
  path: string;
  hash: string;
  size: number;
  mimeType: string;
}

export interface LocalVault {
  scan(): Promise<LocalFile[]>;
  isManaged(path: string): boolean;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, content: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface RemoteVault {
  pullOperations(cursor: string | null): Promise<{ operations: SyncOperation[]; cursor: string }>;
  hasBlob(hash: string): Promise<boolean>;
  putBlob(hash: string, content: ArrayBuffer, mimeType: string): Promise<void>;
  getBlob(hash: string): Promise<ArrayBuffer>;
  putOperation(operation: SyncOperation): Promise<void>;
  ensureOperations(operations: SyncOperation[]): Promise<void>;
}

export interface StateRepository {
  /** Protocol state is intentionally opaque to adapters and callers. */
  load(): Promise<unknown>;
  save(state: unknown): Promise<void>;
}

export interface Conflict {
  path: string;
  heads: string[];
  conflictPaths: string[];
}

export interface SyncResult {
  uploadedOperations: number;
  downloadedOperations: number;
  writtenFiles: number;
  removedFiles: number;
  conflicts: Conflict[];
}

export interface SyncEngineOptions {
  allowLargeDeletes?: boolean;
  retainedVersionsPerPath?: number;
  /** How often to re-upload locally retained operations missing from the remote store. */
  repairIntervalMs?: number;
  /** Persist materialization progress after this many files. */
  checkpointEveryFiles?: number;
  /** Persist materialization progress after this many milliseconds. */
  checkpointEveryMs?: number;
  /** Aborts an in-flight sync between steps, e.g. when the plugin unloads. */
  signal?: AbortSignal;
}
