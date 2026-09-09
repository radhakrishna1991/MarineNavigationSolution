/**
 * WebSocket hub for the live stream (Section 19).
 *
 * Streams sensor updates, the trusted navigation solution, alarms, mode
 * transitions, integrity status and scenario time.
 *
 * Two properties matter for a bridge display:
 *  - Back-pressure. If a client cannot keep up, frames are dropped for that
 *    client rather than queued, and the drop is counted. A stale display that
 *    is honest about being stale beats a display running minutes behind while
 *    memory grows.
 *  - Authentication. The socket is authenticated with the same JWT as the REST
 *    API, and ingestion over the socket requires the engineer role. A viewer
 *    can watch; only an authorised client can inject data.
 */

import { WebSocketServer } from 'ws';
import { verifyToken } from '../services/authService.js';
import { env, getConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ws');

/** Frame types the server emits. */
export const Frame = Object.freeze({
  HELLO: 'hello',
  NAVIGATION: 'navigation',
  ALARM: 'alarm',
  ALARMS: 'alarms',
  MODE_TRANSITION: 'mode_transition',
  SCENARIO: 'scenario',
  FLEET: 'fleet',
  REPLAY: 'replay',
  SENSORS: 'sensors',
  SYSTEM: 'system',
  ERROR: 'error',
  PONG: 'pong'
});

/** Channels a client can subscribe to. */
const ALL_CHANNELS = ['navigation', 'sensors', 'alarms', 'scenario', 'system', 'replay', 'fleet'];

const MAX_CLIENT_BUFFER_BYTES = 1 * 1024 * 1024;

export class LiveHub {
  constructor() {
    this.wss = null;
    this.clients = new Map();
    this.stats = { connected: 0, total_connections: 0, frames_sent: 0, frames_dropped: 0 };
    this.heartbeat = null;
  }

  /**
   * Attach to an HTTP server.
   * @param {import('node:http').Server} server
   * @param {(message: object, meta: object) => void} onIngest
   */
  attach(server, { onIngest = null, path = '/ws/live' } = {}) {
    this.onIngest = onIngest;
    this.wss = new WebSocketServer({ server, path, maxPayload: env.maxRequestBodyBytes });

    this.wss.on('connection', (socket, request) => this.handleConnection(socket, request));

    // Detect half-open connections: a bridge display on a flaky link must be
    // reaped rather than left counting as an active viewer.
    this.heartbeat = setInterval(() => {
      for (const [socket, state] of this.clients) {
        if (state.alive === false) {
          socket.terminate();
          continue;
        }
        state.alive = false;
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }
    }, 30000);
    this.heartbeat.unref?.();

    log.info('websocket hub attached', { path });
    return this;
  }

  handleConnection(socket, request) {
    const url = new URL(request.url, 'http://localhost');
    const token = url.searchParams.get('token');
    let user = null;

    if (token) {
      try {
        const claims = verifyToken(token);
        user = { id: claims.sub, username: claims.username, role: claims.role, name: claims.name };
      } catch (err) {
        this.send(socket, { type: Frame.ERROR, error: 'INVALID_TOKEN', message: 'Authentication failed.' });
        socket.close(4401, 'Invalid token');
        return;
      }
    } else if (!env.allowAnonymousViewer) {
      this.send(socket, {
        type: Frame.ERROR,
        error: 'AUTHENTICATION_REQUIRED',
        message: 'Supply a bearer token as the `token` query parameter.'
      });
      socket.close(4401, 'Authentication required');
      return;
    }

    const state = {
      user,
      alive: true,
      channels: new Set(ALL_CHANNELS),
      connectedAt: new Date().toISOString(),
      dropped: 0,
      sent: 0
    };
    this.clients.set(socket, state);
    this.stats.connected = this.clients.size;
    this.stats.total_connections += 1;

    socket.on('pong', () => {
      state.alive = true;
    });
    socket.on('close', () => {
      this.clients.delete(socket);
      this.stats.connected = this.clients.size;
    });
    socket.on('error', (err) => log.warn('client socket error', { message: err.message }));
    socket.on('message', (data) => this.handleClientMessage(socket, state, data));

    this.send(socket, {
      type: Frame.HELLO,
      server_time: new Date().toISOString(),
      user: user ? { username: user.username, role: user.role, name: user.name } : null,
      channels: ALL_CHANNELS,
      platform: {
        name: getConfig().platform.name,
        version: getConfig().platform.version,
        classification: getConfig().platform.classification,
        disclaimer: getConfig().platform.disclaimer
      }
    });
  }

  handleClientMessage(socket, state, data) {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      this.send(socket, { type: Frame.ERROR, error: 'BAD_FRAME', message: 'Frames must be JSON.' });
      return;
    }

    switch (payload.type) {
      case 'ping':
        this.send(socket, { type: Frame.PONG, server_time: new Date().toISOString() });
        break;

      case 'subscribe': {
        const requested = Array.isArray(payload.channels) ? payload.channels : ALL_CHANNELS;
        state.channels = new Set(requested.filter((c) => ALL_CHANNELS.includes(c)));
        this.send(socket, { type: Frame.HELLO, channels: [...state.channels], subscribed: true });
        break;
      }

      case 'ingest': {
        // Sensor ingestion over the UI socket requires an engineer. This keeps
        // the "separation between sensor ingestion and UI access" requirement
        // meaningful even on a shared transport.
        if (!state.user || !['engineer', 'administrator'].includes(state.user.role)) {
          this.send(socket, {
            type: Frame.ERROR,
            error: 'FORBIDDEN',
            message: 'Sensor ingestion requires the engineer role.'
          });
          return;
        }
        const messages = Array.isArray(payload.messages) ? payload.messages : [payload.message];
        let accepted = 0;
        const errors = [];
        for (const message of messages) {
          const result = this.onIngest?.(message, { via: 'websocket', user: state.user.username });
          if (result?.ok) accepted += 1;
          else errors.push(...(result?.errors ?? ['Ingestion is not available.']));
        }
        this.send(socket, { type: 'ingest_result', accepted, rejected: messages.length - accepted, errors: errors.slice(0, 10) });
        break;
      }

      default:
        this.send(socket, { type: Frame.ERROR, error: 'UNKNOWN_FRAME', message: `Unknown frame type: ${payload.type}` });
    }
  }

  /** Send to one client, dropping rather than queueing under back-pressure. */
  send(socket, payload) {
    if (socket.readyState !== socket.OPEN) return false;
    const state = this.clients.get(socket);
    if (socket.bufferedAmount > MAX_CLIENT_BUFFER_BYTES) {
      this.stats.frames_dropped += 1;
      if (state) state.dropped += 1;
      return false;
    }
    try {
      socket.send(JSON.stringify(payload));
      this.stats.frames_sent += 1;
      if (state) state.sent += 1;
      return true;
    } catch (err) {
      log.warn('send failed', { message: err.message });
      return false;
    }
  }

  /** Broadcast to every client subscribed to `channel`. */
  broadcast(channel, payload) {
    const frame = { ...payload, channel, server_time: new Date().toISOString() };
    for (const [socket, state] of this.clients) {
      if (!state.channels.has(channel)) continue;
      this.send(socket, frame);
    }
  }

  /** Publish one navigation epoch. */
  publishEpoch({ output, alarms, active_alarms, scenario, replay }) {
    this.broadcast('navigation', {
      type: Frame.NAVIGATION,
      navigation: output,
      active_alarms,
      scenario: scenario ?? null,
      replay: replay ?? null
    });
    for (const alarm of alarms ?? []) {
      this.broadcast('alarms', { type: Frame.ALARM, alarm });
    }
  }

  /**
   * Publish the fleet overview.
   *
   * On its own channel and at its own, slower rate: a client showing the fleet
   * list does not need every vessel at the full epoch rate, and a client
   * watching one vessel in detail should not pay for the rest of the fleet.
   */
  publishFleet(snapshot) {
    this.broadcast('fleet', { type: Frame.FLEET, fleet: snapshot });
  }

  publishScenarioState(status) {
    this.broadcast('scenario', { type: Frame.SCENARIO, scenario: status });
  }

  publishReplayState(status) {
    this.broadcast('replay', { type: Frame.REPLAY, replay: status });
  }

  publishModeTransition(transition) {
    this.broadcast('navigation', { type: Frame.MODE_TRANSITION, transition });
  }

  publishSystem(status) {
    this.broadcast('system', { type: Frame.SYSTEM, system: status });
  }

  status() {
    return {
      ...this.stats,
      clients: [...this.clients.values()].map((s) => ({
        username: s.user?.username ?? 'anonymous',
        role: s.user?.role ?? null,
        connected_at: s.connectedAt,
        channels: [...s.channels],
        frames_sent: s.sent,
        frames_dropped: s.dropped
      }))
    };
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.clients.keys()) {
      try {
        socket.close(1001, 'Server shutting down');
      } catch {
        socket.terminate();
      }
    }
    this.clients.clear();
    await new Promise((resolve) => (this.wss ? this.wss.close(resolve) : resolve()));
  }
}

export const liveHub = new LiveHub();
export default liveHub;
