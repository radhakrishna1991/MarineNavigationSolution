/**
 * Deterministic pseudo-random number generation.
 *
 * Scenario replay must be bit-for-bit repeatable (Section 24 "Replay: scenario
 * is deterministic"), so nothing in the simulation may call `Math.random()`.
 * Every stochastic source draws from a seeded generator instead.
 */

/** 32-bit mix used to derive independent streams from a string seed. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Mulberry32 - small, fast, statistically adequate for simulation noise.
 */
export class Rng {
  /** @param {number|string} seed */
  constructor(seed = 1) {
    this.seed = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
    this.state = this.seed;
    this._spare = null;
  }

  /** Reset to the original seed (used when a scenario is reset). */
  reset() {
    this.state = this.seed;
    this._spare = null;
  }

  /** Uniform in [0, 1). */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  uniform(min, max) {
    return min + (max - min) * this.next();
  }

  /** Standard normal via Box-Muller with a cached spare. */
  normal(mean = 0, stdDev = 1) {
    if (this._spare !== null) {
      const value = this._spare;
      this._spare = null;
      return mean + stdDev * value;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * mul;
    return mean + stdDev * u * mul;
  }

  /** Bernoulli trial. */
  bool(probability) {
    return this.next() < probability;
  }

  /** Random integer in [min, max]. */
  int(min, max) {
    return Math.floor(this.uniform(min, max + 1));
  }

  /** Derive a named independent sub-stream. */
  fork(name) {
    return new Rng((this.seed ^ hashSeed(name)) >>> 0);
  }
}

/**
 * A first-order Gauss-Markov process, used to model slowly wandering sensor
 * biases (gyro drift, DVL scale wander) rather than pure white noise.
 */
export class GaussMarkov {
  /**
   * @param {Rng} rng
   * @param {number} tauSeconds correlation time
   * @param {number} sigma steady-state standard deviation
   * @param {number} initial initial value
   */
  constructor(rng, tauSeconds, sigma, initial = 0) {
    this.rng = rng;
    this.tau = Math.max(1e-3, tauSeconds);
    this.sigma = sigma;
    this.value = initial;
  }

  step(dt) {
    const beta = Math.exp(-dt / this.tau);
    const q = this.sigma * Math.sqrt(Math.max(0, 1 - beta * beta));
    this.value = beta * this.value + this.rng.normal(0, q);
    return this.value;
  }

  /**
   * Reset both the value and the underlying stream. Resetting only the value
   * would leave the noise sequence where it was, so a scenario re-run from the
   * beginning would diverge from the original - which defeats replay.
   */
  reset(initial = 0) {
    this.rng.reset();
    this.value = initial;
  }
}
