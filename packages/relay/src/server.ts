import { mkdirSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RelayApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GrantStore } from "./store.js";

const config = loadConfig();
mkdirSync(dirname(config.databasePath), { recursive: true });
const store = new GrantStore(new DatabaseSync(config.databasePath), config.encryptionKey);
const app = new RelayApp(config, store);

const server = createServer((request, response) => {
  // handle() owns its own error responses; this catch exists so an unexpected
  // throw fails one request instead of taking down the process.
  app.handle(request, response).catch((error: unknown) => {
    console.error(JSON.stringify({ message: "Unhandled request failure", error: error instanceof Error ? error.message : String(error) }));
    failSafe(response);
  });
});
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.on("clientError", (error, socket) => {
  if (!socket.writable) return void socket.destroy();
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.on("error", (error) => {
  console.error(JSON.stringify({ message: "Server error", error: error.message }));
  process.exitCode = 1;
  server.close();
});

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ message: "Unhandled rejection", error: reason instanceof Error ? reason.message : String(reason) }));
});

process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({ message: "Uncaught exception", error: error.message }));
  shutdown(1);
});

server.listen(config.port, () => {
  console.info(`Vault Relay OAuth service listening on port ${config.port}`);
});

function failSafe(response: ServerResponse): void {
  try {
    if (response.writableEnded || response.destroyed) return;
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Internal server error" }));
  } catch {
    response.destroy();
  }
}

let shuttingDown = false;

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  app.dispose();
  server.close(() => {
    store.close();
    process.exit(code);
  });
  setTimeout(() => process.exit(code || 1), 10_000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
