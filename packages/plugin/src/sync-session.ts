import {
  appendChanges,
  createInitialState,
  DestructiveSyncError,
  headsForPath,
  sha256,
  SyncEngine,
  versionsByPath,
  type LocalVault,
  type Mutation,
  type RemoteVault,
  type StateRepository,
  type SyncState,
} from "@vault-relay/protocol";
import type { DriveLayout, PluginSettings } from "./model";
import type { Notifier, SettingsStore } from "./ports";
import { redactTokens } from "./redact";

export interface Clock {
  now(): Date;
}

export interface RemoteVaultSession {
  open(layout: DriveLayout): RemoteVault;
}

export interface SessionAuth {
  disconnect(): Promise<void>;
}

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type SettingsView = DeepReadonly<PluginSettings>;
export type PreferenceChanges = Partial<Pick<PluginSettings, "paused" | "autoSyncMinutes" | "maxConcurrentRequests" | "exclusions">>;

export interface SyncSessionDependencies<Auth> {
  settings: PluginSettings;
  settingsStore: SettingsStore;
  notifier: Notifier;
  local: LocalVault;
  auth: Auth;
  remoteVaults: RemoteVaultSession;
  clock: Clock;
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}

/** Owns every operation that must serialize access to sync state or the vault. */
export class SyncSession<Auth extends SessionAuth> {
  private readonly mutableSettings: PluginSettings;
  private inFlight: Promise<void> | null = null;
  private lock: Promise<void> = Promise.resolve();
  private aborter: AbortController | null = null;
  private aborted = false;
  private syncing = false;
  private readonly statusListeners = new Set<() => void>();

  constructor(private readonly dependencies: SyncSessionDependencies<Auth>) {
    this.mutableSettings = dependencies.settings;
  }

  get isSyncing(): boolean { return this.syncing; }

  getSettings(): SettingsView { return this.mutableSettings; }

  setConnected(connected: boolean): void {
    this.mutableSettings.connected = connected;
  }

  async updatePreferences(changes: PreferenceChanges): Promise<void> {
    await this.exclusive(async () => {
      Object.assign(this.mutableSettings, changes);
      await this.saveSettings();
    });
  }

  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async saveSettings(): Promise<void> {
    await this.dependencies.settingsStore.save(this.mutableSettings);
  }

  /** Concurrent callers receive the same promise and join the active run. */
  syncNow(showNotice: boolean): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.aborted) return Promise.resolve();
    if (this.mutableSettings.paused) {
      if (showNotice) this.dependencies.notifier.notice("Vault Relay is paused");
      return Promise.resolve();
    }
    if (!this.mutableSettings.connected || !this.mutableSettings.layout) {
      if (showNotice) this.dependencies.notifier.notice("Set up Vault Relay first");
      return Promise.resolve();
    }
    this.syncing = true;
    this.statusChanged();
    this.inFlight = this.exclusive(() => this.runSync(showNotice)).finally(() => {
      this.inFlight = null;
      this.syncing = false;
      this.statusChanged();
    });
    return this.inFlight;
  }

  /** Permanently stops this session and prevents an active engine from writing again. */
  abort(): void {
    this.aborted = true;
    this.aborter?.abort();
  }

  async rebind(layout: DriveLayout): Promise<void> {
    await this.exclusive(async () => {
      const current = this.mutableSettings.layout;
      const sameRemote = current !== null
        && current.vaultId === layout.vaultId
        && current.rootId === layout.rootId
        && current.blobsId === layout.blobsId
        && current.operationsId === layout.operationsId;
      this.mutableSettings.layout = layout;
      if (!sameRemote) {
        this.mutableSettings.syncState = createInitialState(this.mutableSettings.syncState.deviceId);
        this.mutableSettings.conflicts = [];
        this.mutableSettings.pendingLargeDeletionCount = 0;
      }
      await this.saveSettings();
    });
  }

  async disconnectAndSetRelay(relayUrl: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.mutableSettings.connected) await this.dependencies.auth.disconnect();
      this.mutableSettings.relayUrl = relayUrl;
      this.mutableSettings.connected = false;
      this.mutableSettings.layout = null;
      await this.saveSettings();
    });
  }

  async restoreVersion(path: string, blobHash: string): Promise<void> {
    if (!this.mutableSettings.layout) throw new Error("Set up a remote vault first");
    const layout = this.mutableSettings.layout;
    await this.exclusive(async () => {
      const remote = this.remote(layout);
      await this.dependencies.local.write(path, await remote.getBlob(blobHash));
    });
    this.dependencies.notifier.notice(`Restored ${path}; sync to publish it as the current version`);
  }

  async resolveConflict(path: string, keepCurrent: boolean): Promise<void> {
    await this.resolveConflicts([path], keepCurrent);
  }

  async resolveAllConflicts(): Promise<void> {
    await this.resolveConflicts(null);
  }

  async approveLargeDeletion(): Promise<void> {
    const count = this.mutableSettings.pendingLargeDeletionCount;
    if (!count) return;
    await this.exclusive(async () => {
      this.mutableSettings.allowLargeDeletesOnce = true;
      await this.saveSettings();
    });
    this.dependencies.notifier.notice(`Approved one sync that may trash ${count} files`);
    await this.syncNow(true);
  }

  private remote(layout: DriveLayout): RemoteVault {
    return this.dependencies.remoteVaults.open(layout);
  }

  private async runSync(showNotice: boolean): Promise<void> {
    const layout = this.mutableSettings.layout;
    if (!layout || this.aborted) return;
    const aborter = new AbortController();
    this.aborter = aborter;
    try {
      const states: StateRepository = {
        load: async () => structuredClone(this.mutableSettings.syncState),
        save: async (state: SyncState) => {
          this.mutableSettings.syncState = structuredClone(state);
          await this.saveSettings();
        },
      };
      const allowLargeDeletes = this.mutableSettings.allowLargeDeletesOnce;
      this.mutableSettings.allowLargeDeletesOnce = false;
      await this.saveSettings();
      const engine = new SyncEngine(this.dependencies.local, this.remote(layout), states, {
        allowLargeDeletes,
        signal: aborter.signal,
      });
      const result = await engine.sync();
      this.mutableSettings.lastSyncAt = this.dependencies.clock.now().toISOString();
      this.mutableSettings.lastError = null;
      this.mutableSettings.conflicts = result.conflicts;
      this.mutableSettings.pendingLargeDeletionCount = 0;
      await this.saveSettings();
      if (showNotice) {
        const summary = `${result.uploadedOperations} uploaded, ${result.downloadedOperations} downloaded`;
        this.dependencies.notifier.notice(result.conflicts.length
          ? `${summary}; ${result.conflicts.length} conflict(s) preserved`
          : `Vault Relay synced: ${summary}`);
      }
    } catch (error) {
      if (error instanceof DestructiveSyncError) this.mutableSettings.pendingLargeDeletionCount = error.count;
      await this.reportError(error);
    } finally {
      if (this.aborter === aborter) this.aborter = null;
    }
  }

  private async resolveConflicts(paths: string[] | null, keepCurrent?: boolean): Promise<void> {
    const resolved = await this.exclusive(async () => {
      const state = this.mutableSettings.syncState;
      const conflictPaths = [...new Set(paths ?? this.mutableSettings.conflicts.map((conflict) => conflict.path))];
      if (conflictPaths.length === 0) return false;
      const versions = versionsByPath(state.operations);
      const files = new Map((await this.dependencies.local.scan()).map((file) => [file.path, file] as const));
      const changes: Mutation[] = [];
      for (const path of conflictPaths) {
        const heads = headsForPath(versions, path).map((head) => head.operation.id);
        if (heads.length < 2) throw new Error(`${path} no longer has concurrent versions`);
        const file = files.get(path);
        const keepFile = keepCurrent ?? file !== undefined;
        if (keepFile) {
          if (!file) throw new Error("The current file does not exist; choose keep deleted instead");
          const content = await this.dependencies.local.read(path);
          changes.push({
            kind: "put",
            path,
            parents: heads,
            blobHash: await sha256(content),
            size: content.byteLength,
            mimeType: file.mimeType,
          });
        } else {
          changes.push({ kind: "delete", path, parents: heads });
        }
      }
      for (const change of changes) {
        if (change.kind === "delete") await this.dependencies.local.remove(change.path);
      }
      appendChanges(state, changes);
      await this.saveSettings();
      return true;
    });
    if (resolved) await this.syncNow(true);
  }

  async reportError(error: unknown): Promise<void> {
    if (isAbort(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    this.mutableSettings.lastError = redactTokens(message);
    if (!this.aborted) {
      try { await this.saveSettings(); } catch { /* Reporting must not mask the original failure. */ }
      this.dependencies.notifier.notice(`Vault Relay: ${this.mutableSettings.lastError}`);
      this.statusChanged();
    }
  }

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.lock;
    this.lock = previous.catch(() => undefined).then(() => gate);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
    }
  }

  private statusChanged(): void {
    for (const listener of this.statusListeners) listener();
  }
}
