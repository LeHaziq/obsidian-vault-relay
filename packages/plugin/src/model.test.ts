import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MAX_CONCURRENCY, sanitizeSettings } from "./model";

describe("sanitizeSettings", () => {
  it("returns defaults for absent or non-object data", () => {
    for (const value of [null, undefined, "corrupt", 42, []]) {
      const settings = sanitizeSettings(value);
      expect(settings.autoSyncMinutes).toBe(DEFAULT_SETTINGS.autoSyncMinutes);
      expect(settings.exclusions).toEqual(DEFAULT_SETTINGS.exclusions);
      expect(settings.layout).toBeNull();
    }
  });

  it("clamps a non-numeric interval instead of producing NaN", () => {
    // setInterval(fn, NaN) coerces to 0 and spins.
    expect(sanitizeSettings({ autoSyncMinutes: "abc" }).autoSyncMinutes).toBe(DEFAULT_SETTINGS.autoSyncMinutes);
    expect(sanitizeSettings({ autoSyncMinutes: 0 }).autoSyncMinutes).toBe(1);
    expect(sanitizeSettings({ autoSyncMinutes: -5 }).autoSyncMinutes).toBe(1);
    expect(sanitizeSettings({ autoSyncMinutes: 10_000 }).autoSyncMinutes).toBe(1_440);
    expect(Number.isFinite(sanitizeSettings({ autoSyncMinutes: Number.NaN }).autoSyncMinutes)).toBe(true);
  });

  it("clamps concurrency into the supported range", () => {
    expect(sanitizeSettings({ maxConcurrentRequests: 0 }).maxConcurrentRequests).toBe(1);
    expect(sanitizeSettings({ maxConcurrentRequests: 999 }).maxConcurrentRequests).toBe(MAX_CONCURRENCY);
    expect(sanitizeSettings({ maxConcurrentRequests: 2.6 }).maxConcurrentRequests).toBe(3);
  });

  it("rejects a relay URL that is not a safe origin", () => {
    expect(sanitizeSettings({ relayUrl: "http://auth.example.com" }).relayUrl).toBe(DEFAULT_SETTINGS.relayUrl);
    expect(sanitizeSettings({ relayUrl: "not a url" }).relayUrl).toBe(DEFAULT_SETTINGS.relayUrl);
    expect(sanitizeSettings({ relayUrl: "https://auth.example.com/path" }).relayUrl).toBe(DEFAULT_SETTINGS.relayUrl);
    expect(sanitizeSettings({ relayUrl: "https://auth.example.com" }).relayUrl).toBe("https://auth.example.com");
  });

  it("drops a partially populated Drive layout", () => {
    expect(sanitizeSettings({ layout: { vaultId: "v", rootId: "r" } }).layout).toBeNull();
    expect(sanitizeSettings({ layout: { vaultId: "v", rootId: "r", blobsId: "b", operationsId: "" } }).layout).toBeNull();
    const complete = { vaultId: "v", rootId: "r", blobsId: "b", operationsId: "o" };
    expect(sanitizeSettings({ layout: complete }).layout).toEqual(complete);
  });

  it("retains every protocol-state value opaquely for Protocol to parse", () => {
    for (const persisted of [{ protocolVersion: 1, deviceId: "phone-1", operations: "nope" }, "corrupt", 42, null]) {
      expect(sanitizeSettings({ syncState: persisted }).syncState).toEqual(persisted);
    }
  });

  it("filters exclusion entries and trims whitespace", () => {
    const settings = sanitizeSettings({ exclusions: ["  a/  ", "", "   ", 5, null, "b.md"] });
    expect(settings.exclusions).toEqual(["a/", "b.md"]);
  });

  it("never carries a negative pending deletion count", () => {
    expect(sanitizeSettings({ pendingLargeDeletionCount: -3 }).pendingLargeDeletionCount).toBe(0);
    expect(sanitizeSettings({ pendingLargeDeletionCount: "many" }).pendingLargeDeletionCount).toBe(0);
  });
});
