# Architecture

ProfileFleet separates lifecycle authority from browser implementation and page
automation.

```text
React console / host application
              │
       profilefleet/client
              │ bearer-authenticated HTTP + SSE
              ▼
      ProfileFleet daemon
   ┌──────────┼───────────┐
 profiles   leases     sessions
   │          │            │
 filesystem  TTL      engine adapter
   │                       │
 owner lock           CloakBrowser
                           │
                    loopback CDP ── Playwright
```

## Ownership

- A profile is a durable browser identity and user-data directory.
- At most one daemon owns a profile lock.
- At most one active lease owns a profile session.
- A session may remain warm briefly after its lease is released.
- An adapter owns the underlying browser handle; the fleet owns when that
  handle may be created, adopted, or closed.

## Lifecycle

1. `acquire` obtains the profile-local operation mutex.
2. An existing request ID returns its unexpired lease.
3. An existing lease for the profile returns `PROFILE_IN_USE`.
4. The fleet reserves global capacity and a CDP port.
5. It writes `.session.lock` with an unguessable owner token.
6. The adapter starts a persistent browser and returns a health-checkable
   handle.
7. The fleet records the first successful launch and issues a renewable lease.
8. Release or expiry schedules idle shutdown. A requested immediate stop closes
   the handle and removes the lock.

Independent profiles can launch concurrently. Operations for the same profile
are serialized, and capacity/port reservations prevent launch races.

## Recovery

At daemon startup every session lock is classified:

- Live daemon PID: expose the session as `orphaned`; do not take ownership.
- Dead daemon and reachable CDP: call the adapter's `adopt`, replace lock
  ownership, and schedule idle shutdown until a client acquires the profile.
- Dead daemon and unreachable CDP: remove the stale lock.

Leases are intentionally not restored after a daemon crash. A client must
acquire a new lease, preventing a dead client from retaining ownership forever.

## Trust boundary

v0.1 is a same-host control plane. The management server and browser CDP ports
bind to loopback. Bearer authentication prevents ordinary local web pages from
calling the API, while origin checks reject unconfigured cross-origin clients.
The operating-system user remains the ultimate trust boundary: another process
running as the same user can read local files or probe loopback ports.

## Storage

Profile metadata is JSON written through temporary-file rename. It contains no
resolved proxy URL. The token, metadata, and lock files use owner-only modes on
platforms that support POSIX permissions. Browser user data remains wholly in
the profile directory and is never returned by the API.

No database is required in v0.1. Multi-node coordination, remote CDP proxying,
multi-tenancy, and audit-log persistence are future adapter/control-plane work.
