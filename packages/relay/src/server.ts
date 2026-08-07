import { loadConfig } from "./config.js";
import { createRelay } from "./relay.js";

const config = loadConfig();
const relay = createRelay(config);

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ message: "Unhandled rejection", error: reason instanceof Error ? reason.message : String(reason) }));
});

process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({ message: "Uncaught exception", error: error.message }));
  void shutdown(1);
});

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

async function shutdown(code: number): Promise<void> {
  setTimeout(() => process.exit(code || 1), 10_000).unref();
  await relay.close();
  process.exit(code);
}

try {
  await relay.listen(config.port);
  console.info(`Vault Relay OAuth service listening on port ${config.port}`);
} catch {
  // createRelay already logged the failure on the server's error event.
  process.exitCode = 1;
  await relay.close();
}
