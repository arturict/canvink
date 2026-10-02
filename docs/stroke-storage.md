# Stroke storage: ink segments and packed samples

Status: **ink segments** hold committed ink since 2026-09-30 (this section).
The packed form below is the encoding of a stroke's samples inside a segment,
and it still applies to strokes a page document holds itself (overrides, older
pages, packed-form imports before this change). Every build reads all forms.

## Ink segments

A page document keeps every Automerge operation it ever had. Even packed, a
stroke costs about 90 operations for its string fields and its `zOrder` entry,
and those operations stay in the document's history when the stroke is erased
or moved. Opening a page with 7,000 strokes loaded 712,000 operations
(about 1 s), and ink drawn live only made the history longer.

Committed ink therefore lives outside the document, in immutable binary
**segments**: a blob of many strokes (id, style, times, frame and packed
samples, `src/ink/segmentCodec.ts`, about 75 bytes per stroke) addressed by the
SHA-256 of its bytes. A page document holds only references:

- one root field `ink:<hash>` per segment (`{ strokes, bytes, dead }`), one
  field each so that two devices that add their first segment at the same time
  keep both; `dead` lists ids of that segment's strokes that were erased or
  replaced, and is created with the segment so concurrent erases merge;
- a `zOrder` entry `ink:<hash>` (a slot): the segment's strokes are drawn there,
  in the segment's order;
- ordinary stroke elements for anything the editor writes with
  `holdNewInk: false` (tests, older code paths).

Snapshots expand all of it back into `elementsById` and `zOrder`
(`src/ink/projection.ts`), so the renderer, hit testing, export, search, undo
and the clipboard see the stroke elements they always saw.

**Live ink.** A stroke drawn in the editor does not touch the document. It
joins the page's *pending* strokes (`src/ink/pendingInk.ts`): held in memory and
in a journal record in local storage, shown on top of the page immediately. After
the pen has rested for 1.5 s (or 200 strokes), `sealPendingInk` encodes them
into a segment, stores the blob durably, and writes the reference and the slot
in one small document change (about 100 operations, 450 bytes). Erasing a
pending stroke writes nothing. Moving, recolouring or erasing a stroke that is
already in a segment writes a `dead` marker for its old copy and, for a move,
draws the new state as pending ink (a lasso move of 100 strokes: 16 ms and
1.3 KB, packed: 72 ms and 16.5 KB). The app seals before a save, an export, a
history checkpoint, evicting a page and shutting down; after a crash the
journal is sealed on the next start.

**Compaction.** At rest (8 s after a change) a segment that lost at least 30 %
of its strokes is rewritten, and runs of small neighbours are merged into one of
at most 1,000 strokes (`compactPageInk`); the slot and reference are replaced in
one change. The old blobs stay in the local store and in R2 (no garbage
collection yet).

**Sync.** Segments are stored and synced like assets: the local store
(`canvink-ink-segments` in IndexedDB, own database) and R2 through the
personal-space asset routes, `HEAD` before `PUT`, so identical segments are
uploaded once (`src/personal-space/assets/inkSegmentSync.ts`; the Worker needs no
change, it verifies the hash). A device that receives a page document fetches the
segments it lacks, verifies them against their address, and retries for a few
minutes if the cloud does not hold them yet (the uploading device sends them a
moment after the document change). Until they arrive the page shows no ink for
them; a page never shows a wrong stroke. Segments travel through `.canvink`
bundles and backups as assets of MIME type `application/vnd.canvink.ink-segment`.

**Merge behaviour.** Two devices that add ink keep both segments (distinct keys,
distinct slots). Erase and move merge through the per-segment `dead` maps. Known
limits: sealing the same strokes on two devices at once gives two identical
segments whose duplicates the projection removes; an erase that races with a
compaction of the same segment can show the stroke again; the depth of an
undone erase or a moved stroke inside a segment is approximated (it is drawn
above the page's other ink).

**Existing pages.** Nothing is rewritten in bulk on the spot, but legacy pages are rebuilt in the
background (`src/ink/legacyRebuild.ts`). An Automerge document cannot forget its history, so a page
written in the older forms only gets fast to open when it is written as a new document. The job does
that in place: the page keeps its page id, its place in its section, its sub-page level, its tags
(pins, templates) and its title; only the document behind it is new, with a generation suffix on
its document id (`page:x` becomes `page:x~r1`). It runs for pages whose stored document is at least
40 KB, one at a time, when nothing has been touched for 15 s and the personal space, if there is one,
has caught up; recently opened pages come first, then the heaviest. A legacy page the user opens is
rebuilt as soon as the pen has been still for a moment.

The steps are the ones of the "Neu aufbauen" action: build a copy with its ink in segments, take the
swap only if the original did not change meanwhile, replace the list entry of the notebook (same
index), read the copy back and compare it with the original stroke by stroke, and revert (original
back in its place, copy removed) if it does not match. The original stays, hidden (a notebook lists
one document per page), until the copy's segments are in the cloud and a short grace period has
passed; then it is dropped and a `swap:<new>` field in the notebook makes every other device retire
the original from the personal space. Nothing appears in the page list or the trash.

Exactly one device rebuilds a given page. A claim in the notebook document, one root field per
device and page (`rebuild:<page document>:<device>` with a time and an expiry of 15 minutes), decides:
the earliest unexpired claim wins, ties go to the lowest device id, and every device reads the same
rule, so they agree without talking. A device claims, waits two seconds for a rival claim to arrive,
checks that it still wins, and checks again inside the swap change itself. A device that went away
mid-rebuild stops blocking the page once its claim expires. Concurrent claims merge into several
claims (distinct fields), never one overwriting the other. A device that is offline for longer than
the expiry could still race a rival; the outcome is then a duplicate page, not lost ink.

Imports, copies and restored pages are built with segments from the start; "Neu aufbauen" in the page
menu does the same by hand and moves the original to the trash.

**Shared rooms.** Shared notebooks (collab rooms) carry segments too. The Worker gained
`HEAD|GET|PUT /api/v1/rooms/:roomId/assets/:sha256`: blobs stored under `rooms/<roomId>/` in the same
R2 bucket as the personal assets, checked against their hash, readable with any credential the room
accepts (owner token, link secret, registered collaborator) and writable by the owner and
collaborators, not by link viewers; 16 MiB per object and 512 MiB per room, removed with the room. A
blob that is not stored answers 204, not 404, because the owner uploads a moment after the page
document reaches the others. The owner's device uploads every segment the notebook's pages reference
(`src/collab/roomInkSync.ts`, only while its room session is live); a member's app fetches what its
pages reference with its own credential and retries until the owner has uploaded. Strokes drawn on a
page of a shared notebook (owner or member) are written into the page document at once, not held as
pending ink, so members see them as they are drawn; only ink that already lives in segments needs the
room's blobs.

**Older builds.** A build without this change does not know segments: it opens the
document, drops the slots it cannot find elements for and shows the page without
that ink. Update every device (the web app, installed desktop builds) before
ink drawn with this build is opened elsewhere. Team sync through Appwrite carries documents
only, not segments.

### Numbers

Measured on dev-t15 (6 vCPU VM, quiet), a synthetic page shaped like bm's worst
pages: 7,000 strokes of 10 samples, medians of 3 runs, each phase in a fresh Node
process (`scripts/bench/stroke-format-bench.ts`), import-shaped data (constant
pressure) first, live-pen data in brackets.

| | packed (before) | segments |
| --- | --- | --- |
| page document | 790,561 B (1,032,686 B) | 1,748 B (1,742 B) |
| Automerge operations | 711,944 | 675 |
| whole page to an empty peer | 790,774 B, 2,020 ms | 518,157 B (812,048 B) in a document and 7 segments, 14 ms + 54 ms to fetch and verify |
| open: load, segments, first snapshot | 991 ms (1,025 ms) | 79 ms (87 ms) |
| create the document (import) | 2,252 ms | 134 ms |
| add a stroke: time in the editor's write | 9.5 ms, 710 B | 2.1 ms, nothing in the document |
| seal 20 pending strokes | | 9.9 ms, 456 B, 98 operations |
| lasso move of 100 strokes | 71.8 ms, 16.5 KB | 16 ms, 1.3 KB |
| page drawn live, 7,000 strokes in bursts of 30 | (about 800 KB document) | document 43.5 KB, 36,747 operations, open 44 ms |

Drawn live the segments churn: 421 blobs (2.0 MB, 3.1 MB with live-pen samples)
for 7,000 strokes, because merging small neighbours rewrites them; the document
stays small, R2 receives a few hundred small objects.

In the browser (`scripts/heavy-page-bench.mjs`, seeded workspace with one
7,000-stroke page, fresh profiles, medians of 3, dev-t15):

| | before | after |
| --- | --- | --- |
| first open, ink complete | 958 ms | 252 ms |
| longest main-thread task while opening | 800 ms | 64 ms |
| main-thread blocking while opening (over 50 ms) | 764 ms | 14 ms |
| switching to the page, first ink (from the cached raster) | about 990 ms | 75 ms |
| after a restart, first ink from the cached raster | about 1,450 ms | 118 ms |
| after a restart, real ink complete | | 610 ms (app start 530 ms of it) |
| search for a word on the page while the index builds | 806 ms | 89 ms |

Drawing a stroke on the heavy page (`scripts/editing-bench.mjs`, ink scenario):
pointer up to paint 26.5 ms before, 16.5 ms after, no long task before or after.
A whole bm-shaped workspace (398 pages, 204,502 strokes, seed generator) is
seeded in 4.2 s instead of 81.7 s and takes 21.1 MB instead of 23.1 MB.

## Packed samples

Status: **on** since 2026-09-30. `STROKE_WRITE_FORMAT` in
`src/crdt/strokeStorage.ts` is `'packed'`, so new strokes, rewrites and imports are
packed. Every build reads both forms. Canvink had no users when it was switched on,
so the two-step release described below was skipped on purpose: builds from before
the reader cannot edit packed pages.

## Why

An ink stroke is stored as `points: [{x, y, pressure, tiltX, tiltY, time, pointerType}, ...]`.
Automerge keeps every field of every sample as its own operation, and every
string (`id`, `kind`, `tool`, `color`, `createdAt`, `updatedAt`, and each id in
`zOrder`) as a text object with one operation per character. bm's worst pages
hold about 7,000 strokes of ten samples, which is 1.48 million operations for
one page. That is what makes a document large, slow to create (an import),
slow to load and slow to sync.

## What is stored

With the switch on, a stroke keeps all its other fields as they are and swaps
`points` for `packedPoints`, one Automerge byte string
(`src/crdt/packedStrokePoints.ts`):

- positions as zig-zag varint deltas at 1/128 page unit;
- pressure in 254 steps (0, 0.5 and 1 are exact), one byte for the whole
  stroke when it is constant (mouse, OneNote import);
- tilt in whole degrees and time in milliseconds, present only when non-zero;
- one pointer type per stroke; a version byte and flags in front.

A typical stroke of ten samples takes about 40 to 50 bytes and one operation
instead of about 70. A stroke the format cannot hold within that precision
(pressure outside 0 to 1, mixed pointer types, non-finite or huge values) stays
a plain `points` list, so packing never loses more than the stated precision.
Unpacking what was packed returns identical samples, so repeated writes do not
drift.

Readers never see `packedPoints`. Everything that turns an Automerge document
into a snapshot (`getAutomergeSnapshot`, `getAutomergeSnapshotAt`,
`getAutomergeHistory`, and the shared snapshot the editor uses) restores the
`points` list, so the renderer, hit testing, export, search, clipboard and undo
keep their input type. The shared snapshot decodes a byte string once and reuses
the list until those bytes change.

Writers that use the switch: `createAutomergeDocument` (an import builds its
pages this way), and `applyPageElementChanges` for created strokes and rewritten
samples. A stroke whose samples did not change keeps the form it has, so
changing a colour does not migrate it.

## Numbers

Synthetic page shaped like bm's worst pages: 7,000 strokes of 10 samples,
double-precision coordinates, constant pressure, no tilt or time (as OneNote
import writes them). Medians of 5 runs (3 for edit and sync; the create and open
rows are two batches of 5 and show both), each phase in a
fresh Node 24 process on dev-t15 (6 vCPU, load about 2). Script:
`scripts/bench/stroke-format-bench.ts`.

| | points (today) | packed | change |
| --- | --- | --- | --- |
| Automerge operations | 1,481,944 | 711,944 | 2.1x fewer |
| document bytes | 2,481,130 | 911,980 | 2.7x smaller |
| create the document (import apply) | 21.1 to 21.9 s | 2.6 to 3.6 s | 6 to 8x faster |
| peak memory while creating | 1,482 MB | 526 MB | 2.8x less |
| load and first snapshot | 2.6 to 3.0 s | 1.1 to 1.4 s | 2 to 2.7x faster |
| peak memory after opening | 544 MB | 295 MB | 1.8x less |
| add one stroke: time / change size | 15.9 ms / 1,945 B | 15.1 ms / 710 B | time equal |
| move 100 strokes: time / change size | 228 ms / 139 KB | 73 ms / 16.5 KB | 3.1x / 8.4x |
| sync a whole page to an empty peer | 2.48 MB, 15.4 s | 0.91 MB, 2.0 s | 2.7x / 7.7x |
| apply one stroke on a peer | 155 ms | 52 ms | 3x |

A live pen (varying pressure, tilt, timestamps) gives 3.60 MB against 1.15 MB,
create 22.3 s against 4.2 s, open 2.85 s against 1.57 s.

In the browser (`scripts/heavy-page-bench.mjs`, seeded workspace with one
7,000-stroke page, medians of 3 fresh profiles on dev-t15): the page's ink is
complete after 1,025 ms instead of 2,394 ms, main-thread blocking during the
open falls from 2,207 ms to 843 ms, and searching a word on the heavy page while
the index builds answers in 1.4 s instead of 2.3 s. Generating the seed itself
took 21 s and now takes 3 s.

The real import path (`scripts/onenote-import-bench.mjs`, headless Chromium,
a synthetic OneNote export of a quarter of bm: 100 pages, 51,000 strokes,
439,000 samples, 2 runs each): the import took 64.7 s and 62.4 s with today's
storage and 19.0 s and 23.7 s packed, of which the Automerge write phase went
from 58.6 s and 56.5 s to 16.0 s and 19.9 s. Peak WebAssembly memory fell from
695 MB to 354 MB and peak JS heap from 170 MB to 101 MB, and the staged bytes
from 14.6 MB to 6.9 MB. bm itself is four times larger; 6.7 minutes would
become roughly two minutes if the ratio holds (extrapolated, not measured).

### Where the rest of the cost is

After packing, 712,000 operations remain, about 90 per stroke, and they are the
strings: `id`, `kind`, `tool`, `color`, two ISO timestamps (about 75 characters)
plus the 7,000 ids in `zOrder`. Two ceilings that are **not** in the app show
what removing them would buy (same page, plain Automerge load and toJS):

| page of 7,000 strokes | operations | bytes | create (one change) | peak memory creating | Automerge load, then toJS |
| --- | --- | --- | --- | --- | --- |
| points (today) | 1,481,944 | 2.48 MB | 21.1 s | 1,481 MB | 2.18 s, 1.28 s |
| packed (implemented) | 711,944 | 0.91 MB | 3.6 s | 522 MB | 0.99 s, 0.42 s |
| packed, strings as immutable scalars | 126,002 | 0.52 MB | 2.8 s | 361 MB | 0.70 s, 0.45 s |
| one byte string per stroke | 82,892 | 0.68 MB | 0.83 s | 216 MB | 0.31 s, 0.09 s |

Storing those strings as immutable scalar strings (`Automerge.ImmutableString`)
removes most operations but reads back as an object, not a string, so every raw
reader would need a conversion (and the `id` check of the integrity test would
need one too). Storing a whole stroke as one byte string cuts
create time and memory again and is the fastest variant, but it gives up
per-field merging of a stroke (below). Neither is implemented; both are
candidates if packed points alone are not enough. Add-stroke time is about
15 ms in both forms, so it is dominated by Automerge's cost for the size of the
document, not by the stroke.

## Trade-offs

**Merge semantics.** The editor already writes a stroke's samples as a whole:
a transform replaces the whole `points` list, so two concurrent moves of one
stroke already end with one winner's samples and never a mix. Packing keeps that
(last writer wins on `packedPoints`, the loser stays visible as an Automerge
conflict) and keeps per-field merging of everything else: a concurrent recolour
and move of the same stroke both survive (covered by a test). What is lost is
merging edits to single samples of one stroke, which no code path does.
Concurrent edits of one stroke by a writer on `points` and one on `packedPoints`
leave both keys; readers prefer `packedPoints`.

**Whole-stroke transforms.** A move or scale by lasso rewrites the samples of
each stroke (as today), now as one byte string per stroke: 100 strokes cost
16.5 KB instead of 139 KB. No transform is stored beside the samples, because
that would need a second coordinate space in the renderer and hit testing.
Repeated moves re-round to the 1/128 grid each time; the error per write is at
most 1/256 unit and does not accumulate systematically.

**Quantization.** Positions to 1/128 unit (0.008 px at 100 %), pressure to 0.4 %,
tilt to 1 degree, time to 1 ms. Fractional milliseconds are dropped; stored time
is not used for drawing. The limits are asserted in
`src/crdt/packedStrokePoints.test.ts`.

**Undo and redo.** Local history only reverts an element that still equals what
its command wrote. With packed strokes the document holds rounded samples, so a
command that remembered the raw pointer values would not undo (found by the
canvas-tools e2e). `recordLocalCommand` therefore rounds the samples in its
patches to the stored precision (`withStoredPrecision`); the switch off makes it
the identity. History itself stays in memory as decoded elements.

**Older builds, the live web app and collaborators.** This is the real risk. A
build without this change opens a page with a packed stroke, finds a stroke
without `points`, and fails in rendering. This was read from the code of the current build, not run
against the deployed web app: the integrity check only looks at a stroke's
`kind`, so the document opens, and the code that draws or moves a stroke reads
`points` without checking that it exists. The failing operation writes nothing. That holds for
any deployed web app until it is updated, for installed
desktop and Android builds, for a collaborator on an older version of a shared
room, and for a device that receives packed strokes over personal-space sync.
There is no handshake that tells a writer which peers can read the new form.
The switch must therefore stay off until **every** client that can open the
notebook contains the reader. Suggested order: release the reader with the
switch off, wait until the web app and all devices run it, then flip the
switch in a later release. A schema bump (v4) would make old builds refuse the
document instead of failing in the renderer, at the price of the manifest and
activation migration; it is not part of this change.

A build with this change reading a *future* packed version fails closed with an
error naming the stroke, not with wrong ink.

**Migration.** There is no bulk migration and none is needed for correctness.
New strokes and rewritten samples are packed once the switch is on; imports and
copied or restored pages are built fresh, so they are packed. `convertPageStrokes`
converts a page draft in either direction inside one Automerge change. Converting
an existing page in place does not make it smaller, because Automerge keeps the
old operations in the history; only a document that is built fresh from a
snapshot (an import, a restored copy) sheds them. Re-importing bm, or a
"rebuild page" action that reuses the page-restore path, is what makes existing
heavy pages fast.

**Rollback.** Set the switch back to `'points'`: new strokes and rewrites are
lists again and everything already stored stays readable. Data written packed
stays packed until rewritten; `convertPageStrokes(draft, 'points')` turns a page
back (older builds can then open it again, and the history grows by the
conversion). Because an older build cannot read packed strokes, rollback protects
new data but does not reopen pages that were already written packed on a device
that has not been converted.

## Enabling it

Done on 2026-09-30 in one step, without the staged release, because no one else
used Canvink yet. Existing test data only gets the gains when it is re-imported.
