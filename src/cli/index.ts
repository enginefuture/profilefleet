#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ProfileFleetClient } from "../client/client.js";
import { CloakBrowserAdapter } from "../adapters/cloakbrowser.js";
import { initializeHome, loadConfig, readToken } from "../server/config.js";
import { startProfileFleetDaemon } from "../server/daemon.js";

const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function flag(name: string): boolean {
  return args.includes(name);
}

function print(value: unknown): void {
  if (flag("--json")) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.table(value);
}

function help(): void {
  console.log(`ProfileFleet — local fingerprint-browser control plane

Usage:
  profilefleet init
  profilefleet doctor [--install] [--json]
  profilefleet start [--ui]
  profilefleet profile create --name <name> [--id <id>] [--locale <locale>]
                              [--timezone <zone>] [--proxy-env <ENV>] [--headless]
  profilefleet profile list [--json]
  profilefleet profile delete <id>
  profilefleet session list [--json]
  profilefleet session stop <id> [--force]

Environment:
  PROFILEFLEET_HOME               Data directory (default ~/.profilefleet)
  PROFILEFLEET_PORT               Daemon port (default 47110)
  PROFILEFLEET_MAX_CONCURRENT     Concurrent browser limit (default 1)
  CLOAKBROWSER_LICENSE_KEY        Passed directly to CloakBrowser
`);
}

async function client(): Promise<ProfileFleetClient> {
  const config = await loadConfig();
  return new ProfileFleetClient({
    baseUrl: `http://${config.host}:${config.port}`,
    token: await readToken(config.homeDir),
  });
}

async function start(): Promise<void> {
  const withUi = flag("--ui");
  const sourceCandidate = resolve(import.meta.dirname, "../../dist/console");
  const packedCandidate = resolve(import.meta.dirname, "../console");
  const uiDir = withUi
    ? existsSync(packedCandidate) ? packedCandidate : sourceCandidate
    : undefined;
  const daemon = await startProfileFleetDaemon(uiDir ? { uiDir } : {});
  console.log(`ProfileFleet listening on ${daemon.url}`);
  console.log(`Data: ${daemon.config.homeDir}`);
  if (withUi) console.log(`Console: ${daemon.url}/#token=${daemon.config.token}`);
  const shutdown = async () => {
    console.log("Shutting down ProfileFleet…");
    await daemon.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function main(): Promise<void> {
  const [command, subject, action] = args;
  if (!command || command === "help" || flag("--help")) return help();
  if (command === "init") {
    const result = await initializeHome();
    print(`Initialized ProfileFleet at ${result.configPath}`);
    return;
  }
  if (command === "start") return start();
  if (command === "doctor") {
    await initializeHome();
    print([await new CloakBrowserAdapter().doctor({ install: flag("--install") })]);
    return;
  }
  const api = await client();
  if (command === "profile" && subject === "create") {
    const name = option("--name");
    if (!name) throw new Error("--name is required");
    const id = option("--id");
    const locale = option("--locale");
    const timezone = option("--timezone");
    const proxyUrlEnv = option("--proxy-env");
    print(await api.profiles.create({
      name,
      ...(id ? { id } : {}),
      ...(locale ? { locale } : {}),
      ...(timezone ? { timezone } : {}),
      ...(proxyUrlEnv ? { proxyUrlEnv } : {}),
      ...(flag("--headless") ? { headless: true } : {}),
    }));
    return;
  }
  if (command === "profile" && subject === "list") {
    print(await api.profiles.list());
    return;
  }
  if (command === "profile" && subject === "delete") {
    if (!action) throw new Error("profile id is required");
    await api.profiles.delete(action);
    print(`Deleted profile ${action}`);
    return;
  }
  if (command === "session" && subject === "list") {
    print(await api.sessions.list());
    return;
  }
  if (command === "session" && subject === "stop") {
    if (!action) throw new Error("session id is required");
    await api.sessions.stop(action, flag("--force"));
    print(`Stopped session ${action}`);
    return;
  }
  help();
  process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
