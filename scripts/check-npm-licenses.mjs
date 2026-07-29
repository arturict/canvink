import { readFileSync } from 'node:fs';

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
  'Unlicense',
  'Zlib',
]);
const operators = new Set(['AND', 'OR', 'WITH']);
const raw = readFileSync(0, 'utf8');
const report = JSON.parse(raw);
const violations = [];

for (const [expression, packages] of Object.entries(report)) {
  const identifiers = expression.match(/[A-Za-z0-9.-]+/g) ?? [];
  const unsupported = identifiers.filter(
    (identifier) =>
      !operators.has(identifier) && !allowedIdentifiers.has(identifier),
  );
  if (unsupported.length === 0) continue;
  violations.push({
    expression,
    packages: packages.map((entry) => `${entry.name}@${entry.versions.join(',')}`),
    unsupported,
  });
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(
      `Unsupported npm license expression ${violation.expression} ` +
        `(${violation.packages.join(', ')}); unexpected identifiers: ` +
        violation.unsupported.join(', '),
    );
  }
  process.exitCode = 1;
} else {
  const packageCount = Object.values(report)
    .flat()
    .reduce((count, entry) => count + entry.versions.length, 0);
  console.log(`npm dependency license policy passed for ${packageCount} package versions.`);
}
