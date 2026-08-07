import { createHash } from "node:crypto";

/**
 * The client half of PKCE, written out again for the tests.
 *
 * The relay never derives a challenge in production. Deriving it here, from
 * Node directly, keeps the tests independent: they cannot pass because the
 * relay agrees with itself.
 */
export function clientChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
