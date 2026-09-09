/**
 * RTK Query API definition.
 *
 * All server communication goes through here so that loading, error and empty
 * states are handled uniformly rather than reinvented per screen, and so that a
 * 401 has exactly one place to sign the operator out.
 */

import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query';
import { loggedOut } from '../store/authSlice';
import type {
  FleetSnapshot,
  Vessel,
  VesselListResponse,
  VesselSensorFit,
  Alarm,
  ConfigDescription,
  FaultTypeDef,
  GeoBundle,
  NavigationOutput,
  PerformanceReport,
  ReplaySession,
  ReplayStatus,
  RunSummary,
  ScenarioStatus,
  ScenarioSummary,
  SensorDefinition,
  SystemStatus,
  TimeseriesPoint,
  User
} from '../types';

/*
 * Default to the path the dashboard itself is served from, so an IIS
 * application at `/MNS` calls `/MNS/api/...` without a second setting to keep
 * in step. `VITE_API_BASE_URL` still overrides it for the rarer case of an API
 * on a different origin.
 */
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? import.meta.env.BASE_URL.replace(/\/$/, '');

const rawBaseQuery = fetchBaseQuery({
  baseUrl: `${API_BASE}/api`,
  // Resolve `fetch` at call time rather than binding the reference at module
  // load. Binding it early makes the transport impossible to substitute, which
  // in turn makes every query untestable without a live server.
  fetchFn: (...args) => fetch(...args),
  prepareHeaders: (headers, { getState }) => {
    const token = (getState() as { auth: { token: string | null } }).auth.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }
});

/**
 * Wraps the base query so an expired or rejected token signs the operator out
 * once, centrally, instead of every screen showing its own broken state.
 */
const baseQueryWithAuth: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args,
  api,
  extraOptions
) => {
  const result = await rawBaseQuery(args, api, extraOptions);
  if (result.error?.status === 401) {
    const url = typeof args === 'string' ? args : args.url;
    // The login endpoint legitimately returns 401 for a bad password; that is
    // not a session expiry and must not clear a valid session.
    if (!url.includes('/auth/login')) api.dispatch(loggedOut());
  }
  return result;
};

export const api = createApi({
  reducerPath: 'api',
  baseQuery: baseQueryWithAuth,
  tagTypes: ['Scenario', 'Alarms', 'Sensors', 'Config', 'Users', 'Runs', 'Replay', 'System', 'Audit', 'Fleet', 'Vessels'],
  // Live data arrives over the WebSocket, so REST caches can be long-lived.
  keepUnusedDataFor: 120,
  endpoints: (builder) => ({
    // --- Auth ---------------------------------------------------------------
    login: builder.mutation<{ token: string; user: User; expires_in: string }, { username: string; password: string }>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body })
    }),
    me: builder.query<{ user: User }, void>({
      query: () => '/auth/me'
    }),
    changePassword: builder.mutation<{ changed: boolean }, { currentPassword: string; newPassword: string }>({
      query: (body) => ({ url: '/auth/change-password', method: 'POST', body })
    }),
    listUsers: builder.query<{ items: User[] }, void>({
      query: () => '/auth/users',
      providesTags: ['Users']
    }),
    createUser: builder.mutation<{ user: User }, Record<string, unknown>>({
      query: (body) => ({ url: '/auth/users', method: 'POST', body }),
      invalidatesTags: ['Users']
    }),
    updateUser: builder.mutation<{ user: User }, { id: string; body: Record<string, unknown> }>({
      query: ({ id, body }) => ({ url: `/auth/users/${id}`, method: 'PUT', body }),
      invalidatesTags: ['Users']
    }),
    deleteUser: builder.mutation<{ deleted: boolean }, string>({
      query: (id) => ({ url: `/auth/users/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Users']
    }),
    listAudit: builder.query<
      { items: Array<Record<string, any>>; total: number },
      { limit?: number; offset?: number; search?: string; action?: string }
    >({
      query: (params) => ({ url: '/auth/audit', params }),
      providesTags: ['Audit']
    }),

    // --- System -------------------------------------------------------------
    vessels: builder.query<VesselListResponse, void>({
      query: () => '/vessels',
      providesTags: ['Vessels']
    }),
    vessel: builder.query<{ vessel: Vessel; sensor_fit: VesselSensorFit[] }, string>({
      query: (id) => `/vessels/${id}`,
      providesTags: ['Vessels']
    }),
    createVessel: builder.mutation<{ vessel: Vessel }, Partial<Vessel> & { id: string; name: string }>({
      query: (body) => ({ url: '/vessels', method: 'POST', body }),
      invalidatesTags: ['Vessels', 'Fleet']
    }),
    updateVessel: builder.mutation<{ vessel: Vessel }, { id: string; changes: Partial<Vessel> }>({
      query: ({ id, changes }) => ({ url: `/vessels/${id}`, method: 'PUT', body: changes }),
      invalidatesTags: ['Vessels', 'Fleet']
    }),
    deleteVessel: builder.mutation<{ id: string; deleted: boolean }, string>({
      query: (id) => ({ url: `/vessels/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Vessels', 'Fleet']
    }),
    applyFleet: builder.mutation<{ running: boolean }, void>({
      query: () => ({ url: '/vessels/apply', method: 'POST' }),
      invalidatesTags: ['Fleet']
    }),
    fleet: builder.query<FleetSnapshot, void>({
      query: () => '/fleet',
      providesTags: ['Fleet']
    }),
    fleetVessel: builder.query<Record<string, unknown>, string>({
      query: (vesselId) => `/fleet/${vesselId}`,
      providesTags: ['Fleet']
    }),
    systemStatus: builder.query<SystemStatus, void>({
      query: () => '/system/status',
      providesTags: ['System']
    }),
    adapters: builder.query<{ items: Array<Record<string, any>>; implemented: number; placeholders: number }, void>({
      query: () => '/system/adapters'
    }),
    modes: builder.query<{ items: Array<Record<string, any>>; current: Record<string, any> | null }, void>({
      query: () => '/system/modes'
    }),
    sensors: builder.query<{ items: SensorDefinition[] }, void>({
      query: () => '/sensors',
      providesTags: ['Sensors']
    }),
    sensorDetail: builder.query<Record<string, any>, string>({
      query: (id) => `/sensors/${id}`
    }),

    // --- Geospatial ---------------------------------------------------------
    geoBundle: builder.query<GeoBundle, void>({
      query: () => '/geospatial/bundle',
      keepUnusedDataFor: 3600
    }),
    bathymetry: builder.query<
      { cells: Array<[number, number, number]>; min_depth_m: number; max_depth_m: number; cell_size_m: number; resolution_note: string },
      number | void
    >({
      query: (stride) => ({ url: '/geospatial/bathymetry', params: { stride: stride ?? 14 } }),
      keepUnusedDataFor: 3600
    }),

    // --- Navigation ---------------------------------------------------------
    navigationCurrent: builder.query<
      { available: boolean; navigation?: NavigationOutput; scenario: ScenarioStatus; replay: ReplayStatus; message?: string },
      void
    >({
      query: () => '/navigation/current'
    }),
    navigationHistory: builder.query<
      { run_id: string | null; items: Array<Record<string, any>> },
      { runId?: string; limit?: number; stride?: number } | void
    >({
      query: (params) => ({ url: '/navigation/history', params: params ?? {} })
    }),
    gnssDetail: builder.query<Record<string, any>, void>({
      query: () => '/navigation/gnss'
    }),
    integrityDetail: builder.query<Record<string, any>, void>({
      query: () => '/navigation/integrity'
    }),
    localizationDetail: builder.query<Record<string, any>, void>({
      query: () => '/navigation/localization'
    }),
    bathymetricDetail: builder.query<Record<string, any>, void>({
      query: () => '/navigation/bathymetric'
    }),
    modeTransitions: builder.query<{ items: Array<Record<string, any>> }, string | void>({
      query: (runId) => ({ url: '/navigation/mode-transitions', params: runId ? { runId } : {} })
    }),

    // --- Scenarios ----------------------------------------------------------
    scenarios: builder.query<
      { items: ScenarioSummary[]; current: ScenarioStatus; allowed_speed_multipliers: number[] },
      void
    >({
      query: () => '/scenarios',
      providesTags: ['Scenario']
    }),
    scenarioStatus: builder.query<ScenarioStatus, void>({
      query: () => '/scenarios/status',
      providesTags: ['Scenario']
    }),
    faultTypes: builder.query<{ items: FaultTypeDef[] }, void>({
      query: () => '/scenarios/fault-types',
      keepUnusedDataFor: 3600
    }),
    startScenario: builder.mutation<
      ScenarioStatus,
      { scenarioId: string; speedMultiplier?: number; insEnabled?: boolean; label?: string }
    >({
      query: ({ scenarioId, ...body }) => ({ url: `/scenarios/${scenarioId}/start`, method: 'POST', body }),
      invalidatesTags: ['Scenario', 'Alarms', 'Runs']
    }),
    scenarioControl: builder.mutation<ScenarioStatus, { action: 'pause' | 'resume' | 'stop' | 'reset'; }>({
      query: ({ action }) => ({ url: `/scenarios/${action}`, method: 'POST' }),
      invalidatesTags: ['Scenario', 'Runs']
    }),
    scenarioStep: builder.mutation<ScenarioStatus, { seconds: number }>({
      query: (body) => ({ url: '/scenarios/step', method: 'POST', body }),
      invalidatesTags: ['Scenario']
    }),
    scenarioSpeed: builder.mutation<ScenarioStatus, { speedMultiplier: number }>({
      query: (body) => ({ url: '/scenarios/speed', method: 'POST', body }),
      invalidatesTags: ['Scenario']
    }),
    scenarioJump: builder.mutation<ScenarioStatus, { timeS: number }>({
      query: (body) => ({ url: '/scenarios/jump', method: 'POST', body }),
      invalidatesTags: ['Scenario']
    }),
    manualFallback: builder.mutation<{ manual_fallback: boolean; message: string }, { enabled: boolean }>({
      query: (body) => ({ url: '/scenarios/manual-fallback', method: 'POST', body }),
      invalidatesTags: ['Scenario']
    }),
    injectFault: builder.mutation<
      { fault: Record<string, any>; scenario: ScenarioStatus },
      { type: string; sensor_id: string; duration_s?: number; params?: Record<string, number>; label?: string }
    >({
      query: (body) => ({ url: '/scenarios/inject-fault', method: 'POST', body }),
      invalidatesTags: ['Scenario']
    }),
    removeFault: builder.mutation<{ removed: Record<string, any>; scenario: ScenarioStatus }, { faultId: string }>({
      query: (body) => ({ url: '/scenarios/remove-fault', method: 'POST', body }),
      invalidatesTags: ['Scenario']
    }),

    // --- Alarms -------------------------------------------------------------
    alarms: builder.query<
      { items: Alarm[]; total: number; active_now: Alarm[]; summary: Record<string, any> },
      Record<string, unknown> | void
    >({
      query: (params) => ({ url: '/alarms', params: (params ?? {}) as Record<string, string> }),
      providesTags: ['Alarms']
    }),
    acknowledgeAlarm: builder.mutation<{ alarm: Alarm; note: string }, string>({
      query: (id) => ({ url: `/alarms/${id}/acknowledge`, method: 'POST' }),
      invalidatesTags: ['Alarms']
    }),
    acknowledgeAllAlarms: builder.mutation<{ acknowledged: number }, void>({
      query: () => ({ url: '/alarms/acknowledge-all', method: 'POST' }),
      invalidatesTags: ['Alarms']
    }),

    // --- Performance --------------------------------------------------------
    runs: builder.query<{ items: RunSummary[]; total: number }, { limit?: number; scenarioId?: string } | void>({
      query: (params) => ({ url: '/runs', params: (params ?? {}) as Record<string, string> }),
      providesTags: ['Runs']
    }),
    performanceSummary: builder.query<PerformanceReport & { available: boolean }, string | void>({
      query: (runId) => ({ url: '/performance/summary', params: runId ? { runId } : {} })
    }),
    timeseries: builder.query<
      { run_id: string | null; series: TimeseriesPoint[]; point_count: number; total_points: number },
      { runId?: string; maxPoints?: number } | void
    >({
      query: (params) => ({ url: '/performance/timeseries', params: (params ?? {}) as Record<string, string> })
    }),
    tracks: builder.query<
      {
        run_id: string | null;
        fused: Array<{ sim_time_s: number; latitude: number; longitude: number; navigation_mode: string; requirement_status: string }>;
        truth: Array<{ sim_time_s: number; latitude: number; longitude: number; zone: string }>;
        gnss: Array<{ sim_time_s: number; latitude: number; longitude: number }>;
      },
      { runId?: string } | void
    >({
      query: (params) => ({ url: '/performance/tracks', params: (params ?? {}) as Record<string, string> })
    }),
    generateReport: builder.mutation<PerformanceReport, { runId?: string }>({
      query: (body) => ({ url: '/performance/report', method: 'POST', body })
    }),

    // --- Replay -------------------------------------------------------------
    replaySessions: builder.query<{ items: ReplaySession[]; current: ReplayStatus }, void>({
      query: () => '/replay/sessions',
      providesTags: ['Replay']
    }),
    uploadReplay: builder.mutation<
      { session: ReplaySession & { parse_errors?: string[]; parse_error_count?: number } },
      { name: string; format: 'csv' | 'json'; content: string }
    >({
      query: (body) => ({ url: '/data/upload', method: 'POST', body }),
      invalidatesTags: ['Replay']
    }),
    replayFromRun: builder.mutation<{ session: ReplaySession }, { runId: string; name?: string }>({
      query: (body) => ({ url: '/replay/from-run', method: 'POST', body }),
      invalidatesTags: ['Replay']
    }),
    startReplay: builder.mutation<ReplayStatus, { sessionId: string; speedMultiplier?: number }>({
      query: ({ sessionId, ...body }) => ({ url: `/replay/${sessionId}/start`, method: 'POST', body }),
      invalidatesTags: ['Replay', 'Scenario']
    }),
    replayControl: builder.mutation<ReplayStatus, { action: 'pause' | 'resume' | 'stop' }>({
      query: ({ action }) => ({ url: `/replay/${action}`, method: 'POST' }),
      invalidatesTags: ['Replay']
    }),
    deleteReplay: builder.mutation<{ deleted: boolean }, string>({
      query: (id) => ({ url: `/replay/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Replay']
    }),

    // --- Configuration ------------------------------------------------------
    config: builder.query<ConfigDescription, void>({
      query: () => '/config',
      providesTags: ['Config']
    }),
    updateConfig: builder.mutation<ConfigDescription, { updates: Record<string, unknown>; note?: string }>({
      query: (body) => ({ url: '/config', method: 'PUT', body }),
      invalidatesTags: ['Config']
    }),
    resetConfig: builder.mutation<ConfigDescription, { paths?: string[] }>({
      query: (body) => ({ url: '/config/reset', method: 'POST', body }),
      invalidatesTags: ['Config']
    }),
    configHistory: builder.query<{ items: Array<Record<string, any>> }, void>({
      query: () => '/config/history',
      providesTags: ['Config']
    }),

    // --- Ingestion ----------------------------------------------------------
    ingestStatus: builder.query<Record<string, any>, void>({
      query: () => '/data/status'
    }),
    ingestNmea: builder.mutation<Record<string, any>, { sentences: string }>({
      query: (body) => ({ url: '/data/ingest/nmea', method: 'POST', body })
    }),
    validateMessage: builder.mutation<Record<string, any>, Record<string, unknown>>({
      query: (body) => ({ url: '/data/validate', method: 'POST', body })
    })
  })
});

export const {
  useVesselsQuery,
  useVesselQuery,
  useCreateVesselMutation,
  useUpdateVesselMutation,
  useDeleteVesselMutation,
  useApplyFleetMutation,
  useFleetQuery,
  useFleetVesselQuery,
  useLoginMutation,
  useMeQuery,
  useChangePasswordMutation,
  useListUsersQuery,
  useCreateUserMutation,
  useUpdateUserMutation,
  useDeleteUserMutation,
  useListAuditQuery,
  useSystemStatusQuery,
  useAdaptersQuery,
  useModesQuery,
  useSensorsQuery,
  useSensorDetailQuery,
  useGeoBundleQuery,
  useBathymetryQuery,
  useNavigationCurrentQuery,
  useNavigationHistoryQuery,
  useGnssDetailQuery,
  useIntegrityDetailQuery,
  useLocalizationDetailQuery,
  useBathymetricDetailQuery,
  useModeTransitionsQuery,
  useScenariosQuery,
  useScenarioStatusQuery,
  useFaultTypesQuery,
  useStartScenarioMutation,
  useScenarioControlMutation,
  useScenarioStepMutation,
  useScenarioSpeedMutation,
  useScenarioJumpMutation,
  useManualFallbackMutation,
  useInjectFaultMutation,
  useRemoveFaultMutation,
  useAlarmsQuery,
  useAcknowledgeAlarmMutation,
  useAcknowledgeAllAlarmsMutation,
  useRunsQuery,
  usePerformanceSummaryQuery,
  useTimeseriesQuery,
  useTracksQuery,
  useGenerateReportMutation,
  useReplaySessionsQuery,
  useUploadReplayMutation,
  useReplayFromRunMutation,
  useStartReplayMutation,
  useReplayControlMutation,
  useDeleteReplayMutation,
  useConfigQuery,
  useUpdateConfigMutation,
  useResetConfigMutation,
  useConfigHistoryQuery,
  useIngestStatusQuery,
  useIngestNmeaMutation,
  useValidateMessageMutation
} = api;

/** Extract a readable message from an RTK Query error. */
export function errorMessage(error: unknown): string {
  if (!error) return 'Unknown error.';
  const e = error as FetchBaseQueryError & { data?: any; error?: string };
  if (typeof e.status === 'number' && e.data) {
    if (typeof e.data === 'string') return e.data;
    if (e.data.message) {
      const details = Array.isArray(e.data.details)
        ? ` (${e.data.details.map((d: any) => `${d.field}: ${d.message}`).join('; ')})`
        : '';
      return `${e.data.message}${details}`;
    }
    return JSON.stringify(e.data).slice(0, 300);
  }
  if (e.status === 'FETCH_ERROR') return 'Cannot reach the server. Check that the backend is running.';
  if (e.status === 'PARSING_ERROR') return 'The server returned a response that could not be read.';
  if (e.error) return e.error;
  return 'Request failed.';
}

/** Build a download URL for an export, carrying the token as a query param. */
export function exportUrl(
  dataset: string,
  format: string,
  token: string | null,
  runId?: string | null
): string {
  const params = new URLSearchParams({ dataset, format });
  if (runId) params.set('runId', runId);
  // The browser cannot set an Authorization header on a plain navigation, so
  // exports are opened through fetch + blob instead. This helper returns the
  // path; see useDownload().
  void token;
  return `${API_BASE}/api/export?${params.toString()}`;
}
