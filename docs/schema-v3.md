# Canvink schema v3: Math Canvas

Schema v3 extends the per-notebook and per-page Automerge model with local-first
mathematics. It does not replace or reinterpret the historical v1-to-v2
migration. A workspace that is only opened remains at v2; the first operation
that writes current-schema data upgrades the complete activated document graph
to v3 in one checked storage revision.

## Compatibility contract

- Readers accept schema v2 and v3. Writers create v3 documents and v3 bundles.
- The v2-to-v3 migration preserves every existing document, element, asset,
  ordering entry, trash record, Automerge payload, and page background.
- Manifest, activation, notebook documents, and page documents must all name the
  same schema. Mixed graphs, downgrades, and partial upgrades fail closed.
- A v2 page may omit math settings after migration. Readers apply immutable
  defaults until the page is next written.
- Older releases reject a v3 workspace with an incompatibility error. They must
  never open it as v2 and discard unknown elements.

## Page model

The existing page model remains authoritative:

```text
PageDocV3
├── existing metadata and page background
├── optional MathPageSettings
├── elementsById
│   ├── existing v2 elements
│   ├── MathElement
│   └── GraphElement
└── zOrder
```

`MathPageSettings` stores result mode, exact/decimal number mode, angle mode,
and the page default for automatic recognition. The existing page background is
still the single source of truth for blank, ruled, grid, and other page styles.

A `MathElement` stores its frame, input kind, immutable copies of selected raw
ink, typed/recognized/corrected LaTeX, recognition state, derived result, and
variable dependencies. Corrected LaTeX and results never replace raw ink.
Provider and model versions may be recorded as bounded provenance. Credentials,
provider endpoints, request IDs, and provider configuration are forbidden.

A `GraphElement` stores only source Math-element references, visible series,
colors, and viewport/axis state. Sampled points are derived locally and are not
canonical document data.

## Privacy boundary

Lossless workspace, bundle, history, clipboard, and portable current-schema
JSON paths retain Math-block strokes and formulas. That data is notebook content
and is required for recovery. Provider secrets live only in the native operating
system credential boundary and are excluded from documents, exports, history,
search, logs, telemetry, and sync configuration.

Recognition is not a document side effect. Only an active local Math block or an
explicit local selection may create a recognition request. Opening, importing,
restoring, replaying, or synchronizing a Math element never does so.

## Limits and validation

Schema validation is closed and budgeted. It bounds strings, collections,
raw-ink strokes and points, Math alternatives and warnings, graph series and
viewports, trash records, and cross-element references. Graph sources must name
Math elements on the same page. Non-finite geometry, duplicate identifiers,
unknown properties, secret-shaped fields, and broken references fail before an
activation or portable import is accepted.

The executable validation and migration contracts live in
`src/domain/v3/validation.ts` and `src/domain/v3/migration.ts`. The storage and
Automerge dual-reader contract is exercised by the focused CRDT, workspace,
bundle, history, clipboard, search, and export tests.
