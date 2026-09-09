/**
 * Shared types mirroring the backend contract.
 *
 * These are hand-maintained rather than generated, so they carry the same
 * vocabulary the specification uses: `integrity_status` and `requirement_status`
 * are separate concepts and the type system keeps them separate.
 */

export type Role = 'viewer' | 'operator' | 'engineer' | 'administrator';

export type NavigationMode =
  | 'NORMAL_GNSS'
  | 'GNSS_DEGRADED'
  | 'SPOOFING_SUSPECTED'
  | 'JAMMING_SUSPECTED'
  | 'GNSS_REJECTED'
  | 'RADAR_AIDED_NAVIGATION'
  | 'BATHYMETRIC_AIDED_NAVIGATION'
  | 'LIDAR_AIDED_NAVIGATION'
  | 'DEAD_RECKONING'
  | 'INS_AIDED_NAVIGATION'
  | 'LOCAL_POSITIONING_MODE'
  | 'MANUAL_FALLBACK'
  | 'GNSS_RECOVERY_VALIDATION'
  | 'INTEGRITY_NOT_ASSURED';

export type IntegrityStatus = 'ASSURED' | 'DEGRADED' | 'NOT_ASSURED' | 'UNKNOWN';

export type RequirementStatus =
  | 'REQUIREMENT_MET'
  | 'REQUIREMENT_AT_RISK'
  | 'REQUIREMENT_NOT_MET'
  | 'INSUFFICIENT_INFORMATION';

export type GnssTrustStatus = 'REJECTED' | 'HIGHLY_SUSPECT' | 'DEGRADED' | 'ACCEPTABLE' | 'TRUSTED';

export type GnssAction =
  | 'USE_IN_FUSION'
  | 'DEWEIGHT_IN_FUSION'
  | 'EXCLUDE_FROM_FUSION'
  | 'HOLD_FOR_VALIDATION';

export type AlarmSeverity = 'INFO' | 'ADVISORY' | 'WARNING' | 'CRITICAL';

export type ScenarioState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'COMPLETED';

export interface User {
  id: string | null;
  username: string;
  full_name?: string;
  email?: string | null;
  role: Role;
  is_active?: boolean;
  last_login_at?: string | null;
  created_at?: string;
}

export interface ConfidenceEllipse {
  semi_major_m: number | null;
  semi_minor_m: number | null;
  orientation_deg: number;
  confidence: number;
  one_sigma_major_m: number | null;
  one_sigma_minor_m: number | null;
}

export interface Integrity {
  time_s: number;
  sigma_east_m: number | null;
  sigma_north_m: number | null;
  drms_m: number | null;
  confidence_ellipse: ConfidenceEllipse;
  radius_95_m: number | null;
  radius_99_m: number | null;
  horizontal_protection_level_m: number | null;
  vertical_protection_level_m: number | null;
  vertical_protection_level_status: string;
  estimated_horizontal_error_m: number | null;
  protection_level_inflation: number;
  protection_level_inflation_reasons: string[];
  bias_margin_m: number;
  correlated_sigma_m?: number;
  protection_level_growth_rate_m_per_s: number;
  integrity_status: IntegrityStatus;
  integrity_reasons: string[];
  solution_available: boolean;
  solution_age_s: number | null;
  time_since_last_absolute_fix_s: number | null;
  last_absolute_fix_source: string | null;
  dead_reckoning_duration_s: number | null;
  independent_absolute_sources: number;
  absolute_source_ids: string[];
  sensor_diversity_score: number;
  measurement_principles: string[];
  fault_detection_status: string;
  fault_count: number;
  requirement_status: RequirementStatus;
  requirement_reasons: string[];
  requirement_limit_m: number;
  requirement_confidence: number;
  requirement_margin_m: number | null;
  requirement_statement: string;
}

export interface GnssAssessment {
  trust_score: number;
  status: GnssTrustStatus;
  recommended_action: GnssAction;
  detected_conditions: string[];
  pending_conditions: string[];
  spoofing_suspected: boolean;
  jamming_suspected: boolean;
  used_in_fusion: boolean;
  explanation: string;
  recovery: {
    active: boolean;
    complete: boolean;
    progress: number;
    elapsed_s: number;
    required_s: number;
    consistent_samples: number;
    total_samples: number;
    max_difference_m: number;
  } | null;
  diagnostics: Record<string, number | boolean | string | null>;
  quality: {
    satellites: number | null;
    hdop: number | null;
    pdop: number | null;
    cn0_mean_dbhz: number | null;
    fix_type: string | null;
    reported_accuracy_m: number | null;
  };
  reported_position: { latitude: number; longitude: number; altitude_m: number } | null;
  error_vs_truth_m: number | null;
}

export interface LocalizationSummary {
  available: boolean;
  valid: boolean;
  reason?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  east_m?: number | null;
  north_m?: number | null;
  heading_deg?: number | null;
  sigma_m?: number | null;
  confidence?: number;
  match_score?: number | null;
  residual_m?: number | null;
  inliers?: number | null;
  matched_features?: number | null;
  selected_mode?: string | null;
  selection_reason?: string | null;
  stale?: boolean;
  method?: string | null;
  beacon_count?: number | null;
  gdop?: number | null;
}

export interface BathymetricSummary extends LocalizationSummary {
  ambiguity_score?: number;
  terrain_observability?: number;
  candidate_count?: number;
  mode_count?: number;
  residual_rms_m?: number;
  depth_bias_m?: number;
  sequence_length?: number;
  top_candidates?: Array<{
    east_m: number;
    north_m: number;
    offset_east_m: number;
    offset_north_m: number;
    weight: number;
    cost: number;
  }>;
}

export interface DeadReckoningState {
  east_m: number;
  north_m: number;
  latitude: number;
  longitude: number;
  heading_deg: number | null;
  speed_mps: number;
  sigma_m: number;
  duration_s: number;
  anchor_time_s: number;
  bottom_lock: boolean;
  velocity_source: string | null;
  dominant_error_source: string;
}

export interface SensorHealth {
  sensor_id: string;
  sensor_type: string;
  online: boolean;
  last_update_s: number | null;
  data_age_s: number | null;
  update_rate_hz: number | null;
  nominal_rate_hz: number;
  message_count: number;
  accepted_count: number;
  rejected_count: number;
  duplicate_count: number;
  out_of_order_count: number;
  gate_failures: number;
  residual_rms: number | null;
  normalized_residual_rms: number | null;
  chi_square: number | null;
  chi_square_threshold: number | null;
  excluded: boolean;
  exclusion_reason: string | null;
  exclusion_category: string | null;
  faults: string[];
  decision: string;
  reason: string | null;
}

export interface ModeDetail {
  mode: NavigationMode;
  label: string;
  description: string;
  entered_at_s: number;
  duration_s: number;
  active_sensors: string[];
  rejected_sensors: string[];
  expected_accuracy: string;
  uncertainty_behaviour: string;
  operator_alarm: AlarmSeverity;
  operator_guidance: string;
  exit_conditions: string;
  next_modes: NavigationMode[];
}

export interface NavigationOutput {
  time_s: number;
  timestamp_utc: string;
  time_integrity?: TimeIntegrity | null;
  trusted_position: { latitude: number; longitude: number; east_m: number; north_m: number } | null;
  velocity: { north_mps: number; east_mps: number; speed_mps: number } | null;
  course_deg: number | null;
  heading_deg: number | null;
  gyro_bias_deg: number | null;
  speed_scale_factor: number | null;
  solution_available: boolean;
  solution_confidence: number;
  navigation_mode: NavigationMode;
  navigation_mode_detail: ModeDetail;
  integrity: Integrity;
  gnss: GnssAssessment;
  localization: {
    radar: LocalizationSummary;
    lidar: LocalizationSummary;
    bathymetric: BathymetricSummary;
    local_ranging: LocalizationSummary;
    dead_reckoning: DeadReckoningState | null;
  };
  contributing_sensors: string[];
  excluded_sensors: string[];
  absolute_sources: Array<{ sensor_id: string; sensor_type: string; sigma_m: number | null; confidence: number | null }>;
  sensor_health: SensorHealth[];
  ais_contacts: Array<{
    mmsi: string;
    name: string;
    latitude: number;
    longitude: number;
    course_deg: number;
    speed_mps: number;
  }>;
  ground_truth: {
    latitude: number;
    longitude: number;
    heading_deg: number;
    course_deg?: number;
    speed_mps: number;
    depth_m: number;
    zone: string | null;
    east_m?: number;
    north_m?: number;
  } | null;
  actual_error_vs_truth_m: number | null;
  heading_error_deg?: number;
  speed_error_mps?: number;
  scenario_id?: string;
  scenario_progress?: number;
  active_faults?: Array<{ id: string; label: string; type: string; sensor_id: string; category: string }>;
  fusion_debug?: {
    residuals: Array<{
      sensor_id: string;
      sensor_type: string;
      kind: string;
      applied: boolean;
      gate_passed: boolean;
      reason: string | null;
      residual: number | null;
      normalized_residual: number | null;
      nis: number | null;
      decision: string;
      monitor_only?: boolean;
    }>;
    velocity_noise_scale: number;
    update_count: number;
  };
}

export interface Alarm {
  id: string;
  run_id?: string | null;
  code: string;
  severity: AlarmSeverity;
  source: string;
  message: string;
  reason: string | null;
  recommended_action: string | null;
  sim_time_s: number | null;
  raised_at: string;
  cleared_at?: string | null;
  acknowledged_at?: string | null;
  acknowledged_by_username?: string | null;
  active?: boolean;
  occurrences?: number;
  detail?: Record<string, unknown>;
}

export interface ScenarioFault {
  id: string;
  label: string;
  sensor_id: string;
  type: string;
  start_s: number;
  end_s: number | null;
  params: Record<string, number>;
  manual?: boolean;
  category?: string;
}

export interface ScenarioStatus {
  state: ScenarioState;
  scenario_id: string | null;
  scenario_name?: string;
  run_id: string | null;
  speed_multiplier: number;
  sim_time_s: number;
  duration_s: number;
  progress: number;
  tick_count?: number;
  messages_generated?: number;
  ins_enabled?: boolean;
  local_ranging_enabled?: boolean;
  faults?: ScenarioFault[];
  active_faults?: string[];
  demo_steps?: Array<{ at_s: number; title: string; detail: string }> | null;
  ground_truth?: { latitude: number; longitude: number; heading_deg: number; speed_mps: number; zone: string; depth_m: number } | null;
  error?: string | null;
  recorder?: Record<string, unknown>;
}

export interface ScenarioSummary {
  id: string;
  name: string;
  category: string;
  display_order: number;
  duration_s: number;
  seed: number;
  ins_enabled: boolean;
  local_ranging_enabled: boolean;
  is_demonstration: boolean;
  summary: string | null;
  expected_outcome: string | null;
  fault_count: number;
  faults: ScenarioFault[];
  demo_steps: Array<{ at_s: number; title: string; detail: string }> | null;
}

export interface FaultTypeDef {
  type: string;
  label: string;
  applies_to: string[];
  category: string;
  description: string;
  params: Record<string, { type: string; default: number; min?: number; max?: number; unit?: string }>;
}

export interface SensorDefinition {
  sensor_id: string;
  sensor_type: string;
  name: string;
  manufacturer_class: string | null;
  interface_description: string | null;
  nominal_rate_hz: number | null;
  provides: string[];
  absolute_position_source: boolean;
  optional: boolean;
  advisory_only: boolean;
  enabled: boolean;
  configuration: { simulation: Record<string, unknown>; fusion: Record<string, unknown> };
  health: SensorHealth | null;
  trust_score: number | null;
}

export interface RunSummary {
  run_id: string;
  scenario_id: string;
  scenario_name: string;
  category: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  seed: number;
  speed_multiplier: number;
  ins_enabled: boolean;
  started_by_username: string | null;
  solution_count: number;
  alarm_count: number;
  mode_transition_count: number;
}

export interface PerformanceReport {
  summary: Record<string, any>;
  mode_durations: Record<string, { seconds: number; pct: number }>;
  sensor_availability: Record<string, { epochs: number; availability_pct: number }>;
  mode_timeline: Array<{ sim_time_s: number; from_mode: string; to_mode: string; reason: string }>;
  alarms: Alarm[];
  events: Array<{ event_type: string; label: string; sim_time_s: number; detail: Record<string, unknown> }>;
  overall?: Record<string, number | null>;
  available?: boolean;
  report_id?: string;
}

export interface TimeseriesPoint {
  t: number;
  actual_error_m: number | null;
  gnss_error_m: number | null;
  estimated_error_m: number | null;
  hpl_m: number | null;
  radius_95_m: number | null;
  radius_99_m: number | null;
  gnss_trust: number | null;
  mode: NavigationMode;
  integrity: IntegrityStatus;
  requirement: RequirementStatus;
  absolute_sources: number;
  diversity: number | null;
  dr_duration_s: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
  latitude: number | null;
  longitude: number | null;
  contributing: string[];
  excluded: string[];
}

export interface ConfigDescription {
  effective: Record<string, any>;
  defaults: Record<string, any>;
  overrides: Array<{ path: string; value: unknown; default_value: unknown }>;
  editable_bounds: Record<string, { min: number; max: number }>;
  immutable_prefixes: string[];
}

export interface ReplaySession {
  id: string;
  name: string;
  source_type: string;
  source_run_id: string | null;
  message_count: number;
  start_time_s: number | null;
  end_time_s: number | null;
  created_at: string;
  uploaded_by_username?: string | null;
  metadata: Record<string, any>;
}

export interface ReplayStatus {
  state: ScenarioState;
  session_id: string | null;
  session_name: string | null;
  run_id: string | null;
  speed_multiplier: number;
  time_s: number;
  cursor: number;
  message_count: number;
  progress: number;
  has_ground_truth: boolean;
}

export interface SystemStatus {
  platform: { name: string; short_name: string; version: string; classification: string; disclaimer: string };
  uptime_s: number;
  node_version: string;
  environment: string;
  database: { ok: boolean; latency_ms: number | null; counts: Record<string, number> | null };
  scenario: ScenarioStatus;
  replay: ReplayStatus;
  recorder: Record<string, unknown>;
  alarms: {
    by_severity: Record<AlarmSeverity, { count: number; unacknowledged: number }>;
    total: number;
    unacknowledged: number;
    active_now: number;
    highest_active_severity: AlarmSeverity | null;
  };
  websocket: Record<string, unknown>;
  ingestion: { udp_enabled: boolean; udp_port: number | null; udp_bind: string | null };
  process: { rss_mb: number; heap_used_mb: number; heap_total_mb: number };
  trusted_output_read_only: boolean;
  control_output_note: string;
}

export interface GeoBundle {
  layers: Record<string, GeoJSON.FeatureCollection>;
  origin: { latitude: number; longitude: number };
  label: string;
  bathymetry_meta: {
    id: string;
    spacing_m: number;
    width: number;
    height: number;
    min_depth_m: number;
    max_depth_m: number;
    vertical_sigma_m: number;
    survey_date: string;
    resolution_note: string;
  };
  control_points: Array<{
    id: string;
    name: string;
    point_type: string;
    latitude: number;
    longitude: number;
    accuracy_m: number;
  }>;
  radar_feature_count: number;
  lidar_feature_count: number;
}


/** One vessel in the monitored fleet. */
export interface FleetVessel {
  vessel_id: string;
  name: string;
  type: string | null;
  call_sign: string | null;
  mmsi: number | null;
  scenario_id: string;
  scenario_name: string | null;
  sim_time_s: number | null;
  position: { latitude: number; longitude: number } | null;
  heading_deg: number | null;
  speed_mps: number | null;
  course_deg: number | null;
  navigation_mode: NavigationMode | null;
  mode_label: string | null;
  operator_guidance: string | null;
  solution_available: boolean;
  requirement_status: RequirementStatus | null;
  integrity_status: IntegrityStatus | null;
  horizontal_protection_level_m: number | null;
  requirement_limit_m: number | null;
  independent_absolute_sources: number;
  protection_level_growth_rate_m_per_s: number | null;
  dead_reckoning_duration_s: number | null;
  gnss_trust_score: number | null;
  gnss_status: GnssTrustStatus | null;
  gnss_spoofing_suspected: boolean;
  gnss_jamming_suspected: boolean;
  contributing_sensors: string[];
  excluded_sensors: string[];
  ground_truth: { latitude: number; longitude: number } | null;
  actual_error_m: number | null;
}

export interface FleetSnapshot {
  running: boolean;
  broadcast_interval_s: number;
  configured_vessels?: number;
  counts: {
    total: number;
    requirement_met: number;
    requirement_at_risk: number;
    requirement_not_met: number;
    integrity_not_assured: number;
    gnss_rejected: number;
    under_attack: number;
  };
  vessels: FleetVessel[];
}


/** A managed vessel record. */
export interface Vessel {
  id: string;
  name: string;
  vessel_type: string | null;
  call_sign: string | null;
  mmsi: number | null;
  imo: number | null;
  flag: string | null;
  operator: string | null;
  dimensions: { length_m: number | null; beam_m: number | null; draft_m: number | null };
  scenario_id: string | null;
  scenario_name: string | null;
  start_offset_s: number;
  station_offset: { east_m: number; north_m: number };
  focused: boolean;
  monitored: boolean;
  sensor_configuration: Record<string, { fitted?: boolean; notes?: string | null }>;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface VesselSensorFit {
  sensor_id: string;
  sensor_type: string;
  name: string;
  absolute_position_source: boolean;
  fitted: boolean;
  notes: string | null;
}

export interface VesselListResponse {
  items: Vessel[];
  total: number;
  reference: {
    scenarios: Array<{ id: string; name: string; category: string }>;
    sensors: Array<{ sensor_id: string; sensor_type: string; name: string; absolute_position_source: boolean }>;
  };
}


/** Whether the published UTC timestamp can be relied upon, and on what basis. */
export interface TimeIntegrity {
  utc_source: 'GNSS' | 'HOLDOVER' | 'UNKNOWN';
  utc_trusted: boolean;
  utc_error_bound_s: number | null;
  required_accuracy_s: number;
  holdover_duration_s: number;
  last_trusted_reference_age_s: number | null;
  measured_gnss_offset_s: number | null;
  reasons: string[];
}
