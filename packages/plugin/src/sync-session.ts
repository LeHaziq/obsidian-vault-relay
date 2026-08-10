import {
  createProtocol,
  DestructiveSyncError,
  type ConflictChoice,
  type HistoricalVersionReference,
  type LocalVault,
  type Protocol,
  type RemoteVault,
  type StateRepository,
  type VersionHistorySnapshot,
} from "@vault-relay/protocol";
import type { DriveLayout, PluginSettings } from "./model";
import type { Notifier, SettingsStore } from "./ports";
import { redactTokens } from "./redact";

export interface Clock { now(): Date; }
export interface RemoteVaultSession { open(layout: DriveLayout): RemoteVault; }
export interface SessionAuth { disconnect(): Promise<void>; }

type DeepReadonly<T> = T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[] : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;
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

/** Application policy around one Protocol composition root. */
export class SyncSession<Auth extends SessionAuth> {
  private readonly mutableSettings: PluginSettings;
  private readonly protocol: Protocol;
  private inFlight: Promise<void> | null = null;
  private settingsTail: Promise<void> = Promise.resolve();
  private readonly aborter = new AbortController();
  private aborted = false;
  private syncing = false;
  private conflictCount = 0;
  private readonly statusListeners = new Set<() => void>();

  constructor(private readonly dependencies: SyncSessionDependencies<Auth>) {
    this.mutableSettings = dependencies.settings;
    this.protocol = createProtocol({
      local: dependencies.local,
      ...(this.mutableSettings.layout ? { binding: this.binding(this.mutableSettings.layout) } : {}),
      options: {
        signal: this.aborter.signal,
        consumeAllowLargeDeletes: async () => {
          const allowed = this.mutableSettings.allowLargeDeletesOnce;
          if (!allowed) return false;
          await this.persistSettings({ allowLargeDeletesOnce: false });
          return allowed;
        },
      },
    });
  }

  get isSyncing(): boolean { return this.syncing; }
  get hasConflicts(): boolean { return this.conflictCount > 0; }
  getSettings(): SettingsView { return this.mutableSettings; }
  setConnected(connected: boolean): void { this.mutableSettings.connected = connected; }

  /** Rehydrates retained Conflict status without starting synchronization. */
  async initializeStatus(): Promise<void> {
    if (!this.mutableSettings.layout) return;
    try {
      this.conflictCount = (await this.protocol.versionHistory.snapshot()).conflicts.length;
    } catch (error) {
      await this.reportError(error);
    }
    this.statusChanged();
  }

  async updatePreferences(changes: PreferenceChanges): Promise<void> {
    await this.persistSettings(changes);
  }

  onStatusChange(listener: () => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  async saveSettings(): Promise<void> { await this.persistSettings(); }

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
    this.inFlight = this.runSync(showNotice).finally(() => { this.inFlight = null; this.syncing = false; this.statusChanged(); });
    return this.inFlight;
  }

  abort(): void { this.aborted = true; this.aborter.abort(); }

  async rebind(layout: DriveLayout): Promise<void> {
    // The replacement repository must capture the state after an active sync
    // commits, not the state that existed when a queued rebind was requested.
    const activeSync = this.inFlight;
    if (activeSync) await activeSync;
    const current = this.mutableSettings.layout;
    const sameRemote = current !== null && current.vaultId === layout.vaultId && current.rootId === layout.rootId && current.blobsId === layout.blobsId && current.operationsId === layout.operationsId;
    const binding = this.binding(layout, sameRemote ? {} : { pendingLargeDeletionCount: 0 });
    await this.protocol.rebind(binding, { resetState: !sameRemote });
    if (sameRemote) await this.persistSettings({ layout });
    this.conflictCount = 0;
    this.statusChanged();
  }

  async disconnectAndSetRelay(relayUrl: string): Promise<void> {
    await this.protocol.unbind();
    if (this.mutableSettings.connected) await this.dependencies.auth.disconnect();
    this.mutableSettings.relayUrl = relayUrl;
    this.mutableSettings.connected = false;
    this.mutableSettings.layout = null;
    this.conflictCount = 0;
    await this.saveSettings();
    this.statusChanged();
  }

  versionHistorySnapshot(): Promise<VersionHistorySnapshot> { return this.protocol.versionHistory.snapshot(); }

  async restoreVersion(reference: HistoricalVersionReference): Promise<void> {
    if (!this.mutableSettings.layout) throw new Error("Set up a remote vault first");
    const restored = await this.protocol.versionHistory.restore(reference);
    this.dependencies.notifier.notice(`Restored ${restored.path}; sync to publish it as the current version`);
  }

  async resolveConflicts(choices: readonly ConflictChoice[]): Promise<void> {
    const activeSync = this.inFlight;
    const result = await this.protocol.versionHistory.resolveBatch(choices);
    if (result.paths.length > 0) {
      await activeSync;
      await this.syncNow(true);
    }
  }

  async approveLargeDeletion(): Promise<void> {
    const count = this.mutableSettings.pendingLargeDeletionCount;
    if (!count) return;
    this.mutableSettings.allowLargeDeletesOnce = true;
    await this.saveSettings();
    this.dependencies.notifier.notice(`Approved one sync that may trash ${count} files`);
    await this.syncNow(true);
  }

  async reportError(error: unknown): Promise<void> {
    if (isAbort(error)) return;
    this.mutableSettings.lastError = redactTokens(error instanceof Error ? error.message : String(error));
    if (!this.aborted) {
      try { await this.saveSettings(); } catch { /* Reporting must not hide the original failure. */ }
      this.dependencies.notifier.notice(`Vault Relay: ${this.mutableSettings.lastError}`);
      this.statusChanged();
    }
  }

  private binding(layout: DriveLayout, settingsOverrides: Partial<PluginSettings> = {}): { remote: RemoteVault; states: StateRepository } {
    const capturedLayout = structuredClone(layout);
    let initialized = false;
    let committedState: PluginSettings["syncState"];
    let initialOverrides = settingsOverrides;
    const state = (): PluginSettings["syncState"] => {
      if (!initialized) {
        committedState = structuredClone(this.mutableSettings.syncState);
        initialized = true;
      }
      return committedState;
    };
    return {
      remote: this.dependencies.remoteVaults.open(capturedLayout),
      states: {
        load: async () => structuredClone(state()),
        save: async (state) => {
          const candidateState = structuredClone(state) as PluginSettings["syncState"];
          await this.persistSettings({ ...initialOverrides, layout: capturedLayout, syncState: candidateState });
          committedState = candidateState;
          initialized = true;
          initialOverrides = {};
        },
      },
    };
  }

  private async persistSettings(overrides: Partial<PluginSettings> = {}): Promise<void> {
    await this.settingsExclusive(async () => {
      const committed = structuredClone({ ...this.mutableSettings, ...overrides }) as PluginSettings;
      await this.dependencies.settingsStore.save(committed);
      Object.assign(this.mutableSettings, committed);
    });
  }

  private async runSync(showNotice: boolean): Promise<void> {
    try {
      const result = await this.protocol.syncEngine.sync();
      this.mutableSettings.lastSyncAt = this.dependencies.clock.now().toISOString();
      this.mutableSettings.lastError = null;
      this.conflictCount = result.conflicts.length;
      this.mutableSettings.pendingLargeDeletionCount = 0;
      await this.saveSettings();
      if (showNotice) {
        const summary = `${result.uploadedOperations} uploaded, ${result.downloadedOperations} downloaded`;
        this.dependencies.notifier.notice(result.conflicts.length ? `${summary}; ${result.conflicts.length} conflict(s) preserved` : `Vault Relay synced: ${summary}`);
      }
    } catch (error) {
      if (error instanceof DestructiveSyncError) this.mutableSettings.pendingLargeDeletionCount = error.count;
      await this.reportError(error);
    }
  }

  private async settingsExclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.settingsTail.then(run, run);
    this.settingsTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private statusChanged(): void { for (const listener of this.statusListeners) listener(); }
}
