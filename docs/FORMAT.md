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
  "name": "Steel hatch slam",
  "description": "A heavy steel hatch dropped shut in a small concrete room: the door meets its frame with a dull, dented boom, the latch snaps home 90 ms later, and the bare walls ring round both.",
  "tags": ["metal", "door", "impact"],
  "duration": "auto",
  "seed": 7,
  "output": { "sampleRate": 48000, "channels": 1 },
  "tracks": [
    {
      "id": "door",
      "note": "The hatch: a thick steel box hit along its edge. The dent and the damping stop it ringing like a bell.",
      "source": {
        "type": "modal",
        "material": "metal",
        "shape": "box",
        "freq": 82,
        "decay": 0.9,
        "damping": 1.6,
        "dent": 0.35,
        "position": 0.9,
        "exciter": { "kind": "mallet", "hardness": 0.8 }
      },
      "sends": { "room": -8 }
    },
    {
      "id": "latch",
      "note": "The latch snapping home: a small, damped steel bar, well under the door.",
      "gain": -10,
      "events": [0.09],
      "source": {
        "type": "modal",
        "material": "metal",
        "shape": "bar",
        "freq": 1400,
        "decay": 0.08,
        "damping": 2.5,
        "dent": 0.4,
        "position": 0.8,
        "exciter": { "kind": "mallet", "hardness": 1 }
      },
      "sends": { "room": -14 }
    }
  ],
  "buses": [{ "id": "room", "fx": [{ "type": "reverb", "space": "room", "size": 4, "decay": 0.6, "damping": 0.2 }] }],
  "master": { "normalize": { "mode": "peak", "target": -1 } },
  "controls": [
    {
      "id": "weight",
      "label": "Weight",
      "hint": "A light locker door to a ship's bulkhead hatch.",
      "value": 0.5,
      "targets": [
        { "path": "tracks.door.source.freq", "mode": "mul", "from": 1.6, "to": 0.625 },
        { "path": "tracks.door.source.decay", "mode": "mul", "from": 0.625, "to": 1.6 }
      ]
    },
    {
      "id": "room",
      "label": "Room",
      "hint": "Out in the open to a bare concrete cell.",
      "value": 0.5,
      "targets": [
        { "path": "tracks.door.sends.room", "from": -40, "via": -8, "to": 0 },
        { "path": "tracks.latch.sends.room", "mode": "add", "from": -30, "via": 0, "to": 8 }
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
| `seed` | Every random choice comes from it. Change it for a new variation of the same design. |
| `output` | `sampleRate` (default 48000), `channels` 1 or 2 (default 1), `bitDepth` 16, 24 or 32 for WAV export. |
| `loop` | Present only for a seamless loop of exactly `duration` seconds: `{ "mode": "wrap" }` adds whatever rings past the end back onto the start (a sound that never ends is cut exactly at the loop's end instead, since it carries on into the start by itself); `{ "mode": "crossfade", "crossfade": 0.1 }` fades the end into the start. |
| `tracks` | The layers. |
| `buses` | Shared effect chains that tracks send to, such as one reverb for several layers. |
| `master` | `fx`, `gain` (dB), `normalize` (`{ "mode": "peak", "target": -1 }` default; `{ "mode": "loudness", "target": -18, "ceiling": -3 }` levels by LUFS without letting the peak pass the ceiling; or `"none"`), `fadeIn`, `fadeOut`, `dcBlock`. |
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
| `repeat` | Shorthand for a run of events: `{ "count": 6, "interval": 0.09, "accel": 0.8, "decay": -3, "pitchStep": 1, "jitter": 0.004 }`. `accel` below 1 speeds up like a bouncing ball. `accents` sets each repeat's loudness in turn (`[0.7, 1, 0.8]`: the second the firmest, cycling), and `offsets` shifts each in time, in seconds (`[0, 0, 0, 0, 0.35]`: a hesitation before the fifth, the same every render). Tracks whose repeats have the same `group` name draw the same random timing, velocity and pitch, so the layers of one event (a knuckle, the door, its panel) move together. |
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
  voice) or of the track (in an effect: a track with `start: 0.5` counts its effects' times from 0.5 s into the
  patch). Before the first point the value is the first point's; after the last,
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

## Levels and balance

At `gain` 0 every source comes out near full scale: its loudest moment peaks within a few dB of 0 dBFS, whatever
the source. `noise` is the exception: it is scaled by its average level, so unfiltered it peaks 3 to 15 dB over full
scale (white about +10, velvet and crackle about +15) until its voice `filter` and a short envelope bring it down.
Templates usually start a noise layer between -6 and -12 dB.

- So layers at gain 0 all hit equally hard, and the balance is a choice: the layer that carries the sound at 0 dB,
  supporting layers around -4 to -12 dB, details (clicks, debris, air) around -10 to -20 dB. An event's `vel`
  scales its level too.
- Loudness follows length: a 5 ms click and a 2 s ring that peak at the same level differ by about 10 dB in
  loudness. A short transient can sit high without taking over; a long bed of noise needs much less.
- The master normalizes the finished mix (a peak of -1 dBFS by default), so the balance between layers matters, not
  their absolute level. `sfxgen analyze --tracks` measures each layer on its own and flags any 30 dB or more under
  the loudest.

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
tracks.body.source.freq.1.1       (the value of the second breakpoint: [t, value] is an array too)
tracks.body.events                (the whole event list, for a Speed control with `stretch`)
tracks.body.gain
tracks.body.sends.room            (the send to bus "room", in dB)
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
- `default` is where the control rests (and where each target's `via` sits) and what a double-click in the editor
  resets it to. Without it: the middle for `via`, and the value the patch was saved with for resetting.
- Each target maps the control's position onto a parameter:
  - `set` (default): the parameter becomes a value between `from` and `to` (defaults: the parameter's range).
  - `mul`: multiplies the parameter, breakpoints and all. The right move for pitch and time on a moving parameter.
  - `add`: adds to it (dB on gains, semitones on `pitch`).
  - `stretch`: multiplies the times of the parameter's breakpoints, every time of an ADSR envelope, the times
    (and `dur`) of a track's `events`, or a `repeat`'s `interval`, `jitter` and `dur`: a Speed control.
  - To move one note of a sweep, `set` a single breakpoint's value: `tracks.lead.source.pitch.2.1`.
  - `via`: the value at the control's `default` (or its middle): the mapping runs `from` → `via` → `to`, in every
    mode. Use it so a level or tone control rests exactly on the mixed value: `{ "path": "tracks.air.gain", "from": -30, "via": -8, "to": 0 }`.
    A `mul` target whose ends multiply to 1 (1.6 and 0.625) rests on the patch's own value without one.
  - `curve`: how the position maps: `linear`, `exp` (the default when both ends are positive and the parameter is
    on a log scale, or for `mul` and `stretch`), `smooth`, or a bend number.
- `widget: "select"` or `"toggle"` with `options: [{ "label": "Steel", "set": { "tracks.shell.source.material": "metal" } }, ...]`
  picks one of several settings; `value` is the option's index.
- `vary` is how far variations may move the control (± in its units), for round-robin variations.
- Controls apply in order, to a copy of the patch, just before rendering. The patch keeps its base values.
- A `set` target (or a chosen option) overrides the base value at its path on every render, so editing that value
  by hand changes nothing you can hear. Change the control's value instead, or run `sfxgen sync patch.sfx.json` (the
  `sync_controls` tool): it writes what each control currently applies into the base values at those paths, so the
  file says what renders. `mul`, `add` and `stretch` targets are left alone, since baking them in would apply them
  twice. `sfxgen sync --check` changes nothing and exits 1 if a patch is out of sync (for CI). The editor syncs every
  file it saves and every patch it exports, so a knob turned there leaves the file in sync.

**Choosing controls.** Three to seven, each one a perceptual move (Size, Weight, Grit, Distance, Speed, Brightness,
Wetness), never a raw DSP name. Each should change the sound audibly across its whole range and never break it.
Prefer one control driving several parameters coherently (Size lowers pitch, lengthens decay and adds room) over one
control per parameter. Write the `hint` as what the listener hears.

## Validation

`sfxgen validate file.sfx.json` (or the `set_patch` tool) checks a patch against the format and the catalog.
Errors stop a render; warnings are advice, such as an unknown parameter name with the closest valid one.

## Projects

A project is a set of sounds made to be heard together, such as one game's sound effects. A project file,
`sfxgen.project.json`, sits in a folder with its patches:

```json
{
  "format": "sfxgen-project/1",
  "name": "Cave crawler",
  "output": { "sampleRate": 44100, "channels": 1, "bitDepth": 16 },
  "normalize": { "mode": "peak", "target": -3 },
  "master": { "fx": [{ "type": "reverb", "space": "cave", "mix": 0.12 }] },
  "outDir": "build",
  "groups": [
    { "id": "ui", "label": "Interface", "color": "#7C93C4", "normalize": { "mode": "loudness", "target": -24 } },
    { "id": "combat", "label": "Combat" }
  ],
  "sounds": [
    { "file": "sword-hit.sfx.json", "group": "combat", "export": "../game/audio/sword-hit.wav" },
    { "file": "ui/click.sfx.json", "group": "ui", "gain": -2, "note": "Every menu move." }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `output` | Every sound renders with these settings, whatever its patch says, so the set is consistent. |
| `normalize` | How every sound is levelled. A group's `normalize` overrides it; without either, each patch's own applies. |
| `master` | `fx` run after each sound's own master chain (the set's shared character); `gain` in dB. |
| `outDir` | Where builds go, relative to the project file. Default `out`. |
| `groups` | Families of sounds with an ink and their own levelling. |
| `sounds` | `file` (a patch next to the project) or `patch` (inline), plus `gain` (dB after levelling: the sound's place in the set), `group`, `export` (the WAV path for builds), `skip`, `note`. |

A sound in its project renders as its patch with the project's output, levelling and master chain applied, then its
`gain`. The patch files stay ordinary patches: opened on their own they sound as their author made them.

`sfxgen build` renders every sound of a project to its export path; `sfxgen serve` opens a folder with a project file
as a project in the editor, where the sounds sit side by side, play in turn, and are balanced on a mixer.

## Review and takes

A person reviews each sound in the editor: they listen, may turn knobs or pick a take, then **approve** it or flag it
as **needing work**. What to change they say in the chat with their agent. The verdicts are kept next to the
project file in `sfxgen.review.json` (`sfxgen-review/1`); the patch and project formats don't change.

```json
{
  "format": "sfxgen-review/1",
  "read": "2026-11-26T10:05:00.000Z",
  "sounds": {
    "ambience/engine.sfx.json": {
      "status": "approved",
      "at": "2026-11-26T10:02:11.491Z",
      "version": "11d0fa88c76100a0",
      "take": "darker throb",
      "changes": [{ "path": "controls.power.value", "before": 0.7, "after": 0.75 }]
    },
    "creatures/moan.sfx.json": { "status": "needs-work", "at": "2026-11-26T10:03:40.022Z", "version": "18047c56060cf144" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `sounds` | Verdicts by sound: its `file` as the project lists it (or, for a sound kept inline, its name). |
| `status` | `approved` or `needs-work`. A sound with no verdict is not reviewed. |
| `at` | When the verdict was given (ISO 8601). |
| `version` | What the verdict is for: a hash of the sound's patch and of its takes. When either changes (an agent's edit, a file saved on disk, the person's own knob turn, another take picked, a new take), the verdict no longer holds and the sound is not reviewed again. Values a control sets are left out of the hash, since every render overrides them: syncing a file keeps its verdict. |
| `take` | The take in use when the verdict was given, by label. |
| `changes` | What the person changed before deciding, since the sound was last written by someone else (or since they picked its take): `{ path, before, after }`, the same records as `get_human_changes`. The changes are in the patch file already. |
| `read` | When an agent last read the verdicts (`sfxgen review`): later verdicts are new to it. |

**Takes** are other versions of one sound for the person to choose between. They are ordinary patch files in a folder
named after the sound: `engine.takes/darker-throb.sfx.json` beside `engine.sfx.json`. The file name is the take's
label ("darker throb"). The sound's own file always holds the take in use, and that is what builds, exports and the
project read; a `.takes` folder is never a sound of its own. Picking a take in the editor copies it into the sound's
file. Nothing is lost: the version it replaces goes back into the take it came from (with the person's changes), or
becomes a take named `original`. Takes are not the round-robin variations a WAV export writes (`variations`).
