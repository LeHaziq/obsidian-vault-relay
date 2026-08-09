import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));

vi.mock("obsidian", () => ({ requestUrl }));

import { GoogleDriveSession } from "./remote-vault-session";

const roots = Array.from({ length: 3 }, (_, index) => ({
  id: `root-${index}`,
  name: `Vault Relay - Vault ${index}`,
  mimeType: "application/vnd.google-apps.folder",
  appProperties: {
    vaultRelayKind: "vault-root",
    vaultId: `vault-${index}`,
    vaultName: `Vault ${index}`,
  },
}));

function response(json: unknown) {
  return { status: 200, json, headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

class ConcurrencyProbe {
  active = 0;
  peak = 0;
  private gate!: Promise<void>;
  private releaseGate = (): void => undefined;

  constructor() { this.reset(); }

  reset(): void {
    this.active = 0;
    this.peak = 0;
    this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  }

  async hold(): Promise<void> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    await this.gate;
    this.active -= 1;
  }

  release(): void { this.releaseGate(); }
}

describe("GoogleDriveSession", () => {
  beforeEach(() => { requestUrl.mockReset(); });

  it("uses the current concurrency setting when listing remote vaults", async () => {
    let concurrency = 1;
    const children = new ConcurrencyProbe();

    requestUrl.mockImplementation(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.searchParams.get("q")?.includes("value='vault-root'")) return response({ files: roots });
      if (parsed.searchParams.get("q")?.includes("in parents")) {
        await children.hold();
        const rootId = parsed.searchParams.get("q")!.match(/'([^']+)' in parents/)![1]!;
        const index = rootId.at(-1)!;
        return response({ files: [
          { id: `blobs-${index}`, name: "blobs", mimeType: "application/vnd.google-apps.folder", appProperties: { vaultRelayKind: "blobs", vaultId: `vault-${index}` } },
          { id: `operations-${index}`, name: "operations", mimeType: "application/vnd.google-apps.folder", appProperties: { vaultRelayKind: "operations", vaultId: `vault-${index}` } },
          { id: `descriptor-${index}`, name: "vault.json", mimeType: "application/json", appProperties: { vaultRelayKind: "descriptor", vaultId: `vault-${index}` } },
        ] });
      }
      if (parsed.searchParams.get("alt") === "media") {
        const index = parsed.pathname.match(/descriptor-(\d+)/)![1]!;
        return response({ protocolVersion: 1, vaultId: `vault-${index}`, name: `Vault ${index}` });
      }
      throw new Error(`Unexpected Drive request: ${url}`);
    });

    const auth = { token: async () => "token", invalidate: vi.fn() };
    const session = new GoogleDriveSession(auth, () => concurrency);

    const first = session.list();
    await vi.waitFor(() => expect(children.active).toBe(1));
    children.release();
    await first;
    expect(children.peak).toBe(1);

    concurrency = 2;
    children.reset();
    const second = session.list();
    await vi.waitFor(() => expect(children.active).toBe(2));
    children.release();
    await second;
    expect(children.peak).toBe(2);
  });

  it("uses the current concurrency setting when creating a remote vault", async () => {
    let concurrency = 1;
    const children = new ConcurrencyProbe();

    requestUrl.mockImplementation(async ({ url, body }: { url: string; body?: unknown }) => {
      const metadata = typeof body === "string" && body.startsWith("{") ? JSON.parse(body) as { name?: string } : {};
      if (metadata.name === "Vault Relay - Work") {
        return response({ id: "root", name: metadata.name, mimeType: "application/vnd.google-apps.folder" });
      }
      await children.hold();
      if (metadata.name === "blobs") return response({ id: "blobs", name: "blobs", mimeType: "application/vnd.google-apps.folder" });
      if (metadata.name === "operations") return response({ id: "operations", name: "operations", mimeType: "application/vnd.google-apps.folder" });
      if (url.includes("uploadType=multipart")) return response({ id: "descriptor", name: "vault.json", mimeType: "application/json" });
      throw new Error(`Unexpected Drive request: ${url}`);
    });

    const auth = { token: async () => "token", invalidate: vi.fn() };
    const session = new GoogleDriveSession(auth, () => concurrency);
    concurrency = 2;

    const creation = session.create("Work");
    await vi.waitFor(() => expect(children.active).toBe(2));
    children.release();

    await expect(creation).resolves.toMatchObject({
      name: "Work",
      layout: { rootId: "root", blobsId: "blobs", operationsId: "operations" },
    });
    expect(children.peak).toBe(2);
  });

  it("opens remote vaults on the session's live Drive client", async () => {
    let concurrency = 1;
    const downloads = new ConcurrencyProbe();
    const operationFiles = Array.from({ length: 3 }, (_, index) => ({
      id: `file-${index}`,
      name: `operation-${index}.json`,
      mimeType: "application/json",
      parents: ["operations"],
      appProperties: { vaultRelayKind: "operation", vaultId: "vault" },
    }));

    requestUrl.mockImplementation(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/changes/startPageToken")) return response({ startPageToken: "cursor" });
      if (parsed.searchParams.get("q")?.includes("'operations' in parents")) return response({ files: operationFiles });
      if (parsed.searchParams.get("alt") === "media") {
        await downloads.hold();
        const index = parsed.pathname.match(/file-(\d+)/)![1]!;
        return response({ id: `operation-${index}` });
      }
      throw new Error(`Unexpected Drive request: ${url}`);
    });

    const auth = { token: async () => "token", invalidate: vi.fn() };
    const session = new GoogleDriveSession(auth, () => concurrency);
    const remote = session.open({ vaultId: "vault", rootId: "root", blobsId: "blobs", operationsId: "operations" });
    concurrency = 2;

    const pull = remote.pullOperations(null);
    await vi.waitFor(() => expect(downloads.active).toBe(2));
    downloads.release();

    await expect(pull).resolves.toMatchObject({ cursor: "cursor" });
    expect(downloads.peak).toBe(2);
  });
});
