# Canvink sync cryptography protocol v1

Status: implemented core, not yet an end-to-end production sync deployment.

This document specifies the browser-safe cryptographic core in `src/sync/crypto`. It intentionally does not define a server escrow key, password-derived notebook key, plaintext recovery service, or a claim that rotating a key revokes data already received by a device.

## Primitive suite and byte sizes

All operations use `libsodium-wrappers-sumo` 0.8.4 after `sodium.ready`:

| Purpose | Primitive | Exact size |
| --- | --- | ---: |
| Device/recovery agreement key | X25519 (`crypto_box_seed_keypair`, `crypto_scalarmult`) | 32-byte public and private keys |
| Device/recovery signing key | Ed25519 | 32-byte public, 64-byte private, 64-byte signature |
| Notebook epoch key | Random symmetric key | 32 bytes |
| Payload encryption | XChaCha20-Poly1305-IETF | 32-byte key, 24-byte nonce, 16-byte tag |
| Content/change digest | SHA-256 | 32 bytes |
| Envelope wrapping-key derivation | keyed BLAKE2b (`crypto_generichash`) | 32 bytes |

Random nonces and keys come from Sodium. A caller-supplied nonce or seed is accepted only for deterministic tests or restoring an already persisted identity, and must have the exact required size. Production callers must never reuse a nonce with the same symmetric key.

## Canonical authenticated encoding

AAD and signed values are binary, not JSON. `canonicalEncode` emits:

1. a four-byte big-endian domain length and UTF-8 domain;
2. a four-byte big-endian field count;
3. for every field in its specified order: four-byte name length, UTF-8 name, four-byte value length, and value bytes.

Integers are unsigned, eight-byte big-endian values. Field names cannot repeat. Text cannot be empty or contain NUL. IDs are additionally capped at 256 UTF-8 bytes by protocol validation. This encoding prevents concatenation ambiguity and gives every use a distinct domain.

The implemented domains are:

- `canvink/change-aad/v1` and `canvink/change-signature/v1`
- `canvink/asset-aad/v1` and `canvink/asset-signature/v1`
- `canvink/notebook-key-envelope-aad/v1` and `canvink/notebook-key-envelope-signature/v1`
- `canvink/device-approval-challenge/v1` and `canvink/device-approval-proof/v1`
- `canvink/recovery-code-checksum/v1` and `canvink/recovery-key-id/v1`

Signatures cover a domain-separated encoding of the complete AAD, nonce, and ciphertext. Verification happens before decryption. Authentication and hash checks use Sodium, including constant-time comparison for fixed-size hashes and key identity checks.

## Device identities

A device has independent X25519 encryption and Ed25519 signing key pairs plus an `accountId` and `deviceId`. `toJSON()` returns public identity only. Private keys are never part of a sync protocol type or serialization method.

The core can create or restore identities from two 32-byte seeds. Persisting those seeds/private keys safely is an integration responsibility. `destroyDeviceIdentity()` zeroes the owned private-key arrays and marks the identity unusable. JavaScript garbage collection and copied strings mean this is best-effort process-memory hygiene, not a guarantee that every historical runtime copy is erased.

## Changes

The change plaintext limit is 16 MiB. The AAD binds:

- protocol version;
- notebook ID and document ID;
- sender device ID;
- notebook key epoch;
- SHA-256 of the plaintext Automerge change.

The resulting pending envelope has `sequence: null`. The trusted sync service may assign a positive notebook-global `sequence` without invalidating the signature because sequence is deliberately excluded from client AAD and signatures. This is the only mutable field. The inbox rejects repeated change hashes, duplicate/conflicting sequences, gaps beyond its bounded buffer, and replays after commit. Crypto verification and CRDT application must succeed before advancing the durable cursor.

## Assets

The asset plaintext limit is 64 MiB. Its ID is exactly `sha256:<lowercase hex digest>`. AAD binds protocol version, notebook ID, asset ID, normalized MIME type, uploader device ID, key epoch, plaintext size, and plaintext hash. Decryption checks the signature, AEAD tag, exact declared size, digest, and asset ID.

The whole-buffer API enforces a hard limit but is not a streaming encryption format. Larger assets require a separately versioned chunked protocol rather than raising this limit.

## Notebook key envelopes

Each notebook epoch owns an independent random 32-byte key. To wrap it, the sender computes X25519 with its device private key and the recipient public key, then derives a 32-byte wrapping key with keyed BLAKE2b over the envelope AAD. The notebook key is encrypted with XChaCha20-Poly1305, producing exactly 48 ciphertext bytes.

Envelope metadata and signatures bind:

- protocol version, notebook ID, and epoch;
- sender device ID and sender X25519 public key;
- recipient kind and identifier;
- the exact recipient X25519 public key;
- nonce and wrapped ciphertext.

Recipient kinds are:

- `device`: one named device;
- `account`: an account envelope encrypted to one concrete enrolled device key (the account ID and concrete public key are both bound);
- `recovery`: a named recovery public key.

There is no account-wide magical decryption key. To grant another account device access, create another envelope for that device or complete the approval/enrollment flow and then wrap the current epoch key.

## Recovery

A recovery kit contains a random 32-byte seed and an eight-byte SHA-256-based checksum, encoded as `CNVK-R1-<64 lowercase hex seed>-<16 lowercase hex checksum>`. The seed creates the X25519 recovery identity and, through the domain-separated `canvink/recovery-signing-seed/v1` hash, a distinct Ed25519 recovery signing identity. Recovery envelopes bind both public keys. `reveal()` returns the code once and immediately wipes the kit's byte arrays. The returned JavaScript string cannot be reliably zeroized; the UI must show it only at an explicit recovery-code step, prevent telemetry/clipboard logging, and instruct the owner to store it offline.

Parsing verifies the checksum with constant-time comparison and reconstructs both recovery identities. Recovery envelopes are ordinary signed notebook-key envelopes addressed to the X25519 key. Server activation uses a separate Ed25519 signature over the existing short-lived device challenge in `canvink/recovery-device-activation-proof/v1`; `/activateDeviceWithRecovery` atomically consumes that challenge and never treats X25519 as a signature primitive. Losing the code and all enrolled device keys makes the notebook key unrecoverable. Canvink has no hidden escrow path.

## Existing-device approval

An enrollment challenge binds the notebook, account, requesting device ID, both requesting public keys, a random 32-byte nonce, `issuedAt`, and `expiresAt`. The maximum validity window is ten minutes and the default is five. An existing device on the same account signs the challenge hash in the approval-proof domain. Verification checks the account/device metadata, validity window, challenge hash, and Ed25519 signature.

This is cryptographic proof only. The network integration must authenticate both devices, atomically consume each challenge nonce once, enforce account/notebook authorization, record the approved device, and deliver a current-epoch key envelope. Without that server-side one-time consume operation, a valid proof can be replayed during its short validity window.

## Epoch rotation and device removal

`NotebookKeyring.rotate()` creates a fresh epoch and key. New changes/assets use the new epoch. Old keys may remain locally available so historical ciphertext can still be read, or can be explicitly forgotten and zeroed.

Removing a device requires an authoritative membership change plus rotation and new current-epoch envelopes only for remaining devices. Rotation prevents a removed device from decrypting future data only if it does not receive the new key. It cannot revoke plaintext or old epoch keys the device already possessed. The core does not claim otherwise.

## Typed failures and validation limits

Crypto APIs throw `CryptoProtocolError` with stable codes for invalid inputs, byte limits, bad signatures, authentication failure, hash mismatch, wrong sender/recipient/epoch, missing keys, invalid or consumed recovery codes, invalid approvals, unavailable Sodium, and destroyed secrets. Protocol validators require exact 32-byte hashes/public keys, 24-byte nonces, 64-byte signatures, positive epochs, and ciphertext limits before state machines accept values.

Plaintext, notebook keys, private keys, shared secrets, derived wrapping keys, and canonical buffers containing secret key material are never logged or serialized by this module. Owned temporary secret byte arrays are zeroed in `finally` paths. Callers remain responsible for wiping returned plaintext and key copies after use.

## Required integration work

The following are explicit release gaps, not features supplied by this core:

- **Windows at-rest protection:** persist device private material using a narrow Tauri command backed by Windows DPAPI (or equivalent OS keystore), with correct user/machine scope, ACLs, atomic replacement, and migration/recovery behavior. IndexedDB or local storage alone is not acceptable for raw private keys.
- **UI lifecycle:** explicit device naming, enrollment confirmation, recovery-code reveal/confirmation, destructive remove/rotate warnings, key-loss states, and safe redaction from errors, screenshots, analytics, and clipboard history.
- **Network authority:** authenticated account/notebook membership, public-key registration, one-time approval challenge consumption, monotonic sequence assignment, envelope distribution, bounded replay retention, rotation coordination, and audit events containing metadata only.
- **Native/mobile keystores:** equivalent protected persistence and memory-lifecycle review per platform before those clients can participate.
- **Operational review:** protocol interoperability fixtures, dependency/audit policy, rate limits, denial-of-service tests, and an external cryptographic/security review before calling encrypted sync production-ready.
