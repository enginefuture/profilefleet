import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FleetError } from "../core/errors.js";
import { FakeBrowserAdapter } from "../testing/index.js";
import { ProfileFleet } from "./fleet.js";
import { FileProfileStore } from "./storage.js";
import { readSessionLock } from "./lock.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup(options: { maxConcurrent?: number; idleTimeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const home = await mkdtemp(join(tmpdir(), "profilefleet-test-"));
  const adapter = new FakeBrowserAdapter();
  const fleet = new ProfileFleet({
    store: new FileProfileStore(home),
    adapters: [adapter],
    maxConcurrent: options.maxConcurrent ?? 1,
    idleTimeoutMs: options.idleTimeoutMs ?? 0,
    healthCheckIntervalMs: 0,
    portRange: [19_300, 19_399],
    env: options.env ?? {},
  });
  await fleet.initialize();
  cleanups.push(async () => { await fleet.close(); await rm(home, { recursive: true, force: true }); });
  return { fleet, adapter, home };
}

describe("ProfileFleet", () => {
  test("persists a deterministic profile and only exposes mutable updates", async () => {
    const { fleet } = await setup();
    const profile = await fleet.createProfile({
      id: "research",
      name: "Research",
      engine: "fake",
      fingerprintSeed: "fixed_seed",
      tags: ["zeta", "alpha", "alpha"],
    });
    expect(profile.tags).toEqual(["alpha", "zeta"]);
    expect((await fleet.getProfile("research")).fingerprintSeed).toBe("fixed_seed");
    const updated = await fleet.updateProfile("research", { name: "Research A", tags: ["ai"] });
    expect(updated.name).toBe("Research A");
    expect(updated.fingerprintSeed).toBe("fixed_seed");
  });

  test("enforces one exclusive lease and request idempotency", async () => {
    const { fleet } = await setup();
    await fleet.createProfile({ id: "one", name: "One", engine: "fake" });
    const first = await fleet.acquire({ profileId: "one", requestId: "request-one" });
    const repeated = await fleet.acquire({ profileId: "one", requestId: "request-one" });
    expect(repeated.id).toBe(first.id);
    await expect(fleet.acquire({ profileId: "one", requestId: "request-two" }))
      .rejects.toMatchObject({ code: "PROFILE_IN_USE" });
    expect(fleet.capacity()).toMatchObject({ active: 1, leased: 1, available: 0 });
  });

  test("reserves capacity without serializing independent launches", async () => {
    const { fleet } = await setup({ maxConcurrent: 2 });
    await fleet.createProfile({ id: "one", name: "One", engine: "fake" });
    await fleet.createProfile({ id: "two", name: "Two", engine: "fake" });
    await fleet.createProfile({ id: "three", name: "Three", engine: "fake" });
    const [first, second] = await Promise.all([
      fleet.acquire({ profileId: "one" }),
      fleet.acquire({ profileId: "two" }),
    ]);
    expect(first.profileId).not.toBe(second.profileId);
    await expect(fleet.acquire({ profileId: "three" }))
      .rejects.toMatchObject({ code: "CAPACITY_EXHAUSTED" });
  });

  test("releases and stops a session cleanly", async () => {
    const { fleet, adapter } = await setup();
    await fleet.createProfile({ id: "one", name: "One", engine: "fake" });
    const lease = await fleet.acquire({ profileId: "one" });
    expect(adapter.sessions.has("one")).toBe(true);
    await fleet.releaseLease(lease.id, { stop: true });
    expect(adapter.sessions.has("one")).toBe(false);
    expect(fleet.listSessions()).toHaveLength(0);
    expect(fleet.listLeases()).toHaveLength(0);
  });

  test("does not persist or reveal proxy secrets when launch cannot resolve them", async () => {
    const { fleet, home } = await setup({ env: {} });
    await fleet.createProfile({
      id: "proxied",
      name: "Proxied",
      engine: "fake",
      proxyUrlEnv: "PROFILEFLEET_PROXY_TEST",
    });
    await expect(fleet.acquire({ profileId: "proxied" }))
      .rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
    const text = await import("node:fs/promises").then((fs) => fs.readFile(join(home, "profiles/proxied/profile.json"), "utf8"));
    expect(text).toContain("PROFILEFLEET_PROXY_TEST");
    expect(text).not.toContain("user:pass");
  });

  test("refuses to delete an in-use profile", async () => {
    const { fleet } = await setup();
    await fleet.createProfile({ id: "one", name: "One", engine: "fake" });
    await fleet.acquire({ profileId: "one" });
    await expect(fleet.deleteProfile("one")).rejects.toBeInstanceOf(FleetError);
  });

  test("never removes a lock owned by another live daemon", async () => {
    const { fleet, home } = await setup();
    await fleet.createProfile({ id: "one", name: "One", engine: "fake" });
    const lease = await fleet.acquire({ profileId: "one" });
    const observer = new ProfileFleet({
      store: new FileProfileStore(home),
      adapters: [new FakeBrowserAdapter()],
      healthCheckIntervalMs: 0,
    });
    await observer.initialize();
    expect(observer.listSessions()[0]?.status).toBe("orphaned");
    await observer.close();
    expect(await readSessionLock(join(home, "profiles/one"))).not.toBeNull();
    await fleet.releaseLease(lease.id, { stop: true });
  });

  test("expires abandoned leases and closes their sessions", async () => {
    const { fleet } = await setup();
    await fleet.createProfile({ id: "expiring", name: "Expiring", engine: "fake" });
    vi.useFakeTimers();
    await fleet.acquire({ profileId: "expiring", ttlSeconds: 30 });
    await vi.advanceTimersByTimeAsync(31_000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fleet.listLeases()).toEqual([]);
    expect(fleet.listSessions()).toEqual([]);
  });

  test("adopts a reachable browser left by a dead daemon", async () => {
    const home = await mkdtemp(join(tmpdir(), "profilefleet-adopt-"));
    const store = new FileProfileStore(home);
    await store.initialize();
    const now = new Date().toISOString();
    await store.put({
      id: "adoptable",
      name: "Adoptable",
      engine: "fake",
      fingerprintSeed: "adopt_seed",
      locale: "en-US",
      timezone: "UTC",
      headless: true,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    const cdp = createServer((request, response) => {
      if (request.url === "/json/version") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${(cdp.address() as { port: number }).port}/devtools/browser/adoptable` }));
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => cdp.listen(0, "127.0.0.1", resolve));
    const address = cdp.address() as { port: number };
    await writeFile(join(store.profileDir("adoptable"), ".session.lock"), JSON.stringify({
      profileId: "adoptable",
      sessionId: "orphan-session",
      daemonPid: 2_147_483_647,
      browserPid: null,
      cdpPort: address.port,
      ownerToken: "previous-owner-token",
      createdAt: now,
    }));
    const fleet = new ProfileFleet({
      store,
      adapters: [new FakeBrowserAdapter()],
      idleTimeoutMs: 60_000,
      healthCheckIntervalMs: 0,
    });
    await fleet.initialize();
    expect(fleet.listSessions()).toMatchObject([{ id: "orphan-session", status: "running" }]);
    const lease = await fleet.acquire({ profileId: "adoptable" });
    expect(lease.sessionId).toBe("orphan-session");
    await fleet.releaseLease(lease.id, { stop: true });
    await new Promise<void>((resolve) => cdp.close(() => resolve()));
    await fleet.close();
    await rm(home, { recursive: true, force: true });
  });
});
