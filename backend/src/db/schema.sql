-- ---------------------------------------------------------------------------
-- iSpatialTec Assured Marine Navigation Platform
-- PostgreSQL schema (Section 21: Data Recording and Audit Trail)
--
-- Design notes
--  * Every table that records an event carries both wall-clock UTC and
--    scenario-relative time, so a replay can be aligned exactly.
--  * Audit tables have no UPDATE or DELETE paths in the application. The UI can
--    only read them ("logs must be immutable from the UI"); a database trigger
--    enforces this for the audit_log table itself.
--  * JSONB is used for sensor-specific quality blocks and engine debug output
--    so that adding a sensor type does not require a migration.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --- Reference / configuration --------------------------------------------

CREATE TABLE IF NOT EXISTS app_meta (
    key           TEXT PRIMARY KEY,
    value         JSONB       NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username           TEXT NOT NULL UNIQUE,
    full_name          TEXT NOT NULL,
    email              TEXT,
    role               TEXT NOT NULL CHECK (role IN ('viewer','operator','engineer','administrator')),
    password_hash      TEXT NOT NULL,
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    failed_logins      INTEGER NOT NULL DEFAULT 0,
    locked_until       TIMESTAMPTZ,
    last_login_at      TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS config_overrides (
    path          TEXT PRIMARY KEY,
    value         JSONB       NOT NULL,
    updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    note          TEXT
);

CREATE TABLE IF NOT EXISTS sensors (
    sensor_id                 TEXT PRIMARY KEY,
    sensor_type               TEXT NOT NULL,
    name                      TEXT NOT NULL,
    manufacturer_class        TEXT,
    interface_description     TEXT,
    nominal_rate_hz           DOUBLE PRECISION,
    provides                  TEXT[] NOT NULL DEFAULT '{}',
    absolute_position_source  BOOLEAN NOT NULL DEFAULT FALSE,
    optional                  BOOLEAN NOT NULL DEFAULT FALSE,
    advisory_only             BOOLEAN NOT NULL DEFAULT FALSE,
    enabled                   BOOLEAN NOT NULL DEFAULT TRUE,
    configuration             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenarios (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    category            TEXT NOT NULL,
    display_order       INTEGER NOT NULL DEFAULT 100,
    duration_s          DOUBLE PRECISION NOT NULL,
    seed                BIGINT NOT NULL,
    ins_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    local_ranging_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    is_demonstration    BOOLEAN NOT NULL DEFAULT FALSE,
    summary             TEXT,
    expected_outcome    TEXT,
    definition          JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Geospatial reference data --------------------------------------------

CREATE TABLE IF NOT EXISTS map_layers (
    id            TEXT PRIMARY KEY,
    layer_type    TEXT NOT NULL,          -- land | water | operating_area | no_go | channel | contours | features | control_points
    name          TEXT NOT NULL,
    description   TEXT,
    is_demo_data  BOOLEAN NOT NULL DEFAULT TRUE,
    geojson       JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bathymetry_grids (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    origin_latitude   DOUBLE PRECISION NOT NULL,
    origin_longitude  DOUBLE PRECISION NOT NULL,
    spacing_m         DOUBLE PRECISION NOT NULL,
    width             INTEGER NOT NULL,
    height            INTEGER NOT NULL,
    min_depth_m       DOUBLE PRECISION,
    max_depth_m       DOUBLE PRECISION,
    survey_date       DATE,
    vertical_sigma_m  DOUBLE PRECISION,
    depths            BYTEA NOT NULL,     -- Float32Array, row-major, south-west origin
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_point_clouds (
    id            TEXT PRIMARY KEY,
    cloud_type    TEXT NOT NULL,          -- RADAR | LIDAR
    name          TEXT NOT NULL,
    origin_latitude  DOUBLE PRECISION NOT NULL,
    origin_longitude DOUBLE PRECISION NOT NULL,
    point_count   INTEGER NOT NULL,
    map_age_days  DOUBLE PRECISION,
    points        JSONB NOT NULL,         -- [{ e, n, kind, rcs }]
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control_points (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    latitude      DOUBLE PRECISION NOT NULL,
    longitude     DOUBLE PRECISION NOT NULL,
    height_m      DOUBLE PRECISION,
    accuracy_m    DOUBLE PRECISION,
    point_type    TEXT NOT NULL,          -- SURVEY_MARK | UWB_ANCHOR | RANGING_BEACON | TOTAL_STATION | LBL_TRANSPONDER
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- --- Scenario runs ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS scenario_runs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_id        TEXT NOT NULL REFERENCES scenarios(id) ON DELETE RESTRICT,
    run_label          TEXT,
    state              TEXT NOT NULL DEFAULT 'RUNNING',
    seed               BIGINT NOT NULL,
    speed_multiplier   DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    ins_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at           TIMESTAMPTZ,
    duration_s         DOUBLE PRECISION,
    started_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    config_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes              TEXT
);

CREATE INDEX IF NOT EXISTS idx_scenario_runs_scenario ON scenario_runs(scenario_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scenario_runs_state ON scenario_runs(state);

-- --- Recorded telemetry ----------------------------------------------------

CREATE TABLE IF NOT EXISTS sensor_messages (
    id              BIGSERIAL PRIMARY KEY,
    run_id          UUID NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
    sensor_id       TEXT NOT NULL,
    sensor_type     TEXT NOT NULL,
    sim_time_s      DOUBLE PRECISION NOT NULL,
    timestamp_utc   TIMESTAMPTZ NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL,
    sequence_number BIGINT NOT NULL,
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    altitude_m      DOUBLE PRECISION,
    velocity_north_mps DOUBLE PRECISION,
    velocity_east_mps  DOUBLE PRECISION,
    velocity_down_mps  DOUBLE PRECISION,
    heading_deg     DOUBLE PRECISION,
    depth_m         DOUBLE PRECISION,
    quality         JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
    valid           BOOLEAN NOT NULL DEFAULT TRUE,
    decision        TEXT,
    decision_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_sensor_messages_run_time ON sensor_messages(run_id, sim_time_s);
CREATE INDEX IF NOT EXISTS idx_sensor_messages_sensor ON sensor_messages(run_id, sensor_id, sim_time_s);

CREATE TABLE IF NOT EXISTS ground_truth (
    id            BIGSERIAL PRIMARY KEY,
    run_id        UUID NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
    sim_time_s    DOUBLE PRECISION NOT NULL,
    timestamp_utc TIMESTAMPTZ NOT NULL,
    latitude      DOUBLE PRECISION NOT NULL,
    longitude     DOUBLE PRECISION NOT NULL,
    speed_mps     DOUBLE PRECISION NOT NULL,
    course_deg    DOUBLE PRECISION NOT NULL,
    heading_deg   DOUBLE PRECISION NOT NULL,
    turn_rate_dps DOUBLE PRECISION NOT NULL,
    depth_m       DOUBLE PRECISION NOT NULL,
    zone          TEXT
);

CREATE INDEX IF NOT EXISTS idx_ground_truth_run_time ON ground_truth(run_id, sim_time_s);

CREATE TABLE IF NOT EXISTS navigation_solutions (
    id                         BIGSERIAL PRIMARY KEY,
    run_id                     UUID NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
    sim_time_s                 DOUBLE PRECISION NOT NULL,
    timestamp_utc              TIMESTAMPTZ NOT NULL,
    latitude                   DOUBLE PRECISION,
    longitude                  DOUBLE PRECISION,
    velocity_north_mps         DOUBLE PRECISION,
    velocity_east_mps          DOUBLE PRECISION,
    speed_mps                  DOUBLE PRECISION,
    course_deg                 DOUBLE PRECISION,
    heading_deg                DOUBLE PRECISION,
    gyro_bias_deg              DOUBLE PRECISION,
    speed_scale_factor         DOUBLE PRECISION,
    sigma_east_m               DOUBLE PRECISION,
    sigma_north_m              DOUBLE PRECISION,
    ellipse_major_m            DOUBLE PRECISION,
    ellipse_minor_m            DOUBLE PRECISION,
    ellipse_orientation_deg    DOUBLE PRECISION,
    estimated_horizontal_error_m DOUBLE PRECISION,
    horizontal_protection_level_m DOUBLE PRECISION,
    vertical_protection_level_m DOUBLE PRECISION,
    radius_95_m                DOUBLE PRECISION,
    radius_99_m                DOUBLE PRECISION,
    integrity_status           TEXT NOT NULL,
    requirement_status         TEXT NOT NULL,
    navigation_mode            TEXT NOT NULL,
    solution_available         BOOLEAN NOT NULL DEFAULT TRUE,
    contributing_sensors       TEXT[] NOT NULL DEFAULT '{}',
    excluded_sensors           TEXT[] NOT NULL DEFAULT '{}',
    independent_absolute_sources INTEGER NOT NULL DEFAULT 0,
    sensor_diversity_score     DOUBLE PRECISION,
    dead_reckoning_duration_s  DOUBLE PRECISION,
    absolute_fix_age_s         DOUBLE PRECISION,
    gnss_trust_score           DOUBLE PRECISION,
    truth_error_m              DOUBLE PRECISION,
    gnss_truth_error_m         DOUBLE PRECISION,
    detail                     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_nav_solutions_run_time ON navigation_solutions(run_id, sim_time_s);
CREATE INDEX IF NOT EXISTS idx_nav_solutions_mode ON navigation_solutions(run_id, navigation_mode);

CREATE TABLE IF NOT EXISTS gnss_trust_records (
    id                   BIGSERIAL PRIMARY KEY,
    run_id               UUID NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
    sim_time_s           DOUBLE PRECISION NOT NULL,
    timestamp_utc        TIMESTAMPTZ NOT NULL,
    trust_score          DOUBLE PRECISION NOT NULL,
    status               TEXT NOT NULL,
    recommended_action   TEXT NOT NULL,
    detected_conditions  TEXT[] NOT NULL DEFAULT '{}',
    satellites           INTEGER,
    hdop                 DOUBLE PRECISION,
    pdop                 DOUBLE PRECISION,
    cn0_mean_dbhz        DOUBLE PRECISION,
    fix_type             TEXT,
    reported_accuracy_m  DOUBLE PRECISION,
    diff_from_fused_m    DOUBLE PRECISION,
    diff_from_radar_m    DOUBLE PRECISION,
    diff_from_lidar_m    DOUBLE PRECISION,
    diff_from_bathy_m    DOUBLE PRECISION,
    diff_from_dr_m       DOUBLE PRECISION,
    time_offset_s        DOUBLE PRECISION,
    drag_rate_m_per_s    DOUBLE PRECISION,
    detail               JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_gnss_trust_run_time ON gnss_trust_records(run_id, sim_time_s);

CREATE TABLE IF NOT EXISTS sensor_residuals (
    id                    BIGSERIAL PRIMARY KEY,
    run_id                UUID NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
    sim_time_s            DOUBLE PRECISION NOT NULL,
    timestamp_utc         TIMESTAMPTZ NOT NULL,
    sensor_id             TEXT NOT NULL,
    sensor_type           TEXT NOT NULL,
    measurement_kind      TEXT NOT NULL,     -- POSITION | VELOCITY | HEADING | DEPTH
    residual              DOUBLE PRECISION,
    normalized_residual   DOUBLE PRECISION,
    innovation_covariance DOUBLE PRECISION,
    chi_square            DOUBLE PRECISION,
    gate_passed           BOOLEAN NOT NULL DEFAULT TRUE,
    decision              TEXT NOT NULL,
    reason                TEXT
);

CREATE INDEX IF NOT EXISTS idx_residuals_run_time ON sensor_residuals(run_id, sim_time_s);
CREATE INDEX IF NOT EXISTS idx_residuals_sensor ON sensor_residuals(run_id, sensor_id, sim_time_s);

CREATE TABLE IF NOT EXISTS sensor_health_snapshots (
    id                BIGSERIAL PRIMARY KEY,
    run_id            UUID NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
    sim_time_s        DOUBLE PRECISION NOT NULL,
    timestamp_utc     TIMESTAMPTZ NOT NULL,
    sensor_id         TEXT NOT NULL,
    online            BOOLEAN NOT NULL,
    trust_score       DOUBLE PRECISION,
    update_rate_hz    DOUBLE PRECISION,
    data_age_s        DOUBLE PRECISION,
    accepted          BOOLEAN,
    reason            TEXT,
    quality           JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_sensor_health_run ON sensor_health_snapshots(run_id, sim_time_s);

-- --- Events ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mode_transitions (
    id                BIGSERIAL PRIMARY KEY,
    run_id            UUID REFERENCES scenario_runs(id) ON DELETE CASCADE,
    sim_time_s        DOUBLE PRECISION NOT NULL,
    timestamp_utc     TIMESTAMPTZ NOT NULL DEFAULT now(),
    from_mode         TEXT,
    to_mode           TEXT NOT NULL,
    reason            TEXT NOT NULL,
    trigger_context   JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_mode_transitions_run ON mode_transitions(run_id, sim_time_s);

CREATE TABLE IF NOT EXISTS alarms (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id             UUID REFERENCES scenario_runs(id) ON DELETE CASCADE,
    code               TEXT NOT NULL,
    severity           TEXT NOT NULL CHECK (severity IN ('INFO','ADVISORY','WARNING','CRITICAL')),
    source             TEXT NOT NULL,
    message            TEXT NOT NULL,
    reason             TEXT,
    recommended_action TEXT,
    sim_time_s         DOUBLE PRECISION,
    raised_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    cleared_at         TIMESTAMPTZ,
    acknowledged_at    TIMESTAMPTZ,
    acknowledged_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    active             BOOLEAN NOT NULL DEFAULT TRUE,
    latitude           DOUBLE PRECISION,
    longitude          DOUBLE PRECISION,
    detail             JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_alarms_run ON alarms(run_id, raised_at DESC);
CREATE INDEX IF NOT EXISTS idx_alarms_active ON alarms(active, severity);
CREATE INDEX IF NOT EXISTS idx_alarms_code ON alarms(code);

CREATE TABLE IF NOT EXISTS scenario_events (
    id             BIGSERIAL PRIMARY KEY,
    run_id         UUID NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
    sim_time_s     DOUBLE PRECISION NOT NULL,
    timestamp_utc  TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type     TEXT NOT NULL,   -- FAULT_INJECTED | FAULT_REMOVED | STAGE | CONTROL | NOTE
    label          TEXT NOT NULL,
    detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_scenario_events_run ON scenario_events(run_id, sim_time_s);

CREATE TABLE IF NOT EXISTS audit_log (
    id            BIGSERIAL PRIMARY KEY,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_name    TEXT,
    actor_role    TEXT,
    action        TEXT NOT NULL,
    entity_type   TEXT,
    entity_id     TEXT,
    outcome       TEXT NOT NULL DEFAULT 'SUCCESS',
    ip_address    TEXT,
    user_agent    TEXT,
    detail        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- Audit records are append-only. The application never issues UPDATE/DELETE
-- against this table; the trigger below makes that guarantee enforceable even
-- if a future code path tries.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit_log;
CREATE TRIGGER trg_audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- --- Performance reports and replay ---------------------------------------

CREATE TABLE IF NOT EXISTS performance_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
    scenario_id     TEXT NOT NULL,
    generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    generated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    summary         JSONB NOT NULL,
    mode_durations  JSONB NOT NULL DEFAULT '{}'::jsonb,
    sensor_availability JSONB NOT NULL DEFAULT '{}'::jsonb,
    compliance_result TEXT
);

CREATE INDEX IF NOT EXISTS idx_perf_reports_run ON performance_reports(run_id);

CREATE TABLE IF NOT EXISTS replay_sessions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           TEXT NOT NULL,
    source_type    TEXT NOT NULL,     -- RUN | CSV | JSON
    source_run_id  UUID REFERENCES scenario_runs(id) ON DELETE SET NULL,
    message_count  INTEGER NOT NULL DEFAULT 0,
    start_time_s   DOUBLE PRECISION,
    end_time_s     DOUBLE PRECISION,
    uploaded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS replay_messages (
    id           BIGSERIAL PRIMARY KEY,
    session_id   UUID NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
    sim_time_s   DOUBLE PRECISION NOT NULL,
    message      JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replay_messages_session ON replay_messages(session_id, sim_time_s);

-- --- Convenience views -----------------------------------------------------

CREATE OR REPLACE VIEW v_active_alarms AS
SELECT a.*, u.username AS acknowledged_by_username
FROM alarms a
LEFT JOIN users u ON u.id = a.acknowledged_by
WHERE a.active = TRUE;

CREATE OR REPLACE VIEW v_run_summary AS
SELECT
    r.id                AS run_id,
    r.scenario_id,
    s.name              AS scenario_name,
    r.state,
    r.started_at,
    r.ended_at,
    r.duration_s,
    (SELECT count(*) FROM navigation_solutions n WHERE n.run_id = r.id)            AS solution_count,
    (SELECT count(*) FROM alarms al WHERE al.run_id = r.id)                        AS alarm_count,
    (SELECT count(*) FROM mode_transitions m WHERE m.run_id = r.id)                AS mode_transition_count,
    (SELECT avg(n.truth_error_m) FROM navigation_solutions n WHERE n.run_id = r.id) AS mean_truth_error_m
FROM scenario_runs r
JOIN scenarios s ON s.id = r.scenario_id;
