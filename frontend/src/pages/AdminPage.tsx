/**
 * Administration: users, roles and the audit trail (Section 22).
 *
 * The audit log is read-only by design and is presented as such — there is no
 * edit or delete control anywhere on this screen, because the database itself
 * refuses those operations.
 */

import { useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  useCreateUserMutation,
  useDeleteUserMutation,
  useListAuditQuery,
  useListUsersQuery,
  useSystemStatusQuery,
  useUpdateUserMutation,
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
  SearchInput,
  Select,
  StatusChip,
  Tabs
} from '../components/ui';
import { bytes, duration, relativeTime, timestamp } from '../utils/format';
import { SEVERITY_PRESENTATION } from '../utils/status';
import type { Role, User } from '../types';

type Tab = 'users' | 'audit' | 'system';

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Read-only. Can see every panel but change nothing.',
  operator: 'Can start, pause and stop scenarios, acknowledge alarms and generate reports.',
  engineer: 'Adds fault injection, configuration changes and data ingestion.',
  administrator: 'Adds user management. Full access.'
};

function UserForm({
  user,
  open,
  onClose
}: {
  user: User | null;
  open: boolean;
  onClose: () => void;
}) {
  const dispatch = useAppDispatch();
  const [createUser, { isLoading: creating }] = useCreateUserMutation();
  const [updateUser, { isLoading: updating }] = useUpdateUserMutation();

  const [username, setUsername] = useState(user?.username ?? '');
  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'viewer');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isEdit = Boolean(user);
  const busy = creating || updating;

  const validate = () => {
    const next: Record<string, string> = {};
    if (!isEdit) {
      if (username.trim().length < 3) next.username = 'At least 3 characters.';
      else if (!/^[a-zA-Z0-9._-]+$/.test(username)) next.username = 'Letters, digits, dot, underscore or hyphen only.';
    }
    if (fullName.trim().length === 0) next.fullName = 'Required.';
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) next.email = 'Not a valid email address.';
    if (!isEdit || password) {
      if (password.length < 10) next.password = 'At least 10 characters.';
      else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) next.password = 'Must contain letters and digits.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    try {
      if (isEdit) {
        await updateUser({
          id: user!.id!,
          body: { fullName, email: email || null, role, ...(password ? { password } : {}) }
        }).unwrap();
        dispatch(toastAdded('success', 'User updated'));
      } else {
        await createUser({ username, fullName, email: email || null, role, password }).unwrap();
        dispatch(toastAdded('success', 'User created'));
      }
      onClose();
    } catch (err) {
      dispatch(toastAdded('error', isEdit ? 'Update failed' : 'Creation failed', errorMessage(err)));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit ${user?.username}` : 'Create user'}
      size="sm"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create user'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {!isEdit && (
          <Field label="Username" error={errors.username} required>
            <input
              className="field-input"
              value={username}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
        )}
        <Field label="Full name" error={errors.fullName} required>
          <input className="field-input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Email" error={errors.email}>
          <input className="field-input" type="email" value={email ?? ''} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role" required hint={ROLE_DESCRIPTIONS[role]}>
          <Select
            value={role}
            onChange={(v) => setRole(v as Role)}
            options={(['viewer', 'operator', 'engineer', 'administrator'] as Role[]).map((r) => ({
              value: r,
              label: r
            }))}
          />
        </Field>
        <Field
          label={isEdit ? 'New password (leave blank to keep)' : 'Password'}
          error={errors.password}
          required={!isEdit}
          hint="At least 10 characters, containing letters and digits."
        >
          <input
            className="field-input"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

export function AdminPage() {
  const dispatch = useAppDispatch();
  const currentUser = useAppSelector((s) => s.auth.user);
  const [tab, setTab] = useState<Tab>('users');
  const [editing, setEditing] = useState<User | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<User | null>(null);
  const [auditSearch, setAuditSearch] = useState('');

  const { data: users, isLoading, isError, error, refetch } = useListUsersQuery(undefined, {
    skip: !hasRole(currentUser?.role, 'administrator')
  });
  const { data: audit } = useListAuditQuery(
    { limit: 200, search: auditSearch || undefined },
    { skip: tab !== 'audit' }
  );
  const { data: system } = useSystemStatusQuery(undefined, { skip: tab !== 'system', pollingInterval: 10000 });
  const [updateUser] = useUpdateUserMutation();
  const [deleteUser, { isLoading: deleting }] = useDeleteUserMutation();

  const isAdmin = hasRole(currentUser?.role, 'administrator');

  const auditRows = useMemo(() => audit?.items ?? [], [audit]);

  if (!isAdmin) {
    return (
      <Panel title="Administration">
        <EmptyState
          title="Administrator role required"
          detail={`User management and the audit trail are restricted to administrators. You are signed in as ${currentUser?.role}.`}
          icon="⚿"
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
              { id: 'users', label: 'Users', badge: users?.items.length },
              { id: 'audit', label: 'Audit trail' },
              { id: 'system', label: 'System' }
            ]}
          />
        </div>

        <div className="p-4">
          {tab === 'users' && (
            <>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-xs text-bridge-400">
                  Roles are hierarchical: each role includes everything the one below it can do.
                </p>
                <button type="button" className="btn-primary btn-sm" onClick={() => setCreating(true)}>
                  Create user
                </button>
              </div>

              <QueryBoundary
                isLoading={isLoading}
                isError={isError}
                error={isError ? { message: errorMessage(error) } : undefined}
                data={users?.items}
                isEmpty={(d) => d.length === 0}
                emptyTitle="No users"
                onRetry={refetch}
              >
                {(list) => (
                  <div className="overflow-x-auto rounded border border-bridge-700">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Username</th>
                          <th>Full name</th>
                          <th>Email</th>
                          <th>Role</th>
                          <th>Status</th>
                          <th>Last sign-in</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((u) => (
                          <tr key={u.id ?? u.username}>
                            <td className="font-mono text-xs text-bridge-100">{u.username}</td>
                            <td className="text-xs">{u.full_name}</td>
                            <td className="text-2xs text-bridge-400">{u.email ?? '—'}</td>
                            <td>
                              <span className="chip border-bridge-600 bg-bridge-800 text-bridge-200" title={ROLE_DESCRIPTIONS[u.role]}>
                                {u.role}
                              </span>
                            </td>
                            <td>
                              <span className={u.is_active ? 'text-2xs text-assured' : 'text-2xs text-critical'}>
                                {u.is_active ? 'Active' : 'Disabled'}
                              </span>
                            </td>
                            <td className="text-2xs text-bridge-400">
                              {u.last_login_at ? relativeTime(u.last_login_at) : 'never'}
                            </td>
                            <td className="whitespace-nowrap text-right">
                              <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(u)}>
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn-ghost btn-sm"
                                onClick={async () => {
                                  try {
                                    await updateUser({ id: u.id!, body: { isActive: !u.is_active, unlock: true } }).unwrap();
                                    dispatch(toastAdded('success', u.is_active ? 'User disabled' : 'User enabled'));
                                  } catch (err) {
                                    dispatch(toastAdded('error', 'Update failed', errorMessage(err)));
                                  }
                                }}
                              >
                                {u.is_active ? 'Disable' : 'Enable'}
                              </button>
                              {u.id !== currentUser?.id && (
                                <button
                                  type="button"
                                  className="btn-ghost btn-sm text-critical"
                                  onClick={() => setConfirmDelete(u)}
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

              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {(['viewer', 'operator', 'engineer', 'administrator'] as Role[]).map((r) => (
                  <div key={r} className="rounded border border-bridge-700 bg-bridge-850 p-2.5">
                    <p className="text-xs font-semibold uppercase tracking-wider text-bridge-200">{r}</p>
                    <p className="mt-1 text-2xs leading-relaxed text-bridge-400">{ROLE_DESCRIPTIONS[r]}</p>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'audit' && (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <SearchInput
                  value={auditSearch}
                  onChange={setAuditSearch}
                  placeholder="Search action, actor or entity"
                  className="w-80"
                />
                <p className="text-xs text-bridge-400">{audit?.total ?? 0} records</p>
              </div>

              {auditRows.length === 0 ? (
                <EmptyState title="No audit records match" icon="⚿" />
              ) : (
                <div className="max-h-[32rem] overflow-auto rounded border border-bridge-700">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Actor</th>
                        <th>Action</th>
                        <th>Entity</th>
                        <th>Outcome</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditRows.map((row: any) => (
                        <tr key={row.id}>
                          <td className="whitespace-nowrap font-mono text-2xs" title={timestamp(row.occurred_at, true)}>
                            {timestamp(row.occurred_at)}
                          </td>
                          <td className="text-2xs">
                            {row.actor_name ?? '—'}
                            {row.actor_role && <span className="block text-bridge-500">{row.actor_role}</span>}
                          </td>
                          <td className="font-mono text-2xs text-bridge-100">{row.action}</td>
                          <td className="text-2xs text-bridge-400">
                            {row.entity_type ?? '—'}
                            {row.entity_id && (
                              <span className="block truncate font-mono" style={{ maxWidth: '14rem' }}>
                                {row.entity_id}
                              </span>
                            )}
                          </td>
                          <td>
                            <span className={row.outcome === 'SUCCESS' ? 'text-2xs text-assured' : 'text-2xs text-critical'}>
                              {row.outcome}
                            </span>
                          </td>
                          <td className="max-w-md">
                            <details>
                              <summary className="cursor-pointer text-2xs text-bridge-400 hover:text-bridge-200">
                                {row.detail?.path ?? row.detail?.reason ?? 'view'}
                              </summary>
                              <pre className="mt-1 max-h-40 overflow-auto rounded border border-bridge-700 bg-bridge-950 p-2 text-[10px] text-bridge-300">
                                {JSON.stringify(row.detail, null, 2)}
                              </pre>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <Note>
                Audit records are append-only. The application never issues an update or delete against this table, and
                a database trigger enforces that guarantee independently of the application code.
              </Note>
            </>
          )}

          {tab === 'system' && system && (
            <div className="grid gap-4 lg:grid-cols-3">
              <div>
                <p className="panel-title mb-2">Platform</p>
                <KeyValue label="Name" value={system.platform.name} />
                <KeyValue label="Version" value={system.platform.version} />
                <KeyValue label="Classification" value={system.platform.classification} tone="caution" />
                <KeyValue label="Environment" value={system.environment} />
                <KeyValue label="Node" value={system.node_version} />
                <KeyValue label="Uptime" value={duration(system.uptime_s)} />
                <KeyValue
                  label="Trusted output"
                  value={system.trusted_output_read_only ? 'Read-only' : 'Writable'}
                  tone={system.trusted_output_read_only ? 'assured' : 'critical'}
                />
                <Note tone="caution">{system.control_output_note}</Note>
              </div>

              <div>
                <p className="panel-title mb-2">Database</p>
                <KeyValue
                  label="Connection"
                  value={system.database.ok ? 'Healthy' : 'Unreachable'}
                  tone={system.database.ok ? 'assured' : 'critical'}
                />
                <KeyValue label="Latency" value={`${system.database.latency_ms ?? '—'} ms`} />
                {system.database.counts &&
                  Object.entries(system.database.counts).map(([key, value]) => (
                    <KeyValue key={key} label={key.replace(/_/g, ' ')} value={Number(value).toLocaleString()} />
                  ))}

                <p className="panel-title mb-2 mt-4">Recorder</p>
                {Object.entries(system.recorder ?? {}).map(([key, value]) => (
                  <KeyValue
                    key={key}
                    label={key.replace(/_/g, ' ')}
                    value={typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    tone={key === 'rows_dropped' && Number(value) > 0 ? 'critical' : undefined}
                  />
                ))}
              </div>

              <div>
                <p className="panel-title mb-2">Process</p>
                <KeyValue label="Resident memory" value={bytes(system.process.rss_mb * 1048576)} />
                <KeyValue label="Heap used" value={bytes(system.process.heap_used_mb * 1048576)} />
                <KeyValue label="Heap total" value={bytes(system.process.heap_total_mb * 1048576)} />

                <p className="panel-title mb-2 mt-4">Ingestion</p>
                <KeyValue label="UDP listener" value={system.ingestion.udp_enabled ? 'Enabled' : 'Disabled'} />
                {system.ingestion.udp_enabled && (
                  <KeyValue label="Bound to" value={`${system.ingestion.udp_bind}:${system.ingestion.udp_port}`} />
                )}

                <p className="panel-title mb-2 mt-4">Alarms</p>
                <KeyValue label="Total recorded" value={system.alarms.total} />
                <KeyValue label="Unacknowledged" value={system.alarms.unacknowledged} />
                <KeyValue label="Active now" value={system.alarms.active_now} />
                {system.alarms.highest_active_severity && (
                  <div className="mt-1.5">
                    <StatusChip presentation={SEVERITY_PRESENTATION[system.alarms.highest_active_severity]} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </Panel>

      {(creating || editing) && (
        <UserForm
          key={editing?.id ?? 'new'}
          user={editing}
          open
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete ${confirmDelete?.username}`}
        message="The account will be removed permanently. Their audit records are retained, with the actor name preserved."
        confirmLabel="Delete user"
        destructive
        busy={deleting}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await deleteUser(confirmDelete!.id!).unwrap();
            dispatch(toastAdded('success', 'User deleted'));
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

export default AdminPage;
