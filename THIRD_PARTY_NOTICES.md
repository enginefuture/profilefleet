# Third-party notices

ProfileFleet can optionally launch CloakBrowser. The CloakBrowser JavaScript
wrapper is MIT licensed. Its compiled Chromium binary is distributed under a
separate license and is **not** included in ProfileFleet.

The optional adapter asks the upstream wrapper to download and verify a binary
on the user's machine. Users are responsible for complying with CloakBrowser's
binary license and concurrency limits:

- https://github.com/CloakHQ/CloakBrowser
- https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md

Other runtime dependencies retain their respective licenses. See the package
lockfile and package metadata for the complete dependency inventory.
