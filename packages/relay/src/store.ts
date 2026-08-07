import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { TokenCipher } from "./crypto.js";
import { verifierMatchesChallenge } from "./pkce.js";

interface AuthRow {
  nonce: string;
  challenge: string;
  user_state: string;
  return_to: string;
  expires_at: number;
}

interface GrantRow {
  ticket_hash: string;
  challenge: string;
  encrypted_token: string;
  expires_at: number;
}

const SALT_KEY = "token_key_salt";

export class GrantStore {
  private readonly cipher: TokenCipher;

  constructor(private readonly db: DatabaseSync, encryptionKey: string) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS relay_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS auth_requests (
        nonce TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        user_state TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS grants (
        ticket_hash TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        encrypted_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS auth_expiry ON auth_requests(expires_at);
      CREATE INDEX IF NOT EXISTS grant_expiry ON grants(expires_at);
    `);
    this.cipher = new TokenCipher(encryptionKey, this.keySalt());
  }

  createAuthRequest(challenge: string, userState: string, returnTo: string, now = Date.now()): string {
    this.cleanup(now);
    const nonce = randomSecret();
    this.db.prepare("INSERT INTO auth_requests(nonce, challenge, user_state, return_to, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(nonce, challenge, userState, returnTo, now + 10 * 60_000);
    return nonce;
  }

  consumeAuthRequest(nonce: string, now = Date.now()): AuthRow | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT nonce, challenge, user_state, return_to, expires_at FROM auth_requests WHERE nonce = ?")
        .get(nonce) as AuthRow | undefined;
      this.db.prepare("DELETE FROM auth_requests WHERE nonce = ?").run(nonce);
      return row && row.expires_at >= now ? row : null;
    });
  }

  createGrant(challenge: string, refreshToken: string, now = Date.now()): string {
    const ticket = randomSecret();
    this.db.prepare("INSERT INTO grants(ticket_hash, challenge, encrypted_token, expires_at) VALUES (?, ?, ?, ?)")
      .run(ticketHash(ticket), challenge, this.cipher.encrypt(refreshToken), now + 5 * 60_000);
    return ticket;
  }

  claim(ticket: string, verifier: string, now = Date.now()): string | null {
    const encrypted = this.transaction(() => {
      const hash = ticketHash(ticket);
      const row = this.db.prepare("SELECT ticket_hash, challenge, encrypted_token, expires_at FROM grants WHERE ticket_hash = ?")
        .get(hash) as GrantRow | undefined;
      if (!row || row.expires_at < now || !verifierMatchesChallenge(verifier, row.challenge)) return null;
      this.db.prepare("DELETE FROM grants WHERE ticket_hash = ?").run(hash);
      return row.encrypted_token;
    });
    return encrypted === null ? null : this.cipher.decrypt(encrypted);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Read-then-delete has to be atomic so a second caller cannot observe a grant
   * that is already being consumed. Single-instance deployments are safe by
   * virtue of synchronous SQLite on one thread; this makes it structural.
   */
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private keySalt(): Buffer {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM relay_meta WHERE key = ?").get(SALT_KEY) as { value: string } | undefined;
      if (row) return Buffer.from(row.value, "base64");
      const salt = TokenCipher.newSalt();
      this.db.prepare("INSERT INTO relay_meta(key, value) VALUES (?, ?)").run(SALT_KEY, salt.toString("base64"));
      return salt;
    });
  }

  private cleanup(now: number): void {
    this.db.prepare("DELETE FROM auth_requests WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM grants WHERE expires_at < ?").run(now);
  }
}

/** 256 bits of entropy, URL-safe: the shape of both nonces and tickets. */
function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The store keeps only the hash of each ticket. Thus a stolen database file
 * gives no ticket that a thief can still redeem. A plain digest is sufficient
 * here, although a password would need scrypt. The ticket is 256 random bits,
 * not a secret that an attacker can guess.
 */
function ticketHash(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}
