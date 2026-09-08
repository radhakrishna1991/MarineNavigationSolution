/**
 * Configuration screen (Section 20).
 *
 * Every threshold the engines use is editable here, with its default, its
 * permitted range and its current value shown together. Changes are validated
 * server-side, applied to the live engines and written to the audit log.
 *
 * Safety-critical values carry explicit bounds so that the 2 m requirement
 * cannot quietly be moved to 200 m to make the dashboard turn green.
 */

import { useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  useAdaptersQuery,
  useConfigHistoryQuery,
  useConfigQuery,
  useIngestStatusQuery,
  useModesQuery,
  useResetConfigMutation,
  useUpdateConfigMutation,
  errorMessage
} from '../api/api';
import { toastAdded } from '../store/uiSlice';
import { hasRole } from '../store/authSlice';
import {
  ConfirmDialog,
  EmptyState,
  Field,
  KeyValue,
  Note,
  Panel,
  QueryBoundary,
  SearchInput,
  StatusChip,
  Tabs
} from '../components/ui';
import { relativeTime, timestamp } from '../utils/format';
import { SEVERITY_PRESENTATION } from '../utils/status';

type Tab = 'thresholds' | 'modes' | 'adapters' | 'history';

interface Editable {
  path: string;
  value: number | string | boolean;
  defaultValue: number | string | boolean;
  bounds?: { min: number; max: number };
}

/** Flatten the effective configuration into editable scalar leaves. */
function flatten(obj: Record<string, any>, prefix = '', out: Array<[string, unknown]> = []) {
  for (const [key, value] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
    else out.push([path, value]);
  }
  return out;
}

const GROUP_DESCRIPTIONS: Record<string, string> = {
  requirements: 'The Safeen horizontal accuracy requirement and how compliance with it is decided.',
  gnss_integrity: 'GNSS trust bands, anomaly detection thresholds and the recovery validation period.',
  dead_reckoning: 'How dead-reckoning uncertainty grows, and the unassisted duration limit.',
  fusion: 'Filter process noise, measurement noise floors and innovation gating.',
  fault_detection: 'Residual monitoring, exclusion thresholds and controlled reintegration.',
  integrity: 'How the protection level is built and what counts as assured.',
  mode_manager: 'Mode dwell time and latching behaviour.',
  alarms: 'Alarm debouncing, auto-clear and severity mapping.',
  simulation: 'Simulation tick rate, publish rate and vessel parameters.',
  geospatial: 'Synthetic environment generation.',
  recording: 'What is written to the audit trail and at what rate.',
  platform: 'Identity and classification. Not editable at runtime.',
  security: 'Password policy and message limits. Not editable at runtime.'
};

export function ConfigPage() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);
  const [tab, setTab] = useState<Tab>('thresholds');
  const [search, setSearch] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [nmeaText, setNmeaText] = useState(
    '$GPGGA,123519,2430.600,N,05421.000,E,4,12,0.8,1.6,M,,M,,*4B\n$HEHDT,12.3,T*1F\n$SDDBT,32.8,f,10.0,M,5.5,F*3A'
  );
  const [nmeaResult, setNmeaResult] = useState<string | null>(null);

  const { data: config, isLoading, isError, error, refetch } = useConfigQuery();
  const { data: modes } = useModesQuery(undefined, { skip: tab !== 'modes' });
  const { data: adapters } = useAdaptersQuery(undefined, { skip: tab !== 'adapters' });
  const { data: history } = useConfigHistoryQuery(undefined, { skip: tab !== 'history' });
  const { data: ingestStatus } = useIngestStatusQuery(undefined, { skip: tab !== 'adapters' });
  const [updateConfig, { isLoading: saving }] = useUpdateConfigMutation();
  const [resetConfig, { isLoading: resetting }] = useResetConfigMutation();

  const canEdit = hasRole(user?.role, 'engineer');

  const groups = useMemo(() => {
    if (!config) return [];
    const leaves = flatten(config.effective);
    const defaults = new Map(flatten(config.defaults));
    const byGroup = new Map<string, Editable[]>();
    for (const [path, value] of leaves) {
      if (typeof value === 'object' && value !== null) continue;
      const group = path.split('.')[0];
      if (config.immutable_prefixes.some((p) => path.startsWith(p))) continue;
      const list = byGroup.get(group) ?? [];
      list.push({
        path,
        value: value as number | string | boolean,
        defaultValue: defaults.get(path) as number | string | boolean,
        bounds: config.editable_bounds[path]
      });
      byGroup.set(group, list);
    }
    return [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [config]);

  const filteredGroups = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return groups;
    return groups
      .map(([group, items]) => [group, items.filter((i) => i.path.toLowerCase().includes(term))] as [string, Editable[]])
      .filter(([, items]) => items.length > 0);
  }, [groups, search]);

  const dirty = Object.keys(edits).length > 0;

  const validate = () => {
    const next: Record<string, string> = {};
    for (const [path, raw] of Object.entries(edits)) {
      const item = groups.flatMap(([, items]) => items).find((i) => i.path === path);
      if (!item) continue;
      if (typeof item.defaultValue === 'number') {
        const value = Number(raw);
        if (!Number.isFinite(value)) next[path] = 'Must be a number.';
        else if (item.bounds && (value < item.bounds.min || value > item.bounds.max)) {
          next[path] = `Must be between ${item.bounds.min} and ${item.bounds.max}.`;
        }
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const save = async () => {
    if (!validate()) {
      dispatch(toastAdded('error', 'Some values are out of range', 'Correct the highlighted fields.'));
      return;
    }
    const updates: Record<string, unknown> = {};
    for (const [path, raw] of Object.entries(edits)) {
      const item = groups.flatMap(([, items]) => items).find((i) => i.path === path);
      if (!item) continue;
      updates[path] =
        typeof item.defaultValue === 'number'
          ? Number(raw)
          : typeof item.defaultValue === 'boolean'
            ? raw === 'true'
            : raw;
    }
    try {
      await updateConfig({ updates, note: note || undefined }).unwrap();
      dispatch(toastAdded('success', `${Object.keys(updates).length} values updated`, 'Applied to the live engines and recorded in the audit log.'));
      setEdits({});
      setErrors({});
      setNote('');
    } catch (err) {
      dispatch(toastAdded('error', 'Configuration change rejected', errorMessage(err)));
    }
  };

  if (!canEdit) {
    return (
      <Panel title="Configuration">
        <EmptyState
          title="Engineer role required"
          detail={`Configuration changes alter how the navigation engines behave and are restricted to the engineer role. You are signed in as ${user?.role}.`}
          icon="⚙"
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      <Panel bodyClassName="p-0">
        <div className="px-4 pt-3">
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'thresholds', label: 'Thresholds', badge: config?.overrides.length },
              { id: 'modes', label: 'Mode state machine' },
              { id: 'adapters', label: 'Adapters and ingestion' },
              { id: 'history', label: 'Change history' }
            ]}
          />
        </div>

        <div className="p-4">
          {tab === 'thresholds' && (
            <QueryBoundary
              isLoading={isLoading}
              isError={isError}
              error={isError ? { message: errorMessage(error) } : undefined}
              data={filteredGroups}
              isEmpty={(d) => d.length === 0}
              emptyTitle="No settings match"
              onRetry={refetch}
            >
              {(list) => (
                <>
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <SearchInput value={search} onChange={setSearch} placeholder="Filter settings" className="w-72" />
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={resetting || (config?.overrides.length ?? 0) === 0}
                      onClick={() => setConfirmReset(true)}
                    >
                      Reset all to defaults
                    </button>
                    <span className="ml-auto text-xs text-bridge-400">
                      {config?.overrides.length ?? 0} setting{(config?.overrides.length ?? 0) === 1 ? '' : 's'} differ
                      from the shipped defaults
                    </span>
                  </div>

                  {dirty && (
                    <div className="mb-4 rounded-lg border border-info/50 bg-info/10 p-3">
                      <p className="text-sm font-medium text-info">
                        {Object.keys(edits).length} unsaved change{Object.keys(edits).length === 1 ? '' : 's'}
                      </p>
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <Field label="Reason for the change" hint="Recorded in the audit log alongside the values.">
                          <input
                            type="text"
                            className="field-input w-96"
                            value={note}
                            placeholder="e.g. Tightening the drag detector after the Nov trial"
                            onChange={(e) => setNote(e.target.value)}
                          />
                        </Field>
                        <button type="button" className="btn-primary btn-sm" disabled={saving} onClick={save}>
                          {saving ? 'Applying…' : 'Apply changes'}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => {
                            setEdits({});
                            setErrors({});
                          }}
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="space-y-5">
                    {list.map(([group, items]) => (
                      <div key={group}>
                        <h3 className="panel-title">{group.replace(/_/g, ' ')}</h3>
                        {GROUP_DESCRIPTIONS[group] && (
                          <p className="mb-2 mt-0.5 text-xs text-bridge-400">{GROUP_DESCRIPTIONS[group]}</p>
                        )}
                        <div className="grid gap-2 lg:grid-cols-2">
                          {items.map((item) => {
                            const changed = String(item.value) !== String(item.defaultValue);
                            const editing = item.path in edits;
                            const current = editing ? edits[item.path] : String(item.value);
                            const isBoolean = typeof item.defaultValue === 'boolean';
                            return (
                              <div
                                key={item.path}
                                className={`rounded border px-3 py-2 ${
                                  editing
                                    ? 'border-info/60 bg-info/5'
                                    : changed
                                      ? 'border-caution/40 bg-caution/5'
                                      : 'border-bridge-800 bg-bridge-850'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate font-mono text-2xs text-bridge-300" title={item.path}>
                                      {item.path.split('.').slice(1).join('.')}
                                    </p>
                                    <p className="mt-0.5 text-[10px] text-bridge-500">
                                      default {String(item.defaultValue)}
                                      {item.bounds && ` · range ${item.bounds.min}–${item.bounds.max}`}
                                    </p>
                                  </div>
                                  <div className="w-32 shrink-0">
                                    {isBoolean ? (
                                      <select
                                        className="field-input py-1 text-xs"
                                        value={current}
                                        onChange={(e) => setEdits((p) => ({ ...p, [item.path]: e.target.value }))}
                                      >
                                        <option value="true">true</option>
                                        <option value="false">false</option>
                                      </select>
                                    ) : (
                                      <input
                                        type={typeof item.defaultValue === 'number' ? 'number' : 'text'}
                                        step="any"
                                        className="field-input py-1 text-right font-mono text-xs"
                                        value={current}
                                        aria-label={item.path}
                                        onChange={(e) => setEdits((p) => ({ ...p, [item.path]: e.target.value }))}
                                      />
                                    )}
                                  </div>
                                </div>
                                {errors[item.path] && (
                                  <p className="mt-1 text-2xs text-critical" role="alert">
                                    {errors[item.path]}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>

                  <Note tone="caution">
                    Changes take effect immediately on the running engines. Safety-critical values carry bounds so the
                    requirement limit cannot be moved to a value that would make the dashboard read green regardless of
                    the actual uncertainty. Values under <code>platform</code> and <code>security</code> cannot be
                    changed at runtime at all.
                  </Note>
                </>
              )}
            </QueryBoundary>
          )}

          {tab === 'modes' && (
            <div className="space-y-3">
              <Note>
                The mode state machine is data, not code. Conditions use a small declarative predicate language with no
                expression evaluation, which is what keeps the "no arbitrary code execution" requirement satisfiable by
                inspection.
              </Note>
              {(modes?.items ?? []).map((mode: any) => (
                <div key={mode.id} className="rounded-lg border border-bridge-700 bg-bridge-850 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold text-bridge-100">{mode.label}</h3>
                    <span className="font-mono text-2xs text-bridge-500">
                      priority {mode.priority} · {mode.id}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-bridge-300">{mode.description}</p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <div>
                      <KeyValue label="Expected accuracy" value={mode.expected_accuracy} />
                      <KeyValue label="Uncertainty behaviour" value={mode.uncertainty_behaviour} />
                      <KeyValue label="Operator alarm" value={mode.operator_alarm} />
                    </div>
                    <div>
                      <p className="text-2xs uppercase tracking-wider text-bridge-400">Active sensors</p>
                      <p className="font-mono text-2xs text-bridge-300">{(mode.active_sensors ?? []).join(', ') || '—'}</p>
                      <p className="mt-1.5 text-2xs uppercase tracking-wider text-bridge-400">Rejected sensors</p>
                      <p className="font-mono text-2xs text-bridge-300">{(mode.rejected_sensors ?? []).join(', ') || '—'}</p>
                      <p className="mt-1.5 text-2xs uppercase tracking-wider text-bridge-400">Exit</p>
                      <p className="text-2xs text-bridge-300">{mode.exit}</p>
                    </div>
                  </div>
                  <p className="mt-2 rounded border border-caution/30 bg-caution/5 px-2 py-1.5 text-2xs leading-relaxed text-caution">
                    {mode.operator_guidance}
                  </p>
                  <p className="mt-1.5 font-mono text-[10px] text-bridge-500">
                    → {(mode.next_modes ?? []).join(' · ')}
                  </p>
                </div>
              ))}
            </div>
          )}

          {tab === 'adapters' && (
            <div className="space-y-4">
              <div>
                <p className="panel-title mb-2">
                  Adapters — {adapters?.implemented ?? 0} implemented, {adapters?.placeholders ?? 0} placeholders
                </p>
                <div className="grid gap-2 lg:grid-cols-2">
                  {(adapters?.items ?? []).map((adapter: any) => (
                    <div
                      key={adapter.id}
                      className={`rounded border p-3 ${
                        adapter.status === 'IMPLEMENTED'
                          ? 'border-assured/40 bg-assured/5'
                          : 'border-bridge-700 bg-bridge-850'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h4 className="text-sm font-medium text-bridge-100">{adapter.name}</h4>
                          <p className="font-mono text-2xs text-bridge-500">{adapter.transport}</p>
                        </div>
                        <StatusChip
                          presentation={
                            adapter.status === 'IMPLEMENTED'
                              ? { ...SEVERITY_PRESENTATION.INFO, label: 'Implemented', short: 'IMPLEMENTED', glyph: '✓', text: 'text-assured', bg: 'bg-assured/15', border: 'border-assured/50' }
                              : { ...SEVERITY_PRESENTATION.ADVISORY, label: 'Placeholder', short: 'PLACEHOLDER', glyph: '○' }
                          }
                        />
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-bridge-400">{adapter.description}</p>
                      {adapter.contract && (
                        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-bridge-500">
                          Contract: {adapter.contract}
                        </p>
                      )}
                      {adapter.production_notes && (
                        <p className="mt-1 text-[10px] leading-relaxed text-info">{adapter.production_notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="panel-title mb-2">Ingestion status</p>
                  {ingestStatus ? (
                    <>
                      <KeyValue label="Pipeline attached" value={ingestStatus.handler_attached ? 'Yes' : 'No — start a scenario'} />
                      <KeyValue label="REST messages received" value={ingestStatus.rest_messages_received} />
                      <KeyValue label="REST messages accepted" value={ingestStatus.rest_messages_accepted} />
                      <KeyValue label="REST messages rejected" value={ingestStatus.rest_messages_rejected} />
                      <KeyValue label="NMEA sentences received" value={ingestStatus.nmea_sentences_received} />
                      <KeyValue label="Maximum batch size" value={ingestStatus.max_batch_size} />
                      {ingestStatus.last_error && (
                        <Note tone="caution">
                          Last rejection: {JSON.stringify(ingestStatus.last_error.errors).slice(0, 200)}
                        </Note>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-bridge-400">Loading…</p>
                  )}
                </div>

                <div>
                  <p className="panel-title mb-2">NMEA 0183 test bench</p>
                  <Field label="Sentences" hint="One sentence per line, including the checksum.">
                    <textarea
                      className="field-input h-28 font-mono text-xs"
                      value={nmeaText}
                      onChange={(e) => setNmeaText(e.target.value)}
                    />
                  </Field>
                  <NmeaTester text={nmeaText} onResult={setNmeaResult} />
                  <p className="mt-2 text-2xs leading-relaxed text-bridge-500">
                    Sentences are checksum-verified and converted to internal sensor messages. If a scenario is
                    running they are also fed to the navigation pipeline, so a real receiver can be exercised against
                    the live engines.
                  </p>
                  {nmeaResult && (
                    <pre className="mt-2 max-h-48 overflow-auto rounded border border-bridge-700 bg-bridge-950 p-2 text-[10px] text-bridge-300">
                      {nmeaResult}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === 'history' && (
            <div>
              {(history?.items?.length ?? 0) === 0 ? (
                <EmptyState
                  title="No configuration changes"
                  detail="Every threshold is still at its shipped default."
                  icon="⚙"
                />
              ) : (
                <div className="overflow-x-auto rounded border border-bridge-700">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Path</th>
                        <th>Value</th>
                        <th>Changed by</th>
                        <th>When</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(history?.items ?? []).map((row: any, i: number) => (
                        <tr key={i}>
                          <td className="font-mono text-2xs">{row.path}</td>
                          <td className="font-mono text-2xs text-bridge-100">{JSON.stringify(row.value)}</td>
                          <td className="text-2xs">{row.updated_by_username ?? '—'}</td>
                          <td className="text-2xs text-bridge-400" title={timestamp(row.updated_at, true)}>
                            {relativeTime(row.updated_at)}
                          </td>
                          <td className="text-2xs text-bridge-400">{row.note ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </Panel>

      <ConfirmDialog
        open={confirmReset}
        title="Reset configuration"
        message="Every runtime override will be removed and the shipped defaults restored. This takes effect immediately on the running engines and is recorded in the audit log."
        confirmLabel="Reset to defaults"
        destructive
        busy={resetting}
        onCancel={() => setConfirmReset(false)}
        onConfirm={async () => {
          try {
            await resetConfig({}).unwrap();
            dispatch(toastAdded('success', 'Configuration reset to defaults'));
            setEdits({});
          } catch (err) {
            dispatch(toastAdded('error', 'Reset failed', errorMessage(err)));
          } finally {
            setConfirmReset(false);
          }
        }}
      />
    </div>
  );
}

/** Small helper that parses NMEA through the dedicated backend route. */
function NmeaTester({ text, onResult }: { text: string; onResult: (result: string) => void }) {
  const token = useAppSelector((s) => s.auth.token);
  return (
    <button
      type="button"
      className="btn-primary btn-sm ml-2"
      onClick={async () => {
        try {
          const response = await fetch('/api/data/ingest/nmea', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ sentences: text })
          });
          onResult(JSON.stringify(await response.json(), null, 2));
        } catch (err) {
          onResult(`Request failed: ${(err as Error).message}`);
        }
      }}
    >
      Parse and ingest
    </button>
  );
}

export default ConfigPage;
