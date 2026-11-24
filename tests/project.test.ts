import { describe, expect, it } from 'vitest';
import { loudness, matchLoudness, projectPatch, render, renderProjectSound, soundExportPath, soundName, validateProject, type Patch, type Project } from '../src/core';

const tone = (name: string, freq: number, gainDb = 0): Patch => ({
  format: 'sfxgen/1',
  name,
  duration: 0.3,
  master: { gain: gainDb },
  tracks: [{ id: 't', source: { type: 'osc', wave: 'sine', freq, env: { attack: 0.005, decay: 0.25 } } }],
});

const project = (): Project => ({
  format: 'sfxgen-project/1',
  name: 'Set',
  output: { sampleRate: 24000, channels: 1, bitDepth: 16 },
  normalize: { mode: 'peak', target: -3 },
  master: { fx: [{ type: 'drive', mode: 'tanh', amount: 6 }] },
  groups: [{ id: 'ui', normalize: { mode: 'loudness', target: -24 } }],
  outDir: 'build',
  sounds: [{ file: 'sounds/Hit.sfx.json' }, { patch: tone('Soft click', 2000), group: 'ui', gain: -2, export: 'ui/click.wav' }],
});

describe('projects', () => {
  it('validates, including inline patches', () => {
    const v = validateProject(project());
    expect([...v.errors, ...v.warnings]).toEqual([]);
    const bad = project();
    bad.sounds.push({ file: 'x.sfx.json', group: 'iu' });
    expect(validateProject(bad).errors.some((e) => e.message.includes('"ui"'))).toBe(true);
  });

  it('names and places exports', () => {
    const p = project();
    expect(soundName(p.sounds[0])).toBe('Hit');
    expect(soundExportPath(p, p.sounds[0])).toBe('build/Hit.wav');
    expect(soundExportPath(p, p.sounds[1])).toBe('ui/click.wav');
  });

  it('renders in project context: output, normalisation, shared chain, gain', () => {
    const p = project();
    const a = renderProjectSound(p, p.sounds[0], tone('Hit', 200, -12));
    expect(a.sampleRate).toBe(24000);
    let peak = 0;
    for (const v of a.channels[0]) peak = Math.max(peak, Math.abs(v));
    expect(20 * Math.log10(peak)).toBeCloseTo(-3, 1);
    expect(projectPatch(p, p.sounds[0], tone('Hit', 200)).master?.fx?.[0].type).toBe('drive');

    const b = renderProjectSound(p, p.sounds[1], p.sounds[1].patch!);
    expect(loudness(b.channels, b.sampleRate).integrated).toBeCloseTo(-26, 0);
    // The patch itself is untouched by the project.
    expect(render(tone('x', 200)).sampleRate).toBe(48000);
  });

  it('matches loudness under a ceiling', () => {
    const gains = matchLoudness(
      [
        { name: 'quiet', lufs: -30, peakDb: -12, gain: 0 },
        { name: 'peaky', lufs: -20, peakDb: -1, gain: 2 },
      ],
      -18,
      -1,
    );
    expect(gains.quiet).toBe(11);
    expect(gains.peaky).toBe(2);
  });
});
