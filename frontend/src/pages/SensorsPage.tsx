/**
 * Sensor health panel (Section 15.2).
 *
 * A sortable, searchable table of every sensor with its rate, age, residuals
 * and — crucially — the reason it was accepted or excluded. "Rejected" without
 * a reason is not actionable, so the reason is a first-class column rather than
 * a tooltip.
 */

import { useMemo, useState } from 'react';
import { useAppSelector } from '../store';
import { useSensorDetailQuery, useSensorsQuery, errorMessage } from '../api/api';
import {
  KeyValue,
  Modal,
  Note,
  Panel,
  QueryBoundary,
  SearchInput,
  Select,
  SortHeader,
  StatusChip,
  useSort
} from '../components/ui';
import { LineChart } from '../charts/charts';
import { duration, number, EM_DASH } from '../utils/format';
import { sensorTone } from '../utils/status';
import type { SensorHealth } from '../types';

type Column =
  | 'sensor_id'
  | 'sensor_type'
  | 'status'
  | 'update_rate_hz'
  | 'data_age_s'
  | 'message_count'
  | 'residual_rms'
  | 'normalized_residual_rms'
  | 'rejected_count';

interface Row extends SensorHealth {
  name: string;
  absolute: boolean;
  advisory: boolean;
  optional: boolean;
  nominalRate: number | null;
  trustScore: number | null;
  interfaceDescription: string | null;
  manufacturerClass: string | null;
}

function SensorDetailModal({ sensorId, onClose }: { sensorId: string | null; onClose: () => void }) {
  const { data, isLoading, isError, error } = useSensorDetailQuery(sensorId!, { skip: !sensorId });

  return (
    <Modal open={Boolean(sensorId)} onClose={onClose} title={`Sensor ${sensorId ?? ''}`} size="lg">
      <QueryBoundary isLoading={isLoading} isError={isError} error={error} data={data}>
        {(detail) => {
          const residuals = (detail.recent_residuals ?? []) as Array<{
            sim_time_s: number;
            normalized_residual: number | null;
            measurement_kind: string;
          }>;
          const messages = (detail.recent_messages ?? []) as Array<Record<string, any>>;
          const health = detail.health as SensorHealth | null;
          return (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="panel-title mb-2">Definition</p>
                  <KeyValue label="Name" value={detail.sensor?.name} />
                  <KeyValue label="Type" value={detail.sensor?.sensor_type} />
                  <KeyValue label="Class" value={detail.sensor?.manufacturer_class ?? EM_DASH} />
                  <KeyValue label="Interface" value={detail.sensor?.interface_description ?? EM_DASH} />
                  <KeyValue label="Nominal rate" value={`${detail.sensor?.nominal_rate_hz ?? EM_DASH} Hz`} />
                  <KeyValue label="Provides" value={(detail.sensor?.provides ?? []).join(', ') || EM_DASH} />
                  <KeyValue
                    label="Absolute position source"
                    value={detail.sensor?.absolute_position_source ? 'Yes' : 'No'}
                  />
                </div>
                <div>
                  <p className="panel-title mb-2">Live health</p>
                  {health ? (
                    <>
                      <KeyValue label="Online" value={health.online ? 'Yes' : 'No'} tone={health.online ? 'assured' : 'critical'} />
                      <KeyValue label="Observed rate" value={`${number(health.update_rate_hz, 2)} Hz`} />
                      <KeyValue label="Data age" value={duration(health.data_age_s)} />
                      <KeyValue label="Messages" value={health.message_count} />
                      <KeyValue label="Accepted into filter" value={health.accepted_count} />
                      <KeyValue label="Rejected at ingestion" value={health.rejected_count} />
                      <KeyValue label="Duplicates" value={health.duplicate_count} />
                      <KeyValue label="Out of order" value={health.out_of_order_count} />
                      <KeyValue label="Gate failures" value={health.gate_failures} />
                      <KeyValue label="Residual RMS" value={number(health.residual_rms, 4)} />
                      <KeyValue label="Normalized residual RMS" value={number(health.normalized_residual_rms, 3)} />
                    </>
                  ) : (
                    <p className="text-xs text-bridge-400">No live health data. Start a scenario.</p>
                  )}
                </div>
              </div>

              {health?.exclusion_reason && (
                <Note tone="caution">
                  <strong>Excluded:</strong> {health.exclusion_reason}
                </Note>
              )}

              {residuals.length > 0 && (
                <div>
                  <p className="panel-title mb-2">Normalized residual history</p>
                  <LineChart
                    data={residuals.map((r) => ({ t: r.sim_time_s, value: r.normalized_residual }))}
                    label="Normalized residual"
                    unit="σ"
                    colour="#38bdf8"
                    markLineAt={3}
                    markLineLabel="warn 3σ"
                    height={180}
                  />
                  <Note>
                    A normalized residual is the disagreement between this sensor and the filter, divided by how much
                    disagreement was expected. Around 1 is healthy. Persistently above 3 means the sensor and the
                    solution do not agree within their stated uncertainties.
                  </Note>
                </div>
              )}

              {messages.length > 0 && (
                <div>
                  <p className="panel-title mb-2">Recent messages</p>
                  <div className="max-h-64 overflow-auto rounded border border-bridge-700">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Seq</th>
                          <th>Position</th>
                          <th>Heading</th>
                          <th>Depth</th>
                          <th>Decision</th>
                        </tr>
                      </thead>
                      <tbody>
                        {messages.slice(0, 60).map((m, i) => (
                          <tr key={i}>
                            <td className="font-mono text-2xs">{Number(m.sim_time_s).toFixed(2)}</td>
                            <td className="font-mono text-2xs">{m.sequence_number}</td>
                            <td className="font-mono text-2xs">
                              {m.latitude !== null ? `${Number(m.latitude).toFixed(6)}, ${Number(m.longitude).toFixed(6)}` : EM_DASH}
                            </td>
                            <td className="font-mono text-2xs">{m.heading_deg !== null ? Number(m.heading_deg).toFixed(2) : EM_DASH}</td>
                            <td className="font-mono text-2xs">{m.depth_m !== null ? Number(m.depth_m).toFixed(2) : EM_DASH}</td>
                            <td className="text-2xs">
                              <span className={m.decision === 'REJECTED' ? 'text-critical' : 'text-bridge-300'}>
                                {m.decision ?? 'ACCEPTED'}
                              </span>
                              {m.decision_reason && <span className="block text-bridge-500">{m.decision_reason}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          );
        }}
      </QueryBoundary>
    </Modal>
  );
}

export function SensorsPage() {
  const navigation = useAppSelector((s) => s.live.navigation);
  const { data, isLoading, isError, error, refetch } = useSensorsQuery();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const liveById = new Map((navigation?.sensor_health ?? []).map((h) => [h.sensor_id, h]));
    return data.items
      .filter((s) => s.sensor_id !== 'TRUTH_01')
      .map((s) => {
        const health = liveById.get(s.sensor_id) ??
          s.health ?? {
            sensor_id: s.sensor_id,
            sensor_type: s.sensor_type,
            online: false,
            last_update_s: null,
            data_age_s: null,
            update_rate_hz: null,
            nominal_rate_hz: s.nominal_rate_hz ?? 0,
            message_count: 0,
            accepted_count: 0,
            rejected_count: 0,
            duplicate_count: 0,
            out_of_order_count: 0,
            gate_failures: 0,
            residual_rms: null,
            normalized_residual_rms: null,
            chi_square: null,
            chi_square_threshold: null,
            excluded: false,
            exclusion_reason: null,
            exclusion_category: null,
            faults: [],
            decision: 'NOT_USED',
            reason: null
          };
        return {
          ...health,
          name: s.name,
          absolute: s.absolute_position_source,
          advisory: s.advisory_only,
          optional: s.optional,
          nominalRate: s.nominal_rate_hz,
          trustScore: s.sensor_id === 'GNSS_01' ? (navigation?.gnss.trust_score ?? s.trust_score) : null,
          interfaceDescription: s.interface_description,
          manufacturerClass: s.manufacturer_class
        };
      });
  }, [data, navigation]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === 'online' && !row.online) return false;
      if (filter === 'offline' && row.online) return false;
      if (filter === 'excluded' && !row.excluded) return false;
      if (filter === 'faulted' && row.faults.length === 0) return false;
      if (filter === 'absolute' && !row.absolute) return false;
      if (!term) return true;
      return (
        row.sensor_id.toLowerCase().includes(term) ||
        row.sensor_type.toLowerCase().includes(term) ||
        row.name.toLowerCase().includes(term) ||
        (row.exclusion_reason ?? '').toLowerCase().includes(term)
      );
    });
  }, [rows, search, filter]);

  const { sorted, sort, onSort } = useSort<Row, Column>(filtered, 'sensor_id', (row, column) => {
    if (column === 'status') return row.excluded ? 2 : row.online ? 0 : 1;
    return row[column] as string | number | null;
  });

  const counts = useMemo(
    () => ({
      total: rows.length,
      online: rows.filter((r) => r.online).length,
      excluded: rows.filter((r) => r.excluded).length,
      faulted: rows.filter((r) => r.faults.length > 0).length
    }),
    [rows]
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Sensors configured', value: counts.total, tone: 'text-bridge-100' },
          { label: 'Online', value: counts.online, tone: 'text-assured' },
          { label: 'Reporting faults', value: counts.faulted, tone: counts.faulted ? 'text-caution' : 'text-bridge-100' },
          { label: 'Excluded from solution', value: counts.excluded, tone: counts.excluded ? 'text-critical' : 'text-bridge-100' }
        ].map((tile) => (
          <div key={tile.label} className="panel px-4 py-3">
            <p className="readout-label">{tile.label}</p>
            <p className={`mt-1 font-mono text-3xl font-semibold tabular-nums ${tile.tone}`}>{tile.value}</p>
          </div>
        ))}
      </div>

      <Panel
        title="Sensor health"
        subtitle="Every configured sensor, its data quality, and the reason for its current decision"
        actions={
          <div className="flex items-center gap-2">
            <SearchInput value={search} onChange={setSearch} placeholder="Search sensors" className="w-52" />
            <Select
              value={filter}
              onChange={setFilter}
              ariaLabel="Filter sensors"
              options={[
                { value: 'all', label: 'All sensors' },
                { value: 'online', label: 'Online only' },
                { value: 'offline', label: 'Offline only' },
                { value: 'excluded', label: 'Excluded only' },
                { value: 'faulted', label: 'Reporting faults' },
                { value: 'absolute', label: 'Absolute position sources' }
              ]}
              className="w-52"
            />
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
          emptyTitle="No sensors match"
          emptyDetail="Adjust the search term or the filter."
          onRetry={refetch}
          loadingRows={6}
        >
          {(list) => (
            <div className="max-h-[34rem] overflow-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortHeader column="sensor_id" label="Sensor" sort={sort} onSort={onSort} />
                    <SortHeader column="sensor_type" label="Type" sort={sort} onSort={onSort} />
                    <SortHeader column="status" label="Status" sort={sort} onSort={onSort} />
                    <SortHeader column="update_rate_hz" label="Rate" sort={sort} onSort={onSort} align="right" />
                    <SortHeader column="data_age_s" label="Age" sort={sort} onSort={onSort} align="right" />
                    <SortHeader column="message_count" label="Messages" sort={sort} onSort={onSort} align="right" />
                    <SortHeader column="residual_rms" label="Residual" sort={sort} onSort={onSort} align="right" />
                    <SortHeader
                      column="normalized_residual_rms"
                      label="Norm. residual"
                      sort={sort}
                      onSort={onSort}
                      align="right"
                    />
                    <th scope="col">Decision and reason</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((row) => {
                    const tone = sensorTone(row.excluded, row.online, row.faults);
                    const rateOk =
                      row.update_rate_hz === null || row.nominalRate === null
                        ? true
                        : row.update_rate_hz > row.nominalRate * 0.6;
                    return (
                      <tr
                        key={row.sensor_id}
                        className="cursor-pointer"
                        onClick={() => setSelected(row.sensor_id)}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') setSelected(row.sensor_id);
                        }}
                      >
                        <td>
                          <span className="font-mono text-xs text-bridge-100">{row.sensor_id}</span>
                          <span className="block text-2xs text-bridge-500">{row.name}</span>
                        </td>
                        <td>
                          <span className="text-xs">{row.sensor_type}</span>
                          <span className="block text-2xs text-bridge-500">
                            {row.absolute ? 'absolute source' : row.advisory ? 'advisory only' : 'relative'}
                          </span>
                        </td>
                        <td>
                          <StatusChip presentation={tone} />
                          {row.trustScore !== null && (
                            <span className="mt-1 block font-mono text-2xs text-bridge-400">
                              trust {row.trustScore.toFixed(0)}
                            </span>
                          )}
                        </td>
                        <td className={`text-right font-mono text-xs ${rateOk ? '' : 'text-caution'}`}>
                          {number(row.update_rate_hz, 1)}
                          <span className="text-bridge-500"> / {row.nominalRate ?? EM_DASH} Hz</span>
                        </td>
                        <td
                          className={`text-right font-mono text-xs ${
                            (row.data_age_s ?? 0) > 3 ? 'text-caution' : ''
                          }`}
                        >
                          {row.data_age_s === null ? EM_DASH : `${row.data_age_s.toFixed(1)} s`}
                        </td>
                        <td className="text-right font-mono text-xs">
                          {row.message_count}
                          {row.rejected_count > 0 && (
                            <span className="block text-2xs text-critical">{row.rejected_count} rejected</span>
                          )}
                        </td>
                        <td className="text-right font-mono text-xs">{number(row.residual_rms, 3)}</td>
                        <td
                          className={`text-right font-mono text-xs ${
                            (row.normalized_residual_rms ?? 0) > 3 ? 'text-caution' : ''
                          }`}
                        >
                          {number(row.normalized_residual_rms, 2)}
                        </td>
                        <td className="max-w-md">
                          <span className="text-xs">{row.decision}</span>
                          {(row.exclusion_reason || row.reason) && (
                            <span className="mt-0.5 block text-2xs leading-relaxed text-bridge-400">
                              {row.exclusion_reason ?? row.reason}
                            </span>
                          )}
                          {row.faults.length > 0 && (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {row.faults.map((f) => (
                                <span key={f} className="chip border-caution/40 bg-caution/10 text-caution">
                                  {f.replace(/_/g, ' ')}
                                </span>
                              ))}
                            </span>
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
      </Panel>

      <Note>
        Sensors are listed with vendor-neutral class descriptions. This platform integrates with OEM equipment through
        generic configurable adapters; naming a manufacturer here would imply an integration that has not been built.
      </Note>

      <SensorDetailModal sensorId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export default SensorsPage;
