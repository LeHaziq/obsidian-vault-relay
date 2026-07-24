import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RelayApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GrantStore } from "./store.js";

const config = loadConfig();
mkdirSync(dirname(config.databasePath), { recursive: true });
const store = new GrantStore(new DatabaseSync(config.databasePath), config.encryptionKey);
const app = new RelayApp(config, store);
const server = createServer((request, response) => void app.handle(request, response));
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.listen(config.port, () => {
  console.info(`Vault Relay OAuth service listening on port ${config.port}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
