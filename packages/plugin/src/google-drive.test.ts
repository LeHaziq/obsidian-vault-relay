import { describe, expect, it } from "vitest";
import { retryable } from "./google-drive";

function response(status: number, reason?: string) {
  return { status, json: reason ? { error: { errors: [{ reason }] } } : undefined };
}

describe("retryable", () => {
  it("always retries 429", () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      expect(retryable(response(429), method)).toBe(true);
    }
  });

  it("retries 403 only when Drive reports throttling", () => {
    expect(retryable(response(403, "rateLimitExceeded"), "GET")).toBe(true);
    expect(retryable(response(403, "userRateLimitExceeded"), "POST")).toBe(true);
    // A permission failure will never succeed; retrying burned five attempts
    // with backoff before surfacing the error.
    expect(retryable(response(403, "insufficientFilePermissions"), "GET")).toBe(false);
    expect(retryable(response(403), "GET")).toBe(false);
  });

  it("retries 5xx for idempotent methods", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(retryable(response(status), "GET")).toBe(true);
      expect(retryable(response(status), "PUT")).toBe(true);
      expect(retryable(response(status), "DELETE")).toBe(true);
    }
  });

  it("retries a POST only on 503, which means the request was shed", () => {
    // Uploads are POSTs. Previously no POST was retried at all, so a single
    // transient 429 or 503 failed the whole sync.
    expect(retryable(response(503), "POST")).toBe(true);
    expect(retryable(response(500), "POST")).toBe(false);
    expect(retryable(response(502), "POST")).toBe(false);
    expect(retryable(response(504), "POST")).toBe(false);
  });

  it("does not retry client errors or success", () => {
    for (const status of [200, 201, 308, 400, 401, 404, 409, 410, 412]) {
      expect(retryable(response(status), "GET")).toBe(false);
    }
  });
});
