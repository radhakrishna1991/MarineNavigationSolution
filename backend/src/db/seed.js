/**
 * Reference-data seeding.
 *
 * Populates users, the sensor catalogue, scenario definitions and the whole
 * synthetic geospatial environment. Idempotent: re-running updates rows in
 * place rather than duplicating them.
 *
 * Historical scenario runs (so the analytics screens have data on first load)
 * are produced separately by `scripts/generate_demo_data.js`, which drives the
 * real navigation pipeline headless rather than fabricating plausible numbers.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { query, withTransaction, closePool } from './pool.js';
import { migrate } from './migrate.js';
import { env, sensorCatalog, scenarioCatalog } from '../config/index.js';
import { buildEnvironment } from '../geospatial/environment.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('db:seed');

const DEMO_USERS = [
  {
    username: 'admin',
    full_name: 'Platform Administrator',
    email: 'admin@ispatialtec.local',
    role: 'administrator',
    password: () => env.seed.adminPassword
  },
  {
    username: 'engineer',
    full_name: 'Navigation Systems Engineer',
    email: 'engineer@ispatialtec.local',
    role: 'engineer',
    password: () => env.seed.demoPassword
  },
  {
    username: 'operator',
    full_name: 'Bridge Watch Officer',
    email: 'operator@ispatialtec.local',
    role: 'operator',
    password: () => env.seed.demoPassword
  },
  {
    username: 'viewer',
    full_name: 'Survey Observer',
    email: 'viewer@ispatialtec.local',
    role: 'viewer',
    password: () => env.seed.demoPassword
  }
];

async function seedUsers() {
  for (const user of DEMO_USERS) {
    const hash = await bcrypt.hash(user.password(), 12);
    await query(
      `INSERT INTO users (username, full_name, email, role, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO UPDATE
         SET full_name = EXCLUDED.full_name,
             email = EXCLUDED.email,
             role = EXCLUDED.role,
             password_hash = EXCLUDED.password_hash,
             is_active = TRUE,
             failed_logins = 0,
             locked_until = NULL,
             updated_at = now()`,
      [user.username, user.full_name, user.email, user.role, hash]
    );
  }
  log.info('users seeded', { count: DEMO_USERS.length });
}

async function seedSensors() {
  for (const sensor of sensorCatalog) {
    await query(
      `INSERT INTO sensors (
         sensor_id, sensor_type, name, manufacturer_class, interface_description,
         nominal_rate_hz, provides, absolute_position_source, optional, advisory_only,
         enabled, configuration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (sensor_id) DO UPDATE
         SET sensor_type = EXCLUDED.sensor_type,
             name = EXCLUDED.name,
             manufacturer_class = EXCLUDED.manufacturer_class,
             interface_description = EXCLUDED.interface_description,
             nominal_rate_hz = EXCLUDED.nominal_rate_hz,
             provides = EXCLUDED.provides,
             absolute_position_source = EXCLUDED.absolute_position_source,
             optional = EXCLUDED.optional,
             advisory_only = EXCLUDED.advisory_only,
             configuration = EXCLUDED.configuration,
             updated_at = now()`,
      [
        sensor.sensor_id,
        sensor.sensor_type,
        sensor.name,
        sensor.manufacturer_class ?? null,
        sensor.interface ?? null,
        sensor.rate_hz ?? null,
        sensor.provides ?? [],
        Boolean(sensor.absolute_position_source),
        Boolean(sensor.optional),
        Boolean(sensor.advisory_only),
        sensor.enabled_by_default !== false,
        JSON.stringify({ simulation: sensor.simulation ?? {}, fusion: sensor.fusion ?? {} })
      ]
    );
  }
  log.info('sensors seeded', { count: sensorCatalog.length });
}

async function seedScenarios() {
  for (const scenario of scenarioCatalog) {
    await query(
      `INSERT INTO scenarios (
         id, name, category, display_order, duration_s, seed, ins_enabled,
         local_ranging_enabled, is_demonstration, summary, expected_outcome, definition)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             category = EXCLUDED.category,
             display_order = EXCLUDED.display_order,
             duration_s = EXCLUDED.duration_s,
             seed = EXCLUDED.seed,
             ins_enabled = EXCLUDED.ins_enabled,
             local_ranging_enabled = EXCLUDED.local_ranging_enabled,
             is_demonstration = EXCLUDED.is_demonstration,
             summary = EXCLUDED.summary,
             expected_outcome = EXCLUDED.expected_outcome,
             definition = EXCLUDED.definition,
             updated_at = now()`,
      [
        scenario.id,
        scenario.name,
        scenario.category,
        scenario.order ?? 100,
        scenario.duration_s,
        scenario.seed,
        scenario.ins_enabled !== false,
        Boolean(scenario.local_ranging_enabled),
        Boolean(scenario.is_demonstration),
        scenario.summary ?? null,
        scenario.expected_outcome ?? null,
        JSON.stringify(scenario)
      ]
    );
  }
  log.info('scenarios seeded', { count: scenarioCatalog.length });
}

async function seedGeospatial() {
  const environment = buildEnvironment(true);

  const layerRows = [
    ['LAND', 'land', 'Land, breakwaters and island', environment.layers.land],
    ['OPERATING_AREA', 'operating_area', 'Approved operating area', environment.layers.operating_area],
    ['NO_GO', 'no_go', 'No-go areas', environment.layers.no_go],
    ['CHANNEL', 'channel', 'Approach channel and spoil ground', environment.layers.channel],
    ['RADAR_FEATURES', 'features', 'Radar navigation marks and structures', environment.layers.radar_features],
    ['CONTROL_POINTS', 'control_points', 'Survey control points and beacons', environment.layers.control_points],
    ['CONTOURS', 'contours', 'Depth contours', environment.layers.contours],
    ['ROUTE', 'route', 'Planned survey route', environment.layers.route]
  ];

  await withTransaction(async (client) => {
    for (const [id, layerType, name, geojson] of layerRows) {
      await client.query(
        `INSERT INTO map_layers (id, layer_type, name, description, is_demo_data, geojson)
         VALUES ($1,$2,$3,$4,TRUE,$5)
         ON CONFLICT (id) DO UPDATE
           SET layer_type = EXCLUDED.layer_type,
               name = EXCLUDED.name,
               description = EXCLUDED.description,
               geojson = EXCLUDED.geojson`,
        [id, layerType, name, environment.label, JSON.stringify(geojson)]
      );
    }

    const grid = environment.bathymetry;
    const buffer = Buffer.from(grid.depths.buffer, grid.depths.byteOffset, grid.depths.byteLength);
    await client.query(
      `INSERT INTO bathymetry_grids (
         id, name, origin_latitude, origin_longitude, spacing_m, width, height,
         min_depth_m, max_depth_m, survey_date, vertical_sigma_m, depths)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             spacing_m = EXCLUDED.spacing_m,
             width = EXCLUDED.width,
             height = EXCLUDED.height,
             min_depth_m = EXCLUDED.min_depth_m,
             max_depth_m = EXCLUDED.max_depth_m,
             survey_date = EXCLUDED.survey_date,
             vertical_sigma_m = EXCLUDED.vertical_sigma_m,
             depths = EXCLUDED.depths`,
      [
        grid.id,
        grid.name,
        environment.origin.latitude,
        environment.origin.longitude,
        grid.spacing,
        grid.width,
        grid.height,
        Number(grid.minDepth.toFixed(3)),
        Number(grid.maxDepth.toFixed(3)),
        grid.surveyDate,
        grid.verticalSigmaM,
        buffer
      ]
    );

    const clouds = [
      ['RADAR_MAP_01', 'RADAR', 'Harbour radar reference map', environment.radarPoints, 45],
      ['LIDAR_MAP_01', 'LIDAR', 'Quay-side LiDAR reference cloud', environment.lidarPoints, 12]
    ];
    for (const [id, cloudType, name, points, ageDays] of clouds) {
      await client.query(
        `INSERT INTO reference_point_clouds (
           id, cloud_type, name, origin_latitude, origin_longitude, point_count, map_age_days, points)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               point_count = EXCLUDED.point_count,
               map_age_days = EXCLUDED.map_age_days,
               points = EXCLUDED.points`,
        [
          id,
          cloudType,
          name,
          environment.origin.latitude,
          environment.origin.longitude,
          points.length,
          ageDays,
          JSON.stringify(points)
        ]
      );
    }

    for (const cp of environment.controlPoints) {
      await client.query(
        `INSERT INTO control_points (id, name, latitude, longitude, height_m, accuracy_m, point_type, active, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               latitude = EXCLUDED.latitude,
               longitude = EXCLUDED.longitude,
               accuracy_m = EXCLUDED.accuracy_m,
               point_type = EXCLUDED.point_type,
               metadata = EXCLUDED.metadata`,
        [
          cp.id,
          cp.name,
          cp.latitude,
          cp.longitude,
          cp.height_m,
          cp.accuracy_m,
          cp.point_type,
          JSON.stringify({ east_m: cp.east_m, north_m: cp.north_m, demonstration_only: true })
        ]
      );
    }
  });

  log.info('geospatial data seeded', {
    radar_points: environment.radarPoints.length,
    lidar_points: environment.lidarPoints.length,
    control_points: environment.controlPoints.length,
    bathymetry_cells: environment.bathymetry.width * environment.bathymetry.height
  });
}

export async function seed({ migrateFirst = true } = {}) {
  if (migrateFirst) await migrate({ drop: false });
  await seedUsers();
  await seedSensors();
  await seedScenarios();
  await seedGeospatial();
  await query(
    `INSERT INTO app_meta(key, value, updated_at) VALUES ('seeded_at', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ at: new Date().toISOString() })]
  );
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  seed()
    .then(async () => {
      log.info('seed complete');
      log.info('demo accounts', {
        note: 'passwords come from SEED_ADMIN_PASSWORD / SEED_DEMO_PASSWORD',
        accounts: DEMO_USERS.map((u) => `${u.username} (${u.role})`)
      });
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      log.fatal('seed failed', err);
      await closePool().catch(() => {});
      process.exit(1);
    });
}
