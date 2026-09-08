/**
 * WebSocket client for the live stream.
 *
 * Reconnects with exponential back-off and jitter. The back-off matters on a
 * vessel: a dozen bridge displays all retrying in lockstep after a switch
 * reboot is a self-inflicted denial of service.
 */

import type { AppDispatch } from '../store';
import {
  alarmCleared,
  alarmReceived,
  connectionChanged,
  navigationReceived,
  replayStateReceived,
  scenarioStateReceived
} from '../store/liveSlice';

const WS_URL =
  import.meta.env.VITE_WS_URL ??
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/live`;

const BASE_DELAY_MS = 750;
const MAX_DELAY_MS = 20000;

export class LiveClient {
  private socket: WebSocket | null = null;
  private dispatch: AppDispatch;
  private token: string | null = null;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private stopped = false;

  constructor(dispatch: AppDispatch) {
    this.dispatch = dispatch;
  }

  connect(token: string | null) {
    this.stopped = false;
    this.token = token;
    this.open();
  }

  private open() {
    if (this.stopped) return;
    this.close(false);

    const url = this.token ? `${WS_URL}?token=${encodeURIComponent(this.token)}` : WS_URL;
    this.dispatch(connectionChanged({ state: 'connecting' }));

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.dispatch(connectionChanged({ state: 'error', error: (err as Error).message }));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.dispatch(connectionChanged({ state: 'open' }));
      socket.send(
        JSON.stringify({ type: 'subscribe', channels: ['navigation', 'alarms', 'scenario', 'replay', 'system'] })
      );
    };

    socket.onmessage = (event) => {
      let frame: any;
      try {
        frame = JSON.parse(event.data as string);
      } catch {
        return;
      }
      switch (frame.type) {
        case 'navigation':
          if (frame.navigation) {
            this.dispatch(
              navigationReceived({
                navigation: frame.navigation,
                active_alarms: frame.active_alarms,
                scenario: frame.scenario,
                replay: frame.replay
              })
            );
          }
          break;
        case 'alarm':
          if (frame.alarm) this.dispatch(alarmReceived(frame.alarm));
          break;
        case 'alarm_cleared':
          if (frame.alarm?.id) this.dispatch(alarmCleared({ id: frame.alarm.id }));
          break;
        case 'scenario':
          if (frame.scenario) this.dispatch(scenarioStateReceived(frame.scenario));
          break;
        case 'replay':
          if (frame.replay) this.dispatch(replayStateReceived(frame.replay));
          break;
        case 'error':
          this.dispatch(connectionChanged({ state: 'error', error: frame.message ?? frame.error }));
          break;
        default:
          break;
      }
    };

    socket.onerror = () => {
      this.dispatch(connectionChanged({ state: 'error', error: 'The live connection reported an error.' }));
    };

    socket.onclose = (event) => {
      this.socket = null;
      if (this.stopped) {
        this.dispatch(connectionChanged({ state: 'closed' }));
        return;
      }
      // 4401 is our own "authentication failed" code. Retrying with the same
      // rejected token would loop forever, so stop and let the UI sign out.
      if (event.code === 4401) {
        this.stopped = true;
        this.dispatch(
          connectionChanged({ state: 'error', error: 'Live stream authentication failed. Sign in again.' })
        );
        return;
      }
      this.dispatch(connectionChanged({ state: 'closed', error: event.reason || null }));
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.attempt += 1;
    const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.attempt, 6));
    // Jitter so a fleet of displays does not reconnect in lockstep.
    const delay = backoff * (0.6 + Math.random() * 0.6);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  /** Send sensor messages over the live socket (engineer role required). */
  ingest(messages: unknown[]) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'ingest', messages }));
      return true;
    }
    return false;
  }

  close(markStopped = true) {
    if (markStopped) this.stopped = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.onopen = null;
      try {
        this.socket.close();
      } catch {
        // Already closing.
      }
      this.socket = null;
    }
  }
}

let client: LiveClient | null = null;

export function getLiveClient(dispatch: AppDispatch): LiveClient {
  if (!client) client = new LiveClient(dispatch);
  return client;
}
