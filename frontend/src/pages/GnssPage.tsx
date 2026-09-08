/**
 * GNSS integrity panel (Section 15.3).
 *
 * This screen answers one question: should this GNSS fix be believed, and if
 * not, why not? Every cross-check the trust engine performs is shown with its
 * value and its threshold, so the decision is auditable rather than a verdict
 * from a black box.
 */

import { useMemo } from 'react';
import { useAppSelector } from '../store';
import { useGnssDetailQuery, errorMessage } from '../api/api';
import { KeyValue, Meter, Note, Panel, QueryBoundary, StatusChip, EmptyState } from '../components/ui';
import { SignalQualityChart, TrustScoreChart, LineChart } from '../charts/charts';
import { metres, number, simClock, EM_DASH } from '../utils/format';
import { TRUST_PRESENTATION } from '../utils/status';
import type { GnssAssessment } from '../types';

/** A single cross-check row: value, threshold, and whether it passed. */
function CheckRow({
  label,
  value,
  threshold,
  unit = 'm',
  breached,
  detail
}: {
  label: string;
  value: number | null | undefined;
  threshold?: number | null;
  unit?: string;
  breached?: boolean;
  detail?: string;
}) {
  const hasValue = value !== null && value !== undefined && Number.isFinite(value);
  const isBreached = breached ?? (hasValue && threshold != null ? value! > threshold : false);
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-bridge-800/60 py-1.5 last:border-0">
      <div className="min-w-0">
        <span className="text-xs text-bridge-300">{label}</span>
        {detail && <span className="block text-2xs text-bridge-500">{detail}</span>}
      </div>
      <div className="shrink-0 text-right">
        <span className={`font-mono text-xs tabular-nums ${isBreached ? 'text-critical' : hasValue ? 'text-bridge-100' : 'text-bridge-500'}`}>
          {hasValue ? `${value!.toFixed(unit === 'σ' || unit === '' ? 3 : 2)} ${unit}` : EM_DASH}
        </span>
        {threshold != null && (
          <span className="ml-2 font-mono text-2xs text-bridge-500">
            / {threshold} {unit}
          </span>
        )}
      </div>
    </div>
  );
}

export function GnssPage() {
  const navigation = useAppSelector((s) => s.live.navigation);
  const history = useAppSelector((s) => s.live.history);
  const { data, isLoading, isError, error, refetch } = useGnssDetailQuery(undefined, {
    pollingInterval: 5000
  });

  // The live socket is ahead of the polled REST snapshot, so prefer it.
  const gnss: GnssAssessment | null = navigation?.gnss ?? (data?.current as GnssAssessment | undefined) ?? null;
  const thresholds: Record<string, number> = data?.thresholds ?? {};

  const signalHistory = useMemo(
    () =>
      ((data?.history ?? []) as Array<Record<string, any>>).map((h) => ({
        t: Number(h.sim_time_s),
        cn0: h.cn0_mean_dbhz === null ? null : Number(h.cn0_mean_dbhz),
        satellites: h.satellites === null ? null : Number(h.satellites),
        hdop: h.hdop === null ? null : Number(h.hdop)
      })),
    [data]
  );

  const differenceHistory = useMemo(
    () =>
      ((data?.history ?? []) as Array<Record<string, any>>).map((h) => ({
        t: Number(h.sim_time_s),
        value: h.diff_from_radar_m === null ? null : Number(h.diff_from_radar_m)
      })),
    [data]
  );

  const trustHistory = useMemo(() => history.slice(-900).map((h) => ({ t: h.t, trust: h.trust })), [history]);

  if (!gnss) {
    return (
      <Panel title="GNSS integrity">
        <QueryBoundary
          isLoading={isLoading}
          isError={isError}
          error={isError ? { message: errorMessage(error) } : undefined}
          data={undefined}
          emptyTitle="No GNSS assessment available"
          emptyDetail="Start a scenario or a replay to begin evaluating GNSS."
          onRetry={refetch}
        >
          {() => null}
        </QueryBoundary>
      </Panel>
    );
  }

  const trust = TRUST_PRESENTATION[gnss.status];
  const d = gnss.diagnostics as Record<string, number | boolean | null>;

  return (
    <div className="space-y-3">
      {/* Verdict */}
      <Panel
        tone={gnss.spoofing_suspected ? 'critical' : gnss.jamming_suspected ? 'caution' : undefined}
        bodyClassName="p-4"
      >
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          <div>
            <p className="readout-label">GNSS trust score</p>
            <p
              className={`mt-1 font-mono text-readout font-bold tabular-nums ${
                gnss.trust_score > 75 ? 'text-assured' : gnss.trust_score > 50 ? 'text-caution' : 'text-critical'
              }`}
            >
              {gnss.trust_score.toFixed(0)}
              <span className="ml-1 text-lg font-normal text-bridge-400">/100</span>
            </p>
          </div>
          <div className="min-w-[10rem]">
            <p className="readout-label">Status</p>
            <div className="mt-2">
              <StatusChip presentation={trust} size="lg" />
            </div>
            <p className="mt-2 text-2xs text-bridge-400">{trust.meaning}</p>
          </div>
          <div className="min-w-[12rem]">
            <p className="readout-label">Decision</p>
            <p
              className={`mt-1 text-lg font-bold uppercase ${
                gnss.recommended_action === 'USE_IN_FUSION' ? 'text-assured' : gnss.recommended_action === 'DEWEIGHT_IN_FUSION' ? 'text-caution' : 'text-critical'
              }`}
            >
              {gnss.recommended_action.replace(/_/g, ' ')}
            </p>
            <p className="mt-1 text-2xs text-bridge-400">
              {gnss.used_in_fusion ? 'Contributing to the trusted position' : 'Not contributing to the trusted position'}
            </p>
          </div>
          <div className="min-w-[12rem] flex-1">
            <p className="readout-label">Classification</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <span
                className={`chip ${gnss.spoofing_suspected ? 'border-critical/50 bg-critical/15 text-critical' : 'border-bridge-600 bg-bridge-800 text-bridge-400'}`}
              >
                <span aria-hidden>{gnss.spoofing_suspected ? '✕' : '○'}</span>
                Spoofing {gnss.spoofing_suspected ? 'suspected' : 'not indicated'}
              </span>
              <span
                className={`chip ${gnss.jamming_suspected ? 'border-caution/50 bg-caution/15 text-caution' : 'border-bridge-600 bg-bridge-800 text-bridge-400'}`}
              >
                <span aria-hidden>{gnss.jamming_suspected ? '▲' : '○'}</span>
                Jamming {gnss.jamming_suspected ? 'suspected' : 'not indicated'}
              </span>
            </div>
          </div>
        </div>

        <p className="mt-4 rounded-md border border-bridge-700 bg-bridge-850 px-3 py-2 text-sm leading-relaxed text-bridge-100">
          {gnss.explanation}
        </p>

        {gnss.detected_conditions.length > 0 && (
          <div className="mt-3">
            <p className="readout-label">Confirmed conditions</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {gnss.detected_conditions.map((c: string) => (
                <span key={c} className="chip border-critical/40 bg-critical/10 text-critical">
                  {c.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          </div>
        )}
        {gnss.pending_conditions.length > 0 && (
          <div className="mt-3">
            <p className="readout-label">Pending confirmation</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {gnss.pending_conditions.map((c: string) => (
                <span key={c} className="chip border-caution/40 bg-caution/10 text-caution">
                  {c.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-2xs text-bridge-500">
              A condition must persist for several epochs before it is confirmed. This stops a single noisy fix from
              rejecting a healthy receiver.
            </p>
          </div>
        )}
      </Panel>

      {/* Recovery validation */}
      {gnss.recovery && (
        <Panel title="GNSS recovery validation" subtitle="GNSS is never trusted immediately after a rejection">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Meter
                value={gnss.recovery.elapsed_s}
                max={gnss.recovery.required_s}
                tone={gnss.recovery.complete ? 'assured' : 'info'}
                label="Validation progress"
                formatValue={(v) => `${v.toFixed(0)} s of ${gnss.recovery!.required_s} s`}
              />
              <div className="mt-3 space-y-1">
                <KeyValue label="Consistent samples" value={`${gnss.recovery.consistent_samples} / ${gnss.recovery.total_samples}`} />
                <KeyValue label="Maximum difference" value={metres(gnss.recovery.max_difference_m)} />
                <KeyValue
                  label="Status"
                  value={gnss.recovery.complete ? 'Complete — reintegrating' : 'In progress — GNSS held out'}
                  tone={gnss.recovery.complete ? 'assured' : 'caution'}
                />
              </div>
            </div>
            <Note tone="info">
              After a rejection, GNSS must agree with the trusted solution continuously for the full validation window
              before it is allowed back into the navigation solution. Any anomaly during the window restarts it from
              zero. This is what prevents a spoofer from simply pausing and resuming.
            </Note>
          </div>
        </Panel>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Cross-checks */}
        <Panel title="Cross-checks against independent sources" subtitle="How far GNSS is from things it cannot influence">
          <CheckRow
            label="Difference from radar map match"
            value={d.diff_from_radar_m as number}
            threshold={thresholds.radar_disagreement_m}
            detail="Radar localizes against stored shoreline and structures"
          />
          <CheckRow
            label="Difference from LiDAR map match"
            value={d.diff_from_lidar_m as number}
            threshold={thresholds.lidar_disagreement_m}
          />
          <CheckRow
            label="Difference from bathymetric match"
            value={d.diff_from_bathy_m as number}
            threshold={thresholds.bathymetric_disagreement_m}
          />
          <CheckRow
            label="Difference from dead reckoning"
            value={d.diff_from_dr_m as number}
            threshold={thresholds.dead_reckoning_disagreement_m}
            detail="Gyro and DVL propagation from the last trusted fix"
          />
          <CheckRow
            label="Difference from fused solution"
            value={d.diff_from_fused_m as number}
            threshold={thresholds.max_position_innovation_m}
          />
          <CheckRow
            label="Velocity difference from DVL"
            value={d.velocity_difference_mps as number}
            threshold={thresholds.max_velocity_innovation_mps}
            unit="m/s"
          />
          <CheckRow
            label="Course difference from gyrocompass"
            value={d.heading_difference_deg as number}
            threshold={thresholds.max_heading_disagreement_deg}
            unit="°"
          />
          <CheckRow
            label="Timestamp offset from system time"
            value={d.time_offset_s as number}
            threshold={thresholds.max_time_offset_s}
            unit="s"
          />
        </Panel>

        {/* Behaviour checks */}
        <Panel title="Behavioural checks" subtitle="Signatures a genuine receiver does not produce">
          <CheckRow
            label="Position drag rate"
            value={d.drag_rate_m_per_s as number}
            threshold={thresholds.drag_rate_alarm_m_per_s}
            unit="m/s"
            detail={
              d.drag_reference
                ? `measured against ${String(d.drag_reference).toLowerCase().replace(/_/g, ' ')}, R² ${number(d.drag_r2 as number, 2)}`
                : undefined
            }
          />
          <CheckRow
            label="Accumulated drag offset"
            value={d.drag_offset_m as number}
            threshold={thresholds.drag_min_offset_m}
            detail="All three drag conditions must hold together before an alarm"
          />
          <CheckRow
            label="Single-update position jump"
            value={d.position_jump_m as number}
            threshold={thresholds.max_position_jump_m}
          />
          <CheckRow
            label="Implied speed"
            value={d.speed_mps as number}
            threshold={thresholds.max_speed_mps}
            unit="m/s"
          />
          <CheckRow
            label="Implied acceleration"
            value={d.acceleration_mps2 as number}
            threshold={thresholds.max_acceleration_mps2}
            unit="m/s²"
          />
          <CheckRow
            label="Implied turn rate"
            value={d.turn_rate_dps as number}
            threshold={thresholds.max_turn_rate_dps}
            unit="°/s"
          />
          <CheckRow
            label="C/N0 drop within the window"
            value={d.cn0_drop_db as number}
            threshold={thresholds.cn0_drop_alarm_db}
            unit="dB"
          />
          <CheckRow
            label="Signal degraded (warn level)"
            value={null}
            breached={Boolean(d.signal_degraded)}
            detail={
              d.signal_degraded
                ? 'Yes — this is the evidence that distinguishes interference from deception'
                : 'No'
            }
          />
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Trust score over time" subtitle="Bands show the configured decision thresholds">
          <TrustScoreChart data={trustHistory} />
        </Panel>
        <Panel title="Signal quality" subtitle="Carrier-to-noise density, satellites tracked and HDOP">
          <SignalQualityChart data={signalHistory} />
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Difference from radar over time" subtitle="The cross-check a spoofer cannot influence">
          <LineChart
            data={differenceHistory}
            label="GNSS minus radar"
            unit="m"
            colour="#ef3f5b"
            markLineAt={thresholds.radar_disagreement_m}
            markLineLabel={`${thresholds.radar_disagreement_m} m threshold`}
          />
        </Panel>

        <Panel title="Reported quality" subtitle="What the receiver claims about itself">
          <div className="grid grid-cols-2 gap-x-6">
            <div>
              <KeyValue label="Fix type" value={gnss.quality.fix_type ?? EM_DASH} />
              <KeyValue label="Satellites" value={gnss.quality.satellites ?? EM_DASH} />
              <KeyValue label="HDOP" value={number(gnss.quality.hdop)} />
              <KeyValue label="PDOP" value={number(gnss.quality.pdop)} />
            </div>
            <div>
              <KeyValue label="Mean C/N0" value={gnss.quality.cn0_mean_dbhz ? `${gnss.quality.cn0_mean_dbhz} dB-Hz` : EM_DASH} />
              <KeyValue label="Reported accuracy" value={metres(gnss.quality.reported_accuracy_m)} />
              <KeyValue
                label="Reported position"
                value={
                  gnss.reported_position
                    ? `${gnss.reported_position.latitude.toFixed(6)}, ${gnss.reported_position.longitude.toFixed(6)}`
                    : EM_DASH
                }
              />
              <KeyValue label="Epoch" value={simClock(navigation?.time_s)} />
            </div>
          </div>
          {gnss.error_vs_truth_m !== null && (
            <div className="mt-3 rounded-md border border-caution/35 bg-caution/10 p-2.5">
              <p className="text-2xs font-semibold uppercase tracking-wider text-caution">Simulation reference</p>
              <KeyValue label="Actual GNSS error vs ground truth" value={metres(gnss.error_vs_truth_m)} />
              <p className="mt-1 text-2xs text-bridge-400">
                Only available in simulation. The trust engine never sees this value; it reaches its conclusions from
                cross-checks alone.
              </p>
            </div>
          )}
          <div className="mt-3">
            <Note>
              A receiver that claims a better accuracy than its own dilution of precision supports is itself a
              suspicious signature, and is one of the conditions checked above.
            </Note>
          </div>
        </Panel>
      </div>

      {trustHistory.length === 0 && (
        <Panel>
          <EmptyState
            title="No trust history yet"
            detail="History accumulates while a scenario runs."
            icon="◈"
          />
        </Panel>
      )}
    </div>
  );
}

export default GnssPage;
