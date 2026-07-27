import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";
import type { GrantStore } from "./store.js";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 120;
/** Hard ceiling on tracked rate-limit buckets, to bound memory under a flood. */
const RATE_LIMIT_MAX_ENTRIES = 20_000;

export class RelayApp {
  private readonly rates = new Map<string, { count: number; resetAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly store: GrantStore,
    private readonly tokenFetch: typeof fetch = fetch,
  ) {
    // Sweeping on a timer keeps the O(n) scan off the request path, where it
    // previously ran on every request once the map exceeded its threshold.
    this.sweeper = setInterval(() => this.sweepRates(), RATE_LIMIT_WINDOW_MS);
    this.sweeper.unref();
  }

  dispose(): void {
    clearInterval(this.sweeper);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(request.url ?? "/", this.config.publicUrl);
    try {
      this.rateLimit(request, url.pathname);
      if (request.method === "GET" && url.pathname === "/health") return this.json(response, 200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/oauth/start") return this.start(url, response);
      // These must be awaited inside the try block. `return somePromise` in an
      // async function settles the outer promise without routing rejections
      // through this catch, so every async route's error path escaped it.
      if (request.method === "GET" && url.pathname === "/oauth/callback") return await this.callback(url, response);
      if (request.method === "POST" && url.pathname === "/oauth/claim") return await this.claim(request, response);
      if (request.method === "POST" && url.pathname === "/oauth/refresh") return await this.refresh(request, response);
      this.json(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) {
        // Without this the cause of every 500 was discarded, leaving operators
        // with a generic body and no server-side record.
        console.error(JSON.stringify({ message: "Request failed", path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      }
      if (response.headersSent) response.destroy();
      else this.json(response, status, { error: status === 500 ? "Internal server error" : error instanceof Error ? error.message : String(error) });
    } finally {
      console.info(JSON.stringify({ method: request.method, path: url.pathname, status: response.statusCode, duration_ms: Date.now() - started }));
    }
  }

  private start(url: URL, response: ServerResponse): void {
    const challenge = url.searchParams.get("challenge") ?? "";
    const userState = url.searchParams.get("state") ?? "";
    const returnTo = url.searchParams.get("return_to") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new HttpError(400, "Invalid verifier challenge");
    if (!/^[0-9a-f-]{36}$/i.test(userState)) throw new HttpError(400, "Invalid state");
    if (returnTo !== "obsidian://vault-relay-auth") throw new HttpError(400, "Invalid return URL");
    const nonce = this.store.createAuthRequest(challenge, userState, returnTo);
    const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    google.searchParams.set("client_id", this.config.googleClientId);
    google.searchParams.set("redirect_uri", `${this.config.publicUrl}/oauth/callback`);
    google.searchParams.set("response_type", "code");
    google.searchParams.set("scope", DRIVE_SCOPE);
    google.searchParams.set("access_type", "offline");
    google.searchParams.set("prompt", "consent");
    google.searchParams.set("state", nonce);
    response.writeHead(302, { Location: google.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    response.end();
  }

  private async callback(url: URL, response: ServerResponse): Promise<void> {
    const nonce = url.searchParams.get("state") ?? "";
    const request = this.store.consumeAuthRequest(nonce);
    if (!request) throw new HttpError(400, "Authorization request expired or was already used");
    const oauthError = url.searchParams.get("error");
    if (oauthError) throw new HttpError(400, `Google authorization failed: ${sanitizeOAuthError(oauthError)}`);
    const code = url.searchParams.get("code");
    if (!code) throw new HttpError(400, "Google did not return an authorization code");
    const token = await this.googleToken({
      code,
      client_id: this.config.googleClientId,
      client_secret: this.config.googleClientSecret,
      redirect_uri: `${this.config.publicUrl}/oauth/callback`,
      grant_type: "authorization_code",
    });
    if (!token.refresh_token) throw new HttpError(502, "Google did not return a refresh token; revoke access and try again");
    const ticket = this.store.createGrant(request.challenge, token.refresh_token);
    const destination = new URL(request.return_to);
    destination.searchParams.set("ticket", ticket);
    destination.searchParams.set("state", request.user_state);
    response.writeHead(302, { Location: destination.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    response.end();
  }

  private async claim(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request) as { ticket?: string; verifier?: string };
    if (typeof body?.ticket !== "string" || typeof body?.verifier !== "string" || !body.ticket || !body.verifier
      || body.ticket.length > 512 || body.verifier.length > 512) {
      throw new HttpError(400, "Ticket and verifier are required");
    }
    const refreshToken = this.store.claim(body.ticket, body.verifier);
    if (!refreshToken) throw new HttpError(401, "Grant expired, was already used, or verifier did not match");
    this.json(response, 200, { refresh_token: refreshToken });
  }

  private async refresh(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request) as { refresh_token?: string };
    if (typeof body?.refresh_token !== "string" || !body.refresh_token || body.refresh_token.length > 4096) {
      throw new HttpError(400, "Refresh token is required");
    }
    try {
      const token = await this.googleToken({
        refresh_token: body.refresh_token,
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        grant_type: "refresh_token",
      });
      this.json(response, 200, { access_token: token.access_token, expires_in: token.expires_in, token_type: token.token_type });
    } catch (error) {
      if (error instanceof GoogleTokenError && error.oauthCode === "invalid_grant") throw new HttpError(401, "Google authorization was revoked or expired");
      throw error;
    }
  }

  private async googleToken(values: Record<string, string>): Promise<{ access_token: string; expires_in: number; token_type: string; refresh_token?: string }> {
    const result = await this.tokenFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await result.json().catch(() => ({})) as { access_token?: string; expires_in?: number; token_type?: string; refresh_token?: string; error?: string };
    if (!result.ok || !body.access_token) throw new GoogleTokenError(sanitizeOAuthError(body.error) || `HTTP ${result.status}`);
    return {
      access_token: body.access_token,
      expires_in: body.expires_in ?? 3600,
      token_type: body.token_type ?? "Bearer",
      ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    };
  }

  private rateLimit(request: IncomingMessage, path: string): void {
    const key = `${this.clientAddress(request)}:${path}`;
    const now = Date.now();
    const current = this.rates.get(key);
    if (!current || current.resetAt < now) {
      if (this.rates.size >= RATE_LIMIT_MAX_ENTRIES) this.sweepRates(now);
      this.rates.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return;
    }
    current.count += 1;
    if (current.count > RATE_LIMIT_REQUESTS) throw new HttpError(429, "Too many requests");
  }

  private clientAddress(request: IncomingMessage): string {
    const forwarded = this.config.trustProxy ? request.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() : undefined;
    const raw = forwarded && forwarded.length > 0 && forwarded.length <= 64 ? forwarded : request.socket.remoteAddress ?? "unknown";
    return normalizeAddress(raw);
  }

  private sweepRates(now = Date.now()): void {
    for (const [key, rate] of this.rates) {
      if (rate.resetAt < now) this.rates.delete(key);
    }
    if (this.rates.size <= RATE_LIMIT_MAX_ENTRIES) return;
    // Still over budget with every bucket live: drop the ones expiring soonest.
    const ordered = [...this.rates.entries()].sort((left, right) => left[1].resetAt - right[1].resetAt);
    for (const [key] of ordered.slice(0, this.rates.size - RATE_LIMIT_MAX_ENTRIES)) this.rates.delete(key);
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    response.end(JSON.stringify(body));
  }
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

class GoogleTokenError extends Error {
  constructor(public readonly oauthCode: string) { super(`Google token request failed: ${oauthCode}`); }
}

/** OAuth error codes are echoed back to clients, so keep them to a safe token. */
function sanitizeOAuthError(value: string | undefined): string {
  if (!value) return "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "invalid_response";
}

/**
 * Collapses an IPv6 address to its /64 prefix so a single allocation cannot
 * mint unlimited rate-limit buckets. IPv4 addresses pass through unchanged.
 */
export function normalizeAddress(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const address = (unbracketed.split("%")[0] ?? "").toLowerCase();
  const mapped = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (!mapped.includes(":")) return mapped || "unknown";
  let groups: string[];
  if (mapped.includes("::")) {
    const [head = "", tail = ""] = mapped.split("::");
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tail ? tail.split(":") : [];
    const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
    groups = [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  } else {
    groups = mapped.split(":");
  }
  return `${groups.slice(0, 4).map((group) => (group.replace(/^0+/, "") || "0")).join(":")}::/64`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > 16 * 1024) throw new HttpError(413, "Request body is too large");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}
