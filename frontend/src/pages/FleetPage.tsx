/**
 * Fleet overview.
 *
 * The screen an operations room leaves on the wall. It answers one question at
 * a glance — *which of my vessels can still prove where they are?* — and lets
 * anything that needs attention be opened without hunting for it.
 *
 * Vessels are ordered by how much attention they need, not alphabetically. A
 * fleet list sorted by name buries the vessel in trouble somewhere in the
 * middle, which is precisely the vessel the display exists to surface.
 */

import { useMemo, useState } from 'react';
import { useAppSelector } from '../store';
import { useFleetQuery } from '../api/api';
import { EmptyState, Panel, StatusChip } from '../components/ui';
import { REQUIREMENT_PRESENTATION, TRUST_PRESENTATION, sourceColours } from '../utils/status';
import { bearing, duration, latitudeDm, longitudeDm, metres, number, speed as fmtSpeed, EM_DASH } from '../utils/format';
import { FleetChartTabs } from '../map/MapTabs';
import type { FleetVessel, RequirementStatus } from '../types';

/**
 * How much attention a vessel needs. Lower sorts first.
 *
 * Integrity that is not assured outranks everything: the vessel cannot prove
 * where it is. A suspected attack comes next, because it is the situation most
 * likely to need a decision in the next few minutes.
 */
function attentionRank(v: FleetVessel): number {
  if (v.integrity_status === 'NOT_ASSURED') return 0;
  if (v.gnss_spoofing_suspected) return 1;
  if (v.requirement_status === 'REQUIREMENT_NOT_MET') return 2;
  if (v.gnss_jamming_suspected) return 3;
  if (v.requirement_status === 'REQUIREMENT_AT_RISK') return 4;
  if (!v.solution_available) return 5;
  return 6;
}

function CountTile({
  label,
  value,
  tone,
  hint
}: {
  label: string;
  value: number;
  tone: 'assured' | 'caution' | 'critical' | 'neutral';
  hint: string;
}) {
  const toneClass = {
    assured: 'border-assured/40 bg-assured/10 text-assured',
    caution: 'border-caution/40 bg-caution/10 text-caution',
    critical: 'border-critical/40 bg-critical/10 text-critical',
    neutral: 'border-bridge-700 bg-bridge-850 text-bridge-200'
  }[tone];

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${toneClass}`} title={hint}>
      <p className="font-mono text-2xl font-semibold tabular-nums leading-none">{value}</p>
      <p className="mt-1.5 text-2xs font-semibold uppercase tracking-[0.1em] opacity-80">{label}</p>
    </div>
  );
}

function VesselRow({
  vessel,
  selected,
  onSelect
}: {
  vessel: FleetVessel;
  selected: boolean;
  onSelect: () => void;
}) {
  const requirement = vessel.requirement_status
    ? REQUIREMENT_PRESENTATION[vessel.requirement_status as RequirementStatus]
    : null;
  const trust = vessel.gnss_status ? TRUST_PRESENTATION[vessel.gnss_status] : null;
  const limit = vessel.requirement_limit_m ?? 2;
  const hpl = vessel.horizontal_protection_level_m;

  return (
    <tr
      onClick={onSelect}
      className={`cursor-pointer ${selected ? 'bg-info/10' : ''}`}
      aria-selected={selected}
    >
      <td>
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: sourceColours().fused }}
          />
          <div className="min-w-0">
            <p className="truncate font-medium text-bridge-100">{vessel.name}</p>
            <p className="truncate text-2xs text-bridge-400">
              {vessel.type ?? EM_DASH} · {vessel.call_sign ?? EM_DASH}
            </p>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap">
        {requirement ? (
          <StatusChip presentation={requirement} />
        ) : (
          <span className="text-bridge-500">{EM_DASH}</span>
        )}
      </td>
      <td className="whitespace-nowrap text-right font-mono tabular-nums">
        <span className={hpl !== null && hpl > limit ? 'text-critical' : 'text-bridge-100'}>
          {metres(hpl, 2)}
        </span>
      </td>
      <td className="whitespace-nowrap">
        {trust ? (
          <span className={`chip ${trust.bg} ${trust.border} ${trust.text}`}>
            <span aria-hidden>{trust.glyph}</span>
            {vessel.gnss_trust_score ?? EM_DASH}
          </span>
        ) : (
          <span className="text-bridge-500">{EM_DASH}</span>
        )}
      </td>
      <td className="truncate text-bridge-300">{vessel.mode_label ?? EM_DASH}</td>
      <td className="whitespace-nowrap text-right font-mono tabular-nums text-bridge-300">
        {fmtSpeed(vessel.speed_mps)}
      </td>
      <td className="whitespace-nowrap text-right font-mono tabular-nums text-bridge-300">
        {bearing(vessel.heading_deg)}
      </td>
    </tr>
  );
}

function VesselDetail({ vessel }: { vessel: FleetVessel }) {
  const requirement = vessel.requirement_status
    ? REQUIREMENT_PRESENTATION[vessel.requirement_status as RequirementStatus]
    : null;

  return (
    <Panel title={vessel.name} subtitle={`${vessel.type ?? ''} · ${vessel.scenario_name ?? ''}`}>
      <div className="space-y-3">
        {requirement && (
          <div className="flex items-center justify-between gap-3">
            <span className="readout-label">Safeen &lt;2 m requirement</span>
            <StatusChip presentation={requirement} />
          </div>
        )}

        {vessel.integrity_status === 'NOT_ASSURED' && vessel.operator_guidance && (
          <div className="rounded-md border border-critical/50 bg-critical/10 p-2.5">
            <p className="text-2xs font-semibold uppercase tracking-wider text-critical">Operator action</p>
            <p className="mt-1 text-xs leading-relaxed text-bridge-100">{vessel.operator_guidance}</p>
          </div>
        )}

        <dl className="space-y-0">
          <div className="kv-row">
            <dt className="kv-key">Position</dt>
            <dd className="kv-value">
              {vessel.position
                ? `${latitudeDm(vessel.position.latitude)}  ${longitudeDm(vessel.position.longitude)}`
                : EM_DASH}
            </dd>
          </div>
          <div className="kv-row">
            <dt className="kv-key">Protection level</dt>
            <dd className="kv-value">{metres(vessel.horizontal_protection_level_m, 2)}</dd>
          </div>
          <div className="kv-row">
            <dt className="kv-key">Independent absolute sources</dt>
            <dd className="kv-value">{vessel.independent_absolute_sources}</dd>
          </div>
          <div className="kv-row">
            <dt className="kv-key">Uncertainty growth</dt>
            <dd className="kv-value">
              {number(vessel.protection_level_growth_rate_m_per_s, 3)} m/s
            </dd>
          </div>
          <div className="kv-row">
            <dt className="kv-key">Dead-reckoning duration</dt>
            <dd className="kv-value">{duration(vessel.dead_reckoning_duration_s)}</dd>
          </div>
          <div className="kv-row">
            <dt className="kv-key">GNSS</dt>
            <dd className="kv-value">
              {vessel.gnss_status ?? EM_DASH}
              {vessel.gnss_spoofing_suspected && <span className="ml-1.5 text-critical">spoofing</span>}
              {vessel.gnss_jamming_suspected && <span className="ml-1.5 text-alert">jamming</span>}
            </dd>
          </div>
          <div className="kv-row">
            <dt className="kv-key">MMSI</dt>
            <dd className="kv-value">{vessel.mmsi ?? EM_DASH}</dd>
          </div>
        </dl>

        {vessel.excluded_sensors.length > 0 && (
          <div>
            <p className="readout-label mb-1.5">Excluded from the solution</p>
            <div className="flex flex-wrap gap-1">
              {vessel.excluded_sensors.map((id) => (
                <span key={id} className="chip border-critical/40 bg-critical/10 text-critical">
                  {id}
                </span>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="readout-label mb-1.5">Contributing</p>
          <div className="flex flex-wrap gap-1">
            {vessel.contributing_sensors.length === 0 ? (
              <span className="text-xs text-bridge-500">None</span>
            ) : (
              vessel.contributing_sensors.map((id) => (
                <span key={id} className="chip border-bridge-600 bg-bridge-800 text-bridge-300">
                  {id}
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function FleetPage() {
  // The live channel carries the fleet; the query is the fallback for a first
  // paint before the socket has delivered anything.
  const live = useAppSelector((s) => s.live.fleet);
  const { data: fetched, isLoading, error } = useFleetQuery(undefined, {
    pollingInterval: live ? 0 : 5000
  });
  const fleet = live ?? fetched ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const vessels = useMemo(
    () => [...(fleet?.vessels ?? [])].sort((a, b) => attentionRank(a) - attentionRank(b)),
    [fleet]
  );
  const selected = vessels.find((v) => v.vessel_id === selectedId) ?? vessels[0] ?? null;
  const counts = fleet?.counts;

  if (isLoading && !fleet) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-96 w-full" />
      </div>
    );
  }

  if (!fleet || vessels.length === 0) {
    return (
      <EmptyState
        title="No vessels are being monitored"
        detail={
          error
            ? 'The fleet service could not be reached.'
            : 'Vessels join the fleet as they come on watch. If this persists, start the fleet from the system status screen.'
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Fleet-wide counts. The first thing read, so it goes first. */}
      {counts && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <CountTile label="Vessels" value={counts.total} tone="neutral" hint="Vessels currently monitored." />
          <CountTile
            label="Requirement met"
            value={counts.requirement_met}
            tone="assured"
            hint="Position bounded within the 2 m limit, with an independent absolute source."
          />
          <CountTile label="At risk" value={counts.requirement_at_risk} tone="caution" hint="Still met, but the margin is thin or the uncertainty is growing." />
          <CountTile label="Not met" value={counts.requirement_not_met} tone="critical" hint="The error cannot be bounded within 2 m." />
          <CountTile
            label="Integrity lost"
            value={counts.integrity_not_assured}
            tone="critical"
            hint="No independent absolute source. The vessel cannot prove its position."
          />
          <CountTile label="Under attack" value={counts.under_attack} tone="critical" hint="GNSS spoofing or jamming suspected." />
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-3">
          <Panel title="Fleet positions" bodyClassName="p-0">
            <FleetChartTabs
              vessels={vessels}
              selectedId={selected?.vessel_id ?? null}
              onSelect={setSelectedId}
              className="h-[26rem]"
            />
          </Panel>

          <Panel title="Vessels" subtitle="Ordered by the attention each needs" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vessel</th>
                    <th>Requirement</th>
                    <th className="text-right">Protection level</th>
                    <th>GNSS</th>
                    <th>Mode</th>
                    <th className="text-right">Speed</th>
                    <th className="text-right">Heading</th>
                  </tr>
                </thead>
                <tbody>
                  {vessels.map((v) => (
                    <VesselRow
                      key={v.vessel_id}
                      vessel={v}
                      selected={v.vessel_id === selected?.vessel_id}
                      onSelect={() => setSelectedId(v.vessel_id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        {selected && <VesselDetail vessel={selected} />}
      </div>
    </div>
  );
}

export default FleetPage;
