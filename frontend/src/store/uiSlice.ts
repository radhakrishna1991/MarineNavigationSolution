/** Interface preferences and transient notifications. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { applyTheme, resolveTheme, type ThemePreference } from '../theme/theme';

const PREF_KEY = 'amnp.preferences';

export interface MapLayerVisibility {
  bathymetry: boolean;
  contours: boolean;
  land: boolean;
  operatingArea: boolean;
  noGo: boolean;
  channel: boolean;
  radarFeatures: boolean;
  controlPoints: boolean;
  route: boolean;
  trails: boolean;
  groundTruth: boolean;
  gnssPosition: boolean;
  sensorPositions: boolean;
  protectionCircle: boolean;
  confidenceEllipse: boolean;
  aisContacts: boolean;
}

export interface Toast {
  id: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  detail?: string;
  createdAt: number;
}

interface UiState {
  sidebarCollapsed: boolean;
  mapLayers: MapLayerVisibility;
  mapFollowVessel: boolean;
  units: 'metric' | 'nautical';
  toasts: Toast[];
  selectedRunId: string | null;
  demoPanelOpen: boolean;
  reducedMotion: boolean;
  /**
   * Light is the default: most of the time this platform is read in an office,
   * an operations room or a briefing rather than on a darkened bridge. Dark is
   * one click away and remains the palette for night watchkeeping, where a
   * light screen destroys the operator's dark adaptation.
   */
  theme: ThemePreference;
}

const defaultLayers: MapLayerVisibility = {
  bathymetry: true,
  contours: true,
  land: true,
  operatingArea: true,
  noGo: true,
  channel: true,
  radarFeatures: true,
  controlPoints: false,
  route: true,
  trails: true,
  groundTruth: true,
  gnssPosition: true,
  sensorPositions: true,
  protectionCircle: true,
  confidenceEllipse: true,
  aisContacts: false
};

function loadPreferences(): Partial<UiState> {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? (JSON.parse(raw) as Partial<UiState>) : {};
  } catch {
    return {};
  }
}

function persistPreferences(state: UiState) {
  try {
    localStorage.setItem(
      PREF_KEY,
      JSON.stringify({
        sidebarCollapsed: state.sidebarCollapsed,
        mapLayers: state.mapLayers,
        mapFollowVessel: state.mapFollowVessel,
        units: state.units,
        reducedMotion: state.reducedMotion,
        theme: state.theme
      })
    );
  } catch {
    // Preferences are a convenience; failing to store them is not an error.
  }
}

const stored = loadPreferences();

const initialState: UiState = {
  sidebarCollapsed: stored.sidebarCollapsed ?? false,
  mapLayers: { ...defaultLayers, ...(stored.mapLayers ?? {}) },
  mapFollowVessel: stored.mapFollowVessel ?? true,
  units: stored.units ?? 'metric',
  toasts: [],
  selectedRunId: null,
  demoPanelOpen: false,
  reducedMotion: stored.reducedMotion ?? false,
  theme: stored.theme ?? 'light'
};

let toastCounter = 0;

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    sidebarToggled(state) {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      persistPreferences(state);
    },
    mapLayerToggled(state, action: PayloadAction<keyof MapLayerVisibility>) {
      state.mapLayers[action.payload] = !state.mapLayers[action.payload];
      persistPreferences(state);
    },
    mapLayersSet(state, action: PayloadAction<Partial<MapLayerVisibility>>) {
      state.mapLayers = { ...state.mapLayers, ...action.payload };
      persistPreferences(state);
    },
    followVesselToggled(state) {
      state.mapFollowVessel = !state.mapFollowVessel;
      persistPreferences(state);
    },
    unitsChanged(state, action: PayloadAction<'metric' | 'nautical'>) {
      state.units = action.payload;
      persistPreferences(state);
    },
    reducedMotionToggled(state) {
      state.reducedMotion = !state.reducedMotion;
      persistPreferences(state);
    },
    themeChanged(state, action: PayloadAction<ThemePreference>) {
      state.theme = action.payload;
      persistPreferences(state);
      // Applied here rather than in a component effect so the document updates
      // in the same tick as the click, with no intermediate frame in the old
      // palette.
      applyTheme(resolveTheme(action.payload), { animate: true });
    },
    runSelected(state, action: PayloadAction<string | null>) {
      state.selectedRunId = action.payload;
    },
    demoPanelToggled(state, action: PayloadAction<boolean | undefined>) {
      state.demoPanelOpen = action.payload ?? !state.demoPanelOpen;
    },
    toastAdded: {
      reducer(state, action: PayloadAction<Toast>) {
        state.toasts.push(action.payload);
        if (state.toasts.length > 5) state.toasts.shift();
      },
      prepare(severity: Toast['severity'], title: string, detail?: string) {
        toastCounter += 1;
        return {
          payload: { id: `toast-${toastCounter}-${Date.now()}`, severity, title, detail, createdAt: Date.now() }
        };
      }
    },
    toastDismissed(state, action: PayloadAction<string>) {
      state.toasts = state.toasts.filter((t) => t.id !== action.payload);
    }
  }
});

export const {
  sidebarToggled,
  mapLayerToggled,
  mapLayersSet,
  followVesselToggled,
  unitsChanged,
  reducedMotionToggled,
  themeChanged,
  runSelected,
  demoPanelToggled,
  toastAdded,
  toastDismissed
} = uiSlice.actions;

export default uiSlice.reducer;
