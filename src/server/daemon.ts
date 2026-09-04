import { readFile, stat } from "node:fs/promises";
import { once } from "node:events";
import { extname, join, resolve, sep } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { CloakBrowserAdapter } from "../adapters/cloakbrowser.js";
import type { BrowserEngineAdapter } from "../core/types.js";
import { loadConfig, type ProfileFleetConfig } from "./config.js";
import { ProfileFleet, type FleetLogger } from "./fleet.js";
import { createProfileFleetApp } from "./http.js";
import { FileProfileStore } from "./storage.js";

export interface StartDaemonOptions {
  config?: ProfileFleetConfig;
  adapters?: BrowserEngineAdapter[];
  uiDir?: string;
  logger?: FleetLogger;
}

export interface RunningDaemon {
  fleet: ProfileFleet;
  config: ProfileFleetConfig;
  url: string;
  server: ServerType;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function attachConsole(app: ReturnType<typeof createProfileFleetApp>, uiDir: string): void {
  const uiRoot = resolve(uiDir);
  const securityHeaders = {
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/v1/")) return next();
    const relative = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\//, "");
    const candidate = resolve(uiRoot, relative);
    const safePath = candidate === uiRoot || candidate.startsWith(`${uiRoot}${sep}`)
      ? candidate
      : join(uiRoot, "index.html");
    try {
      const info = await stat(safePath);
      if (!info.isFile()) throw new Error("not a file");
      return c.body(await readFile(safePath), 200, {
        "Content-Type": MIME[extname(safePath)] ?? "application/octet-stream",
        "Cache-Control": safePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
        ...securityHeaders,
      });
    } catch {
      try {
        return c.body(await readFile(join(uiDir, "index.html")), 200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          ...securityHeaders,
        });
      } catch {
        return c.text("ProfileFleet console was not included in this build", 404);
      }
    }
  });
}

export async function startProfileFleetDaemon(options: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const config = options.config ?? await loadConfig();
  const logger = options.logger ?? {
    info: (message: string, detail?: Record<string, unknown>) => console.log(JSON.stringify({ level: "info", message, ...detail })),
    warn: (message: string, detail?: Record<string, unknown>) => console.warn(JSON.stringify({ level: "warn", message, ...detail })),
    error: (message: string, detail?: Record<string, unknown>) => console.error(JSON.stringify({ level: "error", message, ...detail })),
  };
  const fleet = new ProfileFleet({
    store: new FileProfileStore(config.homeDir),
    adapters: options.adapters ?? [new CloakBrowserAdapter()],
    maxConcurrent: config.maxConcurrent,
    idleTimeoutMs: config.idleTimeoutMs,
    healthCheckIntervalMs: config.healthCheckIntervalMs,
    logger,
  });
  await fleet.initialize();
  const app = createProfileFleetApp({
    fleet,
    token: config.token,
    allowedOrigins: config.allowedOrigins,
  });
  if (options.uiDir) attachConsole(app, options.uiDir);
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : config.port;
  return {
    fleet,
    config,
    url: `http://${config.host}:${actualPort}`,
    server,
    close: async () => {
      await fleet.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
