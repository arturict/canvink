import assert from 'node:assert/strict';
import test from 'node:test';
import { findLicenseViolations } from './check-npm-licenses.mjs';

const entry = (name, version) => ({
  name,
  versions: [version],
  paths: [`node_modules/.pnpm/${name}@${version}/node_modules/${name}`],
});

test('accepts only the pinned JSXGraph dual-license expression through MIT', () => {
  const report = {
    '(MIT OR LGPL-3.0-or-later)': [entry('jsxgraph', '1.13.1')],
  };
  assert.deepEqual(findLicenseViolations(report), []);
});

test('normalizes harmless surrounding and repeated whitespace', () => {
  const report = {
    '  (MIT   OR   LGPL-3.0-or-later)  ': [entry('jsxgraph', '1.13.1')],
  };
  assert.deepEqual(findLicenseViolations(report), []);
});

test('rejects a similar but different JSXGraph expression', () => {
  const report = {
    '(MIT OR LGPL-3.0-only)': [entry('jsxgraph', '1.13.1')],
  };
  assert.deepEqual(findLicenseViolations(report), [{
    expression: '(MIT OR LGPL-3.0-only)',
    packages: ['jsxgraph@1.13.1'],
    unsupported: ['LGPL-3.0-only'],
  }]);
});

test('rejects the approved expression for an unapproved package or version', () => {
  for (const packageEntry of [entry('not-jsxgraph', '1.13.1'), entry('jsxgraph', '1.13.2')]) {
    const violations = findLicenseViolations({
      '(MIT OR LGPL-3.0-or-later)': [packageEntry],
    });
    assert.equal(violations.length, 1);
    assert.deepEqual(violations[0].unsupported, ['LGPL-3.0-or-later']);
  }
});

test('continues rejecting unknown identifiers in unrelated expressions', () => {
  const report = {
    '(MIT OR Proprietary-Unknown)': [entry('example', '1.0.0')],
  };
  assert.deepEqual(findLicenseViolations(report), [{
    expression: '(MIT OR Proprietary-Unknown)',
    packages: ['example@1.0.0'],
    unsupported: ['Proprietary-Unknown'],
  }]);
});
