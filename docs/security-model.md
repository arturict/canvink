# Security model

## Summary

Canvink 0.x is a local-first public alpha. It has no required account, cloud sync, collaboration service, or application telemetry. These choices reduce exposure, but they do not make the application encrypted or independently audited.

Desktop notes are stored locally in SQLite. Browser-demo notes are stored in the current origin's IndexedDB. A temporary crash-recovery draft is stored separately in browser or desktop-webview IndexedDB until a matching authoritative save clears it. All of these stores are plaintext from Canvink's perspective.

## Assets to protect

- Notebook titles, text, handwriting, images, and PDF previews
- Deleted content retained in trash
- Local database integrity and availability
- Exported files and backups
- The integrity of distributed source code and binaries
- Future signing and deployment credentials

## Trust boundaries

### Desktop operating system

Canvink trusts the signed-in operating-system account, filesystem permissions, and device security. On Unix systems, Canvink creates and repairs its database directory with owner-only permissions (`0700`) and its SQLite database and companion files with owner-only permissions (`0600`). A person or process with access to the user's account or disk may still be able to read or modify the database.

Use full-disk encryption, a locked account, operating-system updates, and trusted backups for sensitive notes. The current alpha does not add database encryption or an application PIN.

### Tauri webview and Rust process

The webview handles untrusted note and document content. Native access belongs behind narrow Tauri commands. Commands must validate input, avoid caller-controlled arbitrary paths, and use the minimum Tauri capabilities required by the application.

A content bug in the webview must not automatically become unrestricted filesystem or shell access.

### Browser demo

IndexedDB is readable by code executing under the same web origin. A cross-site scripting flaw, malicious browser extension, compromised browser profile, or local device access may expose demo data. Clearing site data can destroy it.

The hosted demo is not suitable for the only copy of sensitive or important notes.

### Hosting

The landing page and browser app may be hosted by Vercel or by an operator using the documented static container. The hosting platform, self-host operator, reverse proxy, and network intermediaries can observe normal request metadata such as IP address, time, route, and user agent. They do not receive notebook scenes from Canvink. A self-host deployment must use one stable HTTPS origin because IndexedDB does not move between origins.

The production browser build uses a same-origin service worker for the application shell. It caches only navigation responses and content-hashed static assets. It does not cache notebook exports, imported documents, external URLs, or IndexedDB content. A compromised deployment can still serve malicious replacement code that reads same-origin browser storage, so operators must protect TLS, image provenance, and upgrades.

### Imported content

Images, PDFs, filenames, and pasted text are untrusted. Parsers can contain vulnerabilities and large inputs can exhaust memory. Content should be decoded locally with maintained libraries, bounded before allocation, and rendered without executing embedded scripts.

## Threats and current controls

| Threat | Current or required control | Remaining risk |
| --- | --- | --- |
| Lost or corrupt local data | Transactional SQLite snapshot and schema versioning | Alpha recovery and backup tooling is limited |
| Interrupted autosave | Versioned recovery draft, strict validation, explicit restore or discard, portable draft download | Recovery is not history or an external backup and disappears with browser or webview site data |
| Malicious PDF or image | Local parsing, browser sandbox, dependency updates, bounded input | Parser defects and denial of service remain possible |
| Webview to native escalation | Narrow Tauri commands and least-privilege capabilities | Native surface needs continued review |
| Cross-site scripting | React text rendering, no trusted note HTML, restrictive content policy where supported | Dependency or application bugs can still introduce XSS |
| Supply-chain compromise | Locked dependencies, review of updates, CI gates, minimized release permissions | Public package ecosystems remain a trust dependency |
| Tampered binary | Release checksums and exact source tag | Current desktop builds are unsigned |
| Local device compromise | Operating-system protections, owner-only Unix database permissions, and user backups | Canvink does not encrypt data at rest or protect against processes running as the same user |
| Silent remote collection | No application telemetry or required account | Hosting providers still keep ordinary request logs |

## Explicit non-guarantees

The current Canvink alpha does not claim:

- End-to-end encryption
- Encrypted local storage
- Resistance to a compromised operating system or browser
- Safe handling of arbitrarily large or malicious documents
- Reproducible binaries
- Independent penetration testing
- Signed or notarized installers
- Secure sync, because sync is not included

## Release and dependency security

Release workflows must:

- Use least-privilege GitHub permissions
- Keep secrets unavailable to untrusted pull-request code
- Pin action dependencies to immutable commit SHAs
- Install JavaScript dependencies from the committed lockfile
- Run TypeScript, test, web-build, Rust formatting, Clippy, and Rust-test gates
- Build artifacts from the release tag's exact commit
- Publish checksums with each binary set
- Keep signing and production deployment behind explicit protected environments

An unsigned checksum proves consistency with a downloaded checksum file only if the channel that delivered that file is trusted. It is not a substitute for code signing.

### Tracked Linux platform advisory

Tauri 2.11 currently brings the GTK3 Linux stack and `glib` 0.18 into Linux builds. RustSec advisory `RUSTSEC-2024-0429` covers unsound iterator implementations in `glib::VariantStrIter`; the currently released patched `glib` line starts at 0.20. An upgrade to `glib` 0.20 cannot be made independently inside Tauri's GTK3 stack.

A source reachability review on 2026-07-29 for the dependency graph locked by commit `5bd4dcbdee20c018d2a7ca868cf38cb1f1ab145f` found the affected iterator calls only inside `glib` itself, including its documentation and tests. No call was found in Canvink, Tauri, Wry, or Tao. This is evidence for the reviewed graph, not proof that an indirect path can never exist.

CI therefore carries one exact exception for `RUSTSEC-2024-0429` in `cargo-deny`, while `cargo audit` continues to report it. CI still fails on other vulnerability and unsoundness advisories, yanked crates, forbidden sources, license violations, and dependency bans. It also fails when this exception stops matching, so the exception must be removed instead of silently becoming stale.

Review this exception on every Tauri upgrade and in the weekly dependency review. Remove it as soon as the supported Tauri Linux stack resolves to any officially patched `glib` release. Track the upstream [0.18 backport](https://github.com/gtk-rs/gtk-rs-core/pull/2009) and [0.18.6 release request](https://github.com/gtk-rs/gtk-rs-core/issues/2010); do not pin an unreviewed fork as a substitute.

## Vulnerability reporting

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting on the repository Security tab when it is available. If private reporting is unavailable, contact a project maintainer through their GitHub profile, say that you need a private security channel, and do not include exploit details in the initial public message.

Include:

- Affected version and platform
- Reproduction steps or a minimal proof of concept
- Expected and observed impact
- Whether user interaction is required
- Suggested mitigation, if known

Maintainers should acknowledge receipt privately, avoid promising a date before triage, and credit reporters who want attribution.

## Security changes

Security-sensitive changes require tests and a clear threat statement. Changes to persistence, content parsing, Tauri permissions, deployment workflows, or external network behavior need focused review even when the code diff is small.
