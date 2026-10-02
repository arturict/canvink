# Adversarial acceptance suite

This suite is a deterministic regression gate for Canvink v2 import, asset, bundle, and encrypted-sync boundaries. It is not a penetration test or a substitute for the repository's security review process. All payloads are synthetic and contain no production data.

## Run the gate

```powershell
pnpm exec vitest run src/security/adversarial.test.ts
pnpm exec playwright test tests/e2e/security-v2.spec.ts
```

The repository-wide release gate remains `pnpm check` plus the full Playwright suite.

## Coverage matrix

| Boundary | Deterministic attacks | Required invariant | Evidence |
| --- | --- | --- | --- |
| OneNote conversion | scripts, event handlers, CSS imports and URLs, unsafe links, SVG/MathML, iframes, forms, excessive depth and fan-out | executable subtrees and unsafe URLs are dropped; bounded conversion returns no partial tree | unit fixture and browser preview |
| PDFs | corrupt header, truncation, byte overflow, hostile stream length, executable bytes after `%%EOF` | reject before page creation or asset persistence | unit and browser upload |
| Images | decoded-pixel overflow, truncated PNG chunks, bytes after `IEND`, stored-byte checksum mismatch | reject before persistence; content-addressed reopen re-verifies bytes | unit and browser upload |
| `.canvink` | manifest SHA tamper, ZIP CRC tamper, traversal, duplicate IDs, unsupported compression and declared-size overflow, entry and total-size overflow | parser yields nothing until the entire canonical bundle verifies; caller authority remains unchanged | unit and browser import |
| Sync packets | metadata, ciphertext and signature tamper, wrong sender, wrong epoch, replay, sequence conflict, reordering and wrong notebook | only authenticated packets for the expected notebook/device/epoch apply; plaintext never appears in packet serialization | unit |
| Sync authority | viewer write, revoked-device registration, compromised catch-up pages, server cursor reset | authorization fails closed; invalid server responses do not apply; reset rebuilds encrypted state from local authority | unit |
| Key loss | destroyed device identity, keyring and recovery secret; malformed recovery code | no fallback key path and no recovery after all authorized material is destroyed | unit |

## Live-only gaps

The deterministic gate deliberately does not claim coverage for:

- Microsoft Graph tenant behavior, OAuth consent surfaces, throttling, or malicious live OneNote responses;
- Appwrite deployment policy, compromised infrastructure, realtime delivery timing, or revocation propagation across real devices;
- browser, PDF.js, image-decoder, operating-system, or download-handler vulnerabilities outside Canvink's validation boundary;
- malware scanning of arbitrary downloaded attachments;
- memory and latency behavior on every supported physical device at the configured maximum limits.

Those require separately authorized live-environment validation. A passing suite means the enumerated application invariants remain deterministic, bounded, and fail-closed; it does not mean the product is vulnerability-free.
