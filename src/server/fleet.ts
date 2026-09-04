import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type {
  AcquireLeaseInput,
  BrowserEngineAdapter,
  BrowserLease,
  BrowserProfile,
  BrowserSession,
  CreateProfileInput,
  EngineSessionHandle,
  FleetCapacity,
  FleetEvent,
  FleetEventType,
  ReleaseLeaseOptions,
  UpdateProfileInput,
} from "../core/types.js";
import { FleetError } from "../core/errors.js";
import {
  acquireLeaseSchema,
  createProfileSchema,
  updateProfileSchema,
} from "../core/schemas.js";
import {
  acquireSessionLock,
  forceReleaseSessionLock,
  listSessionLocks,
  processIsAlive,
  releaseSessionLock,
  updateSessionLock,
  type SessionLock,
} from "./lock.js";
import type { ProfileStore } from "./storage.js";

interface ManagedSession {
  public: BrowserSession;
  handle: EngineSessionHandle | null;
  lock: SessionLock;
  ownsLock: boolean;
  idleTimer?: NodeJS.Timeout;
  healthTimer?: NodeJS.Timeout;
}

interface ManagedLease {
  public: BrowserLease;
  timer: NodeJS.Timeout;
}

export interface FleetLogger {
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

export interface ProfileFleetOptions {
  store: ProfileStore;
  adapters: BrowserEngineAdapter[];
  maxConcurrent?: number;
  idleTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  portRange?: readonly [number, number];
  logger?: FleetLogger;
  env?: NodeJS.ProcessEnv;
}

const silentLogger: FleetLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function sanitizeError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  return message.replace(/([a-z]+:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

async function isPortOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function discoverCdpEndpoint(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    const body = await response.json() as { webSocketDebuggerUrl?: string };
    return body.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

export class ProfileFleet {
  readonly events = new EventEmitter();
  private readonly adapters = new Map<string, BrowserEngineAdapter>();
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly leases = new Map<string, ManagedLease>();
  private readonly requestLeases = new Map<string, string>();
  private readonly profileQueues = new Map<string, Promise<void>>();
  private readonly reservedPorts = new Set<number>();
  private readonly maxConcurrent: number;
  private readonly idleTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly portRange: readonly [number, number];
  private readonly logger: FleetLogger;
  private readonly env: NodeJS.ProcessEnv;
  private reservedCapacity = 0;
  private initialized = false;
  private closing = false;

  constructor(private readonly options: ProfileFleetOptions) {
    for (const adapter of options.adapters) {
      if (this.adapters.has(adapter.id)) {
        throw new FleetError("CONFLICT", `Duplicate engine adapter "${adapter.id}"`);
      }
      this.adapters.set(adapter.id, adapter);
    }
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
    this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? 60_000);
    this.healthCheckIntervalMs = Math.max(0, options.healthCheckIntervalMs ?? 5_000);
    this.portRange = options.portRange ?? [9300, 9999];
    this.logger = options.logger ?? silentLogger;
    this.env = options.env ?? process.env;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.options.store.initialize();
    await this.reconcileLocks();
    this.initialized = true;
  }

  private assertReady(): void {
    if (!this.initialized) throw new FleetError("CONFLICT", "ProfileFleet is not initialized");
    if (this.closing) throw new FleetError("CONFLICT", "ProfileFleet is shutting down");
  }

  private emitEvent(
    type: FleetEventType,
    refs: Pick<FleetEvent, "profileId" | "sessionId" | "leaseId" | "detail"> = {},
  ): FleetEvent {
    const event: FleetEvent = {
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      ...refs,
    };
    this.events.emit("event", event);
    return event;
  }

  subscribe(listener: (event: FleetEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  private async withProfileOperation<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.profileQueues.get(profileId) ?? Promise.resolve();
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.profileQueues.set(profileId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.profileQueues.get(profileId) === current) this.profileQueues.delete(profileId);
    }
  }

  async listProfiles(): Promise<BrowserProfile[]> {
    this.assertReady();
    return this.options.store.list();
  }

  async getProfile(id: string): Promise<BrowserProfile> {
    this.assertReady();
    const profile = await this.options.store.get(id);
    if (!profile) throw new FleetError("NOT_FOUND", `Profile "${id}" was not found`);
    return profile;
  }

  async createProfile(input: CreateProfileInput): Promise<BrowserProfile> {
    this.assertReady();
    const parsed = createProfileSchema.parse(input);
    if (!this.adapters.has(parsed.engine)) {
      throw new FleetError("ENGINE_UNAVAILABLE", `Engine "${parsed.engine}" is not registered`);
    }
    const id = parsed.id ?? `profile-${randomUUID().slice(0, 8)}`;
    return this.withProfileOperation(id, async () => {
      if (await this.options.store.get(id)) {
        throw new FleetError("CONFLICT", `Profile "${id}" already exists`);
      }
      const resolved = Intl.DateTimeFormat().resolvedOptions();
      const now = new Date().toISOString();
      const profile: BrowserProfile = {
        id,
        name: parsed.name,
        engine: parsed.engine,
        fingerprintSeed: parsed.fingerprintSeed ?? randomBytes(24).toString("base64url"),
        locale: parsed.locale ?? resolved.locale ?? "en-US",
        timezone: parsed.timezone ?? resolved.timeZone ?? "UTC",
        headless: parsed.headless ?? false,
        tags: [...new Set(parsed.tags ?? [])].sort(),
        createdAt: now,
        updatedAt: now,
        ...(parsed.proxyUrlEnv ? { proxyUrlEnv: parsed.proxyUrlEnv } : {}),
      };
      await this.options.store.put(profile);
      this.emitEvent("profile.created", { profileId: id });
      return profile;
    });
  }

  async updateProfile(id: string, input: UpdateProfileInput): Promise<BrowserProfile> {
    this.assertReady();
    const parsed = updateProfileSchema.parse(input);
    return this.withProfileOperation(id, async () => {
      const profile = await this.getProfile(id);
      const next: BrowserProfile = {
        ...profile,
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.tags !== undefined ? { tags: [...new Set(parsed.tags)].sort() } : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.options.store.put(next);
      this.emitEvent("profile.updated", { profileId: id });
      return next;
    });
  }

  async deleteProfile(id: string): Promise<void> {
    this.assertReady();
    await this.withProfileOperation(id, async () => {
      await this.getProfile(id);
      if (this.sessionForProfile(id) || this.leaseForProfile(id)) {
        throw new FleetError("PROFILE_IN_USE", `Profile "${id}" has an active session or lease`);
      }
      await this.options.store.delete(id);
      this.emitEvent("profile.deleted", { profileId: id });
    });
  }

  listSessions(): BrowserSession[] {
    this.assertReady();
    return [...this.sessions.values()].map((entry) => ({ ...entry.public }));
  }

  listLeases(): BrowserLease[] {
    this.assertReady();
    return [...this.leases.values()].map((entry) => ({ ...entry.public }));
  }

  capacity(): FleetCapacity {
    const values = [...this.sessions.values()];
    const active = values.filter((entry) => ["starting", "running", "stopping"].includes(entry.public.status)).length;
    const orphaned = values.filter((entry) => entry.public.status === "orphaned").length;
    return {
      maximum: this.maxConcurrent,
      active,
      leased: this.leases.size,
      orphaned,
      available: Math.max(0, this.maxConcurrent - active - orphaned - this.reservedCapacity),
    };
  }

  async acquire(input: AcquireLeaseInput): Promise<BrowserLease> {
    this.assertReady();
    const parsed = acquireLeaseSchema.parse(input);
    if (parsed.requestId) {
      const leaseId = this.requestLeases.get(parsed.requestId);
      const existing = leaseId ? this.leases.get(leaseId) : undefined;
      if (existing && new Date(existing.public.expiresAt).getTime() > Date.now()) {
        return { ...existing.public };
      }
    }
    return this.withProfileOperation(parsed.profileId, async () => {
      const currentLease = this.leaseForProfile(parsed.profileId);
      if (currentLease) {
        if (parsed.requestId && currentLease.public.requestId === parsed.requestId) {
          return { ...currentLease.public };
        }
        throw new FleetError("PROFILE_IN_USE", `Profile "${parsed.profileId}" already has an active lease`);
      }
      const profile = await this.getProfile(parsed.profileId);
      let session = this.sessionForProfile(profile.id);
      if (!session || session.public.status !== "running" || !session.handle) {
        session = await this.launchProfile(profile, parsed.initialUrl);
      }
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        delete session.idleTimer;
      }
      const lease: BrowserLease = {
        id: randomUUID(),
        sessionId: session.public.id,
        profileId: profile.id,
        owner: parsed.owner,
        expiresAt: new Date(Date.now() + parsed.ttlSeconds * 1_000).toISOString(),
        cdpEndpoint: session.public.cdpEndpoint!,
        ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
      };
      const timer = this.createLeaseTimer(lease);
      this.leases.set(lease.id, { public: lease, timer });
      if (lease.requestId) this.requestLeases.set(lease.requestId, lease.id);
      this.emitEvent("lease.acquired", {
        profileId: profile.id,
        sessionId: session.public.id,
        leaseId: lease.id,
        detail: { owner: lease.owner, expiresAt: lease.expiresAt },
      });
      return { ...lease };
    });
  }

  async renewLease(id: string, ttlSeconds = 600): Promise<BrowserLease> {
    this.assertReady();
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 86_400) {
      throw new FleetError("VALIDATION_ERROR", "ttlSeconds must be between 30 and 86400");
    }
    const managed = this.leases.get(id);
    if (!managed) throw new FleetError("NOT_FOUND", `Lease "${id}" was not found`);
    clearTimeout(managed.timer);
    managed.public.expiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString();
    managed.timer = this.createLeaseTimer(managed.public);
    this.emitEvent("lease.renewed", {
      profileId: managed.public.profileId,
      sessionId: managed.public.sessionId,
      leaseId: id,
      detail: { expiresAt: managed.public.expiresAt },
    });
    return { ...managed.public };
  }

  async releaseLease(id: string, options: ReleaseLeaseOptions = {}): Promise<void> {
    this.assertReady();
    const managed = this.leases.get(id);
    if (!managed) return;
    await this.withProfileOperation(managed.public.profileId, async () => {
      this.removeLease(managed, "lease.released");
      const session = this.sessions.get(managed.public.sessionId);
      if (!session) return;
      if (options.stop || this.idleTimeoutMs === 0) {
        await this.stopManagedSession(session);
      } else {
        this.scheduleIdleStop(session);
      }
    });
  }

  async stopSession(id: string, force = false): Promise<void> {
    this.assertReady();
    const session = this.sessions.get(id);
    if (!session) return;
    await this.withProfileOperation(session.public.profileId, async () => {
      if (!session.ownsLock) {
        throw new FleetError(
          "PROFILE_IN_USE",
          `Session "${id}" is managed by another live daemon`,
        );
      }
      const lease = this.leaseForProfile(session.public.profileId);
      if (lease && !force) {
        throw new FleetError("PROFILE_IN_USE", `Session "${id}" has an active lease`);
      }
      if (lease) this.removeLease(lease, "lease.released");
      await this.stopManagedSession(session);
    });
  }

  async doctor(options?: { install?: boolean }): Promise<Awaited<ReturnType<BrowserEngineAdapter["doctor"]>>[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.doctor(options)));
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const lease of this.leases.values()) {
      clearTimeout(lease.timer);
    }
    this.leases.clear();
    this.requestLeases.clear();
    await Promise.allSettled([...this.sessions.values()].map((session) => this.stopManagedSession(session)));
  }

  private reserveCapacity(): void {
    if (this.capacity().available <= 0) {
      throw new FleetError("CAPACITY_EXHAUSTED", `Browser capacity exhausted (${this.maxConcurrent})`);
    }
    this.reservedCapacity += 1;
  }

  private async allocatePort(): Promise<number> {
    for (let port = this.portRange[0]; port <= this.portRange[1]; port += 1) {
      if (this.reservedPorts.has(port)) continue;
      if (await isPortOpen(port)) continue;
      this.reservedPorts.add(port);
      return port;
    }
    throw new FleetError("CAPACITY_EXHAUSTED", `No CDP port available in ${this.portRange.join("-")}`);
  }

  private async launchProfile(profile: BrowserProfile, initialUrl?: string): Promise<ManagedSession> {
    const adapter = this.adapters.get(profile.engine);
    if (!adapter) throw new FleetError("ENGINE_UNAVAILABLE", `Engine "${profile.engine}" is unavailable`);
    this.reserveCapacity();
    let port: number | undefined;
    let lock: SessionLock | undefined;
    let session: ManagedSession | undefined;
    const proxyUrl = profile.proxyUrlEnv ? this.env[profile.proxyUrlEnv] : undefined;
    if (profile.proxyUrlEnv && !proxyUrl) {
      this.reservedCapacity -= 1;
      throw new FleetError("ENGINE_UNAVAILABLE", `Proxy environment variable "${profile.proxyUrlEnv}" is not set`);
    }
    try {
      port = await this.allocatePort();
      const sessionId = randomUUID();
      lock = await acquireSessionLock(this.options.store.profileDir(profile.id), {
        profileId: profile.id,
        sessionId,
        cdpPort: port,
      });
      const now = new Date().toISOString();
      session = {
        public: {
          id: sessionId,
          profileId: profile.id,
          engine: profile.engine,
          status: "starting",
          pid: null,
          cdpPort: port,
          cdpEndpoint: null,
          startedAt: now,
          lastSeenAt: now,
        },
        handle: null,
        lock,
        ownsLock: true,
      };
      this.sessions.set(sessionId, session);
      this.reservedCapacity -= 1;
      this.emitEvent("session.starting", { profileId: profile.id, sessionId });
      const handle = await adapter.launch({
        profile,
        profileDir: this.options.store.userDataDir(profile.id),
        cdpPort: port,
        ...(proxyUrl ? { proxyUrl } : {}),
        ...(initialUrl ? { initialUrl } : {}),
      });
      session.handle = handle;
      session.lock = await updateSessionLock(this.options.store.profileDir(profile.id), lock, {
        browserPid: handle.pid,
        daemonPid: process.pid,
      });
      session.public = {
        ...session.public,
        status: "running",
        pid: handle.pid,
        cdpEndpoint: handle.cdpEndpoint,
        lastSeenAt: new Date().toISOString(),
      };
      if (!profile.firstLaunchedAt) {
        const launched = { ...profile, firstLaunchedAt: now, updatedAt: now };
        await this.options.store.put(launched);
      }
      this.startHealthMonitor(session);
      this.emitEvent("session.running", { profileId: profile.id, sessionId });
      this.logger.info("Browser session started", { profileId: profile.id, sessionId, cdpPort: port });
      return session;
    } catch (error) {
      if (this.reservedCapacity > 0 && !session) this.reservedCapacity -= 1;
      if (port !== undefined) this.reservedPorts.delete(port);
      if (lock) await releaseSessionLock(this.options.store.profileDir(profile.id), lock);
      const message = sanitizeError(error, proxyUrl ? [proxyUrl] : []);
      if (session) {
        await session.handle?.close().catch(() => undefined);
        session.public = { ...session.public, status: "error", error: message };
        this.sessions.delete(session.public.id);
        this.emitEvent("session.error", {
          profileId: profile.id,
          sessionId: session.public.id,
          detail: { message },
        });
      }
      this.logger.error("Browser launch failed", { profileId: profile.id, message });
      if (error instanceof FleetError) throw error;
      throw new FleetError("LAUNCH_FAILED", message, { cause: error });
    }
  }

  private createLeaseTimer(lease: BrowserLease): NodeJS.Timeout {
    const delay = Math.max(1, new Date(lease.expiresAt).getTime() - Date.now());
    const timer = setTimeout(() => {
      void this.expireLease(lease.id);
    }, delay);
    timer.unref();
    return timer;
  }

  private async expireLease(id: string): Promise<void> {
    const lease = this.leases.get(id);
    if (!lease) return;
    await this.withProfileOperation(lease.public.profileId, async () => {
      const current = this.leases.get(id);
      if (!current) return;
      if (new Date(current.public.expiresAt).getTime() > Date.now()) return;
      this.removeLease(current, "lease.expired");
      const session = this.sessions.get(current.public.sessionId);
      if (session) this.scheduleIdleStop(session);
    });
  }

  private removeLease(lease: ManagedLease, eventType: "lease.released" | "lease.expired"): void {
    clearTimeout(lease.timer);
    this.leases.delete(lease.public.id);
    if (lease.public.requestId) this.requestLeases.delete(lease.public.requestId);
    this.emitEvent(eventType, {
      profileId: lease.public.profileId,
      sessionId: lease.public.sessionId,
      leaseId: lease.public.id,
    });
  }

  private scheduleIdleStop(session: ManagedSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void this.withProfileOperation(session.public.profileId, async () => {
        if (!this.leaseForProfile(session.public.profileId)) await this.stopManagedSession(session);
      });
    }, this.idleTimeoutMs);
    session.idleTimer.unref();
  }

  private startHealthMonitor(session: ManagedSession): void {
    if (this.healthCheckIntervalMs === 0 || !session.handle) return;
    session.healthTimer = setInterval(() => {
      void this.checkSessionHealth(session);
    }, this.healthCheckIntervalMs);
    session.healthTimer.unref();
  }

  private async checkSessionHealth(session: ManagedSession): Promise<void> {
    if (!session.handle || session.public.status !== "running") return;
    const alive = await session.handle.isAlive().catch(() => false);
    if (alive) {
      session.public.lastSeenAt = new Date().toISOString();
      return;
    }
    await this.withProfileOperation(session.public.profileId, async () => {
      if (!this.sessions.has(session.public.id)) return;
      const lease = this.leaseForProfile(session.public.profileId);
      if (lease) this.removeLease(lease, "lease.expired");
      await this.finishStoppedSession(session, "Browser process exited unexpectedly");
    });
  }

  private async stopManagedSession(session: ManagedSession): Promise<void> {
    if (!this.sessions.has(session.public.id)) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.healthTimer) clearInterval(session.healthTimer);
    session.public.status = "stopping";
    this.emitEvent("session.stopping", {
      profileId: session.public.profileId,
      sessionId: session.public.id,
    });
    await session.handle?.close().catch((error) => {
      this.logger.warn("Browser close returned an error", {
        profileId: session.public.profileId,
        message: sanitizeError(error),
      });
    });
    await this.finishStoppedSession(session);
  }

  private async finishStoppedSession(session: ManagedSession, reason?: string): Promise<void> {
    if (session.healthTimer) clearInterval(session.healthTimer);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.ownsLock) {
      await releaseSessionLock(this.options.store.profileDir(session.public.profileId), session.lock);
    }
    this.reservedPorts.delete(session.public.cdpPort);
    this.sessions.delete(session.public.id);
    session.public.status = reason ? "error" : "stopped";
    this.emitEvent(reason ? "session.error" : "session.stopped", {
      profileId: session.public.profileId,
      sessionId: session.public.id,
      ...(reason ? { detail: { message: reason } } : {}),
    });
  }

  private sessionForProfile(profileId: string): ManagedSession | undefined {
    return [...this.sessions.values()].find((entry) => entry.public.profileId === profileId);
  }

  private leaseForProfile(profileId: string): ManagedLease | undefined {
    return [...this.leases.values()].find((entry) => entry.public.profileId === profileId);
  }

  private async reconcileLocks(): Promise<void> {
    const locks = await listSessionLocks((this.options.store as { profilesDir?: string }).profilesDir ?? "");
    for (const lock of locks) {
      this.reservedPorts.add(lock.cdpPort);
      const profile = await this.options.store.get(lock.profileId);
      if (!profile) {
        if (!processIsAlive(lock.daemonPid) && !(await isPortOpen(lock.cdpPort))) {
          await forceReleaseSessionLock(this.options.store.profileDir(lock.profileId));
          this.reservedPorts.delete(lock.cdpPort);
        }
        continue;
      }
      if (processIsAlive(lock.daemonPid)) {
        const now = new Date().toISOString();
        this.sessions.set(lock.sessionId, {
          public: {
            id: lock.sessionId,
            profileId: profile.id,
            engine: profile.engine,
            status: "orphaned",
            pid: lock.browserPid,
            cdpPort: lock.cdpPort,
            cdpEndpoint: null,
            startedAt: lock.createdAt,
            lastSeenAt: now,
            error: `Managed by live daemon PID ${lock.daemonPid}`,
          },
          handle: null,
          lock,
          ownsLock: false,
        });
        this.emitEvent("session.orphaned", { profileId: profile.id, sessionId: lock.sessionId });
        continue;
      }
      const endpoint = await discoverCdpEndpoint(lock.cdpPort);
      const adapter = this.adapters.get(profile.engine);
      if (!endpoint || !adapter?.adopt) {
        await forceReleaseSessionLock(this.options.store.profileDir(profile.id));
        this.reservedPorts.delete(lock.cdpPort);
        continue;
      }
      try {
        const handle = await adapter.adopt({
          profile,
          profileDir: this.options.store.userDataDir(profile.id),
          cdpPort: lock.cdpPort,
          cdpEndpoint: endpoint,
          browserPid: lock.browserPid,
        });
        const adoptedLock = await updateSessionLock(this.options.store.profileDir(profile.id), lock, {
          daemonPid: process.pid,
          browserPid: handle.pid,
        });
        const now = new Date().toISOString();
        const session: ManagedSession = {
          public: {
            id: lock.sessionId,
            profileId: profile.id,
            engine: profile.engine,
            status: "running",
            pid: handle.pid,
            cdpPort: lock.cdpPort,
            cdpEndpoint: handle.cdpEndpoint,
            startedAt: lock.createdAt,
            lastSeenAt: now,
          },
          handle,
          lock: adoptedLock,
          ownsLock: true,
        };
        this.sessions.set(lock.sessionId, session);
        this.startHealthMonitor(session);
        this.scheduleIdleStop(session);
        this.emitEvent("session.running", {
          profileId: profile.id,
          sessionId: lock.sessionId,
          detail: { adopted: true },
        });
      } catch (error) {
        this.logger.warn("Unable to adopt orphaned browser", {
          profileId: profile.id,
          message: sanitizeError(error),
        });
        await forceReleaseSessionLock(this.options.store.profileDir(profile.id));
        this.reservedPorts.delete(lock.cdpPort);
      }
    }
  }
}
