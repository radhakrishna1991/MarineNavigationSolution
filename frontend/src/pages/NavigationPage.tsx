/**
 * Main navigation screen (Section 15.1).
 *
 * Everything a bridge watchkeeper needs in one view: the chart, the trusted
 * position, what is producing it, how well it is bounded, and what is wrong.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../store';
import { MapView } from '../map/MapView';
import { StatusBanner } from '../components/StatusBanner';
import { KeyValue, Meter, Note, Panel, Readout, StatusChip, EmptyState } from '../components/ui';
import { Sparkline } from '../charts/charts';
import {
  bearing,
  duration,
  latitudeDm,
  longitudeDm,
  metres,
  number,
  simClock,
  speed as fmtSpeed,
  EM_DASH
} from '../utils/format';
import {
  INTEGRITY_PRESENTATION,
  REQUIREMENT_PRESENTATION,
  SEVERITY_PRESENTATION,
  sourceColours,
  TRUST_PRESENTATION,
  modePresentation,
  sensorTone,
  type SourceKey
} from '../utils/status';
import { useAcknowledgeAlarmMutation } from '../api/api';
import { alarmAcknowledgedLocally } from '../store/liveSlice';
import { toastAdded } from '../store/uiSlice';
import type { NavigationOutput } from '../types';

function PositionPanel({ navigation }: { navigation: NavigationOutput }) {
  const units = useAppSelector((s) => s.ui.units);
  const pos = navigation.trusted_position;
  return (
    <Panel title="Trusted position" subtitle="Fused solution — distinct from any single sensor">
      {pos ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="readout-label">Latitude</p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-bridge-100">
                {latitudeDm(pos.latitude)}
              </p>
            </div>
            <div>
              <p className="readout-label">Longitude</p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-bridge-100">
                {longitudeDm(pos.longitude)}
              </p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Readout label="Heading" value={bearing(navigation.heading_deg)} size="sm" />
            <Readout label="Course" value={bearing(navigation.course_deg)} size="sm" />
            <Readout label="Speed" value={fmtSpeed(navigation.velocity?.speed_mps, units)} size="sm" />
          </div>
          <div className="mt-4 space-y-1">
            <KeyValue label="Local east / north" value={`${number(pos.east_m, 1)} / ${number(pos.north_m, 1)} m`} />
            <KeyValue label="Gyro bias estimate" value={`${number(navigation.gyro_bias_deg, 3)}°`} />
            <KeyValue label="Log scale factor" value={number(navigation.speed_scale_factor, 4)} />
            <KeyValue
              label="Solution confidence"
              value={`${(navigation.solution_confidence * 100).toFixed(0)} %`}
              tone={navigation.solution_confidence > 0.7 ? 'assured' : navigation.solution_confidence > 0.4 ? 'caution' : 'critical'}
            />
          </div>
          {navigation.ground_truth && (
            <div className="mt-3 rounded-md border border-caution/35 bg-caution/10 p-2.5">
              <p className="text-2xs font-semibold uppercase tracking-wider text-caution">
                Simulation reference — not available at sea
              </p>
              <div className="mt-1.5 space-y-1">
                <KeyValue label="Actual error vs ground truth" value={metres(navigation.actual_error_vs_truth_m)} />
                <KeyValue label="Raw GNSS error vs ground truth" value={metres(navigation.gnss.error_vs_truth_m)} />
                <KeyValue label="Zone" value={navigation.ground_truth.zone?.replace(/_/g, ' ') ?? EM_DASH} />
                <KeyValue label="Seabed depth" value={metres(navigation.ground_truth.depth_m, 1)} />
              </div>
            </div>
          )}
        </>
      ) : (
        <EmptyState
          title="No trusted position"
          detail="The filter has not been seeded. It needs both an absolute position source and a heading reference before it will publish a solution."
          icon="◎"
        />
      )}
    </Panel>
  );
}

function IntegrityPanel({ navigation }: { navigation: NavigationOutput }) {
  const history = useAppSelector((s) => s.live.history);
  const integrity = navigation.integrity;
  const limit = integrity.requirement_limit_m;
  const hpl = integrity.horizontal_protection_level_m;
  const requirement = REQUIREMENT_PRESENTATION[integrity.requirement_status];
  const integrityStatus = INTEGRITY_PRESENTATION[integrity.integrity_status];

  const sparkData = useMemo(() => history.slice(-240).map((h) => h.hpl), [history]);

  return (
    <Panel
      title="Integrity"
      subtitle="Bound on the error, not an estimate of it"
      tone={integrity.integrity_status === 'NOT_ASSURED' ? 'critical' : undefined}
      actions={<StatusChip presentation={integrityStatus} />}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Readout
          label="Horizontal protection level"
          value={hpl === null ? EM_DASH : hpl.toFixed(2)}
          unit="m"
          tone={hpl === null ? undefined : hpl > limit ? 'critical' : hpl > limit * 0.75 ? 'caution' : 'assured'}
        />
        <StatusChip presentation={requirement} size="lg" />
      </div>

      <div className="mt-3">
        <Sparkline data={sparkData} colour="caution" limit={limit} height={36} />
      </div>

      <div className="mt-3">
        <Meter
          value={hpl}
          max={Math.max(limit * 2, (hpl ?? 0) * 1.15)}
          limit={limit}
          tone={hpl === null ? 'info' : hpl > limit ? 'critical' : hpl > limit * 0.75 ? 'caution' : 'assured'}
          label={`Against the ${limit} m limit`}
          formatValue={(v) => `${v.toFixed(2)} m`}
        />
      </div>

      <div className="mt-4 space-y-1">
        <KeyValue label="Estimated horizontal error" value={metres(integrity.estimated_horizontal_error_m)} />
        <KeyValue label="95% confidence radius" value={metres(integrity.radius_95_m)} />
        <KeyValue label="99% confidence radius" value={metres(integrity.radius_99_m)} />
        <KeyValue
          label="Confidence ellipse"
          value={`${metres(integrity.confidence_ellipse.semi_major_m)} × ${metres(integrity.confidence_ellipse.semi_minor_m)} @ ${bearing(integrity.confidence_ellipse.orientation_deg)}`}
        />
        <KeyValue
          label="Independent absolute sources"
          value={String(integrity.independent_absolute_sources)}
          tone={integrity.independent_absolute_sources === 0 ? 'critical' : integrity.independent_absolute_sources === 1 ? 'caution' : 'assured'}
        />
        <KeyValue label="Sensor diversity" value={`${(integrity.sensor_diversity_score * 100).toFixed(0)} %`} />
        <KeyValue label="Time since absolute fix" value={duration(integrity.time_since_last_absolute_fix_s)} />
        <KeyValue
          label="Dead-reckoning duration"
          value={duration(integrity.dead_reckoning_duration_s)}
          tone={(integrity.dead_reckoning_duration_s ?? 0) > 120 ? 'critical' : undefined}
        />
        <KeyValue
          label="Uncertainty growth"
          value={`${number(integrity.protection_level_growth_rate_m_per_s, 3)} m/s`}
          tone={integrity.protection_level_growth_rate_m_per_s > 0.05 ? 'caution' : undefined}
        />
        {/* Time is the other thing GNSS provides, and the other thing an
            attacker can falsify. Once GNSS is rejected, UTC is in holdover. */}
        {navigation.time_integrity && (
          <>
            <KeyValue
              label="UTC source"
              value={navigation.time_integrity.utc_source}
              title={navigation.time_integrity.reasons.join(' ') || 'Disciplined by a trusted GNSS clock.'}
              tone={
                navigation.time_integrity.utc_source === 'GNSS'
                  ? undefined
                  : navigation.time_integrity.utc_trusted
                    ? 'caution'
                    : 'critical'
              }
            />
            <KeyValue
              label="UTC error bound"
              value={
                navigation.time_integrity.utc_error_bound_s === null
                  ? 'Unknown'
                  : `${number(navigation.time_integrity.utc_error_bound_s, 3)} s`
              }
              title={`Required accuracy ${navigation.time_integrity.required_accuracy_s} s.`}
              tone={navigation.time_integrity.utc_trusted ? undefined : 'critical'}
            />
          </>
        )}
      </div>

      {integrity.requirement_reasons.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-bridge-800 pt-3">
          {integrity.requirement_reasons.map((reason, i) => (
            <li key={i} className="text-xs leading-relaxed text-bridge-300">
              <span aria-hidden className={`mr-1.5 ${requirement.text}`}>
                {requirement.glyph}
              </span>
              {reason}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        <Note>
          The protection level is a <strong>bound</strong> the system undertakes to respect at{' '}
          {(integrity.requirement_confidence * 100).toFixed(0)}% confidence. It is not the same thing as the
          estimated error, and neither is the same thing as the actual error.
        </Note>
      </div>
    </Panel>
  );
}

function SourcesPanel({ navigation }: { navigation: NavigationOutput }) {
  const localization = navigation.localization;
  const entries: Array<{ key: SourceKey; label: string; valid: boolean; detail: string }> = [
    {
      key: 'radar',
      label: 'Radar map matching',
      valid: Boolean(localization.radar?.valid),
      detail: localization.radar?.valid
        ? `confidence ${((localization.radar.confidence ?? 0) * 100).toFixed(0)}% · σ ${metres(localization.radar.sigma_m)} · ${localization.radar.selected_mode ?? ''}`
        : (localization.radar?.reason ?? 'unavailable').replace(/_/g, ' ').toLowerCase()
    },
    {
      key: 'lidar',
      label: 'LiDAR map matching',
      valid: Boolean(localization.lidar?.valid),
      detail: localization.lidar?.valid
        ? `confidence ${((localization.lidar.confidence ?? 0) * 100).toFixed(0)}% · σ ${metres(localization.lidar.sigma_m)}`
        : (localization.lidar?.reason ?? 'out of range').replace(/_/g, ' ').toLowerCase()
    },
    {
      key: 'bathymetric',
      label: 'Bathymetric terrain matching',
      valid: Boolean(localization.bathymetric?.valid),
      detail: localization.bathymetric?.valid
        ? `confidence ${((localization.bathymetric.confidence ?? 0) * 100).toFixed(0)}% · ambiguity ${((localization.bathymetric.ambiguity_score ?? 0) * 100).toFixed(0)}%`
        : (localization.bathymetric?.reason ?? 'unavailable').replace(/_/g, ' ').toLowerCase()
    },
    {
      key: 'localRanging',
      label: 'Local ranging',
      valid: Boolean(localization.local_ranging?.valid),
      detail: localization.local_ranging?.valid
        ? `${localization.local_ranging.beacon_count ?? '?'} beacons · σ ${metres(localization.local_ranging.sigma_m)}`
        : 'no coverage'
    },
    {
      key: 'deadReckoning',
      label: 'Dead reckoning',
      valid: Boolean(localization.dead_reckoning),
      detail: localization.dead_reckoning
        ? `σ ${metres(localization.dead_reckoning.sigma_m)} after ${duration(localization.dead_reckoning.duration_s)} · limited by ${localization.dead_reckoning.dominant_error_source.replace(/_/g, ' ').toLowerCase()}`
        : 'not anchored'
    }
  ];

  return (
    <Panel title="Positioning sources" subtitle="What is holding the position up right now">
      <ul className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.key} className="flex items-start gap-2.5">
            <span
              aria-hidden
              className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border"
              style={{
                borderColor: sourceColours()[entry.key],
                backgroundColor: entry.valid ? sourceColours()[entry.key] : 'transparent'
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className={`text-sm ${entry.valid ? 'text-bridge-100' : 'text-bridge-500'}`}>{entry.label}</span>
                <span className={`text-2xs font-semibold uppercase ${entry.valid ? 'text-assured' : 'text-bridge-500'}`}>
                  {entry.valid ? 'Valid' : 'Not valid'}
                </span>
              </div>
              <p className="truncate text-2xs text-bridge-400" title={entry.detail}>
                {entry.detail}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-4 border-t border-bridge-800 pt-3">
        <p className="readout-label">Contributing this epoch</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {navigation.contributing_sensors.length === 0 ? (
            <span className="text-xs text-bridge-500">None</span>
          ) : (
            navigation.contributing_sensors.map((id) => (
              <span key={id} className="chip border-assured/40 bg-assured/10 text-assured">
                <span aria-hidden>✓</span>
                {id}
              </span>
            ))
          )}
        </div>
      </div>

      {navigation.excluded_sensors.length > 0 && (
        <div className="mt-3">
          <p className="readout-label">Excluded</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {navigation.excluded_sensors.map((id) => {
              const health = navigation.sensor_health.find((h) => h.sensor_id === id);
              return (
                <span
                  key={id}
                  className="chip border-critical/40 bg-critical/10 text-critical"
                  title={health?.exclusion_reason ?? undefined}
                >
                  <span aria-hidden>✕</span>
                  {id}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

function GnssSummaryPanel({ navigation }: { navigation: NavigationOutput }) {
  const gnss = navigation.gnss;
  const trust = TRUST_PRESENTATION[gnss.status];
  return (
    <Panel
      title="GNSS"
      subtitle="Treated as one potentially untrusted sensor"
      tone={gnss.spoofing_suspected ? 'critical' : undefined}
      actions={
        <Link to="/gnss" className="btn-ghost btn-sm">
          Detail →
        </Link>
      }
    >
      <div className="flex items-center justify-between gap-3">
        <Readout
          label="Trust score"
          value={gnss.trust_score.toFixed(0)}
          unit="/100"
          tone={
            gnss.trust_score > 90
              ? 'assured'
              : gnss.trust_score > 75
                ? 'assured'
                : gnss.trust_score > 50
                  ? 'caution'
                  : 'critical'
          }
        />
        <StatusChip presentation={trust} size="lg" />
      </div>

      <div className="mt-3">
        <Meter
          value={gnss.trust_score}
          max={100}
          tone={gnss.trust_score > 75 ? 'assured' : gnss.trust_score > 50 ? 'caution' : 'critical'}
        />
      </div>

      <p className="mt-3 text-xs leading-relaxed text-bridge-300">{gnss.explanation}</p>

      {gnss.detected_conditions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {gnss.detected_conditions.map((c) => (
            <span key={c} className="chip border-critical/40 bg-critical/10 text-critical">
              {c.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      )}

      {gnss.recovery && (
        <div className="mt-3 rounded-md border border-info/40 bg-info/10 p-2.5">
          <p className="text-2xs font-semibold uppercase tracking-wider text-info">
            Recovery validation {gnss.recovery.complete ? 'complete' : 'in progress'}
          </p>
          <div className="mt-1.5">
            <Meter
              value={gnss.recovery.elapsed_s}
              max={gnss.recovery.required_s}
              tone="info"
              label={`${gnss.recovery.elapsed_s.toFixed(0)} s of ${gnss.recovery.required_s} s`}
              formatValue={(v) => `${v.toFixed(0)} s`}
            />
          </div>
          <p className="mt-1.5 text-2xs text-bridge-300">
            {gnss.recovery.consistent_samples}/{gnss.recovery.total_samples} samples consistent · maximum difference{' '}
            {metres(gnss.recovery.max_difference_m)}. GNSS is not contributing until validation completes.
          </p>
        </div>
      )}

      <div className="mt-3 space-y-1">
        <KeyValue label="Fix type" value={gnss.quality.fix_type ?? EM_DASH} />
        <KeyValue label="Satellites" value={gnss.quality.satellites ?? EM_DASH} />
        <KeyValue label="HDOP" value={number(gnss.quality.hdop)} />
        <KeyValue label="Mean C/N0" value={gnss.quality.cn0_mean_dbhz ? `${gnss.quality.cn0_mean_dbhz} dB-Hz` : EM_DASH} />
        <KeyValue label="Difference from fused" value={metres(gnss.diagnostics.diff_from_fused_m as number)} />
        <KeyValue label="Difference from radar" value={metres(gnss.diagnostics.diff_from_radar_m as number)} />
      </div>
    </Panel>
  );
}

function AlarmStrip() {
  const dispatch = useAppDispatch();
  const alarms = useAppSelector((s) => s.live.activeAlarms);
  const [acknowledge, { isLoading }] = useAcknowledgeAlarmMutation();

  const sorted = useMemo(() => {
    const order = ['CRITICAL', 'WARNING', 'ADVISORY', 'INFO'];
    return [...alarms].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity)).slice(0, 6);
  }, [alarms]);

  return (
    <Panel
      title="Active alarms"
      subtitle={`${alarms.filter((a) => !a.acknowledged_at).length} unacknowledged of ${alarms.length}`}
      actions={
        <Link to="/alarms" className="btn-ghost btn-sm">
          All alarms →
        </Link>
      }
      bodyClassName="p-0"
    >
      {sorted.length === 0 ? (
        <EmptyState title="No active alarms" detail="Conditions are nominal." icon="✓" />
      ) : (
        <ul className="divide-y divide-bridge-800">
          {sorted.map((alarm) => {
            const presentation = SEVERITY_PRESENTATION[alarm.severity];
            return (
              <li
                key={alarm.id}
                className={`flex items-start gap-3 px-4 py-2.5 ${
                  alarm.severity === 'CRITICAL' && !alarm.acknowledged_at ? 'bg-critical/5' : ''
                }`}
              >
                <span aria-hidden className={`mt-0.5 text-sm ${presentation.text}`}>
                  {presentation.glyph}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className={`text-2xs font-bold uppercase tracking-wider ${presentation.text}`}>
                      {presentation.short}
                    </span>
                    <span className="text-sm text-bridge-100">{alarm.message}</span>
                    {alarm.sim_time_s !== null && (
                      <span className="font-mono text-2xs text-bridge-500">@ {simClock(alarm.sim_time_s)}</span>
                    )}
                  </div>
                  {alarm.reason && <p className="mt-0.5 text-xs leading-relaxed text-bridge-400">{alarm.reason}</p>}
                  {alarm.recommended_action && (
                    <p className="mt-1 text-xs leading-relaxed text-caution">→ {alarm.recommended_action}</p>
                  )}
                </div>
                {alarm.acknowledged_at ? (
                  <span className="shrink-0 text-2xs uppercase tracking-wider text-bridge-500">Ack</span>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary btn-sm shrink-0"
                    disabled={isLoading}
                    onClick={async () => {
                      try {
                        await acknowledge(alarm.id).unwrap();
                        dispatch(alarmAcknowledgedLocally(alarm.id));
                      } catch {
                        dispatch(toastAdded('error', 'Could not acknowledge the alarm'));
                      }
                    }}
                  >
                    Ack
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function SensorStrip({ navigation }: { navigation: NavigationOutput }) {
  return (
    <Panel
      title="Sensor status"
      actions={
        <Link to="/sensors" className="btn-ghost btn-sm">
          Detail →
        </Link>
      }
      bodyClassName="p-3"
    >
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-2">
        {navigation.sensor_health
          .filter((s) => s.sensor_id !== 'TRUTH_01')
          .map((sensor) => {
            const tone = sensorTone(sensor.excluded, sensor.online, sensor.faults);
            return (
              <div
                key={sensor.sensor_id}
                className={`rounded border px-2 py-1.5 ${tone.border} ${tone.bg}`}
                title={sensor.exclusion_reason ?? sensor.reason ?? tone.label}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-mono text-2xs text-bridge-200">{sensor.sensor_id}</span>
                  <span aria-hidden className={`text-2xs ${tone.text}`}>
                    {tone.glyph}
                  </span>
                </div>
                <p className={`text-[10px] uppercase tracking-wider ${tone.text}`}>{tone.short}</p>
              </div>
            );
          })}
      </div>
    </Panel>
  );
}

export function NavigationPage() {
  const navigation = useAppSelector((s) => s.live.navigation);
  const scenario = useAppSelector((s) => s.live.scenario);
  const mode = navigation ? modePresentation(navigation.navigation_mode) : null;

  return (
    <div className="space-y-3">
      <StatusBanner navigation={navigation} />

      {!navigation && (
        <Panel>
          <EmptyState
            title="No navigation solution is running"
            detail={
              <>
                The platform produces a trusted position only while a scenario or a replay is running. Open{' '}
                <Link to="/scenarios" className="text-info underline">
                  Replay &amp; Scenario
                </Link>{' '}
                to start one, or the{' '}
                <Link to="/demo" className="text-info underline">
                  guided demonstration
                </Link>
                .
              </>
            }
            icon="◎"
          />
        </Panel>
      )}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="space-y-3">
          <MapView navigation={navigation} className="h-[26rem] xl:h-[34rem]" />
          {navigation && mode && (
            <Panel title="Active mode" subtitle={mode.label}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <KeyValue label="Entered at" value={simClock(navigation.navigation_mode_detail.entered_at_s)} />
                  <KeyValue label="Time in mode" value={duration(navigation.navigation_mode_detail.duration_s)} />
                  <KeyValue label="Expected accuracy" value={navigation.navigation_mode_detail.expected_accuracy} />
                  <KeyValue label="Uncertainty behaviour" value={navigation.navigation_mode_detail.uncertainty_behaviour} />
                </div>
                <div>
                  <p className="text-xs leading-relaxed text-bridge-300">{navigation.navigation_mode_detail.description}</p>
                  <p className="mt-2 text-xs leading-relaxed text-caution">
                    <span className="font-semibold uppercase tracking-wider">Guidance: </span>
                    {navigation.navigation_mode_detail.operator_guidance}
                  </p>
                  <p className="mt-2 text-2xs text-bridge-500">
                    Exit: {navigation.navigation_mode_detail.exit_conditions}
                  </p>
                </div>
              </div>
            </Panel>
          )}
          <AlarmStrip />
        </div>

        <div className="space-y-3">
          {navigation && (
            <>
              <IntegrityPanel navigation={navigation} />
              <PositionPanel navigation={navigation} />
              <GnssSummaryPanel navigation={navigation} />
              <SourcesPanel navigation={navigation} />
              <SensorStrip navigation={navigation} />
            </>
          )}
          {scenario?.active_faults && scenario.active_faults.length > 0 && (
            <Panel title="Injected faults active" tone="caution">
              <ul className="space-y-1.5">
                {(scenario.faults ?? [])
                  .filter((f) => scenario.active_faults?.includes(f.id))
                  .map((f) => (
                    <li key={f.id} className="text-xs text-bridge-200">
                      <span className="font-mono text-caution">{f.sensor_id}</span> · {f.label}
                    </li>
                  ))}
              </ul>
              <Note tone="caution">
                These faults are injected by the simulator. The navigation engines are not told about them; they have
                to discover them from the data.
              </Note>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

export default NavigationPage;
