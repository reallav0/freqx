# Desktop dependency upgrade — 2026-10-01

Electron 36.9.5 → 44.5.1; electron-builder 26.8.1 → 26.15.3.
The resource editor is an explicit pinned `rcedit` 5.0.2 development dependency,
rather than an undeclared path into electron-winstaller's transitive package.

Electron 44 exposed an incompatibility in the old NAN used by naudiodon's
segfault-handler. The `nan: 2.29.0` override supplies the upstream V8 compatibility
fixes (see the installed NAN changelog, including 2.28.0's ExternalPointerTypeTag
fix). Native rebuilding now succeeds without skipping the crash handler.

The upgraded dependency tree reports **zero known npm audit vulnerabilities**,
compared with 15 high and one critical affected entries at baseline. This is an
advisory snapshot, not a guarantee of absence of vulnerabilities. rcedit has an
npm deprecation notice; it remains a packaging-only dependency and should be
replaced with a maintained resource editor when compatible tooling is available.

The generated Windows installer is **NotSigned** according to
Get-AuthenticodeSignature. Builder's signing log lines do not establish that
signing occurred. No trusted signing certificate is configured.

## Audit remediation — 2026-10-03

The CI audit gate remains enabled. Advisory
[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
affects `http-cache-semantics`, pulled in by Electron Builder's legacy downloader.
The `@electron/get: 5.1.0` override uses the native-fetch downloader already required
by Electron 44, removing the vulnerable cache dependency instead of suppressing
the audit. This requires Node 22.12 or newer; CI uses Node 22.

The updated lockfile reports zero vulnerabilities with `npm audit --audit-level=high`.
Windows packaging and native dependency rebuilding are verified with the override.
