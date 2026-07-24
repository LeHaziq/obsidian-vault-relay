export function normalizeRelayOrigin(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("OAuth relay must use HTTPS outside exact loopback addresses");
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error("OAuth relay URL must contain only an origin");
  return url.origin;
}

export function safeRelayOrigin(value: string): string | null {
  try { return normalizeRelayOrigin(value); } catch { return null; }
}
