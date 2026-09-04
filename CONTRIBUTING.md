# Contributing

Contributions are welcome when they preserve ProfileFleet's local-first trust
boundary and acceptable-use policy.

## Development

```bash
pnpm install
pnpm check
```

Use Node.js 22 or newer. Tests must use `FakeBrowserAdapter` unless a change is
specifically covered by an opt-in real-engine smoke test. Do not add site-
specific login, CAPTCHA, credential submission, or evasion code.

## Pull requests

- Add or update tests for observable behavior.
- Keep client and core exports free of Node-only and browser-engine imports.
- Never log token, proxy, cookie, or browser-storage values.
- Document public API changes in both READMEs.
- Confirm `pnpm pack` contains compiled output but no browser binary or local
  profile data.

By contributing, you agree that your contribution is licensed under
Apache-2.0.
