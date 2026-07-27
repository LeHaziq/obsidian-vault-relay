export function buildAuthorizationUrl(relayOrigin: string, challenge: string, state: string): string {
  const url = new URL("/oauth/start", relayOrigin);
  url.searchParams.set("challenge", challenge);
  url.searchParams.set("state", state);
  url.searchParams.set("return_to", "obsidian://vault-relay-auth");
  return url.toString();
}
