import { beforeEach, describe, expect, it } from "vitest";
import { shownNotices } from "../test/obsidian";
import { DEFAULT_SETTINGS } from "./model";
import { ObsidianNotifier, ObsidianSettingsStore, type PluginData } from "./obsidian-ports";

class FakePluginData implements PluginData {
  saved: unknown = undefined;

  constructor(private readonly stored: unknown) {}

  async loadData(): Promise<unknown> {
    return this.stored;
  }

  async saveData(data: unknown): Promise<void> {
    this.saved = data;
  }
}

describe("ObsidianSettingsStore", () => {
  it("sanitizes what the plugin data holds", async () => {
    const store = new ObsidianSettingsStore(new FakePluginData({ autoSyncMinutes: "not a number", paused: true }));
    const settings = await store.load();
    expect(settings.autoSyncMinutes).toBe(DEFAULT_SETTINGS.autoSyncMinutes);
    expect(settings.paused).toBe(true);
  });

  it("gives the default settings, with a fresh device, when nothing is stored yet", async () => {
    const store = new ObsidianSettingsStore(new FakePluginData(null));
    const settings = await store.load();
    expect(settings.syncState.deviceId).not.toBe(DEFAULT_SETTINGS.syncState.deviceId);
    expect({ ...settings, syncState: DEFAULT_SETTINGS.syncState }).toEqual(DEFAULT_SETTINGS);
  });

  it("writes the settings through to the plugin data", async () => {
    const data = new FakePluginData(null);
    const store = new ObsidianSettingsStore(data);
    const settings = await store.load();
    settings.lastSyncAt = "2026-08-07T00:00:00.000Z";
    await store.save(settings);
    expect(data.saved).toEqual(settings);
  });
});

describe("ObsidianNotifier", () => {
  beforeEach(() => {
    shownNotices.length = 0;
  });

  it("shows the message as an Obsidian notice", () => {
    new ObsidianNotifier().notice("synced");
    expect(shownNotices).toEqual(["synced"]);
  });
});
