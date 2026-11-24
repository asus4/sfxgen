import { TAU, type Buf } from './math';

export type Waveform = 'sine' | 'triangle' | 'saw' | 'square' | 'pulse';

/** PolyBLEP residual: smooths the jump of a saw or square so it doesn't alias. `t` is phase 0..1, `dt` the step. */
function blep(t: number, dt: number): number {
  if (dt <= 0) return 0;
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/**
 * Renders a band-limited waveform with a per-sample frequency (Hz). Negative frequencies run the phase backwards.
 * `pw` is the pulse width for `pulse` (0..1, curve or constant). `phase0` is the start phase 0..1.
 */
export function oscillator(
  wave: Waveform,
  freq: Buf,
  sr: number,
  phase0 = 0,
  pw: number | Buf = 0.5,
  out: Buf = new Float64Array(freq.length),
): Buf {
  let ph = ((phase0 % 1) + 1) % 1;
  const n = freq.length;
  const pwArr = typeof pw === 'number' ? null : pw;
  const pw0 = typeof pw === 'number' ? pw : 0.5;
  for (let i = 0; i < n; i++) {
    const dt = Math.min(Math.abs(freq[i]) / sr, 0.5);
    let y: number;
    switch (wave) {
      case 'sine':
        y = Math.sin(TAU * ph);
        break;
      case 'saw':
        y = 2 * ph - 1 - blep(ph, dt);
        break;
      case 'square':
      case 'pulse': {
        const width = wave === 'square' ? 0.5 : Math.min(Math.max(pwArr ? pwArr[i] : pw0, 0.01), 0.99);
        y = ph < width ? 1 : -1;
        y += blep(ph, dt);
        y -= blep((ph + 1 - width) % 1, dt);
        break;
      }
      case 'triangle':
        // Its harmonics fall at 12 dB per octave, so the plain shape aliases very little.
        y = 1 - 4 * Math.abs(ph - 0.5);
        break;
    }
    out[i] = y;
    ph += freq[i] / sr;
    ph -= Math.floor(ph);
  }
  return out;
}

/** Running phase in radians from a per-sample frequency: for FM and anything that needs the phase itself. */
export function phaseOf(freq: Buf, sr: number, phase0 = 0): Buf {
  const out = new Float64Array(freq.length);
  let ph = phase0 * TAU;
  const k = TAU / sr;
  for (let i = 0; i < freq.length; i++) {
    out[i] = ph;
    ph += freq[i] * k;
    if (ph > 1e6) ph -= TAU * Math.floor(ph / TAU);
  }
  return out;
}
