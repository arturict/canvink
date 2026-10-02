# Canvink portable bundle format v2

## Status and scope

Format version `2` is Canvink's portable `.canvink` interchange container. It
keeps the notebook document, individual page documents, and original binary
assets together without embedding assets as data URLs. The container is meant
for backup, transfer, inspection, and a later transactional v1-to-v2 migration.

The bundle layer does not define the internal CRDT schema. Notebook and page
documents are opaque bytes identified by a MIME type, byte size, and SHA-256
digest. The current default MIME types reserve Automerge payloads:

- `application/vnd.canvink.notebook+automerge`
- `application/vnd.canvink.page+automerge`

Format v2 is not encryption, cloud sync, a SQLite backup, or an assurance that
the current UI can render every declared MIME type. A reader must validate a
complete bundle before offering it as an import candidate.

## Container profile

A `.canvink` file is a deterministic ZIP32 archive using a deliberately small
profile:

- Entries use ZIP method `0` (stored, no compression).
- General-purpose flag `0x0800` marks UTF-8 names. Encryption and data
  descriptors are forbidden.
- ZIP64, split archives, archive comments, entry comments, and extra fields are
  forbidden.
- Paths are printable ASCII, relative, slash-separated paths. Empty, `.`, `..`,
  absolute, and backslash components are rejected.
- CRC-32 is present in both headers and verified before manifest processing.
- The deterministic DOS timestamp is `1980-01-01 00:00:00` for every entry.
- Local entries are contiguous and in the same order as the central directory.
  Gaps, overlaps, duplicate paths, and trailing data are rejected.

Storing entries without compression makes their declared size equal to the
actual allocation size. This lets a reader enforce bounds before copying data
and avoids decompression bombs. General ZIP tools can still inspect or extract
the archive. A generic ZIP file with the same filenames is not necessarily a
valid `.canvink` bundle if it does not follow this profile.

Canonical entry order is:

1. `manifest.json`
2. `documents/notebook.bin`
3. `documents/pages/00000000.bin`, then subsequent pages in manifest order
4. `assets/<lowercase-sha256>`, sorted by digest

The manifest is pretty-printed UTF-8 JSON with a final newline. Identical
normalized input, including `createdAt` and `generator`, produces identical
bundle bytes.

## Manifest

The following example is shortened but structurally complete:

```json
{
  "format": "canvink",
  "formatVersion": 2,
  "createdAt": "2026-08-03T12:34:56.000Z",
  "generator": "Canvink 0.2.0",
  "notebook": {
    "id": "notebook-018f...",
    "document": {
      "path": "documents/notebook.bin",
      "mimeType": "application/vnd.canvink.notebook+automerge",
      "size": 14208,
      "sha256": "64 lowercase hexadecimal characters"
    }
  },
  "pages": [
    {
      "id": "page-018f...",
      "document": {
        "path": "documents/pages/00000000.bin",
        "mimeType": "application/vnd.canvink.page+automerge",
        "size": 8124,
        "sha256": "64 lowercase hexadecimal characters"
      }
    }
  ],
  "assets": [
    {
      "id": "sha256:<same digest as sha256>",
      "path": "assets/<same digest as sha256>",
      "mimeType": "application/pdf",
      "size": 1048576,
      "sha256": "64 lowercase hexadecimal characters",
      "originalNames": ["worksheet.pdf"]
    }
  ]
}
```

Core rules:

- `format` is exactly `canvink`; `formatVersion` is exactly the integer `2`.
- `createdAt` is a valid ISO 8601 UTC timestamp. `generator` is optional and is
  informational only.
- IDs are non-empty, case-sensitive, opaque strings without control characters.
- MIME types are canonical lowercase `type/subtype` tokens without parameters.
- Each payload descriptor records the canonical archive path, exact byte size,
  MIME type, and lowercase SHA-256 digest.
- Page IDs are unique. Page array order is significant and determines the
  zero-padded document path.
- An asset ID is `sha256:<digest>`. Its path is `assets/<digest>`.
- `originalNames` contains sorted, unique basenames only. Directory components
  are removed on export and are never trusted as extraction paths.
- Every archive entry is referenced exactly once by the manifest, except
  `manifest.json`. Missing, duplicate, or unreferenced entries invalidate the
  entire bundle.

## Asset identity and deduplication

Asset identity is the SHA-256 digest of the original bytes. Export computes the
digest, sorts assets by it, and emits one binary entry for all identical inputs.
Distinct original basenames are merged into the sorted `originalNames` array.

Identical bytes declared with conflicting MIME types make export fail. The
writer does not choose one type based on input order. Although a SHA-256
collision is not expected in practice, the exporter also compares bytes before
deduplicating two in-memory inputs with the same digest.

The bundle stores original asset bytes. Previews, OCR text, and search
projections should either be represented by a documented page/notebook schema
or rebuilt after import; they must not silently replace an original asset.

## Import limits

The reference TypeScript reader applies these defaults before returning data:

| Limit | Default |
| --- | ---: |
| Bundle bytes | 256 MiB |
| Manifest bytes | 4 MiB |
| ZIP entries | 20,002 |
| Page documents | 10,000 |
| Assets | 10,000 |
| One document | 32 MiB |
| One asset | 64 MiB |
| Total uncompressed bytes | 512 MiB |
| One identifier | 16 KiB UTF-8 |
| Original names per asset | 64 |

An embedding application may lower these bounds for a constrained device or
raise them through an explicit policy decision. Limit values must remain
positive safe integers. MIME-specific parsing, image pixel limits, PDF page
limits, active-content blocking, and CRDT schema validation remain required in
their respective layers after container verification.

## Verification and safe import

A reader performs the following work before exposing an import candidate:

1. Bound the whole file and validate the canonical ZIP32 structure.
2. Bound entry counts and cumulative stored bytes, then verify every CRC-32.
3. Parse bounded, strict UTF-8 manifest JSON and reject unsupported versions.
4. Validate IDs, canonical paths, MIME types, sizes, counts, and asset order.
5. Resolve every declared payload exactly once and enforce its per-entry limit.
6. Compute and compare SHA-256 for notebook, page, and asset bytes.
7. Reject missing, duplicate, or unreferenced archive entries.
8. Return a complete in-memory import candidate with copied bytes.

`readCanvinkBundle` has no workspace, database, or UI parameter and performs no
state mutation. The application must stage its returned candidate, validate the
document schemas and MIME-specific contents, create a recoverable backup, and
commit all imported records atomically. Any error before that commit leaves the
existing notebook unchanged. Import must never normalize a malformed bundle to
an empty notebook and save it over current state.

## Compatibility

Readers reject unknown format versions rather than attempting a best-effort
conversion. Future additions that change canonical paths, payload meaning, or
lossless round-tripping require a new format version and a documented,
transactional migration. Schema v1 JSON exports remain governed by
`file-format-v1.md`; wrapping an unconverted v1 JSON file in this ZIP layout
does not make it a v2 bundle.
