import type {
  BrowserEngineAdapter,
  EngineAdoptInput,
  EngineDoctorResult,
  EngineLaunchInput,
  EngineSessionHandle,
} from "../core/types.js";

async function cdpEndpoint(port: number, attempts = 80): Promise<string> {
  let lastError = "CDP endpoint did not become ready";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const body = await response.json() as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      } else {
        lastError = `CDP discovery returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${lastError} on port ${port}`);
}

function browserPid(context: unknown): number | null {
  try {
    const candidate = context as {
      _browser?: { _process?: { pid?: number } };
      _connection?: { _transport?: { _proc?: { pid?: number } } };
    };
    return candidate._browser?._process?.pid
      ?? candidate._connection?._transport?._proc?.pid
      ?? null;
  } catch {
    return null;
  }
}

async function endpointAlive(endpoint: string): Promise<boolean> {
  try {
    const url = new URL(endpoint);
    const port = Number(url.port);
    if (!port) return false;
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function cloakBrowserPlatformOptions(platform: NodeJS.Platform = process.platform): {
  stealthArgs: boolean;
  args: string[];
} {
  // CloakBrowser's wrapper adds --no-sandbox on every platform. Desktop macOS
  // and Windows do not require it, and keeping Chromium's sandbox enabled is a
  // safer, more browser-like default. Linux retains the wrapper defaults for
  // container compatibility; --test-type suppresses Chromium's warning banner.
  if (platform === "linux") return { stealthArgs: true, args: ["--test-type"] };
  return {
    stealthArgs: false,
    args: [
      "--test-type",
      `--fingerprint-platform=${platform === "darwin" ? "macos" : "windows"}`,
    ],
  };
}

export class CloakBrowserAdapter implements BrowserEngineAdapter {
  readonly id = "cloakbrowser";

  async doctor(options: { install?: boolean } = {}): Promise<EngineDoctorResult> {
    const diagnostics: EngineDoctorResult["diagnostics"] = [];
    try {
      const cloak = await import("cloakbrowser");
      diagnostics.push({ name: "wrapper", ok: true, message: "cloakbrowser wrapper is installed" });
      if (options.install && typeof cloak.ensureBinary === "function") {
        await cloak.ensureBinary();
      }
      const info = typeof cloak.binaryInfo === "function" ? cloak.binaryInfo() : null;
      const installed = info && typeof info === "object"
        ? Boolean((info as { installed?: boolean; executablePath?: string }).installed
          || (info as { executablePath?: string }).executablePath)
        : true;
      diagnostics.push({
        name: "binary",
        ok: installed,
        message: installed
          ? "CloakBrowser binary is available"
          : "CloakBrowser binary is not installed; run profilefleet doctor --install",
      });
      diagnostics.push({
        name: "license",
        ok: true,
        message: process.env.CLOAKBROWSER_LICENSE_KEY
          ? "CLOAKBROWSER_LICENSE_KEY is configured"
          : "No license key detected; upstream free-build concurrency limits apply",
      });
    } catch (error) {
      diagnostics.push({
        name: "wrapper",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      engine: this.id,
      ok: diagnostics.every((entry) => entry.ok),
      diagnostics,
    };
  }

  async launch(input: EngineLaunchInput): Promise<EngineSessionHandle> {
    const { launchPersistentContext } = await import("cloakbrowser");
    const platform = cloakBrowserPlatformOptions();
    const args = [
      `--remote-debugging-port=${input.cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--fingerprint=${input.profile.fingerprintSeed}`,
      "--disable-session-crashed-bubble",
      "--no-first-run",
      ...platform.args,
      ...(input.proxyUrl ? [] : ["--no-proxy-server"]),
    ];
    const context = await launchPersistentContext({
      userDataDir: input.profileDir,
      headless: input.profile.headless,
      locale: input.profile.locale,
      timezone: input.profile.timezone,
      stealthArgs: platform.stealthArgs,
      args,
      ...(input.proxyUrl ? { proxy: input.proxyUrl } : {}),
      ...(process.env.CLOAKBROWSER_LICENSE_KEY
        ? { licenseKey: process.env.CLOAKBROWSER_LICENSE_KEY }
        : {}),
    });
    try {
      if (input.initialUrl) {
        const pages = context.pages();
        const page = pages[0] ?? await context.newPage();
        await page.goto(input.initialUrl, { waitUntil: "domcontentloaded" });
      }
      const endpoint = await cdpEndpoint(input.cdpPort);
      return {
        pid: browserPid(context),
        cdpEndpoint: endpoint,
        isAlive: () => endpointAlive(endpoint),
        close: async () => { await context.close(); },
      };
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  async adopt(input: EngineAdoptInput): Promise<EngineSessionHandle> {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.connectOverCDP(input.cdpEndpoint);
    return {
      pid: input.browserPid,
      cdpEndpoint: input.cdpEndpoint,
      isAlive: () => endpointAlive(input.cdpEndpoint),
      close: async () => { await browser.close(); },
    };
  }
}
