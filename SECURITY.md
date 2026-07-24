# Security

## Reporting

Do not open a public issue containing OAuth credentials, tokens, vault content, or a reproducible token-exfiltration path. Contact the maintainer privately before public disclosure.

## Relay deployment

- Terminate TLS with a maintained reverse proxy or load balancer.
- Keep `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` in a secret manager.
- Persist `/app/data` and restrict it to the relay process.
- Do not place request bodies, query strings, or response headers in proxy access logs. OAuth callback query strings contain short-lived authorization codes.
- Set `TRUST_PROXY=true` only when the trusted proxy overwrites `X-Forwarded-For`; otherwise clients can spoof rate-limit identities.
- Restrict administrative access and apply upstream request limits in addition to the relay's per-process limiter.
- Run one relay instance per SQLite volume. Multi-instance deployments should replace SQLite with a shared transactional grant store.
- Keep Node.js and the container base image patched.

## Threat boundaries

The relay can observe Google refresh tokens during initial authorization and hourly token renewal. It does not receive vault file content. A compromised relay can steal tokens for requests passing through it, so users should deploy or trust the configured relay operator.

Google Drive stores unencrypted vault content in the current protocol. The folder is an internal object store, but anyone with account or Drive access can download its blobs. End-to-end encryption is not implemented in version 1.
