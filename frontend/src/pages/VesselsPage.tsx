/**
 * Vessel management.
 *
 * Create, edit and remove the vessels the platform monitors, and configure the
 * sensor fit each one carries. The fit matters more than it looks: a vessel
 * with no absolute positioning source can never report the requirement as met,
 * whatever else it carries, so the form says that at the moment the operator
 * unticks the last one rather than leaving them to wonder later why the vessel
 * never goes green.
 *
 * Edits change what *will* be monitored. Rebuilding a vessel's pipeline
 * discards its filter state, so that happens when the operator asks for it,
 * not on every keystroke.
 */

import { useMemo, useState } from 'react';
import {
  useVesselsQuery,
  useCreateVesselMutation,
  useUpdateVesselMutation,
  useDeleteVesselMutation,
  useApplyFleetMutation,
  errorMessage
} from '../api/api';
import { useAppDispatch, useAppSelector } from '../store';
import { toastAdded } from '../store/uiSlice';
import { hasRole } from '../store/authSlice';
import {
  ConfirmDialog,
  EmptyState,
  Field,
  Modal,
  Note,
  Panel,
  SearchInput,
  Select,
  Toggle
} from '../components/ui';
import { EM_DASH } from '../utils/format';
import type { Vessel, VesselListResponse } from '../types';

/** Field-level problems returned by the server, keyed by field. */
type FieldErrors = Record<string, string>;

interface DraftVessel {
  id: string;
  name: string;
  vessel_type: string;
  call_sign: string;
  mmsi: string;
  imo: string;
  flag: string;
  operator: string;
  length_m: string;
  beam_m: string;
  draft_m: string;
  scenario_id: string;
  start_offset_s: string;
  east_m: string;
  north_m: string;
  monitored: boolean;
  focused: boolean;
  notes: string;
  unfitted: Set<string>;
}

const emptyDraft = (): DraftVessel => ({
  id: '',
  name: '',
  vessel_type: '',
  call_sign: '',
  mmsi: '',
  imo: '',
  flag: 'AE',
  operator: '',
  length_m: '',
  beam_m: '',
  draft_m: '',
  scenario_id: '',
  start_offset_s: '0',
  east_m: '0',
  north_m: '0',
  monitored: true,
  focused: false,
  notes: '',
  unfitted: new Set()
});

function toDraft(vessel: Vessel): DraftVessel {
  const unfitted = new Set(
    Object.entries(vessel.sensor_configuration ?? {})
      .filter(([, cfg]) => cfg?.fitted === false)
      .map(([id]) => id)
  );
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return {
    id: vessel.id,
    name: vessel.name,
    vessel_type: text(vessel.vessel_type),
    call_sign: text(vessel.call_sign),
    mmsi: text(vessel.mmsi),
    imo: text(vessel.imo),
    flag: text(vessel.flag),
    operator: text(vessel.operator),
    length_m: text(vessel.dimensions?.length_m),
    beam_m: text(vessel.dimensions?.beam_m),
    draft_m: text(vessel.dimensions?.draft_m),
    scenario_id: text(vessel.scenario_id),
    start_offset_s: text(vessel.start_offset_s ?? 0),
    east_m: text(vessel.station_offset?.east_m ?? 0),
    north_m: text(vessel.station_offset?.north_m ?? 0),
    monitored: vessel.monitored,
    focused: vessel.focused,
    notes: text(vessel.notes),
    unfitted
  };
}

/** Turn the draft into the payload the API expects, dropping empty fields. */
function toPayload(draft: DraftVessel, sensors: VesselListResponse['reference']['sensors']) {
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const str = (v: string) => (v.trim() === '' ? null : v.trim());

  const sensor_configuration: Record<string, { fitted: boolean }> = {};
  for (const sensor of sensors) {
    if (draft.unfitted.has(sensor.sensor_id)) sensor_configuration[sensor.sensor_id] = { fitted: false };
  }

  return {
    name: draft.name.trim(),
    vessel_type: str(draft.vessel_type),
    call_sign: str(draft.call_sign),
    mmsi: num(draft.mmsi),
    imo: num(draft.imo),
    flag: str(draft.flag),
    operator: str(draft.operator),
    dimensions: {
      length_m: num(draft.length_m),
      beam_m: num(draft.beam_m),
      draft_m: num(draft.draft_m)
    },
    scenario_id: str(draft.scenario_id),
    start_offset_s: Number(draft.start_offset_s) || 0,
    station_offset: { east_m: Number(draft.east_m) || 0, north_m: Number(draft.north_m) || 0 },
    monitored: draft.monitored,
    focused: draft.focused,
    notes: str(draft.notes),
    sensor_configuration
  };
}

/** Client-side checks, so obvious mistakes never reach the server. */
function validateDraft(draft: DraftVessel, isNew: boolean): FieldErrors {
  const errors: FieldErrors = {};
  if (isNew) {
    if (!draft.id.trim()) errors.id = 'An identifier is required.';
    else if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(draft.id.trim())) {
      errors.id = 'Upper-case letters, digits and underscores, starting with a letter. 3-40 characters.';
    }
  }
  if (!draft.name.trim()) errors.name = 'A name is required.';
  if (draft.mmsi.trim() && !/^\d{9}$/.test(draft.mmsi.trim())) errors.mmsi = 'An MMSI is nine digits.';
  if (draft.imo.trim() && !/^\d{7}$/.test(draft.imo.trim())) errors.imo = 'An IMO number is seven digits.';
  for (const [field, label] of [
    ['length_m', 'Length'],
    ['beam_m', 'Beam'],
    ['draft_m', 'Draft']
  ] as const) {
    const raw = draft[field];
    if (raw.trim() && !(Number(raw) > 0)) errors[field] = `${label} must be a positive number.`;
  }
  return errors;
}

function VesselForm({
  draft,
  setDraft,
  errors,
  reference,
  isNew
}: {
  draft: DraftVessel;
  setDraft: (next: DraftVessel) => void;
  errors: FieldErrors;
  reference: VesselListResponse['reference'];
  isNew: boolean;
}) {
  const set = <K extends keyof DraftVessel>(key: K, value: DraftVessel[K]) =>
    setDraft({ ...draft, [key]: value });

  const fitted = reference.sensors.filter((s) => !draft.unfitted.has(s.sensor_id));
  const absoluteFitted = fitted.filter((s) => s.absolute_position_source);
  const headingFitted = fitted.filter((s) => ['GYRO', 'INS', 'RADAR'].includes(s.sensor_type));

  const toggleSensor = (sensorId: string) => {
    const next = new Set(draft.unfitted);
    if (next.has(sensorId)) next.delete(sensorId);
    else next.add(sensorId);
    set('unfitted', next);
  };

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-bridge-300">Identity</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Identifier" required error={errors.id} hint={isNew ? 'Used in logs and alarms. Cannot be changed later.' : 'Fixed once created.'}>
            <input
              className="field-input"
              value={draft.id}
              disabled={!isNew}
              onChange={(e) => set('id', e.target.value.toUpperCase())}
              placeholder="VSL_EXAMPLE"
            />
          </Field>
          <Field label="Name" required error={errors.name}>
            <input className="field-input" value={draft.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Type" error={errors.vessel_type}>
            <input
              className="field-input"
              value={draft.vessel_type}
              onChange={(e) => set('vessel_type', e.target.value)}
              placeholder="Survey vessel"
            />
          </Field>
          <Field label="Operator" error={errors.operator}>
            <input className="field-input" value={draft.operator} onChange={(e) => set('operator', e.target.value)} />
          </Field>
          <Field label="Call sign" error={errors.call_sign}>
            <input
              className="field-input"
              value={draft.call_sign}
              onChange={(e) => set('call_sign', e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Flag" error={errors.flag}>
            <input
              className="field-input"
              value={draft.flag}
              maxLength={3}
              onChange={(e) => set('flag', e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="MMSI" error={errors.mmsi} hint="Nine digits. Must be unique across the fleet.">
            <input className="field-input" value={draft.mmsi} onChange={(e) => set('mmsi', e.target.value)} />
          </Field>
          <Field label="IMO number" error={errors.imo} hint="Seven digits.">
            <input className="field-input" value={draft.imo} onChange={(e) => set('imo', e.target.value)} />
          </Field>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-bridge-300">Dimensions</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Length overall (m)" error={errors.length_m}>
            <input className="field-input" value={draft.length_m} onChange={(e) => set('length_m', e.target.value)} />
          </Field>
          <Field label="Beam (m)" error={errors.beam_m}>
            <input className="field-input" value={draft.beam_m} onChange={(e) => set('beam_m', e.target.value)} />
          </Field>
          <Field label="Draft (m)" error={errors.draft_m}>
            <input className="field-input" value={draft.draft_m} onChange={(e) => set('draft_m', e.target.value)} />
          </Field>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-bridge-300">
          Operating position
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Scenario" error={errors.scenario_id} hint="What this vessel is currently experiencing.">
            <Select
              value={draft.scenario_id}
              onChange={(v) => set('scenario_id', v)}
              ariaLabel="Scenario"
              options={[
                { value: '', label: 'None' },
                ...reference.scenarios.map((s) => ({ value: s.id, label: s.name }))
              ]}
            />
          </Field>
          <Field
            label="Route stagger (s)"
            error={errors.start_offset_s}
            hint="Simulated at full fidelity on start, so keep it modest."
          >
            <input
              className="field-input"
              value={draft.start_offset_s}
              onChange={(e) => set('start_offset_s', e.target.value)}
            />
          </Field>
          <Field label="Station offset east (m)" error={errors.east_m} hint="Where in the operating area this vessel works.">
            <input className="field-input" value={draft.east_m} onChange={(e) => set('east_m', e.target.value)} />
          </Field>
          <Field label="Station offset north (m)" error={errors.north_m}>
            <input className="field-input" value={draft.north_m} onChange={(e) => set('north_m', e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <Toggle checked={draft.monitored} onChange={(v) => set('monitored', v)} label="Monitored" />
          <Toggle
            checked={draft.focused}
            onChange={(v) => set('focused', v)}
            label="Focused vessel"
            description="The vessel the detail screens, recording and fault injection follow. Only one at a time."
          />
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-bridge-300">Sensor fit</h3>

        {absoluteFitted.length === 0 && (
          <Note tone="caution">
            No absolute positioning source is fitted. This vessel could never report the 2 m requirement as met,
            because there would be nothing to bound its position against.
          </Note>
        )}
        {headingFitted.length === 0 && (
          <Note tone="caution">
            No heading reference is fitted. The filter cannot be initialised without one.
          </Note>
        )}

        <div className="grid gap-1.5 sm:grid-cols-2">
          {reference.sensors.map((sensor) => (
            <label
              key={sensor.sensor_id}
              className="flex cursor-pointer items-center gap-2.5 rounded-md border border-bridge-700 bg-bridge-850/60 px-2.5 py-2"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-current text-info"
                checked={!draft.unfitted.has(sensor.sensor_id)}
                onChange={() => toggleSensor(sensor.sensor_id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-bridge-100">{sensor.name}</span>
                <span className="block truncate text-2xs text-bridge-400">
                  {sensor.sensor_id}
                  {sensor.absolute_position_source && ' · absolute position'}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <Field label="Notes" error={errors.notes}>
        <textarea
          className="field-input min-h-[4rem]"
          value={draft.notes}
          onChange={(e) => set('notes', e.target.value)}
        />
      </Field>
    </div>
  );
}

export function VesselsPage() {
  const dispatch = useAppDispatch();
  const role = useAppSelector((s) => s.auth.user?.role);
  const canEdit = hasRole(role, 'engineer');

  const { data, isLoading, error, refetch } = useVesselsQuery();
  const [createVessel, createState] = useCreateVesselMutation();
  const [updateVessel, updateState] = useUpdateVesselMutation();
  const [deleteVessel, deleteState] = useDeleteVesselMutation();
  const [applyFleet, applyState] = useApplyFleetMutation();

  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Vessel | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<DraftVessel>(emptyDraft());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [confirmDelete, setConfirmDelete] = useState<Vessel | null>(null);

  const vessels = useMemo(() => {
    const term = search.trim().toLowerCase();
    const items = data?.items ?? [];
    if (!term) return items;
    return items.filter((v) =>
      [v.id, v.name, v.vessel_type, v.call_sign, String(v.mmsi ?? ''), v.scenario_name]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term))
    );
  }, [data, search]);

  const openCreate = () => {
    setDraft(emptyDraft());
    setErrors({});
    setCreating(true);
  };

  const openEdit = (vessel: Vessel) => {
    setDraft(toDraft(vessel));
    setErrors({});
    setEditing(vessel);
  };

  const close = () => {
    setCreating(false);
    setEditing(null);
    setErrors({});
  };

  /** Map the server's field-level problems onto the form. */
  const applyServerErrors = (err: unknown) => {
    const details = (err as { data?: { details?: Array<{ field: string; message: string }> } })?.data?.details;
    if (Array.isArray(details) && details.length > 0) {
      setErrors(Object.fromEntries(details.map((d) => [d.field, d.message])));
      return true;
    }
    return false;
  };

  const submit = async () => {
    const isNew = creating;
    const clientErrors = validateDraft(draft, isNew);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }

    const payload = toPayload(draft, data?.reference.sensors ?? []);
    try {
      if (isNew) {
        await createVessel({ id: draft.id.trim(), ...payload } as never).unwrap();
        dispatch(toastAdded('success', 'Vessel created', `${payload.name} has been added to the fleet.`));
      } else if (editing) {
        await updateVessel({ id: editing.id, changes: payload as never }).unwrap();
        dispatch(toastAdded('success', 'Vessel updated', `${payload.name} has been saved.`));
      }
      close();
    } catch (err) {
      if (!applyServerErrors(err)) {
        dispatch(toastAdded('error', 'Could not save the vessel', errorMessage(err)));
      }
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    try {
      await deleteVessel(confirmDelete.id).unwrap();
      dispatch(toastAdded('success', 'Vessel removed', `${confirmDelete.name} is no longer monitored.`));
      setConfirmDelete(null);
    } catch (err) {
      dispatch(toastAdded('error', 'Could not remove the vessel', errorMessage(err)));
      setConfirmDelete(null);
    }
  };

  const apply = async () => {
    try {
      await applyFleet().unwrap();
      dispatch(
        toastAdded(
          'info',
          'Rebuilding the fleet',
          'Vessels are being wound forward to their positions and will rejoin as they become ready.'
        )
      );
    } catch (err) {
      dispatch(toastAdded('error', 'Could not rebuild the fleet', errorMessage(err)));
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-12 w-full" />
        <div className="skeleton h-96 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        title="The vessel register could not be loaded"
        detail={errorMessage(error)}
        action={
          <button type="button" className="btn-secondary" onClick={() => refetch()}>
            Try again
          </button>
        }
      />
    );
  }

  const busy = createState.isLoading || updateState.isLoading;

  return (
    <div className="space-y-3">
      <Panel
        title="Vessel register"
        subtitle={`${data?.total ?? 0} vessels · each runs its own independent navigation pipeline`}
        actions={
          canEdit && (
            <div className="flex items-center gap-2">
              <button type="button" className="btn-secondary btn-sm" onClick={apply} disabled={applyState.isLoading}>
                {applyState.isLoading ? 'Rebuilding…' : 'Apply to fleet'}
              </button>
              <button type="button" className="btn-primary btn-sm" onClick={openCreate}>
                Add vessel
              </button>
            </div>
          )
        }
        bodyClassName="p-0"
      >
        <div className="border-b border-bridge-700 p-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search vessels" className="w-full sm:w-72" />
        </div>

        {vessels.length === 0 ? (
          <EmptyState
            title={search ? 'No vessels match that search' : 'No vessels are registered'}
            detail={
              search
                ? 'Try a different name, call sign or MMSI.'
                : 'Add a vessel to begin monitoring it. Each vessel runs its own navigation pipeline.'
            }
            action={
              canEdit && !search ? (
                <button type="button" className="btn-primary" onClick={openCreate}>
                  Add the first vessel
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vessel</th>
                  <th>Identity</th>
                  <th>Scenario</th>
                  <th>Station offset</th>
                  <th>Status</th>
                  {canEdit && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {vessels.map((vessel) => (
                  <tr key={vessel.id}>
                    <td>
                      <p className="font-medium text-bridge-100">{vessel.name}</p>
                      <p className="text-2xs text-bridge-400">
                        {vessel.id} · {vessel.vessel_type ?? EM_DASH}
                      </p>
                    </td>
                    <td className="whitespace-nowrap text-bridge-300">
                      <p className="font-mono text-xs">{vessel.call_sign ?? EM_DASH}</p>
                      <p className="font-mono text-2xs text-bridge-400">MMSI {vessel.mmsi ?? EM_DASH}</p>
                    </td>
                    <td className="text-bridge-300">{vessel.scenario_name ?? EM_DASH}</td>
                    <td className="whitespace-nowrap font-mono text-xs tabular-nums text-bridge-300">
                      {vessel.station_offset.east_m} E / {vessel.station_offset.north_m} N
                    </td>
                    <td className="whitespace-nowrap">
                      <div className="flex flex-wrap gap-1">
                        {vessel.focused && (
                          <span className="chip border-info/50 bg-info/15 text-info" title="Detail screens and recording follow this vessel">
                            <span aria-hidden>◎</span>FOCUSED
                          </span>
                        )}
                        <span
                          className={`chip ${
                            vessel.monitored
                              ? 'border-assured/50 bg-assured/15 text-assured'
                              : 'border-bridge-600 bg-bridge-800 text-bridge-400'
                          }`}
                        >
                          <span aria-hidden>{vessel.monitored ? '✓' : '○'}</span>
                          {vessel.monitored ? 'MONITORED' : 'STANDBY'}
                        </span>
                      </div>
                    </td>
                    {canEdit && (
                      <td className="whitespace-nowrap text-right">
                        <button type="button" className="btn-ghost btn-sm" onClick={() => openEdit(vessel)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn-ghost btn-sm text-critical"
                          onClick={() => setConfirmDelete(vessel)}
                          disabled={vessel.focused}
                          title={vessel.focused ? 'Focus another vessel before deleting this one' : 'Remove this vessel'}
                        >
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {canEdit && (
        <Note tone="info">
          Changes take effect for the running fleet when you choose <strong>Apply to fleet</strong>. Rebuilding
          restarts each vessel&apos;s pipeline and discards its filter state, so it is a deliberate step rather
          than something that happens as you type.
        </Note>
      )}

      <Modal
        open={creating || editing !== null}
        onClose={close}
        title={creating ? 'Add a vessel' : `Edit ${editing?.name ?? ''}`}
        size="xl"
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? 'Saving…' : creating ? 'Create vessel' : 'Save changes'}
            </button>
          </div>
        }
      >
        {data && (
          <VesselForm
            draft={draft}
            setDraft={setDraft}
            errors={errors}
            reference={data.reference}
            isNew={creating}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Remove this vessel?"
        message={
          <>
            <strong>{confirmDelete?.name}</strong> will stop being monitored and its record will be deleted.
            Recorded history from earlier runs is kept.
          </>
        }
        confirmLabel="Remove vessel"
        destructive
        busy={deleteState.isLoading}
        onConfirm={remove}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

export default VesselsPage;
