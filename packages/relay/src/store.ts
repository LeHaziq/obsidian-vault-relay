import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { base64Url, digest, safeEqual, TokenCipher, verifierChallenge } from "./crypto.js";

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

export class GrantStore {
  private readonly cipher: TokenCipher;

  constructor(private readonly db: DatabaseSync, encryptionKey: string) {
    this.cipher = new TokenCipher(encryptionKey);
    db.exec(`
      PRAGMA journal_mode = WAL;
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
  }

  createAuthRequest(challenge: string, userState: string, returnTo: string, now = Date.now()): string {
    this.cleanup(now);
    const nonce = base64Url(randomBytes(32));
    this.db.prepare("INSERT INTO auth_requests(nonce, challenge, user_state, return_to, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(nonce, challenge, userState, returnTo, now + 10 * 60_000);
    return nonce;
  }

  consumeAuthRequest(nonce: string, now = Date.now()): AuthRow | null {
    const row = this.db.prepare("SELECT nonce, challenge, user_state, return_to, expires_at FROM auth_requests WHERE nonce = ?")
      .get(nonce) as AuthRow | undefined;
    this.db.prepare("DELETE FROM auth_requests WHERE nonce = ?").run(nonce);
    return row && row.expires_at >= now ? row : null;
  }

  createGrant(challenge: string, refreshToken: string, now = Date.now()): string {
    const ticket = base64Url(randomBytes(32));
    this.db.prepare("INSERT INTO grants(ticket_hash, challenge, encrypted_token, expires_at) VALUES (?, ?, ?, ?)")
      .run(digest(ticket), challenge, this.cipher.encrypt(refreshToken), now + 5 * 60_000);
    return ticket;
  }

  claim(ticket: string, verifier: string, now = Date.now()): string | null {
    const ticketHash = digest(ticket);
    const row = this.db.prepare("SELECT ticket_hash, challenge, encrypted_token, expires_at FROM grants WHERE ticket_hash = ?")
      .get(ticketHash) as GrantRow | undefined;
    if (!row || row.expires_at < now || !safeEqual(row.challenge, verifierChallenge(verifier))) return null;
    this.db.prepare("DELETE FROM grants WHERE ticket_hash = ?").run(ticketHash);
    return this.cipher.decrypt(row.encrypted_token);
  }

  close(): void {
    this.db.close();
  }

  private cleanup(now: number): void {
    this.db.prepare("DELETE FROM auth_requests WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM grants WHERE expires_at < ?").run(now);
  }
}
