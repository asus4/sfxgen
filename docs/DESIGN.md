# sfxgen design

sfxgen makes sound effects from JSON patches. An agent writes the patch, renders it, reads measurements and a
spectrogram instead of listening, and chooses the few knobs a person should try. The person opens it in the
editor, listens, turns those knobs (or everything, if they ask), and the file on disk changes so the agent can see
what they did.

## Why it exists

Sound effects written by coding agents tend to sound alike: they reach for the same handful of primitives (a
pitch-dropping sine thump, a band-passed noise burst, a few decaying sine partials, a saw through a band-pass) and
layer them the same way. sfxgen tries to break that in three ways:

1. **A richer palette with physical meaning.** Modal resonators with real material and shape models, waveguide
   strings and springs, particle clouds, formant voices, machines, chaos oscillators, and effects like Doppler
   fly-bys, varispeed, wavefolding and medium simulation (TV, radio, tape). The agent picks *what the object is*
   (a dented steel bucket, a wet cardboard box) instead of building it from sine waves.
2. **Ears for the agent.** `analyze` reports loudness, attack, decay, spectral centroid and how it moves, band
   balance and pitch, in words and numbers, with a spectrogram image an agent can look at.
3. **A person in the loop.** The agent exposes the moves that matter; the person decides by ear.

## Principles

- **Files are the API.** A patch is a plain JSON file. Agents edit it with whatever they already use; the editor
  live-reloads it; the person's tweaks are saved back; `git diff` shows who changed what.
- **Deterministic.** Same patch, seed and sample rate, same samples, in the browser and in Node. All randomness comes
  from named streams (`Rng.fork`).
- **One source of truth for nodes.** Each source and effect declares its parameters (`ParamMeta`: kind, unit, range,
  scale, doc). Validation, the editor's controls, the agent guide and the JSON Schema all read it.
- **Offline rendering.** Sounds are short, so the engine renders whole buffers (like numpy) rather than running a
  real-time graph. The editor re-renders in a worker on every change and caches unchanged tracks.
- **Agent-first, person-final.** Every action in the editor is also a tool; every tool result is readable by a
  model; nothing in the editor is the only way to do something.

## Architecture

```
src/core/            DOM-free; runs in a browser worker and in Node
  format/            types, validation, paths, controls
  dsp/               rng, filters, oscillators, noise, fft, oversampling
  params.ts          parameter values and envelopes -> per-sample curves
  nodes.ts           ParamMeta, SourceDef, EffectDef, contexts
  sources/           one file per source type, listed in sources/catalog-*.ts
  effects/           one file per effect type, listed in effects/catalog-*.ts
  registry.ts        lookups and metaAt(path)
  render.ts          patch -> samples
  analysis/          metrics, loudness, describe, spectrogram, png
  agent/             workspace interface, tool definitions, guide, schema
  templates/         template loader (library.json is generated)
src/worker/          the editor's render worker
src/ui/              the editor (React)
src/web/             browser-only agent glue: WebMCP registration
src/node/            CLI, local editor server
templates/           the template library, one *.sfx.json per sound
docs/                FORMAT.md, SOUND-DESIGN.md, TEMPLATE-BRIEF.md, this file
```

### Adding a source or an effect

Write a `SourceDef` or `EffectDef` (see `src/core/nodes.ts`) in its own file and add it to the catalog. Declare every
parameter with a `doc` an agent can act on, a unit, a soft range and hard limits that keep the DSP stable. Mark
frequency-like parameters `pitch: true` and `scale: 'log'`. Use `ctx.signal(name)` for anything that may move,
`ctx.num(name)` for things fixed per event, and `ctx.rng.fork('purpose')` for randomness. Add a test that renders
it with defaults and with extreme values and checks for finite, non-silent, non-clipping output.

## Agent interfaces

Two paths: WebMCP for light use in the browser, with nothing to install, and the command line on local files for
heavy use. Both use the same core, so a patch renders and measures the same either way.

| Agent | Use | How |
| --- | --- | --- |
| In-browser agents | WebMCP | The editor registers the tools below on `document.modelContext` when the browser offers it, acting on the open project. The hosted editor carries a Chrome origin-trial token for `https://asus4.github.io` in `index.html` (Chrome 149 to 162, until 30 March 2027); elsewhere, and in Brave, it needs `chrome://flags/#enable-webmcp-testing`. The WebMCP key in the top strip shows the state and how to turn it on; phones and tablets don't show it. |
| Coding agents (Claude Code, Codex, ...) | Files and CLI | Write `*.sfx.json`, run `sfxgen render`, `sfxgen analyze --png`, read the spectrogram. `sfxgen guide` prints the catalog. |
| People | `sfxgen serve` or the hosted editor | Opens the editor on the same files, live-reloading both ways. |

### Tools (WebMCP)

Defined once in `src/core/agent/tools.ts` against the `Workspace` interface (`src/core/agent/workspace.ts`): the
editor's workspace in the browser, a `FileWorkspace` in the CLI (`sfxgen project report --match` runs
`balance_project`), and an in-memory one in tests.

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
| `list_patches` | Patch files the workspace can see. |
| `sync_controls` | Write what the controls set back into the patch, so the file says what renders. |
| `get_project` | The project: its sounds with their groups, gains and export paths, and the shared settings; with `measure`, each sound's loudness and peak. |
| `edit_project` | Change the project by path, and add or remove sounds. |
| `build_project` | Render every sound (or the named ones) in the project's context and write each WAV to its export path. |
| `balance_project` | Work out the gains that bring the sounds to a target loudness under a peak ceiling, and write them when asked. |

### Local editor server (`sfxgen serve [dir]`)

Serves the built editor and a small API over the `*.sfx.json` files under `dir`. The editor detects it with
`GET /api/info`; without it (static hosting, `npm run dev` alone) the editor keeps patches in the browser.

| Request | Does |
| --- | --- |
| `GET /api/info` | `{ "mode": "serve", "version", "root" }` |
| `GET /api/files` | `{ "files": [{ "path", "name", "mtime" }] }`, every `*.sfx.json` under the root |
| `GET /api/file?path=` | The patch JSON |
| `PUT /api/file?path=&origin=human` | Validates and writes the patch (2-space JSON). 422 with issues on errors. |
| `PUT /api/wav?path=` | Writes WAV bytes (the editor's export) |
| `POST /api/play?path=` | Asks every open editor to play that patch |
| `GET /api/events` | Server-sent events: `file` (`{ path, mtime, origin }`, from the disk watcher or a PUT), `play` (`{ path }`), `focus` (`{ path, control }`) |
| `GET /api/project` | `{ path, saved, project }`: the root's `sfxgen.project.json`, or (`saved: false`) the folder's patches as an unsaved project |
| `PUT /api/project?origin=human` | Validates and writes `sfxgen.project.json` (422 with issues on errors) |
| `POST /api/build` | Renders every sound (body `{ "only": [names] }` for some) in project context to its export path; returns the build rows |

`/api/events` also sends `project` (`{ path, mtime, origin }`) when the project file changes.

The editor opens `?file=<path>` directly. Vite's dev server proxies `/api` to `sfxgen serve --port 5179` when it runs.

## The editor

### Art direction: an instrument

sfxgen is one instrument: a sound-effect synthesizer brought into the browser. The references are compact hardware
synths and grooveboxes (Teenage Engineering's OP-1, Yamaha's SEQTRAK, Behringer's TD-3-AM): learn from them, never
copy their layouts, graphics or trade dress.

- **One surface, clear zones.** A device body with a display, a control surface and a row of sound pads, all in
  view at once on a desktop screen, as on a panel. No long scrolling page.
- **Colour means something.** The body is monochrome (light or dark finish); colour appears only where it carries
  meaning: each control has its own colour, and the display shows that colour where the control acts (the OP-1's
  encoder-to-screen mapping); each track and each sound group has an ink.
- **A display that's alive.** The waveform, spectrum and readouts live on a dark screen with bright, playful
  graphics and a monospace readout font; it reacts while a sound plays.
- **Pads with LEDs.** A project's sounds are pads: one press plays, selecting opens it; LEDs show playing, selected,
  edited and touched-by-an-agent.
- **Silkscreen restraint.** Small uppercase legends, hairline dividers, numbered sections. No faux 3D: controls turn
  and light up; they don't jump or cast offset shadows when pressed.

### Layout

On a desktop screen everything is one panel with no page scroll (below 1040 × 640 px the zones stack):

1. **01 Top strip**: logo, the project key (switch, create, delete projects), gallery, open, save, export, share,
   the latest activity, undo and redo, WebMCP status (not on phones and tablets, where nothing calls the tools yet),
   light or dark finish, and a link to the source on GitHub.
2. **02 Sounds**: a pad per sound in the project, down the side (keys 1 to 9 and 0 play them), with LEDs for
   playing, edited by you and touched by an agent, and after the last pad an empty slot that adds a sound from the
   gallery. A single patch is a project of one.
3. **The display**: a dark screen with play, the sound's name and readouts (length, peak, LUFS, render time), the
   mix as a waveform or spectrum with a playhead and a level meter, and the tracks as lanes (mute, solo, drag to
   move) with a key under the last one to add a layer.
4. **04 Easy control**: the patch's controls as colour-coded knobs and selectors with their hints. Hovering or
   turning one draws what it drives in its colour on the display. After them, the two chance keys: **another take**
   and **surprise me**.
5. **05 Full control**, closed until opened (the display takes the room): every parameter of the selected track
   (source, voice filter, envelope, events, effects) and the master, generated from the node metadata; breakpoint
   parameters get a small curve editor; any parameter can be pinned into the easy controls. Its tabs swap it for
   the **Mix** (groups, gain faders, loudness and peak, match loudness per group, play the set in turn), the
   **Settings** (the set's name, output, levelling, the shared master chain, export folder) and the **Notes**
   (what the agent wrote, and who changed what). Opening a tab opens it.

### Behaviour

- Re-render in a worker on every change (latest wins), cache unchanged tracks, show render time.
- Space plays; a knob plays the sound when it is released (always); undo/redo.
- Template gallery: cards by category with a mini waveform; one click loads and plays.
- "Another take" (new seed) and "Surprise me" (random values within the controls' ranges).
- Export WAV (16/24/32-bit, mono/stereo, sample rate), variations, and the `.sfx.json`.
- Autosave to the browser; share link with the patch compressed in the URL hash.
- Paste a patch anywhere outside a text field (a copied `.sfx.json` file, or its JSON as text) to add it as a new pad.
- Works with a keyboard alone and at phone width.
