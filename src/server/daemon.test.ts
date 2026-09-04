import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ProfileFleetClient } from "../client/client.js";
import { FakeBrowserAdapter } from "../testing/index.js";
import { startProfileFleetDaemon, type RunningDaemon } from "./daemon.js";

describe("ProfileFleet daemon", () => {
  let daemon: RunningDaemon | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (daemon) await daemon.close();
    if (home) await rm(home, { recursive: true, force: true });
  });

  test("serves a complete client lifecycle over TCP", async () => {
    home = await mkdtemp(join(tmpdir(), "profilefleet-daemon-"));
    daemon = await startProfileFleetDaemon({
      config: {
        homeDir: home,
        host: "127.0.0.1",
        port: 0,
        maxConcurrent: 1,
        idleTimeoutMs: 0,
        healthCheckIntervalMs: 0,
        allowedOrigins: [],
        token: "daemon-test-token",
      },
      adapters: [new FakeBrowserAdapter()],
    });
    const client = new ProfileFleetClient({ baseUrl: daemon.url, token: daemon.config.token });
    const profile = await client.profiles.create({ id: "integration", name: "Integration", engine: "fake" });
    const lease = await client.leases.acquire({ profileId: profile.id, owner: "test" });
    expect(lease.cdpEndpoint).toContain("devtools/browser/fake-integration");
    expect(await client.capacity.get()).toMatchObject({ active: 1, leased: 1 });
    await client.leases.release(lease.id, { stop: true });
    expect(await client.sessions.list()).toEqual([]);
  });
});
