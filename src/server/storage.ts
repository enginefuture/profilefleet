import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserProfile } from "../core/types.js";

export interface ProfileStore {
  readonly profilesDir: string;
  initialize(): Promise<void>;
  list(): Promise<BrowserProfile[]>;
  get(id: string): Promise<BrowserProfile | null>;
  put(profile: BrowserProfile): Promise<void>;
  delete(id: string): Promise<void>;
  profileDir(id: string): string;
  userDataDir(id: string): string;
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export class FileProfileStore implements ProfileStore {
  readonly profilesDir: string;

  constructor(readonly homeDir: string) {
    this.profilesDir = join(homeDir, "profiles");
  }

  async initialize(): Promise<void> {
    await mkdir(this.profilesDir, { recursive: true });
    await chmod(this.homeDir, 0o700).catch(() => undefined);
  }

  profileDir(id: string): string {
    return join(this.profilesDir, id);
  }

  userDataDir(id: string): string {
    return join(this.profileDir(id), "user-data");
  }

  private profilePath(id: string): string {
    return join(this.profileDir(id), "profile.json");
  }

  async list(): Promise<BrowserProfile[]> {
    if (!existsSync(this.profilesDir)) return [];
    const entries = await readdir(this.profilesDir, { withFileTypes: true });
    const profiles = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.get(entry.name)),
    );
    return profiles
      .filter((profile): profile is BrowserProfile => profile !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(id: string): Promise<BrowserProfile | null> {
    try {
      return JSON.parse(await readFile(this.profilePath(id), "utf8")) as BrowserProfile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(profile: BrowserProfile): Promise<void> {
    await mkdir(this.userDataDir(profile.id), { recursive: true });
    await atomicJsonWrite(this.profilePath(profile.id), profile);
  }

  async delete(id: string): Promise<void> {
    await rm(this.profileDir(id), { recursive: true, force: true });
  }
}

export async function writeSecureText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}
