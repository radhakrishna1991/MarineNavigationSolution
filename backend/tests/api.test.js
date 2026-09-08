/**
 * API integration tests (Sections 19 and 22).
 *
 * These exercise the real Express app against the real database. The suite
 * skips itself, loudly, if the database is unreachable, so the engine tests
 * stay runnable anywhere while the API tests still get run where they can be.
 */

import request from 'supertest';
import { createApp } from '../src/app.js';
import { checkConnection, closePool, query } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { env } from '../src/config/index.js';
import { scenarioService } from '../src/services/scenarioService.js';
import { replayService } from '../src/services/replayService.js';
import { recorder } from '../src/services/recorder.js';

let app;
let adminToken = null;
let viewerToken = null;

/**
 * The database probe has to run at module scope, not in `beforeAll`.
 * Jest evaluates every `describe` block during collection, which happens before
 * any hook runs, so a flag set in `beforeAll` would always still be false and
 * the whole suite would silently skip itself - passing while testing nothing.
 */
let databaseAvailable = false;
try {
  await checkConnection();
  databaseAvailable = true;
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[api.test] Database unreachable (${err.code ?? err.message}) - API integration tests skipped.` +
      '\n           Start PostgreSQL and set PGHOST/PGUSER/PGPASSWORD to run them.\n'
  );
}

const describeIfDb = (...args) => (databaseAvailable ? describe(...args) : describe.skip(...args));

beforeAll(async () => {
  if (!databaseAvailable) return;
  await migrate({ drop: false });
  await seed({ migrateFirst: false });
  app = createApp();

  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: env.seed.adminPassword });
  adminToken = login.body.token;

  const viewerLogin = await request(app)
    .post('/api/auth/login')
    .send({ username: 'viewer', password: env.seed.demoPassword });
  viewerToken = viewerLogin.body.token;
}, 180000);

afterAll(async () => {
  if (!databaseAvailable) return;
  await scenarioService.stop().catch(() => {});
  await replayService.stop().catch(() => {});
  await recorder.stop().catch(() => {});
  await closePool().catch(() => {});
}, 60000);

const auth = (token) => (req) => req.set('Authorization', `Bearer ${token}`);

describeIfDb('health and discovery', () => {
  it('reports health without authentication', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.database.ok).toBe(true);
  });

  it('describes itself, including that it has no control outputs', async () => {
    const response = await request(app).get('/api');
    expect(response.status).toBe(200);
    expect(response.body.control_outputs).toMatch(/no interface to autopilot/i);
    expect(response.body.classification).toMatch(/PROOF OF CONCEPT/);
  });

  it('returns 404 with a helpful message for an unknown route', async () => {
    const response = await request(app).get('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('NOT_FOUND');
  });
});

describeIfDb('authentication', () => {
  it('rejects a bad password with a generic message', async () => {
    const response = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' });
    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid username or password.');
  });

  it('gives the same message for an unknown user, so accounts cannot be enumerated', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'no-such-user', password: 'whatever123' });
    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid username or password.');
  });

  it('validates the request body', async () => {
    const response = await request(app).post('/api/auth/login').send({ username: '' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_FAILED');
    expect(response.body.details.length).toBeGreaterThan(0);
  });

  it('refuses protected routes without a token', async () => {
    const response = await request(app).get('/api/system/status');
    expect(response.status).toBe(401);
  });

  it('refuses a forged token', async () => {
    const response = await request(app).get('/api/system/status').set('Authorization', 'Bearer not.a.token');
    expect(response.status).toBe(401);
  });

  it('returns the signed-in user', async () => {
    const response = await auth(adminToken)(request(app).get('/api/auth/me'));
    expect(response.status).toBe(200);
    expect(response.body.user.username).toBe('admin');
    expect(response.body.user).not.toHaveProperty('password_hash');
  });

  it('records the sign-in in the audit log', async () => {
    const response = await auth(adminToken)(request(app).get('/api/auth/audit').query({ action: 'LOGIN', limit: 5 }));
    expect(response.status).toBe(200);
    expect(response.body.items.length).toBeGreaterThan(0);
    expect(response.body.items[0].action).toBe('LOGIN');
  });
});

describeIfDb('role-based access control', () => {
  it('lets a viewer read', async () => {
    const response = await auth(viewerToken)(request(app).get('/api/navigation/current'));
    expect(response.status).toBe(200);
  });

  it('stops a viewer controlling a scenario', async () => {
    const response = await auth(viewerToken)(request(app).post('/api/scenarios/stop'));
    expect(response.status).toBe(403);
    expect(response.body.required_role).toBe('operator');
    expect(response.body.your_role).toBe('viewer');
  });

  it('stops a viewer changing configuration', async () => {
    const response = await auth(viewerToken)(
      request(app).put('/api/config').send({ updates: { 'requirements.horizontal_error_limit_m': 5 } })
    );
    expect(response.status).toBe(403);
  });

  it('stops a viewer managing users', async () => {
    const response = await auth(viewerToken)(request(app).get('/api/auth/users'));
    expect(response.status).toBe(403);
  });
});

describeIfDb('trusted output is read-only', () => {
  it.each(['post', 'put', 'patch', 'delete'])('refuses %s on the navigation surface', async (method) => {
    const response = await auth(adminToken)(request(app)[method]('/api/navigation/current').send({}));
    expect(response.status).toBe(405);
    expect(response.body.error).toBe('READ_ONLY_OUTPUT');
    expect(response.body.message).toMatch(/no control interface/i);
  });
});

describeIfDb('reference data', () => {
  it('lists sensors with vendor-neutral class descriptions', async () => {
    const response = await auth(adminToken)(request(app).get('/api/sensors'));
    expect(response.status).toBe(200);
    expect(response.body.items.length).toBeGreaterThan(5);
    const gnss = response.body.items.find((s) => s.sensor_id === 'GNSS_01');
    expect(gnss.manufacturer_class).toMatch(/vendor neutral/i);
  });

  it('lists every navigation mode with guidance and successors', async () => {
    const response = await auth(adminToken)(request(app).get('/api/system/modes'));
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(14);
    for (const mode of response.body.items) {
      expect(mode.operator_guidance).toBeTruthy();
      expect(mode.expected_accuracy).toBeTruthy();
    }
  });

  it('serves the geospatial bundle with the demonstration label', async () => {
    const response = await auth(adminToken)(request(app).get('/api/geospatial/bundle'));
    expect(response.status).toBe(200);
    expect(response.body.label).toMatch(/not for navigation/i);
    expect(response.body.layers.LAND).toBeDefined();
    expect(response.body.bathymetry_meta.resolution_note).toMatch(/does not imply/i);
  });

  it('answers a depth query', async () => {
    const response = await auth(adminToken)(
      request(app).get('/api/geospatial/depth').query({ latitude: 24.515, longitude: 54.355 })
    );
    expect(response.status).toBe(200);
    expect(typeof response.body.depth_m).toBe('number');
  });

  it('validates a depth query', async () => {
    const response = await auth(adminToken)(
      request(app).get('/api/geospatial/depth').query({ latitude: 'north', longitude: 54 })
    );
    expect(response.status).toBe(400);
  });

  it('lists scenarios with their scripted faults', async () => {
    const response = await auth(adminToken)(request(app).get('/api/scenarios'));
    expect(response.status).toBe(200);
    expect(response.body.items.length).toBeGreaterThanOrEqual(10);
    const drag = response.body.items.find((s) => s.id === 'SCN_03_GRADUAL_DRAG');
    expect(drag.faults[0].type).toBe('GNSS_GRADUAL_DRAG');
  });
});

describeIfDb('scenario lifecycle', () => {
  it('runs a scenario end to end and produces a trusted solution', async () => {
    const start = await auth(adminToken)(
      request(app).post('/api/scenarios/SCN_02_GNSS_JUMP/start').send({ speedMultiplier: 10 })
    );
    expect(start.status).toBe(200);
    expect(start.body.state).toBe('RUNNING');
    const runId = start.body.run_id;
    expect(runId).toBeTruthy();

    // Let it run a few seconds of wall clock at 10x.
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const current = await auth(adminToken)(request(app).get('/api/navigation/current'));
    expect(current.status).toBe(200);
    expect(current.body.available).toBe(true);
    const nav = current.body.navigation;
    expect(nav.trusted_position).not.toBeNull();
    expect(nav.integrity.horizontal_protection_level_m).toBeGreaterThan(0);
    expect(['REQUIREMENT_MET', 'REQUIREMENT_AT_RISK', 'REQUIREMENT_NOT_MET', 'INSUFFICIENT_INFORMATION']).toContain(
      nav.integrity.requirement_status
    );
    // The fused position and the raw GNSS position are reported separately.
    expect(nav.gnss.reported_position).toBeDefined();
    expect(nav.contributing_sensors.length).toBeGreaterThan(0);

    // Pause, step, resume.
    expect((await auth(adminToken)(request(app).post('/api/scenarios/pause'))).body.state).toBe('PAUSED');
    const stepped = await auth(adminToken)(request(app).post('/api/scenarios/step').send({ seconds: 5 }));
    expect(stepped.status).toBe(200);
    expect((await auth(adminToken)(request(app).post('/api/scenarios/resume'))).body.state).toBe('RUNNING');

    await new Promise((resolve) => setTimeout(resolve, 1500));

    // History was recorded.
    const history = await auth(adminToken)(request(app).get('/api/navigation/history').query({ runId, limit: 50 }));
    expect(history.status).toBe(200);
    expect(history.body.items.length).toBeGreaterThan(0);

    await auth(adminToken)(request(app).post('/api/scenarios/stop'));
  }, 90000);

  it('refuses to step while running', async () => {
    await auth(adminToken)(request(app).post('/api/scenarios/SCN_01_HEALTHY/start').send({ speedMultiplier: 5 }));
    const response = await auth(adminToken)(request(app).post('/api/scenarios/step').send({ seconds: 1 }));
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/Pause the scenario/i);
    await auth(adminToken)(request(app).post('/api/scenarios/stop'));
  }, 60000);

  it('refuses to jump backwards in simulated time', async () => {
    await auth(adminToken)(request(app).post('/api/scenarios/SCN_01_HEALTHY/start').send({ speedMultiplier: 10 }));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await auth(adminToken)(request(app).post('/api/scenarios/jump').send({ timeS: 0 }));
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/cannot run backwards/i);
    await auth(adminToken)(request(app).post('/api/scenarios/stop'));
  }, 60000);

  it('rejects an unknown scenario', async () => {
    const response = await auth(adminToken)(request(app).post('/api/scenarios/NOT_A_SCENARIO/start').send({}));
    expect(response.status).toBe(404);
  });
});

describeIfDb('fault injection and alarms', () => {
  it('injects a fault, detects it, and records the alarm', async () => {
    await auth(adminToken)(
      request(app).post('/api/scenarios/SCN_01_HEALTHY/start').send({ speedMultiplier: 10 })
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const injected = await auth(adminToken)(
      request(app)
        .post('/api/scenarios/inject-fault')
        .send({ type: 'GNSS_POSITION_JUMP', sensor_id: 'GNSS_01', duration_s: 120, params: { east_m: 80, north_m: 0 } })
    );
    expect(injected.status).toBe(201);
    const faultId = injected.body.fault.id;

    await new Promise((resolve) => setTimeout(resolve, 4000));

    const current = await auth(adminToken)(request(app).get('/api/navigation/current'));
    expect(current.body.navigation.gnss.spoofing_suspected).toBe(true);
    expect(current.body.navigation.excluded_sensors).toContain('GNSS_01');

    const alarms = await auth(adminToken)(request(app).get('/api/alarms').query({ limit: 50 }));
    expect(alarms.status).toBe(200);
    const spoofing = alarms.body.items.find((a) => a.code === 'GNSS_SPOOFING_DETECTED');
    expect(spoofing).toBeDefined();
    expect(spoofing.severity).toBe('CRITICAL');
    expect(spoofing.reason).toMatch(/differs from|jumped|walking away/i);
    expect(spoofing.recommended_action).toBeTruthy();

    // Acknowledging does not clear it.
    const acked = await auth(adminToken)(request(app).post(`/api/alarms/${spoofing.id}/acknowledge`));
    expect(acked.status).toBe(200);
    expect(acked.body.alarm.acknowledged_at).toBeTruthy();
    expect(acked.body.note).toMatch(/does not clear/i);

    const removed = await auth(adminToken)(request(app).post('/api/scenarios/remove-fault').send({ faultId }));
    expect(removed.status).toBe(200);

    await auth(adminToken)(request(app).post('/api/scenarios/stop'));
  }, 120000);

  it('validates fault parameters', async () => {
    await auth(adminToken)(request(app).post('/api/scenarios/SCN_01_HEALTHY/start').send({ speedMultiplier: 5 }));
    const response = await auth(adminToken)(
      request(app)
        .post('/api/scenarios/inject-fault')
        .send({ type: 'GNSS_GRADUAL_DRAG', sensor_id: 'GNSS_01', params: { rate_m_per_s: 9999 } })
    );
    expect(response.status).toBe(400);
    await auth(adminToken)(request(app).post('/api/scenarios/stop'));
  }, 60000);

  it('rejects an unknown fault type at the schema', async () => {
    const response = await auth(adminToken)(
      request(app).post('/api/scenarios/inject-fault').send({ type: 'SUMMON_KRAKEN', sensor_id: 'GNSS_01' })
    );
    expect(response.status).toBe(400);
  });
});

describeIfDb('performance reporting', () => {
  let runId = null;

  beforeAll(async () => {
    const start = await auth(adminToken)(
      request(app).post('/api/scenarios/SCN_03_GRADUAL_DRAG/start').send({ speedMultiplier: 10 })
    );
    runId = start.body.run_id;
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await auth(adminToken)(request(app).post('/api/scenarios/stop'));
    await recorder.flush();
  }, 90000);

  it('separates actual error, estimated error and protection level', async () => {
    const response = await auth(adminToken)(request(app).get('/api/performance/summary').query({ runId }));
    expect(response.status).toBe(200);
    const s = response.body.summary;
    expect(s.actual_error.source).toMatch(/ground truth/i);
    expect(s.estimated_error.source).toMatch(/covariance/i);
    expect(s.protection_level.source).toMatch(/bound/i);
    expect(typeof s.misleading_information_pct).toBe('number');
    expect(s.compliance_result).toBeTruthy();
  });

  it('serves a decimated time series', async () => {
    const response = await auth(adminToken)(
      request(app).get('/api/performance/timeseries').query({ runId, maxPoints: 100 })
    );
    expect(response.status).toBe(200);
    expect(response.body.series.length).toBeLessThanOrEqual(120);
    expect(response.body.series[0]).toHaveProperty('hpl_m');
    expect(response.body.series[0]).toHaveProperty('actual_error_m');
  });

  it('serves the three tracks separately', async () => {
    const response = await auth(adminToken)(request(app).get('/api/performance/tracks').query({ runId }));
    expect(response.status).toBe(200);
    expect(response.body.fused.length).toBeGreaterThan(0);
    expect(response.body.truth.length).toBeGreaterThan(0);
  });

  it('generates and stores a report', async () => {
    const response = await auth(adminToken)(request(app).post('/api/performance/report').send({ runId }));
    expect(response.status).toBe(200);
    expect(response.body.report_id).toBeTruthy();
    expect(response.body.summary.scenario_id).toBe('SCN_03_GRADUAL_DRAG');
  });

  it('exports CSV, JSON, GeoJSON, KML and a printable report', async () => {
    const csv = await auth(adminToken)(
      request(app).get('/api/export').query({ dataset: 'navigation', format: 'csv', runId })
    );
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toContain('sim_time_s');

    const geo = await auth(adminToken)(
      request(app).get('/api/export').query({ dataset: 'navigation', format: 'geojson', runId })
    );
    expect(geo.status).toBe(200);
    const parsed = JSON.parse(geo.text);
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.properties.label).toMatch(/not for navigation/i);

    const kml = await auth(adminToken)(
      request(app).get('/api/export').query({ dataset: 'ground_truth', format: 'kml', runId })
    );
    expect(kml.status).toBe(200);
    expect(kml.text).toContain('<kml');

    const html = await auth(adminToken)(
      request(app).get('/api/export').query({ dataset: 'report', format: 'html', runId })
    );
    expect(html.status).toBe(200);
    expect(html.text).toContain('Scenario Performance Report');
    expect(html.text).toMatch(/PROOF OF CONCEPT/);
  }, 60000);
});

describeIfDb('configuration', () => {
  it('applies a change and records it in the audit log', async () => {
    const before = await auth(adminToken)(request(app).get('/api/config'));
    expect(before.body.effective.requirements.horizontal_error_limit_m).toBe(2);

    const update = await auth(adminToken)(
      request(app)
        .put('/api/config')
        .send({ updates: { 'requirements.horizontal_error_limit_m': 2.5 }, note: 'integration test' })
    );
    expect(update.status).toBe(200);
    expect(update.body.effective.requirements.horizontal_error_limit_m).toBe(2.5);

    const history = await auth(adminToken)(request(app).get('/api/config/history'));
    expect(history.body.items.some((i) => i.path === 'requirements.horizontal_error_limit_m')).toBe(true);

    const reset = await auth(adminToken)(
      request(app).post('/api/config/reset').send({ paths: ['requirements.horizontal_error_limit_m'] })
    );
    expect(reset.status).toBe(200);
    expect(reset.body.effective.requirements.horizontal_error_limit_m).toBe(2);
  });

  it('refuses a value outside the safety bounds', async () => {
    const response = await auth(adminToken)(
      request(app).put('/api/config').send({ updates: { 'requirements.horizontal_error_limit_m': 500 } })
    );
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/must be between/i);
  });

  it('refuses to change the platform identity or security policy', async () => {
    const platform = await auth(adminToken)(
      request(app).put('/api/config').send({ updates: { 'platform.classification': 'CERTIFIED' } })
    );
    expect(platform.status).toBe(400);
    expect(platform.body.message).toMatch(/cannot be changed at runtime/i);

    const security = await auth(adminToken)(
      request(app).put('/api/config').send({ updates: { 'security.password_min_length': 1 } })
    );
    expect(security.status).toBe(400);
  });

  it('refuses an unknown configuration path', async () => {
    const response = await auth(adminToken)(
      request(app).put('/api/config').send({ updates: { 'nonsense.value': 1 } })
    );
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Unknown configuration path/i);
  });

  it('refuses an inconsistent pair of thresholds', async () => {
    const response = await auth(adminToken)(
      request(app).put('/api/config').send({ updates: { 'requirements.at_risk_lower_bound_m': 3.0 } })
    );
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/must be below/i);
  });
});

describeIfDb('data ingestion', () => {
  it('validates a message without ingesting it', async () => {
    const good = await auth(adminToken)(
      request(app).post('/api/data/validate').send({
        sensor_id: 'EXT_01',
        sensor_type: 'GNSS',
        timestamp_utc: new Date().toISOString(),
        sequence_number: 1,
        position: { latitude: 24.5, longitude: 54.3, altitude_m: 0 }
      })
    );
    expect(good.status).toBe(200);
    expect(good.body.valid).toBe(true);

    const bad = await auth(adminToken)(
      request(app).post('/api/data/validate').send({ sensor_id: 'EXT_01', sensor_type: 'WRONG' })
    );
    expect(bad.status).toBe(400);
    expect(bad.body.valid).toBe(false);
  });

  it('parses NMEA sentences over REST', async () => {
    const response = await auth(adminToken)(
      request(app)
        .post('/api/data/ingest/nmea')
        .send({ sentences: '$GPGGA,123519,2430.600,N,05421.000,E,4,12,0.8,1.6,M,,M,,*4B\n$HEHDT,12.3,T*1F' })
    );
    expect([200, 202]).toContain(response.status);
    expect(response.body.parsed).toBeGreaterThanOrEqual(1);
  });

  it('publishes the message schema for integrators', async () => {
    const response = await auth(adminToken)(request(app).get('/api/data/schema'));
    expect(response.status).toBe(200);
    expect(response.body.sensor_types).toContain('GNSS');
    expect(response.body.rules.join(' ')).toMatch(/rejected/i);
  });

  it('refuses ingestion from a viewer', async () => {
    const response = await auth(viewerToken)(
      request(app).post('/api/data/ingest').send({ messages: [] })
    );
    expect(response.status).toBe(403);
  });
});

describeIfDb('replay', () => {
  it('imports a CSV, replays it, and cleans up', async () => {
    const rows = ['sensor_id,sensor_type,timestamp_utc,sequence_number,latitude,longitude'];
    const base = Date.now();
    for (let i = 0; i < 40; i += 1) {
      rows.push(
        `CSV_GNSS,GNSS,${new Date(base + i * 200).toISOString()},${i + 1},${24.51 + i * 0.00002},${54.35 + i * 0.00002}`
      );
    }
    const upload = await auth(adminToken)(
      request(app).post('/api/data/upload').send({ name: 'Integration CSV', format: 'csv', content: rows.join('\n') })
    );
    expect(upload.status).toBe(201);
    expect(upload.body.session.message_count).toBe(40);

    const sessionId = upload.body.session.id;
    const started = await auth(adminToken)(
      request(app).post(`/api/replay/${sessionId}/start`).send({ speedMultiplier: 10 })
    );
    expect(started.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await auth(adminToken)(request(app).post('/api/replay/stop'));

    const deleted = await auth(adminToken)(request(app).delete(`/api/replay/${sessionId}`));
    expect(deleted.status).toBe(200);
  }, 60000);

  it('rejects a file with no usable messages', async () => {
    const response = await auth(adminToken)(
      request(app).post('/api/data/upload').send({ name: 'Bad', format: 'csv', content: 'a,b\n1,2' })
    );
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/No valid sensor messages/i);
  });
});

describeIfDb('user administration', () => {
  it('creates, updates and deletes a user', async () => {
    const created = await auth(adminToken)(
      request(app)
        .post('/api/auth/users')
        .send({ username: 'inttest', fullName: 'Integration Test', role: 'operator', password: 'Test@12345' })
    );
    expect(created.status).toBe(201);
    const id = created.body.user.id;

    const updated = await auth(adminToken)(
      request(app).put(`/api/auth/users/${id}`).send({ role: 'engineer' })
    );
    expect(updated.status).toBe(200);
    expect(updated.body.user.role).toBe('engineer');

    const deleted = await auth(adminToken)(request(app).delete(`/api/auth/users/${id}`));
    expect(deleted.status).toBe(200);
  });

  it('enforces the password policy', async () => {
    const response = await auth(adminToken)(
      request(app)
        .post('/api/auth/users')
        .send({ username: 'weakpw', fullName: 'Weak', role: 'viewer', password: 'short' })
    );
    expect(response.status).toBe(400);
  });

  it('refuses a duplicate username', async () => {
    const response = await auth(adminToken)(
      request(app)
        .post('/api/auth/users')
        .send({ username: 'admin', fullName: 'Clash', role: 'viewer', password: 'Test@12345' })
    );
    expect(response.status).toBe(409);
  });
});

describeIfDb('audit trail is append-only', () => {
  it('refuses an update at the database level', async () => {
    await expect(query("UPDATE audit_log SET action = 'TAMPERED' WHERE id = (SELECT max(id) FROM audit_log)")).rejects.toThrow(
      /append-only/i
    );
  });

  it('refuses a delete at the database level', async () => {
    await expect(query('DELETE FROM audit_log WHERE id = (SELECT max(id) FROM audit_log)')).rejects.toThrow(
      /append-only/i
    );
  });
});
