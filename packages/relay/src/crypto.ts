import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/** Minimum accepted length of TOKEN_ENCRYPTION_KEY, in characters. */
export const MIN_ENCRYPTION_KEY_LENGTH = 32;
/** Salt length used for key derivation, in bytes. */
export const KEY_SALT_BYTES = 16;

export class TokenCipher {
  private readonly key: Buffer;

  /** A salt for a cipher that has none yet. Persist it with the ciphertext. */
  static newSalt(): Buffer {
    return randomBytes(KEY_SALT_BYTES);
  }

  /**
   * Derives the AES key with scrypt rather than a bare hash, so a weak operator
   * key is expensive to brute-force from a stolen database file. The salt is
   * persisted alongside the ciphertext it protects.
   */
  constructor(secret: string, salt: Buffer) {
    if (secret.length < MIN_ENCRYPTION_KEY_LENGTH) {
      throw new Error(`Token encryption key must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters`);
    }
    if (salt.byteLength < KEY_SALT_BYTES) {
      throw new Error(`Token encryption salt must be at least ${KEY_SALT_BYTES} bytes`);
    }
    this.key = scryptSync(secret, salt, 32);
  }

  encrypt(plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [nonce, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
  }

  decrypt(value: string): string {
    const parts = value.split(".");
    if (parts.length !== 3) throw new Error("Invalid encrypted token");
    const [nonceValue, tagValue, ciphertextValue] = parts as [string, string, string];
    if (!nonceValue || !tagValue || !ciphertextValue) throw new Error("Invalid encrypted token");
    const nonce = Buffer.from(nonceValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw new Error("Invalid encrypted token");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      // Never surface the underlying cipher error; it distinguishes tampering
      // modes to a caller that should only learn that the token is unusable.
      throw new Error("Invalid encrypted token");
    }
  }
}
