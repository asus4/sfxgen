# Designing original sound effects with sfxgen

A guide for agents (and people) writing patches. The format is in [FORMAT.md](FORMAT.md); the node catalog comes
from `sfxgen guide`.

## Why generated sound effects sound alike

Sound effects written by coding agents are recognisable, and not in a good way. The same habits show up in almost
all of them:

- **The same three layers.** A click, a sine that drops in pitch, and a handful of decaying sine partials, mixed
  together and called an impact, a door, a footstep and a punch.
- **Perfect numbers.** Round frequencies, exact harmonic ratios, partials that all start at the same instant,
  envelopes with the same attack on every layer.
- **No object.** The sound is built from waveforms, not from something: it has no material, size, mechanism or
  place, so it can't be specific.
- **No space and no medium.** Everything is dry and close, or everything gets the same reverb.
- **Everything the same length and level.** Peak-normalised, 0.3 to 0.6 s, centred in the same frequency range.
- **No life.** Repeats are identical copies; nothing drifts, wobbles or varies.

The result is technically clean and immediately forgettable. The cure is to design the way a foley artist or sound
designer does: start from a story and let physics, imperfection and context do the work.

## Start with a story, not a waveform

Before writing a track, answer these in the patch's `description` and the tracks' `note` fields:

1. **What is it?** Not "an impact" but "a steel toolbox dropped on a concrete floor, its lid rattling".
2. **What is it made of, and how big is it?** Material sets the colour and the decay; size sets the pitch and the
   length.
3. **What happens, in order?** Most sounds are a sequence: the latch, then the thud, then the rattle, then the
   settle. Write the timeline in milliseconds.
4. **Where are we, and how far away?** A small tiled room, an open field, inside a helmet, across a stadium.
5. **Through what?** Air only, or a TV speaker, a radio, a phone, a tape? `medium` is part of the world.
6. **What does it mean in the game or film?** A reward should rise and sparkle; damage should be harsh and short;
   a UI tick should get out of the way. Meaning chooses the details.

## The anatomy of a sound

Think in parts, each a track with one job:

| Part | Does | Typical nodes |
| --- | --- | --- |
| Transient | Identity in the first 1 to 20 ms: what hit what | `noise` with a short envelope, `modal` with a hard exciter, `particles` with clicks |
| Body | Weight and material | `modal`, `pluck`, `osc`/`fm` with pitch motion, `voice` |
| Texture | Detail that makes it real: grit, rattle, debris, breath | `particles`, `noise` through `resonator` or `filter`, `chaos` |
| Motion | How it moves: pitch, filter and level over time | breakpoints, modulators, `doppler`, `varispeed` |
| Tail | Size and place | `reverb`, `delay`, the natural ring of `modal` |

Two to five tracks is usually right. Each one should be audible on its own and missed when muted. If a layer
doesn't change the sound when you mute it, remove it.

## Use the physical models

The richest nodes describe objects, so use them for objects:

- **`modal`** for anything that rings when struck, scraped or rolled. Choose `material` and `shape` from the story
  (a wooden crate is wood and box; a frying pan is metal and plate; a wine glass is glass and bell). Use the
  exciter: a hard mallet for a hit, `scrape` for dragging, `roll` for a can rolling away. `dent` makes it a used,
  real object rather than a perfect one. `position` changes which modes ring: hitting near an edge sounds different
  from the centre.
- **`particles`** for anything made of many small events: debris after an impact, gravel underfoot, rain, fire,
  sparks, coins, glass shards, bubbles. `distribution: "burst"` for debris after a hit, `"bounce"` for something
  settling.
- **`pluck`** for strings, cables, springs and anything that twangs; high `stiffness` turns it into a spring.
- **`voice`** for creatures, grunts and robots: choose `size` from the creature and move the `vowel`.
- **`machine`** for motors, engines, rotors and servos: drive `rpm` with breakpoints so it spins up and strains.
- **`fm`** for bells, alarms, zaps and metallic tones; give the modulator index its own envelope so the brightness
  decays faster than the level.
- **`chaos`** for glitches, alien electronics, broken machines: textures nothing else makes.

`osc` and `noise` are still useful, especially for UI sounds, retro tones and air, but reach for them second.

## Imperfection is information

Real sounds are never exact. Each of these is cheap and makes a patch sound recorded rather than computed:

- **Offset the layers.** Real events don't align to the sample: start layers 1 to 15 ms apart (a flam), and let
  the parts of a sequence breathe (the rattle 40 ms after the thud).
- **Detune.** Use ratios from the models, `dent`, `inharmonicity`, `detune`, `drift`. Avoid round frequencies.
- **Wobble.** `wander` modulators on pitch and cutoff (a few cents, a few percent) give life to anything sustained.
- **Vary repeats.** `repeat` with `jitter`, `velJitter` and `pitchJitter`; `particles` with level and pitch spread.
- **Asymmetric envelopes.** Fast attacks, long and uneven decays; different attacks on different layers.
- **Seeds.** Try a few seeds and keep the best. Expose `vary` on controls so a game gets round-robin variations.

## Plan the spectrum

- Give each layer its own range, and check with `render_and_analyze` (the band table) that one band isn't doing
  everything.
- Laptop and phone speakers don't reproduce much below 100 Hz. Weight has to live at 100 to 300 Hz too; sub is a
  bonus for headphones.
- 200 to 500 Hz turns muddy when several layers pile up there: cut it on the layers that don't need it.
- Presence (2 to 5 kHz) makes a sound cut through a mix; air (above 8 kHz) makes it close and crisp. Too much of
  either is harsh.
- Use the centroid trend: a pickup should rise, a power-down should fall, an explosion should start bright and
  darken.

## Dynamics and punch

- The first 10 ms decide whether a hit feels strong. A `transient` shaper with more attack, or a short bright layer,
  does more than making everything louder.
- A `compressor` on the master glues layers into one object; a `limiter` keeps peaks safe.
- Leave contrast: a sound that is loud all the way through has no impact. Let the tail be much quieter than the hit.

## Space and medium

- Dry and close is a choice, not a default. Small spaces (closet, car, room) make sounds feel physical; big ones
  (hall, cave, stadium) make them epic. Use `predelay` to keep the hit clear of the reverb.
- Send several layers to one bus with one `reverb` so they sit in the same place.
- `medium` puts the sound inside the world: a broadcast, a radio call, a cassette memory.

## Motion

- Breakpoint curves: frequencies and times glide `exp` by default, which sounds natural. Use `hold` for steps and
  `smooth` for gentle moves.
- `doppler` for anything that passes by; `varispeed` for power-downs and tape stops; `pitch` on the voice for whole
  sound sweeps.
- Movement can be tiny and still matter: a 3 % pitch sag at the end of a hit makes it feel heavy.

## Checking without ears

You can't listen, so measure, look, and be honest about what you can't know:

1. `render_and_analyze` (or `sfxgen render --analyze --png`): read the attack, peak time, decay, centroid trend,
   band balance and pitch against the story. "A heavy door" with its energy above 2 kHz and a 3 ms decay is wrong.
2. Look at the spectrogram: the transient should be a sharp vertical line; layers should be visible as separate
   shapes; the tail should fade, not stop.
3. Mute layers one at a time and check the measurements change the way you meant.
4. Compare with the nearest template: if your patch is a light variation of it, ask what would make it specific to
   this object and this world.
5. Then hand it to a person with good controls, and say what you could not check.

## Choosing controls for people

The controls are your recommendation of what to try first. Three to seven of them, each a move a listener would
ask for in their own words: Size, Weight, Material, Distance, Speed, Grit, Brightness, Wetness, Intensity. One
control can move several parameters coherently: Size lowers pitch, lengthens decay and adds room. Write each
`hint` as what the listener will hear. Test every control at both ends of its range: it should change the sound
clearly and never break it.

## Recipes are starting points

These show how the parts combine. Change them for the story at hand; don't apply them as formulas.

- **Metal impact**: a hard `modal` (metal, plate, a little `dent`) for the body; a 2 ms bright `noise` transient; a
  `particles` burst of small metal ticks 20 to 120 ms later for the rattle; a small room on a bus.
- **Footstep on gravel**: a soft low `modal` (wood or stone, box) for the heel; `particles` (stone grains, burst,
  60 to 120 ms) for the crunch; a second, quieter crunch for the toe 70 ms later.
- **Magic pickup**: `fm` bell partials in a rising arpeggio (`events` with pitch steps); a `particles` cloud of tiny
  pings that rises in pitch; a long bright `reverb`; maybe `chorus` for shimmer.
- **Creature growl**: `voice` with a big `size`, `growl` and a slow vowel move from "o" to "a"; a `noise` breath
  layer; `drive` for texture; a cave for scale.
- **Servo**: `machine` (servo) with `rpm` breakpoints that spin up, hold and strain at the end; a click at the stop
  (`modal`, plastic); the `medium` the world calls for.
