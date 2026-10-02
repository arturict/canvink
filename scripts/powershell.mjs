import { spawnSync } from "node:child_process";
import test from "node:test";

// `pwsh` is the cross-platform PowerShell; Windows PowerShell ships as
// `powershell.exe`. The acceptance and signing scripts under test are
// PowerShell, so the tests that execute them can only run where one exists.
const candidates = ["pwsh", "powershell.exe", "powershell"];

export const powershell = candidates.find(
  (name) => !spawnSync(name, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { stdio: "ignore" }).error,
);

const skipReason = "PowerShell (pwsh or powershell.exe) is not installed, so this script test cannot run here; install pwsh to run it";

/** Like `test`, but skipped with a clear reason when no PowerShell is available. */
export function powershellTest(name, fn) {
  return test(name, { skip: powershell ? false : skipReason }, fn);
}
