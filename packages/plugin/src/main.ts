import { createInitialState, DestructiveSyncError, headsForVersions, PROTOCOL_VERSION, sha256, SyncEngine, versionsByPath, type StateRepository, type SyncOperation, type SyncState } from "@vault-relay/protocol";
import { Notice, Plugin, setIcon, TAbstractFile } from "obsidian";
import { GoogleAuth } from "./auth";
import { GoogleDriveRemote, type RemoteVaultSummary } from "./google-drive";
import { ObsidianLocalVault } from "./local-vault";
import { DEFAULT_SETTINGS, type PluginSettings } from "./model";
import { normalizeRelayOrigin } from "./relay-url";
import { ConflictModal, RestoreModal, SetupModal, VaultRelaySettingTab } from "./ui";

export default class VaultRelayPlugin extends Plugin {
  settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
  private auth!: GoogleAuth;
  private local!: ObsidianLocalVault;
  private statusEl!: HTMLElement;
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private timer: number | null = null;
  private debounce: number | null = null;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();
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
        new Notice(this.settings.paused ? "Vault Relay paused" : "Vault Relay resumed");
      },
    });

    this.registerObsidianProtocolHandler("vault-relay-auth", (params) => void this.handleAuthCallback(params.ticket, params.state));
    const onFileChanged = (file: TAbstractFile) => {
      if (!this.local.consumeSuppression(file.path)) this.scheduleSync();
    };
    this.registerEvent(this.app.vault.on("create", onFileChanged));
    this.registerEvent(this.app.vault.on("modify", onFileChanged));
    this.registerEvent(this.app.vault.on("delete", onFileChanged));
    this.registerEvent(this.app.vault.on("rename", onFileChanged));

    this.resetTimer();
    this.updateStatus();
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.connected && this.settings.layout && !this.settings.paused) void this.syncNow(false);
    });
  }

  onunload(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    if (this.debounce !== null) window.clearTimeout(this.debounce);
  }

  async connect(): Promise<void> {
    if (!this.settings.relayUrl) throw new Error("Configure the OAuth relay URL first");
    await this.auth.begin();
  }

  async updateRelayUrl(value: string): Promise<void> {
    let origin: string;
    try {
      origin = normalizeRelayOrigin(value.trim());
    } catch {
      return;
    }
    if (origin === this.settings.relayUrl) return;
    if (this.settings.connected) await this.auth.disconnect();
    this.settings.relayUrl = origin;
    this.settings.connected = false;
    this.settings.layout = null;
    await this.saveSettings();
    this.updateStatus();
  }

  async openSetup(): Promise<void> {
    if (!this.auth.isConnected()) {
      new Notice("Connect Google Drive first");
      return;
    }
    try {
      const remotes = await GoogleDriveRemote.list(this.auth);
      new SetupModal(this.app, this, remotes).open();
    } catch (error) {
      this.reportError(error);
    }
  }

  async createRemote(): Promise<void> {
    const created = await GoogleDriveRemote.create(this.auth, this.app.vault.getName());
    this.settings.layout = created.layout;
    this.settings.syncState = createInitialState(this.settings.syncState.deviceId);
    await this.saveSettings();
    await this.syncNow(true);
    new Notice("Remote vault created and initial upload completed");
  }

  async linkRemote(remote: RemoteVaultSummary): Promise<void> {
    this.settings.layout = remote.layout;
    this.settings.syncState = createInitialState(this.settings.syncState.deviceId);
    await this.saveSettings();
    await this.syncNow(true);
    new Notice(`Linked ${remote.name}`);
  }

  async syncNow(showNotice: boolean): Promise<void> {
    if (this.syncing) return;
    if (this.settings.paused) {
      if (showNotice) new Notice("Vault Relay is paused");
      return;
    }
    if (!this.settings.connected || !this.settings.layout) {
      if (showNotice) new Notice("Set up Vault Relay first");
      return;
    }

    this.syncing = true;
    this.updateStatus();
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
        new GoogleDriveRemote(this.auth, this.settings.layout, this.settings.maxConcurrentRequests),
        states,
        { allowLargeDeletes },
      );
      const result = await engine.sync();
      this.settings.lastSyncAt = new Date().toISOString();
      this.settings.lastError = null;
      this.settings.conflicts = result.conflicts;
      this.settings.pendingLargeDeletionCount = 0;
      await this.saveSettings();
      if (showNotice) {
        const summary = `${result.uploadedOperations} uploaded, ${result.downloadedOperations} downloaded`;
        new Notice(result.conflicts.length ? `${summary}; ${result.conflicts.length} conflict(s) preserved` : `Vault Relay synced: ${summary}`);
      }
    } catch (error) {
      if (error instanceof DestructiveSyncError) this.settings.pendingLargeDeletionCount = error.count;
      this.reportError(error);
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }

  async restoreVersion(path: string, blobHash: string): Promise<void> {
    if (!this.settings.layout) throw new Error("Set up a remote vault first");
    const remote = new GoogleDriveRemote(this.auth, this.settings.layout, this.settings.maxConcurrentRequests);
    await this.local.write(path, await remote.getBlob(blobHash));
    new Notice(`Restored ${path}; sync to publish it as the current version`);
    this.scheduleSync();
  }

  async resolveConflict(path: string, keepCurrent: boolean): Promise<void> {
    const state = this.settings.syncState;
    const heads = headsForVersions(versionsByPath(state.operations).get(path) ?? new Map()).map((head) => head.operation.id);
    if (heads.length < 2) throw new Error("This path no longer has concurrent versions");
    const sequence = state.nextSequence;
    let changes: SyncOperation["changes"];
    if (keepCurrent) {
      const file = (await this.local.scan()).find((candidate) => candidate.path === path);
      if (!file) throw new Error("The current file does not exist; choose keep deleted instead");
      const content = await this.local.read(path);
      const hash = await sha256(content);
      changes = [{ kind: "put", path, parents: heads, blobHash: hash, size: content.byteLength, mimeType: file.mimeType }];
    } else {
      await this.local.remove(path);
      changes = [{ kind: "delete", path, parents: heads }];
    }
    state.pending.push({
      protocolVersion: PROTOCOL_VERSION,
      id: `${state.deviceId}-${sequence.toString(36)}-${crypto.randomUUID()}`,
      deviceId: state.deviceId,
      sequence,
      createdAt: new Date().toISOString(),
      changes,
    });
    state.nextSequence += 1;
    await this.saveSettings();
    await this.syncNow(true);
  }

  async approveLargeDeletion(): Promise<void> {
    const count = this.settings.pendingLargeDeletionCount;
    if (!count) return;
    this.settings.allowLargeDeletesOnce = true;
    await this.saveSettings();
    new Notice(`Approved one sync that may trash ${count} files`);
    await this.syncNow(true);
  }

  resetTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.syncNow(false), Math.max(1, this.settings.autoSyncMinutes) * 60_000);
    this.registerInterval(this.timer);
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
    await this.saveData(this.settings);
  }

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...loaded,
      syncState: loaded?.syncState ?? createInitialState(),
      exclusions: loaded?.exclusions ?? [...DEFAULT_SETTINGS.exclusions],
      conflicts: loaded?.conflicts ?? [],
    };
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
    this.statusEl.addEventListener("click", open);
    this.statusEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open();
    });
    setIcon(this.statusDot, "circle");
  }

  private scheduleSync(): void {
    if (this.settings.paused || !this.settings.layout) return;
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => void this.syncNow(false), 2_000);
  }

  private async handleAuthCallback(ticket?: string, state?: string): Promise<void> {
    if (!ticket || !state) {
      new Notice("Google sign-in returned an invalid response");
      return;
    }
    try {
      await this.auth.complete(ticket, state);
      this.settings.connected = true;
      await this.saveSettings();
      new Notice("Google Drive connected");
      await this.openSetup();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.settings.lastError = message.replace(/1\/[\w-]+|ya29\.[\w-]+/g, "[redacted]");
    void this.saveSettings();
    new Notice(`Vault Relay: ${this.settings.lastError}`);
    this.updateStatus();
  }
}
