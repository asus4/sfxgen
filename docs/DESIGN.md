# sfxgen design

sfxgen makes sound effects from JSON patches. An agent writes the patch, renders it, reads measurements and a
spectrogram instead of listening, and chooses the few knobs a person should try. The person opens it in the
editor, listens, turns those knobs (or everything), and the file on disk changes so the agent can see what they did.

## Why it exists

Sound effects written by coding agents tend to sound alike ([SOUND-DESIGN.md](SOUND-DESIGN.md) says why). sfxgen
tries to break that in three ways:

1. **A richer palette with physical meaning.** Modal resonators with material and shape models, waveguide strings
   and springs, particle clouds, formant voices, machines, chaos oscillators, and effects like Doppler fly-bys,
   varispeed, wavefolding and medium simulation (TV, radio, tape). The agent picks *what the object is* (a dented
   steel bucket, a wet cardboard box) instead of building it from sine waves.
2. **Ears for the agent.** `analyze` reports loudness, attack, decay, spectral centroid and how it moves, band
   balance and pitch, in words and numbers, with a spectrogram image.
3. **A person in the loop.** The agent exposes the moves that matter; the person decides by ear.

## Principles

- **Files are the API.** A patch is a plain JSON file. Agents edit it with whatever they already use; the editor
  live-reloads it; the person's tweaks are saved back; `git diff` shows who changed what.
- **Deterministic.** Same patch, seed and sample rate, same samples, in the browser and in Node. All randomness comes
  from named streams (`Rng.fork`).
- **One source of truth for nodes.** Each source and effect declares its parameters in `ParamMeta`. Validation, the
  editor's controls and tooltips, the agent guide and the JSON Schema all read it.
- **Offline rendering.** Sounds are short, so the engine renders whole buffers rather than running a real-time
  graph. The editor re-renders in a worker on every change and caches unchanged tracks.
- **Agent-first, person-final.** Every action in the editor is also a tool; every tool result is readable by a
  model.

## Architecture

```
src/core/            DOM-free; runs in a browser worker and in Node
  format/            types, validation, paths, controls, sync
  dsp/               DSP building blocks: rng, filters, oscillators, delays, FFT, ...
  params.ts          parameter values and envelopes -> per-sample curves
  nodes.ts           ParamMeta, SourceDef, EffectDef, contexts
  sources/           one file per source type, listed in sources/catalog-*.ts
  effects/           one file per effect type, listed in effects/catalog-*.ts
  registry.ts        lookups and metaAt(path)
  render.ts          patch -> samples
  analysis/          metrics, loudness, describe, spectrogram, png
  project/           projects and reviews
  agent/             workspace interface, tool definitions, guide, schema
  templates/         template loader (library.json is generated)
src/worker/          the editor's render worker
src/ui/              the editor (React)
src/web/             WebMCP registration
src/node/            CLI and local editor server
templates/           the template library, one *.sfx.json per sound
```

### Adding a source or an effect

Write a `SourceDef` or `EffectDef` (`src/core/nodes.ts`) in its own file, add it to its catalog, and declare and
test its parameters as [AGENTS.md](../AGENTS.md) says. Use `ctx.signal(name)` for anything that may move,
`ctx.num(name)` for values fixed per event, and `ctx.rng.fork('purpose')` for randomness.

## Agent interfaces

Both use the same core, so a patch renders and measures the same either way.

| Agent | Use | How |
| --- | --- | --- |
| In-browser agents | WebMCP | The editor registers the tools below on `document.modelContext` when the browser offers it, acting on the open project. The hosted editor carries a Chrome origin-trial token in `index.html`; elsewhere it needs `chrome://flags/#enable-webmcp-testing`. The WebMCP key in the top strip shows the state and how to turn it on. |
| Coding agents | Files and CLI | Write `*.sfx.json`, run `sfxgen render` and `sfxgen analyze --png`, read the spectrogram. `sfxgen guide` prints the catalog; `sfxgen review` reads what the person approved or flagged. `sfxgen serve` opens the editor on the same files, live-reloading both ways. |

### Tools (WebMCP)

Defined once in `src/core/agent/tools.ts` against the `Workspace` interface (`src/core/agent/workspace.ts`): the
editor's workspace in the browser, a `FileWorkspace` in the CLI, and an in-memory one in tests.

| Tool | Does |
| --- | --- |
| `describe_format` | The format and node catalog as markdown, or one node's parameters. |
| `list_templates` | Search the library by category or words. |
| `new_from_template` | Start a patch from a template, optionally setting controls and seed. |
| `get_patch` | The current patch JSON. |
| `set_patch` | Replace the patch (validated). |
| `edit_patch` | `set` values by path, `unset` paths, add or remove a track. |
| `set_controls` | Replace the person-facing controls. |
| `render_and_analyze` | Render, measure, describe; spectrogram image when asked. |
| `play` | Play the sound for the person. |
| `export_wav` | Write a WAV (and variations). |
| `get_human_changes` | What a person changed since the agent last wrote the patch. |
| `get_review` | The person's verdicts, what they changed first, the takes, and what is not reviewed yet. |
| `list_patches` | Patch files the workspace can see. |
| `sync_controls` | Write what the controls set back into the patch, so the file says what renders. |
| `get_project` | The project's sounds (groups, gains, export paths) and shared settings; with `measure`, each sound's loudness and peak. |
| `edit_project` | Change the project by path, and add or remove sounds. |
| `build_project` | Render every sound (or the named ones) in project context and write each WAV to its export path. |
| `balance_project` | Work out the gains that bring the sounds to a target loudness under a peak ceiling, and write them when asked. |

### Local editor server (`sfxgen serve [dir]`)

Serves the built editor and a small API over the `*.sfx.json` files under `dir`. The editor detects it with
`GET /api/info`; without it (static hosting, `npm run dev` alone) the editor keeps patches in the browser.

| Request | Does |
| --- | --- |
| `GET /api/info` | `{ "mode": "serve", "version", "root" }` |
| `GET /api/files` | `{ "files": [{ "path", "name", "mtime" }] }`, every `*.sfx.json` under the root except takes |
| `GET /api/file?path=` | The patch JSON |
| `PUT /api/file?path=&origin=human` | Validates and writes the patch (2-space JSON). 422 with issues on errors. |
| `PUT /api/wav?path=` | Writes WAV bytes (the editor's export) |
| `GET /api/project` | `{ path, saved, project }`: the root's `sfxgen.project.json`, or (`saved: false`) the folder's patches as an unsaved project |
| `PUT /api/project?origin=human` | Validates and writes `sfxgen.project.json`. 422 with issues on errors. |
| `GET /api/takes` | `{ "takes": { "<sound file>": [{ "path", "name", "mtime" }] } }`: each sound's takes (`<name>.takes/*.sfx.json`) |
| `GET /api/review` | `{ path, review }`: the root's `sfxgen.review.json` (empty when there is none) |
| `PUT /api/review?origin=human` | Body `{ sound, entry }`: sets one sound's verdict (`entry: null` clears it). 422 when the entry is invalid. |
| `POST /api/build` | Renders every sound (body `{ "only": [names] }` for some) in project context to its export path; returns the build rows |
| `POST /api/play?path=` | Asks every open editor to play that patch |
| `POST /api/focus?path=&control=` | Asks every open editor to open that patch and point at one of its controls |
| `GET /api/events` | Server-sent events: `file` and `project` (`{ path, mtime, origin }`, from the disk watcher or a PUT), `review` (`{ path, origin }`), `play` (`{ path }`), `focus` (`{ path, control }`) |

`?file=<path>` opens that sound, and the address follows the open sound, so a reload reopens it. In development
Vite proxies `/api` to `sfxgen serve --port 5179`, and a change to the store, the controller or the core reloads
the page, since a hot update would start a second, empty editor.

## The editor

### Art direction: an instrument

sfxgen is one instrument: a sound-effect synthesizer brought into the browser. The references are compact hardware
synths and grooveboxes (Teenage Engineering's OP-1, Yamaha's SEQTRAK, Behringer's TD-3-AM): learn from them, never
copy their layouts, graphics or trade dress.

- **One surface, clear zones.** A device body with a display, a control surface and a row of sound pads, all in
  view at once on a desktop screen. No long scrolling page.
- **Colour means something.** The body is monochrome (light or dark finish); colour appears only where it carries
  meaning: each control has its own colour, and the display shows that colour where the control acts; each track
  and each sound group has an ink.
- **A display that's alive.** The waveform, spectrum and readouts live on a dark screen with bright, playful
  graphics and a monospace readout font; it reacts while a sound plays.
- **Pads with LEDs.** A project's sounds are pads with flat LEDs, each glowing in its own colour.
- **Silkscreen restraint.** Small uppercase legends, hairline dividers, numbered sections. No faux 3D: controls turn
  and light up; they don't jump or cast offset shadows when pressed.

### Layout

On a desktop screen everything is one panel with no page scroll (below 1040 × 640 px the zones stack):

1. **01 Top strip**: logo, the project key (switch, create, delete projects), gallery, open, save, export, share,
   the latest activity, undo and redo, WebMCP status (not on phones and tablets, where nothing calls the tools yet),
   light or dark finish, and a link to the source on GitHub.
2. **02 Sounds**: a pad per sound in the project, down the side (keys 1 to 9 and 0 play them), and after the last
   pad an empty slot that adds a sound from the gallery. A single patch is a project of one. The pad's LED shows the
   first state that applies: playing (green), touched by an agent (magenta), approved (off), needing work (a red
   ring), changed by you and not yet decided (orange), not reviewed (red). A count in the head opens the next sound
   to review. Under the open sound's pad sit **Approve** (with the number of changes you made, which go with it) and
   **Needs work** (keys A and N); either one opens and plays the next sound to review. A sound's takes show under
   its pad like a folder; a click puts a take in use and plays it (keys [ and ]).
3. **The display**: play, the sound's name and readouts (length, peak, LUFS, render time), the mix as a waveform or
   spectrum with a playhead and a level meter, and the tracks as lanes (mute, solo, drag to move) with a key to add
   a layer. When a control sets a lane's start (a "push" knob timing every layer), dragging the lane shifts that
   control's range for the layer instead, so the knob keeps working around the new time.
4. **04 Easy control**: the patch's controls as colour-coded knobs and selectors with their hints. Hovering or
   turning one draws what it drives in its colour on the display. Then the two chance keys: **the dice** (a new
   seed) and **surprise me** (random values within the controls' ranges).
5. **05 Full control**, closed until opened: every parameter of the selected track (source, voice filter, envelope,
   events, effects) and the master, generated from the node metadata; breakpoint parameters get a small curve
   editor; any parameter can be pinned into the easy controls. A value that a control sets shows as it plays,
   tagged with the control; turning it moves the control's range by the same amount. Its tabs swap it for the
   **Mix** (groups, gain faders, loudness and peak, match loudness per group, play the set in turn), the
   **Settings** (the set's name, output, levelling, the shared master chain, export folder) and the **Notes** (what
   the agent wrote, and who changed what).

### Behaviour

- Re-render in a worker on every change (latest wins), cache unchanged tracks, show render time.
- Space plays; a knob plays the sound when it is released; undo and redo.
- Template gallery: cards by category with a mini waveform; one click loads and plays.
- Review: a verdict is for the version heard. Any change afterwards, the person's own included, puts the sound back
  to be reviewed; syncing the controls' values into the file is not a change. Served folders keep the verdicts in
  `sfxgen.review.json`; a project kept in the browser keeps them with it.
- Export WAV (16, 24 or 32-bit float, mono or stereo, any sample rate) with variations, or the `.sfx.json`. Every
  patch the editor saves or exports is synced first (`sfxgen sync`).
- Autosave to the browser; share links carry the patch compressed in the URL hash.
- Paste a patch anywhere outside a text field (a copied `.sfx.json` file, or its JSON as text) to add it as a pad.
- Works with a keyboard alone and at phone width.
