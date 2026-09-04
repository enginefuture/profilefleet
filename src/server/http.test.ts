import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeBrowserAdapter } from "../testing/index.js";
import { ProfileFleet } from "./fleet.js";
import { createProfileFleetApp } from "./http.js";
import { FileProfileStore } from "./storage.js";

describe("ProfileFleet HTTP API", () => {
  let home: string;
  let fleet: ProfileFleet;
  const token = "test-token";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "profilefleet-http-"));
    fleet = new ProfileFleet({
      store: new FileProfileStore(home),
      adapters: [new FakeBrowserAdapter()],
      idleTimeoutMs: 0,
      healthCheckIntervalMs: 0,
      portRange: [19_400, 19_499],
    });
    await fleet.initialize();
  });

  afterEach(async () => {
    await fleet.close();
    await rm(home, { recursive: true, force: true });
  });

  test("keeps health public and protects management routes", async () => {
    const app = createProfileFleetApp({ fleet, token });
    expect((await app.request("/v1/health")).status).toBe(200);
    const response = await app.request("/v1/profiles");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  test("creates profiles and rejects immutable fields on patch", async () => {
    const app = createProfileFleetApp({ fleet, token });
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const created = await app.request("/v1/profiles", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "alpha", name: "Alpha", engine: "fake" }),
    });
    expect(created.status).toBe(201);
    const patched = await app.request("/v1/profiles/alpha", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fingerprintSeed: "changed" }),
    });
    expect(patched.status).toBe(400);
  });

  test("allows same-origin console requests but rejects unknown origins", async () => {
    const app = createProfileFleetApp({ fleet, token, allowedOrigins: [] });
    const accepted = await app.request("http://127.0.0.1:47110/v1/capacity", {
      headers: { Authorization: `Bearer ${token}`, Origin: "http://127.0.0.1:47110" },
    });
    expect(accepted.status).toBe(200);
    const rejected = await app.request("http://127.0.0.1:47110/v1/capacity", {
      headers: { Authorization: `Bearer ${token}`, Origin: "https://example.com" },
    });
    expect(rejected.status).toBe(403);
  });
});
