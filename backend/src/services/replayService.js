/**
 * Replay of recorded data (Sections 8, 15.6 and 32 Phase 2).
 *
 * Two sources:
 *   - an uploaded CSV or JSON file of internal sensor messages
 *   - a previously recorded scenario run, replayed from the database
 *
 * A replay drives the *same* navigation pipeline as the live simulator, which
 * is the point: the platform's behaviour on recorded vessel data must be
 * identical to its behaviour in the demonstration. What a replay cannot
 * provide is ground truth, so accuracy statistics are simply absent rather
 * than fabricated - the report says so explicitly.
 */

import { EventEmitter } from 'node:events';
import { one, query, rows, withTransaction } from '../db/pool.js';
import { parseCsv, parseJson } from '../adapters/index.js';
import { NavigationPipeline } from '../navigation/pipeline.js';
import { buildEnvironment } from '../geospatial/environment.js';
import { getConfig } from '../config/index.js';
import { alarmService } from './alarmService.js';
import { recorder } from './recorder.js';
import { ScenarioState } from '../models/enums.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('replay');

const LOOP_INTERVAL_MS = 100;

export class ReplayService extends EventEmitter {
  constructor() {
    super();
    this.session = null;
    this.pipeline = null;
    this.state = ScenarioState.IDLE;
    this.timer = null;
    this.speedMultiplier = 1;
    this.cursor = 0;
    this.messages = [];
    this.time = 0;
    this.runId = null;
    this.lastOutput = null;
  }

  /**
   * Import an uploaded file into a replay session.
   *
   * @param {object} args
   * @param {string} args.name
   * @param {string} args.content raw file text
   * @param {'csv'|'json'} args.format
   * @param {string} [args.userId]
   */
  async importFile({ name, content, format, userId = null, defaultSensorId, defaultSensorType }) {
    const parsed =
      format === 'csv'
        ? parseCsv(content, { defaultSensorId, defaultSensorType })
        : parseJson(content);

    if (parsed.messages.length === 0) {
      throw Object.assign(
        new Error(`No valid sensor messages found. ${parsed.errors.slice(0, 3).join(' ')}`),
        { status: 400 }
      );
    }

    // Sort by timestamp and derive a relative time base, so a file recorded on
    // any date replays from t = 0.
    const withTimes = parsed.messages
      .map((m) => ({ message: m, epochMs: Date.parse(m.timestamp_utc) }))
      .sort((a, b) => a.epochMs - b.epochMs);
    const baseMs = withTimes[0].epochMs;
    const items = withTimes.map((w) => ({ sim_time_s: (w.epochMs - baseMs) / 1000, message: w.message }));

    const session = await withTransaction(async (client) => {
      const created = await client.query(
        `INSERT INTO replay_sessions (name, source_type, message_count, start_time_s, end_time_s, uploaded_by, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          name,
          format.toUpperCase(),
          items.length,
          0,
          items[items.length - 1].sim_time_s,
          userId,
          JSON.stringify({
            parse_errors: parsed.errors.slice(0, 50),
            parse_error_count: parsed.errors.length,
            base_timestamp_utc: new Date(baseMs).toISOString(),
            sensors: [...new Set(items.map((i) => i.message.sensor_id))],
            has_ground_truth: items.some((i) => i.message.sensor_type === 'GROUND_TRUTH')
          })
        ]
      );
      const sessionRow = created.rows[0];

      // Bulk insert in bounded chunks.
      const chunkSize = 2000;
      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const values = [];
        const tuples = chunk.map((item, j) => {
          values.push(sessionRow.id, item.sim_time_s, JSON.stringify(item.message));
          return `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}::jsonb)`;
        });
        await client.query(
          `INSERT INTO replay_messages (session_id, sim_time_s, message) VALUES ${tuples.join(',')}`,
          values
        );
      }
      return sessionRow;
    });

    log.info('replay session imported', { id: session.id, messages: items.length, format });
    return {
      ...session,
      parse_errors: parsed.errors.slice(0, 20),
      parse_error_count: parsed.errors.length
    };
  }

  /** Create a replay session from a previously recorded run. */
  async importFromRun(runId, { name = null, userId = null } = {}) {
    const run = await one(
      'SELECT r.*, s.name AS scenario_name FROM scenario_runs r JOIN scenarios s ON s.id = r.scenario_id WHERE r.id = $1',
      [runId]
    );
    if (!run) throw Object.assign(new Error('Run not found.'), { status: 404 });

    const messages = await rows(
      `SELECT sim_time_s, sensor_id, sensor_type, timestamp_utc, sequence_number, latitude, longitude,
              altitude_m, velocity_north_mps, velocity_east_mps, velocity_down_mps, heading_deg,
              depth_m, quality, raw, valid
       FROM sensor_messages WHERE run_id = $1 ORDER BY sim_time_s, id`,
      [runId]
    );
    if (messages.length === 0) {
      throw Object.assign(new Error('That run has no recorded sensor messages to replay.'), { status: 400 });
    }

    const session = await withTransaction(async (client) => {
      const created = await client.query(
        `INSERT INTO replay_sessions (name, source_type, source_run_id, message_count, start_time_s, end_time_s, uploaded_by, metadata)
         VALUES ($1,'RUN',$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          name ?? `${run.scenario_name} replay`,
          runId,
          messages.length,
          messages[0].sim_time_s,
          messages[messages.length - 1].sim_time_s,
          userId,
          JSON.stringify({ scenario_id: run.scenario_id, seed: run.seed, source: 'RECORDED_RUN' })
        ]
      );
      const sessionRow = created.rows[0];
      const chunkSize = 2000;
      for (let i = 0; i < messages.length; i += chunkSize) {
        const chunk = messages.slice(i, i + chunkSize);
        const values = [];
        const tuples = chunk.map((m, j) => {
          values.push(sessionRow.id, m.sim_time_s, JSON.stringify(rowToMessage(m)));
          return `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}::jsonb)`;
        });
        await client.query(
          `INSERT INTO replay_messages (session_id, sim_time_s, message) VALUES ${tuples.join(',')}`,
          values
        );
      }
      return sessionRow;
    });
    return session;
  }

  async listSessions() {
    return rows(
      `SELECT s.*, u.username AS uploaded_by_username
       FROM replay_sessions s LEFT JOIN users u ON u.id = s.uploaded_by
       ORDER BY s.created_at DESC LIMIT 200`
    );
  }

  async getSession(id) {
    const session = await one('SELECT * FROM replay_sessions WHERE id = $1', [id]);
    if (!session) throw Object.assign(new Error('Replay session not found.'), { status: 404 });
    return session;
  }

  async deleteSession(id) {
    const result = await query('DELETE FROM replay_sessions WHERE id = $1', [id]);
    if (result.rowCount === 0) throw Object.assign(new Error('Replay session not found.'), { status: 404 });
    return { deleted: true };
  }

  /** Start replaying a session through the navigation pipeline. */
  async start(sessionId, { userId = null, speedMultiplier = 1 } = {}) {
    await this.stop();
    const session = await this.getSession(sessionId);
    const stored = await rows(
      'SELECT sim_time_s, message FROM replay_messages WHERE session_id = $1 ORDER BY sim_time_s, id',
      [sessionId]
    );
    if (stored.length === 0) throw Object.assign(new Error('That session contains no messages.'), { status: 400 });

    const environment = buildEnvironment();
    const baseMs = Date.parse(session.metadata?.base_timestamp_utc ?? new Date().toISOString());
    const epochMs = Number.isFinite(baseMs) ? baseMs : Date.now();

    this.session = session;
    this.messages = stored;
    this.cursor = 0;
    this.time = stored[0].sim_time_s;
    this.speedMultiplier = speedMultiplier;
    this.pipeline = new NavigationPipeline({
      environment,
      insEnabled: stored.some((s) => s.message.sensor_type === 'INS'),
      localRangingEnabled: stored.some((s) => s.message.sensor_type === 'LOCAL_RANGING'),
      epochMs
    });

    const run = await one(
      `INSERT INTO scenario_runs (scenario_id, run_label, state, seed, speed_multiplier, ins_enabled, started_by, notes)
       VALUES ($1,$2,'RUNNING',0,$3,TRUE,$4,$5) RETURNING id`,
      [
        session.source_run_id
          ? (await one('SELECT scenario_id FROM scenario_runs WHERE id = $1', [session.source_run_id]))?.scenario_id ??
            'SCN_01_HEALTHY'
          : 'SCN_01_HEALTHY',
        `REPLAY: ${session.name}`,
        speedMultiplier,
        userId,
        `Replay of session ${session.id}. Ground truth is ${session.metadata?.has_ground_truth ? 'present' : 'NOT available'} in this data.`
      ]
    );
    this.runId = run.id;
    recorder.start(this.runId);
    alarmService.startRun(this.runId);

    this.state = ScenarioState.RUNNING;
    this.lastTickWallMs = Date.now();
    this.startLoop();
    log.info('replay started', { session_id: sessionId, run_id: this.runId, messages: stored.length });
    return this.status();
  }

  startLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error('replay tick failed', err));
    }, LOOP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stopLoop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    if (this.state !== ScenarioState.RUNNING || !this.pipeline) return;
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const now = Date.now();
      const wallDelta = (now - (this.lastTickWallMs ?? now)) / 1000;
      this.lastTickWallMs = now;
      const target = this.time + Math.min(5, wallDelta * this.speedMultiplier);
      const publishInterval = 1 / (getConfig().simulation.publish_hz || 5);

      while (this.time < target) {
        const nextEpoch = Math.min(target, this.time + publishInterval);
        while (this.cursor < this.messages.length && this.messages[this.cursor].sim_time_s <= nextEpoch) {
          const item = this.messages[this.cursor];
          this.pipeline.ingest(item.message, item.sim_time_s);
          recorder.recordSensorMessage(item.message, { simTimeS: item.sim_time_s, decision: null, reason: null });
          this.cursor += 1;
        }
        this.time = nextEpoch;
        const output = this.pipeline.step(this.time);
        output.replay_session_id = this.session.id;
        output.replay_progress = this.messages.length ? this.cursor / this.messages.length : 1;
        // A replay has no ground truth unless the recording carried it, so the
        // accuracy fields stay null rather than being invented.
        this.lastOutput = output;

        recorder.recordNavigationSolution(output);
        recorder.recordGnssTrust(output);
        recorder.recordSensorHealth(output);
        const raised = await alarmService.raiseAll(this.pipeline.drainAlarms());
        this.pipeline.drainMessageDecisions();
        this.emit('epoch', { output, alarms: raised, active_alarms: alarmService.snapshot(), replay: this.status() });
      }

      if (this.cursor >= this.messages.length) await this.complete();
    } finally {
      this.tickInFlight = false;
    }
  }

  async complete() {
    this.state = ScenarioState.COMPLETED;
    this.stopLoop();
    await recorder.flush();
    if (this.runId) {
      await query(
        "UPDATE scenario_runs SET state='COMPLETED', ended_at=now(), duration_s=$2 WHERE id=$1",
        [this.runId, this.time]
      );
    }
    this.emit('completed', { session_id: this.session?.id, run_id: this.runId });
  }

  async pause() {
    if (this.state !== ScenarioState.RUNNING) return this.status();
    this.state = ScenarioState.PAUSED;
    this.stopLoop();
    await recorder.flush();
    return this.status();
  }

  async resume() {
    if (this.state !== ScenarioState.PAUSED) return this.status();
    this.state = ScenarioState.RUNNING;
    this.lastTickWallMs = Date.now();
    this.startLoop();
    return this.status();
  }

  async stop() {
    this.stopLoop();
    if (this.runId) {
      await recorder.stop();
      await query(
        "UPDATE scenario_runs SET state='STOPPED', ended_at=now(), duration_s=$2 WHERE id=$1 AND ended_at IS NULL",
        [this.runId, this.time]
      );
    }
    this.state = this.session ? ScenarioState.STOPPED : ScenarioState.IDLE;
    this.runId = null;
    return this.status();
  }

  setSpeed(multiplier) {
    this.speedMultiplier = Math.max(0.1, Math.min(50, Number(multiplier) || 1));
    return this.status();
  }

  status() {
    return {
      state: this.state,
      session_id: this.session?.id ?? null,
      session_name: this.session?.name ?? null,
      run_id: this.runId,
      speed_multiplier: this.speedMultiplier,
      time_s: Number(this.time.toFixed(3)),
      cursor: this.cursor,
      message_count: this.messages.length,
      progress: this.messages.length ? Number((this.cursor / this.messages.length).toFixed(4)) : 0,
      has_ground_truth: Boolean(this.session?.metadata?.has_ground_truth)
    };
  }
}

/** Turn a recorded database row back into an internal sensor message. */
function rowToMessage(row) {
  return {
    sensor_id: row.sensor_id,
    sensor_type: row.sensor_type,
    timestamp_utc: new Date(row.timestamp_utc).toISOString(),
    sequence_number: Number(row.sequence_number),
    position:
      row.latitude === null || row.longitude === null
        ? null
        : { latitude: Number(row.latitude), longitude: Number(row.longitude), altitude_m: Number(row.altitude_m ?? 0) },
    velocity:
      row.velocity_north_mps === null && row.velocity_east_mps === null
        ? null
        : {
            north_mps: Number(row.velocity_north_mps ?? 0),
            east_mps: Number(row.velocity_east_mps ?? 0),
            down_mps: Number(row.velocity_down_mps ?? 0)
          },
    heading_deg: row.heading_deg === null ? null : Number(row.heading_deg),
    depth_m: row.depth_m === null ? null : Number(row.depth_m),
    quality: row.quality ?? {},
    raw: row.raw ?? {},
    valid: row.valid !== false
  };
}

export const replayService = new ReplayService();
export default replayService;
