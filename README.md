# ProfileFleet

ProfileFleet is a local-first TypeScript control plane for persistent
fingerprint-browser profiles. It gives applications one small API for profile
identity, exclusive leases, capacity, process recovery, and Playwright CDP
connections. A React library and an optional management console use the exact
same public client.

> Status: `v0.1.0`. Single host, local clients, one CloakBrowser adapter.

## Why ProfileFleet?

Launching a browser is easy. Keeping many durable browser identities coherent
is not. A production host must prevent two processes from opening the same
profile, avoid CDP port collisions, recover Chromium processes after daemon
crashes, expire abandoned work, and keep proxy credentials out of metadata and
logs. ProfileFleet owns those lifecycle concerns while leaving page automation
to Playwright and fingerprint implementation to an engine adapter.

## Features

- Persistent browser profiles with immutable fingerprint identity
- Exclusive, renewable leases with idempotent acquisition
- Explicit capacity and idle shutdown
- Per-profile owner-token locks and orphan process adoption
- Loopback-only HTTP API and CDP endpoints by default
- Proxy secrets resolved from environment variables only
- Framework-neutral TypeScript client
- React hooks, accessible components, and a built-in console
- Extensible `BrowserEngineAdapter` interface
- CloakBrowser adapter and a deterministic fake adapter for tests

## Install

Until the package is published to npm, install the versioned release artifact:

```bash
npm install https://github.com/enginefuture/profilefleet/releases/download/v0.1.0/profilefleet-0.1.0.tgz
npx profilefleet doctor --install
npx profilefleet start --ui
```

Open the console URL printed by the daemon. The URL carries the local bearer
token in its fragment; the console removes it from the address bar and keeps it
in session storage for that tab.

The optional CloakBrowser wrapper downloads and verifies its browser binary on
first use. ProfileFleet does not redistribute that binary. Newer CloakBrowser
builds may require an upstream free or paid license key:

```bash
export CLOAKBROWSER_LICENSE_KEY=cb_xxxxxxxx
```

ProfileFleet passes the value directly to CloakBrowser and never stores it.

## TypeScript quick start

Create a profile through the client:

```ts
import { ProfileFleetClient } from "profilefleet/client";

const fleet = new ProfileFleetClient({
  baseUrl: "http://127.0.0.1:47110",
  token: process.env.PROFILEFLEET_TOKEN,
});

const profile = await fleet.profiles.create({
  id: "research",
  name: "Research account",
  locale: "en-US",
  timezone: "America/New_York",
  proxyUrlEnv: "PROFILEFLEET_PROXY_RESEARCH",
  tags: ["research"],
});

const managed = await fleet.acquireManaged({
  profileId: profile.id,
  owner: "paper-monitor",
  ttlSeconds: 600,
  requestId: "paper-monitor-2026-09-04",
});

try {
  console.log(managed.lease.cdpEndpoint);
  // Connect your Playwright workflow here.
} finally {
  await managed.release();
}
```

Connect Playwright to a lease:

```ts
import { connectPlaywright } from "profilefleet/playwright";

const browser = await connectPlaywright(managed.lease);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? await context.newPage();
await page.goto("https://example.com");

// Release the fleet lease when work is complete. An unexpected browser close
// is detected by the daemon and reported as a session error.
await managed.release();
```

## React

```tsx
import {
  FleetOverview,
  ProfileFleetProvider,
  ProfileTable,
  SessionPanel,
} from "profilefleet/react";
import "profilefleet/styles.css";

export function BrowserAdmin() {
  return (
    <ProfileFleetProvider clientOptions={{
      baseUrl: "http://127.0.0.1:47110",
      token: sessionStorage.getItem("profilefleet-token") ?? "",
    }}>
      <FleetOverview />
      <ProfileTable />
      <SessionPanel />
    </ProfileFleetProvider>
  );
}
```

The React export also includes `ProfileForm`, `useProfiles`, `useSessions`,
`useCapacity`, `useProfileActions`, and `useFleetEvents`.

## CLI

```text
profilefleet init
profilefleet doctor [--install] [--json]
profilefleet start [--ui]
profilefleet profile create --name <name> [--id <id>] [--headless]
profilefleet profile list [--json]
profilefleet profile delete <id>
profilefleet session list [--json]
profilefleet session stop <id> [--force]
```

## Configuration

The default home is `~/.profilefleet` and can be changed with
`PROFILEFLEET_HOME`.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PROFILEFLEET_PORT` | `47110` | Management API port |
| `PROFILEFLEET_MAX_CONCURRENT` | `1` | Maximum active/orphaned sessions |
| `PROFILEFLEET_IDLE_TIMEOUT_MS` | `60000` | Delay before an unleased session stops |
| `PROFILEFLEET_HEALTH_INTERVAL_MS` | `5000` | CDP liveness interval |
| `PROFILEFLEET_TOKEN` | generated | Override the local bearer token |
| `CLOAKBROWSER_LICENSE_KEY` | unset | Passed directly to the engine |

Proxy URLs are never stored in profile JSON. A profile records an environment
variable name such as `PROFILEFLEET_PROXY_RESEARCH`; the daemon resolves its
value only while launching the browser.

## Storage and identity

```text
~/.profilefleet/
├── config.json
├── token
└── profiles/
    └── research/
        ├── profile.json
        ├── .session.lock
        └── user-data/
```

After the first successful launch, `engine`, `fingerprintSeed`, `locale`,
`timezone`, and `proxyUrlEnv` are identity fields. Create a new profile instead
of changing them. Only `name` and `tags` can be updated in place.

## Security model

- The daemon and all CDP ports bind to `127.0.0.1` in v0.1.
- Every management route except `/v1/health` requires a bearer token.
- Cross-origin browser requests are rejected unless explicitly allowlisted.
- Token files and profile metadata use owner-only file permissions where the
  platform supports them.
- Logs redact proxy user information and resolved secret values.
- Use an SSH tunnel when the host application is on another machine. Do not
  expose CDP or the daemon directly to the public internet.

See [Security](SECURITY.md), [Acceptable Use](ACCEPTABLE_USE.md), and
[Architecture](docs/ARCHITECTURE.md).

## Adapter API

An adapter implements:

```ts
interface BrowserEngineAdapter {
  readonly id: string;
  doctor(options?: { install?: boolean }): Promise<EngineDoctorResult>;
  launch(input: EngineLaunchInput): Promise<EngineSessionHandle>;
  adopt?(input: EngineAdoptInput): Promise<EngineSessionHandle>;
}
```

Adapters own engine startup and shutdown. ProfileFleet owns profile storage,
leases, ports, locks, health checks, HTTP, and events. See the fake adapter in
`profilefleet/testing` for a minimal implementation.

## Development

```bash
pnpm install
pnpm check
pnpm dev:console
```

Real-engine testing is opt-in because it downloads or uses a platform-specific
browser and may require a CloakBrowser license. Normal CI uses the fake adapter.

## Project boundaries

ProfileFleet is intended for browser-session isolation, authorized account
workflows, QA, and testing. It does not provide CAPTCHA bypass, credential
stuffing, account creation, site-specific evasion, or automation against
systems you do not own or have permission to access.

Licensed under Apache-2.0. CloakBrowser's compiled binary has separate terms;
see [Third-party notices](THIRD_PARTY_NOTICES.md).
