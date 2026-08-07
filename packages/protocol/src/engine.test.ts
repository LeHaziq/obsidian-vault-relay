import { describe, expect, it } from "vitest";
import { createInitialState, DestructiveSyncError, parseSyncState, SyncEngine, validateOperation } from "./engine.js";
import { sha256 } from "./hash.js";
import { PROTOCOL_VERSION, type LocalFile, type LocalVault, type RemoteVault, type StateRepository, type SyncOperation, type SyncState } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class MemoryLocal implements LocalVault {
  files = new Map<string, Uint8Array>();
  excluded = new Set<string>();

  set(path: string, content: string): void {
    this.files.set(path, encoder.encode(content));
  }

  text(path: string): string | undefined {
    const value = this.files.get(path);
    return value ? decoder.decode(value) : undefined;
  }

  async scan(): Promise<LocalFile[]> {
    return Promise.all([...this.files].filter(([path]) => !this.excluded.has(path)).map(async ([path, content]) => ({
      path,
      hash: await sha256(content),
      size: content.byteLength,
      mimeType: path.endsWith(".md") ? "text/markdown" : "application/octet-stream",
    })));
  }

  isManaged(path: string): boolean { return !this.excluded.has(path); }

  async read(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path);
    if (!value) throw new Error(`Missing ${path}`);
    return value.slice().buffer;
  }

  async write(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(content.slice(0)));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

/** A local vault that reports each file twice: once un-normalized, once normalized. */
class UnnormalizedLocal extends MemoryLocal {
  async scan(): Promise<LocalFile[]> {
    const files = await super.scan();
    return files.flatMap((file) => [{ ...file, path: `/${file.path}` }, file]);
  }
}

class MemoryRemote implements RemoteVault {
  blobs = new Map<string, ArrayBuffer>();
  operations = new Map<string, SyncOperation>();

  async pullOperations(cursor: string | null): Promise<{ operations: SyncOperation[]; cursor: string }> {
    const offset = Number(cursor ?? 0);
    const operations = [...this.operations.values()].slice(offset);
    return { operations, cursor: String(this.operations.size) };
  }

  async hasBlob(hash: string): Promise<boolean> { return this.blobs.has(hash); }
  async putBlob(hash: string, content: ArrayBuffer): Promise<void> { this.blobs.set(hash, content.slice(0)); }
  async getBlob(hash: string): Promise<ArrayBuffer> {
    const value = this.blobs.get(hash);
    if (!value) throw new Error(`Missing blob ${hash}`);
    return value.slice(0);
  }
  async putOperation(operation: SyncOperation): Promise<void> { this.operations.set(operation.id, operation); }
  async ensureOperations(operations: SyncOperation[]): Promise<void> {
    for (const operation of operations) this.operations.set(operation.id, operation);
  }
}

class MemoryState implements StateRepository {
  constructor(public state: SyncState) {}
  async load(): Promise<SyncState> { return structuredClone(this.state); }
  async save(state: SyncState): Promise<void> { this.state = structuredClone(state); }
}

function device(local: MemoryLocal, remote: MemoryRemote, id: string) {
  const states = new MemoryState(createInitialState(id));
  return { states, engine: new SyncEngine(local, remote, states) };
}

describe("SyncEngine", () => {
  it("uploads, downloads, and deletes files", async () => {
    const remote = new MemoryRemote();
    const first = new MemoryLocal();
    first.set("note.md", "hello");
    const a = device(first, remote, "desktop");
    await a.engine.sync();

    const second = new MemoryLocal();
    const b = device(second, remote, "phone");
    await b.engine.sync();
    expect(second.text("note.md")).toBe("hello");

    first.files.delete("note.md");
    await a.engine.sync();
    await b.engine.sync();
    expect(second.text("note.md")).toBeUndefined();
  });

  it("preserves both concurrent offline edits", async () => {
    const remote = new MemoryRemote();
    const desktop = new MemoryLocal();
    desktop.set("note.md", "base");
    const a = device(desktop, remote, "desktop");
    await a.engine.sync();

    const phone = new MemoryLocal();
    const b = device(phone, remote, "phone");
    await b.engine.sync();
    desktop.set("note.md", "desktop edit");
    phone.set("note.md", "phone edit");

    await a.engine.sync();
    const result = await b.engine.sync();
    await a.engine.sync();
    expect(result.conflicts).toHaveLength(1);
    const allDesktopText = [...desktop.files.values()].map((value) => decoder.decode(value));
    expect(allDesktopText).toContain("desktop edit");
    expect(allDesktopText).toContain("phone edit");
  });

  it("syncs a local vault that reports un-normalized paths", async () => {
    const remote = new MemoryRemote();
    const local = new UnnormalizedLocal();
    local.set("note.md", "hello");
    const current = device(local, remote, "device");

    const result = await current.engine.sync();

    const uploadedPaths = [...remote.operations.values()].flatMap((operation) => operation.changes).map((change) => change.path);
    expect(result.uploadedOperations).toBe(1);
    expect(uploadedPaths).toEqual(["note.md"]);
  });

  it("adopts matching remote files when linking with fresh state", async () => {
    const remote = new MemoryRemote();
    const source = new MemoryLocal();
    source.set("note.md", "same content");
    await device(source, remote, "source").engine.sync();

    const relinked = new MemoryLocal();
    relinked.set("note.md", "same content");
    const result = await device(relinked, remote, "relinked").engine.sync();

    expect(result.conflicts).toEqual([]);
    expect(result.uploadedOperations).toBe(0);
    expect(remote.operations.size).toBe(1);
    expect([...relinked.files.keys()]).toEqual(["note.md"]);
  });

  it("preserves differing local files when linking with fresh state", async () => {
    const remote = new MemoryRemote();
    const source = new MemoryLocal();
    source.set("note.md", "remote content");
    await device(source, remote, "source").engine.sync();

    const relinked = new MemoryLocal();
    relinked.set("note.md", "local content");
    const result = await device(relinked, remote, "relinked").engine.sync();

    expect(result.conflicts).toHaveLength(1);
    expect(result.uploadedOperations).toBe(1);
    expect([...relinked.files.values()].map((value) => decoder.decode(value))).toEqual(expect.arrayContaining(["local content", "remote content"]));
  });

  it("commits an operation only after its blob", async () => {
    const remote = new MemoryRemote();
    const local = new MemoryLocal();
    local.set("large.bin", "content");
    const original = remote.putBlob.bind(remote);
    remote.putBlob = async () => { throw new Error("offline"); };
    const current = device(local, remote, "device");
    await expect(current.engine.sync()).rejects.toThrow("offline");
    expect(remote.operations.size).toBe(0);
    expect(current.states.state.pending).toHaveLength(1);

    remote.putBlob = original;
    await current.engine.sync();
    expect(remote.operations.size).toBe(1);
    expect(current.states.state.pending).toHaveLength(0);
  });

  it("rejects unsafe remote paths before materialization", () => {
    expect(() => validateOperation({
      protocolVersion: 1,
      id: "bad",
      deviceId: "device",
      sequence: 1,
      createdAt: new Date().toISOString(),
      changes: [{ kind: "delete", path: "../outside", parents: [] }],
    })).toThrow("Unsafe vault path");
  });

  it("captures unrelated edits while retrying pending work", async () => {
    const remote = new MemoryRemote();
    const local = new MemoryLocal();
    local.set("first.md", "one");
    local.set("second.md", "base");
    const current = device(local, remote, "device");
    await current.engine.sync();
    local.set("first.md", "pending edit");
    const original = remote.putBlob.bind(remote);
    remote.putBlob = async () => { throw new Error("offline"); };
    await expect(current.engine.sync()).rejects.toThrow("offline");
    local.set("second.md", "newer local edit");
    remote.putBlob = original;
    await current.engine.sync();
    expect(local.text("second.md")).toBe("newer local edit");
    // Assert on what was published rather than on how changes were batched.
    const published = [...remote.operations.values()].flatMap((operation) => operation.changes);
    expect(published.filter((change) => change.path === "first.md")).toHaveLength(2);
    expect(published.filter((change) => change.path === "second.md")).toHaveLength(2);
    expect(current.states.state.pending).toHaveLength(0);
  });

  it("rejects corrupt downloaded content before writing", async () => {
    const remote = new MemoryRemote();
    const source = new MemoryLocal();
    source.set("note.md", "good");
    await device(source, remote, "source").engine.sync();
    const [hash] = remote.blobs.keys();
    if (!hash) throw new Error("Expected uploaded blob");
    remote.blobs.set(hash, encoder.encode("evil").buffer);
    const destination = new MemoryLocal();
    await expect(device(destination, remote, "destination").engine.sync()).rejects.toThrow("integrity verification");
    expect(destination.text("note.md")).toBeUndefined();
  });

  it("rejects cyclic operation graphs", () => {
    const now = new Date().toISOString();
    const make = (id: string, parent: string): SyncOperation => ({
      protocolVersion: 1,
      id,
      deviceId: "device",
      sequence: id === "a" ? 1 : 2,
      createdAt: now,
      changes: [{ kind: "delete", path: "note.md", parents: [parent] }],
    });
    const state = createInitialState("device");
    state.operations = { a: make("a", "b"), b: make("b", "a") };
    const local = new MemoryLocal();
    const remote = new MemoryRemote();
    const states = new MemoryState(state);
    return expect(new SyncEngine(local, remote, states).sync()).rejects.toThrow("cycle");
  });

  it("does not publish deletions when a path becomes excluded", async () => {
    const remote = new MemoryRemote();
    const local = new MemoryLocal();
    local.set("private.md", "keep");
    const current = device(local, remote, "device");
    await current.engine.sync();
    local.excluded.add("private.md");
    await current.engine.sync();
    expect(remote.operations.size).toBe(1);
    expect(local.text("private.md")).toBe("keep");
  });

  it("splits large changes into bounded operations", async () => {
    const remote = new MemoryRemote();
    const local = new MemoryLocal();
    for (let index = 0; index < 1_001; index += 1) local.set(`notes/${index}.md`, String(index));
    await device(local, remote, "device").engine.sync();
    expect(remote.operations.size).toBe(2);
    expect([...remote.operations.values()].every((operation) => operation.changes.length <= 1_000)).toBe(true);
  });

  it("rejects a MIME type that could inject multipart headers", () => {
    const operation = (mimeType: string): SyncOperation => ({
      protocolVersion: 1,
      id: "op",
      deviceId: "device",
      sequence: 1,
      createdAt: new Date().toISOString(),
      changes: [{ kind: "put", path: "a.md", parents: [], blobHash: "a".repeat(64), size: 1, mimeType }],
    });
    for (const bad of ["text/markdown\r\nContent-Type: evil", "not-a-mime", "", "a/b/c", "text /markdown", "x".repeat(300)]) {
      expect(() => validateOperation(operation(bad))).toThrow("invalid MIME type");
    }
    for (const good of ["text/markdown", "application/octet-stream", "image/svg+xml", "audio/mpeg"]) {
      expect(() => validateOperation(operation(good))).not.toThrow();
    }
  });

  it("stops between steps when the caller aborts", async () => {
    const remote = new MemoryRemote();
    const source = new MemoryLocal();
    for (let index = 0; index < 20; index += 1) source.set(`notes/${index}.md`, `body ${index}`);
    await device(source, remote, "source").engine.sync();

    const destination = new MemoryLocal();
    const states = new MemoryState(createInitialState("destination"));
    const controller = new AbortController();
    let downloaded = 0;
    const original = remote.getBlob.bind(remote);
    remote.getBlob = async (hash: string) => {
      downloaded += 1;
      if (downloaded === 3) controller.abort();
      return original(hash);
    };
    const engine = new SyncEngine(destination, remote, states, { signal: controller.signal });
    await expect(engine.sync()).rejects.toMatchObject({ name: "AbortError" });
    expect(destination.files.size).toBeLessThan(20);
    // Progress made before the abort is persisted, so a later sync resumes.
    remote.getBlob = original;
    await new SyncEngine(destination, remote, states).sync();
    expect(destination.files.size).toBe(20);
  });

  it("persists materialization progress without saving once per file", async () => {
    const remote = new MemoryRemote();
    const source = new MemoryLocal();
    for (let index = 0; index < 40; index += 1) source.set(`notes/${index}.md`, `body ${index}`);
    await device(source, remote, "source").engine.sync();

    const destination = new MemoryLocal();
    const states = new MemoryState(createInitialState("destination"));
    let saves = 0;
    const counting: StateRepository = {
      load: () => states.load(),
      save: async (state) => { saves += 1; await states.save(state); },
    };
    await new SyncEngine(destination, remote, counting, { checkpointEveryFiles: 50, checkpointEveryMs: 60_000 }).sync();
    expect(destination.files.size).toBe(40);
    // Previously this was one full-state write per materialized file.
    expect(saves).toBeLessThan(10);
  });

  it("repairs missing remote operations on a schedule rather than every sync", async () => {
    const remote = new MemoryRemote();
    const local = new MemoryLocal();
    local.set("note.md", "hello");
    const states = new MemoryState(createInitialState("device"));
    let repairs = 0;
    const original = remote.ensureOperations.bind(remote);
    remote.ensureOperations = async (operations) => { repairs += 1; await original(operations); };

    const engine = new SyncEngine(local, remote, states, { repairIntervalMs: 60_000 });
    await engine.sync();
    expect(repairs).toBe(1);
    await new SyncEngine(local, remote, states, { repairIntervalMs: 60_000 }).sync();
    expect(repairs).toBe(1);
    states.state.lastRepairAt = Date.now() - 120_000;
    await new SyncEngine(local, remote, states, { repairIntervalMs: 60_000 }).sync();
    expect(repairs).toBe(2);
  });

  it("re-uploads an operation the remote store lost during a repair pass", async () => {
    const remote = new MemoryRemote();
    const local = new MemoryLocal();
    local.set("note.md", "hello");
    const states = new MemoryState(createInitialState("device"));
    await new SyncEngine(local, remote, states).sync();
    expect(remote.operations.size).toBe(1);
    remote.operations.clear();
    states.state.lastRepairAt = null;
    await new SyncEngine(local, remote, states).sync();
    expect(remote.operations.size).toBe(1);
  });

  it("requires one-time approval for bulk remote deletion", async () => {
    const remote = new MemoryRemote();
    const source = new MemoryLocal();
    for (let index = 0; index < 30; index += 1) source.set(`notes/${index}.md`, "content");
    const a = device(source, remote, "source");
    await a.engine.sync();
    const destination = new MemoryLocal();
    const b = device(destination, remote, "destination");
    await b.engine.sync();
    source.files.clear();
    await a.engine.sync();
    await expect(b.engine.sync()).rejects.toBeInstanceOf(DestructiveSyncError);
    await new SyncEngine(destination, remote, b.states, { allowLargeDeletes: true }).sync();
    expect(destination.files.size).toBe(0);
  });
});

function operationFor(id: string, path: string, sequence = 1): SyncOperation {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id,
    deviceId: "desktop",
    sequence,
    createdAt: new Date().toISOString(),
    changes: [{ kind: "put", path, parents: [], blobHash: "a".repeat(64), size: 1, mimeType: "text/markdown" }],
  };
}

function persistedState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "desktop",
    nextSequence: 7,
    cursor: "token-9",
    operations: { op: operationFor("op", "a.md") },
    materialized: { "a.md": { hash: "a".repeat(64), operationId: "op" } },
    pending: [operationFor("later", "b.md", 6)],
    lastRepairAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("parseSyncState", () => {
  it("returns an initial state for a value that is not an object", () => {
    for (const value of [null, undefined, "corrupt", 42, []]) {
      const state = parseSyncState(value);
      expect(state.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(state.nextSequence).toBe(1);
      expect(state.operations).toEqual({});
      expect(state.deviceId.length).toBeGreaterThan(0);
    }
  });

  it("preserves a well-formed state", () => {
    const source = persistedState();
    const state = parseSyncState(source);
    expect(state.deviceId).toBe("desktop");
    expect(state.nextSequence).toBe(7);
    expect(state.cursor).toBe("token-9");
    expect(state.operations).toEqual(source.operations);
    expect(state.materialized).toEqual(source.materialized);
    expect(state.pending).toEqual(source.pending);
    expect(state.lastRepairAt).toBe(1_700_000_000_000);
  });

  it("discards a state from a different protocol version", () => {
    const state = parseSyncState(persistedState({ protocolVersion: 99 }));
    expect(state.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(state.operations).toEqual({});
    expect(state.cursor).toBeNull();
  });

  it("keeps the device identity when the rest is unusable", () => {
    const state = parseSyncState({ protocolVersion: 1, deviceId: "phone-1", operations: "nope" });
    expect(state.deviceId).toBe("phone-1");
    expect(state.operations).toEqual({});
    expect(state.nextSequence).toBe(1);
  });

  it("invents a device identity when the persisted one is unusable", () => {
    for (const deviceId of ["", 42, "x".repeat(201)]) {
      expect(parseSyncState(persistedState({ deviceId })).deviceId.length).toBeGreaterThan(0);
    }
  });

  it("discards a state that holds a malformed operation", () => {
    const truncated = { ...operationFor("op", "a.md"), changes: undefined };
    for (const operations of [{ op: truncated }, { op: {} }, { op: null }, { other: operationFor("op", "a.md") }]) {
      expect(parseSyncState(persistedState({ operations })).operations).toEqual({});
    }
  });

  it("discards a state whose pending work is malformed", () => {
    for (const pending of [[{}], [operationFor("op", "../outside")], "not an array"]) {
      expect(parseSyncState(persistedState({ pending })).pending).toEqual([]);
    }
  });

  it("discards a state whose materialized files are malformed", () => {
    const bad = [
      { "a.md": { hash: "short", operationId: "op" } },
      { "a.md": { hash: "a".repeat(64) } },
      { "../outside": { hash: "a".repeat(64), operationId: "op" } },
      { "a.md": "junk" },
    ];
    for (const materialized of bad) {
      expect(parseSyncState(persistedState({ materialized })).materialized).toEqual({});
    }
  });

  it("never rewinds the sequence counter behind the retained work", () => {
    // A repeated sequence number makes two different operations of one device.
    for (const nextSequence of ["abc", 0, Number.NaN, 2.5, 3]) {
      expect(parseSyncState(persistedState({ nextSequence })).nextSequence).toBe(7);
    }
    expect(parseSyncState(persistedState({ nextSequence: 12 })).nextSequence).toBe(12);
    expect(parseSyncState({ protocolVersion: PROTOCOL_VERSION, deviceId: "desktop", operations: {}, materialized: {}, pending: [], nextSequence: "abc" }).nextSequence).toBe(1);
  });

  it("drops a repair time that is not a number", () => {
    expect(parseSyncState(persistedState({ lastRepairAt: "soon" })).lastRepairAt).toBeNull();
  });

  it("drops a cursor that is not a plausible page token", () => {
    expect(parseSyncState(persistedState({ cursor: 5 })).cursor).toBeNull();
    expect(parseSyncState(persistedState({ cursor: "x".repeat(4_001) })).cursor).toBeNull();
  });

  it("gives the engine a state it accepts", async () => {
    const remote = new MemoryRemote();
    const local = new MemoryLocal();
    local.set("note.md", "body");
    const states = new MemoryState(parseSyncState("corrupt"));
    await new SyncEngine(local, remote, states).sync();
    expect(remote.operations.size).toBe(1);
  });
});
