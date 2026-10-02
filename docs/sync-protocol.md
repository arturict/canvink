# Encrypted sync protocol foundation

`src/sync` contains Canvink's transport-neutral protocol records, cryptographic
core, durable client state machine, Appwrite transport adapter, and local
integration ports. The record validators and inbox/outbox reducers remain pure
TypeScript and do not infer that arbitrary opaque bytes are valid cryptography.
The higher layers use the validated records with the implemented cryptographic
and persistence boundaries described below.

## Wire records

`SyncEnvelope` contains only protocol version, opaque notebook/document/device
identifiers, a positive notebook-global server sequence, change hash, nonce,
ciphertext, and signature. `PendingSyncEnvelope` uses the same payload with a
`null` sequence until the server assigns one. The validators reject missing and
unknown fields, non-byte payloads, unsupported versions, unsafe sequences, and
unbounded values. They defensively copy all `Uint8Array` values.

`DevicePublicIdentity` carries opaque X25519 and Ed25519 public-key payloads.
`NotebookKeyEnvelope` supports device, account-invitation, and recovery
recipients plus a monotonically increasing key epoch. `DocumentHeads` and
`HeadsAcknowledgement` carry opaque CRDT heads and reject duplicates.

The byte lengths are defensive transport limits, not cryptographic algorithm
validation. No code here infers plaintext, filenames, titles, OCR, ink, or other
notebook content from an envelope.

## Inbound sequencing

Each notebook has a `contiguousSequence` cursor. Incoming envelopes are kept in
ascending order until all earlier sequences are available. A caller first uses
`ingestSyncEnvelope`, then reads the contiguous prefix with
`getReadyEnvelopes`. Only after signature verification, decryption, and durable
CRDT application succeed may it call `commitAppliedEnvelopes`. This two-phase
flow prevents a crash or failed decryption from advancing the cursor and losing
a change.

`parseSequenceCursor` validates a persisted cursor independently before it is
used to ask a transport for changes.

The inbox rejects:

- a duplicate sequence/hash pair;
- the same hash replayed at another sequence;
- a different hash for an already buffered sequence;
- any unknown envelope at or behind the committed cursor;
- another notebook's envelope; and
- growth beyond the configured out-of-order buffer limit.

Exact replay detection retains applied sequence/hash receipts. A production
persistence adapter must durably store this state and define a safe compaction
policy or a server-backed uniqueness window before pruning it.

## Outbox acknowledgements

Outbox operations receive a stable `operationId` and monotonic `localOrder`.
Batch selection always follows local order. Acknowledgements are canonicalized
by operation ID and remove an entry only when every opaque payload field matches
the pending change; the server may only add its positive sequence. Durable
receipts make identical acknowledgements idempotent and conflicting
acknowledgements fail closed. Receipts retain the exact committed envelope; a
production adapter must persist them atomically and define a safe pruning policy
rather than silently weakening duplicate acknowledgement checks.

## Catch-up

`beginCatchUp` requests changes strictly after the durable cursor. A
`CatchUpPage` is tied to that cursor and a server snapshot sequence. Pages must
be contiguous and ascending; final pages must end exactly at the snapshot.
Accepted pages enter the normal inbox and remain in `applying` state until the
entire page is durably committed. Realtime delivery may race catch-up: an
identical buffered envelope is tolerated, while any sequence/hash conflict is
rejected.

## Implemented integration layers

The current source tree includes:

- X25519 device agreement keys and Ed25519 signing keys through the
  Sodium-compatible cryptographic adapter;
- encrypted notebook changes, assets, and wrapped notebook epoch keys using
  XChaCha20-Poly1305, including a specified associated-data encoding;
- canonical signed bytes plus verification of signatures, hashes, key epochs,
  device authorization, revocation, roles, and key rotation before applying a
  change;
- Windows DPAPI commands and a protected keyring adapter for desktop private
  material, plus recovery-code generation, one-time reveal, verification, and
  explicit unrecoverable-loss behavior;
- byte-safe serialization and durable inbox, outbox, receipt, cursor, heads,
  encrypted-asset, and Automerge application ports for SQLite or IndexedDB;
- an Appwrite transport and Function routes for `appendChange`, `listChangesAfter`,
  `ackHeads`, `putKeyEnvelope`, `beginAssetUpload`, `uploadAssetChunk`, and
  `completeAssetUpload` endpoints with atomic notebook-global
  sequencing, payload limits, membership checks, rate limits, and durable
  uniqueness constraints; and
- deterministic tests covering real Automerge Repo handles, offline changes,
  lost acknowledgements, reorder/replay handling, reinstall, server reset,
  removal, rotation, recovery, tampered packets, and bounded encrypted assets.

Encrypted asset reservation uses a separate Ed25519 authorization domain,
`canvink/asset-upload-authorization/v1`, binding only protocol version,
notebook/device IDs, encrypted SHA-256, and encrypted byte size. MIME type,
filename, and plaintext hash are not disclosed. Exact authorization replay is
idempotent; changed metadata, another device, or a revoked device fails closed.
Clients have no bucket create permission. The active device sends fixed 3 MiB
ciphertext chunks through the authenticated Function, which rechecks the signed
reservation and writes private opaque staging objects. Atomic notebook/device
counter rows enforce 64/16 pending quotas under races. Completion and cleanup
claim leased states before storage I/O so expiry cleanup cannot delete an active
completion; the final 64 MiB budget is at most 22 chunks.

## Outstanding live and release gates

Implemented encryption and client mechanics do not establish a live secure
collaboration service. Before product activation or release claims, Canvink
still requires an explicitly authorized Appwrite deployment; review of the
deployed permissions, quotas, backup, cleanup, and restoration behavior; two
real accounts/devices exercising Realtime and persistent catch-up; a packaged
Windows DPAPI restart; live removal/rotation/recovery; the exact 60-minute soak;
near-limit encrypted assets; representative failure drills; and independent
security/release review.

Until those gates pass, describe the repository precisely as an implemented
encrypted sync protocol and client with an undeployed Appwrite integration. Do
not describe it as live cloud sync, production-ready secure collaboration, or
operational recovery evidence.
