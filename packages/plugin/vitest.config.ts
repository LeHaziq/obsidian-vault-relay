import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^obsidian$/, replacement: fileURLToPath(new URL("./test/obsidian.ts", import.meta.url)) },
      // Match the tsconfig path mapping so tests exercise protocol source
      // rather than a possibly stale dist build.
      { find: /^@vault-relay\/protocol$/, replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)) },
    ],
  },
});
