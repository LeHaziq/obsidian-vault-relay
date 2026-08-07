import type { Config } from "./config.js";

export const TEST_ENCRYPTION_KEY = "test-encryption-key-of-sufficient-length";

export function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    publicUrl: "https://auth.example.com",
    googleClientId: "client-id.apps.googleusercontent.com",
    googleClientSecret: "client-secret",
    encryptionKey: TEST_ENCRYPTION_KEY,
    databasePath: ":memory:",
    trustProxy: false,
    ...overrides,
  };
}
