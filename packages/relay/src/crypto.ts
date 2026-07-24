import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function base64Url(input: Buffer): string {
  return input.toString("base64url");
}

export function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function verifierChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class TokenCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret).digest();
  }

  encrypt(plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [base64Url(nonce), base64Url(cipher.getAuthTag()), base64Url(ciphertext)].join(".");
  }

  decrypt(value: string): string {
    const [nonceValue, tagValue, ciphertextValue] = value.split(".");
    if (!nonceValue || !tagValue || !ciphertextValue) throw new Error("Invalid encrypted token");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(nonceValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
  }
}
