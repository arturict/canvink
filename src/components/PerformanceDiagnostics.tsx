import { Activity, Download, X } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import {
  performanceEvidenceBinding,
  passesPerformanceGate,
  type PenPerformanceAcceptanceEvidence,
  type PerformanceEvidenceBinding,
  type LocalPerformanceRecorder,
  type PerformanceMetric,
  type PerformanceSummary,
} from '../performance/metrics';
import { evaluateCachedNavigationGate } from '../performance/navigation';

export interface PerformanceDiagnosticsProps {
  recorder: LocalPerformanceRecorder;
  initiallyOpen?: boolean;
  /**
   * Controlled use: the panel shows while `open` is true and `onClose` hides
   * it. The owner (the "More" menu's Diagnostics item) then has no trigger
   * button here.
   */
  open?: boolean;
  onClose?: () => void;
}

export function serializePerformanceEvidence(
  recorder: LocalPerformanceRecorder,
  binding: PerformanceEvidenceBinding = performanceEvidenceBinding(),
  recordedAt?: string,
): string {
  return JSON.stringify(recorder.exportPenPerformanceAcceptanceEvidence(binding, recordedAt), null, 2);
}

function downloadEvidence(evidence: PenPerformanceAcceptanceEvidence): void {
  const blob = new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `canvink-pen-performance-${evidence.recordedAt.slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Summary({
  metric,
  summary,
  gate,
}: {
  metric: PerformanceMetric;
  summary: PerformanceSummary | null;
  gate?: { requiredSamples: number; gateMs: number; passes: boolean };
}) {
  const { t } = useI18n();
  const name = t(metric === 'cached-navigation'
    ? 'performance.metric.navigation'
    : metric === 'storage-flush'
      ? 'performance.metric.save'
      : 'performance.metric.pen');
  const state = gate
    ? summary && summary.samples >= gate.requiredSamples
      ? gate.passes ? t('performance.state.passed') : t('performance.state.failed')
      : t('performance.state.collecting', {
        count: summary?.samples ?? 0,
        required: gate.requiredSamples,
      })
    : summary ? t('performance.state.measured') : t('performance.state.noSamples');
  return (
    <li data-testid={`performance-${metric}`}>
      <strong>{name}</strong>
      <span>{summary
        ? t('performance.summary', {
          samples: summary.samples,
          p95: summary.p95Ms.toFixed(1),
        })
        : t('performance.state.noSamples')}</span>
      {gate ? <small>{t('performance.gate', { gate: gate.gateMs, state })}</small> : <small>{state}</small>}
    </li>
  );
}

export default function PerformanceDiagnostics({
  recorder,
  initiallyOpen = false,
  open: controlledOpen,
  onClose,
}: PerformanceDiagnosticsProps) {
  const { t } = useI18n();
  const [ownOpen, setOpen] = useState(initiallyOpen);

  if (controlledOpen !== undefined) {
    return (
      <div className="performance-diagnostics">
        {controlledOpen ? <PerformancePanel recorder={recorder} onClose={() => onClose?.()} /> : null}
      </div>
    );
  }
  const open = ownOpen;
  return (
    <div className="performance-diagnostics">
      <button
        type="button"
        className="topbar-action"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Activity size={15} /> {t('performance.open')}
      </button>
      {open ? <PerformancePanel recorder={recorder} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/**
 * The evidence is gathered when the panel is open only: the notebook shell
 * renders this component on every state change, and exporting the samples of
 * every metric each time was a measurable part of a keystroke.
 */
function PerformancePanel({ recorder, onClose }: { recorder: LocalPerformanceRecorder; onClose: () => void }) {
  const { t } = useI18n();
  const evidence = recorder.exportEvidence();
  const navigation = evaluateCachedNavigationGate(recorder);
  const pen = recorder.summary('pen-preview');
  const save = recorder.summary('storage-flush');
  let penEvidence: PenPerformanceAcceptanceEvidence | null = null;
  try {
    penEvidence = recorder.exportPenPerformanceAcceptanceEvidence(performanceEvidenceBinding());
  } catch {
    penEvidence = null;
  }

  return (
    <section className="performance-diagnostics__panel" role="region" aria-label={t('performance.title')}>
      <header>
        <div>
          <strong>{t('performance.title')}</strong>
          <small>{t('performance.privacy')}</small>
        </div>
        <button type="button" aria-label={t('performance.close')} onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <ul>
        <Summary metric="cached-navigation" summary={navigation.summary} gate={navigation} />
        <Summary metric="storage-flush" summary={save} />
        <Summary
          metric="pen-preview"
          summary={pen}
          gate={{ requiredSamples: 20, gateMs: evidence.gates.penPreviewP95Ms, passes: pen ? passesPerformanceGate(pen) : false }}
        />
      </ul>
      <button type="button" disabled={!penEvidence} onClick={() => {
        if (penEvidence) downloadEvidence(penEvidence);
      }}>
        <Download size={14} /> {t('performance.export')}
      </button>
    </section>
  );
}
