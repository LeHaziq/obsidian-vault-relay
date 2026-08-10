import { describe, expect, it } from "vitest";
import { createProtocol, sha256, type ConflictChoice, type LocalFile, type LocalVault, type RemoteVault, type StateRepository, type SyncOperation } from "./index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class MemoryLocal implements LocalVault {
  readonly files = new Map<string, Uint8Array>();
  readonly unmanaged = new Set<string>();
  writes = 0;
  removes = 0;
  removedPaths: string[] = [];
  failWrite: Error | null = null;
  failRemove: Error | null = null;

  async scan(): Promise<LocalFile[]> {
    return Promise.all([...this.files].map(async ([path, content]) => ({ path, hash: await sha256(content), size: content.byteLength, mimeType: "text/markdown" })));
  }

  isManaged(path: string): boolean { return !this.unmanaged.has(path); }
  async read(path: string): Promise<ArrayBuffer> { return this.files.get(path)!.slice().buffer; }
  async write(path: string, content: ArrayBuffer): Promise<void> { this.writes += 1; if (this.failWrite) throw this.failWrite; this.files.set(path, new Uint8Array(content)); }
  async remove(path: string): Promise<void> { this.removes += 1; this.removedPaths.push(path); if (this.failRemove) throw this.failRemove; this.files.delete(path); }
}

class MemoryRemote implements RemoteVault {
  readonly blobs = new Map<string, ArrayBuffer>();
  readonly operations = new Map<string, SyncOperation>();
  pulls = 0;
  gets = 0;
  pullGate: Promise<void> = Promise.resolve();
  getGate: Promise<void> = Promise.resolve();

  async pullOperations(cursor: string | null): Promise<{ operations: SyncOperation[]; cursor: string }> {
    this.pulls += 1;
    await this.pullGate;
    return { operations: [...this.operations.values()].slice(Number(cursor ?? 0)), cursor: String(this.operations.size) };
  }
  async hasBlob(hash: string): Promise<boolean> { return this.blobs.has(hash); }
  async putBlob(hash: string, content: ArrayBuffer): Promise<void> { this.blobs.set(hash, content.slice(0)); }
  async getBlob(hash: string): Promise<ArrayBuffer> { this.gets += 1; await this.getGate; return this.blobs.get(hash)!.slice(0); }
  async putOperation(operation: SyncOperation): Promise<void> { this.operations.set(operation.id, structuredClone(operation)); }
  async ensureOperations(operations: SyncOperation[]): Promise<void> { for (const operation of operations) this.operations.set(operation.id, structuredClone(operation)); }
}

class MemoryStates implements StateRepository {
  value: unknown = undefined;
  saves = 0;
  failLoad: Error | null = null;
  failSave: Error | null = null;
  async load(): Promise<unknown> { if (this.failLoad) throw this.failLoad; return structuredClone(this.value); }
  async save(value: unknown): Promise<void> { this.saves += 1; if (this.failSave) throw this.failSave; this.value = structuredClone(value); }
}

async function conflictedRoot(): Promise<{ local: MemoryLocal; remote: MemoryRemote; states: MemoryStates; root: ReturnType<typeof createProtocol> }> {
  const local = new MemoryLocal();
  const remote = new MemoryRemote();
  const states = new MemoryStates();
  const one = encoder.encode("one");
  const two = encoder.encode("two");
  const oneHash = await sha256(one);
  const twoHash = await sha256(two);
  remote.blobs.set(oneHash, one.buffer);
  remote.blobs.set(twoHash, two.buffer);
  for (const [id, path, hash, content] of [["desktop-a", "a.md", oneHash, one], ["phone-a", "a.md", twoHash, two], ["desktop-b", "b.md", oneHash, one], ["phone-b", "b.md", twoHash, two], ["desktop-c", "c.md", oneHash, one], ["phone-c", "c.md", twoHash, two]] as const) {
    remote.operations.set(id, { protocolVersion: 1, id, deviceId: id.split("-")[0]!, sequence: 1, createdAt: "2026-08-10T00:00:00.000Z", changes: [{ kind: "put", path, parents: [], blobHash: hash, size: content.byteLength, mimeType: "text/markdown" }] });
  }
  const root = createProtocol({ local, binding: { remote, states } });
  await root.syncEngine.sync();
  return { local, remote, states, root };
}

async function manyConflictedRoot(count: number): Promise<{ local: MemoryLocal; remote: MemoryRemote; states: MemoryStates; root: ReturnType<typeof createProtocol> }> {
  const local = new MemoryLocal();
  const remote = new MemoryRemote();
  const states = new MemoryStates();
  const desktop = encoder.encode("desktop");
  const phone = encoder.encode("phone");
  const desktopHash = await sha256(desktop);
  const phoneHash = await sha256(phone);
  const changes = Array.from({ length: count }, (_, index) => `conflicts/${index.toString().padStart(5, "0")}.md`);
  const desktopOperation: SyncOperation = {
    protocolVersion: 1,
    id: "desktop-many",
    deviceId: "desktop",
    sequence: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    changes: changes.map((path) => ({ kind: "put", path, parents: [], blobHash: desktopHash, size: desktop.byteLength, mimeType: "text/markdown" })),
  };
  const phoneOperation: SyncOperation = {
    protocolVersion: 1,
    id: "phone-many",
    deviceId: "phone",
    sequence: 1,
    createdAt: "2026-08-10T00:00:01.000Z",
    changes: changes.map((path) => ({ kind: "put", path, parents: [], blobHash: phoneHash, size: phone.byteLength, mimeType: "text/markdown" })),
  };
  remote.operations.set(desktopOperation.id, desktopOperation);
  remote.operations.set(phoneOperation.id, phoneOperation);
  states.value = {
    protocolVersion: 1,
    deviceId: "resolver",
    nextSequence: 1,
    cursor: "2",
    operations: { [desktopOperation.id]: desktopOperation, [phoneOperation.id]: phoneOperation },
    materialized: {},
    pending: [],
    lastRepairAt: null,
  };
  return { local, remote, states, root: createProtocol({ local, binding: { remote, states } }) };
}

describe("createProtocol", () => {
  it("projects locally retained Version History without representation fields", async () => {
    const local = new MemoryLocal();
    local.files.set("note.md", encoder.encode("first"));
    const root = createProtocol({ local, binding: { remote: new MemoryRemote(), states: new MemoryStates() } });

    await root.syncEngine.sync();
    const snapshot = await root.versionHistory.snapshot();

    expect(snapshot.historicalVersions).toHaveLength(1);
    expect(snapshot.historicalVersions[0]).toMatchObject({ path: "note.md", content: "file", deviceId: expect.any(String), reference: expect.any(String) });
    expect(Object.keys(snapshot.historicalVersions[0]!)).not.toEqual(expect.arrayContaining(["id", "blobHash", "parents", "mutation"]));
    expect(decoder.decode(local.files.get("note.md"))).toBe("first");
  });

  it("joins concurrent sync callers and consumes bulk-deletion approval once", async () => {
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    let release = (): void => undefined;
    remote.pullGate = new Promise<void>((resolve) => { release = resolve; });
    let approvals = 0;
    const root = createProtocol({
      local,
      binding: { remote, states: new MemoryStates() },
      options: { consumeAllowLargeDeletes: async () => { approvals += 1; return false; } },
    });

    const first = root.syncEngine.sync();
    const second = root.syncEngine.sync();
    expect(second).toBe(first);
    release();
    await first;
    expect(approvals).toBe(1);
    expect(remote.pulls).toBe(1);
  });

  it("orders retained Version History and Conflicts deterministically without leaking representation", async () => {
    const current = await conflictedRoot();
    const snapshot = await current.root.versionHistory.snapshot();
    expect(snapshot.conflicts.map((conflict) => conflict.path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(snapshot.historicalVersions).toEqual([...snapshot.historicalVersions].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.reference.localeCompare(left.reference)));
    for (const conflict of snapshot.conflicts) {
      expect(Object.keys(conflict)).not.toEqual(expect.arrayContaining(["heads", "id", "parents", "blobHash", "mutation"]));
    }
  });

  it("orders Historical Versions by instant rather than timestamp spelling", async () => {
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    const states = new MemoryStates();
    const bytes = encoder.encode("body");
    const hash = await sha256(bytes);
    remote.blobs.set(hash, bytes.buffer);
    remote.operations.set("offset-time", { protocolVersion: 1, id: "offset-time", deviceId: "source", sequence: 1, createdAt: "2026-08-10T10:00:00+08:00", changes: [{ kind: "put", path: "offset.md", parents: [], blobHash: hash, size: bytes.byteLength, mimeType: "text/markdown" }] });
    remote.operations.set("utc-time", { protocolVersion: 1, id: "utc-time", deviceId: "source", sequence: 2, createdAt: "2026-08-10T03:00:00Z", changes: [{ kind: "put", path: "utc.md", parents: [], blobHash: hash, size: bytes.byteLength, mimeType: "text/markdown" }] });
    const root = createProtocol({ local, binding: { remote, states } });
    await root.syncEngine.sync();
    expect((await root.versionHistory.snapshot()).historicalVersions.map((version) => version.path)).toEqual(["utc.md", "offset.md"]);
  });

  it("projects pending file versions as non-restorable until sync publishes them, while deletions stay non-restorable", async () => {
    const current = await conflictedRoot();
    const conflicts = (await current.root.versionHistory.snapshot()).conflicts;
    const a = conflicts.find((conflict) => conflict.path === "a.md")!;
    const b = conflicts.find((conflict) => conflict.path === "b.md")!;
    await current.root.versionHistory.resolveBatch([
      { reference: a.reference, choice: "keep-current-file" },
      { reference: b.reference, choice: "keep-deleted" },
    ]);
    const pending = await current.root.versionHistory.snapshot();
    const pendingFile = pending.historicalVersions.find((version) => version.path === "a.md" && version.content === "file" && version.restorable === false);
    expect(pendingFile).toBeDefined();
    const pendingDeletion = pending.historicalVersions.find((version) => version.path === "b.md" && version.content === "deletion");
    expect(pendingDeletion).toMatchObject({ publication: "pending", restorable: false });

    await current.root.syncEngine.sync();
    const published = await current.root.versionHistory.snapshot();
    expect(published.historicalVersions.find((version) => version.reference === pendingFile!.reference)).toMatchObject({ publication: "published", restorable: true });
    expect(published.historicalVersions.find((version) => version.reference === pendingDeletion!.reference)).toMatchObject({ publication: "published", restorable: false, content: "deletion" });
  });

  it("projects each Conflict choice from the managed local vault rather than the graph primary", async () => {
    const current = await conflictedRoot();
    current.local.files.delete("a.md");
    expect((await current.root.versionHistory.snapshot()).conflicts.find((conflict) => conflict.path === "a.md")?.current).toBe("deletion");
    current.local.files.set("a.md", encoder.encode("chosen locally"));
    expect((await current.root.versionHistory.snapshot()).conflicts.find((conflict) => conflict.path === "a.md")?.current).toBe("file");
  });

  it("restores a retained Historical Version, persists it, and publishes it through sync", async () => {
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    const states = new MemoryStates();
    local.files.set("note.md", encoder.encode("first"));
    const root = createProtocol({ local, binding: { remote, states } });

    await root.syncEngine.sync();
    const first = (await root.versionHistory.snapshot()).historicalVersions[0]!;
    local.files.set("note.md", encoder.encode("second"));
    await root.syncEngine.sync();

    await root.versionHistory.restore(first.reference);
    expect(decoder.decode(local.files.get("note.md"))).toBe("first");
    expect((await root.versionHistory.snapshot()).historicalVersions).toHaveLength(3);

    const reconstructed = createProtocol({ local, binding: { remote, states } });
    await reconstructed.syncEngine.sync();
    expect(remote.operations.size).toBe(3);
    expect(decoder.decode(local.files.get("note.md"))).toBe("first");
  });

  it("does not write corrupt Historical Version content", async () => {
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    const states = new MemoryStates();
    local.files.set("note.md", encoder.encode("good"));
    const root = createProtocol({ local, binding: { remote, states } });
    await root.syncEngine.sync();
    const version = (await root.versionHistory.snapshot()).historicalVersions[0]!;
    const [hash] = remote.blobs.keys();
    remote.blobs.set(hash!, encoder.encode("corrupt").buffer);

    await expect(root.versionHistory.restore(version.reference)).rejects.toThrow("integrity verification");
    expect(decoder.decode(local.files.get("note.md"))).toBe("good");
  });

  it("withdraws Historical Version restoration when its path becomes unmanaged", async () => {
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    const states = new MemoryStates();
    local.files.set("note.md", encoder.encode("first"));
    const root = createProtocol({ local, binding: { remote, states } });
    await root.syncEngine.sync();
    const version = (await root.versionHistory.snapshot()).historicalVersions.find((entry) => entry.path === "note.md")!;
    expect(version.restorable).toBe(true);

    local.unmanaged.add("note.md");
    expect((await root.versionHistory.snapshot()).historicalVersions.find((entry) => entry.reference === version.reference)?.restorable).toBe(false);
    const saves = states.saves;
    const writes = local.writes;
    const gets = remote.gets;
    await expect(root.versionHistory.restore(version.reference)).rejects.toThrow("unmanaged path: note.md");
    expect(remote.gets).toBe(gets);
    expect(local.writes).toBe(writes);
    expect(states.saves).toBe(saves);

    local.unmanaged.delete("note.md");
    expect((await root.versionHistory.snapshot()).historicalVersions.find((entry) => entry.reference === version.reference)?.restorable).toBe(true);
  });

  it("rejects malformed, unknown, deleted, and evicted Historical Version references", async () => {
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    const states = new MemoryStates();
    local.files.set("note.md", encoder.encode("first"));
    const root = createProtocol({ local, binding: { remote, states }, options: { retainedVersionsPerPath: 1 } });
    await root.syncEngine.sync();
    const evicted = (await root.versionHistory.snapshot()).historicalVersions[0]!;
    local.files.delete("note.md");
    await root.syncEngine.sync();
    const deletion = (await root.versionHistory.snapshot()).historicalVersions.find((version) => version.content === "deletion")!;

    await expect(root.versionHistory.restore("h:malformed" as typeof deletion.reference)).rejects.toThrow("unavailable");
    await expect(root.versionHistory.restore(evicted.reference)).rejects.toThrow("unavailable");
    await expect(root.versionHistory.restore(deletion.reference)).rejects.toThrow("unavailable");
    expect(local.writes).toBe(0);
    expect((await root.versionHistory.snapshot()).historicalVersions).toHaveLength(1);
  });

  it("does not accept a Historical Version reference when a retained operation id is reused with different content", async () => {
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    const states = new MemoryStates();
    const first = encoder.encode("first");
    const second = encoder.encode("second");
    const firstHash = await sha256(first);
    const secondHash = await sha256(second);
    remote.blobs.set(firstHash, first.buffer);
    remote.blobs.set(secondHash, second.buffer);
    remote.operations.set("reused", { protocolVersion: 1, id: "reused", deviceId: "source", sequence: 1, createdAt: "2026-08-01T00:00:00.000Z", changes: [{ kind: "put", path: "note.md", parents: [], blobHash: firstHash, size: first.byteLength, mimeType: "text/markdown" }] });
    const root = createProtocol({ local, binding: { remote, states } });
    await root.syncEngine.sync();
    const old = (await root.versionHistory.snapshot()).historicalVersions[0]!;
    remote.operations.set("reused", { protocolVersion: 1, id: "reused", deviceId: "source", sequence: 1, createdAt: "2026-08-02T00:00:00.000Z", changes: [{ kind: "put", path: "note.md", parents: [], blobHash: secondHash, size: second.byteLength, mimeType: "text/markdown" }] });
    await root.rebind({ remote, states }, { resetState: true });
    await root.syncEngine.sync();
    await expect(root.versionHistory.restore(old.reference)).rejects.toThrow("unavailable");
  });

  it("keeps restoration recoverable across remote-read and vault-write failures", async () => {
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    const states = new MemoryStates();
    local.files.set("note.md", encoder.encode("first"));
    const root = createProtocol({ local, binding: { remote, states } });
    await root.syncEngine.sync();
    const version = (await root.versionHistory.snapshot()).historicalVersions[0]!;
    const read = remote.getBlob.bind(remote);
    remote.getBlob = async () => { throw new Error("offline"); };
    await expect(root.versionHistory.restore(version.reference)).rejects.toThrow("Historical Version restoration failed for note.md");
    remote.getBlob = read;
    local.failWrite = new Error("disk full");
    await expect(root.versionHistory.restore(version.reference)).rejects.toThrow("Historical Version restoration failed for note.md");
    local.failWrite = null;
    await expect(root.versionHistory.restore(version.reference)).resolves.toMatchObject({ path: "note.md" });
  });

  it("returns domain-safe Version History errors without adapter details", async () => {
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    const states = new MemoryStates();
    local.files.set("note.md", encoder.encode("first"));
    const root = createProtocol({ local, binding: { remote, states } });
    await root.syncEngine.sync();
    const version = (await root.versionHistory.snapshot()).historicalVersions[0]!;

    states.failLoad = new Error("Bearer secret-token blob deadbeef backend-id-123");
    await expect(root.versionHistory.snapshot()).rejects.toThrow("Version History snapshot is unavailable");
    await root.versionHistory.snapshot().catch((error: Error) => {
      expect(error.message).not.toMatch(/secret-token|deadbeef|backend-id-123/);
    });
    states.failLoad = null;

    remote.getBlob = async () => { throw new Error("Bearer secret-token blob deadbeef backend-id-123"); };
    await root.versionHistory.restore(version.reference).catch((error: Error) => {
      expect(error.message).toContain("Historical Version restoration failed for note.md");
      expect(error.message).not.toMatch(/secret-token|deadbeef|backend-id-123|h:/);
      expect(error.message).not.toContain(version.reference);
    });

    const current = await conflictedRoot();
    const conflict = (await current.root.versionHistory.snapshot()).conflicts[0]!;
    current.local.failRemove = new Error("Bearer secret-token blob deadbeef backend-id-123");
    await current.root.versionHistory.resolveBatch([{ reference: conflict.reference, choice: "keep-deleted" }]).catch((error: Error) => {
      expect(error.message).toContain(`Conflict resolution failed for ${conflict.path}`);
      expect(error.message).not.toMatch(/secret-token|deadbeef|backend-id-123|c:/);
      expect(error.message).not.toContain(conflict.reference);
    });
  });

  it("rejects invalid Conflict batches before any vault or persisted-state effect", async () => {
    const current = await conflictedRoot();
    const snapshot = await current.root.versionHistory.snapshot();
    const first = snapshot.conflicts[0]!;
    const invalid = { reference: "c:not-a-conflict" as typeof first.reference, choice: "keep-deleted" as const };
    const attempts: readonly ConflictChoice[][] = [
      [],
      [invalid],
      [{ reference: first.reference, choice: "keep-deleted" }, { reference: first.reference, choice: "keep-current-file" }],
      [{ reference: first.reference, choice: "keep-deleted" }, invalid],
    ];
    for (const choices of attempts) {
      const saves = current.states.saves;
      const removes = current.local.removes;
      await expect(current.root.versionHistory.resolveBatch(choices)).rejects.toThrow();
      expect(current.states.saves).toBe(saves);
      expect(current.local.removes).toBe(removes);
    }

    for (const invalidRequest of [[{ reference: first.reference, choice: "merge" }], [null]] as unknown[]) {
      const saves = current.states.saves;
      const removes = current.local.removes;
      await expect(current.root.versionHistory.resolveBatch(invalidRequest as ConflictChoice[])).rejects.toThrow("Conflict resolution");
      expect(current.states.saves).toBe(saves);
      expect(current.local.removes).toBe(removes);
    }

    current.local.unmanaged.add(first.path);
    await expect(current.root.versionHistory.resolveBatch([{ reference: first.reference, choice: "keep-deleted" }])).rejects.toThrow();
    expect(current.local.removes).toBe(0);
  });

  it("rejects an oversized Conflict batch before any effect", async () => {
    const current = await conflictedRoot();
    const conflict = (await current.root.versionHistory.snapshot()).conflicts[0]!;
    const choices = Array.from({ length: 10_001 }, () => ({ reference: conflict.reference, choice: "keep-deleted" as const }));
    const saves = current.states.saves;
    await expect(current.root.versionHistory.resolveBatch(choices)).rejects.toThrow("Conflict resolution");
    expect(current.states.saves).toBe(saves);
    expect(current.local.removes).toBe(0);
  });

  it("resolves 1,001 distinct Conflicts in one valid batch operation", async () => {
    const current = await manyConflictedRoot(1_001);
    const conflicts = (await current.root.versionHistory.snapshot()).conflicts;
    const saves = current.states.saves;

    await expect(current.root.versionHistory.resolveBatch(conflicts.map((conflict) => ({ reference: conflict.reference, choice: "keep-deleted" })))).resolves.toMatchObject({ paths: expect.arrayContaining(["conflicts/00000.md", "conflicts/01000.md"]) });

    expect(current.states.saves).toBe(saves + 1);
    expect((await current.root.versionHistory.snapshot()).conflicts).toEqual([]);
    await current.root.syncEngine.sync();
    expect(current.remote.operations.size).toBe(3);
  });

  it("accepts exactly 10,000 distinct Conflict choices", async () => {
    const current = await manyConflictedRoot(10_000);
    const conflicts = (await current.root.versionHistory.snapshot()).conflicts;
    expect(conflicts).toHaveLength(10_000);
    const saves = current.states.saves;

    const result = await current.root.versionHistory.resolveBatch(conflicts.map((conflict) => ({ reference: conflict.reference, choice: "keep-deleted" })));
    expect(result.paths).toHaveLength(10_000);
    expect(result.paths.at(0)).toBe("conflicts/00000.md");
    expect(result.paths.at(-1)).toBe("conflicts/09999.md");
    expect(current.states.saves).toBe(saves + 1);

    await current.root.syncEngine.sync();
    expect(current.remote.operations.size).toBe(3);
  }, 20_000);

  it("rejects restoration when the path has unpublished pending ancestry", async () => {
    const current = await conflictedRoot();
    const before = await current.root.versionHistory.snapshot();
    const historical = before.historicalVersions.find((version) => version.path === "a.md" && version.restorable)!;
    const conflict = before.conflicts.find((entry) => entry.path === "a.md")!;
    await current.root.versionHistory.resolveBatch([{ reference: conflict.reference, choice: "keep-current-file" }]);
    const writes = current.local.writes;
    await expect(current.root.versionHistory.restore(historical.reference)).rejects.toThrow("publication is pending");
    expect(current.local.writes).toBe(writes);
  });

  it.each(["keep-current-file", "keep-deleted"] as const)("rejects %s Conflict resolution with unpublished pending ancestry before effects", async (choice) => {
    const local = new MemoryLocal();
    local.files.set("note.md", encoder.encode("current"));
    const remote = new MemoryRemote();
    const states = new MemoryStates();
    const first = await sha256("first");
    const second = await sha256("second");
    states.value = {
      protocolVersion: 1,
      deviceId: "device",
      nextSequence: 2,
      cursor: "0",
      materialized: {},
      lastRepairAt: null,
      operations: {
        desktop: { protocolVersion: 1, id: "desktop", deviceId: "desktop", sequence: 1, createdAt: "2026-08-10T00:00:00Z", changes: [{ kind: "put", path: "note.md", parents: [], blobHash: first, size: 5, mimeType: "text/markdown" }] },
        phone: { protocolVersion: 1, id: "phone", deviceId: "phone", sequence: 1, createdAt: "2026-08-10T00:00:01Z", changes: [{ kind: "put", path: "note.md", parents: [], blobHash: second, size: 6, mimeType: "text/markdown" }] },
      },
      pending: [{ protocolVersion: 1, id: "device-pending", deviceId: "device", sequence: 1, createdAt: "2026-08-10T00:00:02Z", changes: [{ kind: "put", path: "note.md", parents: [], blobHash: first, size: 5, mimeType: "text/markdown" }] }],
    };
    const root = createProtocol({ local, binding: { remote, states } });
    const conflict = (await root.versionHistory.snapshot()).conflicts[0]!;
    await expect(root.versionHistory.resolveBatch([{ reference: conflict.reference, choice }])).rejects.toThrow("publication is pending");
    expect(local.removes).toBe(0);
    expect(local.writes).toBe(0);
    expect(states.saves).toBe(0);
  });

  it("rejects keep-current-file after the managed file disappears without resolving anything", async () => {
    const current = await conflictedRoot();
    const snapshot = await current.root.versionHistory.snapshot();
    const first = snapshot.conflicts[0]!;
    current.local.files.delete(first.path);
    const saves = current.states.saves;
    await expect(current.root.versionHistory.resolveBatch([{ reference: first.reference, choice: "keep-current-file" }])).rejects.toThrow("does not exist");
    expect(current.states.saves).toBe(saves);
    expect(current.local.removes).toBe(0);
  });

  it("queues restoration behind sync and revalidates an evicted Historical Version before writing", async () => {
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    const states = new MemoryStates();
    local.files.set("note.md", encoder.encode("first"));
    const root = createProtocol({ local, binding: { remote, states }, options: { retainedVersionsPerPath: 1 } });
    await root.syncEngine.sync();
    const old = (await root.versionHistory.snapshot()).historicalVersions[0]!;
    local.files.set("note.md", encoder.encode("second"));
    let release = (): void => undefined;
    remote.pullGate = new Promise<void>((resolve) => { release = resolve; });
    const sync = root.syncEngine.sync();
    const restore = root.versionHistory.restore(old.reference);
    release();
    await sync;
    await expect(restore).rejects.toThrow("unavailable");
    expect(local.writes).toBe(0);
  });

  it("pins immutable binding epochs across queued sync, rebind, and unbind", async () => {
    const local = new MemoryLocal();
    local.files.set("note.md", encoder.encode("bound to first"));
    const firstRemote = new MemoryRemote();
    const secondRemote = new MemoryRemote();
    const firstStates = new MemoryStates();
    const secondStates = new MemoryStates();
    let release = (): void => undefined;
    firstRemote.pullGate = new Promise<void>((resolve) => { release = resolve; });
    const supplied = { remote: firstRemote, states: firstStates };
    const root = createProtocol({ local, binding: supplied });
    const sync = root.syncEngine.sync();
    // A caller mutating its original object cannot retarget the in-flight epoch.
    supplied.remote = secondRemote;
    const rebind = root.rebind({ remote: secondRemote, states: secondStates }, { resetState: true });
    release();
    await sync;
    await rebind;
    expect(firstRemote.operations.size).toBe(1);
    expect(secondRemote.operations.size).toBe(0);
    expect((await root.versionHistory.snapshot()).historicalVersions).toEqual([]);
    await root.unbind();
    await expect(root.versionHistory.snapshot()).rejects.toThrow("not bound");
  });

  it("lets sync callers join one run even while a Version History mutation is queued", async () => {
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    const states = new MemoryStates();
    local.files.set("note.md", encoder.encode("first"));
    const root = createProtocol({ local, binding: { remote, states } });
    await root.syncEngine.sync();
    const version = (await root.versionHistory.snapshot()).historicalVersions[0]!;
    let release = (): void => undefined;
    remote.getGate = new Promise<void>((resolve) => { release = resolve; });
    const restore = root.versionHistory.restore(version.reference);
    const first = root.syncEngine.sync();
    const second = root.syncEngine.sync();
    expect(second).toBe(first);
    release();
    await restore;
    await first;
  });

  it("queues Conflict resolution behind sync and rejects a changed Conflict reference without effects", async () => {
    const current = await conflictedRoot();
    const old = (await current.root.versionHistory.snapshot()).conflicts[0]!;
    let release = (): void => undefined;
    current.remote.pullGate = new Promise<void>((resolve) => { release = resolve; });
    const sync = current.root.syncEngine.sync();
    const [hash, content] = current.remote.blobs.entries().next().value as [string, ArrayBuffer];
    current.remote.operations.set("resolver-a", {
      protocolVersion: 1,
      id: "resolver-a",
      deviceId: "resolver",
      sequence: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      changes: [{ kind: "put", path: old.path, parents: ["desktop-a", "phone-a"], blobHash: hash, size: content.byteLength, mimeType: "text/markdown" }],
    });
    const resolve = current.root.versionHistory.resolveBatch([{ reference: old.reference, choice: "keep-deleted" }]);
    const saves = current.states.saves;
    release();
    await sync;
    await expect(resolve).rejects.toThrow("unknown or stale");
    expect(current.local.removedPaths).not.toContain(old.path);
    expect(current.states.saves).toBeGreaterThan(saves);
  });

  it("publishes one mixed resolution batch, keeps deletions, and leaves unselected Conflicts", async () => {
    const current = await conflictedRoot();
    const snapshot = await current.root.versionHistory.snapshot();
    const a = snapshot.conflicts.find((conflict) => conflict.path === "a.md")!;
    const b = snapshot.conflicts.find((conflict) => conflict.path === "b.md")!;
    await current.root.versionHistory.resolveBatch([
      { reference: a.reference, choice: "keep-deleted" },
      { reference: b.reference, choice: "keep-current-file" },
    ]);
    await current.root.syncEngine.sync();

    expect(current.local.files.has("a.md")).toBe(false);
    expect(current.remote.operations.size).toBe(7);
    expect((await current.root.versionHistory.snapshot()).conflicts.map((conflict) => conflict.path)).toEqual(["c.md"]);
    const reconstructed = createProtocol({ local: current.local, binding: { remote: current.remote, states: current.states } });
    expect((await reconstructed.versionHistory.snapshot()).conflicts.map((conflict) => conflict.path)).toEqual(["c.md"]);
  });

  it("keeps Conflict resolution retryable after vault-removal and state-save failures", async () => {
    const removeFailure = await conflictedRoot();
    const removeChoice = (await removeFailure.root.versionHistory.snapshot()).conflicts[0]!;
    removeFailure.local.failRemove = new Error("read-only vault");
    await expect(removeFailure.root.versionHistory.resolveBatch([{ reference: removeChoice.reference, choice: "keep-deleted" }])).rejects.toThrow(`Conflict resolution failed for ${removeChoice.path}`);
    removeFailure.local.failRemove = null;
    await expect(removeFailure.root.versionHistory.resolveBatch([{ reference: removeChoice.reference, choice: "keep-deleted" }])).resolves.toEqual({ paths: [removeChoice.path] });

    const saveFailure = await conflictedRoot();
    const saveChoice = (await saveFailure.root.versionHistory.snapshot()).conflicts[0]!;
    saveFailure.states.failSave = new Error("settings unavailable");
    await expect(saveFailure.root.versionHistory.resolveBatch([{ reference: saveChoice.reference, choice: "keep-deleted" }])).rejects.toThrow(`Conflict resolution failed for ${saveChoice.path}`);
    saveFailure.states.failSave = null;
    await expect(saveFailure.root.versionHistory.resolveBatch([{ reference: saveChoice.reference, choice: "keep-deleted" }])).resolves.toEqual({ paths: [saveChoice.path] });
  });

  it("resolves a coherent Conflict batch and publishes the chosen current files", async () => {
    const current = await conflictedRoot();
    const snapshot = await current.root.versionHistory.snapshot();
    expect(snapshot.conflicts.map((conflict) => conflict.path)).toEqual(["a.md", "b.md", "c.md"]);

    await current.root.versionHistory.resolveBatch(snapshot.conflicts.map((conflict) => ({ reference: conflict.reference, choice: "keep-current-file" })));
    await current.root.syncEngine.sync();

    expect((await current.root.versionHistory.snapshot()).conflicts).toEqual([]);
    expect(current.remote.operations.size).toBe(7);
  });
});
