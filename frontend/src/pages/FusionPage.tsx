/**
 * Fusion and integrity panel (Section 15.4).
 *
 * The engineering view: filter state, covariance, what each sensor contributed
 * this epoch, how the protection level was assembled, and what the localization
 * engines actually decided. Everything the specification asks to be exposed for
 * debugging is exposed here rather than hidden.
 */

import { useMemo, useState } from 'react';
import { useAppSelector } from '../store';
import { useIntegrityDetailQuery, useLocalizationDetailQuery, useBathymetricDetailQuery, errorMessage } from '../api/api';
import { EmptyState, KeyValue, Note, Panel, QueryBoundary, Readout, StatusChip, Tabs } from '../components/ui';
import { LineChart, ErrorVsProtectionChart } from '../charts/charts';
import { bearing, duration, metres, number, EM_DASH } from '../utils/format';
import { INTEGRITY_PRESENTATION, REQUIREMENT_PRESENTATION } from '../utils/status';

type Tab = 'integrity' | 'filter' | 'localization' | 'terrain';

function CovarianceMatrix({ covariance, labels }: { covariance: number[][]; labels: string[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table text-2xs">
        <thead>
          <tr>
            <th />
            {labels.map((l) => (
              <th key={l} className="text-right font-mono">
                {l.replace(/_/g, ' ').replace(' m', '').replace(' rad', '')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {covariance.map((row, i) => (
            <tr key={i}>
              <th scope="row" className="whitespace-nowrap px-3 py-1 text-left font-mono text-bridge-300">
                {labels[i]?.replace(/_/g, ' ')}
              </th>
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`text-right font-mono ${i === j ? 'font-semibold text-bridge-100' : 'text-bridge-500'}`}
                >
                  {Math.abs(cell) < 1e-9 ? '0' : cell.toExponential(2)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FusionPage() {
  const navigation = useAppSelector((s) => s.live.navigation);
  const history = useAppSelector((s) => s.live.history);
  const [tab, setTab] = useState<Tab>('integrity');

  const { data: integrityDetail, isLoading, isError, error, refetch } = useIntegrityDetailQuery(undefined, {
    pollingInterval: 2000
  });
  const { data: localization } = useLocalizationDetailQuery(undefined, { pollingInterval: 2000, skip: tab !== 'localization' });
  const { data: bathymetric } = useBathymetricDetailQuery(undefined, { pollingInterval: 2000, skip: tab !== 'terrain' });

  const errorSeries = useMemo(
    () =>
      history.slice(-900).map((h) => ({
        t: h.t,
        actual: h.actual,
        estimated: h.estimated,
        hpl: h.hpl
      })),
    [history]
  );

  const drSeries = useMemo(() => history.slice(-900).map((h) => ({ t: h.t, value: h.drDuration })), [history]);
  const sourcesSeries = useMemo(
    () => history.slice(-900).map((h) => ({ t: h.t, value: h.absoluteSources })),
    [history]
  );

  if (!navigation) {
    return (
      <Panel title="Fusion and integrity">
        <EmptyState
          title="No solution running"
          detail="Start a scenario or replay to inspect the filter."
          icon="⬡"
        />
      </Panel>
    );
  }

  const integrity = navigation.integrity;
  const requirement = REQUIREMENT_PRESENTATION[integrity.requirement_status];
  const integrityStatus = INTEGRITY_PRESENTATION[integrity.integrity_status];
  const debug = integrityDetail?.fusion_debug ?? navigation.fusion_debug;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="panel px-4 py-3">
          <Readout
            label="Protection level"
            value={number(integrity.horizontal_protection_level_m)}
            unit="m"
            tone={
              integrity.horizontal_protection_level_m === null
                ? undefined
                : integrity.horizontal_protection_level_m > integrity.requirement_limit_m
                  ? 'critical'
                  : 'assured'
            }
            hint="A bound, at 95% confidence"
          />
        </div>
        <div className="panel px-4 py-3">
          <Readout
            label="Estimated horizontal error"
            value={number(integrity.estimated_horizontal_error_m)}
            unit="m"
            hint="Expected magnitude from the covariance"
          />
        </div>
        <div className="panel px-4 py-3">
          <Readout
            label="Actual error"
            value={number(navigation.actual_error_vs_truth_m)}
            unit="m"
            tone="caution"
            hint="Against simulated ground truth only"
          />
        </div>
        <div className="panel px-4 py-3">
          <p className="readout-label">Status</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusChip presentation={integrityStatus} />
            <StatusChip presentation={requirement} />
          </div>
          <p className="mt-2 text-2xs leading-tight text-bridge-500">{integrity.requirement_statement}</p>
        </div>
      </div>

      <Panel bodyClassName="p-0">
        <div className="px-4 pt-3">
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'integrity', label: 'Integrity build-up' },
              { id: 'filter', label: 'Filter state' },
              { id: 'localization', label: 'Localization engines' },
              { id: 'terrain', label: 'Terrain matching' }
            ]}
          />
        </div>

        <div className="p-4">
          {tab === 'integrity' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <p className="panel-title mb-2">How the protection level was assembled</p>
                <KeyValue
                  label="1-sigma major axis"
                  value={metres(integrity.confidence_ellipse.one_sigma_major_m, 3)}
                  title="Largest eigenvalue of the horizontal position covariance"
                />
                <KeyValue
                  label="1-sigma minor axis"
                  value={metres(integrity.confidence_ellipse.one_sigma_minor_m, 3)}
                />
                <KeyValue label="Ellipse orientation" value={bearing(integrity.confidence_ellipse.orientation_deg)} />
                <KeyValue
                  label="Irreducible correlated error"
                  value={metres(integrity.correlated_sigma_m, 3)}
                  title="The slowly varying component no filter can average away"
                />
                <KeyValue
                  label="Inflation factor"
                  value={`× ${number(integrity.protection_level_inflation, 3)}`}
                  tone={integrity.protection_level_inflation > 1 ? 'caution' : undefined}
                />
                {integrity.protection_level_inflation_reasons.length > 0 && (
                  <p className="mt-1 text-2xs text-caution">
                    {integrity.protection_level_inflation_reasons.map((r) => r.replace(/_/g, ' ').toLowerCase()).join(', ')}
                  </p>
                )}
                <KeyValue
                  label="Fault bias margin"
                  value={metres(integrity.bias_margin_m, 3)}
                  title="Largest position error a just-undetectable measurement fault could induce"
                />
                <KeyValue label="DRMS" value={metres(integrity.drms_m, 3)} />
                <KeyValue label="95% radius" value={metres(integrity.radius_95_m, 3)} />
                <KeyValue label="99% radius" value={metres(integrity.radius_99_m, 3)} />
                <KeyValue
                  label="Horizontal protection level"
                  value={metres(integrity.horizontal_protection_level_m, 3)}
                  tone={
                    integrity.horizontal_protection_level_m !== null &&
                    integrity.horizontal_protection_level_m > integrity.requirement_limit_m
                      ? 'critical'
                      : 'assured'
                  }
                />
                <KeyValue
                  label="Vertical protection level"
                  value={integrity.vertical_protection_level_m ?? 'Not implemented'}
                  title={integrity.vertical_protection_level_status}
                />
                <p className="mt-1 text-2xs text-bridge-500">
                  Vertical is not published: this platform has no independent vertical reference beyond the echo
                  sounder, and a VPL derived from it alone would be misleading.
                </p>
              </div>

              <div>
                <p className="panel-title mb-2">Availability and redundancy</p>
                <KeyValue
                  label="Independent absolute sources"
                  value={String(integrity.independent_absolute_sources)}
                  tone={
                    integrity.independent_absolute_sources === 0
                      ? 'critical'
                      : integrity.independent_absolute_sources === 1
                        ? 'caution'
                        : 'assured'
                  }
                />
                <KeyValue label="Source identifiers" value={integrity.absolute_source_ids.join(', ') || EM_DASH} />
                <KeyValue label="Last absolute fix from" value={integrity.last_absolute_fix_source ?? EM_DASH} />
                <KeyValue label="Time since absolute fix" value={duration(integrity.time_since_last_absolute_fix_s)} />
                <KeyValue label="Dead-reckoning duration" value={duration(integrity.dead_reckoning_duration_s)} />
                <KeyValue
                  label="Uncertainty growth rate"
                  value={`${number(integrity.protection_level_growth_rate_m_per_s, 3)} m/s`}
                  title="How fast the protection level is opening up. Sustained positive growth means the bound will cross the limit; the time remaining is on the navigation screen."
                  tone={integrity.protection_level_growth_rate_m_per_s > 0.05 ? 'caution' : undefined}
                />
                <KeyValue label="Solution age" value={duration(integrity.solution_age_s)} />
                <KeyValue label="Sensor diversity" value={`${(integrity.sensor_diversity_score * 100).toFixed(0)} %`} />
                <KeyValue label="Measurement principles" value={integrity.measurement_principles.length} />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {integrity.measurement_principles.map((p) => (
                    <span key={p} className="chip border-bridge-600 bg-bridge-800 text-bridge-300">
                      {p.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  ))}
                </div>
                <KeyValue label="Fault detection" value={integrity.fault_detection_status.replace(/_/g, ' ')} />

                <div className="mt-4">
                  <Note>
                    Two GNSS receivers are not diversity. Diversity counts independent measurement <em>principles</em>:
                    satellite ranging, radio imaging, optical imaging, acoustic terrain, acoustic Doppler, inertial.
                    A fault that affects one principle does not affect another.
                  </Note>
                </div>
              </div>

              <div className="lg:col-span-2">
                <p className="panel-title mb-2">Bound against error</p>
                <ErrorVsProtectionChart
                  data={errorSeries}
                  limit={integrity.requirement_limit_m}
                  showActual={navigation.actual_error_vs_truth_m !== null}
                  height={260}
                />
                <Note>
                  The protection level (amber) must stay above the actual error (green) for the platform to be
                  believable. Epochs where it does not are counted as <em>misleading information</em> in the
                  performance report, and are the strictest measure of whether this system can be trusted.
                </Note>
              </div>

              <div>
                <p className="panel-title mb-2">Independent absolute sources over time</p>
                <LineChart data={sourcesSeries} label="Absolute sources" unit="count" colour="assured" height={160} />
              </div>
              <div>
                <p className="panel-title mb-2">Dead-reckoning duration</p>
                <LineChart
                  data={drSeries}
                  label="DR duration"
                  unit="s"
                  colour="chart-series-f"
                  markLineAt={120}
                  markLineLabel="unassisted limit"
                  height={160}
                />
              </div>
            </div>
          )}

          {tab === 'filter' && (
            <QueryBoundary
              isLoading={isLoading}
              isError={isError}
              error={isError ? { message: errorMessage(error) } : undefined}
              data={debug}
              onRetry={refetch}
            >
              {(dbg: any) => (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div>
                    <p className="panel-title mb-2">Extended Kalman Filter state</p>
                    {dbg.state ? (
                      Object.entries(dbg.state).map(([key, value]) => (
                        <KeyValue
                          key={key}
                          label={key.replace(/_/g, ' ')}
                          value={
                            key.includes('rad')
                              ? `${(((value as number) * 180) / Math.PI).toFixed(4)}°`
                              : number(value as number, 5)
                          }
                        />
                      ))
                    ) : (
                      <p className="text-xs text-bridge-400">State not available.</p>
                    )}
                    {dbg.variances && (
                      <>
                        <p className="panel-title mb-2 mt-4">State standard deviations</p>
                        {Object.entries(dbg.variances).map(([key, value]) => (
                          <KeyValue
                            key={key}
                            label={key.replace(/_/g, ' ')}
                            value={
                              key.includes('rad')
                                ? `${((Math.sqrt(value as number) * 180) / Math.PI).toFixed(5)}°`
                                : number(Math.sqrt(value as number), 5)
                            }
                          />
                        ))}
                      </>
                    )}
                    <KeyValue label="Velocity noise scale" value={`× ${number(dbg.velocity_noise_scale, 1)}`} />
                    <KeyValue label="Updates applied" value={dbg.update_count} />
                  </div>

                  <div>
                    <p className="panel-title mb-2">Measurements offered this epoch</p>
                    {(dbg.contributors?.length ?? 0) + (dbg.rejections?.length ?? 0) === 0 &&
                    (navigation.fusion_debug?.residuals.length ?? 0) === 0 ? (
                      <p className="text-xs text-bridge-400">No measurements this epoch.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Sensor</th>
                              <th>Kind</th>
                              <th className="text-right">Residual</th>
                              <th className="text-right">Norm.</th>
                              <th>Decision</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(navigation.fusion_debug?.residuals ?? []).map((r, i) => (
                              <tr key={i}>
                                <td className="font-mono text-2xs">{r.sensor_id}</td>
                                <td className="text-2xs">{r.kind}</td>
                                <td className="text-right font-mono text-2xs">{number(r.residual, 4)}</td>
                                <td
                                  className={`text-right font-mono text-2xs ${
                                    (r.normalized_residual ?? 0) > 3 ? 'text-caution' : ''
                                  }`}
                                >
                                  {number(r.normalized_residual, 2)}
                                </td>
                                <td className="text-2xs">
                                  <span
                                    className={
                                      r.decision === 'ACCEPTED'
                                        ? 'text-assured'
                                        : r.decision === 'REJECTED'
                                          ? 'text-critical'
                                          : 'text-bridge-400'
                                    }
                                  >
                                    {r.decision}
                                  </span>
                                  {r.monitor_only && <span className="ml-1 text-bridge-500">(monitored)</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {dbg.covariance && (
                      <>
                        <p className="panel-title mb-2 mt-4">Covariance matrix</p>
                        <CovarianceMatrix
                          covariance={dbg.covariance}
                          labels={[
                            'east_m',
                            'north_m',
                            'v_east',
                            'v_north',
                            'heading_rad',
                            'gyro_bias_rad',
                            'speed_scale'
                          ]}
                        />
                      </>
                    )}
                  </div>

                  <div className="lg:col-span-2">
                    <Note>
                      The filter runs in a local East-North-Up frame anchored at the harbour reference point and is
                      converted to WGS84 only for display. Heading is propagated using the gyrocompass rate of turn, so
                      the solution follows a manoeuvre rather than treating it as a sequence of outliers.
                    </Note>
                  </div>
                </div>
              )}
            </QueryBoundary>
          )}

          {tab === 'localization' && (
            <div className="grid gap-4 lg:grid-cols-2">
              {[
                { key: 'radar', title: 'Radar map matching', result: localization?.radar },
                { key: 'lidar', title: 'LiDAR map matching', result: localization?.lidar },
                { key: 'local_ranging', title: 'Local ranging', result: localization?.local_ranging }
              ].map(({ key, title, result }) => (
                <div key={key}>
                  <p className="panel-title mb-2">{title}</p>
                  {result ? (
                    <>
                      <KeyValue label="Valid" value={result.valid ? 'Yes' : 'No'} tone={result.valid ? 'assured' : 'critical'} />
                      <KeyValue label="Reason" value={result.reason ?? EM_DASH} />
                      <KeyValue label="Confidence" value={`${((result.confidence ?? 0) * 100).toFixed(0)} %`} />
                      <KeyValue label="Sigma" value={metres(result.sigma_m, 3)} />
                      {result.selected_mode && <KeyValue label="Selected mode" value={result.selected_mode} />}
                      {result.selection_reason && (
                        <p className="mt-1 text-2xs leading-relaxed text-bridge-400">{result.selection_reason}</p>
                      )}
                      {result.mode_b && (
                        <div className="mt-2 rounded border border-bridge-700 bg-bridge-850 p-2">
                          <p className="text-2xs font-semibold uppercase tracking-wider text-bridge-300">
                            Mode B — independent scan matching
                          </p>
                          <KeyValue label="Converged" value={result.mode_b.valid ? 'Yes' : 'No'} />
                          <KeyValue label="Inliers" value={result.mode_b.inliers ?? EM_DASH} />
                          <KeyValue label="RMS residual" value={metres(result.mode_b.residual_m, 3)} />
                          <KeyValue label="Iterations" value={result.mode_b.iterations ?? EM_DASH} />
                        </div>
                      )}
                      {result.method && <KeyValue label="Method" value={result.method.replace(/_/g, ' ')} />}
                      {result.beacon_count != null && <KeyValue label="Beacons used" value={result.beacon_count} />}
                      {result.gdop != null && <KeyValue label="GDOP" value={number(result.gdop, 2)} />}
                    </>
                  ) : (
                    <p className="text-xs text-bridge-400">No result. Start a scenario.</p>
                  )}
                </div>
              ))}

              <div>
                <p className="panel-title mb-2">Dead reckoning</p>
                {localization?.dead_reckoning ? (
                  <>
                    <KeyValue label="Uncertainty" value={metres(localization.dead_reckoning.sigma_m, 3)} />
                    <KeyValue label="Elapsed since anchor" value={duration(localization.dead_reckoning.duration_s)} />
                    <KeyValue label="Bottom lock" value={localization.dead_reckoning.bottom_lock ? 'Yes' : 'No'} />
                    <KeyValue label="Velocity source" value={localization.dead_reckoning.velocity_source ?? EM_DASH} />
                    <KeyValue
                      label="Dominant error source"
                      value={localization.dead_reckoning.dominant_error_source.replace(/_/g, ' ').toLowerCase()}
                    />
                    <Note>
                      Dead-reckoning uncertainty grows as the square root of time from velocity noise, plus a linear
                      term from residual heading bias and log scale error. The linear term dominates after a couple of
                      minutes, which is why unbounded dead reckoning can never satisfy a 2 m requirement for long.
                    </Note>
                  </>
                ) : (
                  <p className="text-xs text-bridge-400">Not anchored.</p>
                )}
              </div>

              <div className="lg:col-span-2">
                <Note tone="info">{localization?.mode_note}</Note>
              </div>
            </div>
          )}

          {tab === 'terrain' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <p className="panel-title mb-2">Bathymetric terrain matching</p>
                {bathymetric?.result ? (
                  <>
                    <KeyValue
                      label="Valid"
                      value={bathymetric.result.valid ? 'Yes' : 'No'}
                      tone={bathymetric.result.valid ? 'assured' : 'critical'}
                    />
                    <KeyValue label="Reason" value={(bathymetric.result.reason ?? '').replace(/_/g, ' ')} />
                    <KeyValue label="Confidence" value={`${((bathymetric.result.confidence ?? 0) * 100).toFixed(0)} %`} />
                    <KeyValue
                      label="Ambiguity score"
                      value={`${((bathymetric.result.ambiguity_score ?? 0) * 100).toFixed(0)} %`}
                      tone={(bathymetric.result.ambiguity_score ?? 0) > 0.6 ? 'critical' : undefined}
                    />
                    <KeyValue
                      label="Terrain observability"
                      value={`${((bathymetric.result.terrain_observability ?? 0) * 100).toFixed(0)} %`}
                      tone={(bathymetric.result.terrain_observability ?? 0) < 0.15 ? 'caution' : undefined}
                    />
                    <KeyValue label="Distinct candidate modes" value={bathymetric.result.mode_count ?? EM_DASH} />
                    <KeyValue label="Candidates evaluated" value={bathymetric.result.candidate_count ?? EM_DASH} />
                    <KeyValue label="RMS depth residual" value={metres(bathymetric.result.residual_rms_m, 3)} />
                    <KeyValue label="Estimated depth bias" value={metres(bathymetric.result.depth_bias_m, 3)} />
                    <KeyValue label="Sequence length" value={bathymetric.result.sequence_length ?? EM_DASH} />
                    <KeyValue label="Along-track relief" value={metres(bathymetric.result.track_relief_m, 3)} />
                    <KeyValue label="Position sigma" value={metres(bathymetric.result.sigma_m, 2)} />
                  </>
                ) : (
                  <p className="text-xs text-bridge-400">No terrain match result yet.</p>
                )}
              </div>

              <div>
                <p className="panel-title mb-2">Candidate positions</p>
                {bathymetric?.result?.top_candidates?.length ? (
                  <>
                    <div className="max-h-64 overflow-auto rounded border border-bridge-700">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Offset E</th>
                            <th>Offset N</th>
                            <th className="text-right">Weight</th>
                            <th className="text-right">Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bathymetric.result.top_candidates.map((c: any, i: number) => (
                            <tr key={i}>
                              <td className="font-mono text-2xs">{c.offset_east_m} m</td>
                              <td className="font-mono text-2xs">{c.offset_north_m} m</td>
                              <td className="text-right font-mono text-2xs">{(c.weight * 100).toFixed(2)} %</td>
                              <td className="text-right font-mono text-2xs">{c.cost}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Note tone="caution">
                      When several candidates carry similar weight at positions tens of metres apart, the seabed here
                      is consistent with more than one location. The engine reports that as ambiguity and the fusion
                      filter down-weights or rejects the fix, rather than publishing a confident wrong answer.
                    </Note>
                  </>
                ) : (
                  <p className="text-xs text-bridge-400">No candidate surface available.</p>
                )}
                <Note>{bathymetric?.note}</Note>
              </div>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

export default FusionPage;
