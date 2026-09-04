# Security policy

## Supported versions

Security fixes are provided for the latest minor release. During the `0.x`
period, users should upgrade to the newest published tag before reporting an
issue.

## Reporting a vulnerability

Do not open a public issue for credential disclosure, path traversal, CDP
exposure, authentication bypass, or dependency supply-chain concerns. Use
GitHub's private vulnerability reporting for this repository. Include affected
version, operating system, reproduction steps, and expected impact. Please
allow maintainers a reasonable remediation window before public disclosure.

## Deployment guidance

- Keep `PROFILEFLEET_HOST` at its enforced `127.0.0.1` value.
- Never expose daemon or CDP ports directly to the public internet.
- Protect `~/.profilefleet/token` and browser profile directories as secrets.
- Pass proxy URLs and engine license keys through environment variables or a
  host secret manager.
- Use a dedicated operating-system account for untrusted automation jobs.
- Upgrade CloakBrowser and Playwright regularly and review their separate
  security advisories and license terms.

ProfileFleet cannot isolate processes running as the same operating-system
user. A same-user process may be able to inspect loopback traffic or local
browser data.
