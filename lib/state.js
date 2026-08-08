// lib/state.js
// Active internal state model — free-energy style tracking.
// energy (0..1 high=healthy), uncertainty (0..1), stress (0..1),
// surprise, and a simple free-energy proxy used to bias DEFER vs COMMIT.

export class ActiveState {
  constructor({ energy = 0.8, uncertainty = 0.35, stress = 0.1 } = {}) {
    this.energy = clamp(energy);
    this.uncertainty = clamp(uncertainty);
    this.stress = clamp(stress);
    this.surprise = 0;
    this.turns = 0;
    this.lastDecision = null;
    this.history = []; // last N snapshots
  }

  /** Free-energy proxy: high uncertainty + high stress + low energy → high F */
  freeEnergy() {
    return clamp(
      0.45 * this.uncertainty +
      0.35 * this.stress +
      0.20 * (1 - this.energy)
    );
  }

  /**
   * Update after a decision / tool outcome.
   * @param {object} obs
   * @param {string} obs.state  COMMIT|DEFER|REJECT
   * @param {number} obs.score
   * @param {boolean} obs.toolFailed
   * @param {boolean} obs.error
   * @param {number} obs.latencyMs
   */
  observe(obs = {}) {
    this.turns += 1;
    const expectedScore = 0.7;
    const score = Number(obs.score);
    this.surprise = Number.isFinite(score)
      ? clamp(Math.abs(score - expectedScore))
      : 0.3;

    // Energy drains with errors / long latency; recovers on clean COMMIT
    if (obs.error || obs.toolFailed) {
      this.energy = clamp(this.energy - 0.08);
      this.stress = clamp(this.stress + 0.12);
      this.uncertainty = clamp(this.uncertainty + 0.1);
    } else if (obs.state === 'COMMIT') {
      this.energy = clamp(this.energy + 0.03);
      this.stress = clamp(this.stress - 0.05);
      this.uncertainty = clamp(this.uncertainty - 0.04);
    } else if (obs.state === 'DEFER') {
      this.uncertainty = clamp(this.uncertainty + 0.06);
      this.stress = clamp(this.stress + 0.03);
    } else if (obs.state === 'REJECT') {
      this.stress = clamp(this.stress + 0.08);
      this.energy = clamp(this.energy - 0.04);
    }

    if (obs.latencyMs > 15_000) {
      this.stress = clamp(this.stress + 0.05);
      this.energy = clamp(this.energy - 0.02);
    }

    this.lastDecision = obs.state || null;
    this._pushSnapshot();
    return this.snapshot();
  }

  /**
   * Bias for the kernel: if free energy is high, prefer DEFER.
   * Returns { preferDefer: boolean, reason, freeEnergy }
   */
  decisionBias() {
    const F = this.freeEnergy();
    if (F >= 0.65) {
      return { preferDefer: true, reason: 'high_free_energy', freeEnergy: F };
    }
    if (this.energy < 0.25) {
      return { preferDefer: true, reason: 'energy_critical', freeEnergy: F };
    }
    return { preferDefer: false, reason: 'stable', freeEnergy: F };
  }

  snapshot() {
    return {
      energy: round4(this.energy),
      uncertainty: round4(this.uncertainty),
      stress: round4(this.stress),
      surprise: round4(this.surprise),
      free_energy: round4(this.freeEnergy()),
      turns: this.turns,
      last_decision: this.lastDecision,
    };
  }

  _pushSnapshot() {
    this.history.push({ ts: Date.now(), ...this.snapshot() });
    if (this.history.length > 50) this.history.shift();
  }
}

function clamp(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export function createActiveState(opts) {
  return new ActiveState(opts);
}
