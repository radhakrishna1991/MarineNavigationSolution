/**
 * Performance analytics (Sections 15.7 and 26).
 *
 * Separate charts rather than one crowded combined chart, and — the point of
 * the whole screen — three quantities kept strictly apart: the actual error,
 * the estimated error, and the protection level. The report also states how
 * often the bound failed to contain the error, which is the number a customer
 * should judge the platform by.
 */

import { useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  useGenerateReportMutation,
  usePerformanceSummaryQuery,
  useRunsQuery,
  useTimeseriesQuery,
  useTracksQuery,
  errorMessage
} from '../api/api';
import { runSelected, toastAdded } from '../store/uiSlice';
import { hasRole } from '../store/authSlice';
import { useDownload } from '../hooks/useDownload';
import {
  EmptyState,
  KeyValue,
  Note,
  Panel,
  QueryBoundary,
  Readout,
  Select,
  StatusChip,
  Tabs
} from '../components/ui';
import {
  BarChart,
  ErrorDistributionChart,
  ErrorVsProtectionChart,
  LineChart,
  ModeTimelineChart,
  RequirementTimelineChart,
  TrustScoreChart
} from '../charts/charts';
import { duration, metres, number, percent, simClock, timestamp, EM_DASH } from '../utils/format';
import { REQUIREMENT_PRESENTATION, SEVERITY_PRESENTATION } from '../utils/status';

type Tab = 'summary' | 'error' | 'modes' | 'sensors' | 'events';

function ComplianceBanner({ summary }: { summary: Record<string, any> }) {
  const misleading = summary.misleading_information_count ?? 0;
  const tone =
    misleading > 0 ? 'critical' : summary.requirement_met_pct >= 99 ? 'assured' : 'caution';
  const toneClass = {
    assured: 'border-assured/50 bg-assured/10 text-assured',
    caution: 'border-caution/50 bg-caution/10 text-caution',
    critical: 'border-critical/50 bg-critical/10 text-critical'
  }[tone];

  return (
    <div className={`rounded-lg border px-4 py-3 ${toneClass}`}>
      <p className="text-2xs uppercase tracking-[0.14em] opacity-80">Compliance result</p>
      <p className="mt-1 text-xl font-bold">{summary.compliance_result}</p>
      <p className="mt-1.5 max-w-4xl text-xs leading-relaxed text-bridge-300">
        {misleading > 0
          ? `The actual error exceeded the published protection level while the system was reporting the requirement as met, in ${misleading} epochs (${summary.misleading_information_pct}%). This is the most serious class of failure a navigation integrity system can have and is reported here rather than buried.`
          : `The protection level contained the actual error in every epoch where the requirement was reported as met. The requirement was reported as met for ${summary.requirement_met_pct}% of the run.`}
      </p>
    </div>
  );
}

export function AnalyticsPage() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);
  const liveRunId = useAppSelector((s) => s.live.scenario?.run_id ?? null);
  const selectedRunId = useAppSelector((s) => s.ui.selectedRunId);
  const [tab, setTab] = useState<Tab>('summary');

  const runId = selectedRunId ?? liveRunId ?? undefined;

  const { data: runs } = useRunsQuery({ limit: 60 });
  const {
    data: report,
    isLoading,
    isError,
    error,
    refetch
  } = usePerformanceSummaryQuery(runId, { pollingInterval: runId === liveRunId ? 15000 : 0 });
  const { data: series } = useTimeseriesQuery({ runId, maxPoints: 1500 });
  const { data: tracks } = useTracksQuery({ runId }, { skip: tab !== 'error' });
  const [generateReport, { isLoading: generating }] = useGenerateReportMutation();
  const { download, busy: downloading } = useDownload();

  const canGenerate = hasRole(user?.role, 'operator');

  const points = series?.series ?? [];
  const errorSeries = useMemo(
    () =>
      points.map((p) => ({
        t: p.t,
        actual: p.actual_error_m,
        estimated: p.estimated_error_m,
        hpl: p.hpl_m
      })),
    [points]
  );
  const errorValues = useMemo(
    () => points.map((p) => p.actual_error_m).filter((v): v is number => v !== null),
    [points]
  );

  const summary = report?.summary ?? null;
  const limit = summary?.requirement_limit_m ?? 2;

  return (
    <div className="space-y-3">
      <Panel
        title="Performance analytics"
        subtitle="Actual error, estimated error and protection level are three different things"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={runId ?? ''}
              onChange={(v) => dispatch(runSelected(v || null))}
              ariaLabel="Select run"
              options={[
                { value: '', label: liveRunId ? 'Current run' : 'Choose a run…' },
                ...(runs?.items ?? []).map((r) => ({
                  value: r.run_id,
                  label: `${r.scenario_name} · ${timestamp(r.started_at, true)} · ${r.solution_count} epochs`
                }))
              ]}
              className="w-80"
            />
            {canGenerate && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={!runId || generating}
                onClick={async () => {
                  try {
                    await generateReport({ runId }).unwrap();
                    dispatch(toastAdded('success', 'Report generated and stored'));
                    refetch();
                  } catch (err) {
                    dispatch(toastAdded('error', 'Report generation failed', errorMessage(err)));
                  }
                }}
              >
                Generate report
              </button>
            )}
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={!runId || downloading}
              onClick={() => download('report', 'html', runId)}
            >
              Printable report
            </button>
            <Select
              value=""
              onChange={(v) => {
                if (!v) return;
                const [dataset, format] = v.split(':');
                download(dataset, format, runId);
              }}
              ariaLabel="Export data"
              options={[
                { value: '', label: 'Export data…' },
                { value: 'navigation:csv', label: 'Navigation solutions (CSV)' },
                { value: 'navigation:geojson', label: 'Navigation track (GeoJSON)' },
                { value: 'navigation:kml', label: 'Navigation track (KML)' },
                { value: 'ground_truth:csv', label: 'Ground truth (CSV)' },
                { value: 'ground_truth:geojson', label: 'Ground truth (GeoJSON)' },
                { value: 'sensor_messages:csv', label: 'Raw sensor messages (CSV)' },
                { value: 'gnss_trust:csv', label: 'GNSS trust records (CSV)' },
                { value: 'residuals:csv', label: 'Filter residuals (CSV)' },
                { value: 'alarms:csv', label: 'Alarms (CSV)' },
                { value: 'mode_transitions:csv', label: 'Mode transitions (CSV)' },
                { value: 'scenario_events:csv', label: 'Scenario events (CSV)' },
                { value: 'report:json', label: 'Performance report (JSON)' }
              ]}
              className="w-56"
            />
          </div>
        }
        bodyClassName="p-0"
      >
        <div className="px-4 pt-3">
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'summary', label: 'Summary' },
              { id: 'error', label: 'Error and bound' },
              { id: 'modes', label: 'Modes and compliance' },
              { id: 'sensors', label: 'Sensor availability' },
              { id: 'events', label: 'Events' }
            ]}
          />
        </div>

        <div className="p-4">
          <QueryBoundary
            isLoading={isLoading}
            isError={isError}
            error={isError ? { message: errorMessage(error) } : undefined}
            data={report}
            isEmpty={(d) => !d?.summary}
            emptyTitle="No performance data"
            emptyDetail="Run a scenario to completion, or choose a recorded run from the list above."
            onRetry={refetch}
            loadingRows={8}
          >
            {(data) => {
              const s = data.summary;
              return (
                <div className="space-y-4">
                  {tab === 'summary' && (
                    <>
                      <ComplianceBanner summary={s} />

                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <div className="panel px-4 py-3">
                          <Readout
                            label="Mean actual error"
                            value={number(s.actual_error?.mean_m)}
                            unit="m"
                            hint="Against simulated ground truth"
                          />
                        </div>
                        <div className="panel px-4 py-3">
                          <Readout
                            label="95th percentile error"
                            value={number(s.actual_error?.p95_m)}
                            unit="m"
                            tone={s.actual_error?.p95_m > limit ? 'critical' : 'assured'}
                          />
                        </div>
                        <div className="panel px-4 py-3">
                          <Readout
                            label="Maximum error"
                            value={number(s.actual_error?.max_m)}
                            unit="m"
                            tone={s.actual_error?.max_m > limit ? 'caution' : 'assured'}
                          />
                        </div>
                        <div className="panel px-4 py-3">
                          <Readout
                            label={`Time within ${limit} m`}
                            value={number(s.time_below_limit_pct, 1)}
                            unit="%"
                            tone={s.time_below_limit_pct > 95 ? 'assured' : 'caution'}
                          />
                        </div>
                      </div>

                      <div className="grid gap-4 lg:grid-cols-3">
                        <div>
                          <p className="panel-title mb-2">Actual error — measured</p>
                          <p className="mb-2 text-2xs leading-relaxed text-bridge-500">{s.actual_error?.source}</p>
                          <KeyValue label="Mean" value={metres(s.actual_error?.mean_m, 3)} />
                          <KeyValue label="Median" value={metres(s.actual_error?.median_m, 3)} />
                          <KeyValue label="RMS" value={metres(s.actual_error?.rms_m, 3)} />
                          <KeyValue label="Standard deviation" value={metres(s.actual_error?.std_dev_m, 3)} />
                          <KeyValue label="95th percentile" value={metres(s.actual_error?.p95_m, 3)} />
                          <KeyValue label="99th percentile" value={metres(s.actual_error?.p99_m, 3)} />
                          <KeyValue label="Maximum" value={metres(s.actual_error?.max_m, 3)} />
                          <KeyValue label="Samples" value={s.actual_error?.samples} />
                        </div>

                        <div>
                          <p className="panel-title mb-2">Estimated error — inferred</p>
                          <p className="mb-2 text-2xs leading-relaxed text-bridge-500">{s.estimated_error?.source}</p>
                          <KeyValue label="Mean" value={metres(s.estimated_error?.mean_m, 3)} />
                          <KeyValue label="95th percentile" value={metres(s.estimated_error?.p95_m, 3)} />
                          <KeyValue label="Maximum" value={metres(s.estimated_error?.max_m, 3)} />

                          <p className="panel-title mb-2 mt-4">Protection level — the bound</p>
                          <p className="mb-2 text-2xs leading-relaxed text-bridge-500">{s.protection_level?.source}</p>
                          <KeyValue label="Mean" value={metres(s.protection_level?.mean_m, 3)} />
                          <KeyValue label="95th percentile" value={metres(s.protection_level?.p95_m, 3)} />
                          <KeyValue label="Maximum" value={metres(s.protection_level?.max_m, 3)} />
                        </div>

                        <div>
                          <p className="panel-title mb-2">Integrity performance</p>
                          <KeyValue
                            label="Bound exceeded"
                            value={`${s.protection_level_exceeded_count} (${s.protection_level_exceeded_pct} %)`}
                            tone={s.protection_level_exceeded_pct > 5 ? 'critical' : 'assured'}
                            title="Epochs where the actual error exceeded the protection level"
                          />
                          <KeyValue
                            label="Misleading information"
                            value={`${s.misleading_information_count} (${s.misleading_information_pct} %)`}
                            tone={s.misleading_information_count > 0 ? 'critical' : 'assured'}
                          />
                          <KeyValue
                            label="False attack alarms"
                            value={s.false_alarm_count}
                            tone={s.false_alarm_count > 0 ? 'caution' : 'assured'}
                          />
                          <KeyValue label="Integrity assured" value={percent(s.integrity_assured_pct)} />
                          <KeyValue label="Solution availability" value={percent(s.solution_availability_pct)} />

                          <p className="panel-title mb-2 mt-4">Raw GNSS for comparison</p>
                          <p className="mb-2 text-2xs leading-relaxed text-bridge-500">{s.gnss_error?.source}</p>
                          <KeyValue label="Mean GNSS error" value={metres(s.gnss_error?.mean_m, 3)} />
                          <KeyValue label="Maximum GNSS error" value={metres(s.gnss_error?.max_m, 3)} />
                        </div>
                      </div>

                      <div className="grid gap-4 lg:grid-cols-2">
                        <div>
                          <p className="panel-title mb-2">Requirement compliance breakdown</p>
                          <BarChart
                            data={[
                              { label: 'Met', value: s.requirement_met_pct, colour: '#12b981' },
                              { label: 'At risk', value: s.requirement_at_risk_pct, colour: '#f0b429' },
                              { label: 'Not met', value: s.requirement_not_met_pct, colour: '#ef3f5b' },
                              { label: 'Insufficient information', value: s.insufficient_information_pct, colour: '#8ba1c4' }
                            ]}
                            unit="%"
                            max={100}
                            height={180}
                          />
                        </div>
                        <div>
                          <p className="panel-title mb-2">Detection and recovery timing</p>
                          <KeyValue label="First scripted GNSS fault" value={simClock(s.first_gnss_fault_at_s)} />
                          <KeyValue label="Spoofing detected" value={simClock(s.spoofing_detection_time_s)} />
                          <KeyValue
                            label="Spoofing detection latency"
                            value={s.spoofing_detection_latency_s === null ? EM_DASH : `${s.spoofing_detection_latency_s} s`}
                            tone={s.spoofing_detection_latency_s !== null && s.spoofing_detection_latency_s < 60 ? 'assured' : undefined}
                          />
                          <KeyValue label="Jamming detected" value={simClock(s.jamming_detection_time_s)} />
                          <KeyValue label="GNSS rejected" value={simClock(s.gnss_rejection_time_s)} />
                          <KeyValue
                            label="GNSS rejection latency"
                            value={s.gnss_rejection_latency_s === null ? EM_DASH : `${s.gnss_rejection_latency_s} s`}
                          />
                          <KeyValue label="GNSS reintegrated" value={simClock(s.gnss_recovery_time_s)} />
                          <KeyValue
                            label="GNSS outage duration"
                            value={`${duration(s.gnss_outage_duration_s)} (${s.gnss_outage_pct} %)`}
                          />
                          <KeyValue label="Alarms raised" value={s.alarm_count} />
                          <KeyValue label="Mode transitions" value={s.mode_transition_count} />
                        </div>
                      </div>

                      <Note>
                        {s.misleading_information_note}
                      </Note>
                    </>
                  )}

                  {tab === 'error' && (
                    <div className="space-y-4">
                      <div>
                        <p className="panel-title mb-2">Error against the published bound</p>
                        <ErrorVsProtectionChart data={errorSeries} limit={limit} height={300} />
                      </div>
                      <div className="grid gap-4 lg:grid-cols-2">
                        <div>
                          <p className="panel-title mb-2">Error distribution</p>
                          <ErrorDistributionChart values={errorValues} limit={limit} />
                        </div>
                        <div>
                          <p className="panel-title mb-2">GNSS trust over time</p>
                          <TrustScoreChart data={points.map((p) => ({ t: p.t, trust: p.gnss_trust }))} />
                        </div>
                      </div>
                      <div className="grid gap-4 lg:grid-cols-2">
                        <div>
                          <p className="panel-title mb-2">Independent absolute sources</p>
                          <LineChart
                            data={points.map((p) => ({ t: p.t, value: p.absolute_sources }))}
                            label="Absolute sources"
                            unit="count"
                            colour="#12b981"
                            height={160}
                          />
                        </div>
                        <div>
                          <p className="panel-title mb-2">Dead-reckoning duration</p>
                          <LineChart
                            data={points.map((p) => ({ t: p.t, value: p.dr_duration_s }))}
                            label="DR duration"
                            unit="s"
                            colour="#f97316"
                            markLineAt={120}
                            markLineLabel="unassisted limit"
                            height={160}
                          />
                        </div>
                      </div>
                      {tracks && tracks.fused.length > 0 && (
                        <Note>
                          Track geometry for this run is available as GeoJSON and KML through the export menu:{' '}
                          {tracks.fused.length} fused positions, {tracks.truth.length} ground-truth points and{' '}
                          {tracks.gnss.length} raw GNSS fixes.
                        </Note>
                      )}
                    </div>
                  )}

                  {tab === 'modes' && (
                    <div className="space-y-4">
                      <div>
                        <p className="panel-title mb-2">Requirement compliance over time</p>
                        <RequirementTimelineChart data={points.map((p) => ({ t: p.t, requirement: p.requirement }))} />
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(['REQUIREMENT_MET', 'REQUIREMENT_AT_RISK', 'REQUIREMENT_NOT_MET', 'INSUFFICIENT_INFORMATION'] as const).map(
                            (status) => (
                              <StatusChip key={status} presentation={REQUIREMENT_PRESENTATION[status]} />
                            )
                          )}
                        </div>
                      </div>

                      <div>
                        <p className="panel-title mb-2">Navigation mode timeline</p>
                        <ModeTimelineChart data={points.map((p) => ({ t: p.t, mode: p.mode }))} height={260} />
                      </div>

                      <div className="grid gap-4 lg:grid-cols-2">
                        <div>
                          <p className="panel-title mb-2">Time in each mode</p>
                          <BarChart
                            data={Object.entries(data.mode_durations ?? {})
                              .sort((a, b) => b[1].seconds - a[1].seconds)
                              .map(([mode, v]) => ({ label: mode.replace(/_/g, ' '), value: v.seconds }))}
                            unit="s"
                          />
                        </div>
                        <div>
                          <p className="panel-title mb-2">Mode transitions</p>
                          <div className="max-h-64 overflow-auto rounded border border-bridge-700">
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>Time</th>
                                  <th>From</th>
                                  <th>To</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(data.mode_timeline ?? []).map((t, i) => (
                                  <tr key={i} title={t.reason}>
                                    <td className="font-mono text-2xs">{simClock(t.sim_time_s)}</td>
                                    <td className="text-2xs">{t.from_mode?.replace(/_/g, ' ')}</td>
                                    <td className="text-2xs text-bridge-100">{t.to_mode?.replace(/_/g, ' ')}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {tab === 'sensors' && (
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div>
                        <p className="panel-title mb-2">Sensor availability</p>
                        <BarChart
                          data={Object.entries(data.sensor_availability ?? {})
                            .sort((a, b) => b[1].availability_pct - a[1].availability_pct)
                            .map(([id, v]) => ({
                              label: id,
                              value: v.availability_pct,
                              colour: v.availability_pct > 80 ? '#12b981' : v.availability_pct > 40 ? '#f0b429' : '#ef3f5b'
                            }))}
                          unit="%"
                          max={100}
                        />
                      </div>
                      <div>
                        <p className="panel-title mb-2">Contribution detail</p>
                        <div className="max-h-80 overflow-auto rounded border border-bridge-700">
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Sensor</th>
                                <th className="text-right">Contributing epochs</th>
                                <th className="text-right">Availability</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Object.entries(data.sensor_availability ?? {})
                                .sort((a, b) => b[1].availability_pct - a[1].availability_pct)
                                .map(([id, v]) => (
                                  <tr key={id}>
                                    <td className="font-mono text-xs">{id}</td>
                                    <td className="text-right font-mono text-xs">{v.epochs}</td>
                                    <td className="text-right font-mono text-xs">{v.availability_pct} %</td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                        <Note>
                          Availability here means the fraction of published epochs in which the sensor contributed an
                          accepted measurement to the fused solution. A sensor can be online and healthy but not
                          contributing, for example a LiDAR out of range of any mapped structure.
                        </Note>
                      </div>
                    </div>
                  )}

                  {tab === 'events' && (
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div>
                        <p className="panel-title mb-2">Alarms ({data.alarms?.length ?? 0})</p>
                        <div className="max-h-96 overflow-auto rounded border border-bridge-700">
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Time</th>
                                <th>Severity</th>
                                <th>Message</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(data.alarms ?? []).map((a, i) => (
                                <tr key={i} title={a.reason ?? undefined}>
                                  <td className="font-mono text-2xs">{simClock(a.sim_time_s)}</td>
                                  <td>
                                    <StatusChip presentation={SEVERITY_PRESENTATION[a.severity]} size="sm" />
                                  </td>
                                  <td className="text-2xs">{a.message}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      <div>
                        <p className="panel-title mb-2">Scenario events ({data.events?.length ?? 0})</p>
                        <div className="max-h-96 overflow-auto rounded border border-bridge-700">
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Time</th>
                                <th>Type</th>
                                <th>Label</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(data.events ?? []).map((e, i) => (
                                <tr key={i}>
                                  <td className="font-mono text-2xs">{simClock(e.sim_time_s)}</td>
                                  <td className="text-2xs">{e.event_type.replace(/_/g, ' ')}</td>
                                  <td className="text-2xs text-bridge-100">{e.label}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {(data.events?.length ?? 0) === 0 && (
                          <EmptyState title="No scenario events" detail="Fault injections and control actions appear here." icon="▶" />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            }}
          </QueryBoundary>
        </div>
      </Panel>

      {report?.overall && (
        <Panel title="Across every recorded run" subtitle="Fleet-level view of the platform's own performance">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Readout label="Runs" value={report.overall.runs ?? 0} size="sm" />
            <Readout label="Epochs" value={report.overall.epochs ?? 0} size="sm" />
            <Readout label="Mean error" value={number(report.overall.mean_error_m)} unit="m" size="sm" />
            <Readout label="Worst error" value={number(report.overall.max_error_m)} unit="m" size="sm" />
            <Readout label="Requirement met" value={number(report.overall.requirement_met_pct, 1)} unit="%" size="sm" />
            <Readout
              label="Bound exceeded"
              value={number(report.overall.protection_level_exceeded_pct, 2)}
              unit="%"
              size="sm"
              tone={(report.overall.protection_level_exceeded_pct ?? 0) > 5 ? 'critical' : 'assured'}
            />
          </div>
        </Panel>
      )}
    </div>
  );
}

export default AnalyticsPage;
