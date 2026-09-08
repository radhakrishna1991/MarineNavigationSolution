/**
 * Guided demonstration (Section 30): "Safeen GNSS-Denied Survey Demonstration".
 *
 * A stage-by-stage script that tracks the running scenario clock, tells the
 * presenter what should be visible now, and shows the live evidence for it.
 * The point is that the audience can check every claim against the panels
 * rather than taking the narration on trust.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../store';
import { useScenariosQuery, useStartScenarioMutation, useScenarioJumpMutation, errorMessage } from '../api/api';
import { toastAdded } from '../store/uiSlice';
import { hasRole } from '../store/authSlice';
import { EmptyState, KeyValue, Note, Panel, Readout, StatusChip } from '../components/ui';
import { MapView } from '../map/MapView';
import { StatusBanner } from '../components/StatusBanner';
import { ErrorVsProtectionChart, TrustScoreChart } from '../charts/charts';
import { metres, number, simClock } from '../utils/format';
import { REQUIREMENT_PRESENTATION, TRUST_PRESENTATION, modePresentation } from '../utils/status';

const DEMO_SCENARIO_ID = 'SCN_15_SAFEEN_DEMO';

/** What the audience should be able to verify at each stage. */
const STAGE_EVIDENCE: Record<string, string> = {
  'Healthy start': 'GNSS trust is above 90, radar and GNSS agree, and the requirement reads MET.',
  'Spoofing begins': 'Nothing visible yet — that is the point. Each individual GNSS fix still looks plausible.',
  'Residuals rise': 'On the GNSS panel, the difference from the radar map match starts to grow steadily.',
  'Trust collapses': 'The trust score falls through the degraded and suspect bands as conditions confirm.',
  'Spoofing alarm': 'A CRITICAL alarm names the reason, and GNSS is excluded from the solution.',
  'Independent navigation': 'The mode changes to radar-aided. The fused track stays on the ground-truth line while raw GNSS walks away.',
  'Feature-poor zone': 'Radar match confidence falls and the bathymetric matcher starts reporting ambiguity.',
  'Uncertainty grows': 'The protection level rises and the requirement moves to AT RISK.',
  'Integrity not assured': 'The protection level exceeds the limit. The platform says so plainly rather than continuing to show green.',
  'Radar restored': 'Mapped features return, an absolute correction is applied, and the protection level falls again.',
  'GNSS returns': 'GNSS is present but held out of the solution while the validation window runs.',
  'Reintegration': 'After the full validation period, GNSS is readmitted and the event is logged.',
  Report: 'Export the performance report and compare the fused solution against ground truth.'
};

export function DemoPage() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);
  const navigation = useAppSelector((s) => s.live.navigation);
  const scenario = useAppSelector((s) => s.live.scenario);
  const history = useAppSelector((s) => s.live.history);
  const alarms = useAppSelector((s) => s.live.recentAlarms);

  const { data: scenarios } = useScenariosQuery();
  const [start, { isLoading: starting }] = useStartScenarioMutation();
  const [jump, { isLoading: jumping }] = useScenarioJumpMutation();

  const canControl = hasRole(user?.role, 'operator');
  const demo = scenarios?.items.find((s) => s.id === DEMO_SCENARIO_ID);
  const isRunning = scenario?.scenario_id === DEMO_SCENARIO_ID;
  const t = isRunning ? scenario!.sim_time_s : 0;

  const steps = demo?.demo_steps ?? [];
  const currentIndex = useMemo(() => {
    if (!isRunning || steps.length === 0) return -1;
    let index = -1;
    for (let i = 0; i < steps.length; i += 1) if (t >= steps[i].at_s) index = i;
    return index;
  }, [isRunning, steps, t]);

  const errorSeries = useMemo(
    () => history.slice(-1200).map((h) => ({ t: h.t, actual: h.actual, estimated: h.estimated, hpl: h.hpl })),
    [history]
  );
  const trustSeries = useMemo(() => history.slice(-1200).map((h) => ({ t: h.t, trust: h.trust })), [history]);

  const keyAlarms = useMemo(
    () =>
      alarms
        .filter((a) =>
          ['GNSS_SPOOFING_DETECTED', 'GNSS_JAMMING_DETECTED', 'GNSS_REINTEGRATED', 'INTEGRITY_NOT_ASSURED', 'REQUIREMENT_NOT_MET', 'REQUIREMENT_AT_RISK', 'BATHYMETRIC_AMBIGUITY'].includes(
            a.code
          )
        )
        .slice(0, 8),
    [alarms]
  );

  return (
    <div className="space-y-3">
      <Panel
        title="Safeen GNSS-Denied Survey Demonstration"
        subtitle="A guided walk-through of what the platform does when GNSS cannot be trusted"
        actions={
          canControl && (
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={starting || !demo}
              onClick={async () => {
                try {
                  await start({ scenarioId: DEMO_SCENARIO_ID, speedMultiplier: 2 }).unwrap();
                  dispatch(toastAdded('success', 'Demonstration started', 'Running at 2× real time.'));
                } catch (err) {
                  dispatch(toastAdded('error', 'Could not start the demonstration', errorMessage(err)));
                }
              }}
            >
              {isRunning ? 'Restart demonstration' : 'Start demonstration'}
            </button>
          )
        }
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div>
            <p className="text-sm leading-relaxed text-bridge-200">
              iSpatialTec does not claim to create an accurate position from unavailable information. The platform
              determines which navigation sources can be trusted, combines valid independent measurements, quantifies
              the uncertainty, and warns before the less-than-2-metre requirement can no longer be assured.
            </p>
            <p className="mt-3 text-xs leading-relaxed text-bridge-400">
              This demonstration runs a simulated survey vessel through a synthetic UAE-like harbour. GNSS is
              gradually spoofed, detected and excluded; navigation continues on radar and bathymetry; the vessel then
              enters a feature-poor area where the requirement can no longer be assured; and finally GNSS returns and
              is revalidated before being readmitted.
            </p>
            {demo && (
              <div className="mt-3 space-y-1">
                <KeyValue label="Duration" value={`${Math.round(demo.duration_s / 60)} minutes of simulated time`} />
                <KeyValue label="Seed" value={demo.seed} />
                <KeyValue label="Scripted faults" value={demo.fault_count} />
                <KeyValue label="Stages" value={steps.length} />
              </div>
            )}
            <Note tone="caution">
              Everything shown is simulated. The geospatial data is synthetic and is not an official chart. Field
              performance depends on vessel type, sensor installation, gyro quality, DVL bottom lock, radar field of
              view, map quality, bathymetric survey age, tide, sound velocity, seabed distinctiveness, weather, sea
              state, sensor latency, operating area and outage duration.
            </Note>
          </div>

          <div>
            {!isRunning ? (
              <EmptyState
                title="Demonstration not running"
                detail={
                  canControl
                    ? 'Start it with the button above. The stage list will follow the scenario clock.'
                    : 'Ask an operator to start it. You can still watch every panel.'
                }
                icon="★"
              />
            ) : (
              <ol className="max-h-[26rem] space-y-1.5 overflow-y-auto pr-1">
                {steps.map((step, i) => {
                  const isCurrent = i === currentIndex;
                  const isPast = i < currentIndex;
                  return (
                    <li key={i}>
                      <div
                        className={`rounded-md border px-3 py-2 transition-colors ${
                          isCurrent
                            ? 'border-info/60 bg-info/10'
                            : isPast
                              ? 'border-bridge-800 bg-bridge-850/60 opacity-70'
                              : 'border-bridge-800 bg-bridge-900'
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span
                            className={`text-sm font-medium ${
                              isCurrent ? 'text-info' : isPast ? 'text-bridge-400' : 'text-bridge-200'
                            }`}
                          >
                            {isPast && <span aria-hidden className="mr-1.5 text-assured">✓</span>}
                            {isCurrent && <span aria-hidden className="mr-1.5">▶</span>}
                            {step.title}
                          </span>
                          <span className="shrink-0 font-mono text-2xs text-bridge-500">
                            {simClock(step.at_s)}
                            {canControl && !isPast && !isCurrent && (
                              <button
                                type="button"
                                className="ml-2 text-info hover:underline disabled:opacity-40"
                                disabled={jumping}
                                onClick={async () => {
                                  try {
                                    await jump({ timeS: step.at_s }).unwrap();
                                  } catch (err) {
                                    dispatch(toastAdded('error', 'Jump failed', errorMessage(err)));
                                  }
                                }}
                              >
                                skip to
                              </button>
                            )}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs leading-relaxed text-bridge-400">{step.detail}</p>
                        {isCurrent && STAGE_EVIDENCE[step.title] && (
                          <p className="mt-1.5 rounded border border-bridge-700 bg-bridge-950 px-2 py-1.5 text-2xs leading-relaxed text-assured">
                            <span className="uppercase tracking-wider">Look for: </span>
                            {STAGE_EVIDENCE[step.title]}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      </Panel>

      <StatusBanner navigation={navigation} />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-3">
          <MapView navigation={navigation} className="h-[24rem] xl:h-[30rem]" />
          <Panel title="The claim, and the evidence for it">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <p className="panel-title mb-2">Error against the published bound</p>
                <ErrorVsProtectionChart
                  data={errorSeries}
                  limit={navigation?.integrity.requirement_limit_m ?? 2}
                  height={200}
                />
                <p className="mt-1 text-2xs leading-relaxed text-bridge-500">
                  Green is the actual error against simulated ground truth. Amber is the bound the platform published
                  at the time. The platform is credible only while the amber line stays above the green one.
                </p>
              </div>
              <div>
                <p className="panel-title mb-2">GNSS trust</p>
                <TrustScoreChart data={trustSeries} height={200} />
                <p className="mt-1 text-2xs leading-relaxed text-bridge-500">
                  The trust engine never sees ground truth. It reaches its conclusions purely from cross-checks
                  against independent measurements and from behaviour a genuine receiver does not exhibit.
                </p>
              </div>
            </div>
          </Panel>
        </div>

        <div className="space-y-3">
          {navigation && (
            <Panel title="Right now">
              <div className="space-y-3">
                <div>
                  <p className="readout-label">Navigation mode</p>
                  <div className="mt-1.5">
                    <StatusChip presentation={modePresentation(navigation.navigation_mode)} size="lg" />
                  </div>
                </div>
                <div>
                  <p className="readout-label">Safeen requirement</p>
                  <div className="mt-1.5">
                    <StatusChip
                      presentation={REQUIREMENT_PRESENTATION[navigation.integrity.requirement_status]}
                      size="lg"
                    />
                  </div>
                </div>
                <div>
                  <p className="readout-label">GNSS</p>
                  <div className="mt-1.5">
                    <StatusChip presentation={TRUST_PRESENTATION[navigation.gnss.status]} size="lg" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 border-t border-bridge-800 pt-3">
                  <Readout
                    label="Protection level"
                    value={number(navigation.integrity.horizontal_protection_level_m)}
                    unit="m"
                    size="sm"
                  />
                  <Readout
                    label="Actual error"
                    value={number(navigation.actual_error_vs_truth_m)}
                    unit="m"
                    size="sm"
                    tone="caution"
                  />
                  <Readout
                    label="Raw GNSS error"
                    value={number(navigation.gnss.error_vs_truth_m)}
                    unit="m"
                    size="sm"
                    tone={
                      (navigation.gnss.error_vs_truth_m ?? 0) > 10
                        ? 'critical'
                        : (navigation.gnss.error_vs_truth_m ?? 0) > 3
                          ? 'caution'
                          : undefined
                    }
                  />
                  <Readout
                    label="Absolute sources"
                    value={navigation.integrity.independent_absolute_sources}
                    size="sm"
                  />
                </div>
                {navigation.gnss.error_vs_truth_m !== null &&
                  navigation.actual_error_vs_truth_m !== null &&
                  navigation.gnss.error_vs_truth_m > navigation.actual_error_vs_truth_m * 3 && (
                    <div className="rounded-md border border-assured/40 bg-assured/10 p-2.5">
                      <p className="text-2xs font-semibold uppercase tracking-wider text-assured">
                        This is the whole argument
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-bridge-200">
                        Raw GNSS is {metres(navigation.gnss.error_vs_truth_m)} from the true position. The trusted
                        fused solution is {metres(navigation.actual_error_vs_truth_m)}. The platform detected the
                        discrepancy without ever being told the truth.
                      </p>
                    </div>
                  )}
              </div>
            </Panel>
          )}

          <Panel title="Key events so far" bodyClassName="p-0">
            {keyAlarms.length === 0 ? (
              <EmptyState title="No key events yet" detail="Detection events will appear here as they happen." icon="○" />
            ) : (
              <ul className="divide-y divide-bridge-800">
                {keyAlarms.map((alarm) => (
                  <li key={alarm.id} className="px-4 py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-bridge-100">{alarm.message}</span>
                      <span className="shrink-0 font-mono text-2xs text-bridge-500">{simClock(alarm.sim_time_s)}</span>
                    </div>
                    {alarm.reason && <p className="mt-0.5 text-2xs leading-relaxed text-bridge-400">{alarm.reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Next steps">
            <ul className="space-y-2 text-xs text-bridge-300">
              <li>
                <Link to="/gnss" className="text-info hover:underline">
                  GNSS Integrity →
                </Link>{' '}
                shows every cross-check with its value and threshold.
              </li>
              <li>
                <Link to="/fusion" className="text-info hover:underline">
                  Fusion &amp; Integrity →
                </Link>{' '}
                shows how the protection level was assembled.
              </li>
              <li>
                <Link to="/sensors" className="text-info hover:underline">
                  Sensors →
                </Link>{' '}
                shows why each sensor was accepted or excluded.
              </li>
              <li>
                <Link to="/analytics" className="text-info hover:underline">
                  Performance →
                </Link>{' '}
                produces the report comparing the fused solution against ground truth.
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

export default DemoPage;
