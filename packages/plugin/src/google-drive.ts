import { mapLimit, sha256, type RemoteVault, type SyncOperation } from "@vault-relay/protocol";
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import type { DriveLayout } from "./model";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;
/** Resumable chunk size. Google requires a multiple of 256 KiB. */
const RESUMABLE_CHUNK = 8 * 1024 * 1024;
const FILE_FIELDS = "id,name,mimeType,trashed,parents,appProperties";
const MAX_ATTEMPTS = 5;
/** 403 is only worth retrying when Drive attaches a throttling reason. */
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded", "dailyLimitExceeded"]);

export interface DriveFile {
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

export class DriveError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "DriveError";
  }
}

export interface DriveAuth {
  token(): Promise<string>;
  invalidate(): void;
}

/**
 * The single authenticated Drive transport. Everything goes through `request`
 * so retry, backoff, and token refresh apply uniformly; an earlier split
 * between a retrying client and a bare bootstrap client meant the highest
 * latency calls (listing, vault creation) had no resilience at all.
 */
export class DriveClient {
  constructor(private readonly auth: DriveAuth, private readonly currentConcurrency: () => number = () => 4) {}

  get concurrency(): number { return this.currentConcurrency(); }

  async request(params: RequestUrlParam, acceptedStatuses: number[] = []): Promise<RequestUrlResponse> {
    const method = (params.method ?? "GET").toUpperCase();
    let invalidated = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const token = await this.auth.token();
      const response = await requestUrl({
        ...params,
        headers: { ...params.headers, Authorization: `Bearer ${token}` },
        throw: false,
      });
      if ((response.status >= 200 && response.status < 300) || acceptedStatuses.includes(response.status)) return response;
      if (response.status === 401 && !invalidated) {
        invalidated = true;
        this.auth.invalidate();
        continue;
      }
      if (attempt === MAX_ATTEMPTS - 1 || !retryable(response, method)) {
        throw new DriveError(response.status, driveMessage(response));
      }
      await sleep(Math.min(30_000, 500 * 2 ** attempt + Math.random() * 500));
    }
    throw new DriveError(0, "Google Drive request failed after retries");
  }

  async json<T>(url: string, options: Partial<RequestUrlParam> = {}): Promise<T> {
    return (await this.request({ url, method: "GET", ...options })).json as T;
  }

  /** Single page of results; use `listAll` when the result may be paginated. */
  async listFiles(query: string): Promise<DriveFile[]> {
    const url = new URL(`${API}/files`);
    url.searchParams.set("q", query);
    url.searchParams.set("spaces", "drive");
    url.searchParams.set("fields", `files(${FILE_FIELDS})`);
    return (await this.json<DriveList>(url.toString())).files ?? [];
  }

  async listAll(query: string): Promise<DriveFile[]> {
    const result: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${API}/files`);
      url.searchParams.set("q", query);
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.json<DriveList>(url.toString());
      result.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return result;
  }

  async download(id: string): Promise<ArrayBuffer> {
    return (await this.request({ url: `${API}/files/${encodeURIComponent(id)}?alt=media`, method: "GET" })).arrayBuffer;
  }

  async downloadJson<T>(id: string): Promise<T> {
    return this.json<T>(`${API}/files/${encodeURIComponent(id)}?alt=media`);
  }

  async deleteFile(id: string): Promise<void> {
    await this.request({ url: `${API}/files/${encodeURIComponent(id)}`, method: "DELETE" });
  }

  async createFolder(name: string, parentId?: string, appProperties: Record<string, string> = {}): Promise<DriveFile> {
    return this.json<DriveFile>(`${API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}), appProperties }),
    });
  }

  async uploadFile(name: string, parentId: string, content: ArrayBuffer, mimeType: string, appProperties: Record<string, string>): Promise<DriveFile> {
    const metadata = { name, parents: [parentId], appProperties };
    const fields = encodeURIComponent(FILE_FIELDS);
    if (content.byteLength <= RESUMABLE_THRESHOLD) {
      const boundary = `vault-relay-${crypto.randomUUID()}`;
      return this.json<DriveFile>(`${UPLOAD_API}/files?uploadType=multipart&fields=${fields}`, {
        method: "POST",
        contentType: `multipart/related; boundary=${boundary}`,
        body: multipartBody(boundary, metadata, content, mimeType),
      });
    }

    const start = await this.request({
      url: `${UPLOAD_API}/files?uploadType=resumable&fields=${fields}`,
      method: "POST",
      contentType: "application/json",
      headers: { "X-Upload-Content-Type": mimeType, "X-Upload-Content-Length": String(content.byteLength) },
      body: JSON.stringify(metadata),
    });
    const location = header(start.headers, "location");
    if (!location) throw new Error("Google Drive did not provide a resumable upload URL");

    const total = content.byteLength;
    let offset = 0;
    let stalled = 0;
    while (offset < total) {
      // Send bounded chunks so a large attachment is not re-copied in full on
      // every iteration of the loop.
      const end = Math.min(offset + RESUMABLE_CHUNK, total);
      const chunk = content.slice(offset, end);
      const response = await this.request({
        url: location,
        method: "PUT",
        contentType: mimeType,
        headers: { "Content-Length": String(chunk.byteLength), "Content-Range": `bytes ${offset}-${end - 1}/${total}` },
        body: chunk,
      }, [308]);
      if (response.status !== 308) return response.json as DriveFile;
      const received = header(response.headers, "range")?.match(/bytes=0-(\d+)/)?.[1];
      const nextOffset = received ? Number(received) + 1 : end;
      stalled = nextOffset <= offset ? stalled + 1 : 0;
      if (stalled >= 3) throw new Error("Google Drive resumable upload made no progress");
      offset = Math.max(offset, nextOffset);
    }
    throw new Error("Google Drive resumable upload ended without file metadata");
  }
}

export class GoogleDriveRemote implements RemoteVault {
  constructor(private readonly client: DriveClient, private readonly layout: DriveLayout) {}

  async pullOperations(cursor: string | null): Promise<{ operations: SyncOperation[]; cursor: string }> {
    if (!cursor) {
      // Capture the token first so creations racing the full listing are replayed next time.
      const token = await this.client.json<{ startPageToken: string }>(`${API}/changes/startPageToken`);
      const files = await this.client.listAll(`trashed = false and '${escapeQuery(this.layout.operationsId)}' in parents`);
      const operations = await mapLimit(files.filter(isOperation), this.client.concurrency, (file) => this.downloadOperation(file));
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
        url.searchParams.set("fields", `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`);
        const page = await this.client.json<{
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
      return { operations: await mapLimit([...changedFiles.values()], this.client.concurrency, (file) => this.downloadOperation(file)), cursor: finalToken };
    } catch (error) {
      if (error instanceof DriveError && error.status === 410) return this.pullOperations(null);
      throw error;
    }
  }

  /**
   * Metadata-only. Blobs are content-addressed and the name is the SHA-256, so
   * presence does not require transferring the body. Downloading here meant
   * skipping a 100 MB upload cost 100 MB of download first.
   */
  async hasBlob(hash: string): Promise<boolean> {
    return (await this.blobCandidates(hash)).length > 0;
  }

  async putBlob(hash: string, content: ArrayBuffer, mimeType: string): Promise<void> {
    // The engine checks hasBlob before calling this, so no second probe here.
    await this.client.uploadFile(hash, this.layout.blobsId, content, mimeType, {
      vaultRelayKind: "blob",
      vaultId: this.layout.vaultId,
      blobHash: hash,
    });
  }

  async getBlob(hash: string): Promise<ArrayBuffer> {
    const candidates = (await this.blobCandidates(hash)).sort((left, right) => left.id.localeCompare(right.id));
    for (const file of candidates) {
      const content = await this.client.download(file.id);
      if (await sha256(content) === hash) return content;
      // Content-addressed storage means a mismatch is definitively corrupt.
      await this.client.deleteFile(file.id);
    }
    throw new Error(`Remote content is missing or corrupt: ${hash}`);
  }

  async putOperation(operation: SyncOperation): Promise<void> {
    const query = `trashed = false and '${escapeQuery(this.layout.operationsId)}' in parents and name = '${escapeQuery(`${operation.id}.json`)}'`;
    const existing = await this.client.listFiles(query);
    if (existing.length > 0) {
      const current = await mapLimit(existing, this.client.concurrency, (file) => this.downloadOperation(file));
      if (current.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(operation))) throw new Error(`Remote operation ID was reused: ${operation.id}`);
      for (const duplicate of existing.sort((left, right) => left.id.localeCompare(right.id)).slice(1)) {
        await this.client.deleteFile(duplicate.id);
      }
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(operation));
    await this.client.uploadFile(`${operation.id}.json`, this.layout.operationsId, bytes.buffer as ArrayBuffer, "application/json", {
      vaultRelayKind: "operation",
      vaultId: this.layout.vaultId,
      deviceId: operation.deviceId.slice(0, 100),
    });
  }

  async ensureOperations(operations: SyncOperation[]): Promise<void> {
    if (operations.length === 0) return;
    const files = await this.client.listAll(`trashed = false and '${escapeQuery(this.layout.operationsId)}' in parents`);
    const names = new Set(files.filter(isOperation).map((file) => file.name));
    const missing = operations.filter((operation) => !names.has(`${operation.id}.json`));
    await mapLimit(missing, this.client.concurrency, (operation) => this.putOperation(operation));
  }

  private async blobCandidates(hash: string): Promise<DriveFile[]> {
    const query = `trashed = false and '${escapeQuery(this.layout.blobsId)}' in parents and name = '${escapeQuery(hash)}' and appProperties has { key='blobHash' and value='${escapeQuery(hash)}' }`;
    const files = await this.client.listFiles(query);
    return files.filter((file) => file.appProperties?.vaultRelayKind === "blob" && file.appProperties.vaultId === this.layout.vaultId);
  }

  private async downloadOperation(file: DriveFile): Promise<SyncOperation> {
    if (file.appProperties?.vaultId !== this.layout.vaultId || !file.parents?.includes(this.layout.operationsId)) {
      throw new Error(`Remote operation belongs to a different vault: ${file.id}`);
    }
    const operation = await this.client.downloadJson<SyncOperation>(file.id);
    if (file.name !== `${operation.id}.json`) throw new Error(`Remote operation filename does not match its content: ${file.name}`);
    return operation;
  }
}

function isOperation(file: DriveFile): boolean {
  return !file.trashed && file.appProperties?.vaultRelayKind === "operation";
}

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function retryable(response: Pick<RequestUrlResponse, "status" | "json">, method: string): boolean {
  if (response.status === 429) return true;
  if (response.status === 403) return isRateLimited(response);
  if (![500, 502, 503, 504].includes(response.status)) return false;
  // A POST that reached Drive may already have created the resource, so only
  // replay the status that means the request was shed rather than processed.
  // Blobs are content-addressed and operations are name-checked, so a rare
  // duplicate is reconciled rather than corrupting the store.
  return method !== "POST" || response.status === 503;
}

function isRateLimited(response: Pick<RequestUrlResponse, "json">): boolean {
  const body = response.json as { error?: { errors?: Array<{ reason?: string }> } } | undefined;
  return (body?.error?.errors ?? []).some((entry) => entry.reason !== undefined && RATE_LIMIT_REASONS.has(entry.reason));
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
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
