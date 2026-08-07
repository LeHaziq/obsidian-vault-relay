import { appendChanges, createInitialState, DestructiveSyncError, headsForPath, sha256, SyncEngine, versionsByPath, type Mutation, type StateRepository, type SyncState } from "@vault-relay/protocol";
import { Plugin, setIcon } from "obsidian";
import { GoogleAuth } from "./auth";
import { GoogleDriveRemote, type RemoteVaultSummary } from "./google-drive";
import { ObsidianLocalVault } from "./local-vault";
import { DEFAULT_SETTINGS, type DriveLayout, type PluginSettings } from "./model";
import { ObsidianNotifier, ObsidianSettingsStore } from "./obsidian-ports";
import type { Notifier, SettingsStore } from "./ports";
import { redactTokens } from "./redact";
import { normalizeRelayOrigin } from "./relay-url";
import { AuthorizationModal, ConflictModal, RestoreModal, SetupModal, VaultRelaySettingTab } from "./ui";

export interface RelayUrlChange {
  applied: boolean;
  error?: string;
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}

export default class VaultRelayPlugin extends Plugin {
  settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
  // The plugin shell is the only place that knows these are the Obsidian ones.
  // Everything else, here and in ui.ts, reaches persistence and the user
  // through the ports rather than through the Obsidian plugin base class.
  readonly notifier: Notifier = new ObsidianNotifier();
  private readonly settingsStore: SettingsStore = new ObsidianSettingsStore(this);
  private auth!: GoogleAuth;
  private local!: ObsidianLocalVault;
  private statusEl!: HTMLElement;
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private timer: number | null = null;
  private inFlight: Promise<void> | null = null;
  private lock: Promise<void> | null = null;
  private aborter: AbortController | null = null;
  private syncing = false;
  private unloading = false;

  async onload(): Promise<void> {
    this.settings = await this.settingsStore.load();
    this.auth = new GoogleAuth(this.app, () => this.settings.relayUrl);
    this.local = new ObsidianLocalVault(this.app.vault, () => this.settings.exclusions, () => this.settings.maxConcurrentRequests);
    this.settings.connected = this.auth.isConnected();

    const ribbon = this.addRibbonIcon("refresh-cw", "Sync with Vault Relay", () => void this.syncNow(true));
    ribbon.setAttribute("aria-label", "Sync with Vault Relay");
    this.createStatusBar();
    this.addSettingTab(new VaultRelaySettingTab(this.app, this));

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow(true) });
    this.addCommand({ id: "show-conflicts", name: "Show conflicts", callback: () => new ConflictModal(this.app, this).open() });
    this.addCommand({ id: "restore-version", name: "Restore a historical version", callback: () => new RestoreModal(this.app, this).open() });
    this.addCommand({
      id: "approve-large-deletion",
      name: "Review and apply blocked bulk deletions once",
      checkCallback: (checking) => {
        if (this.settings.pendingLargeDeletionCount === 0) return false;
        if (!checking) void this.approveLargeDeletion();
        return true;
      },
    });
    this.addCommand({ id: "setup", name: "Set up or change remote vault", callback: () => void this.openSetup() });
    this.addCommand({
      id: "toggle-pause",
      name: "Pause or resume sync",
      callback: async () => {
        this.settings.paused = !this.settings.paused;
        await this.saveSettings();
        this.updateStatus();
        this.notifier.notice(this.settings.paused ? "Vault Relay paused" : "Vault Relay resumed");
      },
    });

    this.registerObsidianProtocolHandler("vault-relay-auth", (params) => void this.handleAuthCallback(params.ticket, params.state));
    this.resetTimer();
    this.updateStatus();
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.connected && this.settings.layout && !this.settings.paused) void this.syncNow(false);
    });
  }

  onunload(): void {
    this.unloading = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    // Without this a sync in progress keeps writing vault files and calling
    // saveData after the plugin has been torn down.
    this.aborter?.abort();
  }

  async connect(): Promise<void> {
    try {
      if (!this.settings.relayUrl) throw new Error("Configure the OAuth relay URL first");
      const authorizationUrl = await this.auth.prepareAuthorization();
      new AuthorizationModal(this.app, authorizationUrl).open();
    } catch (error) {
      await this.reportError(error);
    }
  }

  /**
   * Applies a relay URL change. The caller commits on blur rather than on each
   * keystroke: partial input such as "https://a" parses as a valid origin, so
   * per-keystroke handling silently disconnected Google and unbound the remote
   * vault while the user was still typing.
   */
  async updateRelayUrl(value: string, confirmDisconnect: () => Promise<boolean>): Promise<RelayUrlChange> {
    let origin: string;
    try {
      origin = normalizeRelayOrigin(value.trim());
    } catch (error) {
      return { applied: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (origin === this.settings.relayUrl) return { applied: true };
    if ((this.settings.connected || this.settings.layout !== null) && !(await confirmDisconnect())) {
      return { applied: false };
    }
    await this.exclusive(async () => {
      if (this.settings.connected) await this.auth.disconnect();
      this.settings.relayUrl = origin;
      this.settings.connected = false;
      this.settings.layout = null;
      await this.saveSettings();
    });
    this.updateStatus();
    return { applied: true };
  }

  async openSetup(): Promise<void> {
    if (!this.auth.isConnected()) {
      this.notifier.notice("Connect Google Drive first");
      return;
    }
    try {
      const remotes = await GoogleDriveRemote.list(this.auth);
      new SetupModal(this.app, this, remotes).open();
    } catch (error) {
      await this.reportError(error);
    }
  }

  async createRemote(): Promise<void> {
    const created = await GoogleDriveRemote.create(this.auth, this.app.vault.getName());
    await this.rebind(created.layout);
    await this.syncNow(true);
    this.notifier.notice("Remote vault created and initial upload completed");
  }

  async linkRemote(remote: RemoteVaultSummary): Promise<void> {
    await this.rebind(remote.layout);
    await this.syncNow(true);
    this.notifier.notice(`Linked ${remote.name}`);
  }

  /** Swapping the remote store resets sync state, so no sync may be in flight. */
  private async rebind(layout: DriveLayout): Promise<void> {
    await this.exclusive(async () => {
      const current = this.settings.layout;
      const sameRemote = current !== null
        && current.vaultId === layout.vaultId
        && current.rootId === layout.rootId
        && current.blobsId === layout.blobsId
        && current.operationsId === layout.operationsId;
      this.settings.layout = layout;
      if (!sameRemote) {
        this.settings.syncState = createInitialState(this.settings.syncState.deviceId);
        this.settings.conflicts = [];
        this.settings.pendingLargeDeletionCount = 0;
      }
      await this.saveSettings();
    });
  }

  /** Coalescing: concurrent callers join the running sync instead of no-oping. */
  syncNow(showNotice: boolean): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.unloading) return Promise.resolve();
    if (this.settings.paused) {
      if (showNotice) this.notifier.notice("Vault Relay is paused");
      return Promise.resolve();
    }
    if (!this.settings.connected || !this.settings.layout) {
      if (showNotice) this.notifier.notice("Set up Vault Relay first");
      return Promise.resolve();
    }
    this.syncing = true;
    this.updateStatus();
    this.inFlight = this.exclusive(() => this.runSync(showNotice)).finally(() => {
      this.inFlight = null;
      this.syncing = false;
      this.updateStatus();
    });
    return this.inFlight;
  }

  private async runSync(showNotice: boolean): Promise<void> {
    const layout = this.settings.layout;
    // Both can change while this call waits its turn behind the lock.
    if (!layout || this.unloading) return;
    const aborter = new AbortController();
    this.aborter = aborter;
    try {
      const states: StateRepository = {
        load: async () => structuredClone(this.settings.syncState),
        save: async (state: SyncState) => {
          this.settings.syncState = structuredClone(state);
          await this.saveSettings();
        },
      };
      const allowLargeDeletes = this.settings.allowLargeDeletesOnce;
      this.settings.allowLargeDeletesOnce = false;
      await this.saveSettings();
      const engine = new SyncEngine(
        this.local,
        new GoogleDriveRemote(this.auth, layout, this.settings.maxConcurrentRequests),
        states,
        { allowLargeDeletes, signal: aborter.signal },
      );
      const result = await engine.sync();
      this.settings.lastSyncAt = new Date().toISOString();
      this.settings.lastError = null;
      this.settings.conflicts = result.conflicts;
      this.settings.pendingLargeDeletionCount = 0;
      await this.saveSettings();
      if (showNotice) {
        const summary = `${result.uploadedOperations} uploaded, ${result.downloadedOperations} downloaded`;
        this.notifier.notice(result.conflicts.length ? `${summary}; ${result.conflicts.length} conflict(s) preserved` : `Vault Relay synced: ${summary}`);
      }
    } catch (error) {
      if (error instanceof DestructiveSyncError) this.settings.pendingLargeDeletionCount = error.count;
      await this.reportError(error);
    } finally {
      if (this.aborter === aborter) this.aborter = null;
    }
  }

  async restoreVersion(path: string, blobHash: string): Promise<void> {
    if (!this.settings.layout) throw new Error("Set up a remote vault first");
    const layout = this.settings.layout;
    await this.exclusive(async () => {
      const remote = new GoogleDriveRemote(this.auth, layout, this.settings.maxConcurrentRequests);
      await this.local.write(path, await remote.getBlob(blobHash));
    });
    this.notifier.notice(`Restored ${path}; sync to publish it as the current version`);
  }

  async resolveConflict(path: string, keepCurrent: boolean): Promise<void> {
    await this.resolveConflicts([path], keepCurrent);
  }

  async resolveAllConflicts(): Promise<void> {
    await this.resolveConflicts(null);
  }

  private async resolveConflicts(paths: string[] | null, keepCurrent?: boolean): Promise<void> {
    // A running sync overwrites settings.syncState wholesale when it
    // checkpoints, so mutating it concurrently silently dropped the resolution.
    const resolved = await this.exclusive(async () => {
      const state = this.settings.syncState;
      const conflictPaths = [...new Set(paths ?? this.settings.conflicts.map((conflict) => conflict.path))];
      if (conflictPaths.length === 0) return false;
      const versions = versionsByPath(state.operations);
      const files = new Map((await this.local.scan()).map((file) => [file.path, file] as const));
      const changes: Mutation[] = [];
      for (const path of conflictPaths) {
        const heads = headsForPath(versions, path).map((head) => head.operation.id);
        if (heads.length < 2) throw new Error(`${path} no longer has concurrent versions`);
        const file = files.get(path);
        const keepFile = keepCurrent ?? file !== undefined;
        if (keepFile) {
          if (!file) throw new Error("The current file does not exist; choose keep deleted instead");
          const content = await this.local.read(path);
          const hash = await sha256(content);
          changes.push({ kind: "put", path, parents: heads, blobHash: hash, size: content.byteLength, mimeType: file.mimeType });
        } else {
          changes.push({ kind: "delete", path, parents: heads });
        }
      }
      for (const change of changes) {
        if (change.kind === "delete") await this.local.remove(change.path);
      }
      appendChanges(state, changes);
      await this.saveSettings();
      return true;
    });
    if (resolved) await this.syncNow(true);
  }

  async approveLargeDeletion(): Promise<void> {
    const count = this.settings.pendingLargeDeletionCount;
    if (!count) return;
    await this.exclusive(async () => {
      this.settings.allowLargeDeletesOnce = true;
      await this.saveSettings();
    });
    this.notifier.notice(`Approved one sync that may trash ${count} files`);
    await this.syncNow(true);
  }

  resetTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    if (this.unloading) return;
    const minutes = Math.min(1_440, Math.max(1, this.settings.autoSyncMinutes));
    // onunload clears this directly; registerInterval would accumulate a stale
    // handle every time the interval setting changed.
    this.timer = window.setInterval(() => void this.syncNow(false), minutes * 60_000);
  }

  updateStatus(): void {
    if (!this.statusEl) return;
    this.statusDot.className = "vault-relay-status__dot";
    if (this.syncing) {
      this.statusDot.addClass("is-syncing");
      this.statusText.setText("Vault Relay: syncing");
    } else if (this.settings.lastError) {
      this.statusDot.addClass("is-error");
      this.statusText.setText("Vault Relay: error");
    } else if (this.settings.conflicts.length) {
      this.statusDot.addClass("is-conflict");
      this.statusText.setText(`Vault Relay: ${this.settings.conflicts.length} conflict(s)`);
    } else if (this.settings.paused) {
      this.statusText.setText("Vault Relay: paused");
    } else if (!this.settings.layout) {
      this.statusText.setText("Vault Relay: setup needed");
    } else {
      this.statusText.setText("Vault Relay: ready");
    }
  }

  async saveSettings(): Promise<void> {
    await this.settingsStore.save(this.settings);
  }

  /**
   * Serializes everything that touches sync state or the vault. Without it a
   * scheduled sync can interleave with conflict resolution or a restore and
   * overwrite settings.syncState from its own snapshot.
   */
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    while (this.lock) await this.lock.catch(() => undefined);
    let release = (): void => undefined;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    try {
      return await run();
    } finally {
      this.lock = null;
      release();
    }
  }

  private createStatusBar(): void {
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("vault-relay-status");
    this.statusEl.setAttribute("role", "button");
    this.statusEl.setAttribute("tabindex", "0");
    this.statusEl.setAttribute("aria-label", "Open Vault Relay conflicts");
    this.statusDot = this.statusEl.createSpan({ cls: "vault-relay-status__dot" });
    this.statusText = this.statusEl.createSpan();
    const open = () => new ConflictModal(this.app, this).open();
    this.registerDomEvent(this.statusEl, "click", open);
    this.registerDomEvent(this.statusEl, "keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    setIcon(this.statusDot, "circle");
  }

  private async handleAuthCallback(ticket?: string, state?: string): Promise<void> {
    if (!ticket || !state) {
      this.notifier.notice("Google sign-in returned an invalid response");
      return;
    }
    try {
      await this.auth.complete(ticket, state);
      this.settings.connected = true;
      await this.saveSettings();
      this.notifier.notice("Google Drive connected");
      await this.openSetup();
    } catch (error) {
      await this.reportError(error);
    }
  }

  private async reportError(error: unknown): Promise<void> {
    // An abort is the expected outcome of unloading, not a failure to record.
    if (isAbort(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    this.settings.lastError = redactTokens(message);
    if (!this.unloading) {
      try {
        await this.saveSettings();
      } catch {
        // Reporting must not mask the original failure.
      }
      this.notifier.notice(`Vault Relay: ${this.settings.lastError}`);
      this.updateStatus();
    }
  }
}
