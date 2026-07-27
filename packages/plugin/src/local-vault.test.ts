import { beforeEach, describe, expect, it } from "vitest";
import { TAbstractFile, TFile, TFolder, type Vault } from "obsidian";
import { ObsidianLocalVault } from "./local-vault";

const encoder = new TextEncoder();

function makeFile(path: string, mtime: number, size: number): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.slice(path.lastIndexOf("/") + 1);
  file.extension = path.slice(path.lastIndexOf(".") + 1);
  file.stat = { ctime: 0, mtime, size };
  return file;
}

class FakeVault {
  private readonly entries = new Map<string, { file: TFile; content: Uint8Array }>();
  private readonly folders = new Map<string, TFolder>();
  reads = 0;
  trashed: string[] = [];
  createdFolders: string[] = [];

  set(path: string, content: string, mtime = 1): TFile {
    const file = makeFile(path, mtime, content.length);
    this.entries.set(path, { file, content: encoder.encode(content) });
    return file;
  }

  touch(path: string, content: string, mtime: number): void {
    this.set(path, content, mtime);
  }

  getFiles(): TFile[] {
    return [...this.entries.values()].map((entry) => entry.file);
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.entries.get(path)?.file ?? this.folders.get(path) ?? null;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    this.reads += 1;
    const entry = this.entries.get(file.path);
    if (!entry) throw new Error(`missing ${file.path}`);
    return entry.content.slice().buffer;
  }

  async createBinary(path: string, content: ArrayBuffer): Promise<TFile> {
    const file = makeFile(path, 1, content.byteLength);
    this.entries.set(path, { file, content: new Uint8Array(content.slice(0)) });
    return file;
  }

  async modifyBinary(file: TFile, content: ArrayBuffer): Promise<void> {
    this.entries.set(file.path, { file, content: new Uint8Array(content.slice(0)) });
  }

  async createFolder(path: string): Promise<TFolder> {
    this.createdFolders.push(path);
    const folder = new TFolder();
    folder.path = path;
    this.folders.set(path, folder);
    return folder;
  }

  async trash(file: TAbstractFile): Promise<void> {
    this.trashed.push(file.path);
    this.entries.delete(file.path);
  }
}

let vault: FakeVault;
let exclusions: string[];

function subject(): ObsidianLocalVault {
  return new ObsidianLocalVault(vault as unknown as Vault, () => exclusions, () => 4);
}

beforeEach(() => {
  vault = new FakeVault();
  exclusions = [...[".obsidian/", ".trash/", ".DS_Store", "Thumbs.db"]];
});

describe("exclusions", () => {
  it("always excludes the .obsidian folder", () => {
    const local = subject();
    expect(local.isManaged(".obsidian/app.json")).toBe(false);
    expect(local.isManaged(".obsidian")).toBe(false);
    expect(local.isManaged("notes/obsidian.md")).toBe(true);
  });

  it("excludes a bare file name at any depth", () => {
    // A rule without a separator previously matched only at the vault root, so
    // the default .DS_Store and Thumbs.db rules did nothing in subfolders.
    const local = subject();
    expect(local.isManaged(".DS_Store")).toBe(false);
    expect(local.isManaged("notes/images/.DS_Store")).toBe(false);
    expect(local.isManaged("a/b/c/Thumbs.db")).toBe(false);
    expect(local.isManaged("notes/My .DS_Store notes.md")).toBe(true);
  });

  it("excludes a folder and its contents for a trailing-slash rule", () => {
    exclusions = ["archive/"];
    const local = subject();
    expect(local.isManaged("archive")).toBe(false);
    expect(local.isManaged("archive/old.md")).toBe(false);
    expect(local.isManaged("archive/deep/old.md")).toBe(false);
    expect(local.isManaged("archived.md")).toBe(true);
    expect(local.isManaged("my-archive/old.md")).toBe(true);
  });

  it("treats a rule containing a separator as a path prefix", () => {
    exclusions = ["a/b.md", "vendor/lib"];
    const local = subject();
    expect(local.isManaged("a/b.md")).toBe(false);
    expect(local.isManaged("vendor/lib")).toBe(false);
    expect(local.isManaged("vendor/lib/x.md")).toBe(false);
    expect(local.isManaged("vendor/library.md")).toBe(true);
    expect(local.isManaged("z/a/b.md")).toBe(true);
  });

  it("ignores blank rules and normalizes separators", () => {
    exclusions = ["", "   ", "/archive/", "notes\\draft.md"];
    const local = subject();
    expect(local.isManaged("archive/x.md")).toBe(false);
    expect(local.isManaged("notes/draft.md")).toBe(false);
    expect(local.isManaged("keep.md")).toBe(true);
  });

  it("omits excluded files from a scan", async () => {
    vault.set("keep.md", "a");
    vault.set("notes/images/.DS_Store", "b");
    vault.set(".obsidian/app.json", "c");
    const scanned = await subject().scan();
    expect(scanned.map((file) => file.path)).toEqual(["keep.md"]);
  });
});

describe("hash cache", () => {
  it("does not re-read a file whose mtime and size are unchanged", async () => {
    vault.set("a.md", "hello", 100);
    const local = subject();
    const first = await local.scan();
    expect(vault.reads).toBe(1);
    const second = await local.scan();
    expect(vault.reads).toBe(1);
    expect(second[0]!.hash).toBe(first[0]!.hash);
  });

  it("re-hashes when the modification time changes", async () => {
    vault.set("a.md", "hello", 100);
    const local = subject();
    const first = await local.scan();
    vault.touch("a.md", "goodbye", 200);
    const second = await local.scan();
    expect(vault.reads).toBe(2);
    expect(second[0]!.hash).not.toBe(first[0]!.hash);
  });

  it("re-hashes when the size changes at the same mtime", async () => {
    vault.set("a.md", "hello", 100);
    const local = subject();
    await local.scan();
    vault.touch("a.md", "hello there", 100);
    await local.scan();
    expect(vault.reads).toBe(2);
  });

  it("invalidates the cache when the plugin writes the file", async () => {
    vault.set("a.md", "hello", 100);
    const local = subject();
    await local.scan();
    await local.write("a.md", encoder.encode("rewritten").slice().buffer);
    await local.scan();
    expect(vault.reads).toBe(2);
  });

  it("evicts entries for files that disappear", async () => {
    vault.set("a.md", "hello", 100);
    const local = subject();
    await local.scan();
    await local.remove("a.md");
    vault.set("a.md", "hello", 100);
    await local.scan();
    expect(vault.reads).toBe(2);
  });
});

describe("path handling", () => {
  it("rejects traversal on every filesystem entry point", async () => {
    const local = subject();
    await expect(local.read("../outside.md")).rejects.toThrow("Unsafe vault path");
    await expect(local.write("../outside.md", new ArrayBuffer(1))).rejects.toThrow("Unsafe vault path");
    await expect(local.remove("../outside.md")).rejects.toThrow("Unsafe vault path");
    await expect(local.write("a/../../b.md", new ArrayBuffer(1))).rejects.toThrow("Unsafe vault path");
  });

  it("creates missing parent folders before writing", async () => {
    await subject().write("a/b/c.md", encoder.encode("x").slice().buffer);
    expect(vault.createdFolders).toEqual(["a", "a/b"]);
    expect(vault.getAbstractFileByPath("a/b/c.md")).toBeInstanceOf(TFile);
  });

  it("trashes rather than hard-deletes", async () => {
    vault.set("a.md", "x");
    await subject().remove("a.md");
    expect(vault.trashed).toEqual(["a.md"]);
  });

  it("is a no-op when removing a file that is already gone", async () => {
    await expect(subject().remove("missing.md")).resolves.toBeUndefined();
  });
});

describe("mime types", () => {
  it("maps known extensions and falls back to octet-stream", async () => {
    vault.set("a.md", "x");
    vault.set("b.PNG", "y");
    vault.set("c.xyz", "z");
    const byPath = new Map((await subject().scan()).map((file) => [file.path, file.mimeType]));
    expect(byPath.get("a.md")).toBe("text/markdown");
    expect(byPath.get("b.PNG")).toBe("image/png");
    expect(byPath.get("c.xyz")).toBe("application/octet-stream");
  });
});
