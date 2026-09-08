/**
 * Alarm panel (Section 15.5).
 *
 * Filter, search, acknowledge and export. Acknowledgement is deliberately
 * separate from clearing: an acknowledged alarm whose condition is still true
 * stays active and stays visible, which is the standard bridge convention.
 */

import { useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  useAcknowledgeAlarmMutation,
  useAcknowledgeAllAlarmsMutation,
  useAlarmsQuery,
  errorMessage
} from '../api/api';
import { alarmAcknowledgedLocally, allAlarmsAcknowledgedLocally } from '../store/liveSlice';
import { toastAdded } from '../store/uiSlice';
import { hasRole } from '../store/authSlice';
import {
  ConfirmDialog,
  EmptyState,
  Note,
  Panel,
  QueryBoundary,
  SearchInput,
  Select,
  SortHeader,
  StatusChip,
  useSort
} from '../components/ui';
import { useDownload } from '../hooks/useDownload';
import { relativeTime, simClock, timestamp } from '../utils/format';
import { SEVERITY_PRESENTATION } from '../utils/status';
import type { Alarm, AlarmSeverity } from '../types';

type Column = 'raised_at' | 'severity' | 'code' | 'source' | 'sim_time_s' | 'acknowledged_at';

const SEVERITY_ORDER: AlarmSeverity[] = ['CRITICAL', 'WARNING', 'ADVISORY', 'INFO'];

export function AlarmsPage() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);
  const runId = useAppSelector((s) => s.live.scenario?.run_id ?? null);
  const liveActive = useAppSelector((s) => s.live.activeAlarms);

  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('all');
  const [scope, setScope] = useState<'active' | 'run' | 'all'>('run');
  const [acknowledged, setAcknowledged] = useState('all');
  const [confirmAll, setConfirmAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const queryArgs = useMemo(() => {
    const args: Record<string, unknown> = { limit: 500 };
    if (scope === 'run' && runId) args.runId = runId;
    if (scope === 'active') args.active = true;
    if (severity !== 'all') args.severity = severity;
    if (acknowledged !== 'all') args.acknowledged = acknowledged === 'yes';
    if (search.trim()) args.search = search.trim();
    return args;
  }, [scope, runId, severity, acknowledged, search]);

  const { data, isLoading, isFetching, isError, error, refetch } = useAlarmsQuery(queryArgs, {
    pollingInterval: 10000
  });
  const [acknowledge] = useAcknowledgeAlarmMutation();
  const [acknowledgeAll, { isLoading: acknowledgingAll }] = useAcknowledgeAllAlarmsMutation();
  const { download, busy: downloading } = useDownload();

  const canAcknowledge = hasRole(user?.role, 'operator');

  const rows = useMemo<Alarm[]>(() => {
    // The live socket is ahead of the polled query, so merge both and dedupe.
    const byId = new Map<string, Alarm>();
    for (const a of data?.items ?? []) byId.set(a.id, a);
    if (scope !== 'all') {
      for (const a of liveActive) if (!byId.has(a.id)) byId.set(a.id, a);
    }
    return [...byId.values()];
  }, [data, liveActive, scope]);

  const { sorted, sort, onSort } = useSort<Alarm, Column>(
    rows,
    'raised_at',
    (row, column) => {
      if (column === 'severity') return SEVERITY_ORDER.indexOf(row.severity);
      if (column === 'raised_at') return new Date(row.raised_at).getTime();
      if (column === 'acknowledged_at') return row.acknowledged_at ? new Date(row.acknowledged_at).getTime() : null;
      return row[column] as string | number | null;
    },
    'desc'
  );

  const summary = data?.summary as
    | { by_severity: Record<AlarmSeverity, { count: number; unacknowledged: number }>; total: number; unacknowledged: number }
    | undefined;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SEVERITY_ORDER.map((sev) => {
          const presentation = SEVERITY_PRESENTATION[sev];
          const stat = summary?.by_severity?.[sev] ?? { count: 0, unacknowledged: 0 };
          return (
            <button
              key={sev}
              type="button"
              onClick={() => setSeverity(severity === sev ? 'all' : sev)}
              className={`panel px-4 py-3 text-left transition-colors ${
                severity === sev ? `${presentation.border} ${presentation.bg}` : 'hover:border-bridge-600'
              }`}
            >
              <div className="flex items-center justify-between">
                <p className="readout-label">{presentation.label}</p>
                <span aria-hidden className={presentation.text}>
                  {presentation.glyph}
                </span>
              </div>
              <p className={`mt-1 font-mono text-3xl font-semibold tabular-nums ${presentation.text}`}>{stat.count}</p>
              {stat.unacknowledged > 0 && (
                <p className="mt-0.5 text-2xs text-bridge-400">{stat.unacknowledged} unacknowledged</p>
              )}
            </button>
          );
        })}
      </div>

      <Panel
        title="Alarms"
        subtitle={
          scope === 'active'
            ? 'Currently active conditions'
            : scope === 'run'
              ? 'This scenario run'
              : 'Every recorded alarm'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={search} onChange={setSearch} placeholder="Search message, code or source" className="w-56" />
            <Select
              value={scope}
              onChange={(v) => setScope(v as typeof scope)}
              ariaLabel="Scope"
              options={[
                { value: 'active', label: 'Active only' },
                { value: 'run', label: 'Current run', disabled: !runId },
                { value: 'all', label: 'All history' }
              ]}
              className="w-36"
            />
            <Select
              value={acknowledged}
              onChange={setAcknowledged}
              ariaLabel="Acknowledgement"
              options={[
                { value: 'all', label: 'Any acknowledgement' },
                { value: 'no', label: 'Unacknowledged' },
                { value: 'yes', label: 'Acknowledged' }
              ]}
              className="w-44"
            />
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={downloading || !runId}
              onClick={() => download('alarms', 'csv', runId)}
            >
              Export CSV
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={downloading || !runId}
              onClick={() => download('alarms', 'json', runId)}
            >
              Export JSON
            </button>
            {canAcknowledge && (
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={acknowledgingAll}
                onClick={() => setConfirmAll(true)}
              >
                Acknowledge all
              </button>
            )}
          </div>
        }
        bodyClassName="p-0"
      >
        <QueryBoundary
          isLoading={isLoading}
          isError={isError}
          error={isError ? { message: errorMessage(error) } : undefined}
          data={sorted}
          isEmpty={(d) => d.length === 0}
          emptyTitle="No alarms match"
          emptyDetail={
            scope === 'active'
              ? 'No conditions are currently active. That is the desired state.'
              : 'Adjust the filters, or start a scenario to generate events.'
          }
          onRetry={refetch}
          loadingRows={8}
        >
          {(list) => (
            <div className="max-h-[36rem] overflow-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortHeader column="severity" label="Severity" sort={sort} onSort={onSort} />
                    <SortHeader column="raised_at" label="Raised" sort={sort} onSort={onSort} />
                    <SortHeader column="sim_time_s" label="Sim time" sort={sort} onSort={onSort} align="right" />
                    <SortHeader column="code" label="Code" sort={sort} onSort={onSort} />
                    <SortHeader column="source" label="Source" sort={sort} onSort={onSort} />
                    <th scope="col">Message and reason</th>
                    <SortHeader column="acknowledged_at" label="Acknowledged" sort={sort} onSort={onSort} />
                  </tr>
                </thead>
                <tbody>
                  {list.map((alarm) => {
                    const presentation = SEVERITY_PRESENTATION[alarm.severity];
                    const isExpanded = expanded === alarm.id;
                    return (
                      <tr
                        key={alarm.id}
                        className={
                          alarm.severity === 'CRITICAL' && !alarm.acknowledged_at ? 'bg-critical/5' : undefined
                        }
                      >
                        <td>
                          <StatusChip presentation={presentation} />
                        </td>
                        <td className="whitespace-nowrap">
                          <span className="font-mono text-2xs">{timestamp(alarm.raised_at)}</span>
                          <span className="block text-2xs text-bridge-500">{relativeTime(alarm.raised_at)}</span>
                        </td>
                        <td className="text-right font-mono text-2xs">{simClock(alarm.sim_time_s)}</td>
                        <td className="font-mono text-2xs">{alarm.code}</td>
                        <td className="font-mono text-2xs">{alarm.source}</td>
                        <td className="max-w-xl">
                          <button
                            type="button"
                            className="text-left"
                            onClick={() => setExpanded(isExpanded ? null : alarm.id)}
                          >
                            <span className="text-xs text-bridge-100">{alarm.message}</span>
                            {alarm.reason && (
                              <span
                                className={`mt-0.5 block text-2xs leading-relaxed text-bridge-400 ${
                                  isExpanded ? '' : 'line-clamp-2'
                                }`}
                              >
                                {alarm.reason}
                              </span>
                            )}
                          </button>
                          {alarm.recommended_action && (
                            <p className="mt-1 text-2xs leading-relaxed text-caution">
                              → {alarm.recommended_action}
                            </p>
                          )}
                          {isExpanded && alarm.detail && Object.keys(alarm.detail).length > 0 && (
                            <pre className="mt-2 max-h-40 overflow-auto rounded border border-bridge-700 bg-bridge-950 p-2 text-[10px] text-bridge-300">
                              {JSON.stringify(alarm.detail, null, 2)}
                            </pre>
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          {alarm.acknowledged_at ? (
                            <>
                              <span className="text-2xs text-bridge-300">{timestamp(alarm.acknowledged_at)}</span>
                              {alarm.acknowledged_by_username && (
                                <span className="block text-2xs text-bridge-500">
                                  by {alarm.acknowledged_by_username}
                                </span>
                              )}
                            </>
                          ) : canAcknowledge ? (
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              onClick={async () => {
                                try {
                                  await acknowledge(alarm.id).unwrap();
                                  dispatch(alarmAcknowledgedLocally(alarm.id));
                                } catch (err) {
                                  dispatch(toastAdded('error', 'Acknowledgement failed', errorMessage(err)));
                                }
                              }}
                            >
                              Acknowledge
                            </button>
                          ) : (
                            <span className="text-2xs text-bridge-500">Operator role required</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </QueryBoundary>

        {isFetching && !isLoading && (
          <div className="border-t border-bridge-800 px-4 py-1.5 text-2xs text-bridge-500">Refreshing…</div>
        )}
      </Panel>

      <Note>
        Acknowledging an alarm records that it has been seen. It does not clear the underlying condition: an alarm
        stays active until the condition that raised it goes away. Alarm records are append-only and cannot be edited
        or deleted from this interface.
      </Note>

      {liveActive.length === 0 && rows.length === 0 && !isLoading && (
        <Panel>
          <EmptyState
            title="No alarm history"
            detail="Alarms are recorded as scenarios run. Start one to see the system's reasoning."
            icon="⚠"
          />
        </Panel>
      )}

      <ConfirmDialog
        open={confirmAll}
        title="Acknowledge all active alarms"
        message="This records that you have seen every currently active alarm. Conditions that are still true will remain active and will stay visible."
        confirmLabel="Acknowledge all"
        busy={acknowledgingAll}
        onCancel={() => setConfirmAll(false)}
        onConfirm={async () => {
          try {
            const result = await acknowledgeAll().unwrap();
            dispatch(allAlarmsAcknowledgedLocally());
            dispatch(toastAdded('success', `${result.acknowledged} alarms acknowledged`));
          } catch (err) {
            dispatch(toastAdded('error', 'Acknowledgement failed', errorMessage(err)));
          } finally {
            setConfirmAll(false);
          }
        }}
      />
    </div>
  );
}

export default AlarmsPage;
