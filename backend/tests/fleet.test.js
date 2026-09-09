/**
 * Fleet monitoring tests.
 *
 * The property that matters is independence. If two vessels shared any state -
 * a filter, a trust assessment, an integrity calculation - then one vessel
 * being attacked would corrupt the answer for another, and a fleet display
 * would be worse than no display at all. These check that they do not.
 */

import { FleetService } from '../src/services/fleetService.js';
import { fleetConfig, getScenarioDefinition } from '../src/config/index.js';
import { buildEnvironment } from '../src/geospatial/environment.js';

/**
 * A fleet of exactly these vessels, with no startup stagger.
 *
 * `loadProfiles` is the seam: it is where the service decides between the
 * database and the configured fallback, so stubbing it is what keeps these
 * tests independent of whatever the database happens to hold.
 */
function quickFleet(vessels) {
  const service = new FleetService();
  const profiles = vessels.map((v) => ({ ...v, start_offset_s: 0 }));
  service.loadProfiles = async () => profiles;
  return service;
}

const HEALTHY = { id: 'T_HEALTHY', name: 'Test Healthy', type: 'Survey', scenario: 'SCN_01_HEALTHY' };
const SPOOFED = { id: 'T_SPOOFED', name: 'Test Spoofed', type: 'Survey', scenario: 'SCN_03_GRADUAL_DRAG' };

describe('fleet configuration', () => {
  it('declares vessels that reference real scenarios', () => {
    const vessels = fleetConfig?.vessels ?? [];
    expect(vessels.length).toBeGreaterThan(1);
    for (const vessel of vessels) {
      expect(getScenarioDefinition(vessel.scenario)).toBeTruthy();
    }
  });

  it('gives every vessel a unique identity', () => {
    const ids = (fleetConfig?.vessels ?? []).map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    const mmsis = (fleetConfig?.vessels ?? []).map((v) => v.mmsi).filter(Boolean);
    expect(new Set(mmsis).size).toBe(mmsis.length);
  });

  it('nominates exactly one focused vessel', () => {
    // The focused vessel is the one the detail screens and the recorder follow.
    // Two would make "the current run" ambiguous.
    const focused = (fleetConfig?.vessels ?? []).filter((v) => v.focused);
    expect(focused).toHaveLength(1);
  });
});

describe('fleet service', () => {
  it('runs an independent pipeline for every vessel', async () => {
    const service = quickFleet([HEALTHY, SPOOFED]);
    await service.start();
    service.tick();

    const vessels = [...service.vessels.values()];
    expect(vessels).toHaveLength(2);

    // No *mutable* state may be shared. Sharing an engine, a pipeline, a
    // filter or a vessel model would let one vessel's attack contaminate
    // another vessel's answer.
    expect(vessels[0].engine).not.toBe(vessels[1].engine);
    expect(vessels[0].engine.pipeline).not.toBe(vessels[1].engine.pipeline);
    expect(vessels[0].engine.pipeline.fusion).not.toBe(vessels[1].engine.pipeline.fusion);
    expect(vessels[0].engine.vessel).not.toBe(vessels[1].engine.vessel);
    expect(vessels[0].engine.rng).not.toBe(vessels[1].engine.rng);

    // The environment is deliberately shared: it is read-only reference data -
    // the depth grid, the shoreline, the planned route - and building a copy
    // per vessel would cost megabytes for no benefit.
    expect(vessels[0].engine.environment).toBe(vessels[1].engine.environment);

    service.stop();
  });

  it('reaches a different verdict for a spoofed vessel than a healthy one', async () => {
    const service = quickFleet([HEALTHY, SPOOFED]);
    await service.start();

    // Past the point where the drag scenario's spoofing is established.
    for (const vessel of service.vessels.values()) {
      let remaining = 260;
      while (remaining > 0) {
        vessel.engine.advance(Math.min(20, remaining));
        remaining -= 20;
      }
      vessel.output = vessel.engine.pipeline.lastOutput ?? vessel.output;
    }
    service.tick();

    const snapshot = service.snapshot();
    const healthy = snapshot.vessels.find((v) => v.vessel_id === 'T_HEALTHY');
    const spoofed = snapshot.vessels.find((v) => v.vessel_id === 'T_SPOOFED');

    expect(healthy.gnss_spoofing_suspected).toBe(false);
    expect(spoofed.gnss_spoofing_suspected).toBe(true);
    // The healthy vessel must be entirely unaffected by its neighbour.
    expect(healthy.excluded_sensors).not.toContain('GNSS_01');

    service.stop();
  });

  it('summarises a vessel with everything the fleet display needs', async () => {
    const service = quickFleet([HEALTHY]);
    await service.start();
    service.tick();

    const [vessel] = service.snapshot().vessels;
    for (const field of [
      'vessel_id',
      'name',
      'position',
      'heading_deg',
      'navigation_mode',
      'requirement_status',
      'integrity_status',
      'horizontal_protection_level_m',
      'gnss_trust_score',
      'contributing_sensors',
      'excluded_sensors'
    ]) {
      expect(vessel).toHaveProperty(field);
    }
    expect(vessel.vessel_id).toBe('T_HEALTHY');

    service.stop();
  });

  it('counts the fleet by the states an operations room acts on', async () => {
    const service = quickFleet([HEALTHY, SPOOFED]);
    await service.start();
    service.tick();

    const { counts } = service.snapshot();
    expect(counts.total).toBe(2);
    expect(
      counts.requirement_met + counts.requirement_at_risk + counts.requirement_not_met
    ).toBeLessThanOrEqual(counts.total);

    service.stop();
  });

  it('gives each vessel its own working area rather than one shared track', async () => {
    // Vessels running the identical route stack on top of each other and the
    // fleet display shows a single dot.
    const service = quickFleet([
      { ...HEALTHY, station_offset: { east_m: 0, north_m: 0 } },
      { ...HEALTHY, id: 'T_OFFSET', name: 'Test Offset', station_offset: { east_m: 1200, north_m: -800 } }
    ]);
    await service.start();
    service.tick();

    const [a, b] = [...service.vessels.values()];
    const first = a.engine.environment.routeWaypoints[0];
    const second = b.engine.environment.routeWaypoints[0];
    expect(second.e - first.e).toBeCloseTo(1200, 6);
    expect(second.n - first.n).toBeCloseTo(-800, 6);

    // The offset must not reach the shared environment. Mutating the memoised
    // route in place would move every other vessel in the fleet, and the
    // focused vessel with them.
    const shared = buildEnvironment();
    expect(shared.routeWaypoints[0].e).toBe(first.e);
    expect(shared.routeWaypoints[0].n).toBe(first.n);

    service.stop();
  });

  it('stops cleanly and releases every vessel', async () => {
    const service = quickFleet([HEALTHY, SPOOFED]);
    await service.start();
    expect(service.vessels.size).toBe(2);

    service.stop();
    expect(service.running).toBe(false);
    expect(service.vessels.size).toBe(0);
    // Ticking after a stop must be a no-op rather than an exception.
    expect(() => service.tick()).not.toThrow();
  });

  it('survives one vessel failing without stopping the rest', async () => {
    const service = quickFleet([HEALTHY, SPOOFED]);
    await service.start();

    const [broken, healthy] = [...service.vessels.values()];
    // Let the healthy vessel establish a solution first - the filter publishes
    // nothing until it has been seeded with a position and a heading.
    healthy.engine.advance(30);
    broken.engine.advance = () => {
      throw new Error('simulated vessel fault');
    };

    expect(() => service.tick()).not.toThrow();
    // The surviving vessel still produced a solution.
    expect(healthy.output).toBeTruthy();

    service.stop();
  });
});
