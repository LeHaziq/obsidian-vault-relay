import { safeRelayOrigin } from "./relay-url";

/** A persisted value that only Protocol is allowed to interpret. */
export type OpaqueProtocolState = unknown;

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
  /** Opaque persisted Protocol state. The plugin never inspects it. */
  syncState: OpaqueProtocolState;
  lastSyncAt: string | null;
  lastError: string | null;
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
  syncState: undefined,
  lastSyncAt: null,
  lastError: null,
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
    // Protocol parses and initializes this persisted value when it runs.
    syncState: source.syncState,
    lastSyncAt: text(source.lastSyncAt, null, 64),
    lastError: text(source.lastError, null),
    allowLargeDeletesOnce: boolean(source.allowLargeDeletesOnce, false),
    pendingLargeDeletionCount: integer(source.pendingLargeDeletionCount, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}
