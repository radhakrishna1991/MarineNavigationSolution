/**
 * Live navigation state, fed by the WebSocket.
 *
 * Two design decisions worth stating:
 *
 *  - Only a bounded history is kept in the store. A bridge display left running
 *    for a watch would otherwise accumulate tens of thousands of epochs in
 *    Redux and slow to a crawl. Full history comes from the database when a
 *    screen actually needs it.
 *  - The connection state is part of the model, not a detail. A dashboard that
 *    silently shows the last frame it received, forever, is dangerous; the UI
 *    needs to be able to say "this data is N seconds old and the link is down".
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Alarm, FleetSnapshot, NavigationOutput, ReplayStatus, ScenarioStatus } from '../types';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** Points retained for the live sparklines. At 5 Hz this is ten minutes. */
const HISTORY_LIMIT = 3000;
/** Track points retained for the live map trail. */
const TRAIL_LIMIT = 1500;

export interface LiveHistoryPoint {
  t: number;
  hpl: number | null;
  estimated: number | null;
  actual: number | null;
  gnssError: number | null;
  trust: number | null;
  mode: string;
  requirement: string;
  integrity: string;
  absoluteSources: number;
  speed: number | null;
  drDuration: number | null;
}

export interface TrailPoint {
  t: number;
  lat: number;
  lon: number;
}

interface LiveState {
  connection: ConnectionState;
  connectionError: string | null;
  lastFrameAt: number | null;
  navigation: NavigationOutput | null;
  scenario: ScenarioStatus | null;
  replay: ReplayStatus | null;
  /** The monitored fleet, updated on its own slower channel. */
  fleet: FleetSnapshot | null;
  activeAlarms: Alarm[];
  recentAlarms: Alarm[];
  history: LiveHistoryPoint[];
  trails: {
    fused: TrailPoint[];
    truth: TrailPoint[];
    gnss: TrailPoint[];
    radar: TrailPoint[];
    bathymetric: TrailPoint[];
    deadReckoning: TrailPoint[];
  };
  frameCount: number;
  muted: boolean;
}

const emptyTrails = (): LiveState['trails'] => ({
  fused: [],
  truth: [],
  gnss: [],
  radar: [],
  bathymetric: [],
  deadReckoning: []
});

const initialState: LiveState = {
  connection: 'idle',
  connectionError: null,
  lastFrameAt: null,
  navigation: null,
  scenario: null,
  replay: null,
  fleet: null,
  activeAlarms: [],
  recentAlarms: [],
  history: [],
  trails: emptyTrails(),
  frameCount: 0,
  muted: false
};

function pushTrail(list: TrailPoint[], point: TrailPoint | null) {
  if (!point) return;
  list.push(point);
  if (list.length > TRAIL_LIMIT) list.shift();
}

const liveSlice = createSlice({
  name: 'live',
  initialState,
  reducers: {
    connectionChanged(state, action: PayloadAction<{ state: ConnectionState; error?: string | null }>) {
      state.connection = action.payload.state;
      state.connectionError = action.payload.error ?? null;
    },

    navigationReceived(
      state,
      action: PayloadAction<{
        navigation: NavigationOutput;
        active_alarms?: Alarm[];
        scenario?: ScenarioStatus | null;
        replay?: ReplayStatus | null;
      }>
    ) {
      const nav = action.payload.navigation;
      // A frame from a run that has been reset arrives with a time earlier than
      // the one we hold; that is a new run, so the history starts again.
      if (state.navigation && nav.time_s < state.navigation.time_s - 0.5) {
        state.history = [];
        state.trails = emptyTrails();
      }
      state.navigation = nav;
      state.lastFrameAt = Date.now();
      state.frameCount += 1;
      if (action.payload.active_alarms) state.activeAlarms = action.payload.active_alarms;
      if (action.payload.scenario) state.scenario = action.payload.scenario;
      if (action.payload.replay) state.replay = action.payload.replay;

      state.history.push({
        t: nav.time_s,
        hpl: nav.integrity.horizontal_protection_level_m,
        estimated: nav.integrity.estimated_horizontal_error_m,
        actual: nav.actual_error_vs_truth_m,
        gnssError: nav.gnss?.error_vs_truth_m ?? null,
        trust: nav.gnss?.trust_score ?? null,
        mode: nav.navigation_mode,
        requirement: nav.integrity.requirement_status,
        integrity: nav.integrity.integrity_status,
        absoluteSources: nav.integrity.independent_absolute_sources,
        speed: nav.velocity?.speed_mps ?? null,
        drDuration: nav.integrity.dead_reckoning_duration_s
      });
      if (state.history.length > HISTORY_LIMIT) state.history.shift();

      pushTrail(
        state.trails.fused,
        nav.trusted_position ? { t: nav.time_s, lat: nav.trusted_position.latitude, lon: nav.trusted_position.longitude } : null
      );
      pushTrail(
        state.trails.truth,
        nav.ground_truth ? { t: nav.time_s, lat: nav.ground_truth.latitude, lon: nav.ground_truth.longitude } : null
      );
      pushTrail(
        state.trails.gnss,
        nav.gnss?.reported_position
          ? { t: nav.time_s, lat: nav.gnss.reported_position.latitude, lon: nav.gnss.reported_position.longitude }
          : null
      );
      const radar = nav.localization?.radar;
      pushTrail(
        state.trails.radar,
        radar?.valid && radar.latitude != null && radar.longitude != null
          ? { t: nav.time_s, lat: radar.latitude, lon: radar.longitude }
          : null
      );
      const bathy = nav.localization?.bathymetric;
      pushTrail(
        state.trails.bathymetric,
        bathy?.valid && bathy.latitude != null && bathy.longitude != null
          ? { t: nav.time_s, lat: bathy.latitude, lon: bathy.longitude }
          : null
      );
      const dr = nav.localization?.dead_reckoning;
      pushTrail(state.trails.deadReckoning, dr ? { t: nav.time_s, lat: dr.latitude, lon: dr.longitude } : null);
    },

    alarmReceived(state, action: PayloadAction<Alarm>) {
      state.recentAlarms.unshift(action.payload);
      if (state.recentAlarms.length > 200) state.recentAlarms.pop();
      if (!state.activeAlarms.some((a) => a.id === action.payload.id)) {
        state.activeAlarms.unshift(action.payload);
      }
    },

    alarmCleared(state, action: PayloadAction<{ id: string }>) {
      state.activeAlarms = state.activeAlarms.filter((a) => a.id !== action.payload.id);
    },

    alarmAcknowledgedLocally(state, action: PayloadAction<string>) {
      const stamp = new Date().toISOString();
      for (const list of [state.activeAlarms, state.recentAlarms]) {
        const found = list.find((a) => a.id === action.payload);
        if (found) found.acknowledged_at = stamp;
      }
    },

    allAlarmsAcknowledgedLocally(state) {
      const stamp = new Date().toISOString();
      for (const a of state.activeAlarms) if (!a.acknowledged_at) a.acknowledged_at = stamp;
      for (const a of state.recentAlarms) if (!a.acknowledged_at) a.acknowledged_at = stamp;
    },

    scenarioStateReceived(state, action: PayloadAction<ScenarioStatus>) {
      state.scenario = action.payload;
    },

    fleetReceived(state, action: PayloadAction<FleetSnapshot>) {
      state.fleet = action.payload;
    },
    replayStateReceived(state, action: PayloadAction<ReplayStatus>) {
      state.replay = action.payload;
    },

    liveReset(state) {
      state.navigation = null;
      state.history = [];
      state.trails = emptyTrails();
      state.activeAlarms = [];
      state.recentAlarms = [];
      state.frameCount = 0;
    },

    mutedToggled(state) {
      state.muted = !state.muted;
    }
  }
});

export const {
  connectionChanged,
  navigationReceived,
  alarmReceived,
  alarmCleared,
  alarmAcknowledgedLocally,
  allAlarmsAcknowledgedLocally,
  scenarioStateReceived,
  replayStateReceived,
  fleetReceived,
  liveReset,
  mutedToggled
} = liveSlice.actions;

export default liveSlice.reducer;
