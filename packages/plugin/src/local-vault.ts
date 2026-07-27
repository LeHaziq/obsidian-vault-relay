import { mapLimit, normalizeVaultPath, sha256, type LocalFile, type LocalVault } from "@vault-relay/protocol";
import { normalizePath, TFile, type Vault } from "obsidian";

const MIME_TYPES: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

interface CachedHash {
  mtime: number;
  size: number;
  hash: string;
}

export class ObsidianLocalVault implements LocalVault {
  /** Keyed by vault path; invalidated by mtime/size change and by local writes. */
  private readonly hashes = new Map<string, CachedHash>();

  constructor(
    private readonly vault: Vault,
    private readonly exclusions: () => string[],
    private readonly concurrency: () => number,
  ) {}

  async scan(): Promise<LocalFile[]> {
    const files = this.vault.getFiles().filter((file) => !this.isExcluded(file.path));
    const present = new Set(files.map((file) => file.path));
    for (const path of this.hashes.keys()) {
      if (!present.has(path)) this.hashes.delete(path);
    }
    return mapLimit(files, this.concurrency(), async (file) => {
      const mimeType = MIME_TYPES[file.extension.toLocaleLowerCase()] ?? "application/octet-stream";
      const cached = this.hashes.get(file.path);
      // Re-reading and re-hashing the whole vault on every sync tick was the
      // dominant cost on mobile; stat is enough to detect a change.
      if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
        return { path: normalizeVaultPath(file.path), hash: cached.hash, size: cached.size, mimeType };
      }
      const content = await this.vault.readBinary(file);
      const hash = await sha256(content);
      this.hashes.set(file.path, { mtime: file.stat.mtime, size: content.byteLength, hash });
      return { path: normalizeVaultPath(file.path), hash, size: content.byteLength, mimeType };
    });
  }

  async read(path: string): Promise<ArrayBuffer> {
    const file = this.vault.getAbstractFileByPath(this.resolve(path));
    if (!(file instanceof TFile)) throw new Error(`Local file not found: ${path}`);
    return this.vault.readBinary(file);
  }

  isManaged(path: string): boolean {
    return !this.isExcluded(path);
  }

  async write(path: string, content: ArrayBuffer): Promise<void> {
    const normalized = this.resolve(path);
    await this.ensureParent(normalized);
    const existing = this.vault.getAbstractFileByPath(normalized);
    this.hashes.delete(normalized);
    if (existing instanceof TFile) await this.vault.modifyBinary(existing, content);
    else if (existing) throw new Error(`Cannot replace folder with file: ${normalized}`);
    else await this.vault.createBinary(normalized, content);
  }

  async remove(path: string): Promise<void> {
    const normalized = this.resolve(path);
    this.hashes.delete(normalized);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (!file) return;
    if (!(file instanceof TFile)) throw new Error(`Cannot remove folder as file: ${normalized}`);
    await this.vault.trash(file, true);
  }

  /**
   * Obsidian's normalizePath does not reject traversal, so validate here as
   * well rather than relying on every caller having gone through the engine.
   */
  private resolve(path: string): string {
    return normalizePath(normalizeVaultPath(path));
  }

  private isExcluded(path: string): boolean {
    const normalized = normalizeVaultPath(path);
    if (normalized === ".obsidian" || normalized.startsWith(".obsidian/")) return true;
    const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
    return this.exclusions().some((entry) => {
      const rule = entry.replaceAll("\\", "/").replace(/^\/+/, "").trim();
      if (!rule) return false;
      if (rule.endsWith("/")) return normalized === rule.slice(0, -1) || normalized.startsWith(rule);
      // A rule with no separator matches the file name at any depth, so
      // ".DS_Store" excludes "notes/images/.DS_Store" and not just the root one.
      if (!rule.includes("/")) return normalized === rule || basename === rule;
      return normalized === rule || normalized.startsWith(`${rule}/`);
    });
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.vault.getAbstractFileByPath(current)) await this.vault.createFolder(current);
    }
  }
}
