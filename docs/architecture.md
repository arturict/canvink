# Architecture

## Status

This document describes the current 0.x alpha architecture. It distinguishes the current foundation from future work. The design favors a small, inspectable local core over premature sync or collaboration abstractions.

## System shape

```mermaid
flowchart LR
  UI["React interface"] --> Domain["Versioned workspace domain"]
  UI --> Canvas["Konva mixed-object canvas"]
  Canvas --> Ink["perfect-freehand geometry"]
  Canvas --> PDF["PDF.js preview rendering"]
  Domain --> Adapter{"Runtime adapter"}
  Adapter -->|Tauri desktop| Commands["Constrained Tauri commands"]
  Commands --> SQLite["Local SQLite database"]
  Adapter -->|Hosted web demo| IDB["Origin-scoped IndexedDB"]
```

The React application owns interaction state and calls pure domain operations. The storage adapter is selected by runtime. This keeps notebook semantics independent from Tauri and makes the browser build useful as a limited demo.

## Logical domain

The root `WorkspaceState` has this ordered nesting:

```text
WorkspaceState
├── notebooks[]
│   └── sections[]
│       └── pages[]
│           └── elements[]
├── trash[]
└── active notebook, section, and page IDs
```

Array order is user-visible order. Page element order is also the default z-order. IDs are opaque and stable. Timestamps are ISO 8601 strings in UTC.

A page has either `free` or `a4` mode. Every page element shares the same top-left coordinate space:

- `stroke` stores pen or highlighter samples and visual settings
- `text` stores plain text, dimensions, and basic typography
- `image` stores a data URL, name, alt text, and dimensions in the alpha schema
- `pdf` stores a preview data URL, source name, page count, and dimensions in the alpha schema

This mixed-object scene is the central product primitive. The text editor and ink engine do not maintain separate pages.

## Rendering and input

React provides navigation, toolbars, panels, and lifecycle state. React Konva maps the ordered scene onto a canvas stage. Konva handles spatial transforms and hit testing. `perfect-freehand` converts pointer samples into filled vector outlines.

Pointer pressure, tilt, time, and pointer type are kept when available. Browsers and devices vary, so absence of useful pressure or tilt must not corrupt a stroke. PDF.js parses PDFs locally for preview rendering. PDF parsing is treated as untrusted-input handling, not as a trusted document conversion service.

## Persistence boundary

### Desktop

The desktop process is authoritative for desktop persistence. The webview sends a versioned workspace scene through a narrow Tauri command surface. Rust validates the request envelope and stores the scene in SQLite.

For schema v1, each save validates the complete scene, then replaces the normalized notebook, section, page, and element rows in one `IMMEDIATE` transaction. Tool-specific payloads remain JSON, ordering is stored explicitly, and an FTS5 search index is rebuilt in the same transaction. This provides typed relationships and deterministic rehydration, but a save can still rewrite the full workspace. It is suitable for an alpha, not proof of large-notebook scalability.

The UI should only confirm a save after the Tauri command succeeds. Database writes use foreign keys, strict tables, WAL mode, and a transaction so a failed replacement leaves the previous commit intact. The save command reloads the committed rows before returning.

### Browser demo

The hosted `/app` route stores the same logical workspace in IndexedDB. The browser origin and profile are the security and durability boundary. Browser data is not synced to the desktop database and is not uploaded to a Canvink service.

IndexedDB is a demo adapter, not a fallback cloud service. Clearing site data can delete its contents.

## Landing page and application

The landing page and web demo share the Vite build but have separate routes. Static deployment on Vercel hosts the landing experience. The desktop app loads packaged assets and does not depend on the hosted site for ordinary editing.

The deployment platform can observe normal request metadata for hosted pages. That does not make notebook content telemetry, and the application must not transmit notebook scenes to analytics or marketing services.

## Trust boundaries

- The React webview is not trusted to access arbitrary local files.
- Tauri commands are narrow and validate input before disk access.
- SQLite and the browser origin are separate persistence domains.
- Images and PDFs are untrusted content.
- Release workflows and signing credentials are separate from pull-request workflows.
- Sync, plugins, and collaboration are outside the current alpha trust model.

Read [security-model.md](security-model.md) for threats and current limitations.

## Design constraints

1. Data integrity is more important than saving a few milliseconds.
2. A local-first claim must name the actual local authority.
3. Schema changes require migrations, tests, and documentation.
4. Optional future services must not become required for ordinary editing.
5. Feature claims must describe shipped behavior, not roadmap intent.
6. New native capabilities require the smallest practical Tauri permission surface.

## Known architectural limitations

- Snapshot persistence is not tuned for very large notebooks.
- Binary data URLs can inflate scene size and memory use.
- The alpha has no cross-device merge model.
- Browser storage is origin-scoped and easy for users to clear accidentally.
- Desktop data is not encrypted by Canvink.
- Import coverage, history, recovery diagnostics, and integrity tools remain early.

These limitations are reasons for focused follow-up work, not permission to hide risk from users.
