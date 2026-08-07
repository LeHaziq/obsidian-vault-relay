import { describe, expect, it } from "vitest";
import { verifierMatchesChallenge } from "./pkce.js";
import { clientChallenge } from "./pkce.test-helper.js";

const VERIFIER = "v".repeat(48);

describe("verifierMatchesChallenge", () => {
  it("accepts the verifier the challenge was derived from", () => {
    expect(verifierMatchesChallenge(VERIFIER, clientChallenge(VERIFIER))).toBe(true);
  });

  it("rejects a different verifier", () => {
    expect(verifierMatchesChallenge("w".repeat(48), clientChallenge(VERIFIER))).toBe(false);
  });

  it("rejects a challenge of the wrong length instead of throwing", () => {
    expect(verifierMatchesChallenge(VERIFIER, "too-short")).toBe(false);
    expect(verifierMatchesChallenge(VERIFIER, "")).toBe(false);
  });

  it("rejects the plain verifier presented as its own challenge", () => {
    const verifier = "v".repeat(43);
    expect(verifierMatchesChallenge(verifier, verifier)).toBe(false);
  });

  it("rejects a challenge that differs in one character", () => {
    const challenge = clientChallenge(VERIFIER);
    const mutated = `${challenge[0] === "A" ? "B" : "A"}${challenge.slice(1)}`;
    expect(verifierMatchesChallenge(VERIFIER, mutated)).toBe(false);
  });

  it("accepts the 43-character base64url challenge the relay validates", () => {
    const challenge = clientChallenge(VERIFIER);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifierMatchesChallenge(VERIFIER, challenge)).toBe(true);
  });
});
