import { requestUrl, type App } from "obsidian";
import { sha256 } from "@vault-relay/protocol";
import { buildAuthorizationUrl } from "./oauth-url";
import { normalizeRelayOrigin, safeRelayOrigin } from "./relay-url";

const SECRET_ID = "vault-relay-google-refresh-token";
const PENDING_SECRET_ID = "vault-relay-google-oauth-pending";

interface StoredCredential {
  refreshToken: string;
  relayOrigin: string;
}

interface PendingAuthorization {
  verifier: string;
  state: string;
  relayOrigin: string;
  expiresAt: number;
}

function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function toBase64Url(hex: string): string {
  const bytes = new Uint8Array(hex.match(/.{2}/g)?.map((value) => Number.parseInt(value, 16)) ?? []);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export class GoogleAuth {
  private accessToken: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(private readonly app: App, private readonly relayUrl: () => string) {}

  async prepareAuthorization(): Promise<string> {
    const verifier = randomVerifier();
    const state = crypto.randomUUID();
    const relayOrigin = normalizeRelayOrigin(this.relayUrl());
    const health = await requestUrl({
      url: new URL("/health", relayOrigin).toString(),
      method: "GET",
      throw: false,
    });
    if (health.status !== 200) throw new Error(`OAuth relay health check failed with HTTP ${health.status}`);
    const pending: PendingAuthorization = { verifier, state, relayOrigin, expiresAt: Date.now() + 10 * 60_000 };
    this.app.secretStorage.setSecret(PENDING_SECRET_ID, JSON.stringify(pending));
    const challenge = toBase64Url(await sha256(verifier));
    return buildAuthorizationUrl(relayOrigin, challenge, state);
  }

  async complete(ticket: string, state: string): Promise<void> {
    const pending = parseJson<PendingAuthorization>(this.app.secretStorage.getSecret(PENDING_SECRET_ID));
    if (!pending || pending.expiresAt < Date.now() || pending.relayOrigin !== normalizeRelayOrigin(this.relayUrl()) || pending.state !== state) {
      throw new Error("OAuth state did not match this sign-in attempt or the attempt expired");
    }
    const response = await requestUrl({
      url: new URL("/oauth/claim", pending.relayOrigin).toString(),
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ ticket, verifier: pending.verifier }),
      throw: false,
    });
    if (response.status !== 200) throw new Error(response.json?.error ?? "Unable to claim Google authorization");
    const credential: StoredCredential = { refreshToken: response.json.refresh_token as string, relayOrigin: pending.relayOrigin };
    this.app.secretStorage.setSecret(SECRET_ID, JSON.stringify(credential));
    this.app.secretStorage.setSecret(PENDING_SECRET_ID, "");
    this.accessToken = null;
  }

  async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = this.refresh().finally(() => { this.tokenRequest = null; });
    return this.tokenRequest;
  }

  private async refresh(): Promise<string> {
    const credential = parseJson<StoredCredential>(this.app.secretStorage.getSecret(SECRET_ID));
    const relayOrigin = normalizeRelayOrigin(this.relayUrl());
    if (!credential?.refreshToken) throw new Error("Connect a Google account first");
    if (credential.relayOrigin !== relayOrigin) throw new Error("The OAuth relay changed; reconnect Google Drive before syncing");
    const response = await requestUrl({
      url: new URL("/oauth/refresh", relayOrigin).toString(),
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ refresh_token: credential.refreshToken }),
      throw: false,
    });
    if (response.status !== 200) {
      if (response.status === 401) this.app.secretStorage.setSecret(SECRET_ID, "");
      throw new Error(response.json?.error ?? "Google authorization expired");
    }
    this.accessToken = {
      value: response.json.access_token as string,
      expiresAt: Date.now() + Number(response.json.expires_in ?? 3600) * 1000,
    };
    return this.accessToken.value;
  }

  invalidate(): void {
    this.accessToken = null;
  }

  async disconnect(): Promise<void> {
    this.app.secretStorage.setSecret(SECRET_ID, "");
    this.app.secretStorage.setSecret(PENDING_SECRET_ID, "");
    this.accessToken = null;
  }

  isConnected(): boolean {
    const credential = parseJson<StoredCredential>(this.app.secretStorage.getSecret(SECRET_ID));
    return Boolean(credential?.refreshToken && credential.relayOrigin === safeRelayOrigin(this.relayUrl()));
  }
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}
