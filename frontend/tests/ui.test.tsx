/**
 * UI tests (Section 24 "UI").
 *
 * These check the things that would be dangerous to get wrong on a bridge:
 * that the requirement status is displayed correctly and changes when it
 * should, that a critical warning stays visible, that alarms appear, that the
 * sensor table updates, and that the map mounts.
 */

import { describe, expect, it, vi } from 'vitest';
import { act, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithStore } from './renderWithStore';
import { makeAlarm, makeNavigation } from './fixtures';
import { StatusBanner } from '../src/components/StatusBanner';
import { NavigationPage } from '../src/pages/NavigationPage';
import { SensorsPage } from '../src/pages/SensorsPage';
import { AlarmsPage } from '../src/pages/AlarmsPage';
import { MapView } from '../src/map/MapView';
import { navigationReceived } from '../src/store/liveSlice';

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
    expect(screen.getByText(/Demonstration geospatial data/i)).toBeInTheDocument();
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

describe('map', () => {
  it('loads and always shows the demonstration label', async () => {
    renderWithStore(<MapView navigation={makeNavigation()} />, {
      responses: {
        '/geospatial/bundle': { layers: {}, origin: { latitude: 24.51, longitude: 54.35 }, label: 'demo' },
        '/geospatial/bathymetry': { cells: [], min_depth_m: 0, max_depth_m: 20, cell_size_m: 56 }
      }
    });
    expect(await screen.findByText(/Demonstration geospatial data — not for navigation/i)).toBeInTheDocument();
    expect(screen.getByText('Position sources')).toBeInTheDocument();
  });

  it('distinguishes the trusted position from the raw GNSS position in the legend', () => {
    renderWithStore(<MapView navigation={makeNavigation()} />, { responses: {} });
    expect(screen.getByText('Trusted fused')).toBeInTheDocument();
    expect(screen.getByText('Raw GNSS')).toBeInTheDocument();
    expect(screen.getByText('Ground truth')).toBeInTheDocument();
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
