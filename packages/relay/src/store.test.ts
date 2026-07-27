import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { verifierChallenge } from "./crypto.js";
import { GrantStore } from "./store.js";

describe("GrantStore", () => {
  it("binds a one-time grant to its verifier", () => {
    const store = new GrantStore(new DatabaseSync(":memory:"), "test-encryption-key-of-sufficient-length");
    const verifier = "v".repeat(48);
    const ticket = store.createGrant(verifierChallenge(verifier), "refresh-secret");
    expect(store.claim(ticket, "wrong")).toBeNull();
    expect(store.claim(ticket, verifier)).toBe("refresh-secret");
    expect(store.claim(ticket, verifier)).toBeNull();
    store.close();
  });

  it("consumes authorization requests once", () => {
    const store = new GrantStore(new DatabaseSync(":memory:"), "test-encryption-key-of-sufficient-length");
    const nonce = store.createAuthRequest("challenge", "state", "obsidian://vault-relay-auth", 100);
    expect(store.consumeAuthRequest(nonce, 101)?.user_state).toBe("state");
    expect(store.consumeAuthRequest(nonce, 101)).toBeNull();
    store.close();
  });
});
