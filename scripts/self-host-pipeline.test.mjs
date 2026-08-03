import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { resolve } from "node:path";

function run(script, arguments_ = [], environment = {}) {
  return spawnSync(process.execPath, [resolve("scripts", script), ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...environment },
    windowsHide: true,
  });
}

test("Docker smoke skip is explicit and successful", () => {
  const result = run("self-host-docker-smoke.mjs", ["--mode", "skip"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^SKIP self-host Docker smoke:/m);
});

test("Docker smoke rejects an invalid policy with the usage exit code", () => {
  const result = run("self-host-docker-smoke.mjs", ["--mode", "unexpected"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--mode must be one of/);
});

test("Docker auto mode skips when the CLI is absent", () => {
  const result = run("self-host-docker-smoke.mjs", ["--mode", "auto"], {
    PATH: "",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^SKIP self-host Docker smoke: Docker CLI/m);
});

test("required Docker mode blocks when the CLI is absent", () => {
  const result = run("self-host-docker-smoke.mjs", ["--mode", "required"], {
    PATH: "",
  });
  assert.equal(result.status, 4);
  assert.match(result.stderr, /Docker CLI/);
});

test("complete release preflight cannot opt out of Docker", () => {
  const result = run("local-release-preflight.mjs", ["--docker=skip"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument/);
});
