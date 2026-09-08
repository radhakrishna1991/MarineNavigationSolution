/**
 * Test fixtures.
 *
 * A realistic navigation output, so the tests exercise the same shapes the
 * server actually produces rather than a convenient simplification.
 */

import type { Alarm, NavigationOutput, RequirementStatus, NavigationMode, IntegrityStatus } from '../src/types';

export function makeNavigation(overrides: Partial<NavigationOutput> = {}): NavigationOutput {
  const base: NavigationOutput = {
    time_s: 120.4,
    timestamp_utc: '2024-11-18T06:02:00.400Z',
    trusted_position: { latitude: 24.5102, longitude: 54.3501, east_m: 10.2, north_m: 22.4 },
    velocity: { north_mps: 3.2, east_mps: 0.4, speed_mps: 3.22 },
    course_deg: 7.1,
    heading_deg: 7.6,
    gyro_bias_deg: -0.04,
    speed_scale_factor: 1.002,
    solution_available: true,
    solution_confidence: 0.86,
    navigation_mode: 'NORMAL_GNSS' as NavigationMode,
    navigation_mode_detail: {
      mode: 'NORMAL_GNSS' as NavigationMode,
      label: 'Normal GNSS',
      description: 'GNSS is healthy and agrees with the independent sensors.',
      entered_at_s: 4.2,
      duration_s: 116.2,
      active_sensors: ['GNSS', 'RADAR', 'GYRO', 'DVL'],
      rejected_sensors: [],
      expected_accuracy: '0.5 - 2 m',
      uncertainty_behaviour: 'Bounded and stable',
      operator_alarm: 'INFO',
      operator_guidance: 'Normal operation. No action required.',
      exit_conditions: 'GNSS trust falls, or an anomaly is detected.',
      next_modes: ['GNSS_DEGRADED' as NavigationMode]
    },
    integrity: {
      time_s: 120.4,
      sigma_east_m: 0.21,
      sigma_north_m: 0.19,
      drms_m: 0.28,
      confidence_ellipse: {
        semi_major_m: 0.52,
        semi_minor_m: 0.46,
        orientation_deg: 42.1,
        confidence: 0.95,
        one_sigma_major_m: 0.213,
        one_sigma_minor_m: 0.188
      },
      radius_95_m: 0.52,
      radius_99_m: 0.65,
      horizontal_protection_level_m: 1.14,
      vertical_protection_level_m: null,
      vertical_protection_level_status: 'NOT_IMPLEMENTED_NO_INDEPENDENT_VERTICAL_REFERENCE',
      estimated_horizontal_error_m: 0.25,
      protection_level_inflation: 1,
      protection_level_inflation_reasons: [],
      bias_margin_m: 0.19,
      correlated_sigma_m: 0.36,
      protection_level_growth_rate_m_per_s: 0.001,
      integrity_status: 'ASSURED' as IntegrityStatus,
      integrity_reasons: [],
      solution_available: true,
      solution_age_s: 0.1,
      time_since_last_absolute_fix_s: 0.2,
      last_absolute_fix_source: 'GNSS_01, RADAR_01',
      dead_reckoning_duration_s: 0,
      independent_absolute_sources: 2,
      absolute_source_ids: ['GNSS_01', 'RADAR_01'],
      sensor_diversity_score: 0.8,
      measurement_principles: ['RADIO_NAVIGATION_SATELLITE', 'RADIO_IMAGING', 'ACOUSTIC_DOPPLER', 'INERTIAL_HEADING'],
      fault_detection_status: 'NO_FAULTS',
      fault_count: 0,
      requirement_status: 'REQUIREMENT_MET' as RequirementStatus,
      requirement_reasons: ['Protection level 1.14 m is within the 2 m limit at 95% confidence.'],
      requirement_limit_m: 2,
      requirement_confidence: 0.95,
      requirement_margin_m: 0.86,
      requirement_statement: 'Horizontal position error is bounded below 2 m at 95% confidence.'
    },
    gnss: {
      trust_score: 100,
      status: 'TRUSTED',
      recommended_action: 'USE_IN_FUSION',
      detected_conditions: [],
      pending_conditions: [],
      spoofing_suspected: false,
      jamming_suspected: false,
      used_in_fusion: true,
      explanation: 'GNSS is consistent with all independent measurements.',
      recovery: null,
      diagnostics: {
        diff_from_fused_m: 0.42,
        diff_from_radar_m: 1.1,
        diff_from_lidar_m: null,
        diff_from_bathy_m: null,
        diff_from_dr_m: 0.5,
        time_offset_s: -0.2,
        drag_rate_m_per_s: 0.001,
        drag_r2: 0.02,
        signal_degraded: false
      },
      quality: {
        satellites: 14,
        hdop: 0.82,
        pdop: 1.56,
        cn0_mean_dbhz: 45.3,
        fix_type: 'RTK_FIXED',
        reported_accuracy_m: 1.28
      },
      reported_position: { latitude: 24.51022, longitude: 54.35012, altitude_m: 1.6 },
      error_vs_truth_m: 0.61
    },
    localization: {
      radar: {
        available: true,
        valid: true,
        reason: 'OK',
        latitude: 24.51019,
        longitude: 54.35008,
        east_m: 9.8,
        north_m: 21.9,
        heading_deg: 7.4,
        sigma_m: 1.31,
        confidence: 0.92,
        match_score: 0.92,
        residual_m: 0.98,
        inliers: 194,
        matched_features: 210,
        selected_mode: 'MODE_A',
        selection_reason: 'Vendor-supplied fix used.',
        stale: false
      },
      lidar: { available: true, valid: false, reason: 'INSUFFICIENT_FEATURES', confidence: 0 },
      bathymetric: {
        available: true,
        valid: false,
        reason: 'AMBIGUOUS_MULTIPLE_CANDIDATES',
        confidence: 0.04,
        ambiguity_score: 0.94,
        terrain_observability: 0.31,
        candidate_count: 441,
        mode_count: 14,
        top_candidates: []
      },
      local_ranging: { available: false, valid: false },
      dead_reckoning: {
        east_m: 10.1,
        north_m: 22.2,
        latitude: 24.5102,
        longitude: 54.35009,
        heading_deg: 7.6,
        speed_mps: 3.2,
        sigma_m: 0.42,
        duration_s: 0.2,
        anchor_time_s: 120.2,
        bottom_lock: true,
        velocity_source: 'DVL_01',
        dominant_error_source: 'ANCHOR_UNCERTAINTY'
      }
    },
    contributing_sensors: ['DVL_01', 'GNSS_01', 'GYRO_01', 'RADAR_01'],
    excluded_sensors: [],
    absolute_sources: [
      { sensor_id: 'GNSS_01', sensor_type: 'GNSS', sigma_m: 0.9, confidence: 1 },
      { sensor_id: 'RADAR_01', sensor_type: 'RADAR', sigma_m: 1.31, confidence: 0.92 }
    ],
    sensor_health: [
      {
        sensor_id: 'GNSS_01',
        sensor_type: 'GNSS',
        online: true,
        last_update_s: 120.3,
        data_age_s: 0.1,
        update_rate_hz: 5,
        nominal_rate_hz: 5,
        message_count: 601,
        accepted_count: 598,
        rejected_count: 0,
        duplicate_count: 0,
        out_of_order_count: 0,
        gate_failures: 0,
        residual_rms: 0.94,
        normalized_residual_rms: 0.98,
        chi_square: 74,
        chi_square_threshold: 369,
        excluded: false,
        exclusion_reason: null,
        exclusion_category: null,
        faults: [],
        decision: 'ACCEPTED',
        reason: null
      },
      {
        sensor_id: 'RADAR_01',
        sensor_type: 'RADAR',
        online: true,
        last_update_s: 120.0,
        data_age_s: 0.4,
        update_rate_hz: 2,
        nominal_rate_hz: 2,
        message_count: 240,
        accepted_count: 238,
        rejected_count: 0,
        duplicate_count: 0,
        out_of_order_count: 0,
        gate_failures: 0,
        residual_rms: 1.2,
        normalized_residual_rms: 1.1,
        chi_square: 120,
        chi_square_threshold: 369,
        excluded: false,
        exclusion_reason: null,
        exclusion_category: null,
        faults: [],
        decision: 'ACCEPTED',
        reason: null
      }
    ],
    ais_contacts: [],
    ground_truth: {
      latitude: 24.51018,
      longitude: 54.35007,
      heading_deg: 7.59,
      speed_mps: 3.2,
      depth_m: 12.4,
      zone: 'CHANNEL'
    },
    actual_error_vs_truth_m: 0.33,
    fusion_debug: { residuals: [], velocity_noise_scale: 1, update_count: 1200 }
  };
  return { ...base, ...overrides };
}

export function makeAlarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    id: 'alarm-1',
    code: 'GNSS_SPOOFING_DETECTED',
    severity: 'CRITICAL',
    source: 'GNSS_01',
    message: 'GNSS spoofing detected - GNSS excluded',
    reason: 'GNSS is not trusted because it differs from radar localization by 38.4 m.',
    recommended_action: 'Do not use GNSS on any bridge system until investigated.',
    sim_time_s: 182.4,
    raised_at: '2024-11-18T06:03:02.400Z',
    acknowledged_at: null,
    active: true,
    occurrences: 1,
    ...overrides
  };
}
