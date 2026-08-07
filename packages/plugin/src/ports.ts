import type { PluginSettings } from "./model";

/**
 * The two services the plugin shell gives to the sync logic. They carry no
 * dependency on Obsidian, so logic that only needs settings and notices can be
 * constructed in a test. The Obsidian implementations live in obsidian-ports.ts.
 */

/** Reads and writes the persisted settings. */
export interface SettingsStore {
  /** Gives the default settings when nothing valid is stored yet. */
  load(): Promise<PluginSettings>;
  save(settings: PluginSettings): Promise<void>;
}

/** Shows a short message to the user. */
export interface Notifier {
  notice(message: string): void;
}
