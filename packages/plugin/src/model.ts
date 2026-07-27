import { createInitialState, PROTOCOL_VERSION, type Conflict, type SyncState } from "@vault-relay/protocol";
import { safeRelayOrigin } from "./relay-url";

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

export const SYNC_INTERVAL_CHOICES = [1, 5, 15, 30, 60] as const;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function text(value: unknown, fallback: string | null, maxLength = 2_000): string | null {
  return typeof value === "string" && value.length <= maxLength ? value : fallback;
}

function layout(value: unknown): DriveLayout | null {
  if (!isRecord(value)) return null;
  const fields = ["vaultId", "rootId", "blobsId", "operationsId"] as const;
  if (!fields.every((field) => typeof value[field] === "string" && (value[field] as string).length > 0)) return null;
  return { vaultId: value.vaultId as string, rootId: value.rootId as string, blobsId: value.blobsId as string, operationsId: value.operationsId as string };
}

function conflicts(value: unknown): Conflict[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") return [];
    const heads = Array.isArray(entry.heads) ? entry.heads.filter((head): head is string => typeof head === "string") : [];
    const conflictPaths = Array.isArray(entry.conflictPaths) ? entry.conflictPaths.filter((path): path is string => typeof path === "string") : [];
    return [{ path: entry.path, heads, conflictPaths }];
  });
}

/**
 * A hand-edited or truncated data.json previously flowed straight into the
 * plugin: a non-numeric interval became NaN and setInterval then fired
 * continuously. Everything persisted is treated as untrusted here.
 */
function syncState(value: unknown): SyncState {
  if (!isRecord(value)) return createInitialState();
  const deviceId = typeof value.deviceId === "string" && value.deviceId.length > 0 && value.deviceId.length <= 200 ? value.deviceId : undefined;
  const fresh = createInitialState(deviceId);
  if (value.protocolVersion !== PROTOCOL_VERSION) return fresh;
  if (!isRecord(value.operations) || !isRecord(value.materialized) || !Array.isArray(value.pending)) return fresh;
  const nextSequence = integer(value.nextSequence, 1, 1, Number.MAX_SAFE_INTEGER);
  const lastRepairAt = typeof value.lastRepairAt === "number" && Number.isFinite(value.lastRepairAt) ? value.lastRepairAt : null;
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: fresh.deviceId,
    nextSequence,
    cursor: text(value.cursor, null, 4_000),
    // Operation and mutation shapes are validated by the engine on every sync.
    operations: value.operations as SyncState["operations"],
    materialized: value.materialized as SyncState["materialized"],
    pending: value.pending as SyncState["pending"],
    lastRepairAt,
  };
}

export function sanitizeSettings(loaded: unknown): PluginSettings {
  const source = isRecord(loaded) ? loaded : {};
  const relayUrl = typeof source.relayUrl === "string" ? safeRelayOrigin(source.relayUrl) : null;
  const exclusions = Array.isArray(source.exclusions)
    ? source.exclusions.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()).slice(0, 500)
    : [...DEFAULT_SETTINGS.exclusions];
  const resolvedLayout = layout(source.layout);
  return {
    relayUrl: relayUrl ?? DEFAULT_SETTINGS.relayUrl,
    // Trusting a stale "connected" flag shows a connected UI with no credential;
    // main.ts re-derives it from SecretStorage during load.
    connected: boolean(source.connected, false),
    paused: boolean(source.paused, false),
    autoSyncMinutes: integer(source.autoSyncMinutes, DEFAULT_SETTINGS.autoSyncMinutes, 1, 1_440),
    maxConcurrentRequests: integer(source.maxConcurrentRequests, DEFAULT_SETTINGS.maxConcurrentRequests, MIN_CONCURRENCY, MAX_CONCURRENCY),
    exclusions,
    layout: resolvedLayout,
    syncState: syncState(source.syncState),
    lastSyncAt: text(source.lastSyncAt, null, 64),
    lastError: text(source.lastError, null),
    conflicts: conflicts(source.conflicts),
    allowLargeDeletesOnce: boolean(source.allowLargeDeletesOnce, false),
    pendingLargeDeletionCount: integer(source.pendingLargeDeletionCount, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}
