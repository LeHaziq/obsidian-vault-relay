import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RelayApp } from "./app.js";
import type { Config } from "./config.js";
import { GrantStore } from "./store.js";

/** What the server needs from the application it serves. */
export interface RelayHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  dispose(): void;
}

export interface RelayOptions {
  /** Replaces the default app, so a test can drive the request failure path. */
  handler?: RelayHandler;
  /** The fetch the default app makes its Google token calls with. */
  tokenFetch?: typeof fetch;
  /** Called after a server error once the relay is listening, so the caller can decide to stop. A failure to bind rejects listen() instead. */
  onError?: (error: Error) => void;
}

export interface Relay {
  /** The grant store the relay serves from, for tests that inspect it. */
  readonly store: GrantStore;
  /** Binds the socket, on the configured port by default, and resolves with the port that was bound. */
  listen(port?: number, host?: string): Promise<number>;
  /** Releases every resource the relay owns. Safe to call more than once. */
  close(): Promise<void>;
}

export function createRelay(config: Config, options: RelayOptions = {}): Relay {
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const store = new GrantStore(new DatabaseSync(config.databasePath), config.encryptionKey);
  const handler = options.handler ?? new RelayApp(config, store, options.tokenFetch);

  const server = createServer((request, response) => {
    // handle() owns its own error responses; this catch exists so an unexpected
    // throw fails one request instead of taking down the process.
    handler.handle(request, response).catch((error: unknown) => {
      console.error(JSON.stringify({ message: "Unhandled request failure", error: error instanceof Error ? error.message : String(error) }));
      failSafe(response);
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  // Without a listener a server error becomes an uncaught exception. Listening
  // for it also means the caller, not the runtime, decides what a failed socket
  // costs: listen() rejects before startup, onError reports it afterwards.
  let listening = false;
  server.on("error", (error) => {
    console.error(JSON.stringify({ message: "Server error", error: error.message }));
    if (listening) options.onError?.(error);
  });

  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return void socket.destroy();
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  let closing: Promise<void> | undefined;
  return {
    store,
    listen: async (port = config.port, host) => {
      const bound = await listen(server, port, host);
      listening = true;
      return bound;
    },
    close: () => (closing ??= close(handler, server, store)),
  };
}

function failSafe(response: ServerResponse): void {
  try {
    if (response.writableEnded || response.destroyed) return;
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Internal server error" }));
  } catch {
    response.destroy();
  }
}

async function listen(server: Server, port: number, host: string | undefined): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : port;
}

async function close(handler: RelayHandler, server: Server, store: GrantStore): Promise<void> {
  handler.dispose();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // Keep-alive sockets that nobody is using would otherwise hold the close open
  // until their timeout expires, including sockets that go idle while draining.
  server.closeIdleConnections();
  const sweep = setInterval(() => server.closeIdleConnections(), 50);
  sweep.unref();
  await closed;
  clearInterval(sweep);
  store.close();
}
