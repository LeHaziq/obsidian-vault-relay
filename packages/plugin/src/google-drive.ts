import { PROTOCOL_VERSION, sha256, type RemoteVault, type SyncOperation, type VaultDescriptor } from "@vault-relay/protocol";
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import type { GoogleAuth } from "./auth";
import type { DriveLayout } from "./model";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  trashed?: boolean;
  parents?: string[];
  appProperties?: Record<string, string>;
}

interface DriveList {
  files?: DriveFile[];
  nextPageToken?: string;
}

export interface RemoteVaultSummary {
  name: string;
  layout: DriveLayout;
}

export class GoogleDriveRemote implements RemoteVault {
  constructor(
    private readonly auth: GoogleAuth,
    private readonly layout: DriveLayout,
    private readonly concurrency = 4,
  ) {}

  static async create(auth: GoogleAuth, name: string): Promise<RemoteVaultSummary> {
    const client = new DriveBootstrap(auth);
    const vaultId = crypto.randomUUID();
    const root = await client.createFolder(`Vault Relay - ${name}`, undefined, {
      vaultRelayKind: "vault-root",
      vaultId,
      vaultName: name.slice(0, 100),
      protocolVersion: String(PROTOCOL_VERSION),
    });
    const blobs = await client.createFolder("blobs", root.id, { vaultRelayKind: "blobs", vaultId });
    const operations = await client.createFolder("operations", root.id, { vaultRelayKind: "operations", vaultId });
    const descriptor: VaultDescriptor = {
      protocolVersion: PROTOCOL_VERSION,
      vaultId,
      createdAt: new Date().toISOString(),
      name: name.slice(0, 100),
      encryption: null,
    };
    const layout = { vaultId, rootId: root.id, blobsId: blobs.id, operationsId: operations.id };
    await new GoogleDriveRemote(auth, layout).uploadFile(
      "vault.json",
      root.id,
      new TextEncoder().encode(JSON.stringify(descriptor, null, 2)).buffer,
      "application/json",
      { vaultRelayKind: "descriptor", vaultId },
    );
    return { name, layout };
  }

  static async list(auth: GoogleAuth): Promise<RemoteVaultSummary[]> {
    const client = new DriveBootstrap(auth);
    const roots = await client.listAll(`trashed = false and mimeType = '${FOLDER_MIME}' and appProperties has { key='vaultRelayKind' and value='vault-root' }`);
    const summaries: RemoteVaultSummary[] = [];
    for (const root of roots) {
      const vaultId = root.appProperties?.vaultId;
      if (!vaultId) continue;
      const children = await client.listAll(`trashed = false and '${escapeQuery(root.id)}' in parents`);
      const blobFolders = children.filter((file) => file.mimeType === FOLDER_MIME && file.appProperties?.vaultRelayKind === "blobs" && file.appProperties.vaultId === vaultId);
      const operationFolders = children.filter((file) => file.mimeType === FOLDER_MIME && file.appProperties?.vaultRelayKind === "operations" && file.appProperties.vaultId === vaultId);
      const descriptors = children.filter((file) => file.appProperties?.vaultRelayKind === "descriptor" && file.appProperties.vaultId === vaultId);
      if (blobFolders.length !== 1 || operationFolders.length !== 1 || descriptors.length !== 1) continue;
      const descriptor = await client.downloadJson<VaultDescriptor>(descriptors[0]!.id);
      if (descriptor.protocolVersion !== PROTOCOL_VERSION || descriptor.vaultId !== vaultId || descriptor.name !== (root.appProperties?.vaultName ?? descriptor.name)) continue;
      const blobs = blobFolders[0]!;
      const operations = operationFolders[0]!;
      summaries.push({
        name: root.appProperties?.vaultName ?? root.name.replace(/^Vault Relay - /, ""),
        layout: { vaultId, rootId: root.id, blobsId: blobs.id, operationsId: operations.id },
      });
    }
    return summaries;
  }

  async pullOperations(cursor: string | null): Promise<{ operations: SyncOperation[]; cursor: string }> {
    if (!cursor) {
      const client = new DriveBootstrap(this.auth);
      // Capture the token first so creations racing the full listing are replayed next time.
      const token = await this.requestJson<{ startPageToken: string }>(`${API}/changes/startPageToken`);
      const files = await client.listAll(`trashed = false and '${escapeQuery(this.layout.operationsId)}' in parents`);
      const operations = await mapLimit(files.filter(isOperation), this.concurrency, (file) => this.downloadOperation(file));
      return { operations, cursor: token.startPageToken };
    }

    try {
      let pageToken: string | undefined = cursor;
      let finalToken = cursor;
      const changedFiles = new Map<string, DriveFile>();
      while (pageToken) {
        const url = new URL(`${API}/changes`);
        url.searchParams.set("pageToken", pageToken);
        url.searchParams.set("spaces", "drive");
        url.searchParams.set("includeRemoved", "true");
        url.searchParams.set("fields", "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,trashed,parents,appProperties))");
        const page = await this.requestJson<{
          changes?: Array<{ fileId: string; removed?: boolean; file?: DriveFile }>;
          nextPageToken?: string;
          newStartPageToken?: string;
        }>(url.toString());
        for (const change of page.changes ?? []) {
          if (!change.removed && change.file && isOperation(change.file) && change.file.parents?.includes(this.layout.operationsId)) changedFiles.set(change.fileId, change.file);
        }
        if (page.newStartPageToken) finalToken = page.newStartPageToken;
        pageToken = page.nextPageToken;
      }
      return { operations: await mapLimit([...changedFiles.values()], this.concurrency, (file) => this.downloadOperation(file)), cursor: finalToken };
    } catch (error) {
      if (error instanceof DriveError && error.status === 410) return this.pullOperations(null);
      throw error;
    }
  }

  async hasBlob(hash: string): Promise<boolean> {
    return Boolean(await this.getVerifiedBlob(hash));
  }

  async putBlob(hash: string, content: ArrayBuffer, mimeType: string): Promise<void> {
    if (await this.hasBlob(hash)) return;
    await this.uploadFile(hash, this.layout.blobsId, content, mimeType, {
      vaultRelayKind: "blob",
      vaultId: this.layout.vaultId,
      blobHash: hash,
    });
  }

  async getBlob(hash: string): Promise<ArrayBuffer> {
    const verified = await this.getVerifiedBlob(hash);
    if (!verified) throw new Error(`Remote content is missing or corrupt: ${hash}`);
    return verified.content;
  }

  async putOperation(operation: SyncOperation): Promise<void> {
    const query = `trashed = false and '${escapeQuery(this.layout.operationsId)}' in parents and name = '${escapeQuery(`${operation.id}.json`)}'`;
    const existing = await this.listFiles(query);
    if (existing.length > 0) {
      const current = await mapLimit(existing, this.concurrency, (file) => this.downloadOperation(file));
      if (current.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(operation))) throw new Error(`Remote operation ID was reused: ${operation.id}`);
      for (const duplicate of existing.sort((left, right) => left.id.localeCompare(right.id)).slice(1)) {
        await this.authorizedRequest({ url: `${API}/files/${encodeURIComponent(duplicate.id)}`, method: "DELETE" });
      }
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(operation));
    await this.uploadFile(`${operation.id}.json`, this.layout.operationsId, bytes.buffer, "application/json", {
      vaultRelayKind: "operation",
      vaultId: this.layout.vaultId,
      deviceId: operation.deviceId.slice(0, 100),
    });
  }

  async ensureOperations(operations: SyncOperation[]): Promise<void> {
    const client = new DriveBootstrap(this.auth);
    const files = await client.listAll(`trashed = false and '${escapeQuery(this.layout.operationsId)}' in parents`);
    const names = new Set(files.filter(isOperation).map((file) => file.name));
    const missing = operations.filter((operation) => !names.has(`${operation.id}.json`));
    await mapLimit(missing, this.concurrency, (operation) => this.putOperation(operation));
  }

  private async getVerifiedBlob(hash: string): Promise<{ file: DriveFile; content: ArrayBuffer } | null> {
    const query = `trashed = false and '${escapeQuery(this.layout.blobsId)}' in parents and name = '${escapeQuery(hash)}' and appProperties has { key='blobHash' and value='${escapeQuery(hash)}' }`;
    const files = await this.listFiles(query);
    const candidates = await mapLimit(files, this.concurrency, async (file) => {
      if (file.appProperties?.vaultRelayKind !== "blob" || file.appProperties.vaultId !== this.layout.vaultId) return null;
      const response = await this.authorizedRequest({ url: `${API}/files/${encodeURIComponent(file.id)}?alt=media`, method: "GET" });
      return await sha256(response.arrayBuffer) === hash ? { file, content: response.arrayBuffer } : null;
    });
    const valid = candidates.filter((candidate): candidate is { file: DriveFile; content: ArrayBuffer } => candidate !== null)
      .sort((left, right) => left.file.id.localeCompare(right.file.id));
    const keep = valid[0] ?? null;
    for (const file of files) {
      if (file.id !== keep?.file.id) await this.authorizedRequest({ url: `${API}/files/${encodeURIComponent(file.id)}`, method: "DELETE" });
    }
    return keep;
  }

  private async downloadOperation(file: DriveFile): Promise<SyncOperation> {
    if (file.appProperties?.vaultId !== this.layout.vaultId || !file.parents?.includes(this.layout.operationsId)) {
      throw new Error(`Remote operation belongs to a different vault: ${file.id}`);
    }
    const operation = await this.requestJson<SyncOperation>(`${API}/files/${encodeURIComponent(file.id)}?alt=media`);
    if (file.name !== `${operation.id}.json`) throw new Error(`Remote operation filename does not match its content: ${file.name}`);
    return operation;
  }

  private async listFiles(query: string): Promise<DriveFile[]> {
    const url = new URL(`${API}/files`);
    url.searchParams.set("q", query);
    url.searchParams.set("spaces", "drive");
    url.searchParams.set("fields", "files(id,name,mimeType,trashed,parents,appProperties)");
    return (await this.requestJson<DriveList>(url.toString())).files ?? [];
  }

  async uploadFile(name: string, parentId: string, content: ArrayBuffer, mimeType: string, appProperties: Record<string, string>): Promise<DriveFile> {
    const metadata = { name, parents: [parentId], appProperties };
    if (content.byteLength <= RESUMABLE_THRESHOLD) {
      const boundary = `vault-relay-${crypto.randomUUID()}`;
      const body = multipartBody(boundary, metadata, content, mimeType);
      return this.requestJson<DriveFile>(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,parents,appProperties`, {
        method: "POST",
        contentType: `multipart/related; boundary=${boundary}`,
        body,
      });
    }

    const start = await this.authorizedRequest({
      url: `${UPLOAD_API}/files?uploadType=resumable&fields=id,name,mimeType,parents,appProperties`,
      method: "POST",
      contentType: "application/json",
      headers: {
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(content.byteLength),
      },
      body: JSON.stringify(metadata),
    });
    const location = header(start.headers, "location");
    if (!location) throw new Error("Google Drive did not provide a resumable upload URL");
    let offset = 0;
    let stalledResponses = 0;
    while (offset < content.byteLength) {
      const remaining = content.slice(offset);
      const complete = await this.authorizedRequest({
        url: location,
        method: "PUT",
        contentType: mimeType,
        headers: {
          "Content-Length": String(remaining.byteLength),
          "Content-Range": `bytes ${offset}-${content.byteLength - 1}/${content.byteLength}`,
        },
        body: remaining,
      }, [308]);
      if (complete.status !== 308) return complete.json as DriveFile;
      const received = header(complete.headers, "range")?.match(/bytes=0-(\d+)/)?.[1];
      const nextOffset = received ? Number(received) + 1 : offset;
      stalledResponses = nextOffset === offset ? stalledResponses + 1 : 0;
      if (stalledResponses >= 3) throw new Error("Google Drive resumable upload made no progress");
      offset = nextOffset;
    }
    throw new Error("Google Drive resumable upload ended without file metadata");
  }

  private async requestJson<T>(url: string, options: Partial<RequestUrlParam> = {}): Promise<T> {
    const response = await this.authorizedRequest({ url, method: "GET", ...options });
    return response.json as T;
  }

  private async authorizedRequest(params: RequestUrlParam, acceptedStatuses: number[] = []): Promise<RequestUrlResponse> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = await this.auth.token();
      const response = await requestUrl({
        ...params,
        headers: { ...params.headers, Authorization: `Bearer ${token}` },
        throw: false,
      });
      if ((response.status >= 200 && response.status < 300) || acceptedStatuses.includes(response.status)) return response;
      if (response.status === 401 && attempt === 0) {
        this.auth.invalidate();
        continue;
      }
      if (![403, 429, 500, 502, 503, 504].includes(response.status) || attempt === 4) {
        throw new DriveError(response.status, driveMessage(response));
      }
      if ((params.method ?? "GET") === "POST") throw new DriveError(response.status, driveMessage(response));
      await sleep(Math.min(30_000, 500 * 2 ** attempt + Math.random() * 500));
    }
    throw new Error("Google Drive request failed");
  }
}

class DriveBootstrap {
  constructor(private readonly auth: GoogleAuth) {}

  async createFolder(name: string, parentId?: string, appProperties: Record<string, string> = {}): Promise<DriveFile> {
    return this.json<DriveFile>(`${API}/files?fields=id,name,mimeType,parents,appProperties`, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}), appProperties }),
    });
  }

  async listAll(query: string): Promise<DriveFile[]> {
    const result: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${API}/files`);
      url.searchParams.set("q", query);
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,trashed,parents,appProperties)");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.json<DriveList>(url.toString());
      result.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return result;
  }

  async downloadJson<T>(id: string): Promise<T> {
    return this.json<T>(`${API}/files/${encodeURIComponent(id)}?alt=media`);
  }

  private async json<T>(url: string, options: Partial<RequestUrlParam> = {}): Promise<T> {
    const response = await requestUrl({
      url,
      method: "GET",
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${await this.auth.token()}` },
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) throw new DriveError(response.status, driveMessage(response));
    return response.json as T;
  }
}

export class DriveError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "DriveError";
  }
}

function isOperation(file: DriveFile): boolean {
  return !file.trashed && file.appProperties?.vaultRelayKind === "operation";
}

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function driveMessage(response: RequestUrlResponse): string {
  const body = response.json as { error?: { message?: string; errors?: Array<{ reason?: string }> } } | undefined;
  const reason = body?.error?.errors?.[0]?.reason;
  return `${body?.error?.message ?? `Google Drive returned HTTP ${response.status}`}${reason ? ` (${reason})` : ""}`;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase());
  return key ? headers[key] : undefined;
}

function multipartBody(boundary: string, metadata: unknown, content: ArrayBuffer, mimeType: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const suffix = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(prefix.byteLength + content.byteLength + suffix.byteLength);
  body.set(prefix, 0);
  body.set(new Uint8Array(content), prefix.byteLength);
  body.set(suffix, prefix.byteLength + content.byteLength);
  return body.buffer;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
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
