import { describe, expect, it } from "vitest";
import { buildAuthorizationUrl } from "./oauth-url";

describe("buildAuthorizationUrl", () => {
  it("builds the relay start URL with the Obsidian callback", () => {
    const result = new URL(buildAuthorizationUrl("https://auth.example.com", "challenge", "state"));
    expect(result.origin).toBe("https://auth.example.com");
    expect(result.pathname).toBe("/oauth/start");
    expect(result.searchParams.get("challenge")).toBe("challenge");
    expect(result.searchParams.get("state")).toBe("state");
    expect(result.searchParams.get("return_to")).toBe("obsidian://vault-relay-auth");
  });
});
