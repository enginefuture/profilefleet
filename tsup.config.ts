import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "client/index": "src/client/index.ts",
    "server/index": "src/server/index.ts",
    "react/index": "src/react/index.tsx",
    "adapters/cloakbrowser": "src/adapters/cloakbrowser.ts",
    "playwright/index": "src/playwright/index.ts",
    "testing/index": "src/testing/index.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: "node22",
  external: ["react", "react-dom", "cloakbrowser", "playwright-core"],
  loader: {
    ".css": "css",
  },
});
