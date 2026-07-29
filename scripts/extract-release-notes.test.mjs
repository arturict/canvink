import assert from "node:assert/strict";
import test from "node:test";

import { extractReleaseNotes } from "./extract-release-notes.mjs";

test("extracts an exact plain version section", () => {
  const changelog = [
    "# Changelog",
    "",
    "## 0.2.0 - 2026-08-01",
    "",
    "### Added",
    "",
    "- Plain notes",
    "",
    "## 0.1.0 - 2026-07-29",
    "",
    "- Older notes",
  ].join("\n");

  assert.equal(
    extractReleaseNotes(changelog, "0.2.0"),
    "### Added\n\n- Plain notes\n",
  );
});

test("extracts the linked heading produced by Release Please", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [0.2.0](https://github.com/arturict/canvink/compare/v0.1.0...v0.2.0) (2026-08-01)",
    "",
    "### Features",
    "",
    "- Linked notes",
    "",
    "## [0.1.0](https://github.com/arturict/canvink/releases/tag/v0.1.0) (2026-07-29)",
  ].join("\n");

  assert.equal(
    extractReleaseNotes(changelog, "0.2.0"),
    "### Features\n\n- Linked notes\n",
  );
});

test("does not confuse a stable version with a prerelease", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [0.2.0-rc.1](https://example.invalid/v0.2.0-rc.1) (2026-08-01)",
    "",
    "- Candidate",
  ].join("\n");

  assert.throws(
    () => extractReleaseNotes(changelog, "0.2.0"),
    /exactly one section.*found 0/,
  );
});

test("rejects duplicate and empty matching sections", () => {
  assert.throws(
    () =>
      extractReleaseNotes(
        "## 0.2.0 - first\n\n- One\n\n## [0.2.0](https://example.invalid) - second\n\n- Two\n",
        "0.2.0",
      ),
    /exactly one section.*found 2/,
  );
  assert.throws(
    () => extractReleaseNotes("## 0.2.0 - empty\n\n## 0.1.0\n\n- Old\n", "0.2.0"),
    /section.*is empty/,
  );
});
