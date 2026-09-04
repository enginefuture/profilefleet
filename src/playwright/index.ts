import type { BrowserLease } from "../core/types.js";

export async function connectPlaywright(lease: BrowserLease) {
  const { chromium } = await import("playwright-core");
  return chromium.connectOverCDP(lease.cdpEndpoint);
}
