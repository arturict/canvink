# Appwrite sync client and coordinator

## Opt-in boundary

Remote sync is optional. `createOptionalSyncClient` returns `null` for missing or `{ enabled: false }` configuration and does not construct an Appwrite `Client`, account adapter, Realtime socket, or transport. Accountless notebooks therefore remain fully local and make zero Appwrite calls.

Enabled configuration requires an HTTPS endpoint (or loopback HTTP for development) plus explicit project, Function, TablesDB database/table, and encrypted-asset bucket IDs. URLs with credentials, queries, or fragments and malformed Appwrite IDs fail before client construction. Configuration contains no API key or notebook content.

## Appwrite 26.2.0 adapters

`src/sync/client/appwrite.ts` uses the installed browser SDK and object-parameter APIs:

- Microsoft OAuth2 through `Account.createOAuth2Session`, with an optional returned-URL opener for a Tauri shell.
- Email OTP through `Account.createEmailToken`, followed by `Account.createSession`.
- Current-session lookup and `deleteSession({ sessionId: 'current' })` logout.
- One Appwrite team per notebook (`teamId === notebookId`). A confirmed membership must have exactly one role: `owner`, `editor`, or `viewer`.
- Synchronous `Functions.createExecution` calls for changes, heads, encrypted assets, key envelopes, the account/notebook device directories, pending-device challenges, activation, and revocation.
- `Channel.tablesdb(...).table(...).row()` change wakeups, notebook-team membership wakeups, and permission-filtered ephemeral Presence events.

Realtime payloads never mutate a document directly. They only schedule a persistent catch-up request, so missed, duplicated, or out-of-order socket events cannot be authoritative.

## Durable protocol

The coordinator persists a versioned snapshot through an injected `DurableSyncStatePort`. The browser port stores the complete validated snapshot in a dedicated IndexedDB store. The Tauri port uses the schema-v2 SQLite outbox and cursor commands, deletes only by the exact stored envelope hash, performs a CAS reset after authenticated server reset, and pages by `afterLocalOrder`. A restart test covers 1,005 queued encrypted changes so the native 1,000-row page cap cannot truncate an offline queue.

Local Automerge changes are extracted as raw change bytes, encrypted, and durably enqueued before network transmission. A pending entry is removed only after a byte-matching committed envelope is returned and the updated outbox is persisted. A lost HTTP acknowledgement is safe because retry uses the same encrypted device/hash identity and the Function returns the already committed sequence.

Catch-up always starts from the durable contiguous cursor. Envelopes enter the existing reorder/replay-safe inbox, then signature verification, epoch-specific decryption, and Automerge application complete before the cursor advances. Heads are acknowledged only after the stable snapshot sequence has been reached.

If an authenticated server reports a snapshot behind the durable cursor, the coordinator treats it as a reset. It rebuilds the outbox from all local Automerge changes, reuses known encrypted envelopes when possible, resets the inbound cursor, and repopulates the server. Applications must retain historical notebook epoch keys needed to read replayed historical changes.

## Roles, removal, and key epochs

- Owners and editors may enqueue changes and encrypted assets.
- Viewers can catch up and acknowledge heads but client mutation/upload APIs fail with `viewer-read-only`.
- Key-envelope publication is owner-only.
- Membership is rechecked at startup and every synchronization cycle. A removed member aborts work, unsubscribes Realtime, and enters the terminal `removed` state. A Function 403 triggers an immediate membership recheck.
- An envelope from a newer key epoch pauses application through the injected `awaitKeyEpoch` handoff. The cursor cannot pass that envelope until the epoch key is installed.

## Device keys and approval

`NotebookCryptoAdapter` binds the coordinator to the protocol-v1 XChaCha20/Ed25519 implementation, a protected persistent keyring whose decrypted keys exist only in process memory, and an authenticated notebook-device sender resolver. Collaborator signing keys come only from the membership-gated, active-only `/listNotebookDevices` directory. An unknown, inactive, or key-changing sender fails closed before Automerge application.

`loadOrCreateProtectedDeviceIdentity` persists only the two random device seeds through an injected secret store. Desktop uses the narrow Windows DPAPI bridge and refuses to continue when DPAPI cannot unlock the protected blob. Browser secrets are deliberately memory-only and disappear with the JavaScript session; the UI states that limitation prominently.

Registration is server-authoritative. Only a response with `device.status === 'active'` may start the coordinator. A later device remains `pending`. Its five-minute approval challenge can be transferred as a bounded `CNVK-A1` code to an active device, which signs the canonical challenge and submits `/activateDevice`; the pending client must refresh the authoritative directory before starting. Recovery kits domain-separate an Ed25519 signing seed from the recovery seed. Recovery envelopes bind the recovery signing public key, and `/activateDeviceWithRecovery` verifies a challenge-bound recovery signature before atomically activating the pending device. The X25519 key still performs only notebook-key unwrapping; it is not misused as a signature key.

## Runtime and collaboration UI

`NotebookSyncRuntime` connects live Automerge Repo `DocHandle`s to local change capture, encrypted durable enqueue, retry, catch-up, remote application, heads acknowledgements, Realtime wakeups, and bounded presence. `SyncCollaborationPanel` provides the German accessible opt-in/configuration, Microsoft and email-OTP auth, membership roles/invites, pending-device approval, one-time recovery acknowledgement, device loss, epoch-rotation warnings, presence, conflict badges, viewer read-only state, and disable/logout actions that explicitly preserve local notes.

The conflict badge enumerates real Automerge register alternatives. The deterministic harness verifies convergence with five and twenty clients under shuffled delivery. The long soak is opt-in with `CANVINK_SYNC_SOAK_MINUTES=60`; it is intentionally skipped in ordinary CI.

## Encrypted assets

The asset wire format contains only a fixed marker, nonce, signature, and ciphertext. It does not expose the original file name, MIME type, plaintext hash, notebook title, or page content to Storage. Before reservation, the active device signs a separate domain-separated authorization binding notebook ID, device ID, encrypted SHA-256, and encrypted size. The Function verifies that authorization and atomically applies bounded pending counters. The client then sends fixed 3 MiB ciphertext chunks through the Function; it never receives bucket create permission or uploads directly to Storage. Each chunk request includes only opaque IDs, the same signed authorization, chunk position/count, ciphertext, and ciphertext SHA-256. Completion claims a lease, assembles at most 22 private staging objects, re-verifies total size/hash, and seals only the final ciphertext for notebook-team read access. Download reconstruction uses caller-held encrypted document metadata.

Reservation IDs, hash, size, notebook/device identity, and configured bucket must all match. The complete encrypted wire object is capped at the Function's 64 MiB limit. Because AEAD and framing add bytes, the practical plaintext ceiling is slightly below 64 MiB. Change ciphertext is capped at the Function's 4 MiB route limit even though the lower crypto primitive supports larger local payloads.

## Presence and privacy-safe failures

Presence is sent only through Appwrite Realtime Presence with notebook-team read permission. Its bounded metadata is limited to display name, color, page ID, cursor coordinates, and selection offsets. It contains no page text, ink, title, asset name, or persisted content.

`SyncClientError` exposes stable local codes and generic user-facing messages. Appwrite response bodies, user IDs, notebook IDs, encrypted payloads, and server internals are not copied into public errors. Retry uses abort-aware exponential backoff for network/service/rate-limit failures and stops immediately for authentication, authorization, protocol, removal, or key errors.

## Integration and live gates

- Provide the Tauri OAuth URL/deep-link opener and register exact browser/Tauri redirect platforms in Appwrite.
- Exercise the implemented DPAPI keyring reopen, historical/current envelope loader, member/device-removal rotation, redistribution, and recovery-activation composition against a live service.
- Exercise the real deployed Function-proxied staging/final upload, 120-second/512-MiB near-limit assembly, TablesDB Realtime channels, Presence permissions, and Teams removal races in a dedicated non-production project.
- Run the parameterized 60-minute soak, two real Appwrite accounts, target-Windows DPAPI restart, server restoration, key rotation/device approval, 4 MiB change splitting, and near-64 MiB encrypted assets.
- Configure and verify scheduled expired-lease cleanup, quota-counter reconciliation, project-level Function/Storage rate limits and budgets, regional residency, backups, a full restore drill, and monitoring before production.
