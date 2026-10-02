import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function directive(csp, name) {
  return csp
    .split(";")
    .map((value) => value.trim().split(/\s+/))
    .find(([directiveName]) => directiveName === name) ?? [];
}

test("desktop CSP permits packaged Automerge WebAssembly without general eval", () => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const csp = config.app?.security?.csp;
  assert.equal(typeof csp, "string");

  const scriptSources = directive(csp, "script-src").slice(1);
  assert.deepEqual(scriptSources, ["'self'", "'wasm-unsafe-eval'"]);
  assert.equal(scriptSources.includes("'unsafe-eval'"), false);
  assert.equal(scriptSources.includes("'unsafe-inline'"), false);
});

test("desktop keeps prototype hardening with the JSXGraph compatibility patch", () => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  assert.equal(config.app?.security?.freezePrototype, true);

  const jsxGraphPatch = readFileSync("patches/jsxgraph@1.13.1.patch", "utf8");
  assert.match(jsxGraphPatch, /Tauri may freeze Object\.prototype/);
  assert.match(jsxGraphPatch, /Object\.defineProperty\(object, e2/);
});
