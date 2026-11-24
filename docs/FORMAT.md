# The sfxgen patch format (`sfxgen/1`)

A patch is one sound effect in one JSON file, conventionally `name.sfx.json`. It is small enough to write by hand,
diff in git and hand back and forth between an agent and a person. Rendering is deterministic: the same patch,
seed and sample rate give the same samples in the browser and from the command line.

This page covers the structure. The catalog of sources and effects, with every parameter, its unit and range,
comes from the code: run `sfxgen guide` (or call the `describe_format` tool), so it is never out of date.

## A whole patch

```json
{
  "format": "sfxgen/1",
  "name": "Rusty hatch clunk",
  "description": "A heavy steel hatch dropping shut: latch click, body thud, a dull ring.",
  "tags": ["metal", "door", "impact"],
  "duration": "auto",
  "seed": 7,
  "output": { "sampleRate": 48000, "channels": 1 },
  "tracks": [
    {
      "id": "latch",
      "note": "The first 5 ms: what makes it read as metal.",
      "source": {
        "type": "noise",
        "color": "white",
        "env": { "attack": 0.0005, "decay": 0.02 },
        "filter": { "mode": "bandpass", "cutoff": 4200, "q": 1.4 }
      }
    },
    {
      "id": "body",
      "start": 0.003,
      "source": {
        "type": "osc",
        "wave": "sine",
        "freq": [[0, 160], [0.08, 62]],
        "env": { "attack": 0.001, "decay": 0.35 }
      },
      "fx": [{ "type": "drive", "mode": "tube", "amount": 10 }]
    }
  ],
  "master": { "normalize": { "mode": "peak", "target": -1 } },
  "controls": [
    {
      "id": "weight",
      "label": "Weight",
      "hint": "Lower and longer: a heavier door.",
      "value": 0.5,
      "targets": [
        { "path": "tracks.body.source.freq", "mode": "mul", "from": 1.6, "to": 0.6 },
        { "path": "tracks.body.source.env.decay", "mode": "set", "from": 0.2, "to": 0.6 }
      ]
    }
  ]
}
```

## Top level

| Field | Meaning |
| --- | --- |
| `format` | Always `"sfxgen/1"`. |
| `name`, `description`, `tags` | For people and for searching the library. |
| `duration` | Seconds, or `"auto"`: until every layer has rung out (capped by `maxDuration`, default 10). |
| `seed` | Every random choice comes from it. Change it for a new take of the same design. |
| `output` | `sampleRate` (default 48000), `channels` 1 or 2 (default 1), `bitDepth` 16, 24 or 32 for WAV export. |
| `loop` | Present only for a seamless loop of exactly `duration` seconds: `{ "mode": "wrap" }` adds whatever rings past the end back onto the start; `{ "mode": "crossfade", "crossfade": 0.1 }` fades the end into the start. |
| `tracks` | The layers. |
| `buses` | Shared effect chains that tracks send to, such as one reverb for several layers. |
| `master` | `fx`, `gain` (dB), `normalize` (`{ "mode": "peak", "target": -1 }` default, or `"loudness"` in LUFS, or `"none"`), `fadeIn`, `fadeOut`, `dcBlock`. |
| `controls` | The knobs a person sees first. |
| `meta` | Anything else: provenance, the template it came from, notes. The renderer ignores it. |

## Tracks

A track is one layer: a **source** played by one or more **events**, then the track's **effects**.

| Field | Meaning |
| --- | --- |
| `id` | Unique; letters, digits, `_`, `-`. Paths use it. |
| `name`, `color`, `note` | For the editor. `note` says why the layer exists, for the person tweaking it. |
| `start` | Seconds from the start of the patch. |
| `length` | Cuts the source after this many seconds (with a 5 ms fade); effect tails keep ringing. |
| `gain`, `pan` | dB; -1 to 1 (stereo output only). |
| `mute`, `solo` | As on a mixer. |
| `source` | `{ "type": ..., ...params }`, see below. |
| `events` | When the source plays, in seconds from the track's start: `[0, 0.12, 0.3]`, or objects `{ "t": 0.12, "pitch": 3, "vel": 0.7, "dur": 0.2 }`. Default: once at 0. |
| `repeat` | Shorthand for a run of events: `{ "count": 6, "interval": 0.09, "accel": 0.8, "decay": -3, "pitchStep": 1, "jitter": 0.004 }`. `accel` below 1 speeds up like a bouncing ball. |
| `fx` | Effect chain, in order: `[{ "type": "filter", ... }, { "type": "reverb", ... }]`. |
| `sends` | `{ "busId": -6 }`: send level in dB, after the track's effects. |

Each event renders the source on its own, with its own pitch (semitones), velocity (scales the level) and held
time (`dur`, which is the envelope's gate), and its own randomness.

## Sources

Every source has these common parameters beside its own:

| Field | Meaning |
| --- | --- |
| `type` | Which generator: `osc`, `noise`, and the rest of the catalog (`sfxgen guide`). |
| `gain` | dB. |
| `env` | Amplitude envelope, see below. Each source type has a sensible default. |
| `pitch` | Semitones added to every pitched parameter (`freq` and the like). It can move: `[[0, 0], [0.3, -12]]` drops the whole voice an octave. |
| `filter` | A filter inside the voice, so every event gets its own sweep: `{ "mode": "lowpass", "cutoff": [[0, 8000], [0.2, 600]], "q": 2, "slope": 24, "keytrack": 0.5 }`. Modes: lowpass, highpass, bandpass, notch, peak, allpass, lowshelf, highshelf. |

## Parameters that move

Any parameter the catalog marks as a *signal* takes one of three forms:

```json
"freq": 440
"freq": [[0, 2000], [0.05, 900], [0.4, 120, "exp"]]
"freq": { "value": 440, "mod": [{ "type": "lfo", "rate": 6, "depth": 0.3, "unit": "st", "delay": 0.1, "fade": 0.2 }] }
```

- **Breakpoints** are `[seconds, value]` or `[seconds, value, curve]`, measured from the start of the event (in a
  voice) or of the track (in an effect). Before the first point the value is the first point's; after the last,
  the last's. The optional curve shapes the segment that *ends* at that point: `linear`, `exp` (constant ratio, the
  natural glide for frequencies and times), `smooth`, `hold`, or a number from -1 (fast first) to 1 (slow first).
  Parameters on a log scale (frequencies, times) glide `exp` by default; the rest `linear`.
- **Signal objects** take `value` or `env` (breakpoints), an optional default `curve`, and `mod`: a list of
  modulators added on top.
- **Modulators**: `{ "type": "lfo", "rate": 6, "depth": 0.3 }` with `shape` sine, triangle, square, saw, ramp,
  random (sample and hold) or smooth-random; or `{ "type": "wander", "rate": 8, "depth": 20, "unit": "cents" }` for
  smooth random drift. `rate` and `depth` may themselves be breakpoints (a tumble that speeds up, vibrato that fades
  in). `unit` is `st`, `cents`, `oct`, `pct`, `db` or `value` (added as is); the default is `st` for log-scale
  parameters and `value` otherwise. `delay` and `fade` hold the modulator back and fade it in.

## Envelopes

```json
"env": { "attack": 0.002, "hold": 0, "decay": 0.3, "sustain": 0, "release": 0.05, "gate": 0.2, "curve": "exp" }
"env": { "points": [[0, 0], [0.01, 1], [0.2, 0.3], [0.6, 0]], "curve": "exp" }
```

- ADSR times are seconds. With the default `exp` curve, `decay` is the time to fall 60 dB toward `sustain`, and
  `release` the time to fall 60 dB to silence, so `{ "decay": 0.3 }` is a natural ring that is gone in 0.3 s.
  `sustain` defaults to 0 when `decay` is set (a one-shot), else 1. The release starts at `gate`, or at the event's
  `dur`, or never.
- Points envelopes give levels 0 to 1 over time; with `"curve": "exp"` they are interpolated in decibels.

## Effects

An effect is `{ "type": ..., ...params }` with three common fields: `id` (so paths and controls can name it),
`bypass`, and `mix` (0 dry to 1 fully processed). `mix` defaults to 1, except where an effect declares its own
default: `reverb` (0.3) and `delay` (0.35) on a track or the master, so the dry sound still passes. On a bus, which
tracks send into, every effect defaults to fully wet. Effects run on the whole track, bus or master buffer; their
breakpoints are measured from the start of that buffer.

## Paths

Controls, edits and tools address parameters by dot path. In an array, a segment picks the item whose `id`
matches, else the item at that position:

```
tracks.body.source.freq
tracks.body.source.env.decay
tracks.body.source.filter.cutoff
tracks.body.fx.space.mix          (the effect with "id": "space")
tracks.body.fx.0.amount           (the first effect)
tracks.body.repeat.interval
tracks.body.gain
buses.room.fx.0.decay
master.gain
duration
seed
```

## Controls

Controls are the few knobs a person sees before anything else. The agent that writes a patch chooses them: the
moves that matter for this sound, named in the listener's words. Everything else stays reachable in the editor's
full view.

```json
{
  "id": "size",
  "label": "Size",
  "hint": "Small tin can to oil drum.",
  "value": 0.4,
  "min": 0, "max": 1,
  "vary": 0.08,
  "targets": [
    { "path": "tracks.shell.source.freq", "mode": "mul", "from": 2, "to": 0.4 },
    { "path": "tracks.shell.source.decay", "mode": "mul", "from": 0.6, "to": 2.2 },
    { "path": "tracks.thud.gain", "mode": "add", "from": -9, "to": 3 }
  ]
}
```

- `value` sits between `min` and `max` (default 0 and 1). `scale: "exp"` spreads a wide positive range evenly.
- Each target maps the control's position onto a parameter:
  - `set` (default): the parameter becomes a value between `from` and `to` (defaults: the parameter's range).
  - `mul`: multiplies the parameter, breakpoints and all. The right move for pitch and time on a moving parameter.
  - `add`: adds to it (dB on gains, semitones on `pitch`).
  - `stretch`: multiplies the times of the parameter's breakpoints, or every time of an ADSR envelope.
  - `curve`: how the position maps: `linear`, `exp` (the default when both ends are positive and the parameter is
    on a log scale, or for `mul` and `stretch`), `smooth`, or a bend number.
- `widget: "select"` or `"toggle"` with `options: [{ "label": "Steel", "set": { "tracks.shell.source.material": "metal" } }, ...]`
  picks one of several settings; `value` is the option's index.
- `vary` is how far variations may move the control (± in its units), for round-robin takes.
- Controls apply in order, to a copy of the patch, just before rendering. The patch keeps its base values.

**Choosing controls.** Three to seven, each one a perceptual move (Size, Weight, Grit, Distance, Speed, Brightness,
Wetness), never a raw DSP name. Each should change the sound audibly across its whole range and never break it.
Prefer one control driving several parameters coherently (Size lowers pitch, lengthens decay and adds room) over one
control per parameter. Write the `hint` as what the listener hears.

## Validation

`sfxgen validate file.sfx.json` (or the `set_patch` tool) checks a patch against the format and the catalog.
Errors stop a render; warnings are advice, such as an unknown parameter name with the closest valid one.
