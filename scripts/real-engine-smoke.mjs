import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloakBrowserAdapter } from "../dist/adapters/cloakbrowser.js";
import { connectPlaywright } from "../dist/playwright/index.js";
import { ProfileFleet } from "../dist/server/index.js";
import { FileProfileStore } from "../dist/server/index.js";

if (process.env.PROFILEFLEET_REAL_ENGINE !== "1") {
  console.log("Skipped: set PROFILEFLEET_REAL_ENGINE=1 to run the real-engine smoke test");
  process.exit(0);
}

const home = await mkdtemp(join(tmpdir(), "profilefleet-real-"));
const originServer = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<!doctype html><title>ProfileFleet smoke</title><main>ok</main>");
});
await new Promise((resolve) => originServer.listen(0, "127.0.0.1", resolve));
const address = originServer.address();
if (!address || typeof address === "string") throw new Error("Unable to allocate smoke origin port");
const origin = `http://127.0.0.1:${address.port}`;

const fleet = new ProfileFleet({
  store: new FileProfileStore(home),
  adapters: [new CloakBrowserAdapter()],
  maxConcurrent: 1,
  idleTimeoutMs: 0,
  healthCheckIntervalMs: 1_000,
  portRange: [19_500, 19_520],
});

try {
  await fleet.initialize();
  const profile = await fleet.createProfile({
    id: "real-smoke",
    name: "Real smoke",
    headless: true,
  });
  const first = await fleet.acquire({ profileId: profile.id, owner: "real-smoke", initialUrl: origin });
  const firstBrowser = await connectPlaywright(first);
  const firstContext = firstBrowser.contexts()[0];
  const firstPage = firstContext.pages()[0] ?? await firstContext.newPage();
  await firstPage.evaluate(() => localStorage.setItem("profilefleet-smoke", "persisted"));
  await fleet.releaseLease(first.id, { stop: true });

  const second = await fleet.acquire({ profileId: profile.id, owner: "real-smoke", initialUrl: origin });
  const secondBrowser = await connectPlaywright(second);
  const secondContext = secondBrowser.contexts()[0];
  const secondPage = secondContext.pages()[0] ?? await secondContext.newPage();
  const persisted = await secondPage.evaluate(() => localStorage.getItem("profilefleet-smoke"));
  if (persisted !== "persisted") throw new Error("Persistent browser storage did not survive restart");
  await fleet.releaseLease(second.id, { stop: true });
  console.log("Real CloakBrowser smoke passed: CDP connect and persistent profile restart");
} finally {
  await fleet.close();
  await new Promise((resolve) => originServer.close(resolve));
  await rm(home, { recursive: true, force: true });
}
