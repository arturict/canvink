// @ts-expect-error -- Node built-ins are used only by this Windows contract test; the browser app has no Node types.
import { execFileSync, spawnSync } from 'node:child_process';
// @ts-expect-error -- Node built-ins are used only by this Windows contract test; the browser app has no Node types.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// @ts-expect-error -- Node built-ins are used only by this Windows contract test; the browser app has no Node types.
import { tmpdir } from 'node:os';
// @ts-expect-error -- Node built-ins are used only by this Windows contract test; the browser app has no Node types.
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LocalPerformanceRecorder } from '../performance/metrics';
import PerformanceDiagnostics, { serializePerformanceEvidence } from './PerformanceDiagnostics';

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
};

// The acceptance validator is a Windows PowerShell script (scripts/windows-school-acceptance.ps1),
// and the school machine that produces this evidence runs Windows. Without
// powershell.exe (Linux, macOS) the spawn fails and no output file exists, so
// the contract can only be checked where the validator can run.
const hasWindowsPowerShell = !spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
  windowsHide: true,
}).error;

describe('PerformanceDiagnostics', () => {
  it('renders the strict cached-navigation result after twenty deterministic samples', () => {
    const recorder = new LocalPerformanceRecorder();
    for (let index = 0; index < 20; index += 1) recorder.record('cached-navigation', index + 1);
    recorder.record('storage-flush', 8);
    const markup = renderToStaticMarkup(createElement(PerformanceDiagnostics, {
      recorder,
      initiallyOpen: true,
    }));
    expect(markup).toContain('Leistungsdiagnose');
    expect(markup).toContain('20 Samples · p95 19.0 ms');
    expect(markup).toContain('Grenze &lt; 300 ms · Bestanden');
    expect(markup).toContain('1 Samples · p95 8.0 ms');
    expect(markup).toContain('disabled=""');
  });

  it('exports only the bounded content-free evidence contract', () => {
    const recorder = new LocalPerformanceRecorder();
    const startedAt = Date.parse('2026-08-03T12:00:00.000Z');
    for (let index = 0; index < 20; index += 1) {
      recorder.record('pen-preview', 10 + index / 100, new Date(startedAt + index * 1_000).toISOString());
    }
    recorder.record('pen-preview', 10, '2026-08-03T12:45:00.000Z');
    const exported = JSON.parse(serializePerformanceEvidence(
      recorder,
      { repositoryCommit: 'a'.repeat(40), packageVersion: '0.1.0' },
      '2026-08-03T12:45:01.000Z',
    )) as Record<string, unknown>;
    expect(Object.keys(exported).sort()).toEqual([
      'contentFree', 'kind', 'packageVersion', 'producer', 'recordedAt', 'repositoryCommit',
      'results', 'schemaVersion', 'status',
    ]);
    expect(JSON.stringify(exported)).not.toMatch(/"(?:notebookId|pageId|title|content)"/i);
    expect(exported).toMatchObject({
      schemaVersion: 1,
      kind: 'pen-performance',
      contentFree: true,
      producer: 'canvink-performance-recorder',
      results: { sampleCount: 21, p95Ms: 10.18, thresholdMs: 20, durationMinutes: 45 },
    });
  });

  it.skipIf(!hasWindowsPowerShell)('round-trips the real UI serializer through the strict Windows acceptance validator', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'canvink-performance-contract-'));
    try {
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const packageVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
      const recordedAtMs = Date.now();
      const startedAtMs = recordedAtMs - 45 * 60_000;
      const recorder = new LocalPerformanceRecorder();
      for (let index = 0; index < 19; index += 1) {
        recorder.record('pen-preview', 11.9, new Date(startedAtMs + index * 1_000).toISOString());
      }
      recorder.record('pen-preview', 11.9, new Date(recordedAtMs).toISOString());
      writeFileSync(path.join(directory, 'pen-performance.json'), serializePerformanceEvidence(
        recorder,
        { repositoryCommit: commit, packageVersion },
        new Date(recordedAtMs).toISOString(),
      ), 'utf8');

      const outputPath = path.join(directory, 'validation.json');
      const validation = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', 'scripts/windows-school-acceptance.ps1',
        '-Mode', 'ValidatePenPerformance',
        '-EvidenceRoot', directory,
        '-OutputPath', outputPath,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CANVINK_ACCEPTANCE_POLICY_TEST_MODE: '1' },
        windowsHide: true,
      });
      const report = JSON.parse(readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, '')) as {
        penPerformance: { valid: boolean; validation: string };
      };
      expect(validation.status, validation.stderr).toBe(0);
      expect(report.penPerformance).toEqual(expect.objectContaining({ valid: true, validation: 'validated' }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
