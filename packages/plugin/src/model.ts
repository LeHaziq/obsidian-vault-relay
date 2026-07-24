import { createInitialState, type Conflict, type SyncState } from "@vault-relay/protocol";

export interface DriveLayout {
  vaultId: string;
  rootId: string;
  blobsId: string;
  operationsId: string;
}

export interface PluginSettings {
  relayUrl: string;
  connected: boolean;
  paused: boolean;
  autoSyncMinutes: number;
  maxConcurrentRequests: number;
  exclusions: string[];
  layout: DriveLayout | null;
  syncState: SyncState;
  lastSyncAt: string | null;
  lastError: string | null;
  conflicts: Conflict[];
  allowLargeDeletesOnce: boolean;
  pendingLargeDeletionCount: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  relayUrl: "http://localhost:8787",
  connected: false,
  paused: false,
  autoSyncMinutes: 5,
  maxConcurrentRequests: 4,
  exclusions: [".obsidian/", ".trash/", ".DS_Store", "Thumbs.db"],
  layout: null,
  syncState: createInitialState(),
  lastSyncAt: null,
  lastError: null,
  conflicts: [],
  allowLargeDeletesOnce: false,
  pendingLargeDeletionCount: 0,
};
