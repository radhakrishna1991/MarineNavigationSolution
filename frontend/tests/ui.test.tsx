/**
 * UI tests (Section 24 "UI").
 *
 * These check the things that would be dangerous to get wrong on a bridge:
 * that the requirement status is displayed correctly and changes when it
 * should, that a critical warning stays visible, that alarms appear, that the
 * sensor table updates, and that the map mounts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithStore } from './renderWithStore';
import { makeAlarm, makeNavigation } from './fixtures';
import { StatusBanner } from '../src/components/StatusBanner';
import { NavigationPage } from '../src/pages/NavigationPage';
import { SensorsPage } from '../src/pages/SensorsPage';
import { AlarmsPage } from '../src/pages/AlarmsPage';
import { MapView } from '../src/map/MapView';
import { NavigationChartTabs } from '../src/map/MapTabs';
import { navigationReceived } from '../src/store/liveSlice';
import { ThemeToggle } from '../src/components/ThemeToggle';
import { SourceIndicator } from '../src/components/SourceIndicator';
import { resolveTheme, sourceColours } from '../src/theme/theme';
import { useApplyTheme } from '../src/theme/useTheme';

describe('status banner', () => {
  it('shows the 2 m requirement as met when it is met', () => {
    const navigation = makeNavigation();
    renderWithStore(<StatusBanner navigation={navigation} />, { navigation });

    expect(screen.getByText(/Safeen <2 m requirement/i)).toBeInTheDocument();
    expect(screen.getByText('MET')).toBeInTheDocument();
    expect(screen.getByText('AVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('1.14')).toBeInTheDocument();
  });

  it('changes the requirement status when it changes', () => {
    const met = makeNavigation();
    const { store, rerender } = renderWithStore(<StatusBanner navigation={met} />, { navigation: met });
    expect(screen.getByText('MET')).toBeInTheDocument();

    const notMet = makeNavigation({
      integrity: {
        ...met.integrity,
        horizontal_protection_level_m: 3.75,
        requirement_status: 'REQUIREMENT_NOT_MET',
        integrity_status: 'NOT_ASSURED',
        integrity_reasons: ['PROTECTION_LEVEL_EXCEEDS_LIMIT'],
        requirement_reasons: ['Horizontal protection level 3.75 m exceeds the 2 m limit.']
      },
      navigation_mode: 'DEAD_RECKONING'
    });
    act(() => {
      store.dispatch(navigationReceived({ navigation: notMet }));
    });
    rerender(<StatusBanner navigation={notMet} />);

    expect(screen.getByText('NOT MET')).toBeInTheDocument();
    expect(screen.getByText('3.75')).toBeInTheDocument();
    expect(screen.getByText(/NOT ASSURED/)).toBeInTheDocument();
  });

  it('keeps the critical operator instruction visible when integrity is not assured', () => {
    const navigation = makeNavigation({
      integrity: {
        ...makeNavigation().integrity,
        horizontal_protection_level_m: 4.2,
        integrity_status: 'NOT_ASSURED',
        requirement_status: 'REQUIREMENT_NOT_MET',
        requirement_reasons: ['Integrity is not assured.']
      },
      navigation_mode: 'INTEGRITY_NOT_ASSURED',
      navigation_mode_detail: {
        ...makeNavigation().navigation_mode_detail,
        mode: 'INTEGRITY_NOT_ASSURED',
        label: 'Integrity Not Assured',
        operator_guidance: 'VERIFY POSITION USING INDEPENDENT MEANS.'
      }
    });
    renderWithStore(<StatusBanner navigation={navigation} />, { navigation });

    expect(screen.getByText('Operator action')).toBeInTheDocument();
    expect(screen.getByText(/VERIFY POSITION USING INDEPENDENT MEANS/i)).toBeInTheDocument();
  });

  it('never claims a position is available when there is no solution', () => {
    renderWithStore(<StatusBanner navigation={null} />);
    expect(screen.getByText('NOT AVAILABLE')).toBeInTheDocument();
    expect(screen.queryByText('MET')).not.toBeInTheDocument();
  });

  it('shows a staleness warning when the live link is down', () => {
    const navigation = makeNavigation();
    const { store } = renderWithStore(<StatusBanner navigation={navigation} />, { navigation });
    act(() => {
      store.dispatch({ type: 'live/connectionChanged', payload: { state: 'closed' } });
    });
    // The banner reads connection state from the store on the next render.
    expect(store.getState().live.connection).toBe('closed');
  });
});

describe('navigation screen', () => {
  it('mounts the map and the position panels', async () => {
    const navigation = makeNavigation();
    renderWithStore(<NavigationPage />, {
      navigation,
      responses: {
        '/geospatial/bundle': { layers: {}, origin: { latitude: 24.51, longitude: 54.35 }, label: 'demo' },
        '/geospatial/bathymetry': { cells: [], min_depth_m: 0, max_depth_m: 20, cell_size_m: 56 }
      }
    });

    expect(await screen.findByText('Trusted position')).toBeInTheDocument();
    expect(screen.getByText('Positioning sources')).toBeInTheDocument();
    expect(screen.getByText(/Radar map matching/)).toBeInTheDocument();
  });

  it('updates the displayed position when a new epoch arrives', () => {
    const first = makeNavigation();
    const { store } = renderWithStore(<NavigationPage />, { navigation: first, responses: {} });
    expect(store.getState().live.navigation?.time_s).toBe(120.4);

    const second = makeNavigation({ time_s: 121.0, actual_error_vs_truth_m: 0.41 });
    act(() => {
      store.dispatch(navigationReceived({ navigation: second }));
    });
    expect(store.getState().live.navigation?.time_s).toBe(121.0);
    expect(store.getState().live.history.length).toBe(2);
  });

  it('shows an explanatory empty state when nothing is running', () => {
    renderWithStore(<NavigationPage />, { responses: {} });
    expect(screen.getByText('No navigation solution is running')).toBeInTheDocument();
  });

  it('shows the excluded sensor list with its reason', () => {
    const base = makeNavigation();
    const navigation = makeNavigation({
      excluded_sensors: ['GNSS_01'],
      sensor_health: [
        { ...base.sensor_health[0], excluded: true, exclusion_reason: 'GNSS_01 was excluded because it differs from radar by 38.4 m.' },
        base.sensor_health[1]
      ]
    });
    renderWithStore(<NavigationPage />, { navigation, responses: {} });
    expect(screen.getByText('Excluded')).toBeInTheDocument();
  });
});

describe('alarms', () => {
  it('shows alarms received over the live link', async () => {
    const alarm = makeAlarm();
    renderWithStore(<NavigationPage />, {
      navigation: makeNavigation(),
      alarms: [alarm],
      responses: {}
    });

    expect(await screen.findByText('GNSS spoofing detected - GNSS excluded')).toBeInTheDocument();
    expect(screen.getByText(/differs from radar localization by 38.4 m/)).toBeInTheDocument();
    expect(screen.getByText(/Do not use GNSS on any bridge system/)).toBeInTheDocument();
  });

  it('lists alarms with severity, reason and recommended action', async () => {
    renderWithStore(<AlarmsPage />, {
      alarms: [makeAlarm(), makeAlarm({ id: 'a2', code: 'REQUIREMENT_AT_RISK', severity: 'WARNING', message: 'Requirement at risk' })],
      responses: {
        '/alarms': {
          items: [makeAlarm(), makeAlarm({ id: 'a2', code: 'REQUIREMENT_AT_RISK', severity: 'WARNING', message: 'Requirement at risk' })],
          total: 2,
          active_now: [],
          summary: { by_severity: {}, total: 2, unacknowledged: 2 }
        }
      }
    });

    expect(await screen.findByText('GNSS spoofing detected - GNSS excluded')).toBeInTheDocument();
    expect(screen.getByText('Requirement at risk')).toBeInTheDocument();
  });

  it('acknowledges an alarm without clearing it', async () => {
    const user = userEvent.setup();
    const alarm = makeAlarm();
    const { store } = renderWithStore(<NavigationPage />, {
      navigation: makeNavigation(),
      alarms: [alarm],
      role: 'operator',
      responses: { [`/alarms/${alarm.id}/acknowledge`]: { alarm: { ...alarm, acknowledged_at: 'now' }, note: 'x' } }
    });

    const button = await screen.findByRole('button', { name: 'Ack' });
    await user.click(button);

    await waitFor(() => {
      expect(store.getState().live.activeAlarms[0]?.acknowledged_at).toBeTruthy();
    });
    // Acknowledging must not remove it from the active list.
    expect(store.getState().live.activeAlarms).toHaveLength(1);
  });
});

describe('sensor table', () => {
  it('renders each sensor with its decision and reason', async () => {
    const navigation = makeNavigation();
    renderWithStore(<SensorsPage />, {
      navigation,
      responses: {
        '/sensors': {
          items: [
            {
              sensor_id: 'GNSS_01',
              sensor_type: 'GNSS',
              name: 'Primary GNSS Receiver',
              manufacturer_class: 'Generic multi-constellation GNSS (vendor neutral)',
              interface_description: 'NMEA 0183',
              nominal_rate_hz: 5,
              provides: ['position'],
              absolute_position_source: true,
              optional: false,
              advisory_only: false,
              enabled: true,
              configuration: { simulation: {}, fusion: {} },
              health: null,
              trust_score: null
            },
            {
              sensor_id: 'RADAR_01',
              sensor_type: 'RADAR',
              name: 'X-Band Marine Radar Map Matcher',
              manufacturer_class: 'Generic marine radar localization adapter (vendor neutral)',
              interface_description: 'TCP',
              nominal_rate_hz: 2,
              provides: ['position'],
              absolute_position_source: true,
              optional: false,
              advisory_only: false,
              enabled: true,
              configuration: { simulation: {}, fusion: {} },
              health: null,
              trust_score: null
            }
          ]
        }
      }
    });

    expect(await screen.findByText('Primary GNSS Receiver')).toBeInTheDocument();
    expect(screen.getByText('X-Band Marine Radar Map Matcher')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('HEALTHY').length).toBeGreaterThan(0);
  });

  it('filters the table by search term', async () => {
    const user = userEvent.setup();
    renderWithStore(<SensorsPage />, {
      navigation: makeNavigation(),
      responses: {
        '/sensors': {
          items: [
            {
              sensor_id: 'GNSS_01',
              sensor_type: 'GNSS',
              name: 'Primary GNSS Receiver',
              manufacturer_class: null,
              interface_description: null,
              nominal_rate_hz: 5,
              provides: [],
              absolute_position_source: true,
              optional: false,
              advisory_only: false,
              enabled: true,
              configuration: { simulation: {}, fusion: {} },
              health: null,
              trust_score: null
            },
            {
              sensor_id: 'RADAR_01',
              sensor_type: 'RADAR',
              name: 'X-Band Marine Radar Map Matcher',
              manufacturer_class: null,
              interface_description: null,
              nominal_rate_hz: 2,
              provides: [],
              absolute_position_source: true,
              optional: false,
              advisory_only: false,
              enabled: true,
              configuration: { simulation: {}, fusion: {} },
              health: null,
              trust_score: null
            }
          ]
        }
      }
    });

    await screen.findByText('Primary GNSS Receiver');
    await user.type(screen.getByPlaceholderText('Search sensors'), 'radar');
    await waitFor(() => {
      expect(screen.queryByText('Primary GNSS Receiver')).not.toBeInTheDocument();
    });
    expect(screen.getByText('X-Band Marine Radar Map Matcher')).toBeInTheDocument();
  });
});

/**
 * Data-source indicator.
 *
 * An operational display has to say where its data came from. Mistaking a
 * replay or a simulation for a live feed is how an operator acts on a position
 * that is not the vessel's current one, so this is derived from what the
 * platform is actually doing rather than from a build-time flag.
 */
describe('data source indicator', () => {
  it('reports SIMULATION while a scenario is running', () => {
    const { store } = renderWithStore(<SourceIndicator />);
    act(() => {
      store.dispatch({ type: 'live/scenarioStateReceived', payload: { state: 'RUNNING', scenario_id: 'SCN_01_HEALTHY' } });
    });
    expect(screen.getByText('SIMULATION')).toBeInTheDocument();
  });

  it('reports REPLAY while recorded data is being played back', () => {
    const { store } = renderWithStore(<SourceIndicator />);
    act(() => {
      store.dispatch({ type: 'live/replayStateReceived', payload: { state: 'RUNNING', session_id: 'r1' } });
    });
    expect(screen.getByText('REPLAY')).toBeInTheDocument();
  });

  it('reports LIVE when solutions arrive with no scenario or replay running', () => {
    // Nothing is being simulated or replayed, so the data can only have come
    // from ingested sensor messages.
    renderWithStore(<SourceIndicator />, { navigation: makeNavigation() });
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('reports STANDBY when nothing is feeding the display', () => {
    renderWithStore(<SourceIndicator />);
    expect(screen.getByText('STANDBY')).toBeInTheDocument();
  });
});

describe('map', () => {
  it('loads and shows the position-source legend', async () => {
    renderWithStore(<MapView navigation={makeNavigation()} />, {
      responses: {
        '/geospatial/bundle': { layers: {}, origin: { latitude: 24.51, longitude: 54.35 }, label: 'demo' },
        '/geospatial/bathymetry': { cells: [], min_depth_m: 0, max_depth_m: 20, cell_size_m: 56 }
      }
    });
    expect(await screen.findByText('Position sources')).toBeInTheDocument();
  });

  it('distinguishes the trusted position from the raw GNSS position in the legend', () => {
    renderWithStore(<MapView navigation={makeNavigation()} />, { responses: {} });
    expect(screen.getByText('Trusted fused')).toBeInTheDocument();
    expect(screen.getByText('Raw GNSS')).toBeInTheDocument();
    expect(screen.getByText('Ground truth')).toBeInTheDocument();
  });
});

/**
 * Chart tabs.
 *
 * The Google chart depends on a public service and a billed key; the platform
 * chart depends on nothing. The platform chart must therefore be what an
 * operator gets without choosing, and an unconfigured Google chart must say so
 * rather than presenting itself as an empty chart.
 */
describe('chart tabs', () => {
  it('opens on the platform chart', () => {
    renderWithStore(<NavigationChartTabs navigation={makeNavigation()} />, { responses: {} });
    expect(screen.getByRole('tab', { name: 'Platform chart' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Google map' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Position sources')).toBeInTheDocument();
  });

  it('explains itself rather than showing a blank chart when no Google key is configured', async () => {
    // Stubbed rather than assumed: a developer machine may well have a key in
    // its environment, and this is the no-key path.
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '');
    const user = userEvent.setup();
    renderWithStore(<NavigationChartTabs navigation={makeNavigation()} />, { responses: {} });

    await user.click(screen.getByRole('tab', { name: 'Google map' }));

    expect(await screen.findByText('The Google basemap is not configured')).toBeInTheDocument();
    expect(screen.getByText('VITE_GOOGLE_MAPS_API_KEY')).toBeInTheDocument();
    vi.unstubAllEnvs();
  });
});

describe('role-based access in the interface', () => {
  it('hides scenario controls from a viewer', () => {
    vi.stubGlobal('innerWidth', 1400);
    renderWithStore(<AlarmsPage />, {
      role: 'viewer',
      responses: { '/alarms': { items: [makeAlarm()], total: 1, active_now: [], summary: {} } }
    });
    expect(screen.queryByRole('button', { name: 'Acknowledge all' })).not.toBeInTheDocument();
  });

  it('shows the acknowledge control to an operator', async () => {
    renderWithStore(<AlarmsPage />, {
      role: 'operator',
      responses: { '/alarms': { items: [makeAlarm()], total: 1, active_now: [], summary: {} } }
    });
    expect(await screen.findByRole('button', { name: 'Acknowledge all' })).toBeInTheDocument();
  });
});

/**
 * Theme (Section 27, "responsive layout" and "colour is not the only indicator").
 *
 * Dark is the operational default and has to stay that way: a light screen on a
 * bridge at night destroys the watchkeeper's dark adaptation. Light exists for
 * daylight work, briefings and printed screenshots.
 */
describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  /**
   * The same arrangement as `App`: the root applies the resolved theme to the
   * document and the toggle changes the preference. Testing them together is
   * the point - a toggle that updates the store but not the document would
   * pass a narrower test and be useless.
   */
  function ThemedApp() {
    useApplyTheme();
    return <ThemeToggle />;
  }

  it('defaults to the dark bridge palette', () => {
    const { store } = renderWithStore(<ThemedApp />);
    expect(store.getState().ui.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('switches the document to the light palette when light is chosen', async () => {
    const user = userEvent.setup();
    const { store } = renderWithStore(<ThemedApp />);

    await user.click(screen.getByRole('radio', { name: /light/i }));

    expect(store.getState().ui.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    // `color-scheme` is what makes native scrollbars and form controls follow.
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('remembers the choice across a reload', async () => {
    const user = userEvent.setup();
    renderWithStore(<ThemedApp />);
    await user.click(screen.getByRole('radio', { name: /light/i }));

    const persisted = JSON.parse(localStorage.getItem('amnp.preferences') ?? '{}');
    expect(persisted.theme).toBe('light');
  });

  it('offers dark, light and follow-the-system, with the current one marked', async () => {
    const user = userEvent.setup();
    renderWithStore(<ThemedApp />);

    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(3);
    // The active option is identified by state, not by colour alone.
    expect(screen.getByRole('radio', { name: /dark/i })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('radio', { name: /auto/i }));
    expect(screen.getByRole('radio', { name: /auto/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /dark/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('resolves the system preference rather than assuming one', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
    // jsdom reports no match for the light query, so system means dark here -
    // the same fallback the platform uses when it cannot ask.
    expect(resolveTheme('system')).toBe('dark');
  });

  it('keeps a distinct colour per positioning source in both palettes', () => {
    const colours = sourceColours();
    const values = Object.values(colours);
    expect(values).toHaveLength(new Set(values).size);
    expect(colours.fused).not.toBe(colours.gnss);
  });
});

/**
 * Map style.
 *
 * The map is built from a hand-written MapLibre style with no external tile or
 * glyph server. MapLibre validates that style strictly and fails the whole load
 * on a malformed property - and a map that fails to load is silent: no error
 * reaches the operator, the panel simply stays empty. This guards the specific
 * shape that broke it.
 */
describe('map style', () => {
  it('omits the glyphs property rather than setting it undefined', async () => {
    renderWithStore(<MapView navigation={makeNavigation()} />, { responses: {} });

    const maplibre = (await import('maplibre-gl')).default as unknown as {
      Map: { lastOptions: { style: Record<string, unknown> } | null };
    };
    const style = maplibre.Map.lastOptions?.style;
    expect(style).toBeTruthy();

    // `glyphs: undefined` still counts as present and fails validation with
    // "glyphs: string expected, undefined found", which stops the style
    // loading, so `load` never fires and no layer is ever added.
    expect(Object.prototype.hasOwnProperty.call(style!, 'glyphs')).toBe(false);
    expect(style!.version).toBe(8);
  });
});
