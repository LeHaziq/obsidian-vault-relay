# Vault Relay

Vault Relay is an Obsidian plugin that synchronizes notes and attachments through Google Drive on desktop and mobile. It is designed to preserve data when devices edit the same file offline instead of choosing a winner from unreliable timestamps.

This repository contains:

- `packages/protocol`: platform-independent operation graph and sync engine.
- `packages/plugin`: mobile-compatible Obsidian plugin and Google Drive REST client.
- `packages/relay`: small Node.js OAuth service. It handles Google credentials, but vault file data travels directly between Obsidian and Google Drive.

## Reliability model

Remote data is an internal sync store rather than a browsable Markdown mirror. Do not manually edit or delete its files; active clients repair missing operation records retained in their bounded local checkpoint.

```text
Vault Relay - <vault name>/
  vault.json
  blobs/
    <sha256>
  operations/
    <operation-id>.json
```

Blobs and operations are immutable. A client uploads content before publishing the operation that references it. Concurrent versions are detected from their parent operation IDs, not modification times. Vault Relay writes alternate content as a conflict copy and never silently discards it.

The remote store retains history indefinitely. Each device keeps a bounded checkpoint of recent versions per path so mobile plugin state does not grow without limit. Content-addressed blobs deduplicate identical content. Remote garbage collection and end-to-end encryption are intentionally reserved for a later protocol version.

## Requirements

- Obsidian 1.11.4 or newer on every device.
- Node.js 22.13 or newer for development and the OAuth relay.
- A Google Cloud project with the Drive API enabled.
- An HTTPS hostname for the production OAuth relay.

## Build

```bash
npm install
npm run check
```

The Obsidian artifacts are generated at:

- `packages/plugin/main.js`
- `packages/plugin/manifest.json`
- `packages/plugin/styles.css`

For local installation, put those three files in `<vault>/.obsidian/plugins/vault-relay/` and enable **Vault Relay** under Community plugins.

## Configure Google OAuth

1. Create a project in the [Google Cloud console](https://console.cloud.google.com/).
2. Enable **Google Drive API**.
3. Configure the OAuth consent screen and request only `https://www.googleapis.com/auth/drive.file`.
4. Create an OAuth client with application type **Web application**.
5. Add `https://auth.example.com/oauth/callback` as an authorized redirect URI, replacing the hostname with your relay hostname.
6. Set the resulting client ID and client secret on the relay.

The `drive.file` scope limits the plugin to files it creates. It does not grant access to unrelated files in the account.

## Deploy the OAuth relay

Create a random encryption key:

```bash
openssl rand -base64 48
```

Build from the repository root:

```bash
docker build -f packages/relay/Dockerfile -t vault-relay-oauth .
```

Run it behind an HTTPS reverse proxy:

```bash
docker run --name vault-relay-oauth \
  -p 8787:8787 \
  -v vault-relay-data:/app/data \
  -e PUBLIC_URL=https://auth.example.com \
  -e GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com \
  -e GOOGLE_CLIENT_SECRET=your-client-secret \
  -e TOKEN_ENCRYPTION_KEY=your-random-key \
  -e TRUST_PROXY=true \
  vault-relay-oauth
```

The SQLite volume stores short-lived OAuth requests and encrypted, five-minute claim tickets. It does not store vault content or long-lived refresh tokens. During access-token renewal, the relay receives the refresh token over HTTPS, adds the confidential Google client credential, forwards it to Google, and does not persist it.

Set `TRUST_PROXY=true` only when the relay is behind a trusted reverse proxy that overwrites `X-Forwarded-For`. Leave it disabled when exposing the Node service directly.

Do not expose the relay over plain HTTP outside local development. Back up `TOKEN_ENCRYPTION_KEY` only if an OAuth flow is currently in progress; losing it does not affect tokens already claimed by devices.

## First migration

1. Install the plugin in the desktop vault that currently lives in the Google Drive-mounted folder.
2. Set the relay URL and connect Google Drive.
3. Choose **Create from this vault** and wait for the initial upload to complete.
4. On iOS, create an empty local Obsidian vault and install the plugin.
5. Connect the same Google account, choose the existing remote vault, and wait for download and hash verification.
6. Verify representative notes and attachments on both devices.
7. Move the desktop vault out of the Google Drive-mounted directory and reopen it from its new local location.

The last step prevents Google Drive for desktop and Vault Relay from independently synchronizing the same local files.

Linking a remote store to a non-empty local vault is allowed. Local and remote versions without common ancestry become explicit conflicts rather than overwriting one another.

## Operation

- Sync runs at startup, after a short local-change debounce, at the configured interval, or from **Vault Relay: Sync now**.
- The status bar reports setup, syncing, paused, error, and conflict states.
- **Show conflicts** lists preserved concurrent versions.
- Resolve a conflict by comparing or copying the desired content, then use **Keep current file** or **Keep deleted**. Resolution creates a new operation descended from every conflicting head and cleans up generated copies.
- **Restore a historical version** downloads old content and writes it locally. The next sync publishes it as a new version without deleting history.
- A sync that would trash more than 25 files or 25% of the local vault stops for review. Use **Review and apply blocked bulk deletions once** only after confirming the deletion on the other device.

## Mobile limitation

Obsidian community plugins run only while Obsidian is active. iOS does not allow this plugin to provide continuous background synchronization. Open Obsidian and wait for the status to return to ready before switching devices, especially after editing large attachments.

## Security properties

- Refresh tokens use Obsidian `SecretStorage`, never plugin `data.json`.
- OAuth callbacks use state validation, a verifier-bound claim ticket, expiration, and single-use database deletion.
- Pending refresh tokens are encrypted with AES-256-GCM.
- The relay does not proxy vault content.
- Google API retries use bounded exponential backoff.
- Logs contain method, route, status, and timing only; request bodies and tokens are not logged.
- Local paths are normalized, traversal is rejected, and case collisions stop sync before writes.

See [SECURITY.md](SECURITY.md) for reporting and deployment guidance.

## Development

```bash
npm test
npm run typecheck
npm run build
```

The protocol tests cover initial replication, deletion, concurrent offline edits, commit ordering, path traversal, case collisions, and single-use OAuth grants. Real-device validation is still required before publishing a community-plugin release.

## License

MIT
