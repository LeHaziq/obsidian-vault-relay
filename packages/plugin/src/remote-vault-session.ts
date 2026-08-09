import { mapLimit, PROTOCOL_VERSION, type VaultDescriptor } from "@vault-relay/protocol";
import type { DriveLayout } from "./model";
import { DriveClient, type DriveAuth, GoogleDriveRemote } from "./google-drive";

const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface RemoteVaultSummary {
  name: string;
  layout: DriveLayout;
}

/** Owns the authenticated Drive client used to discover remote vaults. */
export class GoogleDriveSession {
  private readonly client: DriveClient;

  constructor(auth: DriveAuth, concurrency: () => number) {
    this.client = new DriveClient(auth, concurrency);
  }

  open(layout: DriveLayout): GoogleDriveRemote {
    return new GoogleDriveRemote(this.client, layout);
  }

  async create(name: string): Promise<RemoteVaultSummary> {
    const vaultId = crypto.randomUUID();
    const root = await this.client.createFolder(`Vault Relay - ${name}`, undefined, {
      vaultRelayKind: "vault-root",
      vaultId,
      vaultName: name.slice(0, 100),
      protocolVersion: String(PROTOCOL_VERSION),
    });
    const descriptor: VaultDescriptor = {
      protocolVersion: PROTOCOL_VERSION,
      vaultId,
      createdAt: new Date().toISOString(),
      name: name.slice(0, 100),
      encryption: null,
    };
    const tasks: Array<() => Promise<{ kind: "blobs" | "operations"; id: string } | { kind: "descriptor" }>> = [
      async () => ({ kind: "blobs", id: (await this.client.createFolder("blobs", root.id, { vaultRelayKind: "blobs", vaultId })).id }),
      async () => ({ kind: "operations", id: (await this.client.createFolder("operations", root.id, { vaultRelayKind: "operations", vaultId })).id }),
      async () => {
        await this.client.uploadFile(
          "vault.json",
          root.id,
          new TextEncoder().encode(JSON.stringify(descriptor, null, 2)).buffer as ArrayBuffer,
          "application/json",
          { vaultRelayKind: "descriptor", vaultId },
        );
        return { kind: "descriptor" };
      },
    ];
    const created = await mapLimit(tasks, this.client.concurrency, (task) => task());
    const blobs = created.find((entry): entry is { kind: "blobs"; id: string } => entry.kind === "blobs")!;
    const operations = created.find((entry): entry is { kind: "operations"; id: string } => entry.kind === "operations")!;
    return { name, layout: { vaultId, rootId: root.id, blobsId: blobs.id, operationsId: operations.id } };
  }

  async list(): Promise<RemoteVaultSummary[]> {
    const roots = await this.client.listAll(`trashed = false and mimeType = '${FOLDER_MIME}' and appProperties has { key='vaultRelayKind' and value='vault-root' }`);
    const summaries = await mapLimit(roots, this.client.concurrency, async (root): Promise<RemoteVaultSummary | null> => {
      const vaultId = root.appProperties?.vaultId;
      if (!vaultId) return null;
      const children = await this.client.listAll(`trashed = false and '${escapeQuery(root.id)}' in parents`);
      const blobFolders = children.filter((file) => file.mimeType === FOLDER_MIME && file.appProperties?.vaultRelayKind === "blobs" && file.appProperties.vaultId === vaultId);
      const operationFolders = children.filter((file) => file.mimeType === FOLDER_MIME && file.appProperties?.vaultRelayKind === "operations" && file.appProperties.vaultId === vaultId);
      const descriptors = children.filter((file) => file.appProperties?.vaultRelayKind === "descriptor" && file.appProperties.vaultId === vaultId);
      if (blobFolders.length !== 1 || operationFolders.length !== 1 || descriptors.length !== 1) return null;
      const descriptor = await this.client.downloadJson<VaultDescriptor>(descriptors[0]!.id);
      if (descriptor.protocolVersion !== PROTOCOL_VERSION || descriptor.vaultId !== vaultId || descriptor.name !== (root.appProperties?.vaultName ?? descriptor.name)) return null;
      return {
        name: root.appProperties?.vaultName ?? root.name.replace(/^Vault Relay - /, ""),
        layout: { vaultId, rootId: root.id, blobsId: blobFolders[0]!.id, operationsId: operationFolders[0]!.id },
      };
    });
    return summaries.filter((summary): summary is RemoteVaultSummary => summary !== null);
  }
}

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}
