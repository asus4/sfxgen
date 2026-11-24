/**
 * The agent guide (`sfxgen guide`, the describe_format tool): the format in brief, then the catalog generated from
 * the registry, so it is never out of date: every source and effect with its doc, a parameter table (nested fields
 * included) and its example, then the template library.
 *
 * The format section is a condensed docs/FORMAT.md (the bundlers can't all import markdown as text); keep the two
 * in step. Field tables that the registry describes (tracks, envelopes, repeats, the master) are generated.
 */
import type { NodeDef, ParamMap, ParamMeta } from '../nodes';
import { COMMON_EFFECT_PARAMS, COMMON_SOURCE_PARAMS } from '../nodes';
import { ENVELOPE_FIELDS, MASTER_FIELDS, REPEAT_FIELDS, TRACK_FIELDS, getEffect, getSource, listEffects, listSources } from '../registry';
import { suggest } from '../format/validate';
import { listTemplates } from '../templates';

export type GuideSection = 'overview' | 'index' | 'sources' | 'effects' | 'templates' | 'all';

export interface GuideOptions {
  /** Which part: the format and an index of nodes (`overview`), the full catalog of sources or effects, or all. */
  section?: GuideSection;
  /** One source or effect in detail (with the common parameters it shares). */
  type?: string;
  /** Alias of `type`. */
  node?: string;
}

// ---- Tables -------------------------------------------------------------------------------------------

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

function num(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (Math.abs(x) >= 1e6) return x.toExponential(0);
  return String(Math.round(x * 10000) / 10000);
}

function unitOf(m: ParamMeta): string {
  return m.unit && m.unit !== 'x' ? ` ${m.unit}` : m.unit === 'x' ? 'x' : '';
}

function kindOf(m: ParamMeta): string {
  if (m.kind === 'array') return m.item ? `list of ${m.item.kind === 'object' ? 'objects' : m.item.kind === 'array' ? 'lists' : m.item.kind}` : 'list';
  return m.kind;
}

function rangeOf(m: ParamMeta): string {
  if (m.kind === 'enum') return (m.options ?? []).map((o) => `\`${o}\``).join(', ');
  const parts: string[] = [];
  const u = unitOf(m);
  if (m.min !== undefined || m.max !== undefined) parts.push(`${num(m.min ?? -Infinity)} to ${num(m.max ?? Infinity)}${u}`);
  if (m.hardMin !== undefined || m.hardMax !== undefined) {
    parts.push(`limits ${m.hardMin !== undefined ? num(m.hardMin) : '...'} to ${m.hardMax !== undefined ? num(m.hardMax) : '...'}`);
  }
  if (m.scale === 'log') parts.push('log');
  if (m.pitch) parts.push('follows pitch');
  if (m.step !== undefined) parts.push(`step ${num(m.step)}`);
  if (parts.length === 0 && m.unit) parts.push(m.unit);
  return parts.join('; ');
}

function defaultOf(m: ParamMeta): string {
  if (m.default === undefined) return '';
  const u = typeof m.default === 'number' ? unitOf(m) : '';
  return `\`${JSON.stringify(m.default)}\`${u}`;
}

/** Rows for one parameter and, below it, its nested fields (`filter.cutoff`, `partials[].ratio`). */
function paramRows(name: string, m: ParamMeta, out: string[][]): void {
  out.push([`\`${name}\``, kindOf(m), defaultOf(m), cell(rangeOf(m)), cell(m.doc + (m.advanced ? ' (advanced)' : ''))]);
  if (m.kind === 'object' && m.fields) for (const [k, f] of Object.entries(m.fields)) paramRows(`${name}.${k}`, f, out);
  if (m.kind === 'array' && m.item) {
    if (m.item.kind === 'object' && m.item.fields) for (const [k, f] of Object.entries(m.item.fields)) paramRows(`${name}[].${k}`, f, out);
    else if (m.item.kind === 'array' || m.item.min !== undefined || m.item.unit) paramRows(`${name}[]`, m.item, out);
  }
}

function table(params: ParamMap): string {
  const rows: string[][] = [];
  for (const [name, m] of Object.entries(params)) paramRows(name, m, rows);
  const head = ['Parameter', 'Kind', 'Default', 'Range', 'What it does'];
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/** A compact table for patch fields the registry describes (no kind column: they are plain numbers or flags). */
function fieldTable(fields: ParamMap, extra: [string, string][] = []): string {
  const rows = [
    ...extra.map(([k, d]) => [`\`${k}\``, d]),
    ...Object.entries(fields).map(([k, m]) => {
      const bits = [m.doc.replace(/\.$/, '')];
      const r = m.kind === 'enum' ? '' : rangeOf(m);
      if (r) bits.push(r);
      if (m.default !== undefined) bits.push(`default ${JSON.stringify(m.default)}`);
      return [`\`${k}\``, cell(bits.join('; ') + '.')];
    }),
  ];
  return ['| Field | Meaning |', '| --- | --- |', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const json = (v: unknown): string => '```json\n' + JSON.stringify(v) + '\n```';

// ---- Nodes ----------------------------------------------------------------------------------------------

function nodeSection(def: NodeDef, level = '###'): string {
  const lines = [`${level} \`${def.type}\`: ${def.label} (${def.kind}, ${def.category})`, '', def.doc, '', table(def.params)];
  if (def.example) lines.push('', 'Example:', '', json(def.example));
  return lines.join('\n');
}

function nodeDetail(def: NodeDef): string {
  const common = def.kind === 'source' ? COMMON_SOURCE_PARAMS : COMMON_EFFECT_PARAMS;
  const where =
    def.kind === 'source'
      ? `In a track: \`"source": { "type": "${def.type}", ... }\`. Paths: \`tracks.<track>.source.<param>\`.`
      : `In a chain: \`"fx": [{ "type": "${def.type}", "id": "x", ... }]\` on a track, a bus or the master. Paths: \`tracks.<track>.fx.<id or index>.<param>\`.`;
  const lines = [
    nodeSection(def, '#'),
    '',
    where,
    '',
    `## Common ${def.kind} parameters`,
    '',
    def.kind === 'source'
      ? 'Every source also takes these. `signal` parameters accept a number, breakpoints `[[seconds, value], ...]` or `{ "value" | "env", "mod": [...] }`.'
      : 'Every effect also takes these.',
    '',
    table(common),
  ];
  if (def.kind === 'source') lines.push('', '`env` fields:', '', fieldTable(ENVELOPE_FIELDS, [['points', 'Instead of ADSR: `[[seconds, level 0..1], ...]`.']]));
  return lines.join('\n');
}

function nodeIndex(defs: NodeDef[]): string {
  const byCategory = new Map<string, NodeDef[]>();
  for (const d of defs) byCategory.set(d.category, [...(byCategory.get(d.category) ?? []), d]);
  const lines: string[] = [];
  for (const [cat, list] of byCategory) {
    lines.push(`- **${cat}**: ${list.map((d) => `\`${d.type}\` (${d.label.toLowerCase()})`).join(', ')}`);
  }
  return lines.join('\n');
}

// ---- The format, condensed from docs/FORMAT.md ----------------------------------------------------------

const EXAMPLE = {
  format: 'sfxgen/1',
  name: 'Rusty hatch clunk',
  description: 'A heavy steel hatch dropping shut: latch click, body thud, a dull ring.',
  tags: ['metal', 'door', 'impact'],
  duration: 'auto',
  seed: 7,
  tracks: [
    {
      id: 'latch',
      note: 'The first 5 ms: what makes it read as metal.',
      source: { type: 'noise', color: 'white', env: { attack: 0.0005, decay: 0.02 }, filter: { mode: 'bandpass', cutoff: 4200, q: 1.4 } },
    },
    {
      id: 'body',
      start: 0.003,
      source: { type: 'osc', wave: 'sine', freq: [[0, 160], [0.08, 62]], env: { attack: 0.001, decay: 0.35 } },
      fx: [{ type: 'drive', mode: 'tube', amount: 10 }],
    },
  ],
  master: { normalize: { mode: 'peak', target: -1 } },
  controls: [
    {
      id: 'weight',
      label: 'Weight',
      hint: 'Lower and longer: a heavier door.',
      value: 0.5,
      targets: [
        { path: 'tracks.body.source.freq', mode: 'mul', from: 1.6, to: 0.6 },
        { path: 'tracks.body.source.env.decay', mode: 'set', from: 0.2, to: 0.6 },
      ],
    },
  ],
};

function overview(): string {
  const sources = listSources();
  const effects = listEffects();
  return [
    '# sfxgen: guide for agents',
    '',
    'sfxgen renders sound effects from JSON patches (`name.sfx.json`, format `sfxgen/1`). The same patch, seed and sample rate give the same samples in the browser and from the command line.',
    '',
    '## Workflow',
    '',
    '1. Read docs/SOUND-DESIGN.md once: start from a story (what is it, what is it made of, what happens in order, where, through what), not from waveforms.',
    '2. Start from the nearest template (`sfxgen templates --search "metal door"`, then `sfxgen new impacts/thud -o door.sfx.json`) or write a patch from scratch. Put the story in `description` and each track\'s `note`.',
    '3. `sfxgen validate door.sfx.json`, then `sfxgen render door.sfx.json --analyze --png`. You can\'t hear it: read the analysis and look at `door.png` (waveform on top, log-frequency spectrogram below). Check the numbers against the story and say what you could not check.',
    '4. Give the person 3 to 7 `controls`, named in a listener\'s words, each tested at both ends. `sfxgen render --set weight=1` renders one end.',
    '5. `sfxgen serve .` opens the editor on the same files; their changes are saved back, and `sfxgen diff old.sfx.json door.sfx.json` lists them by path.',
    '',
    'Parts of this guide: `sfxgen guide --section overview|sources|effects|templates`, or one node with `sfxgen guide --type modal`. Editors autocomplete patches with the JSON Schema: `sfxgen schema --write` and `"$schema": "<path to sfxgen.schema.json>"` in the patch.',
    '',
    '## A patch',
    '',
    '```json',
    JSON.stringify(EXAMPLE, null, 2),
    '```',
    '',
    fieldTable({}, [
      ['format', 'Always `"sfxgen/1"`.'],
      ['name, description, tags', 'For people and for searching. The description is the story.'],
      ['duration', 'Seconds, or `"auto"`: until every layer has rung out (capped by `maxDuration`, default 10).'],
      ['seed', 'Every random choice comes from it; change it for another take of the same design.'],
      ['output', '`sampleRate` (default 48000), `channels` 1 or 2 (default 1), `bitDepth` 16, 24 or 32 for WAV export.'],
      ['loop', 'Only for a seamless loop of exactly `duration` seconds: `{ "mode": "wrap" }` (the tail folds onto the start) or `{ "mode": "crossfade", "crossfade": 0.1 }`.'],
      ['tracks', 'The layers, below.'],
      ['buses', '`[{ "id": "room", "fx": [...], "gain": 0 }]`: shared chains that tracks send to (one reverb for several layers).'],
      ['master', '`fx`, `gain` (dB), `normalize` (`{ "mode": "peak", "target": -1 }` default, `"loudness"` in LUFS, or `"none"`), `fadeIn`, `fadeOut`, `dcBlock`.'],
      ['controls', 'The knobs a person sees first, below.'],
      ['meta', 'Anything else (provenance, the template it came from). The renderer ignores it.'],
    ]),
    '',
    '## Tracks',
    '',
    'A track is one layer: a **source** played by one or more **events**, then the track\'s **effects**, then `gain` and `pan`.',
    '',
    fieldTable(TRACK_FIELDS, [
      ['id', 'Unique; letters, digits, `_` and `-`. Paths use it.'],
      ['name, color, note', 'For the editor. `note` says why the layer exists, for the person tweaking it.'],
      ['source', '`{ "type": "...", ...params }`: see Sources.'],
      ['events', 'When the source plays, seconds from the track start: `[0, 0.12]` or `[{ "t": 0.12, "pitch": 3, "vel": 0.7, "dur": 0.2 }]`. Default: once at 0. Each event renders the source on its own (pitch in semitones, velocity scales level, `dur` is the gate).'],
      ['repeat', 'A run of events instead of `events`; fields below.'],
      ['fx', 'Effect chain, in order: `[{ "type": "filter", ... }, { "type": "reverb", ... }]`.'],
      ['sends', '`{ "busId": -6 }`: send level in dB, after the track\'s effects.'],
    ]),
    '',
    '`repeat` (ratchets, bounces, rolls; `accel` below 1 speeds up like a bouncing ball):',
    '',
    fieldTable(REPEAT_FIELDS),
    '',
    '## Sources',
    '',
    'Every source takes `type`, `gain` (dB), `env` (its amplitude envelope; each type has a sensible default), `pitch` (semitones added to every pitched parameter, and it can move: `[[0, 0], [0.3, -12]]` drops the voice an octave) and `filter` (inside the voice, so every event gets its own sweep: `{ "mode": "lowpass", "cutoff": [[0, 8000], [0.2, 600]], "q": 2, "slope": 24, "keytrack": 0.5 }`).',
    '',
    nodeIndex(sources),
    '',
    '## Parameters that move',
    '',
    'Any parameter of kind `signal` takes a number, breakpoints, or a signal object:',
    '',
    '```json',
    '"freq": 440',
    '"freq": [[0, 2000], [0.05, 900], [0.4, 120, "exp"]]',
    '"freq": { "value": 440, "mod": [{ "type": "lfo", "rate": 6, "depth": 0.3, "unit": "st", "delay": 0.1, "fade": 0.2 }] }',
    '```',
    '',
    '- Breakpoints are `[seconds, value]` or `[seconds, value, curve]`, from the start of the event (in a voice) or of the track (in an effect). Before the first point the value is the first point\'s; after the last, the last\'s. The curve shapes the segment that ends at that point: `linear`, `exp` (constant ratio; the default on log-scale parameters such as frequencies and times), `smooth`, `hold`, or a bend from -1 (fast first) to 1 (slow first).',
    '- A signal object has `value` or `env` (breakpoints), an optional default `curve`, and `mod`: modulators added on top.',
    '- Modulators: `{ "type": "lfo", "rate": 6, "depth": 0.3 }` with `shape` sine, triangle, square, saw, ramp, random or smooth-random; or `{ "type": "wander", "rate": 8, "depth": 20, "unit": "cents" }` for smooth random drift. `rate` and `depth` may be breakpoints. `unit` is `st`, `cents`, `oct`, `pct`, `db` or `value`; the default is `st` on log-scale parameters, else `value`. `delay` and `fade` hold the modulator back and fade it in.',
    '',
    '## Envelopes',
    '',
    '```json',
    '"env": { "attack": 0.002, "decay": 0.3 }',
    '"env": { "points": [[0, 0], [0.01, 1], [0.2, 0.3], [0.6, 0]], "curve": "exp" }',
    '```',
    '',
    'With the default `exp` curve, `decay` is the time to fall 60 dB toward `sustain` and `release` the time to fall 60 dB to silence, so `{ "decay": 0.3 }` is a natural ring gone in 0.3 s. `sustain` defaults to 0 when `decay` is set (a one-shot), else 1. The release starts at `gate`, else at the event\'s `dur`, else never. Points envelopes give levels 0 to 1 over time; with `"curve": "exp"` they are interpolated in decibels.',
    '',
    fieldTable(ENVELOPE_FIELDS),
    '',
    '## Effects',
    '',
    'An effect is `{ "type": ..., ...params }` with `id` (so paths and controls can name it), `bypass`, and `mix` (0 dry to 1 fully processed, default 1). Effects run on the whole track, bus or master buffer; their breakpoints count from the start of that buffer.',
    '',
    nodeIndex(effects),
    '',
    'The master:',
    '',
    fieldTable(MASTER_FIELDS),
    '',
    '## Paths',
    '',
    'Controls, edits and tools address parameters by dot path. In a list a segment picks the item whose `id` matches, else the item at that position: `tracks.body.source.freq`, `tracks.body.source.env.decay`, `tracks.body.source.filter.cutoff`, `tracks.body.fx.space.mix` (the effect with `"id": "space"`), `tracks.body.fx.0.amount` (the first effect), `tracks.body.repeat.interval`, `buses.room.fx.0.decay`, `master.gain`, `duration`, `seed`.',
    '',
    '## Controls',
    '',
    'Controls are the few knobs a person sees first: the moves that matter for this sound, named in the listener\'s words.',
    '',
    '```json',
    '{ "id": "size", "label": "Size", "hint": "Small tin can to oil drum.", "value": 0.4, "min": 0, "max": 1, "vary": 0.08,',
    '  "targets": [',
    '    { "path": "tracks.shell.source.freq", "mode": "mul", "from": 2, "to": 0.4 },',
    '    { "path": "tracks.shell.source.decay", "mode": "mul", "from": 0.6, "to": 2.2 },',
    '    { "path": "tracks.thud.gain", "mode": "add", "from": -9, "to": 3 } ] }',
    '```',
    '',
    '- `value` sits between `min` and `max` (default 0 and 1); `scale: "exp"` spreads a wide positive range evenly.',
    '- Target modes: `set` (default: the parameter becomes a value between `from` and `to`, by default the parameter\'s range), `mul` (multiplies it, breakpoints and all: the right move for pitch and time), `add` (dB on gains, semitones on `pitch`), `stretch` (multiplies breakpoint times, or every time of an ADSR envelope). `curve` maps the position: `linear`, `exp` (default when both ends are positive and the parameter is on a log scale, or for `mul` and `stretch`), `smooth`, or a bend.',
    '- `widget: "select"` or `"toggle"` with `options: [{ "label": "Steel", "set": { "tracks.shell.source.material": "metal" } }]` picks one of several settings; `value` is the option\'s index.',
    '- `vary` is how far variations may move the control, for round-robin takes (`sfxgen render --variations 5`).',
    '- Three to seven controls, each a perceptual move (Size, Weight, Grit, Distance, Speed, Brightness, Wetness) that changes the sound audibly across its whole range and never breaks it. Prefer one control driving several parameters coherently over one control per parameter. Write the `hint` as what the listener hears.',
    '',
    '## Reading the analysis',
    '',
    '`sfxgen analyze` (and `render --analyze`) prints a few plain lines, then the numbers:',
    '',
    '- **Level**: sample peak and true peak (dBFS), integrated loudness (LUFS, BS.1770), crest (peak over RMS: high is punchy, low is dense).',
    '- **Time**: attack (10% to 90% of the envelope\'s maximum, for the hit that gets loudest), when it is loudest, `decay20` (time to fall 20 dB after the loud part), when it has fallen 60 dB (audible length), onsets (hits: a quick rise of 8 dB or more; slow swells and beating partials are not hits), and the level of the last stretch (`tail`; above -30 dB it is cut off).',
    '- **Spectrum**: centroid (the balance point of the spectrum: brightness) overall and in thirds of the audible part, so a falling centroid is a sound that darkens or sweeps down; 85% rolloff; energy share per band (sub <60 Hz, low 60-250, low-mid 250-800, mid 800-2.5k, high-mid 2.5k-6k, high 6k-12k, air >12k); tonal peaks (partials 15 dB above their surroundings).',
    '- **Pitch**: YIN on the strongest pitched stretch, with a clarity from 0 (noise) to 1 (pure tone) and a short pitch track for glides; none for noise.',
    '- **Problems**: clipping, DC offset, a click at the start or end, a cut-off tail, silence before the sound starts, and too much energy below 60 Hz for laptop and phone speakers.',
    '- **The spectrogram PNG**: the waveform strip on top (blue min/max, lighter RMS, red where it clips); below it time runs left to right and frequency bottom to top on a log axis from 20 Hz to 20 kHz, with faint lines at 100 Hz, 1 kHz and 10 kHz and every 100 ms (coarser for long sounds, finer for very short ones), labelled. Colour is level, from black (90 dB below the loudest point) through purple and orange to pale yellow.',
    '',
    '## Validation',
    '',
    '`sfxgen validate file.sfx.json` checks a patch against the format and the catalog. Errors stop a render; warnings are advice, such as an unknown parameter with the closest valid name.',
  ].join('\n');
}

function sourcesSection(): string {
  return [
    '## Sources in detail',
    '',
    '### Common source parameters',
    '',
    'Every source takes these beside its own. `env` takes the envelope fields above, or `points`.',
    '',
    table(COMMON_SOURCE_PARAMS),
    '',
    ...listSources().flatMap((def) => [nodeSection(def), '']),
  ].join('\n');
}

function effectsSection(): string {
  return [
    '## Effects in detail',
    '',
    '### Common effect parameters',
    '',
    table(COMMON_EFFECT_PARAMS),
    '',
    ...listEffects().flatMap((def) => [nodeSection(def), '']),
  ].join('\n');
}

function templatesSection(): string {
  const list = listTemplates();
  const lines = [
    '## Templates',
    '',
    `${list.length} patches to start from (\`sfxgen new <id> -o my.sfx.json\`; \`sfxgen templates --search words\` to filter):`,
    '',
  ];
  for (const t of list) {
    const controls = t.controls.length ? ` Controls: ${t.controls.map((c) => c.label).join(', ')}.` : '';
    lines.push(`- \`${t.id}\` **${t.name}**: ${t.description}${controls}`);
  }
  return lines.join('\n');
}

function firstSentence(text: string): string {
  const m = /^(.*?[.!?])(\s|$)/.exec(text.trim());
  return m ? m[1] : text.trim();
}

/** One line per source and effect: the catalog at a glance, for choosing what to read in detail. */
export function catalogIndex(): string {
  const line = (d: { type: string; category: string; doc: string }) => `- \`${d.type}\` (${d.category}): ${firstSentence(d.doc)}`;
  return [
    '## Catalog at a glance',
    '',
    'Sources:',
    ...listSources().map(line),
    '',
    'Effects:',
    ...listEffects().map(line),
  ].join('\n');
}

/**
 * The guide as markdown. With `type` (or `node`), one source or effect in detail; an unknown type throws, with the
 * closest name and the list of types in the message.
 */
export function buildGuide(opts: GuideOptions = {}): string {
  const type = opts.type ?? opts.node;
  if (type) {
    const def = getSource(type) ?? getEffect(type);
    if (!def) {
      const names = [...listSources(), ...listEffects()].map((d) => d.type);
      throw new Error(
        `No source or effect named "${type}"${suggest(type, names)}. ` +
          `Sources: ${listSources().map((d) => d.type).join(', ')}. Effects: ${listEffects().map((d) => d.type).join(', ')}.`,
      );
    }
    return nodeDetail(def) + '\n';
  }
  const section = opts.section ?? 'all';
  const parts: string[] = [];
  if (section === 'index') return catalogIndex() + '\n';
  if (section === 'overview' || section === 'all') parts.push(overview());
  if (section === 'sources' || section === 'all') parts.push(sourcesSection());
  if (section === 'effects' || section === 'all') parts.push(effectsSection());
  if (section === 'templates' || section === 'all') parts.push(templatesSection());
  return parts.join('\n\n') + '\n';
}
