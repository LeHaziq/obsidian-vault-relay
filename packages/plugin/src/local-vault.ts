import { normalizeVaultPath, sha256, type LocalFile, type LocalVault } from "@vault-relay/protocol";
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

export class ObsidianLocalVault implements LocalVault {
  constructor(
    private readonly vault: Vault,
    private readonly exclusions: () => string[],
    private readonly concurrency: () => number,
  ) {}

  async scan(): Promise<LocalFile[]> {
    const files = this.vault.getFiles().filter((file) => !this.isExcluded(file.path));
    return mapLimit(files, this.concurrency(), async (file) => {
      const content = await this.vault.readBinary(file);
      return {
        path: normalizeVaultPath(file.path),
        hash: await sha256(content),
        size: content.byteLength,
        mimeType: MIME_TYPES[file.extension.toLocaleLowerCase()] ?? "application/octet-stream",
      };
    });
  }

  async read(path: string): Promise<ArrayBuffer> {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new Error(`Local file not found: ${path}`);
    return this.vault.readBinary(file);
  }

  isManaged(path: string): boolean {
    return !this.isExcluded(path);
  }

  async write(path: string, content: ArrayBuffer): Promise<void> {
    const normalized = normalizePath(path);
    await this.ensureParent(normalized);
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) await this.vault.modifyBinary(existing, content);
    else if (existing) throw new Error(`Cannot replace folder with file: ${normalized}`);
    else await this.vault.createBinary(normalized, content);
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (!file) return;
    if (!(file instanceof TFile)) throw new Error(`Cannot remove folder as file: ${normalized}`);
    await this.vault.trash(file, true);
  }

  private isExcluded(path: string): boolean {
    const normalized = normalizeVaultPath(path);
    if (normalized === ".obsidian" || normalized.startsWith(".obsidian/")) return true;
    return this.exclusions().some((entry) => {
      const rule = entry.replaceAll("\\", "/").replace(/^\/+/, "");
      return rule.endsWith("/") ? normalized.startsWith(rule) : normalized === rule;
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

async function mapLimit<T, R>(values: T[], concurrency: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      result[index] = await run(values[index]!);
    }
  });
  await Promise.all(workers);
  return result;
}
