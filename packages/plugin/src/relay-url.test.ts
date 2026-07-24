import { describe, expect, it } from "vitest";
import { normalizeRelayOrigin } from "./relay-url";

describe("normalizeRelayOrigin", () => {
  it("allows HTTPS and exact loopback HTTP origins", () => {
    expect(normalizeRelayOrigin("https://auth.example.com/")).toBe("https://auth.example.com");
    expect(normalizeRelayOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });

  it("rejects plaintext remote and lookalike origins", () => {
    expect(() => normalizeRelayOrigin("http://auth.example.com")).toThrow("HTTPS");
    expect(() => normalizeRelayOrigin("http://localhost.attacker.example")).toThrow("HTTPS");
  });
});
