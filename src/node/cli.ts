/**
 * The `sfxgen` command line: render, analyze, validate, guide, schema, templates, new, diff, serve, mcp.
 *
 * Every command is written for an agent reading its output: plain lines first, exact numbers after, `--json` where
 * a program wants the data, warnings on stderr, exit code 1 on errors and 2 on a usage mistake.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeWav,
  encodeWav,
  formatIssues,
  getPath,
  metaAt,
  render,
  setPath,
  suggest,
  takeFileName,
  validatePatch,
  variationTakes,
  type Control,
  type Patch,
  type ValidationResult,
} from '../core';
import { analyze, describeLines, encodePng, formatHz, formatSeconds, noteName, spectrogram, type Analysis } from '../core/analysis';
import { buildGuide, type GuideSection } from '../core/agent/guide';
import { buildSchema } from '../core/agent/schema';
import { diffValues } from '../core/agent/diff';
import { getTemplate, listTemplates, templateCategories } from '../core/templates';
import pkg from '../../package.json';

const VERSION: string = (pkg as { version?: string }).version ?? '0.0.0';

// ---- Errors and output ------------------------------------------------------------------------------

/** A mistake in how the command was called: exit code 2 and a pointer to --help. */
class UsageError extends Error {}
/** An expected failure (a missing file, invalid JSON): exit code 1, no stack. */
class CliError extends Error {}

const out = (text = '') => process.stdout.write(text + '\n');
const err = (text: string) => process.stderr.write(text + '\n');

// ---- Arguments --------------------------------------------------------------------------------------

interface OptionSpec {
  name: string;
  alias?: string;
  /** `required`: takes a value; `optional`: takes the next argument only if `accepts` it; omitted: a flag. */
  value?: 'required' | 'optional';
  accepts?: (next: string) => boolean;
  repeat?: boolean;
  /** Shown in the help: `--out <file.wav>`. */
  arg?: string;
  help: string;
}

interface Args {
  positional: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

const HELP: OptionSpec = { name: 'help', alias: 'h', help: 'Show this help.' };

function parseArgs(argv: string[], specs: OptionSpec[]): Args {
  const all = [...specs, HELP];
  const args: Args = { positional: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.positional.push(...argv.slice(i + 1));
      break;
    }
    const isLong = a.startsWith('--');
    const isShort = !isLong && /^-[A-Za-z]$/.test(a);
    if (!isLong && !isShort) {
      args.positional.push(a);
      continue;
    }
    const eq = isLong ? a.indexOf('=') : -1;
    const key = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const spec = all.find((s) => `--${s.name}` === key || (s.alias !== undefined && `-${s.alias}` === key));
    if (!spec) {
      throw new UsageError(`unknown option ${key}${suggest(key.replace(/^-+/, ''), all.map((s) => s.name)).replace(/"(\w[\w-]*)"/, '"--$1"')}`);
    }
    const store = (v: string) => {
      const list = args.values.get(spec.name) ?? [];
      if (list.length > 0 && !spec.repeat) throw new UsageError(`--${spec.name} is given twice`);
      list.push(v);
      args.values.set(spec.name, list);
    };
    if (!spec.value) {
      if (inline !== undefined) throw new UsageError(`--${spec.name} takes no value`);
      args.flags.add(spec.name);
    } else if (spec.value === 'required') {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`--${spec.name} needs a value${spec.arg ? ` ${spec.arg}` : ''}`);
      store(v);
    } else if (inline !== undefined) {
      store(inline);
    } else if (i + 1 < argv.length && spec.accepts?.(argv[i + 1])) {
      store(argv[++i]);
    } else {
      args.flags.add(spec.name);
    }
  }
  return args;
}

const value = (args: Args, name: string): string | undefined => args.values.get(name)?.[0];
const has = (args: Args, name: string): boolean => args.flags.has(name) || args.values.has(name);

function numberOption(args: Args, name: string, check: (n: number) => boolean, expected: string): number | undefined {
  const v = value(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !check(n)) throw new UsageError(`--${name} must be ${expected}, not "${v}"`);
  return n;
}

// ---- Files ---------------------------------------------------------------------------------------------

function readText(file: string): string {
  if (!existsSync(file)) throw new CliError(`${file}: no such file`);
  if (statSync(file).isDirectory()) throw new CliError(`${file}: is a directory`);
  return readFileSync(file, 'utf8');
}

function loadPatch(file: string): Patch {
  const text = readText(file);
  try {
    return JSON.parse(text) as Patch;
  } catch (e) {
    throw new CliError(`${file}: not valid JSON: ${(e as Error).message}`);
  }
}

function writeFile(file: string, data: string | Uint8Array): void {
  const dir = dirname(file);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, data);
}

/** `door.sfx.json` -> `door`, keeping the directory. */
function stem(file: string): string {
  return file.replace(/\.sfx\.json$/i, '').replace(/\.json$/i, '').replace(/\.wav$/i, '');
}

const isWav = (file: string) => extname(file).toLowerCase() === '.wav' || extname(file).toLowerCase() === '.wave';

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} kB`);

function compact(v: unknown, max = 100): string {
  const s = JSON.stringify(v);
  if (s === undefined) return '(none)';
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

// ---- Setting controls and parameters -------------------------------------------------------------------

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Applies `--set key=value`: a control by id (a number, or an option's label for select and toggle controls), else
 * a parameter by path (`tracks.body.source.freq=220`, `seed=9`), the value parsed as JSON where it can be.
 */
function applySets(patch: Patch, sets: string[]): string[] {
  const done: string[] = [];
  for (const s of sets) {
    const eq = s.indexOf('=');
    if (eq <= 0) throw new UsageError(`--set needs key=value, not "${s}"`);
    const key = s.slice(0, eq).trim();
    const raw = s.slice(eq + 1).trim();
    const control = (patch.controls ?? []).find((c) => c.id === key);
    if (control) {
      control.value = controlValue(control, raw);
      done.push(`${key}=${control.value}`);
      continue;
    }
    const v = parseValue(raw);
    const known = getPath(patch, key) !== undefined || metaAt(patch, key) !== undefined || key === 'seed' || key === 'duration';
    if (!known || !setPath(patch, key, v)) {
      const ids = (patch.controls ?? []).map((c) => c.id);
      const hint = suggest(key, ids);
      throw new CliError(
        `--set ${key}: no control with that id and no parameter at that path${hint}.` +
          (ids.length ? ` Controls: ${ids.join(', ')}.` : ' This patch has no controls.'),
      );
    }
    done.push(`${key}=${compact(v, 40)}`);
  }
  return done;
}

function controlValue(c: Control, raw: string): number {
  if (c.options && c.options.length > 0) {
    const byLabel = c.options.findIndex((o) => o.label.toLowerCase() === raw.toLowerCase());
    if (byLabel >= 0) return byLabel;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n < c.options.length) return n;
    throw new CliError(`--set ${c.id}: choose one of ${c.options.map((o, i) => `${i} "${o.label}"`).join(', ')}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new CliError(`--set ${c.id}: expected a number, not "${raw}"`);
  const lo = Math.min(c.min ?? 0, c.max ?? 1);
  const hi = Math.max(c.min ?? 0, c.max ?? 1);
  if (n < lo || n > hi) err(`warning: ${c.id}=${n} is outside its range ${lo} to ${hi}`);
  return n;
}

function printValidation(file: string, v: ValidationResult): void {
  if (v.errors.length === 0 && v.warnings.length === 0) return;
  const text = formatIssues(v)
    .split('\n')
    .map((l) => `${file}: ${l}`)
    .join('\n');
  err(text);
}

// ---- The analysis as text ------------------------------------------------------------------------------

const BLOCKS = ' ▁▂▃▄▅▆▇█';

/** 40 characters, one per fortieth of the sound, over the top 60 dB. */
function sparkline(env: number[]): string {
  const top = Math.max(...env);
  return env
    .map((db) => {
      const x = (db - (top - 60)) / 60;
      return x <= 0 ? ' ' : BLOCKS[Math.max(1, Math.min(8, Math.ceil(x * 8)))];
    })
    .join('');
}

function bar(db: number, width = 20): string {
  const n = Math.max(0, Math.min(width, Math.round(((db + 40) / 40) * width)));
  return '█'.repeat(n);
}

const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);

/** The plain lines, then every number, in a fixed layout. */
function analysisText(a: Analysis): string[] {
  const lines = [...describeLines(a)];
  if (a.peakDb <= -100) return lines;
  const top = Math.max(...a.envelopeDb);
  lines.push('');
  lines.push(`envelope  |${sparkline(a.envelopeDb)}|  40 steps over ${formatSeconds(a.duration)}, top ${f1(top)} dBFS, 60 dB tall`);
  a.bands.forEach((b, i) => {
    const share = 100 * 10 ** (b.db / 10);
    const pct = share >= 1 ? `${Math.round(share)}%` : share >= 0.1 ? `${share.toFixed(1)}%` : '<0.1%';
    lines.push(`${i === 0 ? 'bands' : ''}`.padEnd(10) + `${b.band.padEnd(17)} ${f1(b.db).padStart(6)} dB ${pct.padStart(6)}  ${bar(b.db)}`);
  });
  lines.push(
    `level     peak ${f2(a.peakDb)} dBFS | true peak ${f2(a.truePeakDb)} dBTP | RMS ${f2(a.rmsDb)} dBFS | ${f2(a.lufs)} LUFS (loudest 400 ms ${f2(a.lufsMomentaryMax)}) | crest ${f1(a.crestDb)} dB`,
  );
  lines.push(
    `time      attack ${formatSeconds(a.attackMs / 1000)} | loudest at ${formatSeconds(a.peakTimeMs / 1000)} | decay20 ${formatSeconds(a.decay20Seconds)} | ` +
      `starts ${formatSeconds(a.startSeconds)} | -60 dB at ${formatSeconds(a.audibleSeconds)} of ${formatSeconds(a.duration)} | tail ${f1(a.tailDb)} dB`,
  );
  lines.push(
    `spectrum  centroid ${formatHz(a.centroidHz)} (thirds ${a.centroidThirds.map(formatHz).join(', ')}) | rolloff 85% ${formatHz(a.rolloffHz)} | ${a.zeroCrossRate} zero crossings/s`,
  );
  if (a.pitchHz !== null) {
    // Consecutive points within 1% read as one.
    const steps = a.pitchTrack.filter(([, hz], i, all) => i === 0 || Math.abs(hz / all[i - 1][1] - 1) > 0.01);
    const track = steps.map(([, hz]) => formatHz(hz).replace(' Hz', '').replace(' kHz', 'k')).join(' > ');
    const span = a.pitchTrack.length > 1 ? ` from ${f2(a.pitchTrack[0][0])} to ${f2(a.pitchTrack[a.pitchTrack.length - 1][0])} s` : '';
    lines.push(`pitch     ${formatHz(a.pitchHz)} (${noteName(a.pitchHz)}), clarity ${f2(a.pitchClarity)} | track ${track} Hz${span}`);
  } else {
    lines.push(`pitch     none (clarity ${f2(a.pitchClarity)})`);
  }
  if (a.peaks.length) lines.push(`peaks     ${a.peaks.map((p) => `${formatHz(p.hz)} ${p.db === 0 ? '0' : f1(p.db)} dB`).join(', ')}`);
  if (a.onsets.length) lines.push(`onsets    ${a.onsets.map((t) => f2(t)).join(', ')} s${a.onsets.length >= 64 ? ' (first 64)' : ''}`);
  lines.push(
    `edges     first sample ${f1(a.firstSampleDb)} dBFS | last ${f1(a.lastSampleDb)} dBFS | DC ${(Math.abs(a.dcOffset) < 0.00005 ? 0 : a.dcOffset).toFixed(4)} | clipped samples ${a.clippedSamples}` +
      (a.stereoCorrelation !== null ? ` | L/R correlation ${f2(a.stereoCorrelation)}` : ''),
  );
  return lines;
}

const channelsText = (n: number) => (n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} channels`);

// ---- Commands -----------------------------------------------------------------------------------------

interface Command {
  name: string;
  summary: string;
  usage: string;
  description: string;
  options: OptionSpec[];
  examples: string[];
  run(args: Args): Promise<number | void>;
}

const SET: OptionSpec = {
  name: 'set',
  value: 'required',
  repeat: true,
  arg: '<id=value>',
  help: 'Set a control by id (a number, or an option label), or any parameter by path (tracks.body.source.freq=220). Repeatable.',
};
const SEED: OptionSpec = { name: 'seed', value: 'required', arg: '<n>', help: 'Use this seed: another take of the same design.' };
const SR: OptionSpec = { name: 'sr', value: 'required', arg: '<Hz>', help: 'Sample rate (default: the patch\'s, else 48000).' };
const CHANNELS: OptionSpec = { name: 'channels', value: 'required', arg: '<1|2>', help: 'Mono or stereo (default: the patch\'s, else 1).' };
const JSON_OUT: OptionSpec = { name: 'json', help: 'Print JSON instead of text.' };

function renderOptions(args: Args): { sampleRate?: number; channels?: 1 | 2 } {
  const sampleRate = numberOption(args, 'sr', (n) => n >= 8000 && n <= 192000, 'a sample rate from 8000 to 192000');
  const channels = numberOption(args, 'channels', (n) => n === 1 || n === 2, '1 or 2') as 1 | 2 | undefined;
  return { sampleRate, channels };
}

/** Loads a patch, applies --seed and --set, validates it; exits on errors. */
function preparePatch(file: string, args: Args, json: boolean): { patch: Patch; validation: ValidationResult; sets: string[] } {
  const patch = loadPatch(file);
  const seed = numberOption(args, 'seed', (n) => Number.isFinite(n), 'a number');
  if (seed !== undefined) patch.seed = seed;
  const sets = applySets(patch, args.values.get('set') ?? []);
  const validation = validatePatch(patch);
  if (!json || !validation.ok) printValidation(file, validation);
  if (!validation.ok) throw new CliError(`${file}: ${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'}; fix ${validation.errors.length === 1 ? 'it' : 'them'} first (sfxgen validate ${file}).`);
  return { patch, validation, sets };
}

const SPECTROGRAM_NOTE = 'The spectrogram:';

async function writeSpectrogram(channels: Float32Array[], sampleRate: number, file: string): Promise<{ path: string; caption: string }> {
  const img = spectrogram(channels, sampleRate);
  writeFile(file, await encodePng(img.width, img.height, img.rgba));
  return { path: file, caption: img.caption };
}

const renderCommand: Command = {
  name: 'render',
  summary: 'Render a patch to WAV; optionally its spectrogram and its analysis',
  usage: 'sfxgen render <patch.sfx.json> [options]',
  description:
    'Renders a patch (with its controls applied) to a WAV file next to it. --png also writes the spectrogram image, --analyze prints what the sound measures like. With --variations N it writes N takes named name-01.wav, name-02.wav, ...: the patch itself, then versions where every control with a `vary` range moves a little and the seed changes (the same takes the editor exports).',
  options: [
    { name: 'out', alias: 'o', value: 'required', arg: '<file.wav>', help: 'Output WAV (default: the patch path with .wav). A directory puts it there.' },
    SR,
    CHANNELS,
    { name: 'bits', value: 'required', arg: '<16|24|32>', help: 'WAV bit depth: 16 or 24-bit integer, 32-bit float (default: the patch\'s, else 16).' },
    SEED,
    SET,
    { name: 'variations', value: 'required', arg: '<n>', help: 'Write n takes (2 to 64) for round-robin: name-01.wav ... name-NN.wav.' },
    { name: 'png', help: 'Also write the spectrogram next to each WAV (name.png).' },
    { name: 'analyze', help: 'Print the analysis: a plain-language summary, then the numbers.' },
    JSON_OUT,
  ],
  examples: [
    'sfxgen render door.sfx.json --analyze --png',
    'sfxgen render door.sfx.json --set weight=1 -o heavy-door.wav --analyze',
    'sfxgen render door.sfx.json --variations 5 --bits 24',
  ],
  async run(args) {
    const file = args.positional[0];
    if (!file) throw new UsageError('which patch? sfxgen render <patch.sfx.json>');
    if (args.positional.length > 1) throw new UsageError(`one patch at a time (got ${args.positional.join(', ')})`);
    const json = args.flags.has('json');
    const { patch, validation, sets } = preparePatch(file, args, json);
    const opts = renderOptions(args);
    const bits = (numberOption(args, 'bits', (n) => n === 16 || n === 24 || n === 32, '16, 24 or 32') ?? patch.output?.bitDepth ?? 16) as 16 | 24 | 32;
    const count = numberOption(args, 'variations', (n) => Number.isInteger(n) && n >= 1 && n <= 64, 'a whole number from 1 to 64') ?? 1;
    let wavPath = value(args, 'out') ?? `${stem(file)}.wav`;
    if (wavPath.endsWith('/') || (existsSync(wavPath) && statSync(wavPath).isDirectory())) wavPath = join(wavPath, `${basename(stem(file))}.wav`);
    if (!isWav(wavPath)) wavPath += '.wav';

    // The takes: the editor's convention, so the CLI and the editor write the same files.
    const takes: { patch: Patch; path: string }[] = [];
    if (count === 1) takes.push({ patch, path: wavPath });
    else {
      variationTakes(patch, count).forEach((p, take) => takes.push({ patch: p, path: takeFileName(stem(wavPath), take, count) }));
    }
    const results = [];
    for (const take of takes) {
      const r = render(take.patch, opts);
      const wav = encodeWav(r.channels, r.sampleRate, bits);
      writeFile(take.path, wav);
      const png = args.flags.has('png') ? await writeSpectrogram(r.channels, r.sampleRate, `${stem(take.path)}.png`) : undefined;
      const analysis = args.flags.has('analyze') ? analyze(r.channels, r.sampleRate) : undefined;
      results.push({ take, r, bytes: wav.length, png, analysis });
    }

    if (json) {
      out(
        JSON.stringify(
          {
            patch: file,
            set: sets,
            validationWarnings: validation.warnings,
            takes: results.map(({ take, r, bytes, png, analysis }) => ({
              wav: take.path,
              bytes,
              seed: take.patch.seed ?? 1,
              controls: Object.fromEntries((take.patch.controls ?? []).map((c) => [c.id, c.value])),
              duration: r.duration,
              sampleRate: r.sampleRate,
              channels: r.channels.length,
              bitDepth: bits,
              renderMs: Math.round(r.timeMs),
              warnings: r.warnings,
              ...(png ? { png: png.path, spectrogram: png.caption } : {}),
              ...(analysis ? { summary: describeLines(analysis), analysis } : {}),
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (sets.length) out(`Set ${sets.join(', ')}`);
    if (results.length === 1) {
      const { take, r, bytes } = results[0];
      out(
        `Rendered ${file} -> ${take.path} (${formatSeconds(r.duration)}, ${r.sampleRate} Hz ${channelsText(r.channels.length)} ${bits === 32 ? '32-bit float' : `${bits}-bit`}, ${kb(bytes)}) in ${Math.round(r.timeMs)} ms`,
      );
    } else {
      out(`Rendered ${file}: ${results.length} takes (the patch, then ${results.length - 1} variations), ${bits === 32 ? '32-bit float' : `${bits}-bit`}`);
      for (const { take, r } of results) {
        const ctl = (take.patch.controls ?? []).filter((c) => c.vary).map((c) => `${c.id} ${Number(c.value.toFixed(3))}`);
        out(`  ${take.path}  ${formatSeconds(r.duration)}  seed ${take.patch.seed ?? 1}${ctl.length ? `  ${ctl.join(', ')}` : ''}`);
      }
      if (!(patch.controls ?? []).some((c) => c.vary)) out('  (no control has a `vary` range, so the takes differ only by seed)');
    }
    const pngs = results.filter((x) => x.png);
    if (pngs.length) {
      out(`${SPECTROGRAM_NOTE} ${pngs.map((x) => x.png!.path).join(', ')}`);
      out(`  ${pngs[0].png!.caption}`);
    }
    for (const { take, r, analysis } of results) {
      if (analysis) {
        out('');
        if (results.length > 1) out(`${take.path}:`);
        for (const line of results.length > 1 ? describeLines(analysis) : analysisText(analysis)) out(results.length > 1 && line ? `  ${line}` : line);
      }
      for (const w of r.warnings) err(`warning: ${results.length > 1 ? `${take.path}: ` : ''}${w}`);
    }
    return 0;
  },
};

const analyzeCommand: Command = {
  name: 'analyze',
  summary: 'Measure a WAV or a patch: a plain summary, the numbers, optionally the spectrogram',
  usage: 'sfxgen analyze <file.wav | patch.sfx.json> [options]',
  description:
    'Measures a sound so you can judge it without hearing it: level and loudness, attack and decay, where the energy sits and how it moves, pitch, and problems (clipping, clicks, cut-off tails, too much sub-bass). A patch is rendered first (nothing is written unless you ask for --png).',
  options: [
    { name: 'png', value: 'optional', accepts: (n) => n.toLowerCase().endsWith('.png'), arg: '[out.png]', help: 'Write the spectrogram (default: next to the input, name.png).' },
    JSON_OUT,
    SR,
    CHANNELS,
    SEED,
    SET,
  ],
  examples: ['sfxgen analyze door.wav', 'sfxgen analyze door.sfx.json --png', 'sfxgen analyze door.wav --png /tmp/door.png --json'],
  async run(args) {
    const file = args.positional[0];
    if (!file) throw new UsageError('which file? sfxgen analyze <file.wav | patch.sfx.json>');
    if (args.positional.length > 1) throw new UsageError(`one file at a time (got ${args.positional.join(', ')})`);
    const json = args.flags.has('json');
    let channels: Float32Array[];
    let sampleRate: number;
    let header: string;
    let warnings: string[] = [];
    const wav = isWav(file) || (existsSync(file) && readFileSync(file).subarray(0, 4).toString('latin1') === 'RIFF');
    if (wav) {
      if (args.values.has('set') || args.values.has('seed') || args.values.has('sr') || args.values.has('channels')) {
        throw new UsageError('--set, --seed, --sr and --channels apply to patches, not WAV files');
      }
      if (!existsSync(file)) throw new CliError(`${file}: no such file`);
      try {
        ({ channels, sampleRate } = decodeWav(new Uint8Array(readFileSync(file))));
      } catch (e) {
        throw new CliError(`${file}: ${(e as Error).message}`);
      }
      header = `${file}: ${formatSeconds((channels[0]?.length ?? 0) / sampleRate)}, ${sampleRate} Hz, ${channelsText(channels.length)}`;
    } else {
      const { patch } = preparePatch(file, args, json);
      const r = render(patch, renderOptions(args));
      channels = r.channels;
      sampleRate = r.sampleRate;
      warnings = r.warnings;
      header = `${file}: rendered ${formatSeconds(r.duration)}, ${r.sampleRate} Hz, ${channelsText(r.channels.length)} in ${Math.round(r.timeMs)} ms`;
    }
    const analysis = analyze(channels, sampleRate);
    let png: { path: string; caption: string } | undefined;
    if (has(args, 'png')) png = await writeSpectrogram(channels, sampleRate, value(args, 'png') ?? `${stem(file)}.png`);
    if (json) {
      out(JSON.stringify({ file, summary: describeLines(analysis), analysis, warnings, ...(png ? { png: png.path, spectrogram: png.caption } : {}) }, null, 2));
      return 0;
    }
    out(header);
    if (png) {
      out(`${SPECTROGRAM_NOTE} ${png.path}`);
      out(`  ${png.caption}`);
    }
    out('');
    for (const line of analysisText(analysis)) out(line);
    for (const w of warnings) err(`warning: ${w}`);
    return 0;
  },
};

const validateCommand: Command = {
  name: 'validate',
  summary: 'Check patches against the format and the catalog (exit 1 on errors)',
  usage: 'sfxgen validate <patch.sfx.json...> [--json]',
  description:
    'Checks each patch against the format and the node catalog. Errors (which stop a render) and warnings (advice, such as an unknown parameter with the closest valid name) name the path they are about. Exits with 1 when any patch has errors.',
  options: [JSON_OUT],
  examples: ['sfxgen validate door.sfx.json', 'sfxgen validate sounds/*.sfx.json'],
  async run(args) {
    if (args.positional.length === 0) throw new UsageError('which patches? sfxgen validate <patch.sfx.json...>');
    const json = args.flags.has('json');
    const report: { file: string; ok: boolean; errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] }[] = [];
    for (const file of args.positional) {
      let v: ValidationResult;
      try {
        v = validatePatch(loadPatch(file));
      } catch (e) {
        v = { ok: false, errors: [{ path: '', message: (e as Error).message.replace(`${file}: `, '') }], warnings: [] };
      }
      report.push({ file, ok: v.ok, errors: v.errors, warnings: v.warnings });
    }
    const bad = report.filter((r) => !r.ok).length;
    if (json) out(JSON.stringify(report, null, 2));
    else {
      for (const r of report) {
        const counts = [r.errors.length ? `${r.errors.length} error${r.errors.length === 1 ? '' : 's'}` : '', r.warnings.length ? `${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}` : '']
          .filter(Boolean)
          .join(', ');
        out(`${r.ok ? 'ok   ' : 'FAIL '} ${r.file}${counts ? ` (${counts})` : ''}`);
        const text = formatIssues({ ok: r.ok, errors: r.errors, warnings: r.warnings });
        if (text) out(text.replace(/^/gm, '      '));
      }
      if (report.length > 1) out(`${report.length} patches: ${report.length - bad} ok, ${bad} with errors`);
    }
    return bad > 0 ? 1 : 0;
  },
};

const SECTIONS: GuideSection[] = ['overview', 'sources', 'effects', 'templates', 'all'];

const guideCommand: Command = {
  name: 'guide',
  summary: 'The format and the catalog of every source and effect, as markdown for agents',
  usage: 'sfxgen guide [--section overview|sources|effects|templates|all] [--type <node>]',
  description:
    'Prints the guide an agent needs to write patches: the format, how to read the analysis, then every source and effect with its parameters (kind, default, range, what it does) and an example, generated from the code so it is never out of date.',
  options: [
    { name: 'section', value: 'required', arg: '<name>', help: `One part: ${SECTIONS.join(', ')} (default all).` },
    { name: 'type', value: 'required', arg: '<node>', help: 'One source or effect in detail, such as modal or reverb.' },
  ],
  examples: ['sfxgen guide > GUIDE.md', 'sfxgen guide --section overview', 'sfxgen guide --type modal'],
  async run(args) {
    const section = value(args, 'section') as GuideSection | undefined;
    if (section && !SECTIONS.includes(section)) throw new UsageError(`--section is one of ${SECTIONS.join(', ')}${suggest(section, SECTIONS)}`);
    let text: string;
    try {
      text = buildGuide({ section, type: value(args, 'type') });
    } catch (e) {
      throw new CliError((e as Error).message);
    }
    process.stdout.write(text);
    return 0;
  },
};

const schemaCommand: Command = {
  name: 'schema',
  summary: 'The JSON Schema for *.sfx.json, for editor autocomplete',
  usage: 'sfxgen schema [--write [file]]',
  description:
    'Prints the JSON Schema (2020-12) for patches, generated from the catalog: editors autocomplete every parameter and show its doc. --write saves it (default schema/sfxgen.schema.json); point a patch at it with "$schema": "<relative path>".',
  options: [{ name: 'write', value: 'optional', accepts: (n) => n.toLowerCase().endsWith('.json'), arg: '[file]', help: 'Write it to a file (default schema/sfxgen.schema.json).' }],
  examples: ['sfxgen schema --write', 'sfxgen schema > sfxgen.schema.json'],
  async run(args) {
    const text = JSON.stringify(buildSchema(), null, 2) + '\n';
    if (has(args, 'write')) {
      const file = value(args, 'write') ?? join('schema', 'sfxgen.schema.json');
      writeFile(file, text);
      out(`Wrote ${file} (${kb(Buffer.byteLength(text))}). In a patch: "$schema": "<path to it>".`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  },
};

const templatesCommand: Command = {
  name: 'templates',
  summary: 'List the template library',
  usage: 'sfxgen templates [--category <name>] [--search <words>] [--json]',
  description: 'Lists the templates to start from, with each one\'s controls. Start a patch from one with `sfxgen new <id>`.',
  options: [
    { name: 'category', value: 'required', arg: '<name>', help: 'Only this category.' },
    { name: 'search', value: 'required', arg: '<words>', help: 'Only templates whose id, name, description or tags contain every word.' },
    JSON_OUT,
  ],
  examples: ['sfxgen templates', 'sfxgen templates --search "metal door"', 'sfxgen templates --category ui --json'],
  async run(args) {
    const category = value(args, 'category');
    const categories = templateCategories();
    if (category && !categories.includes(category)) {
      throw new CliError(`no category "${category}"${suggest(category, categories)}. Categories: ${categories.join(', ')}.`);
    }
    const list = listTemplates({ category, query: value(args, 'search') ?? args.positional.join(' ') });
    if (args.flags.has('json')) {
      out(JSON.stringify(list, null, 2));
      return 0;
    }
    if (list.length === 0) {
      out(`No templates match. Categories: ${categories.join(', ')}.`);
      return 0;
    }
    const width = Math.max(...list.map((t) => t.id.length));
    for (const t of list) {
      const controls = t.controls.length ? `  [${t.controls.map((c) => c.id).join(', ')}]` : '';
      out(`${t.id.padEnd(width)}  ${t.name}: ${t.description}${controls}`);
    }
    out(`\n${list.length} template${list.length === 1 ? '' : 's'}. Start from one: sfxgen new <id> -o my.sfx.json`);
    return 0;
  },
};

function findTemplate(id: string): { id: string; patch: Patch } {
  const exact = getTemplate(id);
  if (exact) return { id, patch: exact };
  const all = listTemplates();
  const matches = all.filter((t) => t.id.endsWith(`/${id}`) || t.name.toLowerCase() === id.toLowerCase());
  if (matches.length === 1) return { id: matches[0].id, patch: getTemplate(matches[0].id)! };
  if (matches.length > 1) throw new CliError(`"${id}" matches ${matches.map((t) => t.id).join(', ')}; give the full id`);
  throw new CliError(`no template "${id}"${suggest(id, all.map((t) => t.id))}. See sfxgen templates.`);
}

const newCommand: Command = {
  name: 'new',
  summary: 'Start a patch from a template',
  usage: 'sfxgen new <templateId> [-o file.sfx.json] [--set id=value ...] [--seed n] [--force]',
  description:
    'Copies a template into a new patch file, optionally with some controls set, ready to edit and render. The template id is recorded in meta.template.',
  options: [
    { name: 'out', alias: 'o', value: 'required', arg: '<file.sfx.json>', help: 'Where to write it (default: ./<template name>.sfx.json).' },
    SET,
    SEED,
    { name: 'force', help: 'Overwrite the file if it exists.' },
  ],
  examples: ['sfxgen new impacts/thud -o door.sfx.json', 'sfxgen new thud --set weight=0.8'],
  async run(args) {
    const id = args.positional[0];
    if (!id) throw new UsageError('which template? sfxgen new <templateId> (sfxgen templates lists them)');
    const { id: fullId, patch } = findTemplate(id);
    const seed = numberOption(args, 'seed', (n) => Number.isFinite(n), 'a number');
    if (seed !== undefined) patch.seed = seed;
    const sets = applySets(patch, args.values.get('set') ?? []);
    let file = value(args, 'out') ?? `${basename(fullId)}.sfx.json`;
    if (!file.endsWith('.json')) file += '.sfx.json';
    if (existsSync(file) && !args.flags.has('force')) throw new CliError(`${file} exists; use --force to overwrite it or -o for another name`);
    writeFile(file, JSON.stringify(patch, null, 2) + '\n');
    out(`Wrote ${file} from ${fullId} (${patch.name})${sets.length ? ` with ${sets.join(', ')}` : ''}.`);
    for (const c of patch.controls ?? []) out(`  control ${c.id} = ${c.value}${c.hint ? `: ${c.hint}` : ''}`);
    out(`Next: sfxgen render ${file} --analyze --png`);
    return 0;
  },
};

const diffCommand: Command = {
  name: 'diff',
  summary: 'What changed between two patches, by path',
  usage: 'sfxgen diff <before.sfx.json> <after.sfx.json> [--json]',
  description:
    'Lists every change from one patch to another by parameter path (tracks, effects and controls are matched by id), so you can see what a person changed in the editor. Prints "no changes" when they are the same.',
  options: [JSON_OUT],
  examples: ['sfxgen diff door.before.sfx.json door.sfx.json', 'git show HEAD:door.sfx.json > /tmp/old.json && sfxgen diff /tmp/old.json door.sfx.json'],
  async run(args) {
    if (args.positional.length !== 2) throw new UsageError('give two patches: sfxgen diff <before> <after>');
    const [a, b] = args.positional;
    const changes = diffValues(loadPatch(a), loadPatch(b));
    if (args.flags.has('json')) {
      out(JSON.stringify(changes, null, 2));
      return 0;
    }
    if (changes.length === 0) {
      out('no changes');
      return 0;
    }
    for (const c of changes) {
      if (c.before === undefined) out(`+ ${c.path}: ${compact(c.after)}`);
      else if (c.after === undefined) out(`- ${c.path}: was ${compact(c.before)}`);
      else out(`~ ${c.path}: ${compact(c.before, 60)} -> ${compact(c.after, 60)}`);
    }
    out(`${changes.length} change${changes.length === 1 ? '' : 's'} (+ added, - removed, ~ changed)`);
    return 0;
  },
};

const serveCommand: Command = {
  name: 'serve',
  summary: 'Open the editor on the patches in a folder (live, both ways)',
  usage: 'sfxgen serve [dir] [--port 5179] [--open] [--file f]',
  description:
    'Serves the editor and a small API over the *.sfx.json files under dir (default .). The editor live-reloads when a file changes on disk, and a person\'s tweaks are saved back to the file.',
  options: [
    { name: 'port', value: 'required', arg: '<n>', help: 'Port (default 5179).' },
    { name: 'open', help: 'Open the editor in the default browser.' },
    { name: 'file', value: 'required', arg: '<patch>', help: 'Patch to open first, relative to dir.' },
  ],
  examples: ['sfxgen serve .', 'sfxgen serve sounds --open --file door.sfx.json'],
  async run(args) {
    const root = resolve(args.positional[0] ?? '.');
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new CliError(`${root}: not a directory`);
    const port = numberOption(args, 'port', (n) => Number.isInteger(n) && n >= 0 && n < 65536, 'a port number') ?? 5179;
    const { startServer } = await import('./server');
    // The server prints its own address and folder.
    const server = await startServer({ root, port, open: args.flags.has('open'), file: value(args, 'file') });
    out('  Ctrl+C to stop.');
    const stop = () => {
      void server.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  },
};

const mcpCommand: Command = {
  name: 'mcp',
  summary: 'Run the MCP server over stdio',
  usage: 'sfxgen mcp [dir]',
  description:
    'Runs the Model Context Protocol server on stdin/stdout, with the patch files under dir (default .) as its workspace: the same operations as the CLI as tools, and the analysis with its spectrogram image. Configure your MCP client to run `npx sfxgen mcp <dir>`.',
  options: [],
  examples: ['sfxgen mcp .', 'claude mcp add sfxgen -- npx sfxgen mcp .'],
  async run(args) {
    const root = resolve(args.positional[0] ?? '.');
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new CliError(`${root}: not a directory`);
    const { startMcp } = await import('./mcp');
    await startMcp({ root });
    return 0;
  },
};

const COMMANDS: Command[] = [
  renderCommand,
  analyzeCommand,
  validateCommand,
  guideCommand,
  schemaCommand,
  templatesCommand,
  newCommand,
  diffCommand,
  serveCommand,
  mcpCommand,
];

// ---- Help ----------------------------------------------------------------------------------------------

function commandHelp(c: Command): string {
  const opts = [...c.options, HELP];
  const left = opts.map((o) => `${o.alias ? `-${o.alias}, ` : '    '}--${o.name}${o.arg ? ` ${o.arg}` : ''}`);
  const width = Math.max(...left.map((l) => l.length)) + 2;
  return [
    `Usage: ${c.usage}`,
    '',
    c.description,
    '',
    'Options:',
    ...opts.map((o, i) => `  ${left[i].padEnd(width)}${o.help}`),
    '',
    'Examples:',
    ...c.examples.map((e) => `  ${e}`),
  ].join('\n');
}

function mainHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
  return [
    `sfxgen ${VERSION}: sound effects from JSON patches, written by agents and finished by ear.`,
    '',
    'Usage: sfxgen <command> [options]        sfxgen <command> --help for its options',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
    '',
    'The loop, for an agent:',
    '  sfxgen guide --section overview              the format; then --type <node> for any source or effect',
    '  sfxgen templates --search "metal door"       find a starting point',
    '  sfxgen new impacts/thud -o door.sfx.json     copy it; edit the JSON',
    '  sfxgen render door.sfx.json --analyze --png  read the numbers, look at door.png',
    '  sfxgen serve .                               a person tunes the controls by ear',
    '  sfxgen diff before.sfx.json door.sfx.json    see what they changed',
  ].join('\n');
}

// ---- Main ------------------------------------------------------------------------------------------------

/** Runs the CLI with these arguments (without `node` and the script) and returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === '-h' || name === '--help' || name === 'help') {
    const topic = name === 'help' ? COMMANDS.find((c) => c.name === rest[0]) : undefined;
    out(topic ? commandHelp(topic) : mainHelp());
    return 0;
  }
  if (name === '-v' || name === '--version' || name === 'version') {
    out(VERSION);
    return 0;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    err(`sfxgen: unknown command "${name}"${suggest(name, COMMANDS.map((c) => c.name))}. Commands: ${COMMANDS.map((c) => c.name).join(', ')}.`);
    return 2;
  }
  try {
    const args = parseArgs(rest, command.options);
    if (args.flags.has('help')) {
      out(commandHelp(command));
      return 0;
    }
    const code = await command.run(args);
    return code ?? 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`sfxgen ${command.name}: ${e.message}\nUsage: ${command.usage}\nMore: sfxgen ${command.name} --help`);
      return 2;
    }
    if (e instanceof CliError) {
      err(`sfxgen ${command.name}: ${e.message}`);
      return 1;
    }
    err(`sfxgen ${command.name}: ${(e as Error)?.message ?? String(e)}`);
    if (process.env.SFXGEN_DEBUG) err(String((e as Error)?.stack ?? ''));
    return 1;
  }
}

function invokedDirectly(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // `sfxgen guide | head` closes the pipe early: stop quietly instead of crashing on EPIPE.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  main(process.argv.slice(2)).then(
    (code) => {
      // Set the code rather than exiting, so piped output is flushed and serve/mcp keep running.
      process.exitCode = code;
    },
    (e) => {
      err(String(e?.stack ?? e));
      process.exitCode = 1;
    },
  );
}
