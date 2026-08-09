import { Plugin, setIcon } from "obsidian";
import { GoogleAuth } from "./auth";
import { GoogleDriveRemote, type RemoteVaultSummary } from "./google-drive";
import { ObsidianLocalVault } from "./local-vault";
import { ObsidianNotifier, ObsidianSettingsStore } from "./obsidian-ports";
import type { Notifier, SettingsStore } from "./ports";
import { normalizeRelayOrigin } from "./relay-url";
import { SyncSession, type PreferenceChanges, type SettingsView } from "./sync-session";
import { AuthorizationModal, ConflictModal, RestoreModal, SetupModal, VaultRelaySettingTab } from "./ui";

export interface RelayUrlChange {
  applied: boolean;
  error?: string;
}

export default class VaultRelayPlugin extends Plugin {
  // The plugin shell is the only place that knows these are the Obsidian ones.
  // Everything else, here and in ui.ts, reaches persistence and the user
  // through the ports rather than through the Obsidian plugin base class.
  readonly notifier: Notifier = new ObsidianNotifier();
  private readonly settingsStore: SettingsStore = new ObsidianSettingsStore(this);
  private auth!: GoogleAuth;
  private local!: ObsidianLocalVault;
  private session!: SyncSession<GoogleAuth>;
  private statusEl!: HTMLElement;
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private timer: number | null = null;
  private unloading = false;

  getSettings(): SettingsView { return this.session.getSettings(); }

  async onload(): Promise<void> {
    const settings = await this.settingsStore.load();
    this.auth = new GoogleAuth(this.app, () => this.session.getSettings().relayUrl);
    this.local = new ObsidianLocalVault(this.app.vault, () => [...this.session.getSettings().exclusions], () => this.session.getSettings().maxConcurrentRequests);
    this.session = new SyncSession({
      settings,
      settingsStore: this.settingsStore,
      notifier: this.notifier,
      local: this.local,
      auth: this.auth,
      remoteVaults: { create: (auth, layout, concurrency) => new GoogleDriveRemote(auth, layout, concurrency) },
      clock: { now: () => new Date() },
    });
    this.session.onStatusChange(() => this.updateStatus());
    this.session.setConnected(this.auth.isConnected());

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
        if (this.session.getSettings().pendingLargeDeletionCount === 0) return false;
        if (!checking) void this.approveLargeDeletion();
        return true;
      },
    });
    this.addCommand({ id: "setup", name: "Set up or change remote vault", callback: () => void this.openSetup() });
    this.addCommand({
      id: "toggle-pause",
      name: "Pause or resume sync",
      callback: async () => {
        const paused = !this.session.getSettings().paused;
        await this.session.updatePreferences({ paused });
        this.updateStatus();
        this.notifier.notice(paused ? "Vault Relay paused" : "Vault Relay resumed");
      },
    });

    this.registerObsidianProtocolHandler("vault-relay-auth", (params) => void this.handleAuthCallback(params.ticket, params.state));
    this.resetTimer();
    this.updateStatus();
    this.app.workspace.onLayoutReady(() => {
      if (this.session.getSettings().connected && this.session.getSettings().layout && !this.session.getSettings().paused) void this.syncNow(false);
    });
  }

  onunload(): void {
    this.unloading = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    // Without this a sync in progress keeps writing vault files and calling
    // saveData after the plugin has been torn down.
    this.session.abort();
  }

  async connect(): Promise<void> {
    try {
      if (!this.session.getSettings().relayUrl) throw new Error("Configure the OAuth relay URL first");
      const authorizationUrl = await this.auth.prepareAuthorization();
      new AuthorizationModal(this.app, authorizationUrl).open();
    } catch (error) {
      await this.session.reportError(error);
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
    if (origin === this.session.getSettings().relayUrl) return { applied: true };
    if ((this.session.getSettings().connected || this.session.getSettings().layout !== null) && !(await confirmDisconnect())) {
      return { applied: false };
    }
    await this.session.disconnectAndSetRelay(origin);
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
      await this.session.reportError(error);
    }
  }

  async createRemote(): Promise<void> {
    const created = await GoogleDriveRemote.create(this.auth, this.app.vault.getName());
    await this.session.rebind(created.layout);
    await this.syncNow(true);
    this.notifier.notice("Remote vault created and initial upload completed");
  }

  async linkRemote(remote: RemoteVaultSummary): Promise<void> {
    await this.session.rebind(remote.layout);
    await this.syncNow(true);
    this.notifier.notice(`Linked ${remote.name}`);
  }

  syncNow(showNotice: boolean): Promise<void> {
    const sync = this.session.syncNow(showNotice);
    this.updateStatus();
    return sync;
  }

  async restoreVersion(path: string, blobHash: string): Promise<void> {
    await this.session.restoreVersion(path, blobHash);
  }

  async resolveConflict(path: string, keepCurrent: boolean): Promise<void> {
    await this.session.resolveConflict(path, keepCurrent);
  }

  async resolveAllConflicts(): Promise<void> {
    await this.session.resolveAllConflicts();
  }

  async approveLargeDeletion(): Promise<void> {
    await this.session.approveLargeDeletion();
  }

  async updatePreferences(changes: PreferenceChanges): Promise<void> {
    await this.session.updatePreferences(changes);
  }

  resetTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    if (this.unloading) return;
    const minutes = Math.min(1_440, Math.max(1, this.session.getSettings().autoSyncMinutes));
    // onunload clears this directly; registerInterval would accumulate a stale
    // handle every time the interval setting changed.
    this.timer = window.setInterval(() => void this.syncNow(false), minutes * 60_000);
  }

  updateStatus(): void {
    if (!this.statusEl) return;
    this.statusDot.className = "vault-relay-status__dot";
    if (this.session.isSyncing) {
      this.statusDot.addClass("is-syncing");
      this.statusText.setText("Vault Relay: syncing");
    } else if (this.session.getSettings().lastError) {
      this.statusDot.addClass("is-error");
      this.statusText.setText("Vault Relay: error");
    } else if (this.session.getSettings().conflicts.length) {
      this.statusDot.addClass("is-conflict");
      this.statusText.setText(`Vault Relay: ${this.session.getSettings().conflicts.length} conflict(s)`);
    } else if (this.session.getSettings().paused) {
      this.statusText.setText("Vault Relay: paused");
    } else if (!this.session.getSettings().layout) {
      this.statusText.setText("Vault Relay: setup needed");
    } else {
      this.statusText.setText("Vault Relay: ready");
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
      this.session.setConnected(true);
      await this.session.saveSettings();
      this.notifier.notice("Google Drive connected");
      await this.openSetup();
    } catch (error) {
      await this.session.reportError(error);
    }
  }

}
