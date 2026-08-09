import { createInitialState, sha256, type LocalFile, type LocalVault, type RemoteVault, type SyncOperation } from "@vault-relay/protocol";
import { describe, expect, it } from "vitest";
import type { DriveLayout, PluginSettings } from "./model";
import { InMemorySettingsStore, RecordingNotifier } from "./ports.test-helper";
import { SyncSession, type Clock, type RemoteVaultFactory } from "./sync-session";

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

class MemoryRemoteFactory implements RemoteVaultFactory<object> {
  creates = 0;
  constructor(readonly remote: RemoteVault) {}
  create(): RemoteVault { this.creates += 1; return this.remote; }
}

const clock: Clock = { now: () => new Date("2026-08-09T01:02:03.000Z") };

type SubjectOverrides = Partial<Pick<PluginSettings, "paused" | "connected" | "layout" | "syncState" | "pendingLargeDeletionCount">>;

async function subject(overrides: SubjectOverrides = {}) {
  const store = new InMemorySettingsStore({
    connected: overrides.connected ?? true,
    paused: overrides.paused ?? false,
    layout: overrides.layout === undefined ? layout : overrides.layout,
    syncState: overrides.syncState ?? createInitialState("test-device"),
    pendingLargeDeletionCount: overrides.pendingLargeDeletionCount ?? 0,
  });
  const settings = await store.load();
  const notifier = new RecordingNotifier();
  const local = new MemoryLocal();
  const remote = new MemoryRemote();
  const remotes = new MemoryRemoteFactory(remote);
  const session = new SyncSession({
    settings,
    settingsStore: store,
    notifier,
    local,
    auth: { disconnect: async () => undefined },
    remoteVaults: remotes,
    clock,
  });
  return { session, store, notifier, local, remote, remotes };
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
    expect(current.remotes.creates).toBe(1);
    expect(current.remote.pulls).toBe(1);
    expect(current.session.getSettings().lastSyncAt).toBe("2026-08-09T01:02:03.000Z");
  });

  it.each([
    [{ paused: true }, "Vault Relay is paused"],
    [{ connected: false, layout: null }, "Set up Vault Relay first"],
  ] as const)("does not sync when unavailable and reports why", async (overrides, message) => {
    const current = await subject(overrides);

    await current.session.syncNow(true);

    expect(current.remotes.creates).toBe(0);
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
    expect(current.store.persisted.syncState.materialized["a.md"]).toEqual({ hash: firstHash, operationId: operation.id });
    expect(current.store.persisted.syncState.materialized["b.md"]).toBeUndefined();
    expect(current.store.persisted.lastError).toBeNull();
  });

  it("keeps sync state when relinking the same remote and resets it for a different remote", async () => {
    const state = createInitialState("test-device");
    state.nextSequence = 7;
    const current = await subject({ syncState: state, pendingLargeDeletionCount: 12 });

    await current.session.rebind({ ...layout });
    expect(current.session.getSettings().syncState.nextSequence).toBe(7);
    expect(current.session.getSettings().pendingLargeDeletionCount).toBe(12);

    await current.session.rebind({ ...layout, vaultId: "other-vault" });
    expect(current.session.getSettings().syncState.nextSequence).toBe(1);
    expect(current.session.getSettings().syncState.deviceId).toBe("test-device");
    expect(current.session.getSettings().pendingLargeDeletionCount).toBe(0);
  });

  it("persists a redacted failure without clearing a blocked deletion count", async () => {
    const current = await subject({ pendingLargeDeletionCount: 31 });
    current.remote.pullOperations = async () => { throw new Error("Bearer ya29.secret-token-value rejected"); };

    await current.session.syncNow(false);

    expect(current.store.persisted.lastError).toBe("Bearer [redacted] rejected");
    expect(current.store.persisted.pendingLargeDeletionCount).toBe(31);
    expect(current.notifier.notices).toEqual(["Vault Relay: Bearer [redacted] rejected"]);
  });
});
