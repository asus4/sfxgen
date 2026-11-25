# sfxgen

sfxgen is an open-source sound-effect generator.

## Why

Sound effects written by coding agents sound alike: a pitch-dropping sine, a band-passed noise burst and a few sine
partials, perfectly aligned, perfectly clean. sfxgen gives agents a better palette and better ears:

- **Physical models** that describe objects instead of waveforms: modal resonators with real materials and shapes,
  waveguide strings and springs, particle clouds for debris, rain and fire, formant voices for creatures, machines
  driven by RPM, chaos generators, and effects like Doppler fly-bys, varispeed, wavefolding and the sound of a TV
  speaker or a cassette.
- **Ears for agents**: loudness, attack, decay, spectral balance and how they move, in words and numbers, with a
  spectrogram image.
- **A person in the loop**: the agent exposes perceptual controls (Size, Weight, Grit, Distance) and the person
  decides by ear. Everything else stays one click away.
- **Projects**: a game's whole set of sounds side by side, with shared output settings, levelling per group, a shared
  master chain, a mixer to balance them and one build that writes every WAV where the game wants it.

## Quick start

```bash
npm install
npm run dev                      # the editor, http://localhost:5178
```

From the command line:

```bash
npm run sfxgen -- templates                          # browse the library
npm run sfxgen -- new impacts/thud -o thud.sfx.json  # start from a template
npm run sfxgen -- render thud.sfx.json --analyze --png
npm run sfxgen -- serve .                            # edit the same files in the browser
npm run sfxgen -- project init sounds/               # make a folder of patches a project
npm run sfxgen -- build sounds/                      # render every sound to its export path
```

## For agents

| Agent | Connect with |
| --- | --- |
| Coding agents (Claude Code, Codex, ...) | Files and the CLI: write `*.sfx.json`, run `sfxgen render --analyze --png`, read the PNG. `sfxgen guide` prints the catalog. |
| MCP clients | `sfxgen mcp <dir>`: the same operations as tools, with spectrograms as images. Claude Code: `claude mcp add sfxgen -- npx tsx /path/to/sfxgen/src/node/cli.ts mcp .` |
| In-browser agents | WebMCP: the editor registers its tools on `document.modelContext` when the browser offers it (Chrome and Edge origin trials). |

Start with [docs/SOUND-DESIGN.md](docs/SOUND-DESIGN.md): how to make sounds that don't sound generated.

## A patch

```json
{
  "format": "sfxgen/1",
  "name": "Rusty hatch clunk",
  "duration": "auto",
  "tracks": [
    {
      "id": "body",
      "source": { "type": "osc", "wave": "sine", "freq": [[0, 160], [0.08, 62]], "env": { "attack": 0.001, "decay": 0.35 } },
      "fx": [{ "type": "drive", "mode": "tube", "amount": 10 }]
    }
  ],
  "controls": [
    {
      "id": "weight", "label": "Weight", "hint": "Lower and longer: a heavier door.", "value": 0.5,
      "targets": [{ "path": "tracks.body.source.freq", "mode": "mul", "from": 1.6, "to": 0.6 }]
    }
  ]
}
```

## Development

```bash
npm test             # vitest
npm run typecheck
npm run build        # templates, the editor (dist/web) and the CLI (dist/node)
```

## License

MIT
