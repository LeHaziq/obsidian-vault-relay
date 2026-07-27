import { MIN_ENCRYPTION_KEY_LENGTH } from "./crypto.js";

export interface Config {
  port: number;
  publicUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  encryptionKey: string;
  databasePath: string;
  trustProxy: boolean;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = environment[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  const encryptionKey = required("TOKEN_ENCRYPTION_KEY");
  if (encryptionKey.length < MIN_ENCRYPTION_KEY_LENGTH) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters; generate one with: openssl rand -base64 48`);
  }
  const parsedPublicUrl = new URL(required("PUBLIC_URL"));
  const loopback = parsedPublicUrl.hostname === "localhost" || parsedPublicUrl.hostname === "127.0.0.1" || parsedPublicUrl.hostname === "[::1]";
  if (parsedPublicUrl.protocol !== "https:" && !(parsedPublicUrl.protocol === "http:" && loopback)) throw new Error("PUBLIC_URL must use HTTPS outside exact loopback addresses");
  if (parsedPublicUrl.username || parsedPublicUrl.password || (parsedPublicUrl.pathname !== "/" && parsedPublicUrl.pathname !== "") || parsedPublicUrl.search || parsedPublicUrl.hash) {
    throw new Error("PUBLIC_URL must contain only an origin");
  }
  const port = Number(environment.PORT ?? 8787);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer from 1 to 65535");
  return {
    port,
    publicUrl: parsedPublicUrl.origin,
    googleClientId: required("GOOGLE_CLIENT_ID"),
    googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
    encryptionKey,
    databasePath: environment.DATABASE_PATH ?? "./data/relay.sqlite",
    trustProxy: environment.TRUST_PROXY === "true",
  };
}
