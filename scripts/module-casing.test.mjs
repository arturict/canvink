import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// Windows and macOS file systems are case-insensitive. Two modules whose
// paths differ only in casing (slashMenu.ts next to SlashMenu.tsx) resolve to
// the same file there, so `./SlashMenu` silently imports the wrong module and
// the desktop build fails, while Linux CI stays green.
test("no two source modules differ only in casing", () => {
  const files = execFileSync("git", ["ls-files", "src", "services", "tests"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.(tsx?|jsx?|mts|mjs)$/.test(file));
  const byKey = new Map();
  for (const file of files) {
    const key = file.replace(/\.(tsx?|jsx?|mts|mjs)$/, "").toLowerCase();
    byKey.set(key, [...(byKey.get(key) ?? []), file]);
  }
  const collisions = [...byKey.values()].filter((group) => group.length > 1);
  assert.deepEqual(collisions, []);
});
