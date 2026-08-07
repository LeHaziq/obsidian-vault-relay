import { Notice, type Plugin } from "obsidian";
import { sanitizeSettings, type PluginSettings } from "./model";
import type { Notifier, SettingsStore } from "./ports";

/**
 * The part of the Obsidian plugin base class that settings persistence needs.
 * Naming just that part keeps the store constructible from a plain object.
 */
export type PluginData = Pick<Plugin, "loadData" | "saveData">;

export class ObsidianSettingsStore implements SettingsStore {
  constructor(private readonly data: PluginData) {}

  async load(): Promise<PluginSettings> {
    // Stored data is untrusted: it can be absent, written by an older version
    // of the plugin, or hand-edited.
    return sanitizeSettings(await this.data.loadData());
  }

  async save(settings: PluginSettings): Promise<void> {
    await this.data.saveData(settings);
  }
}

export class ObsidianNotifier implements Notifier {
  notice(message: string): void {
    new Notice(message);
  }
}
