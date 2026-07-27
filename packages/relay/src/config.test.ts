import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "secret",
  TOKEN_ENCRYPTION_KEY: "a-sufficiently-long-token-encryption-key",
};

describe("loadConfig", () => {
  it("rejects insecure lookalike localhost hosts", () => {
    expect(() => loadConfig({ ...base, PUBLIC_URL: "http://localhost.attacker.example" })).toThrow("HTTPS");
  });

  it("accepts exact loopback development origins", () => {
    expect(loadConfig({ ...base, PUBLIC_URL: "http://localhost:8787" }).publicUrl).toBe("http://localhost:8787");
  });

  it("rejects a PUBLIC_URL carrying anything beyond an origin", () => {
    for (const url of ["https://auth.example.com/path", "https://a:b@auth.example.com", "https://auth.example.com/?x=1", "https://auth.example.com/#f"]) {
      expect(() => loadConfig({ ...base, PUBLIC_URL: url })).toThrow("origin");
    }
  });

  it("rejects a weak token encryption key", () => {
    // A short key made the AES key trivially brute-forceable from a stolen database.
    expect(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: "key", PUBLIC_URL: "https://auth.example.com" })).toThrow("at least 32 characters");
    expect(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: "a".repeat(31), PUBLIC_URL: "https://auth.example.com" })).toThrow("at least 32 characters");
    expect(loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: "a".repeat(32), PUBLIC_URL: "https://auth.example.com" }).encryptionKey).toHaveLength(32);
  });

  it("requires every mandatory variable", () => {
    for (const missing of ["PUBLIC_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
      const environment: NodeJS.ProcessEnv = { ...base, PUBLIC_URL: "https://auth.example.com" };
      delete environment[missing];
      expect(() => loadConfig(environment)).toThrow(missing);
    }
  });

  it("rejects an out-of-range port", () => {
    for (const port of ["0", "70000", "abc", "8787.5"]) {
      expect(() => loadConfig({ ...base, PUBLIC_URL: "https://auth.example.com", PORT: port })).toThrow("PORT");
    }
    expect(loadConfig({ ...base, PUBLIC_URL: "https://auth.example.com", PORT: "9000" }).port).toBe(9000);
  });

  it("treats TRUST_PROXY as opt-in", () => {
    const environment = { ...base, PUBLIC_URL: "https://auth.example.com" };
    expect(loadConfig(environment).trustProxy).toBe(false);
    expect(loadConfig({ ...environment, TRUST_PROXY: "1" }).trustProxy).toBe(false);
    expect(loadConfig({ ...environment, TRUST_PROXY: "true" }).trustProxy).toBe(true);
  });
});
