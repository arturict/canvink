import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const allowedIdentifiers = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  // argparse, a dependency of markdown-it's command line tool (not bundled).
  // The PSF license is permissive and GPL-compatible.
  'Python-2.0',
  'Unlicense',
  'Zlib',
]);
const operators = new Set(['AND', 'OR', 'WITH']);
const root = resolve(import.meta.dirname, '..');
const jsxGraphDualLicense = '(MIT OR LGPL-3.0-or-later)';

function runPnpmLicenses() {
  let executable = 'pnpm';
  let args = ['licenses', 'list', '--json'];

  if (process.platform === 'win32') {
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath && existsSync(npmExecPath)) {
      executable = process.execPath;
      args = [npmExecPath, ...args];
    } else {
      const nativePnpm = (process.env.PATH ?? '')
        .split(delimiter)
        .map((directory) => join(directory, 'pnpm.exe'))
        .find(existsSync);
      if (!nativePnpm) {
        throw new Error(
          'Could not locate pnpm.exe or npm_execpath for the license check.',
        );
      }
      executable = nativePnpm;
    }
  }

  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `pnpm licenses list --json failed with exit code ${result.status}:\n` +
        `${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  }

  const report = JSON.parse(result.stdout);
  if (
    report === null ||
    Array.isArray(report) ||
    typeof report !== 'object'
  ) {
    throw new TypeError('pnpm returned an invalid top-level license report.');
  }
  return report;
}

export function findLicenseViolations(report) {
  if (report === null || Array.isArray(report) || typeof report !== 'object') {
    throw new TypeError('pnpm returned an invalid top-level license report.');
  }
  const licenseBuckets = Object.entries(report);
  if (licenseBuckets.length === 0) {
    throw new TypeError('pnpm returned an empty license report.');
  }
  const violations = [];

  for (const [expression, packages] of licenseBuckets) {
    if (!Array.isArray(packages) || packages.length === 0) {
      throw new TypeError(
        `pnpm returned an invalid package list for license key ${expression}.`,
      );
    }
    for (const entry of packages) {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        typeof entry.name !== 'string' ||
        !Array.isArray(entry.versions) ||
        entry.versions.length === 0 ||
        entry.versions.some((version) => typeof version !== 'string')
      ) {
        throw new TypeError(
          `pnpm returned an invalid package entry for license key ${expression}.`,
        );
      }
    }
    const normalizedExpression = expression.trim().replace(/\s+/g, ' ');
    const isPinnedJsxGraphChoice =
      normalizedExpression === jsxGraphDualLicense &&
      packages.every(
        (entry) => entry.name === 'jsxgraph' && entry.versions.every((version) => version === '1.13.1'),
      );
    const identifiers = normalizedExpression.match(/[A-Za-z0-9.-]+/g) ?? [];
    const unsupported = identifiers.filter(
      (identifier) =>
        !operators.has(identifier) &&
        !allowedIdentifiers.has(identifier) &&
        !(isPinnedJsxGraphChoice && identifier === 'LGPL-3.0-or-later'),
    );
    if (unsupported.length === 0) continue;
    violations.push({
      expression,
      packages: packages.map((entry) => `${entry.name}@${entry.versions.join(',')}`),
      unsupported,
    });
  }
  return violations;
}

export function main() {
  const report = runPnpmLicenses();
  const violations = findLicenseViolations(report);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `Unsupported npm license expression ${violation.expression} ` +
          `(${violation.packages.join(', ')}); unexpected identifiers: ` +
          violation.unsupported.join(', '),
      );
    }
    process.exitCode = 1;
    return;
  }
  const packageCount = Object.values(report)
    .flat()
    .reduce((count, entry) => count + entry.versions.length, 0);
  console.log(`npm dependency license policy passed for ${packageCount} package versions.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
