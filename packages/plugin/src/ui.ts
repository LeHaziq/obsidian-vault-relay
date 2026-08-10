import { App, Modal, PluginSettingTab, Setting } from "obsidian";
import type { VersionHistorySnapshot } from "@vault-relay/protocol";
import type VaultRelayPlugin from "./main";
import { MAX_CONCURRENCY, MIN_CONCURRENCY, SYNC_INTERVAL_CHOICES } from "./model";
import type { RemoteVaultSummary } from "./remote-vault-session";

export class ConfirmModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly body: string,
    private readonly confirmText: string,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.body });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText(this.confirmText).setWarning().onClick(() => {
        this.decided = true;
        this.resolve(true);
        this.close();
      }));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.resolve(false);
  }
}

function confirmAction(app: App, title: string, body: string, confirmText: string): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, title, body, confirmText, resolve).open());
}

async function loadVersionHistory(plugin: VaultRelayPlugin, content: HTMLElement, unavailable: string): Promise<VersionHistorySnapshot | null> {
  try {
    return await plugin.versionHistorySnapshot();
  } catch (error) {
    content.createEl("p", { text: unavailable });
    plugin.notifier.notice(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export class AuthorizationModal extends Modal {
  constructor(app: App, private readonly authorizationUrl: string) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Connect Google Drive");
    this.contentEl.createEl("p", {
      text: "Continue in your system browser to sign in with Google. After approval, Safari will ask to open Obsidian again.",
    });
    const link = this.contentEl.createEl("a", {
      text: "Continue in Safari",
      cls: "mod-cta vault-relay-authorization-link",
      href: this.authorizationUrl,
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener noreferrer");
    link.addEventListener("click", () => window.setTimeout(() => this.close(), 0));
    this.contentEl.createEl("p", {
      cls: "vault-relay-setting-note",
      text: "The authorization request expires after 10 minutes. Return here and press Connect again if it expires.",
    });
  }
}

export class VaultRelaySettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: VaultRelayPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.getSettings();
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault Relay" });

    new Setting(containerEl)
      .setName("OAuth relay URL")
      .setDesc("HTTPS address of your deployed Vault Relay authentication service. Applied when you leave the field or press Enter.")
      .addText((text) => {
        text.setPlaceholder("https://auth.example.com").setValue(settings.relayUrl);
        let committing = false;
        const commit = async (): Promise<void> => {
          // Committing per keystroke tore down the Google credential partway
          // through typing, because prefixes such as "https://a" are valid.
          if (committing) return;
          const value = text.inputEl.value.trim();
          if (!value || value === settings.relayUrl) return;
          committing = true;
          try {
            const result = await this.plugin.updateRelayUrl(value, () => confirmAction(
              this.app,
              "Change the OAuth relay?",
              "This signs out of Google Drive and unlinks the remote vault on this device. Your notes are not deleted, and you can reconnect afterwards.",
              "Change and sign out",
            ));
            if (result.applied) {
              this.display();
              return;
            }
            if (result.error) this.plugin.notifier.notice(result.error);
            text.setValue(settings.relayUrl);
          } finally {
            committing = false;
          }
        };
        text.inputEl.addEventListener("blur", () => void commit());
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            text.inputEl.blur();
          }
        });
      });

    new Setting(containerEl)
      .setName(settings.connected ? "Google Drive connected" : "Connect Google Drive")
      .setDesc(settings.connected ? "Tokens are stored in Obsidian SecretStorage." : "Sign in through the configured OAuth relay.")
      .addButton((button) => button
        .setButtonText(settings.connected ? "Reconnect" : "Connect")
        .setCta()
        .onClick(() => void this.plugin.connect()));

    if (settings.connected) {
      new Setting(containerEl)
        .setName("Remote vault")
        .setDesc(settings.layout ? `Connected to ${settings.layout.vaultId}` : "Choose whether this device creates or links a remote vault.")
        .addButton((button) => button
          .setButtonText(settings.layout ? "Change" : "Choose")
          .onClick(() => void this.plugin.openSetup()));
    }

    new Setting(containerEl)
      .setName("Automatic sync interval")
      .setDesc("Sync while Obsidian is open. iOS does not run community plugins continuously in the background.")
      .addDropdown((dropdown) => dropdown
        .addOptions(Object.fromEntries(SYNC_INTERVAL_CHOICES.map((minutes) => [
          String(minutes),
          minutes === 1 ? "Every minute" : `Every ${minutes} minutes`,
        ])))
        .setValue(String(settings.autoSyncMinutes))
        .onChange(async (value) => {
          const minutes = Number(value);
          if (!Number.isFinite(minutes) || minutes < 1) return;
          await this.plugin.updatePreferences({ autoSyncMinutes: minutes });
          this.plugin.resetTimer();
        }));

    new Setting(containerEl)
      .setName("Parallel Drive requests")
      .setDesc(`How many Google Drive transfers run at once (${MIN_CONCURRENCY}-${MAX_CONCURRENCY}). Lower this on a slow or metered connection.`)
      .addSlider((slider) => slider
        .setLimits(MIN_CONCURRENCY, MAX_CONCURRENCY, 1)
        .setValue(settings.maxConcurrentRequests)
        .setDynamicTooltip()
        .onChange(async (value) => {
          await this.plugin.updatePreferences({ maxConcurrentRequests: value });
        }));

    new Setting(containerEl)
      .setName("Pause synchronization")
      .setDesc("Local changes remain in the vault and will be captured when syncing resumes.")
      .addToggle((toggle) => toggle
        .setValue(settings.paused)
        .onChange(async (value) => {
          await this.plugin.updatePreferences({ paused: value });
          this.plugin.updateStatus();
        }));

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc("One rule per line. A trailing slash excludes a folder, a name without a slash excludes that file name at any depth, and anything else is an exact path. The .obsidian folder is always excluded.")
      .addTextArea((text) => text
        .setValue(settings.exclusions.join("\n"))
        .onChange(async (value) => {
          await this.plugin.updatePreferences({ exclusions: value.split("\n").map((entry) => entry.trim()).filter(Boolean) });
        }));

    if (settings.lastSyncAt) {
      containerEl.createEl("p", { cls: "vault-relay-setting-note", text: `Last successful sync: ${new Date(settings.lastSyncAt).toLocaleString()}` });
    }
    if (settings.lastError) {
      containerEl.createEl("p", { cls: "vault-relay-setting-note", text: `Last error: ${settings.lastError}` });
    }
    if (settings.pendingLargeDeletionCount > 0) {
      new Setting(containerEl)
        .setName("Bulk deletion blocked")
        .setDesc(`Vault Relay stopped before trashing ${settings.pendingLargeDeletionCount} files. Review the other device before approving.`)
        .addButton((button) => button.setButtonText("Approve once").setWarning().onClick(() => void this.plugin.approveLargeDeletion()));
    }
  }
}

export class SetupModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: VaultRelayPlugin,
    private readonly remotes: RemoteVaultSummary[],
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Set up Vault Relay");
    this.contentEl.createEl("p", {
      text: "Create a remote store from this vault, or link one created by another device. Existing local and remote files are merged without silent overwrites.",
    });

    new Setting(this.contentEl)
      .setName("Create from this vault")
      .setDesc("Use this for the desktop vault that currently contains your authoritative notes.")
      .addButton((button) => button.setButtonText("Create and upload").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.createRemote();
          this.close();
        } catch (error) {
          this.plugin.notifier.notice(error instanceof Error ? error.message : String(error));
          button.setDisabled(false);
        }
      }));

    if (this.remotes.length === 0) {
      this.contentEl.createEl("p", { cls: "vault-relay-setting-note", text: "No existing Vault Relay stores were found in this Google Drive account." });
      return;
    }

    this.contentEl.createEl("h3", { text: "Existing remote vaults" });
    for (const remote of this.remotes) {
      new Setting(this.contentEl)
        .setName(remote.name)
        .setDesc(remote.layout.vaultId)
        .addButton((button) => button.setButtonText("Link").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.linkRemote(remote);
            this.close();
          } catch (error) {
            this.plugin.notifier.notice(error instanceof Error ? error.message : String(error));
            button.setDisabled(false);
          }
        }));
    }
  }
}

export class ConflictModal extends Modal {
  constructor(app: App, private readonly plugin: VaultRelayPlugin) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Vault Relay conflicts");
    void this.render();
  }

  private async render(): Promise<void> {
    this.contentEl.empty();
    const snapshot = await loadVersionHistory(this.plugin, this.contentEl, "Conflicts are unavailable until Vault Relay can read retained Version History.");
    if (!snapshot) return;
    const { conflicts } = snapshot;
    if (conflicts.length === 0) {
      this.contentEl.createEl("p", { text: "No unresolved concurrent versions were found in retained Version History." });
      return;
    }
    this.contentEl.createEl("p", { text: "Vault Relay preserved concurrent content as conflict copies. Compare the files, keep the content you want, and delete the extra copy." });
    new Setting(this.contentEl)
      .setName("Resolve all conflicts")
      .setDesc("Keep every file in its current state. Existing files stay; files already deleted remain deleted.")
      .addButton((button) => button.setButtonText("Keep current state for all").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.resolveConflicts(conflicts.map((conflict) => ({ reference: conflict.reference, choice: conflict.current === "file" ? "keep-current-file" : "keep-deleted" })));
          this.close();
        } catch (error) {
          this.plugin.notifier.notice(error instanceof Error ? error.message : String(error));
          button.setDisabled(false);
        }
      }));
    for (const conflict of conflicts) {
      const item = this.contentEl.createDiv({ cls: "vault-relay-conflict" });
      item.createEl("strong", { text: conflict.path });
      item.createEl("div", { text: conflict.conflictPaths.length ? `Copies: ${conflict.conflictPaths.join(", ")}` : "A deletion conflicts with another version." });
      new Setting(item)
        .setName("Resolve this conflict")
        .setDesc("Compare or copy content first. Resolution creates a new version descended from every conflicting head.")
        .addButton((button) => button.setButtonText("Keep current file").setCta().onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.resolveConflicts([{ reference: conflict.reference, choice: "keep-current-file" }]);
            this.close();
          } catch (error) {
            this.plugin.notifier.notice(error instanceof Error ? error.message : String(error));
            button.setDisabled(false);
          }
        }))
        .addButton((button) => button.setButtonText("Keep deleted").setWarning().onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.resolveConflicts([{ reference: conflict.reference, choice: "keep-deleted" }]);
            this.close();
          } catch (error) {
            this.plugin.notifier.notice(error instanceof Error ? error.message : String(error));
            button.setDisabled(false);
          }
        }));
    }
  }
}

export class RestoreModal extends Modal {
  constructor(app: App, private readonly plugin: VaultRelayPlugin) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Restore a historical version");
    void this.render();
  }

  private async render(): Promise<void> {
    this.contentEl.empty();
    const snapshot = await loadVersionHistory(this.plugin, this.contentEl, "Version History is unavailable until Vault Relay can read retained versions.");
    if (!snapshot) return;
    const { historicalVersions: versions } = snapshot;
    if (versions.length === 0) {
      this.contentEl.createEl("p", { text: "No retained versions are available on this device yet." });
      return;
    }
    this.contentEl.createEl("p", { text: "Restoring records the selected content as a new pending version. The next sync publishes it; history is not deleted." });
    for (const version of versions.slice(0, 200)) {
      const setting = new Setting(this.contentEl)
        .setName(version.path)
        .setDesc(`${new Date(version.createdAt).toLocaleString()}${version.deviceId ? ` · ${version.deviceId}` : ""}${version.content === "deletion" ? version.publication === "published" ? " · Deleted" : " · Deletion pending publication" : version.publication === "pending" ? " · Pending publication" : ""}`);
      if (!version.restorable) continue;
      setting.addButton((button) => button.setButtonText("Restore").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.restoreVersion(version.reference);
            this.close();
          } catch (error) {
            this.plugin.notifier.notice(error instanceof Error ? error.message : String(error));
            button.setDisabled(false);
          }
        }));
    }
  }
}
