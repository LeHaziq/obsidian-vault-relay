import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAddress } from "./app.js";
import type { Config } from "./config.js";
import { clientChallenge } from "./pkce.test-helper.js";
import { createRelay } from "./relay.js";
import type { GrantStore } from "./store.js";

const KEY = "test-encryption-key-of-sufficient-length";
const RETURN_TO = "obsidian://vault-relay-auth";
const VERIFIER = "v".repeat(48);

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    publicUrl: "https://auth.example.com",
    googleClientId: "client-id.apps.googleusercontent.com",
    googleClientSecret: "client-secret",
    encryptionKey: KEY,
    databasePath: ":memory:",
    trustProxy: false,
    ...overrides,
  };
}

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

interface Harness {
  base: string;
  store: GrantStore;
  calls: Array<Record<string, string>>;
  close: () => Promise<void>;
}

const running: Harness[] = [];

async function start(tokenFetch: typeof fetch = jsonFetch({}), overrides: Partial<Config> = {}): Promise<Harness> {
  const calls: Array<Record<string, string>> = [];
  const recording: typeof fetch = async (input, init) => {
    calls.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))));
    return tokenFetch(input, init);
  };
  const relay = createRelay(baseConfig(overrides), { tokenFetch: recording });
  const port = await relay.listen(0, "127.0.0.1");
  const harness: Harness = {
    base: `http://127.0.0.1:${port}`,
    store: relay.store,
    calls,
    close: () => relay.close(),
  };
  running.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((harness) => harness.close()));
});

function startUrl(base: string, overrides: Record<string, string> = {}): string {
  const url = new URL("/oauth/start", base);
  url.searchParams.set("challenge", clientChallenge(VERIFIER));
  url.searchParams.set("state", randomUUID());
  url.searchParams.set("return_to", RETURN_TO);
  for (const [key, value] of Object.entries(overrides)) url.searchParams.set(key, value);
  return url.toString();
}

/** Drives start + callback and returns the ticket handed back to the client. */
async function authorize(harness: Harness): Promise<{ ticket: string; userState: string }> {
  const userState = randomUUID();
  const started = await fetch(startUrl(harness.base, { state: userState }), { redirect: "manual" });
  expect(started.status).toBe(302);
  const nonce = new URL(started.headers.get("location")!).searchParams.get("state")!;
  const callback = await fetch(`${harness.base}/oauth/callback?state=${encodeURIComponent(nonce)}&code=auth-code`, { redirect: "manual" });
  expect(callback.status).toBe(302);
  const destination = new URL(callback.headers.get("location")!);
  return { ticket: destination.searchParams.get("ticket")!, userState: destination.searchParams.get("state")! };
}

describe("GET /oauth/start", () => {
  it("redirects to Google with the configured client and scope", async () => {
    const harness = await start();
    const userState = randomUUID();
    const response = await fetch(startUrl(harness.base, { state: userState }), { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("client_id")).toBe("client-id.apps.googleusercontent.com");
    expect(location.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(location.searchParams.get("redirect_uri")).toBe("https://auth.example.com/oauth/callback");
    expect(location.searchParams.get("access_type")).toBe("offline");
    // The nonce sent to Google must not be the caller-supplied state.
    expect(location.searchParams.get("state")).not.toBe(userState);
  });

  it("rejects a challenge that is not a 43-character base64url digest", async () => {
    const harness = await start();
    for (const challenge of ["", "short", "!".repeat(43), "a".repeat(44)]) {
      const response = await fetch(startUrl(harness.base, { challenge }), { redirect: "manual" });
      expect(response.status).toBe(400);
    }
  });

  it("rejects a non-UUID state", async () => {
    const harness = await start();
    const response = await fetch(startUrl(harness.base, { state: "not-a-uuid" }), { redirect: "manual" });
    expect(response.status).toBe(400);
  });

  it("rejects any return URL other than the Obsidian callback", async () => {
    const harness = await start();
    for (const returnTo of ["https://attacker.example", "obsidian://other", "obsidian://vault-relay-auth?x=1", ""]) {
      const response = await fetch(startUrl(harness.base, { return_to: returnTo }), { redirect: "manual" });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("Invalid return URL");
    }
  });
});

describe("GET /oauth/callback", () => {
  it("rejects an unknown nonce", async () => {
    const harness = await start();
    const response = await fetch(`${harness.base}/oauth/callback?state=unknown&code=x`, { redirect: "manual" });
    expect(response.status).toBe(400);
  });

  it("rejects a replayed nonce", async () => {
    const harness = await start(jsonFetch({ access_token: "ya29.x", refresh_token: "1//0g", expires_in: 3600 }));
    const started = await fetch(startUrl(harness.base), { redirect: "manual" });
    const nonce = new URL(started.headers.get("location")!).searchParams.get("state")!;
    expect((await fetch(`${harness.base}/oauth/callback?state=${nonce}&code=c`, { redirect: "manual" })).status).toBe(302);
    expect((await fetch(`${harness.base}/oauth/callback?state=${nonce}&code=c`, { redirect: "manual" })).status).toBe(400);
  });

  it("surfaces a Google denial without echoing arbitrary text", async () => {
    const harness = await start();
    const started = await fetch(startUrl(harness.base), { redirect: "manual" });
    const nonce = new URL(started.headers.get("location")!).searchParams.get("state")!;
    const response = await fetch(`${harness.base}/oauth/callback?state=${nonce}&error=${encodeURIComponent("<script>alert(1)</script>")}`, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Google authorization failed: invalid_response");
  });

  it("fails when Google withholds a refresh token", async () => {
    const harness = await start(jsonFetch({ access_token: "ya29.x", expires_in: 3600 }));
    const started = await fetch(startUrl(harness.base), { redirect: "manual" });
    const nonce = new URL(started.headers.get("location")!).searchParams.get("state")!;
    const response = await fetch(`${harness.base}/oauth/callback?state=${nonce}&code=c`, { redirect: "manual" });
    expect(response.status).toBe(502);
  });

  it("returns the caller's original state alongside the ticket", async () => {
    const harness = await start(jsonFetch({ access_token: "ya29.x", refresh_token: "1//0g", expires_in: 3600 }));
    const userState = randomUUID();
    const started = await fetch(startUrl(harness.base, { state: userState }), { redirect: "manual" });
    const nonce = new URL(started.headers.get("location")!).searchParams.get("state")!;
    const callback = await fetch(`${harness.base}/oauth/callback?state=${nonce}&code=c`, { redirect: "manual" });
    const destination = new URL(callback.headers.get("location")!);
    expect(destination.protocol).toBe("obsidian:");
    expect(destination.searchParams.get("state")).toBe(userState);
    expect(destination.searchParams.get("ticket")).toBeTruthy();
    // The refresh token must never travel in the redirect.
    expect(callback.headers.get("location")).not.toContain("1//0g");
  });
});

describe("POST /oauth/claim", () => {
  it("returns the refresh token exactly once for the matching verifier", async () => {
    const harness = await start(jsonFetch({ access_token: "ya29.x", refresh_token: "1//0gSecret", expires_in: 3600 }));
    const { ticket } = await authorize(harness);
    const claim = async () => fetch(`${harness.base}/oauth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, verifier: VERIFIER }),
    });
    const first = await claim();
    expect(first.status).toBe(200);
    expect((await first.json()).refresh_token).toBe("1//0gSecret");
    expect((await claim()).status).toBe(401);
  });

  it("rejects a mismatched verifier and does not consume the grant", async () => {
    const harness = await start(jsonFetch({ access_token: "ya29.x", refresh_token: "1//0gSecret", expires_in: 3600 }));
    const { ticket } = await authorize(harness);
    const wrong = await fetch(`${harness.base}/oauth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, verifier: "w".repeat(48) }),
    });
    expect(wrong.status).toBe(401);
    const right = await fetch(`${harness.base}/oauth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, verifier: VERIFIER }),
    });
    expect(right.status).toBe(200);
  });

  it("rejects an unknown ticket, missing fields, and non-string fields", async () => {
    const harness = await start();
    const post = async (body: unknown) => fetch(`${harness.base}/oauth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await post({ ticket: "nope", verifier: VERIFIER })).status).toBe(401);
    expect((await post({ ticket: "only" })).status).toBe(400);
    expect((await post({ ticket: 1, verifier: 2 })).status).toBe(400);
    expect((await post({ ticket: "x".repeat(600), verifier: VERIFIER })).status).toBe(400);
  });

  it("rejects a body that is not JSON and one that is too large", async () => {
    const harness = await start();
    const invalid = await fetch(`${harness.base}/oauth/claim`, { method: "POST", body: "not json" });
    expect(invalid.status).toBe(400);
    const oversized = await fetch(`${harness.base}/oauth/claim`, { method: "POST", body: "x".repeat(20 * 1024) });
    expect(oversized.status).toBe(413);
  });
});

describe("POST /oauth/refresh", () => {
  it("exchanges a refresh token for an access token", async () => {
    const harness = await start(jsonFetch({ access_token: "ya29.fresh", expires_in: 1800, token_type: "Bearer" }));
    const response = await fetch(`${harness.base}/oauth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: "1//0gStored" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access_token: "ya29.fresh", expires_in: 1800, token_type: "Bearer" });
    // The confidential client credential is added server-side, never by the client.
    expect(harness.calls.at(-1)).toMatchObject({ grant_type: "refresh_token", client_secret: "client-secret" });
  });

  it("maps invalid_grant to 401 so the plugin can clear its credential", async () => {
    const harness = await start(jsonFetch({ error: "invalid_grant" }, 400));
    const response = await fetch(`${harness.base}/oauth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: "1//0gRevoked" }),
    });
    expect(response.status).toBe(401);
  });

  it("hides upstream failures behind a generic 500", async () => {
    const harness = await start(jsonFetch({ error: "backend_error" }, 500));
    const response = await fetch(`${harness.base}/oauth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: "1//0gStored" }),
    });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Internal server error");
  });

  it("requires a refresh token of bounded length", async () => {
    const harness = await start();
    const post = async (body: unknown) => fetch(`${harness.base}/oauth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await post({})).status).toBe(400);
    expect((await post({ refresh_token: "" })).status).toBe(400);
    expect((await post({ refresh_token: "x".repeat(5000) })).status).toBe(400);
  });
});

describe("routing and hardening", () => {
  it("serves health and returns 404 for unknown routes and wrong methods", async () => {
    const harness = await start();
    expect((await fetch(`${harness.base}/health`)).status).toBe(200);
    expect((await fetch(`${harness.base}/nope`)).status).toBe(404);
    expect((await fetch(`${harness.base}/oauth/start`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${harness.base}/oauth/claim`)).status).toBe(404);
  });

  it("sets no-store and nosniff on JSON responses", async () => {
    const harness = await start();
    const response = await fetch(`${harness.base}/health`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("rate limits a single client per route", async () => {
    const harness = await start();
    let limited = 0;
    for (let attempt = 0; attempt < 125; attempt += 1) {
      if ((await fetch(`${harness.base}/health`)).status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    // A different route keeps its own budget.
    expect((await fetch(`${harness.base}/nope`)).status).toBe(404);
  });

  it("ignores X-Forwarded-For unless the proxy is trusted", async () => {
    const harness = await start(jsonFetch({}), { trustProxy: false });
    let limited = 0;
    for (let attempt = 0; attempt < 125; attempt += 1) {
      const response = await fetch(`${harness.base}/health`, { headers: { "X-Forwarded-For": `10.0.0.${attempt % 200}` } });
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("keys the limiter on X-Forwarded-For when the proxy is trusted", async () => {
    const harness = await start(jsonFetch({}), { trustProxy: true });
    for (let attempt = 0; attempt < 125; attempt += 1) {
      const response = await fetch(`${harness.base}/health`, { headers: { "X-Forwarded-For": `10.0.${Math.floor(attempt / 250)}.${attempt}` } });
      expect(response.status).toBe(200);
    }
  });
});

describe("normalizeAddress", () => {
  it("passes IPv4 through and unwraps IPv4-mapped addresses", () => {
    expect(normalizeAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("collapses IPv6 addresses to a shared /64 bucket", () => {
    const first = normalizeAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    const second = normalizeAddress("2001:db8:1:2:1111:2222:3333:4444");
    expect(first).toBe(second);
    expect(first).toBe("2001:db8:1:2::/64");
    expect(normalizeAddress("2001:db8:1:3::1")).not.toBe(first);
  });

  it("expands compressed and bracketed forms", () => {
    expect(normalizeAddress("::1")).toBe("0:0:0:0::/64");
    expect(normalizeAddress("[2001:db8::1]")).toBe("2001:db8:0:0::/64");
    expect(normalizeAddress("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });
});
