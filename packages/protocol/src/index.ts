export { mapLimit } from "./concurrency.js";
export { sha256 } from "./hash.js";
export { normalizeVaultPath } from "./path.js";
export { DestructiveSyncError } from "./engine.js";
export { PROTOCOL_VERSION, type LocalFile, type LocalVault, type RemoteVault, type StateRepository, type SyncOperation, type VaultDescriptor } from "./types.js";
export {
  createProtocol,
  type ConflictChoice,
  type ConflictReference,
  type CreateProtocolOptions,
  type CurrentConflict,
  type HistoricalVersion,
  type HistoricalVersionReference,
  type Protocol,
  type ProtocolBinding,
  type ProtocolOptions,
  type ProtocolSyncResult,
  type SyncEngineCapability,
  type VersionHistoryCapability,
  type VersionHistorySnapshot,
} from "./composition-root.js";
