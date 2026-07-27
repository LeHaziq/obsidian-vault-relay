import { describe, expect, it } from "vitest";
import { redactTokens } from "./redact";

describe("redactTokens", () => {
  it("redacts Google refresh tokens, which use a double slash", () => {
    // The previous pattern `1/[\w-]+` could never match this shape.
    const redacted = redactTokens("refresh failed for 1//0gABCdef-XYZ_123 at step 2");
    expect(redacted).not.toContain("0gABCdef");
    expect(redacted).toBe("refresh failed for [redacted] at step 2");
  });

  it("redacts access tokens and bearer headers", () => {
    expect(redactTokens("token ya29.a0AfB_xyz-123")).toBe("token [redacted]");
    expect(redactTokens("Authorization: Bearer ya29.a0AfB_xyz")).toContain("[redacted]");
    expect(redactTokens("Authorization: Bearer ya29.a0AfB_xyz")).not.toContain("a0AfB");
  });

  it("redacts JWT-shaped values", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
    expect(redactTokens(`id_token=${jwt}`)).not.toContain("eyJzdWIi");
  });

  it("redacts labelled token fields", () => {
    expect(redactTokens('{"refresh_token":"1//0gSecretValue"}')).not.toContain("SecretValue");
    expect(redactTokens('{"access_token": "abcdefghijklmnop"}')).not.toContain("abcdefghijklmnop");
  });

  it("leaves ordinary messages untouched", () => {
    for (const message of [
      "Google Drive returned HTTP 503 (backendError)",
      "Local file changed before upload completed: notes/a.md",
      "Safety stop: sync would delete 42 files at once",
      "",
    ]) {
      expect(redactTokens(message)).toBe(message);
    }
  });

  it("redacts every occurrence in one message", () => {
    const redacted = redactTokens("first 1//0gAAA then ya29.BBB and 1//0gCCC");
    expect(redacted).toBe("first [redacted] then [redacted] and [redacted]");
  });
});
