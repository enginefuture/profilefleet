import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FleetError } from "../core/errors.js";

const LOCK_FILE = ".session.lock";

export interface SessionLock {
  profileId: string;
  sessionId: string;
  daemonPid: number;
  browserPid: number | null;
  cdpPort: number;
  ownerToken: string;
  createdAt: string;
}

export function processIsAlive(pid: number | null): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}

export function lockPath(profileDir: string): string {
  return join(profileDir, LOCK_FILE);
}

export async function readSessionLock(profileDir: string): Promise<SessionLock | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath(profileDir), "utf8")) as Partial<SessionLock>;
    if (
      typeof parsed.profileId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      !Number.isSafeInteger(parsed.daemonPid) ||
      !Number.isSafeInteger(parsed.cdpPort) ||
      typeof parsed.ownerToken !== "string"
    ) {
      return null;
    }
    return parsed as SessionLock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function acquireSessionLock(
  profileDir: string,
  input: Pick<SessionLock, "profileId" | "sessionId" | "cdpPort">,
): Promise<SessionLock> {
  await mkdir(profileDir, { recursive: true });
  const existing = await readSessionLock(profileDir);
  if (existing) {
    throw new FleetError(
      "PROFILE_IN_USE",
      `Profile "${input.profileId}" is locked by daemon PID ${existing.daemonPid}`,
    );
  }
  if (existsSync(lockPath(profileDir))) {
    await unlink(lockPath(profileDir)).catch(() => undefined);
  }
  const lock: SessionLock = {
    ...input,
    daemonPid: process.pid,
    browserPid: null,
    ownerToken: randomBytes(24).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  await writeFile(lockPath(profileDir), `${JSON.stringify(lock, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return lock;
}

export async function updateSessionLock(
  profileDir: string,
  owner: SessionLock,
  updates: Pick<SessionLock, "browserPid" | "daemonPid">,
): Promise<SessionLock> {
  const current = await readSessionLock(profileDir);
  if (!current || current.ownerToken !== owner.ownerToken) {
    throw new FleetError("CONFLICT", `Profile "${owner.profileId}" lock ownership changed`);
  }
  const next = { ...current, ...updates };
  await writeFile(lockPath(profileDir), `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return next;
}

export async function releaseSessionLock(profileDir: string, owner: SessionLock): Promise<void> {
  const current = await readSessionLock(profileDir);
  if (current?.ownerToken !== owner.ownerToken) return;
  await unlink(lockPath(profileDir)).catch(() => undefined);
}

export async function forceReleaseSessionLock(profileDir: string): Promise<void> {
  await unlink(lockPath(profileDir)).catch(() => undefined);
}

export async function listSessionLocks(profilesDir: string): Promise<SessionLock[]> {
  if (!existsSync(profilesDir)) return [];
  const entries = await readdir(profilesDir, { withFileTypes: true });
  const locks = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readSessionLock(join(profilesDir, entry.name))),
  );
  return locks.filter((lock): lock is SessionLock => lock !== null);
}
