import { createHash, timingSafeEqual } from "node:crypto";

/**
 * PKCE, the relay's half: the client commits to a secret verifier by sending
 * only its SHA-256 challenge when the authorization starts, then presents the
 * verifier itself to redeem the grant.
 *
 * The comparison takes constant time. Thus an attacker with a stolen ticket
 * cannot find the verifier one character at a time from the response delay.
 * The derivation and the comparison stay behind one call. Thus no caller can
 * get the digest and compare it in a way that leaks the delay.
 */
export function verifierMatchesChallenge(verifier: string, challenge: string): boolean {
  const derived = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const stored = Buffer.from(challenge);
  return derived.byteLength === stored.byteLength && timingSafeEqual(derived, stored);
}
