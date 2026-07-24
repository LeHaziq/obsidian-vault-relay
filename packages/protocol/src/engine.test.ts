import { describe, expect, it } from "vitest";
import { createInitialState, DestructiveSyncError, SyncEngine, validateOperation } from "./engine.js";
import { sha256 } from "./hash.js";
import type { LocalFile, LocalVault, RemoteVault, StateRepository, SyncOperation, SyncState } from "./types.js";

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
    expect(remote.operations.size).toBe(3);
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
