import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./model";
import { InMemorySettingsStore, RecordingNotifier } from "./ports.test-helper";

describe("InMemorySettingsStore", () => {
  it("starts from the default settings and applies the given overrides", async () => {
    const store = new InMemorySettingsStore({ paused: true });
    const settings = await store.load();
    expect(settings.paused).toBe(true);
    expect(settings.relayUrl).toBe(DEFAULT_SETTINGS.relayUrl);
  });

  it("returns what the last save wrote", async () => {
    const store = new InMemorySettingsStore();
    const settings = await store.load();
    settings.lastError = "boom";
    await store.save(settings);
    expect((await store.load()).lastError).toBe("boom");
    expect(store.saves).toBe(1);
  });

  it("preserves opaque protocol state across loads", async () => {
    const state = "opaque persisted protocol state";
    const store = new InMemorySettingsStore({ syncState: state });
    const first = await store.load();
    const second = await store.load();
    expect(first.syncState).toBe(state);
    expect(second.syncState).toBe(state);
    expect(first).not.toBe(second);
  });

  it("copies on load and on save, so a caller cannot mutate the stored settings", async () => {
    const store = new InMemorySettingsStore();
    const settings = await store.load();
    await store.save(settings);
    settings.lastError = "written after the save";
    expect((await store.load()).lastError).toBeNull();
  });
});

describe("RecordingNotifier", () => {
  it("keeps every notice in order", () => {
    const notifier = new RecordingNotifier();
    notifier.notice("first");
    notifier.notice("second");
    expect(notifier.notices).toEqual(["first", "second"]);
  });
});
