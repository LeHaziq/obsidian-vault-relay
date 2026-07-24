import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultRelayPlugin from "./main";
import type { RemoteVaultSummary } from "./google-drive";

export class VaultRelaySettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: VaultRelayPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault Relay" });

    new Setting(containerEl)
      .setName("OAuth relay URL")
      .setDesc("HTTPS address of your deployed Vault Relay authentication service.")
      .addText((text) => text
        .setPlaceholder("https://auth.example.com")
        .setValue(this.plugin.settings.relayUrl)
        .onChange(async (value) => {
          await this.plugin.updateRelayUrl(value);
        }));

    new Setting(containerEl)
      .setName(this.plugin.settings.connected ? "Google Drive connected" : "Connect Google Drive")
      .setDesc(this.plugin.settings.connected ? "Tokens are stored in Obsidian SecretStorage." : "Sign in through the configured OAuth relay.")
      .addButton((button) => button
        .setButtonText(this.plugin.settings.connected ? "Reconnect" : "Connect")
        .setCta()
        .onClick(() => void this.plugin.connect()));

    if (this.plugin.settings.connected) {
      new Setting(containerEl)
        .setName("Remote vault")
        .setDesc(this.plugin.settings.layout ? `Connected to ${this.plugin.settings.layout.vaultId}` : "Choose whether this device creates or links a remote vault.")
        .addButton((button) => button
          .setButtonText(this.plugin.settings.layout ? "Change" : "Choose")
          .onClick(() => void this.plugin.openSetup()));
    }

    new Setting(containerEl)
      .setName("Automatic sync interval")
      .setDesc("Sync while Obsidian is open. iOS does not run community plugins continuously in the background.")
      .addDropdown((dropdown) => dropdown
        .addOptions({ "1": "Every minute", "5": "Every 5 minutes", "15": "Every 15 minutes", "30": "Every 30 minutes" })
        .setValue(String(this.plugin.settings.autoSyncMinutes))
        .onChange(async (value) => {
          this.plugin.settings.autoSyncMinutes = Number(value);
          await this.plugin.saveSettings();
          this.plugin.resetTimer();
        }));

    new Setting(containerEl)
      .setName("Pause synchronization")
      .setDesc("Local changes remain in the vault and will be captured when syncing resumes.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.paused)
        .onChange(async (value) => {
          this.plugin.settings.paused = value;
          await this.plugin.saveSettings();
          this.plugin.updateStatus();
        }));

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc("One exact path or folder prefix per line. The .obsidian folder is excluded by default.")
      .addTextArea((text) => text
        .setValue(this.plugin.settings.exclusions.join("\n"))
        .onChange(async (value) => {
          this.plugin.settings.exclusions = value.split("\n").map((entry) => entry.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    if (this.plugin.settings.lastSyncAt) {
      containerEl.createEl("p", { cls: "vault-relay-setting-note", text: `Last successful sync: ${new Date(this.plugin.settings.lastSyncAt).toLocaleString()}` });
    }
    if (this.plugin.settings.lastError) {
      containerEl.createEl("p", { cls: "vault-relay-setting-note", text: `Last error: ${this.plugin.settings.lastError}` });
    }
    if (this.plugin.settings.pendingLargeDeletionCount > 0) {
      new Setting(containerEl)
        .setName("Bulk deletion blocked")
        .setDesc(`Vault Relay stopped before trashing ${this.plugin.settings.pendingLargeDeletionCount} files. Review the other device before approving.`)
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
          new Notice(error instanceof Error ? error.message : String(error));
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
            new Notice(error instanceof Error ? error.message : String(error));
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
    const conflicts = this.plugin.settings.conflicts;
    if (conflicts.length === 0) {
      this.contentEl.createEl("p", { text: "No unresolved concurrent versions were found during the last sync." });
      return;
    }
    this.contentEl.createEl("p", { text: "Vault Relay preserved concurrent content as conflict copies. Compare the files, keep the content you want, and delete the extra copy." });
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
            await this.plugin.resolveConflict(conflict.path, true);
            this.close();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
            button.setDisabled(false);
          }
        }))
        .addButton((button) => button.setButtonText("Keep deleted").setWarning().onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.resolveConflict(conflict.path, false);
            this.close();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
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
    const versions = Object.values(this.plugin.settings.syncState.operations)
      .flatMap((operation) => operation.changes
        .filter((change) => change.kind === "put")
        .map((change) => ({ operation, change })))
      .sort((left, right) => right.operation.createdAt.localeCompare(left.operation.createdAt));
    if (versions.length === 0) {
      this.contentEl.createEl("p", { text: "No uploaded file versions are available on this device yet." });
      return;
    }
    this.contentEl.createEl("p", { text: "Restoring writes the selected content locally. The next sync records it as a new version; history is not deleted." });
    for (const { operation, change } of versions.slice(0, 200)) {
      new Setting(this.contentEl)
        .setName(change.path)
        .setDesc(`${new Date(operation.createdAt).toLocaleString()} · ${operation.deviceId}`)
        .addButton((button) => button.setButtonText("Restore").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.restoreVersion(change.path, change.blobHash);
            this.close();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
            button.setDisabled(false);
          }
        }));
    }
  }
}
