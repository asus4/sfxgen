# sfxgen

An open-source sound-effect generator 🎛️

**[Open the editor 🔗: asus4.github.io/sfxgen](https://asus4.github.io/sfxgen/)**

## Make a sound

1. Press **Gallery** and pick a template: impacts, footsteps, doors, UI clicks, retro blips, sci-fi, creatures,
   magic, nature and more. It plays as soon as you pick it.
2. Turn the **Easy control** knobs; the sound plays when you let go. The **dice** keep the sound and roll new random
   detail. **Surprise me** throws every knob somewhere new.
3. Open **Full control** for every parameter of every layer, the mixer for a whole set of sounds, and the settings
   the set shares.
4. **Export** a WAV (one sound or the whole set), or **Share** a link with the sound inside it.

Your projects are kept in your browser. **Save** downloads a sound as a `.sfx.json` file; drop or paste one onto the
page to bring it back.

## Make a sound with an AI agent

There are two ways to bring in an agent, depending on how much it should do.

**In the browser, with nothing to install (WebMCP).** The editor offers its tools to an AI agent running in your
browser: it finds a template, edits the sound, renders and measures it, and plays it for you in the open page.
Chrome 149 to 162 turns WebMCP on for the hosted editor by itself (an origin trial, until 30 March 2027). In Brave,
and in Chrome elsewhere, set `chrome://flags/#enable-webmcp-testing` to Enabled. The editor's **WebMCP** key shows
how. It is hidden on phones and tablets, where nothing can call the tools yet.

**On your computer, for heavy use (Node.js).** A coding agent (Claude Code, Codex, ...) writes `.sfx.json` files and
runs the sfxgen command line. It renders every sound, reads the measurements and looks at the spectrogram before
handing it over, and `sfxgen serve` opens the editor on the same files so you can hear and tune them. Ask it to "set
up https://github.com/asus4/sfxgen and make me ...". [AGENTS.md](AGENTS.md) is where it starts, and
[docs/SOUND-DESIGN.md](docs/SOUND-DESIGN.md) is how to make sounds that don't sound generated.

The command line runs from a clone of this repository:

```bash
git clone https://github.com/asus4/sfxgen.git
cd sfxgen
npm install
npm run sfxgen -- templates                          # browse the library
npm run sfxgen -- new impacts/thud -o thud.sfx.json  # start from a template
npm run sfxgen -- render thud.sfx.json --analyze --png
npm run sfxgen -- serve .                            # edit the same files in the browser
npm run sfxgen -- review                             # what the person approved or flagged
npm run sfxgen -- project init sounds/               # make a folder of patches a project
npm run sfxgen -- build sounds/                      # render every sound to its export path
```

## A patch

Every sound is a JSON patch like this one: it is what **Save** downloads and what an agent writes.

```json
{
  "format": "sfxgen/1",
  "name": "Steel hatch slam",
  "description": "A heavy steel hatch dropped shut in a small concrete room: a dull, dented boom, then the latch.",
  "duration": "auto",
  "tracks": [
    {
      "id": "door",
      "note": "A thick steel box hit along its edge; the dent stops it ringing like a bell.",
      "source": { "type": "modal", "material": "metal", "shape": "box", "freq": 82, "decay": 0.9, "dent": 0.35,
                  "exciter": { "kind": "mallet", "hardness": 0.8 } },
      "sends": { "room": -8 }
    },
    {
      "id": "latch",
      "note": "The latch snapping home 90 ms later: a small, damped steel bar.",
      "gain": -10,
      "events": [0.09],
      "source": { "type": "modal", "material": "metal", "shape": "bar", "freq": 1400, "decay": 0.08, "damping": 2.5 }
    }
  ],
  "buses": [{ "id": "room", "fx": [{ "type": "reverb", "space": "room", "size": 4, "decay": 0.6 }] }],
  "controls": [
    {
      "id": "weight", "label": "Weight", "hint": "A light locker door to a ship's bulkhead hatch.", "value": 0.5,
      "targets": [
        { "path": "tracks.door.source.freq", "mode": "mul", "from": 1.6, "to": 0.625 },
        { "path": "tracks.door.source.decay", "mode": "mul", "from": 0.625, "to": 1.6 }
      ]
    }
  ]
}
```

## Development

```bash
npm run dev # http://localhost:5178
npm test
npm run build
```

## License

MIT
