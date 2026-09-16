# OneNote use-case coverage

## What the 80% target means

Canvink does not claim 80% feature parity with OneNote. The beta target is narrower and testable: support at least 12 of 15 selected everyday outcomes for an individual who wants a local-first notebook. Each outcome has equal weight, so 12 supported outcomes equal 80% of this matrix.

The outcomes are based on Microsoft's documented OneNote basics for [capturing and organizing notes](https://support.microsoft.com/en-US/OneNote/basic-tasks-in-onenote-for-windows-10), [pages and subpages](https://support.microsoft.com/en-us/onenote/organize-your-notes), [formatting notes and tags](https://support.microsoft.com/en-us/onenote/take-and-format-notes), [search](https://support.microsoft.com/en-us/office/search-for-notes-in-onenote-for-windows-10-01f1da59-8b41-4dc7-b060-9a220ad2ec57), [PDF printouts](https://support.microsoft.com/en-us/onenote/onenote-for-mac-help-and-learning/insert-pdf-printouts-into-notes-in-onenote-for-mac), [notebook export](https://support.microsoft.com/en-US/OneNote/export-and-import-onenote-notebooks), and [offline sync behavior](https://support.microsoft.com/en-US/OneNote/onenote-help-and-learning/sync-a-notebook-in-onenote). The matrix measures delivered Canvink behavior, not Microsoft's product completeness.

## Matrix

| # | Individual notebook outcome | Status | Delivered evidence and boundary |
| --- | --- | --- | --- |
| 1 | Capture a thought immediately | Supported | Blank Quick note and directly focused text editor; onboarding is optional and resumable. |
| 2 | Write and structure a longer note | Supported | Movable plain-text objects with size, weight, italic, underline or strike, alignment, and bullet or numbered list presentation. This is not an HTML rich-text engine. |
| 3 | Keep an actionable checklist | Supported | Editable, movable checklist objects with multiple open or completed items. |
| 4 | Handwrite or sketch ideas | Supported | Pressure-aware pen, highlighter, eraser, selection, movement, and resize on one canvas. No handwriting recognition. |
| 5 | Mix text, ink, and visual references | Supported | Text, checklists, ink, images, and a first-page PDF preview share one spatial page. The original PDF is not embedded in the portable workspace. |
| 6 | Organize work into notebooks and sections | Supported | Named notebooks, sections, pages, and nested subpages. |
| 7 | Restructure a notebook as it grows | Supported | Create subpages, duplicate pages, reorder sibling pages, trash, and restore. Cross-section drag and drop is not delivered. |
| 8 | Mark and revisit important or actionable pages | Supported | Important, To do, Question, and Idea tags plus explicit open or done task state. |
| 9 | Find a note by remembered content | Supported | Local search across notebook, section, page, text, and checklist content. No OCR or handwriting index. |
| 10 | Review open work across pages | Supported | `tag:todo`, `is:open`, and `is:done` filters can be combined with text search. |
| 11 | Continue after reload or without a network | Supported | Local autosave, reload/resume, browser offline shell after first load, and desktop-local SQLite. Offline support is not sync. |
| 12 | Recover, back up, and hand off a static copy | Supported | Trash restore, interrupted-edit recovery, rescue download, portable workspace JSON, Markdown import/export, and page PNG or vector PDF export. |
| 13 | Keep the same live notebook synchronized across devices | Not supported | No cross-device service, merge model, or WebDAV/S3 sync exists. Export and import are deliberate file transfers. |
| 14 | Co-edit or share a live notebook with other people | Not supported | No accounts, permissions, live sharing, comments, or collaboration service exists. |
| 15 | Capture through OCR, audio, email, or a web clipper | Not supported | No OCR, handwriting recognition, audio recording, email ingestion, or browser clipper exists. |

Result: **12 of 15 outcomes supported (80%)** for this bounded individual, local-first matrix.

## Release rule

The matrix may only mark an outcome supported when its end-to-end path is automated or has reproducible local evidence. Partial capabilities remain explicit in the boundary column. Public copy must continue to say `public alpha` until the separate beta publication gates in [Beta readiness](beta-readiness.md) are complete and approved.
