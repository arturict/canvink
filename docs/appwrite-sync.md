# Appwrite encrypted sync contract

This directory defines a deployable but intentionally undeployed Appwrite backend for Canvink's encrypted sync protocol. The backend sequences and routes opaque encrypted records. It never receives or stores notebook titles, page text, handwriting, OCR output, clear file names, or clear MIME types.

The implementation follows Appwrite's current [TablesDB transaction model](https://appwrite.io/docs/products/databases/transactions): operations are staged in a short-lived transaction, reads see staged writes, and commit fails when a touched row changed concurrently. Sequence allocation updates the notebook counter and creates the change row in one transaction. Conflict retries reopen a fresh transaction. A response is returned only after the committed change is read back. If the commit succeeded but its acknowledgement was lost, the deterministic device/hash row is reconciled and returned as an idempotent duplicate.

## Resources

`appwrite.config.json` uses Appwrite CLI multi-file includes. It contains placeholders only; replace the project and regional endpoint locally before any push. The tracked configuration contains no API key, JWT, recovery code, or cryptographic key.

- Database `canvink-sync`
- `sync_notebooks`: server-only notebook-global sequence counter. Its row ID is the opaque notebook ID and therefore also the Appwrite team ID.
- `sync_device_accounts`: server-only one-row-per-account bootstrap guard. Its transactionally unique account ID ensures that concurrent first registrations cannot activate two devices.
- `sync_devices`: account-bound public X25519/Ed25519 device keys and pending/active/revoked state. A device ID and its keys are globally immutable once bound; rows are readable only by their account and writable only through the Function.
- `sync_device_challenges`: server-only, five-minute device-approval challenges and one-time consumption proofs. Live challenge creation is capped at three per pending device.
- `sync_changes`: opaque change envelopes. `(notebookId, sequence)` and `(notebookId, deviceId, changeHash)` are unique. Rows are readable by the notebook team and cannot be changed directly by clients.
- `sync_heads`: server-only per-device/document acknowledged heads.
- `sync_key_envelopes`: server-only opaque wrapped keys. Recovery rows also bind a recovery Ed25519 public key inside the sender-signed envelope. Rows have no direct client permissions; recipient and current-membership checks are centralized in the Function route.
- `sync_assets`: Function-private encrypted upload reservations and completion metadata. Rows contain only protocol version, encrypted SHA-256, encrypted size, opaque notebook/device/file IDs, upload-authorization signature, chunk count, state, lease, and timestamps. Pending and completed rows have no direct team permissions.
- `sync_asset_quotas`: Function-private atomic pending counters for each notebook and notebook/device pair. Both counters and the reservation change in one conflict-detecting TablesDB transaction.
- Bucket `canvink-encrypted-assets`: no client create permission, file security, 64 MiB cap, and no public read. The Function writes private opaque staging chunks and the final ciphertext through its dynamic server key. Only the verified final ciphertext receives notebook-team read permission.
- Function `canvink-sync`: Node 22, user execution only, no event or schedule triggers, a 120-second bound and 512 MiB specification for near-64 MiB assembly, and only `rows.read`, `rows.write`, `teams.read`, `files.read`, and `files.write` dynamic-key scopes.

Appwrite's server-side bucket encryption is defense in depth, not Canvink's end-to-end encryption. Appwrite documents that files above 20 MiB may skip its storage encryption; Canvink ciphertext remains encrypted independently.

## Authentication and authorization

Every request requires both platform-provided `x-appwrite-user-id` and `x-appwrite-user-jwt`. The Function verifies the JWT through `Account.get()` and requires its user ID to match the platform header. The dynamic Function key is used only after this identity check for bounded server operations.

One Appwrite team represents exactly one notebook: `teamId === notebookId`. A confirmed membership must contain exactly one of these roles:

| Operation                              | owner | editor | viewer                    |
| -------------------------------------- | ----- | ------ | ------------------------- |
| append/list/acknowledge                | yes   | yes    | list and acknowledge only |
| create key envelopes                   | yes   | no     | no                        |
| list own account/device key envelopes  | yes   | yes    | yes                       |
| list active notebook device keys       | yes   | yes    | yes                       |
| revoke another current member's device | yes   | no     | no                        |
| begin/chunk/complete asset upload      | yes   | yes    | no                        |

Missing, removed, unconfirmed, or ambiguously multi-role memberships fail closed. Authorization is checked for every Function request. Change append, head acknowledgement, asset reservation/completion, and key-envelope creation also require the supplied sender `deviceId` to be active and bound to the authenticated account. Appwrite Teams and TablesDB are separate services, so membership removal cannot participate atomically in a row transaction; a removal racing the final milliseconds of an already-authorized commit is an unavoidable platform boundary and must be included in operational threat testing.

## HTTP routes

All application routes use `POST` with `Content-Type: application/json`; `OPTIONS` is accepted for preflight. Other methods return 405. Browser origins must exactly match the comma-separated `CANVINK_ALLOWED_ORIGINS` Function variable. Requests without `Origin` are accepted for the Windows/Tauri client. Responses are `no-store`, and logs contain only route, status, and stable error code.

Opaque byte fields use canonical, unpadded base64url. Notebook IDs are valid Appwrite IDs of at most 36 characters. Change ciphertext is capped at 4 MiB, encrypted assets at 64 MiB, Function request bodies at 6 MiB, and asset chunks at 3 MiB before base64url expansion. A 64 MiB encrypted frame therefore uses at most 22 chunk requests, each below the request boundary including JSON overhead. Catch-up pages are capped at 100 changes, and head acknowledgements at 64 documents with 64 heads each.

### `POST /registerDevice`

Accepts `{ protocolVersion, deviceId, encryptionPublicKey, signingPublicKey }`, where both keys are canonical 32-byte base64url values. `accountId` is always derived from the verified Appwrite identity and is not accepted in the body. The response includes `bootstrap`: the transactionally unique first device for an account is active with `bootstrap: true`; every later device is pending with `bootstrap: false` until approved. Exact retries are idempotent. A device ID can never be rebound to another account or different public keys, and a revoked ID cannot be reactivated by registering it again.

### `POST /listMyDevices`

Accepts `{ cursor?, limit? }` and returns at most 50 devices belonging to the authenticated account plus an opaque `nextCursor` when more remain. Responses contain public keys, state, and lifecycle timestamps but never another account ID or notebook/content metadata.

### `POST /listNotebookDevices`

Accepts `{ notebookId, cursor?, limit? }`. Any current confirmed member may list the active public device keys of current confirmed notebook members. The route excludes pending, revoked, removed, and unrelated devices; pages are capped at 50. Membership fan-out is capped at 100 accounts and fails closed above that operational bound.

### `POST /createDeviceApprovalChallenge`

Accepts `{ protocolVersion, notebookId, requestingDeviceId }`. The caller must currently belong to the notebook and own the pending device. The server snapshots the pending device ID and both immutable public keys into a challenge with a random 32-byte nonce and five-minute expiry. At most three unexpired challenges may exist for one pending device.

### `POST /activateDevice`

Accepts `{ challengeId, proof: { protocolVersion, approverDeviceId, challengeHash, signature } }`. The authenticated account, pending device, and active approver must match the challenge account. The Function recomputes the canonical challenge hash and verifies the Ed25519 proof against the approver's registered signing key. Current notebook membership is checked again immediately before an atomic transaction consumes the challenge and activates the device. An exact retry is idempotent; an expired, altered, cross-account, self, inactive-approver, or replayed proof fails closed.

### `POST /activateDeviceWithRecovery`

Accepts `{ challengeId, proof: { protocolVersion, recoveryKeyId, challengeHash, signature } }`. It reuses a challenge from `/createDeviceApprovalChallenge`, but verifies the domain-separated Ed25519 proof against the single consistent `recoverySigningPublicKey` bound by at most 100 stored recovery envelopes for that notebook and recovery key ID. The Function checks the authenticated account, current notebook membership, challenge expiry, pending-device key snapshot, and recovery-key binding before atomically consuming the challenge and activating the device. Exact retry is idempotent; a missing, conflicting, wrong-notebook, altered, expired, or replayed recovery proof fails closed.

### `POST /revokeDevice`

Accepts `{ deviceId, notebookId? }`. An account may revoke its own device. A different account must supply a notebook where the caller is the confirmed owner and the target device account is still a confirmed member. Revocation is idempotent and marks the device inactive; it does not delete audit state or allow key rebinding.

### `POST /listKeyEnvelopes`

Accepts `{ notebookId, recipient: { kind: "account" | "device" | "recovery", id }, cursor?, limit? }`. The caller must still be a notebook member and must be the account recipient or own the active device recipient. A recovery request must name the exact high-entropy recovery key ID; recovery IDs are not enumerated. The response preserves the complete cryptographic envelope needed for verification and unwrap: protocol version, epoch, sender device, recipient, both X25519 public keys, the recovery signing public key when applicable, nonce, ciphertext, signature, and envelope hash. It also includes `senderSigningPublicKey`, resolved from the immutable device registry even if that sender is now revoked; this is response metadata outside the signed envelope. Pages are capped at 50 and ordered by epoch. Envelopes for other account/device/recovery recipients are never returned.

### `POST /appendChange`

Accepts a pending envelope with `protocolVersion`, `notebookId`, `documentId`, `deviceId`, positive `keyEpoch`, 32-byte `changeHash`, 24-byte `nonce`, ciphertext, and 64-byte signature. The Function verifies the canonical Ed25519 signature against the active sender device before assigning `sequence`. `keyEpoch` is persisted and returned unchanged by `listChangesAfter`, allowing clients to select the exact notebook content key needed for each historical change. Exact device/hash replay returns the committed envelope with `duplicate: true`; reuse with a different epoch or any other different bytes returns 409.

### `POST /listChangesAfter`

Accepts `{ notebookId, afterSequence, limit? }`. Returns ascending envelopes including each change's `keyEpoch`, the transaction-consistent `snapshotSequence`, and `hasMore`.

### `POST /ackHeads`

Accepts protocol version, notebook/device IDs, a committed sequence, and bounded document/head arrays. Viewers may acknowledge downloaded state. Future sequences, decreasing sequences, duplicate shapes, and rebinding one sequence to different heads are rejected.

### `POST /putKeyEnvelope`

Owner-only. Stores the opaque sender and recipient X25519 public keys, recipient descriptor, nonce, ciphertext, signature, and envelope hash for one notebook/key-epoch/recipient slot. Recovery recipients must additionally provide a 32-byte `recoverySigningPublicKey`; that field is forbidden for account/device recipients and is included in the envelope AAD before signature verification. The sender must be the owner's active registered device and both its registered X25519 key and canonical Ed25519 signature must verify. Account/device recipients must still be notebook members; device recipients must be active and the recipient public key must match the directory. Binding the public keys prevents a wrapped-key envelope from being replayed under a different recipient or recovery-approval context. Exact retry is idempotent; changing any bound field while reusing the slot is rejected.

### `POST /beginAssetUpload`

Accepts `{ protocolVersion, notebookId, deviceId, encryptedHash, encryptedSize, uploadSignature }` and returns deterministic `assetId`, `fileId`, bucket ID, expiry, chunk count, and status. `uploadSignature` is Ed25519 over the domain `canvink/asset-upload-authorization/v1` and canonical protocol version, notebook ID, device ID, encrypted SHA-256, and encrypted byte size. The Function verifies it against the active registered device before atomically incrementing the notebook and device counters and creating or reusing a Function-private reservation. Exact replay is idempotent; every reconciliation compares all signed fields and the device ID, so a concurrent foreign-device reservation is never returned. Metadata tampering, cross-device use, and revoked devices fail closed. No clear filename, MIME type, plaintext hash, or asset content metadata enters this contract.

The Function bounds pending reservations to 64 per notebook and 16 per device. Deterministic counter rows make the check and increment atomic under concurrent requests; a conflicting transaction reopens and retries. These application bounds do not replace project-level Appwrite rate limits, budgets, alerts, backups, or restore drills; those remain live operational gates.

### `POST /uploadAssetChunk`

Accepts the exact signed reservation identity plus `{ assetId, fileId, chunkIndex, chunkCount, chunkHash, chunkBytes }`. The caller's current membership and active owned device are rechecked. Chunk count and position must match the reservation's fixed 3 MiB layout, and the Function recomputes chunk SHA-256 before writing a private opaque staging file with its server key. Exact bytes at the same index are idempotent; changed bytes, changed reservation metadata, another device, or a revoked device fail closed. The bucket has no authenticated-user create permission, so there is no reservation- or quota-free client upload path.

### `POST /completeAssetUpload`

Accepts the exact signed reservation identity and encrypted metadata. The Function rechecks current membership, active device ownership, and the same upload authorization, then transactionally claims or renews an `uploading` lease before storage I/O. It assembles at most 22 private chunks in bounded memory, writes the final opaque file, recomputes total SHA-256 and size, seals file read permission to the current notebook team, atomically marks the reservation complete and decrements both counters, then removes staging chunks. A partial failure remains replay-recoverable: deterministic final and staging objects remain until a later exact completion or expired-lease cleanup. Exact retry is idempotent.

Every begin request opportunistically processes at most 25 expired reservations. Cleanup first transactionally claims `pending`, expired `uploading`, or expired `cleaning` state with a `cleaning` lease; only the claim owner may delete final/staging objects and atomically delete the row plus decrement counters. A completion lease acquired before expiry therefore cannot be deleted by concurrent cleanup. Request-path cleanup is bounded and opportunistic, so scheduled cleanup remains an operational gate.

## Local verification

From `functions/canvink-sync`:

```powershell
npm ci
npm run check
```

The deterministic tests use injected Appwrite data/storage ports and cover role matrices, removed members, concurrent one-time bootstrap, pending-device isolation, bounded approval challenges, valid and exact-replay approval, expired/tampered/cross-account/wrong-device/inactive-approver proofs, recovery proof replay/tampering/wrong or conflicting keys, membership removal between issuance and consumption, device/account key rebinding, cross-account enumeration, forged/revoked devices, active-only notebook device enumeration, owner-only third-party revocation, Ed25519 change and key-envelope verification, recipient authorization, exact recovery-envelope retrieval with historical sender signing metadata, rotation epochs and cursor pagination, sequence races, altered epoch/idempotency payloads, catch-up epoch round-trips, lost commit acknowledgements, future/stale/tampered heads, bounds, CORS/method/auth failures, missing or changed X25519 recipient keys, key-envelope rebinding, and encrypted-asset hash/size completion.

## Provisioning and live gates

No resource was pushed and no credentials were read. Before a real deployment:

1. Update to the latest Appwrite CLI. The locally observed CLI was 22.6.1 while 25.1.0 was available; current multi-file/TablesDB configuration must be validated with the target server version.
2. Replace only the project/endpoint placeholders, configure `CANVINK_ALLOWED_ORIGINS` as a Function variable, then review the CLI plan before `appwrite push tables`, `appwrite push buckets`, or `appwrite push functions`. Do not add variables to tracked JSON.
3. Create each notebook team with an opaque Appwrite-valid notebook ID and exactly one role per confirmed membership. Enable membership privacy.
4. Verify the target plan's transaction-operation limits, the configured 120-second/512-MiB Function runtime against 22-chunk near-64 MiB assembly, Storage quota and project-level Function/Storage rate limits, regional residency, backups, and self-host compatibility.
5. Run live tests against a dedicated non-production project: concurrent writers, 17-way quota allocation, conflict retries, Realtime delivery plus persistent catch-up, removal during writes/chunks, completion-versus-cleanup leases, interrupted staging/final writes, oversized files, storage hash mismatch, and project/server restoration.
6. Add and verify a scheduled maintenance job for defense-in-depth cleanup, quota-counter reconciliation, and retention reporting. Request-path cleanup is bounded and opportunistic, so it cannot guarantee timely removal during idle periods. Expired/consumed approval-challenge retention also remains operational policy.
7. Complete and verify an authenticated UX for transporting approval challenges and proofs between devices. The Function verifies canonical Ed25519 signatures for changes, key envelopes, device/recovery approvals, and encrypted-asset upload authorization; it does not and cannot decrypt XChaCha20-Poly1305 ciphertext or wrapped keys.

Relevant Appwrite references: [Function request identity and dynamic keys](https://appwrite.io/docs/products/functions/develop), [JWT authentication](https://appwrite.io/docs/products/auth/jwt), [TablesDB transactions](https://appwrite.io/docs/products/databases/transactions), [permissions](https://appwrite.io/docs/advanced/security/permissions), [storage permissions](https://appwrite.io/docs/products/storage/permissions), and [CLI multi-file configuration](https://appwrite.io/docs/tooling/command-line/installation).
