/**
 * Data export (Section 21).
 *
 * Formats: CSV, JSON, GeoJSON, KML, and an HTML report that any browser will
 * print to PDF. A native PDF writer is deliberately not included - it would add
 * a heavyweight dependency to produce a worse document than the browser's own
 * print pipeline, and the specification asks only for a PDF placeholder.
 *
 * Every export carries the demonstration disclaimer, so a file that leaves the
 * platform cannot be mistaken for navigational data.
 */

import { rows } from '../db/pool.js';
import { getConfig } from '../config/index.js';
import { performanceService } from './performanceService.js';
import { DEMONSTRATION_LABEL } from '../geospatial/environment.js';

/** RFC 4180 CSV escaping. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `"${value.join('; ').replace(/"/g, '""')}"`;
  if (typeof value === 'object') return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(records, columns = null) {
  if (!records.length) return '';
  const cols = columns ?? Object.keys(records[0]);
  const lines = [cols.join(',')];
  for (const record of records) lines.push(cols.map((c) => csvCell(record[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export class ExportService {
  /** Named datasets available for export. */
  datasets() {
    return [
      { id: 'navigation', label: 'Trusted navigation solutions', formats: ['csv', 'json', 'geojson', 'kml'] },
      { id: 'ground_truth', label: 'Ground-truth reference track', formats: ['csv', 'json', 'geojson', 'kml'] },
      { id: 'sensor_messages', label: 'Raw normalized sensor messages', formats: ['csv', 'json'] },
      { id: 'gnss_trust', label: 'GNSS trust assessments', formats: ['csv', 'json'] },
      { id: 'residuals', label: 'Filter residuals', formats: ['csv', 'json'] },
      { id: 'alarms', label: 'Alarms', formats: ['csv', 'json'] },
      { id: 'mode_transitions', label: 'Navigation mode transitions', formats: ['csv', 'json'] },
      { id: 'scenario_events', label: 'Scenario events and fault injections', formats: ['csv', 'json'] },
      { id: 'sensor_health', label: 'Sensor health snapshots', formats: ['csv', 'json'] },
      { id: 'audit', label: 'Audit log', formats: ['csv', 'json'] },
      { id: 'report', label: 'Performance report', formats: ['json', 'html'] }
    ];
  }

  async fetchDataset(dataset, runId, { limit = 200000 } = {}) {
    switch (dataset) {
      case 'navigation':
        return rows('SELECT * FROM navigation_solutions WHERE run_id = $1 ORDER BY sim_time_s LIMIT $2', [runId, limit]);
      case 'ground_truth':
        return rows('SELECT * FROM ground_truth WHERE run_id = $1 ORDER BY sim_time_s LIMIT $2', [runId, limit]);
      case 'sensor_messages':
        return rows('SELECT * FROM sensor_messages WHERE run_id = $1 ORDER BY sim_time_s, id LIMIT $2', [runId, limit]);
      case 'gnss_trust':
        return rows('SELECT * FROM gnss_trust_records WHERE run_id = $1 ORDER BY sim_time_s LIMIT $2', [runId, limit]);
      case 'residuals':
        return rows('SELECT * FROM sensor_residuals WHERE run_id = $1 ORDER BY sim_time_s, id LIMIT $2', [runId, limit]);
      case 'alarms':
        return rows('SELECT * FROM alarms WHERE run_id = $1 ORDER BY raised_at LIMIT $2', [runId, limit]);
      case 'mode_transitions':
        return rows('SELECT * FROM mode_transitions WHERE run_id = $1 ORDER BY sim_time_s LIMIT $2', [runId, limit]);
      case 'scenario_events':
        return rows('SELECT * FROM scenario_events WHERE run_id = $1 ORDER BY sim_time_s LIMIT $2', [runId, limit]);
      case 'sensor_health':
        return rows('SELECT * FROM sensor_health_snapshots WHERE run_id = $1 ORDER BY sim_time_s LIMIT $2', [runId, limit]);
      case 'audit':
        return rows('SELECT * FROM audit_log ORDER BY occurred_at DESC LIMIT $1', [Math.min(limit, 50000)]);
      default:
        throw Object.assign(new Error(`Unknown dataset: ${dataset}`), { status: 400 });
    }
  }

  /** GeoJSON export of a positional dataset. */
  async toGeoJson(dataset, runId) {
    const records = await this.fetchDataset(dataset, runId);
    const positional = records.filter((r) => r.latitude !== null && r.longitude !== null);
    const line = {
      type: 'Feature',
      properties: { name: `${dataset} track`, dataset, run_id: runId, demonstration_only: true, label: DEMONSTRATION_LABEL },
      geometry: {
        type: 'LineString',
        coordinates: positional.map((r) => [Number(r.longitude), Number(r.latitude)])
      }
    };
    // Every tenth point carries its full attributes so the track can be
    // interrogated without producing a feature per epoch.
    const points = positional
      .filter((_, i) => i % 10 === 0)
      .map((r) => ({
        type: 'Feature',
        properties: { ...r, demonstration_only: true },
        geometry: { type: 'Point', coordinates: [Number(r.longitude), Number(r.latitude)] }
      }));
    return {
      type: 'FeatureCollection',
      properties: {
        dataset,
        run_id: runId,
        generated_at: new Date().toISOString(),
        demonstration_only: true,
        label: DEMONSTRATION_LABEL,
        disclaimer: getConfig().platform.disclaimer
      },
      features: positional.length ? [line, ...points] : []
    };
  }

  /** KML export (optional per the specification). */
  async toKml(dataset, runId) {
    const records = await this.fetchDataset(dataset, runId);
    const positional = records.filter((r) => r.latitude !== null && r.longitude !== null);
    const coords = positional.map((r) => `${r.longitude},${r.latitude},0`).join(' ');
    const escape = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escape(dataset)} - run ${escape(runId)}</name>
    <description>${escape(DEMONSTRATION_LABEL)} ${escape(getConfig().platform.disclaimer)}</description>
    <Style id="trackStyle">
      <LineStyle><color>ff33c1ff</color><width>3</width></LineStyle>
    </Style>
    <Placemark>
      <name>${escape(dataset)} track</name>
      <styleUrl>#trackStyle</styleUrl>
      <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;
  }

  /**
   * Printable HTML performance report. The browser's own print-to-PDF produces
   * a better document than a bundled PDF writer would, so this stands in for
   * the PDF placeholder the specification asks for.
   */
  async toHtmlReport(runId) {
    const report = await performanceService.buildReport(runId);
    const s = report.summary;
    const esc = (v) => String(v ?? '-').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
    const row = (label, value, note = '') =>
      `<tr><th>${esc(label)}</th><td>${esc(value)}</td><td class="note">${esc(note)}</td></tr>`;

    const modeRows = Object.entries(report.mode_durations)
      .sort((a, b) => b[1].seconds - a[1].seconds)
      .map(([mode, v]) => `<tr><td>${esc(mode)}</td><td>${v.seconds} s</td><td>${v.pct} %</td></tr>`)
      .join('');
    const sensorRows = Object.entries(report.sensor_availability)
      .sort((a, b) => b[1].availability_pct - a[1].availability_pct)
      .map(([id, v]) => `<tr><td>${esc(id)}</td><td>${v.epochs}</td><td>${v.availability_pct} %</td></tr>`)
      .join('');
    const alarmRows = report.alarms
      .slice(0, 200)
      .map(
        (a) =>
          `<tr><td>${a.sim_time_s?.toFixed?.(1) ?? '-'}</td><td class="sev-${esc(a.severity)}">${esc(a.severity)}</td><td>${esc(a.code)}</td><td>${esc(a.message)}</td><td>${esc(a.reason)}</td></tr>`
      )
      .join('');
    const transitionRows = report.mode_timeline
      .map(
        (t) =>
          `<tr><td>${t.sim_time_s?.toFixed?.(1)}</td><td>${esc(t.from_mode)}</td><td>${esc(t.to_mode)}</td><td>${esc(t.reason)}</td></tr>`
      )
      .join('');

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Performance Report - ${esc(s.scenario_name)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 32px; color: #0f172a; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: .08em; color: #475569; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; }
  .sub { color: #64748b; font-size: 13px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin-bottom: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { width: 32%; font-weight: 600; color: #334155; }
  .note { color: #64748b; font-size: 12px; }
  .banner { background: #0f172a; color: #f8fafc; padding: 14px 18px; border-radius: 8px; margin-bottom: 20px; }
  .banner .verdict { font-size: 18px; font-weight: 700; letter-spacing: .02em; }
  .warn { background: #fef3c7; border-left: 4px solid #d97706; padding: 10px 14px; margin: 16px 0; font-size: 13px; }
  .sev-CRITICAL { color: #b91c1c; font-weight: 700; }
  .sev-WARNING { color: #c2410c; font-weight: 600; }
  .sev-ADVISORY { color: #a16207; }
  .sev-INFO { color: #475569; }
  @media print { body { margin: 12mm; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style></head><body>
<div class="banner">
  <div style="font-size:12px;letter-spacing:.14em;opacity:.75">iSPATIALTEC ASSURED MARINE NAVIGATION PLATFORM</div>
  <div class="verdict">${esc(s.compliance_result)}</div>
  <div style="font-size:12px;opacity:.8;margin-top:4px">${esc(s.scenario_name)} &middot; run ${esc(s.run_id)}</div>
</div>
<h1>Scenario Performance Report</h1>
<div class="sub">Generated ${new Date().toISOString()}</div>
<div class="warn"><strong>${esc(getConfig().platform.classification)}.</strong> ${esc(getConfig().platform.disclaimer)}</div>

<h2>Run</h2>
<table>
${row('Scenario', `${s.scenario_name} (${s.scenario_id})`)}
${row('Run identifier', s.run_id)}
${row('Started', s.start_time)}
${row('Ended', s.end_time ?? 'still running')}
${row('Total duration', `${s.total_duration_s} s`)}
${row('Epochs analysed', s.epochs, `at ${s.epoch_interval_s} s intervals`)}
${row('Random seed', s.seed, 'The same seed reproduces this run exactly.')}
${row('INS fitted', s.ins_enabled ? 'yes' : 'no')}
</table>

<h2>Position error - three distinct quantities</h2>
<table>
${row('ACTUAL mean error', `${s.actual_error.mean_m} m`, s.actual_error.source)}
${row('ACTUAL median error', `${s.actual_error.median_m} m`)}
${row('ACTUAL RMS error', `${s.actual_error.rms_m} m`)}
${row('ACTUAL 95th percentile', `${s.actual_error.p95_m} m`)}
${row('ACTUAL 99th percentile', `${s.actual_error.p99_m} m`)}
${row('ACTUAL maximum error', `${s.actual_error.max_m} m`)}
${row('ESTIMATED mean error', `${s.estimated_error.mean_m} m`, s.estimated_error.source)}
${row('PROTECTION LEVEL mean', `${s.protection_level.mean_m} m`, s.protection_level.source)}
${row('PROTECTION LEVEL maximum', `${s.protection_level.max_m} m`)}
${row('Raw GNSS mean error', `${s.gnss_error.mean_m} m`, s.gnss_error.source)}
${row('Raw GNSS maximum error', `${s.gnss_error.max_m} m`)}
</table>

<h2>Requirement compliance</h2>
<table>
${row('Requirement limit', `${s.requirement_limit_m} m horizontal`)}
${row('Time actually below the limit', `${s.time_below_limit_pct} %`)}
${row('Time actually above the limit', `${s.time_above_limit_pct} %`)}
${row('Reported REQUIREMENT MET', `${s.requirement_met_pct} %`)}
${row('Reported REQUIREMENT AT RISK', `${s.requirement_at_risk_pct} %`)}
${row('Reported REQUIREMENT NOT MET', `${s.requirement_not_met_pct} %`)}
${row('Reported INSUFFICIENT INFORMATION', `${s.insufficient_information_pct} %`)}
${row('Integrity ASSURED', `${s.integrity_assured_pct} %`)}
${row('Solution availability', `${s.solution_availability_pct} %`)}
</table>

<h2>Integrity performance</h2>
<table>
${row('Epochs where actual error exceeded the protection level', `${s.protection_level_exceeded_count} (${s.protection_level_exceeded_pct} %)`)}
${row('Misleading information epochs', `${s.misleading_information_count} (${s.misleading_information_pct} %)`, s.misleading_information_note)}
${row('False attack alarms', s.false_alarm_count, 'Attack alarms raised with no GNSS fault scripted.')}
</table>

<h2>Event timing</h2>
<table>
${row('First scripted GNSS fault', s.first_gnss_fault_at_s === null ? 'none' : `${s.first_gnss_fault_at_s} s`)}
${row('Spoofing detected at', s.spoofing_detection_time_s === null ? 'not detected' : `${s.spoofing_detection_time_s} s`)}
${row('Spoofing detection latency', s.spoofing_detection_latency_s === null ? '-' : `${s.spoofing_detection_latency_s} s`)}
${row('Jamming detected at', s.jamming_detection_time_s === null ? 'not detected' : `${s.jamming_detection_time_s} s`)}
${row('GNSS rejected at', s.gnss_rejection_time_s === null ? 'not rejected' : `${s.gnss_rejection_time_s} s`)}
${row('GNSS rejection latency', s.gnss_rejection_latency_s === null ? '-' : `${s.gnss_rejection_latency_s} s`)}
${row('GNSS reintegrated at', s.gnss_recovery_time_s === null ? 'not reintegrated' : `${s.gnss_recovery_time_s} s`)}
${row('GNSS outage duration', `${s.gnss_outage_duration_s} s (${s.gnss_outage_pct} % of the run)`)}
</table>

<h2>Navigation mode durations</h2>
<table><tr><th>Mode</th><th>Duration</th><th>Share</th></tr>${modeRows}</table>

<h2>Sensor availability</h2>
<table><tr><th>Sensor</th><th>Contributing epochs</th><th>Availability</th></tr>${sensorRows}</table>

<h2>Mode transitions (${report.mode_timeline.length})</h2>
<table><tr><th>Time</th><th>From</th><th>To</th><th>Reason</th></tr>${transitionRows}</table>

<h2>Alarms (${report.alarms.length}${report.alarms.length > 200 ? ', first 200 shown' : ''})</h2>
<table><tr><th>Time</th><th>Severity</th><th>Code</th><th>Message</th><th>Reason</th></tr>${alarmRows}</table>

<p class="note" style="margin-top:32px">${esc(DEMONSTRATION_LABEL)} This report describes a simulation. Field performance depends on vessel type, sensor installation, gyro quality, DVL availability and bottom lock, radar field of view, map quality, bathymetric survey age, tide, sound velocity, seabed distinctiveness, weather, sea state, sensor latency, operating area and outage duration.</p>
</body></html>`;
  }
}

export const exportService = new ExportService();
export default exportService;
