/**
 * Replay and scenario panel (Section 15.6).
 *
 * Scenario selection and transport controls, runtime fault injection, and
 * replay of recorded or uploaded data. Fault injection is an engineer action
 * and every injection is written to the audit trail, because a demonstration
 * where the audience cannot tell what was injected is not a demonstration.
 */

import { useMemo, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  useDeleteReplayMutation,
  useFaultTypesQuery,
  useInjectFaultMutation,
  useManualFallbackMutation,
  useRemoveFaultMutation,
  useReplayControlMutation,
  useReplayFromRunMutation,
  useReplaySessionsQuery,
  useRunsQuery,
  useScenarioControlMutation,
  useScenarioJumpMutation,
  useScenarioSpeedMutation,
  useScenarioStepMutation,
  useScenariosQuery,
  useSensorsQuery,
  useStartReplayMutation,
  useStartScenarioMutation,
  useUploadReplayMutation,
  errorMessage
} from '../api/api';
import { toastAdded } from '../store/uiSlice';
import { hasRole } from '../store/authSlice';
import {
  ConfirmDialog,
  EmptyState,
  Field,
  KeyValue,
  Modal,
  Note,
  Panel,
  QueryBoundary,
  Select,
  StatusChip,
  Tabs,
  Toggle
} from '../components/ui';
import { duration, relativeTime, simClock, timestamp } from '../utils/format';
import { SEVERITY_PRESENTATION } from '../utils/status';
import type { FaultTypeDef, ScenarioSummary } from '../types';

type Tab = 'scenarios' | 'faults' | 'replay';

function ScenarioCard({
  scenario,
  active,
  onStart,
  disabled
}: {
  scenario: ScenarioSummary;
  active: boolean;
  onStart: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        active ? 'border-info/60 bg-info/10' : 'border-bridge-700 bg-bridge-850 hover:border-bridge-600'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-bridge-100">{scenario.name}</h3>
            {scenario.is_demonstration && (
              <span className="chip border-caution/50 bg-caution/15 text-caution">Demonstration</span>
            )}
            <span className="chip border-bridge-600 bg-bridge-800 text-bridge-400">{scenario.category}</span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-bridge-400">{scenario.summary}</p>
          {scenario.expected_outcome && (
            <p className="mt-1.5 text-2xs leading-relaxed text-assured">
              <span className="uppercase tracking-wider">Expected: </span>
              {scenario.expected_outcome}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-3 text-2xs text-bridge-500">
            <span>{duration(scenario.duration_s)}</span>
            <span>seed {scenario.seed}</span>
            <span>{scenario.fault_count} scripted fault{scenario.fault_count === 1 ? '' : 's'}</span>
            <span>{scenario.ins_enabled ? 'INS fitted' : 'no INS'}</span>
            {scenario.local_ranging_enabled && <span>local ranging</span>}
          </div>
        </div>
        <button
          type="button"
          className={active ? 'btn-secondary btn-sm shrink-0' : 'btn-primary btn-sm shrink-0'}
          disabled={disabled}
          onClick={() => onStart(scenario.id)}
        >
          {active ? 'Restart' : 'Start'}
        </button>
      </div>

      {scenario.faults.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-2xs uppercase tracking-wider text-bridge-400 hover:text-bridge-200">
            Scripted faults
          </summary>
          <ul className="mt-1.5 space-y-1">
            {scenario.faults.map((f) => (
              <li key={f.id} className="font-mono text-2xs text-bridge-400">
                {String(f.start_s).padStart(4)}s–{f.end_s ?? '∞'}s · {f.sensor_id} · {f.type.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function TransportControls() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);
  const scenario = useAppSelector((s) => s.live.scenario);
  const navigation = useAppSelector((s) => s.live.navigation);

  const [control, { isLoading: controlling }] = useScenarioControlMutation();
  const [step] = useScenarioStepMutation();
  const [setSpeed] = useScenarioSpeedMutation();
  const [jump, { isLoading: jumping }] = useScenarioJumpMutation();
  const [manualFallback] = useManualFallbackMutation();
  const [jumpTarget, setJumpTarget] = useState('');

  const canControl = hasRole(user?.role, 'operator');
  const running = scenario?.state === 'RUNNING';
  const paused = scenario?.state === 'PAUSED';
  const loaded = Boolean(scenario?.scenario_id);

  const act = async (fn: () => Promise<unknown>, label: string) => {
    try {
      await fn();
    } catch (err) {
      dispatch(toastAdded('error', `${label} failed`, errorMessage(err)));
    }
  };

  if (!canControl) {
    return (
      <Note tone="caution">
        Scenario control requires the operator role. You are signed in as {user?.role}. You can watch the running
        scenario and inspect every panel, but not change it.
      </Note>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={!running || controlling}
          onClick={() => act(() => control({ action: 'pause' }).unwrap(), 'Pause')}
        >
          ⏸ Pause
        </button>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={!paused || controlling}
          onClick={() => act(() => control({ action: 'resume' }).unwrap(), 'Resume')}
        >
          ▶ Resume
        </button>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={!loaded || controlling}
          onClick={() => act(() => control({ action: 'stop' }).unwrap(), 'Stop')}
        >
          ⏹ Stop
        </button>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={!loaded || controlling}
          onClick={() => act(() => control({ action: 'reset' }).unwrap(), 'Reset')}
        >
          ⟲ Reset
        </button>
        <div className="mx-1 h-6 w-px bg-bridge-700" />
        {[1, 5, 10, 30].map((s) => (
          <button
            key={s}
            type="button"
            className="btn-secondary btn-sm"
            disabled={!paused}
            title={paused ? `Advance ${s} simulated seconds` : 'Pause the scenario to step'}
            onClick={() => act(() => step({ seconds: s }).unwrap(), 'Step')}
          >
            +{s}s
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="readout-label">Speed</span>
        {[0.5, 1, 2, 5, 10].map((m) => (
          <button
            key={m}
            type="button"
            className={
              scenario?.speed_multiplier === m ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'
            }
            disabled={!loaded}
            onClick={() => act(() => setSpeed({ speedMultiplier: m }).unwrap(), 'Speed change')}
          >
            {m}×
          </button>
        ))}

        <div className="mx-1 h-6 w-px bg-bridge-700" />
        <input
          type="number"
          className="field-input w-28"
          placeholder="Jump to s"
          value={jumpTarget}
          min={0}
          max={scenario?.duration_s ?? 3600}
          onChange={(e) => setJumpTarget(e.target.value)}
          aria-label="Jump to scenario time in seconds"
        />
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={!loaded || jumping || jumpTarget === ''}
          onClick={() => act(() => jump({ timeS: Number(jumpTarget) }).unwrap(), 'Jump')}
        >
          Jump
        </button>
      </div>

      {scenario && scenario.duration_s > 0 && (
        <div>
          <div className="flex items-baseline justify-between">
            <span className="readout-label">Progress</span>
            <span className="font-mono text-xs tabular-nums text-bridge-200">
              {simClock(scenario.sim_time_s)} / {simClock(scenario.duration_s)}
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-bridge-800">
            <div
              className="h-full rounded-full bg-info transition-[width] duration-300"
              style={{ width: `${Math.min(100, scenario.progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      <Toggle
        checked={navigation?.navigation_mode === 'MANUAL_FALLBACK'}
        onChange={(next) => act(() => manualFallback({ enabled: next }).unwrap(), 'Manual fallback')}
        label="Manual fallback"
        description="Suspend automatic navigation assurance. Raw sensor values remain visible; no trusted position is published."
      />

      <Note>
        Simulated time cannot run backwards. To reach an earlier point, reset the scenario and run forward — this
        keeps the recorded audit trail monotonic and the replay reproducible.
      </Note>
    </div>
  );
}

function FaultInjectionForm({ faultTypes }: { faultTypes: FaultTypeDef[] }) {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);
  const scenario = useAppSelector((s) => s.live.scenario);
  const { data: sensors } = useSensorsQuery();
  const [inject, { isLoading }] = useInjectFaultMutation();
  const [removeFault] = useRemoveFaultMutation();

  const [type, setType] = useState(faultTypes[0]?.type ?? '');
  const [sensorId, setSensorId] = useState('GNSS_01');
  const [durationS, setDurationS] = useState('60');
  const [params, setParams] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const canInject = hasRole(user?.role, 'engineer');
  const selected = faultTypes.find((f) => f.type === type);

  const applicableSensors = useMemo(() => {
    if (!sensors || !selected) return [];
    return sensors.items.filter(
      (s) => selected.applies_to.includes('ANY') || selected.applies_to.includes(s.sensor_type)
    );
  }, [sensors, selected]);

  const activeFaults = useMemo(
    () => (scenario?.faults ?? []).filter((f) => scenario?.active_faults?.includes(f.id)),
    [scenario]
  );
  const manualFaults = useMemo(() => (scenario?.faults ?? []).filter((f) => f.manual), [scenario]);

  const validate = () => {
    const next: Record<string, string> = {};
    if (!type) next.type = 'Choose a fault type.';
    if (!sensorId) next.sensorId = 'Choose a sensor.';
    const d = Number(durationS);
    if (!Number.isFinite(d) || d < 1 || d > 100000) next.duration = 'Duration must be between 1 and 100000 seconds.';
    for (const [key, spec] of Object.entries(selected?.params ?? {})) {
      const raw = params[key];
      if (raw === undefined || raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) next[key] = 'Must be a number.';
      else if (spec.min !== undefined && value < spec.min) next[key] = `Minimum ${spec.min}.`;
      else if (spec.max !== undefined && value > spec.max) next[key] = `Maximum ${spec.max}.`;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  if (!canInject) {
    return (
      <Note tone="caution">
        Fault injection requires the engineer role. You are signed in as {user?.role}.
      </Note>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <p className="panel-title mb-3">Inject a fault</p>
        <div className="space-y-3">
          <Field label="Fault type" error={errors.type} required>
            <Select
              value={type}
              onChange={(v) => {
                setType(v);
                setParams({});
                setErrors({});
                const def = faultTypes.find((f) => f.type === v);
                if (def && !def.applies_to.includes('ANY') && !def.applies_to.includes('GNSS')) {
                  const first = sensors?.items.find((s) => def.applies_to.includes(s.sensor_type));
                  if (first) setSensorId(first.sensor_id);
                }
              }}
              options={faultTypes.map((f) => ({ value: f.type, label: `${f.label} (${f.category.toLowerCase()})` }))}
            />
          </Field>
          {selected && <p className="text-xs leading-relaxed text-bridge-400">{selected.description}</p>}

          <Field label="Target sensor" error={errors.sensorId} required>
            <Select
              value={sensorId}
              onChange={setSensorId}
              options={
                applicableSensors.length
                  ? applicableSensors.map((s) => ({ value: s.sensor_id, label: `${s.sensor_id} — ${s.name}` }))
                  : [{ value: sensorId, label: sensorId }]
              }
            />
          </Field>

          <Field label="Duration (seconds)" error={errors.duration} hint="Measured from now, in simulated time.">
            <input
              type="number"
              className="field-input"
              value={durationS}
              min={1}
              onChange={(e) => setDurationS(e.target.value)}
            />
          </Field>

          {selected && Object.keys(selected.params).length > 0 && (
            <div className="rounded-md border border-bridge-700 bg-bridge-850 p-3">
              <p className="readout-label mb-2">Parameters</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {Object.entries(selected.params).map(([key, spec]) => (
                  <Field
                    key={key}
                    label={`${key.replace(/_/g, ' ')}${spec.unit ? ` (${spec.unit})` : ''}`}
                    error={errors[key]}
                    hint={
                      spec.min !== undefined && spec.max !== undefined
                        ? `${spec.min} to ${spec.max}, default ${spec.default}`
                        : `default ${spec.default}`
                    }
                  >
                    <input
                      type="number"
                      className="field-input"
                      placeholder={String(spec.default)}
                      value={params[key] ?? ''}
                      step="any"
                      onChange={(e) => setParams((p) => ({ ...p, [key]: e.target.value }))}
                    />
                  </Field>
                ))}
              </div>
            </div>
          )}

          <button
            type="button"
            className="btn-danger"
            disabled={isLoading || scenario?.state !== 'RUNNING'}
            onClick={async () => {
              if (!validate()) return;
              try {
                const numericParams: Record<string, number> = {};
                for (const [k, v] of Object.entries(params)) if (v !== '') numericParams[k] = Number(v);
                const result = await inject({
                  type,
                  sensor_id: sensorId,
                  duration_s: Number(durationS),
                  params: numericParams
                }).unwrap();
                dispatch(toastAdded('warning', 'Fault injected', `${result.fault.label} on ${sensorId}`));
              } catch (err) {
                dispatch(toastAdded('error', 'Injection failed', errorMessage(err)));
              }
            }}
          >
            Inject fault
          </button>
          {scenario?.state !== 'RUNNING' && (
            <p className="text-xs text-bridge-500">A scenario must be running before a fault can be injected.</p>
          )}
        </div>
      </div>

      <div>
        <p className="panel-title mb-3">Currently active faults</p>
        {activeFaults.length === 0 ? (
          <EmptyState title="No faults active" detail="The sensor streams are behaving as configured." icon="✓" />
        ) : (
          <ul className="space-y-2">
            {activeFaults.map((fault) => (
              <li key={fault.id} className="rounded border border-caution/40 bg-caution/10 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-bridge-100">{fault.label}</p>
                    <p className="font-mono text-2xs text-bridge-400">
                      {fault.sensor_id} · {fault.type} · {fault.start_s}s → {fault.end_s ?? '∞'}s
                    </p>
                    {Object.keys(fault.params ?? {}).length > 0 && (
                      <p className="mt-1 font-mono text-2xs text-bridge-500">
                        {Object.entries(fault.params)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(' · ')}
                      </p>
                    )}
                  </div>
                  {fault.manual && (
                    <button
                      type="button"
                      className="btn-secondary btn-sm shrink-0"
                      onClick={async () => {
                        try {
                          await removeFault({ faultId: fault.id }).unwrap();
                          dispatch(toastAdded('success', 'Fault removed'));
                        } catch (err) {
                          dispatch(toastAdded('error', 'Removal failed', errorMessage(err)));
                        }
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {manualFaults.length > 0 && (
          <>
            <p className="panel-title mb-2 mt-4">Manually injected this run</p>
            <ul className="space-y-1">
              {manualFaults.map((f) => (
                <li key={f.id} className="font-mono text-2xs text-bridge-400">
                  {f.id} · {f.sensor_id} · {f.start_s}s → {f.end_s ?? '∞'}s
                </li>
              ))}
            </ul>
          </>
        )}

        <Note>
          Injected faults change the simulated sensor stream only. The navigation engines are never told what was
          injected — they have to detect it from the data, which is what makes the demonstration meaningful.
        </Note>
      </div>
    </div>
  );
}

function ReplayTab() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);
  const replay = useAppSelector((s) => s.live.replay);

  const { data: sessions, isLoading, isError, error, refetch } = useReplaySessionsQuery(undefined, {
    pollingInterval: 15000
  });
  const { data: runs } = useRunsQuery({ limit: 30 });
  const [upload, { isLoading: uploading }] = useUploadReplayMutation();
  const [fromRun, { isLoading: importing }] = useReplayFromRunMutation();
  const [startReplay] = useStartReplayMutation();
  const [replayControl] = useReplayControlMutation();
  const [deleteReplay] = useDeleteReplayMutation();

  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState('');

  const canManage = hasRole(user?.role, 'engineer');
  const canControl = hasRole(user?.role, 'operator');

  const handleFile = async (file: File) => {
    setUploadError(null);
    const lower = file.name.toLowerCase();
    const format = lower.endsWith('.json') ? 'json' : lower.endsWith('.csv') ? 'csv' : null;
    if (!format) {
      setUploadError('Only .csv and .json files are supported.');
      return;
    }
    if (file.size > 32 * 1024 * 1024) {
      setUploadError('File is larger than 32 MB. Split it or use a recorded run instead.');
      return;
    }
    try {
      const content = await file.text();
      const result = await upload({ name: uploadName || file.name, format, content }).unwrap();
      const errorCount = result.session.parse_error_count ?? 0;
      dispatch(
        toastAdded(
          errorCount > 0 ? 'warning' : 'success',
          `Imported ${result.session.message_count} messages`,
          errorCount > 0 ? `${errorCount} rows could not be parsed and were skipped.` : undefined
        )
      );
      setUploadName('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setUploadError(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      {replay?.session_id && (
        <div className="rounded-lg border border-info/40 bg-info/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-2xs uppercase tracking-wider text-info">Replay running</p>
              <p className="mt-0.5 text-sm text-bridge-100">{replay.session_name}</p>
              <p className="mt-0.5 font-mono text-2xs text-bridge-400">
                {replay.cursor} / {replay.message_count} messages · t = {simClock(replay.time_s)} ·{' '}
                {replay.speed_multiplier}×
              </p>
              {!replay.has_ground_truth && (
                <p className="mt-1 text-2xs text-caution">
                  This recording carries no ground truth, so accuracy statistics are not available for it. Integrity
                  and requirement status are still computed.
                </p>
              )}
            </div>
            {canControl && (
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => replayControl({ action: replay.state === 'RUNNING' ? 'pause' : 'resume' })}
                >
                  {replay.state === 'RUNNING' ? '⏸ Pause' : '▶ Resume'}
                </button>
                <button type="button" className="btn-secondary btn-sm" onClick={() => replayControl({ action: 'stop' })}>
                  ⏹ Stop
                </button>
              </div>
            )}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bridge-800">
            <div className="h-full rounded-full bg-info" style={{ width: `${replay.progress * 100}%` }} />
          </div>
        </div>
      )}

      {canManage && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-bridge-700 bg-bridge-850 p-3">
            <p className="panel-title mb-2">Import recorded data</p>
            <Field
              label="Session name"
              hint="Defaults to the file name."
            >
              <input
                type="text"
                className="field-input"
                value={uploadName}
                placeholder="e.g. Al Dhafra survey 2024-11-18"
                onChange={(e) => setUploadName(e.target.value)}
              />
            </Field>
            <Field label="File" error={uploadError} hint="CSV or JSON of internal sensor messages. Maximum 32 MB.">
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.json"
                className="field-input file:mr-3 file:rounded file:border-0 file:bg-bridge-700 file:px-3 file:py-1 file:text-xs file:text-bridge-100"
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
            </Field>
            {uploading && <p className="text-xs text-info">Importing…</p>}
            <Note>
              A replay drives exactly the same navigation pipeline as the live simulator. That is the point: behaviour
              on recorded vessel data has to be identical to behaviour in the demonstration.
            </Note>
          </div>

          <div className="rounded-lg border border-bridge-700 bg-bridge-850 p-3">
            <p className="panel-title mb-2">Replay a previous run</p>
            <Field label="Recorded run">
              <Select
                value={selectedRun}
                onChange={setSelectedRun}
                options={[
                  { value: '', label: 'Choose a run…' },
                  ...(runs?.items ?? []).map((r) => ({
                    value: r.run_id,
                    label: `${r.scenario_name} · ${timestamp(r.started_at, true)} · ${r.solution_count} epochs`
                  }))
                ]}
              />
            </Field>
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={!selectedRun || importing}
              onClick={async () => {
                try {
                  await fromRun({ runId: selectedRun }).unwrap();
                  dispatch(toastAdded('success', 'Replay session created'));
                  setSelectedRun('');
                } catch (err) {
                  dispatch(toastAdded('error', 'Could not create the session', errorMessage(err)));
                }
              }}
            >
              Create replay session
            </button>
          </div>
        </div>
      )}

      <div>
        <p className="panel-title mb-2">Replay sessions</p>
        <QueryBoundary
          isLoading={isLoading}
          isError={isError}
          error={isError ? { message: errorMessage(error) } : undefined}
          data={sessions?.items}
          isEmpty={(d) => d.length === 0}
          emptyTitle="No replay sessions"
          emptyDetail="Import a CSV or JSON recording, or create a session from a previous run."
          onRetry={refetch}
        >
          {(items) => (
            <div className="overflow-x-auto rounded border border-bridge-700">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Source</th>
                    <th className="text-right">Messages</th>
                    <th className="text-right">Span</th>
                    <th>Created</th>
                    <th>Ground truth</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((session) => (
                    <tr key={session.id}>
                      <td className="text-xs text-bridge-100">{session.name}</td>
                      <td className="text-2xs">{session.source_type}</td>
                      <td className="text-right font-mono text-2xs">{session.message_count}</td>
                      <td className="text-right font-mono text-2xs">
                        {session.end_time_s !== null ? duration(session.end_time_s - (session.start_time_s ?? 0)) : '—'}
                      </td>
                      <td className="text-2xs text-bridge-400">{relativeTime(session.created_at)}</td>
                      <td className="text-2xs">
                        {session.metadata?.has_ground_truth ? (
                          <span className="text-assured">Present</span>
                        ) : (
                          <span className="text-bridge-500">Not available</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        {canControl && (
                          <button
                            type="button"
                            className="btn-secondary btn-sm"
                            onClick={async () => {
                              try {
                                await startReplay({ sessionId: session.id, speedMultiplier: 1 }).unwrap();
                                dispatch(toastAdded('success', 'Replay started'));
                              } catch (err) {
                                dispatch(toastAdded('error', 'Replay failed to start', errorMessage(err)));
                              }
                            }}
                          >
                            Play
                          </button>
                        )}
                        {canManage && (
                          <button
                            type="button"
                            className="btn-ghost btn-sm ml-1 text-critical"
                            onClick={() => setConfirmDelete(session.id)}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryBoundary>
      </div>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete replay session"
        message="The session and its stored messages will be removed permanently. Recorded scenario runs are not affected."
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await deleteReplay(confirmDelete!).unwrap();
            dispatch(toastAdded('success', 'Session deleted'));
          } catch (err) {
            dispatch(toastAdded('error', 'Delete failed', errorMessage(err)));
          } finally {
            setConfirmDelete(null);
          }
        }}
      />
    </div>
  );
}

export function ScenarioPage() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);
  const liveScenario = useAppSelector((s) => s.live.scenario);
  const [tab, setTab] = useState<Tab>('scenarios');
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);

  const { data, isLoading, isError, error, refetch } = useScenariosQuery();
  const { data: faultTypes } = useFaultTypesQuery();
  const [startScenario, { isLoading: starting }] = useStartScenarioMutation();

  const canControl = hasRole(user?.role, 'operator');
  const activeId = liveScenario?.scenario_id ?? data?.current?.scenario_id ?? null;
  const state = liveScenario?.state ?? data?.current?.state ?? 'IDLE';

  const grouped = useMemo(() => {
    const groups = new Map<string, ScenarioSummary[]>();
    for (const s of data?.items ?? []) {
      const list = groups.get(s.category) ?? [];
      list.push(s);
      groups.set(s.category, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  return (
    <div className="space-y-3">
      <Panel
        title="Scenario runtime"
        subtitle={
          activeId
            ? `${liveScenario?.scenario_name ?? activeId} · ${state}`
            : 'No scenario is loaded'
        }
        actions={
          <StatusChip
            presentation={
              state === 'RUNNING'
                ? { ...SEVERITY_PRESENTATION.INFO, label: 'Running', short: 'RUNNING', glyph: '▶' }
                : state === 'PAUSED'
                  ? { ...SEVERITY_PRESENTATION.ADVISORY, label: 'Paused', short: 'PAUSED', glyph: '⏸' }
                  : { ...SEVERITY_PRESENTATION.INFO, label: state, short: state, glyph: '○' }
            }
          />
        }
      >
        <TransportControls />
      </Panel>

      <Panel bodyClassName="p-0">
        <div className="px-4 pt-3">
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'scenarios', label: 'Scenarios', badge: data?.items.length },
              { id: 'faults', label: 'Fault injection', badge: liveScenario?.active_faults?.length },
              { id: 'replay', label: 'Replay' }
            ]}
          />
        </div>

        <div className="p-4">
          {tab === 'scenarios' && (
            <QueryBoundary
              isLoading={isLoading}
              isError={isError}
              error={isError ? { message: errorMessage(error) } : undefined}
              data={grouped}
              isEmpty={(d) => d.length === 0}
              emptyTitle="No scenarios configured"
              onRetry={refetch}
            >
              {(groups) => (
                <div className="space-y-5">
                  {groups.map(([category, scenarios]) => (
                    <div key={category}>
                      <h3 className="panel-title mb-2">{category.replace(/_/g, ' ')}</h3>
                      <div className="grid gap-3 lg:grid-cols-2">
                        {scenarios
                          .sort((a, b) => a.display_order - b.display_order)
                          .map((scenario) => (
                            <ScenarioCard
                              key={scenario.id}
                              scenario={scenario}
                              active={scenario.id === activeId}
                              disabled={!canControl || starting}
                              onStart={setPendingStart}
                            />
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </QueryBoundary>
          )}

          {tab === 'faults' && <FaultInjectionForm faultTypes={faultTypes?.items ?? []} />}
          {tab === 'replay' && <ReplayTab />}
        </div>
      </Panel>

      <Modal
        open={Boolean(pendingStart)}
        onClose={() => setPendingStart(null)}
        title="Start scenario"
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setPendingStart(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={starting}
              onClick={async () => {
                try {
                  await startScenario({ scenarioId: pendingStart!, speedMultiplier: speed }).unwrap();
                  dispatch(toastAdded('success', 'Scenario started'));
                } catch (err) {
                  dispatch(toastAdded('error', 'Could not start the scenario', errorMessage(err)));
                } finally {
                  setPendingStart(null);
                }
              }}
            >
              {starting ? 'Starting…' : 'Start'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-bridge-200">
            Starting a scenario stops anything currently running and begins a new recorded run.
          </p>
          <Field label="Initial speed" hint="Can be changed while the scenario runs.">
            <Select
              value={String(speed)}
              onChange={(v) => setSpeed(Number(v))}
              options={(data?.allowed_speed_multipliers ?? [0.5, 1, 2, 5, 10]).map((m) => ({
                value: String(m),
                label: `${m}× real time`
              }))}
            />
          </Field>
          {(() => {
            const scenario = data?.items.find((s) => s.id === pendingStart);
            return scenario ? (
              <div className="rounded border border-bridge-700 bg-bridge-850 p-2.5">
                <KeyValue label="Scenario" value={scenario.name} />
                <KeyValue label="Duration" value={duration(scenario.duration_s)} />
                <KeyValue label="Seed" value={scenario.seed} />
                <KeyValue label="Scripted faults" value={scenario.fault_count} />
                <KeyValue label="INS" value={scenario.ins_enabled ? 'Fitted' : 'Not fitted'} />
              </div>
            ) : null;
          })()}
        </div>
      </Modal>
    </div>
  );
}

export default ScenarioPage;
