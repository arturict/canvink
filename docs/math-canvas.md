# Math Canvas v0.2 architecture

Math Canvas embeds typed and handwritten mathematics in notebook pages, pen canvases, PDF worksheets, and exports. It is not a separate calculator application. Recognition is deliberately scoped to an explicitly created Math element or an atomic conversion of selected strokes; ordinary ink never triggers recognition.

This document describes the v0.2 target and its persistence contract. A feature mentioned here is not release evidence. The stable release remains blocked until the automated and external gates in [math-acceptance.md](math-acceptance.md) pass for the release commit and package version.

## Elements and evaluation

A `MathElement` owns its position and size, immutable source strokes when the input came from ink, input mode, corrected canonical LaTeX, presentation settings, dependency metadata, provider/model metadata, and recognition state. Recognition and correction are derived data: neither operation replaces the source strokes. Typed input uses the same canonical math model but does not invent ink.

A `GraphElement` references one or more Math elements and stores visible functions, colors, equal-axis mode, and viewport state. It never stores or evaluates arbitrary JavaScript. Graph input must be compiled from the validated mathematical AST to a bounded evaluator.

`MathPageSettings` controls result mode (`suggest`, `insert`, or `off`), angle mode, exact/decimal display, and automatic recognition. The recognition scheduler owns the fixed 900 ms pause. The existing page background remains the single authority for blank, ruled, or grid paper. Exact values are the default source of truth; decimal display is a presentation choice.

The page evaluator uses stable geometric order: top to bottom, then left to right. Variable assignments invalidate dependent results and graphs. Undefined variables and dependency cycles are visible states, not silently substituted values. Creating, recognizing, correcting, converting, moving, and deleting a Math element are atomic undo/redo operations.

Local responsibilities are separated:

- MathLive provides typed entry, correction, and accessible mathematical presentation.
- Cortex Compute Engine parses canonical expressions and handles local simplification, evaluation, variables, and the bounded equation set.
- Numbat provides dimension-safe units and conversions through a native boundary. Currency results additionally carry rate date and source.
- JSXGraph renders bounded interactive 2D graphs.
- A `RecognitionProvider` supplies canonical LaTeX candidates for an explicit ink Math block. It is optional for typed and already-recognized mathematics.

Provider failure leaves an ink block in `pending` state. Typed expressions, existing canonical expressions, local evaluation, variables, units, history, and graphs continue offline. Network work must not block pen input or autosave.

## Schema v3 decision

The repository already uses workspace schema v2 for notebooks, pages, assets, and synchronization. Treating Math Canvas as another “v1 to v2” migration would collide with that shipped meaning. Math Canvas therefore introduces workspace schema **v3** and an atomic **v2 to v3** migration. The historical v1 to v2 migration remains unchanged.

The v3 page-element union adds Math and Graph elements and page-level math settings. Migration preserves all existing element identifiers and content and initializes explicit math defaults without interpreting existing ink. It must be idempotent and crash-safe. Opening v1 still follows the historical v1 to v2 path and then v2 to v3. Older clients must fail closed with a clear incompatibility message rather than partially opening or rewriting v3 content.

The `.canvink` bundle format must be bumped when its manifest declares the new workspace schema. Its Automerge documents and asset inventory remain authoritative. Current-schema JSON, PDF, and PNG exports must handle Math and Graph elements explicitly; the legacy rollback export remains clearly labeled and must not be presented as a lossless v3 export.

Lossless workspace and bundle persistence includes source Math-block strokes, canonical/corrected formulas, result presentation, recognition state, dependencies, and Graph references. Provider secrets and provider configuration are never workspace fields. See [math-recognition.md](math-recognition.md) for the exact privacy boundary.

## Interaction and accessibility

The Math tool accepts pen or keyboard input. Existing selected strokes convert atomically to a Math element. Ambiguous recognition is marked blue, unparseable recognition red, and both open a structured editor without mutating source ink. Results are cleanly typeset; v0.2 does not imitate a writer's handwriting.

Number scrubbing accepts pen, touch, or mouse horizontal movement and updates dependents locally during the gesture. The calculator palette exposes basic, scientific, and conversion operations and can insert either an expression or result. Its history is local, content-bearing notebook state and is not acceptance telemetry.

Graph elements support multiple colored functions, visibility toggles, pan, zoom, resize, viewport reset, equal axis scaling, and point inspection. Source changes update referenced graphs. Keyboard focus, accessible labels, reduced-motion behavior, and non-color-only error states are required.

## Explicitly outside v0.2

3D graphs, general matrices and vectors, general differential equations, symbolic step-by-step tutoring, AI word-problem solving, handwriting imitation, and a public Canvink recognition quota are separate releases. TexTeller is a private, license-gated reference until code, model, and training-data rights are cleared; it is not implicitly approved by implementing the provider interface.
