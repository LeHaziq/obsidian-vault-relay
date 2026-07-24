import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "secret",
  TOKEN_ENCRYPTION_KEY: "key",
};

describe("loadConfig", () => {
  it("rejects insecure lookalike localhost hosts", () => {
    expect(() => loadConfig({ ...base, PUBLIC_URL: "http://localhost.attacker.example" })).toThrow("HTTPS");
  });

  it("accepts exact loopback development origins", () => {
    expect(loadConfig({ ...base, PUBLIC_URL: "http://localhost:8787" }).publicUrl).toBe("http://localhost:8787");
  });
});
