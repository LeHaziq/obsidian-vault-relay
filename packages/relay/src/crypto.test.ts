import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KEY_SALT_BYTES, MIN_ENCRYPTION_KEY_LENGTH, TokenCipher } from "./crypto.js";

const KEY = "k".repeat(MIN_ENCRYPTION_KEY_LENGTH);

describe("TokenCipher", () => {
  it("round-trips a token", () => {
    const cipher = new TokenCipher(KEY, TokenCipher.newSalt());
    expect(cipher.decrypt(cipher.encrypt("1//0gRefreshToken"))).toBe("1//0gRefreshToken");
  });

  it("uses a fresh nonce for every encryption", () => {
    const cipher = new TokenCipher(KEY, TokenCipher.newSalt());
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
  });

  it("rejects a key shorter than the documented minimum", () => {
    expect(() => new TokenCipher("short", TokenCipher.newSalt())).toThrow("at least");
  });

  it("rejects an undersized salt", () => {
    expect(() => new TokenCipher(KEY, randomBytes(8))).toThrow("salt");
  });

  it("derives different keys from different salts", () => {
    const salt = TokenCipher.newSalt();
    const encrypted = new TokenCipher(KEY, salt).encrypt("secret");
    expect(new TokenCipher(KEY, salt).decrypt(encrypted)).toBe("secret");
    expect(() => new TokenCipher(KEY, TokenCipher.newSalt()).decrypt(encrypted)).toThrow("Invalid encrypted token");
  });

  it("rejects a tampered auth tag", () => {
    const cipher = new TokenCipher(KEY, TokenCipher.newSalt());
    const [nonce, , ciphertext] = cipher.encrypt("secret").split(".");
    const forgedTag = Buffer.alloc(16, 7).toString("base64url");
    expect(() => cipher.decrypt(`${nonce}.${forgedTag}.${ciphertext}`)).toThrow("Invalid encrypted token");
  });

  it("rejects tampered ciphertext", () => {
    const cipher = new TokenCipher(KEY, TokenCipher.newSalt());
    const [nonce, tag] = cipher.encrypt("secret").split(".");
    const forged = Buffer.from("attacker chosen").toString("base64url");
    expect(() => cipher.decrypt(`${nonce}.${tag}.${forged}`)).toThrow("Invalid encrypted token");
  });

  it("rejects malformed input", () => {
    const cipher = new TokenCipher(KEY, TokenCipher.newSalt());
    for (const value of ["", "a.b", "a.b.c.d", "....", "a.b.c"]) {
      expect(() => cipher.decrypt(value)).toThrow("Invalid encrypted token");
    }
  });

  it("does not leak the cipher failure mode", () => {
    const cipher = new TokenCipher(KEY, TokenCipher.newSalt());
    const [nonce, tag, ciphertext] = cipher.encrypt("secret").split(".");
    const wrongTag = (() => { try { cipher.decrypt(`${nonce}.${Buffer.alloc(16).toString("base64url")}.${ciphertext}`); } catch (error) { return (error as Error).message; } return ""; })();
    const wrongNonce = (() => { try { cipher.decrypt(`${Buffer.alloc(12).toString("base64url")}.${tag}.${ciphertext}`); } catch (error) { return (error as Error).message; } return ""; })();
    expect(wrongTag).toBe(wrongNonce);
  });

  it("mints a fresh salt of the documented size", () => {
    const salt = TokenCipher.newSalt();
    expect(salt.byteLength).toBe(KEY_SALT_BYTES);
    expect(salt.equals(TokenCipher.newSalt())).toBe(false);
    expect(() => new TokenCipher(KEY, salt)).not.toThrow();
  });
});
