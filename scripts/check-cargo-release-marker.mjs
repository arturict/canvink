import { readFileSync } from "node:fs";

const lockPath = "src-tauri/Cargo.lock";
const contents = readFileSync(lockPath, "utf8");
const expectedVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const packageTables = contents
  .split(/^\[\[package\]\]\s*$/m)
  .filter(
    (table) =>
      /^\s*name\s*=\s*["']canvink["']\s*$/m.test(table),
  );

if (packageTables.length !== 1) {
  throw new Error(
    `${lockPath} must contain exactly one canvink package table; found ${packageTables.length}`,
  );
}

const version = packageTables[0].match(
  /^\s*version\s*=\s*["']([^"']+)["']\s*#\s*x-release-please-version\s*$/m,
)?.[1];
if (!version) {
  throw new Error(
    `${lockPath} must retain the inline x-release-please-version marker on canvink's version`,
  );
}
if (version !== expectedVersion) {
  throw new Error(
    `${lockPath} has canvink ${version}, but package.json has ${expectedVersion}`,
  );
}

const markerCount = contents.match(/x-release-please-version/g)?.length ?? 0;
if (markerCount !== 1) {
  throw new Error(
    `${lockPath} must contain exactly one release marker; found ${markerCount}`,
  );
}

console.log(`Cargo release marker verified for canvink ${version}.`);
