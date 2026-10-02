# Desktop key protection

Canvink desktop protects device and private notebook key material with Windows
Data Protection API (DPAPI) before any persistence. The native commands are:

- `protect_key_material({ materialBase64 }) -> { protectedBase64 }`
- `unprotect_key_material({ protectedBase64 }) -> { materialBase64 }`

Both commands accept only non-empty canonical padded Base64 whose decoded value
is at most 1 MiB. They return typed, content-free errors and never include a
Windows error message, plaintext, path, or key identifier.

DPAPI uses the current Windows user profile, `CRYPTPROTECT_UI_FORBIDDEN`, and the
fixed Canvink notebook-key domain entropy. It never requests
`CRYPTPROTECT_LOCAL_MACHINE`, so another Windows user or a copied database is
not sufficient to open the blob. DPAPI output allocations are zeroed and
released with `LocalFree`; decoded plaintext and native intermediate buffers are
explicitly zeroized.

The TypeScript boundary is `WindowsDpapiBridge` in
`src/security/dpapiBridge.ts`. `protectKeyMaterial` consumes and zeroes its
caller-owned `Uint8Array` on success and failure. `unprotectKeyMaterial` returns
a detached plaintext buffer which its caller must zero immediately after key
import. The bridge refuses to run outside Tauri unless a command transport is
explicitly injected for tests. There is no browser, localStorage, IndexedDB, or
plaintext fallback.

Persist only `protectedBase64`. Never log command arguments or responses. An
empty, malformed, tampered, wrong-entropy, wrong-user, or otherwise unreadable
blob must be treated as unavailable key material and routed to explicit recovery
or re-authentication, never to key regeneration over existing encrypted data.
