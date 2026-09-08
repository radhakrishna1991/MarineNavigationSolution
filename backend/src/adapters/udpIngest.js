/**
 * Simulated UDP sensor ingestion (Section 8).
 *
 * Accepts either a JSON internal sensor message (or a `{messages:[...]}`
 * envelope) or raw NMEA 0183 text, one datagram at a time.
 *
 * Security posture: bound to loopback by default, size-limited, rate-limited
 * per source address, and completely separate from the UI's authenticated HTTP
 * surface (Section 22, "separation between sensor ingestion and UI access").
 * UDP is unauthenticated by nature; on a vessel this listener belongs on a
 * dedicated sensor VLAN, which is stated in docs/security.md rather than
 * pretended away here.
 */

import dgram from 'node:dgram';
import { BaseAdapter, parseNmeaChunk, parseJson } from './index.js';
import { env } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('udp-ingest');

const MAX_DATAGRAM_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 1000;

export class UdpIngestAdapter extends BaseAdapter {
  constructor({ onMessage, port = env.udp.port, bind = env.udp.bind, maxPerSecond = 2000 }) {
    super({ id: 'UDP_INGEST', onMessage });
    this.port = port;
    this.bind = bind;
    this.maxPerSecond = maxPerSecond;
    this.socket = null;
    this.rateBuckets = new Map();
    this.sequence = 0;
    this.stats.dropped_rate_limited = 0;
    this.stats.dropped_oversize = 0;
  }

  async start() {
    await super.start();
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket.on('error', (err) => {
        log.error('udp socket error', err);
        this.stats.lastError = { at: new Date().toISOString(), errors: [err.message] };
        reject(err);
      });
      this.socket.on('message', (buffer, rinfo) => this.handleDatagram(buffer, rinfo));
      this.socket.bind(this.port, this.bind, () => {
        log.info('udp ingestion listening', { address: this.bind, port: this.port });
        resolve(this);
      });
    });
  }

  async stop() {
    if (this.socket) {
      await new Promise((resolve) => this.socket.close(resolve));
      this.socket = null;
      log.info('udp ingestion stopped');
    }
  }

  /** Per-source rate limit. */
  allow(address) {
    const now = Date.now();
    let bucket = this.rateBuckets.get(address);
    if (!bucket || now - bucket.startedAt > RATE_WINDOW_MS) {
      bucket = { startedAt: now, count: 0 };
      this.rateBuckets.set(address, bucket);
    }
    bucket.count += 1;
    if (this.rateBuckets.size > 256) this.rateBuckets.clear();
    return bucket.count <= this.maxPerSecond;
  }

  handleDatagram(buffer, rinfo) {
    if (buffer.length > MAX_DATAGRAM_BYTES) {
      this.stats.dropped_oversize += 1;
      return;
    }
    if (!this.allow(rinfo.address)) {
      this.stats.dropped_rate_limited += 1;
      return;
    }

    const text = buffer.toString('utf8').trim();
    if (!text) return;
    const meta = { source_address: rinfo.address, source_port: rinfo.port };

    if (text.startsWith('$') || text.startsWith('!')) {
      const { messages, errors } = parseNmeaChunk(text, {
        sensorIdPrefix: 'UDP',
        sequenceStart: this.sequence
      });
      this.sequence += messages.length;
      for (const message of messages) this.emit(message, { ...meta, format: 'NMEA_0183' });
      if (errors.length) {
        this.stats.rejected += errors.length;
        this.stats.lastError = { at: new Date().toISOString(), errors: errors.slice(0, 3) };
      }
      return;
    }

    const { messages, errors } = parseJson(text);
    for (const message of messages) this.emit(message, { ...meta, format: 'JSON' });
    if (errors.length) {
      this.stats.rejected += errors.length;
      this.stats.lastError = { at: new Date().toISOString(), errors: errors.slice(0, 3) };
    }
  }
}

export default UdpIngestAdapter;
