import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { createRelay, type Relay } from "./relay.js";

const KEY = "test-encryption-key-of-sufficient-length";

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

const running: Relay[] = [];

async function start(overrides: Partial<Config> = {}): Promise<{ relay: Relay; base: string }> {
  const relay = createRelay(baseConfig(overrides));
  running.push(relay);
  const port = await relay.listen(0, "127.0.0.1");
  return { relay, base: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((relay) => relay.close()));
});

describe("createRelay", () => {
  it("serves requests on the port it listens on", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("closes the server and the store, and tolerates a second close", async () => {
    const { relay, base } = await start();
    await relay.close();
    await relay.close();
    await expect(fetch(`${base}/health`)).rejects.toThrow();
    expect(() => relay.store.createAuthRequest("challenge", "state", "obsidian://vault-relay-auth")).toThrow();
  });

  it("fails one request with a 500 when request handling throws unexpectedly", async () => {
    let failNext = true;
    const relay = createRelay(baseConfig(), {
      handler: {
        handle: async (_request, response) => {
          if (failNext) {
            failNext = false;
            throw new Error("boom");
          }
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ status: "ok" }));
        },
        dispose: () => {},
      },
    });
    running.push(relay);
    const base = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
    const failed = await fetch(`${base}/oauth/claim`);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Internal server error" });
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("keeps the store open until in-flight requests finish", async () => {
    let arrived: () => void = () => {};
    const entered = new Promise<void>((resolve) => { arrived = resolve; });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const relay = createRelay(baseConfig(), {
      handler: {
        handle: async (_request, response) => {
          arrived();
          await held;
          const nonce = relay.store.createAuthRequest("challenge", "state", "obsidian://vault-relay-auth");
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ nonce }));
        },
        dispose: () => {},
      },
    });
    running.push(relay);
    const base = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;

    const pending = fetch(`${base}/health`);
    await entered;
    const closed = relay.close();
    release();

    const response = await pending;
    expect(response.status).toBe(200);
    expect((await response.json() as { nonce: string }).nonce).toMatch(/\S/);
    await closed;
  });
});
