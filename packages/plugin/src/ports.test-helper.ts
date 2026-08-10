import { DEFAULT_SETTINGS, sanitizeSettings, type PluginSettings } from "./model";
import type { Notifier, SettingsStore } from "./ports";

/** Settings that live only for the length of a test. */
export class InMemorySettingsStore implements SettingsStore {
  /** How many times the settings were written, to catch a missing save. */
  saves = 0;
  failNextSave: Error | null = null;
  saveGate: Promise<void> = Promise.resolve();
  readonly saved: PluginSettings[] = [];
  private stored: unknown;

  constructor(overrides: Partial<PluginSettings> = {}) {
    this.stored = { ...DEFAULT_SETTINGS, ...overrides };
  }

  async load(): Promise<PluginSettings> {
    return sanitizeSettings(this.stored);
  }

  async save(settings: PluginSettings): Promise<void> {
    // Obsidian writes JSON, so keep the same round trip: a later mutation of
    // the caller's object must not reach the stored settings, and settings that
    // do not survive JSON must fail here too.
    await this.saveGate;
    if (this.failNextSave) {
      const failure = this.failNextSave;
      this.failNextSave = null;
      throw failure;
    }
    this.stored = JSON.parse(JSON.stringify(settings));
    this.saved.push(sanitizeSettings(this.stored));
    this.saves += 1;
  }

  /** What a reload would read back. */
  get persisted(): PluginSettings {
    return sanitizeSettings(this.stored);
  }
}

/** Collects notices instead of showing them. */
export class RecordingNotifier implements Notifier {
  readonly notices: string[] = [];

  notice(message: string): void {
    this.notices.push(message);
  }
}
