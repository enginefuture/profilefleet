import { describe, expect, test } from "vitest";
import { cloakBrowserPlatformOptions } from "./cloakbrowser.js";

describe("cloakBrowserPlatformOptions", () => {
  test("keeps the Chromium sandbox enabled on macOS", () => {
    const options = cloakBrowserPlatformOptions("darwin");
    expect(options.stealthArgs).toBe(false);
    expect(options.args).toContain("--fingerprint-platform=macos");
    expect(options.args).not.toContain("--no-sandbox");
  });

  test("keeps the Chromium sandbox enabled on Windows", () => {
    const options = cloakBrowserPlatformOptions("win32");
    expect(options.stealthArgs).toBe(false);
    expect(options.args).toContain("--fingerprint-platform=windows");
  });

  test("retains wrapper defaults for Linux container compatibility", () => {
    const options = cloakBrowserPlatformOptions("linux");
    expect(options.stealthArgs).toBe(true);
    expect(options.args).toEqual(["--test-type"]);
  });
});
