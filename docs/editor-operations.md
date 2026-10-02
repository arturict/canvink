# School editor operations

`src/editor/operations` contains pure algorithms for the v2 school editor. The
module depends on the v2 element interfaces only through type imports and does
not mutate page documents, browser state, React components, or Automerge.

## Input and palm rejection

Pointer samples are normalized into bounded stroke samples with finite canvas
coordinates, clamped pressure/tilt, monotonic timestamps, duplicate removal, and
a hard coalesced-event limit. Pen hover/proximity and active pen contact suppress
touch. Mouse input is never suppressed. The UI adapter remains responsible for
calling the policy for pointer enter/down/move/up/cancel/leave events.

## Pen pipeline (quick handwriting)

The page sees one `pointermove` per frame but the digitizer sends several
samples in that time, so every sample is taken from `getCoalescedEvents()`.
Where the browser has `pointerrawupdate` (Chromium, so WebView2), the samples
also arrive one by one ahead of the frame; `SampleDeduper` makes sure a sample
that comes twice is stored once. Predicted events are painted, never stored.

- **Path.** A pen stroke is drawn along a centripetal Catmull-Rom path through
  every sample (`inkPath.ts`): corners stay where the pen turned, there is no
  overshoot, and a tap is a dot. perfect-freehand only builds the outline
  around that path; its own streamlining is off for pens. Mouse and touch
  strokes keep the speed-based width and perfect-freehand's streamlining.
- **Live stroke.** An opaque pen stroke is painted on the overlay a piece at a
  time (`liveStrokePainter.ts`): the settled part of the path stays on the
  canvas, only the provisional tail and the prediction are wiped and repainted
  inside a small device-pixel rectangle. The cost per frame does not grow with
  the stroke. Highlighter, snapped, mouse and touch strokes repaint their whole
  outline.
- **Pen-up.** The stroke is on screen at once; its write to the page (an
  Automerge change, a notebook render, a tile repaint) waits in `InkCommitQueue`
  until the pen has rested for 180 ms, or 16 strokes have gathered, and then
  takes all of them in one change, one undo step each. Every other write, undo,
  redo, key press, tool change and pan flushes the queue first, so the page is
  never behind what was drawn; `pagehide` and unmount flush it as well.
- **Cancel.** A `pointercancel` of a pen or mouse stroke keeps the stroke up to
  its last sample (the position of a cancel event is meaningless).

`tests/e2e/pen-fast-strokes.spec.ts` drives the pipeline with bursts of
coalesced pen events at a quarter of the CPU speed and checks stored samples,
painted ink (sharp tips, taps, the overlay mid-stroke) and the time the pointer
handlers take.

## Selection and transforms

Rectangle and arbitrary polygon lassos use frame polygons, edge intersections,
and even-odd containment, including self-intersecting lassos. Multi-selection
transforms return a new element map, skip locked elements, update frames and
absolute stroke/shape points, and retain pressure/time metadata. Grid, angle,
and infinite-ruler projection helpers are independent of UI state.

## Device-local history

History stores only commands produced by its device. Commands are top-level
field patches. Undo/redo uses three-way matching: a field is reversed only while
its current value still equals the local command value. Remote edits to other
fields are preserved, and a remote edit to the same field wins instead of being
overwritten. Remote commands must never be inserted into local history.

## Clipboard

Clipboard payloads have a versioned format, UTF-8 byte limit, element/node/stroke
point budgets, finite frame/sample checks, known element kinds, unique IDs, and
strict z-order references. Paste remaps element IDs, in-selection
`sourceStrokeId` links, rich-text block IDs, and z-order, then returns a new map.
Assets remain references; no asset bytes or active content are executed here.

## Erasers and merge safety

Whole-stroke erase adds a monotonic tombstone. Point erase also tombstones the
source, splits surviving original samples into new immutable strokes, preserves
pressure/tilt/time, enforces a minimum sample count, and links every segment to
the root `sourceStrokeId`. Repeating erase on a tombstoned source is idempotent.
`reconcileStrokeTombstone` provides the essential merge invariant: if either
version is tombstoned, a newer stale live version cannot resurrect it.

The integration layer must commit the source tombstone and every surviving
segment in one Automerge change. It must use collision-resistant locally unique
IDs, persist local history separately from shared CRDT history, and validate
clipboard-created elements with the canonical v2 document validator before
storage. UI wiring, rendering, Automerge transactions, and platform clipboard
permissions remain out of scope.

