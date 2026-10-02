# Math recognition providers and privacy boundary

Handwriting recognition is optional and replaceable. Canvink must remain useful for typed mathematics and previously recognized ink without a provider or network connection. The desktop release supports a user-configured compatible endpoint and Mathpix Strokes BYOK; the web build does not persist third-party API keys.

## Provider contract

The compatible endpoint is an authenticated `POST /v1/math/recognize`. The request contains only:

- a random request identifier;
- normalized strokes belonging to the explicitly selected Math element;
- that element's local bounding box;
- bounded language, angle, and mathematical settings.

The response contains canonical LaTeX, optional ranked alternatives, model version, API version, duration, and machine-readable warning codes. Both sides enforce request size, stroke count, point count, coordinate, timeout, media-type, and response-size limits. Redirects to a different origin are rejected. LaTeX is data and is parsed by the local math engine; it is never converted to executable JavaScript or interpolated into HTML.

The service rasterizes only the selected Math element when an image model requires pixels. It never receives a whole page, PDF pixels, neighboring handwriting, page or notebook titles, asset identifiers, history, or clipboard contents. Ordinary pen strokes outside a Math element produce exactly zero recognition requests.

After a 900 ms pause, an active block may start recognition if automatic recognition is enabled for that block. Each request carries cancellation and last-write-wins identity so a late response cannot replace a newer edit. Provider and network errors retain source strokes and set `pending`; they do not discard a prior valid canonical expression.

## What is persisted

There are two distinct privacy questions that must not be conflated:

1. **Notebook content needed for recovery.** Math-block source strokes and typed or corrected canonical formulas are user content. They must be stored in the local workspace, Automerge state, lossless `.canvink` bundle, and current-schema JSON export so migration, restart, crash recovery, and import can reproduce the page. Graph references and result presentation are stored for the same reason. These fields may participate in the user's configured encrypted synchronization just like other notebook content.
2. **Credentials and operational evidence.** API keys, bearer tokens, endpoint credentials, and provider configuration are not notebook content. They must never appear in workspace documents, `.canvink` bundles, JSON/PDF/PNG exports, synchronization payloads, recovery journals, logs, telemetry, crash reports, calculator history, or acceptance evidence. Desktop secrets use the operating-system credential store; the v0.2 web build has no provider-key input or persistence path.

Raw strokes and formulas also never belong in logs, telemetry, or the content-free acceptance evidence. Their required presence in a lossless workspace is not a token leak. Conversely, deleting them from workspace export in the name of privacy would cause data loss and is not acceptable.

Provider metadata stored with a Math element is limited to non-secret adapter, model, and API version identifiers plus recognition state and warning codes. The configured endpoint and account identifiers remain outside workspace schema. Debug output uses bounded request counts, timings, sizes, and enumerated error codes, never request or response bodies.

## Endpoint and key policy

Desktop endpoint configuration accepts only policy-approved HTTPS origins, with an explicit local/private-development exception where documented. Loopback, link-local, private-network, DNS rebinding, redirect, and hostname resolution behavior must be threat-modeled and tested rather than inferred from a string prefix. Authorization headers are stripped on any rejected redirect and redacted before error construction.

The Mathpix adapter is BYOK and must not log application ID, key, request body, response body, or provider error echo. A compatible private TexTeller service uses the same interface and a bearer token in the operating-system store. The private 2070/5060 service remains LAN/Tailscale-only and is not a public Canvink service.

TexTeller can become a documented reference only after review of repository code, model weights, dependencies, training data, and intended distribution/use. MathWriting, CROHME, or other noncommercial/research-restricted datasets are not product training or acceptance-corpus material. UniMERNet, pix2tex, and Seshat are benchmark alternatives, not automatically distributable dependencies.

## Verification boundary

Unit and integration tests prove request scoping, cancellation, bounds, redaction, offline states, parser safety, and secret exclusion. They cannot prove real recognition accuracy, GPU latency, model/data licensing, or personal workflows. Those require fresh, commit-bound evidence described in [math-acceptance.md](math-acceptance.md). A missing external result stays blocked.
