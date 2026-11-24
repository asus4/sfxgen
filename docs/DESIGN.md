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
src/node/            CLI, MCP server, local editor server
templates/           the template library, one *.sfx.json per sound
docs/                FORMAT.md, SOUND-DESIGN.md, this file
```

### Adding a source or an effect

Write a `SourceDef` or `EffectDef` (see `src/core/nodes.ts`) in its own file and add it to the catalog. Declare every
parameter with a `doc` an agent can act on, a unit, a soft range and hard limits that keep the DSP stable. Mark
frequency-like parameters `pitch: true` and `scale: 'log'`. Use `ctx.signal(name)` for anything that may move,
`ctx.num(name)` for things fixed per event, and `ctx.rng.fork('purpose')` for randomness. Add a test that renders
it with defaults and with extreme values and checks for finite, non-silent, non-clipping output.

## Agent interfaces

| Agent | Use | How |
| --- | --- | --- |
| Coding agents (Claude Code, Codex, ...) | Files and CLI | Write `*.sfx.json`, run `sfxgen render`, `sfxgen analyze --png`, read the spectrogram. `sfxgen guide` prints the catalog. |
| MCP clients | `sfxgen mcp` | The same operations as tools; analysis returns the spectrogram as an image. |
| In-browser agents | WebMCP | The editor registers the same tools on `document.modelContext` when the browser offers it (Chrome 149+ and Edge 150+ origin trials as of November 2026). |
| People | `sfxgen serve` or the hosted editor | Opens the editor on the same files, live-reloading both ways. |

### Tools (shared by MCP and WebMCP)

Defined once in `src/core/agent/tools.ts` against the `Workspace` interface (`src/core/agent/workspace.ts`).

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

The editor opens `?file=<path>` directly. Vite's dev server proxies `/api` to `sfxgen serve --port 5179` when it runs.

## The editor

### Art direction: "Ink & Signal"

A risograph print shop for sound. Layering sounds is overprinting inks: each track is one ink, and where layers
overlap on the timeline their colours multiply, as riso inks do. It should feel tactile, bold and playful (a
creative tool, not a lab instrument) while staying precise where numbers matter.

- **Paper and ink.** Light theme on a neutral, very slightly cool paper (not cream). Dark theme is black paper
  with the inks glowing (screen blend). Track inks from the riso set: fluorescent pink `#FF48B0`, blue `#0078BF`,
  yellow `#FFE800`, teal `#00838A`, orange `#FF6C2F`, green `#00A95C`, purple `#765BA7`, red `#FF665E`.
- **Texture with restraint.** A faint paper grain and a 1 px misregistration on large display type; never on
  numbers or controls.
- **Type.** A bold grotesk for display and labels, a monospace for values, both open-licensed and bundled.
- **Motion.** Knobs and waveforms respond immediately; a new render morphs the waveform rather than snapping;
  agent edits flash like a highlighter on the knob they touched.

### Layout

1. **Header**: logo, patch name (editable), template gallery, open/save, export, share link, agent status (WebMCP
   tools registered, live file link).
2. **Stage**: the mix as a large overprinted waveform, each track in its ink, with a spectrogram view to toggle and a
   playhead. Click to play from a point.
3. **Lanes**: one per track: ink swatch, name, mute/solo, its waveform at its start time (drag to move).
4. **Controls**: the patch's controls as large knobs and selectors with their hints. This is the default view.
5. **Everything**: a toggle that reveals every parameter of the selected track (source, voice filter, envelope,
   events, effects) and the master, generated from the node metadata; breakpoint parameters get a small curve
   editor; any parameter can be pinned into the controls.
6. **Agent notes and activity**: the patch's description and track notes, and a feed of agent edits.

### Behaviour

- Re-render in a worker on every change (latest wins), cache unchanged tracks, show render time.
- Space plays; auto-audition after a knob is released (a toggle); undo/redo.
- Template gallery: cards by category with a mini waveform; one click loads and plays.
- "Another take" (new seed) and "Surprise me" (random values within the controls' ranges).
- Export WAV (16/24/32-bit, mono/stereo, sample rate), variations, and the `.sfx.json`.
- Autosave to the browser; share link with the patch compressed in the URL hash.
- Works with a keyboard alone and at phone width.
