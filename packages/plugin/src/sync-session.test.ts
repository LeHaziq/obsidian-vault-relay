import { sha256, type LocalFile, type LocalVault, type RemoteVault, type SyncOperation } from "@vault-relay/protocol";
import { describe, expect, it } from "vitest";
import type { DriveLayout, PluginSettings } from "./model";
import { InMemorySettingsStore, RecordingNotifier } from "./ports.test-helper";
import { SyncSession, type Clock, type RemoteVaultSession } from "./sync-session";

const encoder = new TextEncoder();
const layout: DriveLayout = { vaultId: "vault", rootId: "root", blobsId: "blobs", operationsId: "operations" };

class MemoryLocal implements LocalVault {
  readonly files = new Map<string, Uint8Array>();
  writes: string[] = [];
  afterWrite: (() => void) | null = null;

  async scan(): Promise<LocalFile[]> {
    return Promise.all([...this.files].map(async ([path, content]) => ({
      path,
      hash: await sha256(content),
      size: content.byteLength,
      mimeType: "text/markdown",
    })));
  }

  isManaged(): boolean { return true; }
  async read(path: string): Promise<ArrayBuffer> {
    const content = this.files.get(path);
    if (!content) throw new Error(`Missing ${path}`);
    return content.slice().buffer;
  }
  async write(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(content));
    this.writes.push(path);
    this.afterWrite?.();
  }
  async remove(path: string): Promise<void> { this.files.delete(path); }
}

class MemoryRemote implements RemoteVault {
  readonly blobs = new Map<string, ArrayBuffer>();
  readonly operations = new Map<string, SyncOperation>();
  pulls = 0;
  pullGate: Promise<void> = Promise.resolve();

  async pullOperations(): Promise<{ operations: SyncOperation[]; cursor: string }> {
    this.pulls += 1;
    await this.pullGate;
    return { operations: [...this.operations.values()], cursor: String(this.operations.size) };
  }
  async hasBlob(hash: string): Promise<boolean> { return this.blobs.has(hash); }
  async putBlob(hash: string, content: ArrayBuffer): Promise<void> { this.blobs.set(hash, content.slice(0)); }
  async getBlob(hash: string): Promise<ArrayBuffer> {
    const content = this.blobs.get(hash);
    if (!content) throw new Error(`Missing ${hash}`);
    return content.slice(0);
  }
  async putOperation(operation: SyncOperation): Promise<void> { this.operations.set(operation.id, structuredClone(operation)); }
  async ensureOperations(operations: SyncOperation[]): Promise<void> {
    for (const operation of operations) this.operations.set(operation.id, structuredClone(operation));
  }
}

class MemoryRemoteSession implements RemoteVaultSession {
  opens = 0;
  constructor(readonly remote: RemoteVault) {}
  open(): RemoteVault { this.opens += 1; return this.remote; }
}

class LayoutRemoteSession implements RemoteVaultSession {
  constructor(private readonly remotes: Map<string, RemoteVault>) {}
  open(layout: DriveLayout): RemoteVault {
    const remote = this.remotes.get(layout.vaultId);
    if (!remote) throw new Error(`No remote for ${layout.vaultId}`);
    return remote;
  }
}

const clock: Clock = { now: () => new Date("2026-08-09T01:02:03.000Z") };

type SubjectOverrides = Partial<Pick<PluginSettings, "paused" | "connected" | "layout" | "syncState" | "pendingLargeDeletionCount">>;

async function subject(overrides: SubjectOverrides = {}) {
  const store = new InMemorySettingsStore({
    connected: overrides.connected ?? true,
    paused: overrides.paused ?? false,
    layout: overrides.layout === undefined ? layout : overrides.layout,
    syncState: overrides.syncState ?? {},
    pendingLargeDeletionCount: overrides.pendingLargeDeletionCount ?? 0,
  });
  const settings = await store.load();
  const notifier = new RecordingNotifier();
  const local = new MemoryLocal();
  const remote = new MemoryRemote();
  const remotes = new MemoryRemoteSession(remote);
  const auth = { disconnected: false, disconnect: async (): Promise<void> => { auth.disconnected = true; } };
  const session = new SyncSession({
    settings,
    settingsStore: store,
    notifier,
    local,
    auth,
    remoteVaults: remotes,
    clock,
  });
  return { session, store, notifier, local, remote, remotes, auth };
}

async function seedConflict(remote: MemoryRemote, path = "note.md"): Promise<void> {
  const first = encoder.encode("desktop");
  const second = encoder.encode("phone");
  const firstHash = await sha256(first);
  const secondHash = await sha256(second);
  remote.blobs.set(firstHash, first.buffer);
  remote.blobs.set(secondHash, second.buffer);
  remote.operations.set("desktop-conflict", { protocolVersion: 1, id: "desktop-conflict", deviceId: "desktop", sequence: 1, createdAt: "2026-08-09T00:00:00.000Z", changes: [{ kind: "put", path, parents: [], blobHash: firstHash, size: first.byteLength, mimeType: "text/markdown" }] });
  remote.operations.set("phone-conflict", { protocolVersion: 1, id: "phone-conflict", deviceId: "phone", sequence: 1, createdAt: "2026-08-09T00:00:00.000Z", changes: [{ kind: "put", path, parents: [], blobHash: secondHash, size: second.byteLength, mimeType: "text/markdown" }] });
}

describe("SyncSession", () => {
  it("joins concurrent callers to one sync run", async () => {
    const current = await subject();
    let release = (): void => undefined;
    current.remote.pullGate = new Promise<void>((resolve) => { release = resolve; });

    const first = current.session.syncNow(false);
    const second = current.session.syncNow(false);

    expect(second).toBe(first);
    release();
    await first;
    expect(current.remotes.opens).toBe(1);
    expect(current.remote.pulls).toBe(1);
    expect(current.session.getSettings().lastSyncAt).toBe("2026-08-09T01:02:03.000Z");
  });

  it.each([
    [{ paused: true }, "Vault Relay is paused"],
    [{ connected: false, layout: null }, "Set up Vault Relay first"],
  ] as const)("does not sync when unavailable and reports why", async (overrides, message) => {
    const current = await subject(overrides);

    await current.session.syncNow(true);

    // The session creates its one Protocol root with its immutable initial binding.
    expect(current.remotes.opens).toBe("layout" in overrides && overrides.layout === null ? 0 : 1);
    expect(current.notifier.notices).toEqual([message]);
  });

  it("stops vault writes after abort and persists completed progress", async () => {
    const current = await subject();
    const first = encoder.encode("first");
    const second = encoder.encode("second");
    const firstHash = await sha256(first);
    const secondHash = await sha256(second);
    const operation: SyncOperation = {
      protocolVersion: 1,
      id: "source-1-operation",
      deviceId: "source",
      sequence: 1,
      createdAt: "2026-08-09T00:00:00.000Z",
      changes: [
        { kind: "put", path: "a.md", parents: [], blobHash: firstHash, size: first.byteLength, mimeType: "text/markdown" },
        { kind: "put", path: "b.md", parents: [], blobHash: secondHash, size: second.byteLength, mimeType: "text/markdown" },
      ],
    };
    current.remote.operations.set(operation.id, operation);
    current.remote.blobs.set(firstHash, first.buffer);
    current.remote.blobs.set(secondHash, second.buffer);
    current.local.afterWrite = () => current.session.abort();

    await current.session.syncNow(false);

    expect(current.local.writes).toEqual(["a.md"]);
    expect(current.store.persisted.lastError).toBeNull();
  });

  it("delegates binding changes to the Protocol root", async () => {
    const state = { protocolVersion: 1, deviceId: "test-device", nextSequence: 7, cursor: null, operations: {}, materialized: {}, pending: [] };
    const current = await subject({ syncState: state, pendingLargeDeletionCount: 12 });

    await current.session.rebind({ ...layout });
    expect(current.session.getSettings().pendingLargeDeletionCount).toBe(12);

    await current.session.rebind({ ...layout, vaultId: "other-vault" });
    expect(current.session.getSettings().pendingLargeDeletionCount).toBe(0);
  });

  it("captures same-remote rebinding state after an active sync commits", async () => {
    const current = await subject();
    current.local.files.set("note.md", encoder.encode("first"));
    let release = (): void => undefined;
    current.remote.pullGate = new Promise<void>((resolve) => { release = resolve; });
    const active = current.session.syncNow(false);
    const rebind = current.session.rebind({ ...layout });
    release();
    await active;
    await rebind;
    current.local.files.set("note.md", encoder.encode("second"));
    await current.session.syncNow(false);
    expect(current.remote.operations.size).toBe(2);
    expect((await current.session.versionHistorySnapshot()).conflicts).toEqual([]);
  });

  it("retains a restored pending Historical Version when same-remote rebinding queues behind it", async () => {
    const current = await subject();
    current.local.files.set("note.md", encoder.encode("first"));
    await current.session.syncNow(false);
    const version = (await current.session.versionHistorySnapshot()).historicalVersions.find((entry) => entry.path === "note.md" && entry.restorable)!;

    const restoring = current.session.restoreVersion(version.reference);
    const rebinding = current.session.rebind({ ...layout });
    await restoring;
    await rebinding;

    const pending = (await current.session.versionHistorySnapshot()).historicalVersions.find((entry) => entry.path === "note.md" && entry.publication === "pending");
    expect(pending).toBeDefined();
    await current.session.syncNow(false);
    expect(current.remote.operations.size).toBe(2);
    expect((await current.session.versionHistorySnapshot()).historicalVersions.find((entry) => entry.reference === pending!.reference)).toMatchObject({ publication: "published", restorable: true });
  });

  it("queues same-remote rebinding before a synchronously started sync when none is active", async () => {
    const current = await subject();
    current.local.files.set("note.md", encoder.encode("first"));

    const rebind = current.session.rebind({ ...layout });
    const sync = current.session.syncNow(false);
    await rebind;
    await sync;

    current.local.files.set("note.md", encoder.encode("second"));
    await current.session.syncNow(false);
    expect(current.remote.operations.size).toBe(2);
    expect((await current.session.versionHistorySnapshot()).conflicts).toEqual([]);
  });

  it("persists a redacted failure without clearing a blocked deletion count", async () => {
    const current = await subject({ pendingLargeDeletionCount: 31 });
    current.remote.pullOperations = async () => { throw new Error("Bearer ya29.secret-token-value rejected"); };

    await current.session.syncNow(false);

    expect(current.store.persisted.lastError).toBe("Bearer [redacted] rejected");
    expect(current.store.persisted.pendingLargeDeletionCount).toBe(31);
    expect(current.notifier.notices).toEqual(["Vault Relay: Bearer [redacted] rejected"]);
  });

  it("initializes retained Conflict status while paused without starting a sync", async () => {
    const initial = await subject();
    await seedConflict(initial.remote);
    await initial.session.syncNow(false);
    const settings = await initial.store.load();
    settings.paused = true;
    const restarted = new SyncSession({
      settings,
      settingsStore: initial.store,
      notifier: initial.notifier,
      local: initial.local,
      auth: initial.auth,
      remoteVaults: initial.remotes,
      clock,
    });
    const pulls = initial.remote.pulls;

    await restarted.initializeStatus();

    expect(restarted.hasConflicts).toBe(true);
    expect(initial.remote.pulls).toBe(pulls);
  });

  it("waits for Protocol unbinding before disconnecting credentials", async () => {
    const current = await subject();
    let release = (): void => undefined;
    current.remote.pullGate = new Promise<void>((resolve) => { release = resolve; });
    const sync = current.session.syncNow(false);
    const disconnect = current.session.disconnectAndSetRelay("https://new-relay.example");
    await Promise.resolve();
    await Promise.resolve();
    expect(current.auth.disconnected).toBe(false);
    release();
    await sync;
    await disconnect;
    expect(current.auth.disconnected).toBe(true);
  });

  it("does not retain an uncommitted restore after settings persistence fails", async () => {
    const current = await subject();
    current.local.files.set("note.md", encoder.encode("first"));
    await current.session.syncNow(false);
    const version = (await current.session.versionHistorySnapshot()).historicalVersions.find((entry) => entry.path === "note.md" && entry.restorable)!;
    current.store.failNextSave = new Error("settings offline");
    await expect(current.session.restoreVersion(version.reference)).rejects.toThrow("Historical Version restoration failed for note.md");
    await current.session.restoreVersion(version.reference);
    await current.session.syncNow(false);
    expect(current.remote.operations.size).toBe(2);
  });

  it("starts a new publication sync after resolving behind an active sync", async () => {
    const current = await subject();
    await seedConflict(current.remote);
    await current.session.syncNow(false);
    const conflict = (await current.session.versionHistorySnapshot()).conflicts[0]!;
    let release = (): void => undefined;
    current.remote.pullGate = new Promise<void>((resolve) => { release = resolve; });
    const active = current.session.syncNow(false);
    const resolve = current.session.resolveConflicts([{ reference: conflict.reference, choice: "keep-current-file" }]);
    release();
    await active;
    await resolve;
    expect(current.remote.operations.size).toBe(3);
    expect((await current.session.versionHistorySnapshot()).conflicts).toEqual([]);
  });

  it("keeps old-epoch saves on the old layout until queued rebinding resets the new epoch", async () => {
    const oldRemote = new MemoryRemote();
    const newRemote = new MemoryRemote();
    const newLayout = { ...layout, vaultId: "new-vault", rootId: "new-root", blobsId: "new-blobs", operationsId: "new-operations" };
    const store = new InMemorySettingsStore({ connected: true, layout, syncState: {} });
    const local = new MemoryLocal();
    local.files.set("note.md", encoder.encode("old epoch"));
    const session = new SyncSession({
      settings: await store.load(), settingsStore: store, notifier: new RecordingNotifier(), local,
      auth: { disconnect: async () => undefined }, remoteVaults: new LayoutRemoteSession(new Map([[layout.vaultId, oldRemote], [newLayout.vaultId, newRemote]])), clock,
    });
    let release = (): void => undefined;
    oldRemote.pullGate = new Promise<void>((resolve) => { release = resolve; });
    const sync = session.syncNow(false);
    const rebind = session.rebind(newLayout);
    release();
    await sync;
    await rebind;
    const firstNew = store.saved.findIndex((settings) => settings.layout?.vaultId === newLayout.vaultId);
    expect(firstNew).toBeGreaterThanOrEqual(0);
    expect(store.saved.slice(0, firstNew).every((settings) => settings.layout?.vaultId === layout.vaultId)).toBe(true);
    expect(store.persisted.layout).toEqual(newLayout);
  });

  it("leaves the old layout and binding usable when a new-epoch reset cannot save", async () => {
    const oldRemote = new MemoryRemote();
    const newRemote = new MemoryRemote();
    const newLayout = { ...layout, vaultId: "new-vault", rootId: "new-root", blobsId: "new-blobs", operationsId: "new-operations" };
    const store = new InMemorySettingsStore({ connected: true, layout, syncState: {} });
    const session = new SyncSession({
      settings: await store.load(), settingsStore: store, notifier: new RecordingNotifier(), local: new MemoryLocal(),
      auth: { disconnect: async () => undefined }, remoteVaults: new LayoutRemoteSession(new Map([[layout.vaultId, oldRemote], [newLayout.vaultId, newRemote]])), clock,
    });
    store.failNextSave = new Error("settings offline");
    await expect(session.rebind(newLayout)).rejects.toThrow("settings offline");
    expect(session.getSettings().layout).toEqual(layout);
    await session.syncNow(false);
    expect(oldRemote.pulls).toBe(1);
    expect(newRemote.pulls).toBe(0);
  });

  it("keeps a newly blocked deletion warning after cross-remote reset", async () => {
    const oldRemote = new MemoryRemote();
    const newRemote = new MemoryRemote();
    const newLayout = { ...layout, vaultId: "new-vault", rootId: "new-root", blobsId: "new-blobs", operationsId: "new-operations" };
    const store = new InMemorySettingsStore({ connected: true, layout, syncState: {}, pendingLargeDeletionCount: 12 });
    const local = new MemoryLocal();
    const content = encoder.encode("remote file");
    const hash = await sha256(content);
    newRemote.blobs.set(hash, content.buffer);
    newRemote.operations.set("remote-put", {
      protocolVersion: 1, id: "remote-put", deviceId: "remote", sequence: 1, createdAt: "2026-08-10T00:00:00Z",
      changes: Array.from({ length: 26 }, (_, index) => ({ kind: "put" as const, path: `deleted/${index}.md`, parents: [], blobHash: hash, size: content.byteLength, mimeType: "text/markdown" })),
    });
    const session = new SyncSession({
      settings: await store.load(), settingsStore: store, notifier: new RecordingNotifier(), local,
      auth: { disconnect: async () => undefined }, remoteVaults: new LayoutRemoteSession(new Map([[layout.vaultId, oldRemote], [newLayout.vaultId, newRemote]])), clock,
    });
    await session.rebind(newLayout);
    expect(session.getSettings().pendingLargeDeletionCount).toBe(0);
    await session.syncNow(false);
    newRemote.operations.set("remote-delete", {
      protocolVersion: 1, id: "remote-delete", deviceId: "remote", sequence: 2, createdAt: "2026-08-10T00:00:01Z",
      changes: Array.from({ length: 26 }, (_, index) => ({ kind: "delete" as const, path: `deleted/${index}.md`, parents: ["remote-put"] })),
    });
    await session.syncNow(false);
    expect(session.getSettings().pendingLargeDeletionCount).toBe(26);
    expect(store.persisted.pendingLargeDeletionCount).toBe(26);
  });

  it("preserves queued application preferences around a Protocol state save", async () => {
    const current = await subject();
    current.local.files.set("note.md", encoder.encode("captured"));
    let release = (): void => undefined;
    current.store.saveGate = new Promise<void>((resolve) => { release = resolve; });
    const firstPreference = current.session.updatePreferences({ autoSyncMinutes: 15 });
    const sync = current.session.syncNow(false);
    await Promise.resolve();
    await Promise.resolve();
    const secondPreference = current.session.updatePreferences({ maxConcurrentRequests: 7 });
    release();
    await Promise.all([firstPreference, sync, secondPreference]);
    expect(current.store.persisted.autoSyncMinutes).toBe(15);
    expect(current.store.persisted.maxConcurrentRequests).toBe(7);
    expect(current.remote.operations.size).toBe(1);
  });
});
