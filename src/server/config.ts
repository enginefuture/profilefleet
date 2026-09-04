import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeSecureText } from "./storage.js";

export interface ProfileFleetConfig {
  homeDir: string;
  host: "127.0.0.1";
  port: number;
  maxConcurrent: number;
  idleTimeoutMs: number;
  healthCheckIntervalMs: number;
  allowedOrigins: string[];
  token: string;
}

interface PersistedConfig {
  host?: string;
  port?: number;
  maxConcurrent?: number;
  idleTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  allowedOrigins?: string[];
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}, received ${String(value)}`);
  }
  return parsed;
}

export function defaultHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PROFILEFLEET_HOME || join(homedir(), ".profilefleet");
}

export async function initializeHome(homeDir = defaultHomeDir()): Promise<{ token: string; configPath: string }> {
  await mkdir(homeDir, { recursive: true });
  const configPath = join(homeDir, "config.json");
  const tokenPath = join(homeDir, "token");
  if (!existsSync(configPath)) {
    const defaults: PersistedConfig = {
      host: "127.0.0.1",
      port: 47_110,
      maxConcurrent: 1,
      idleTimeoutMs: 60_000,
      healthCheckIntervalMs: 5_000,
      allowedOrigins: [],
    };
    await writeFile(configPath, `${JSON.stringify(defaults, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  let token: string;
  if (existsSync(tokenPath)) {
    token = (await readFile(tokenPath, "utf8")).trim();
  } else {
    token = randomBytes(32).toString("base64url");
    await writeSecureText(tokenPath, `${token}\n`);
  }
  return { token, configPath };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ProfileFleetConfig> {
  const homeDir = defaultHomeDir(env);
  const { token: storedToken, configPath } = await initializeHome(homeDir);
  const persisted = JSON.parse(await readFile(configPath, "utf8")) as PersistedConfig;
  const host = env.PROFILEFLEET_HOST ?? persisted.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("ProfileFleet v0.1 only supports loopback host 127.0.0.1");
  }
  return {
    homeDir,
    host,
    port: integer(env.PROFILEFLEET_PORT ?? persisted.port, 47_110, 1, 65_535),
    maxConcurrent: integer(env.PROFILEFLEET_MAX_CONCURRENT ?? persisted.maxConcurrent, 1, 1, 1_000),
    idleTimeoutMs: integer(env.PROFILEFLEET_IDLE_TIMEOUT_MS ?? persisted.idleTimeoutMs, 60_000, 0, 86_400_000),
    healthCheckIntervalMs: integer(
      env.PROFILEFLEET_HEALTH_INTERVAL_MS ?? persisted.healthCheckIntervalMs,
      5_000,
      0,
      3_600_000,
    ),
    allowedOrigins: (persisted.allowedOrigins ?? []).map((origin) => new URL(origin).origin),
    token: env.PROFILEFLEET_TOKEN || storedToken,
  };
}

export async function readToken(homeDir = defaultHomeDir()): Promise<string> {
  const { token } = await initializeHome(homeDir);
  return token;
}
